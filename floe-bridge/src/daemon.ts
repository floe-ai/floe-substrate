/**
 * @invariant The bridge is the sole owner of effective runtime embodiment.
 * Adapter selection and runtime resolution happen here; callers may provide bindings and config,
 * but only the bridge decides the live adapter and the effective runtime passed into sessions.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRuntimeConfig } from "./auth.js";
import { BrokeredDeliveryCredentialStore, RuntimeAuthError } from "./auth.js";
import { createBridgeAuthRuntime } from "./auth.js";
import type { LocalConfig } from "./config.js";
import { bridgeHttpBase, bridgeWsBase } from "./config.js";
import {
  BridgeTransportUnavailableError,
  BusClient,
  isCredentialTransportSecure,
  type BridgeTransportAuthority,
  type BridgeTransportAuthorityState,
  type DeliveryBundle,
  type LocalWorkspaceProjection,
  type WorkspaceConfigurationImportResponse,
} from "./bus-client.js";
import {
  ensureProjectTemplate,
  loadProject,
  materializeSavedConfig,
  type ProjectLoadResult,
} from "./project.js";
import type { RuntimeAdapter } from "./adapters/runtime-adapter.js";
import { FakeRuntimeAdapter } from "./adapters/fake-runtime-adapter.js";
import { PiAgentCoreAdapter } from "./adapters/pi-agent-core-adapter.js";
import { FloeRuntimeAdapter } from "./adapters/floe-runtime-adapter.js";
import { TurnFailedError } from "./adapters/turn-failed-error.js";
import { HookRegistry } from "./hooks.js";
import { watchFolder } from "./folder-watcher.js";
import { selectPinnedRuntime, type PinnedRuntimeSelection } from "./runtime-processing-contract.js";
import {
  buildWorkspaceConfigurationInventory,
  type WorkspaceConfigurationInventory,
  type WorkspaceRuntimeObservation,
} from "./workspace-config-inventory.js";

const WEBHOOK_DEDUPE_MAX_EVENTS = 10_000;
const STREAM_INITIAL_BACKOFF_MS = 250;
const STREAM_MAX_BACKOFF_MS = 16_000;

type EndpointEntry = {
  config: AgentRuntimeConfig;
  instructions: string;
  workspace_locator?: string;
  workspace_id?: string;
  agent_id?: string;
};

type ResolvedAuthProfile = Readonly<{
  auth_profile: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  model_source: string | null;
  thinking_level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
}>;

type ObservedActorRuntime = Readonly<{
  endpoint_id: string;
  config: AgentRuntimeConfig;
  resolved_auth: ResolvedAuthProfile;
}>;

export type BridgeDaemonOptions = Readonly<{
  bridge_id?: string;
  transport_authority?: BridgeTransportAuthority | null;
}>;

export class BridgeDaemon {
  readonly bridgeId: string;
  readonly bus: BusClient;
  readonly adapter: RuntimeAdapter;
  readonly #bridgeServiceToken: string | null;
  private endpointRuntime = new Map<string, EndpointEntry>();
  private workspaceLocators = new Map<string, string>();
  private workspaceHooks = new Map<string, HookRegistry>();
  /**
   * Node-specific instructions bindings, keyed by `${endpoint_id}:${context_id}` — an actor
   * node's own material, injected into that actor's turns arising from that node's Context
   * via the BeforeTurn hook (same inject-once mechanism extension overlays already use).
   * Never merged into the actor's general `.floe/agents/*.md` instructions.
   */
  private nodeInstructionBindings = new Map<string, string>();
  private workspaceWatchers = new Map<string, Array<() => void>>();
  private attachmentPass: Promise<void> | null = null;
  private attachmentRequested = false;
  private processingEndpoints = new Set<string>();
  private processingDeliveryIds = new Map<string, string>();
  private pendingDeliveries = new Map<string, Map<string, DeliveryBundle>>();
  private cancelledDeliveries = new Set<string>();
  private reportedAttachments = new Map<string, string>();
  private firedWebhookEvents = new Set<string>();
  // D1: reconnect state
  private streamCancelled = false;
  private streamSocket: { close(code?: number, reason?: string): void; send(data: string): void } | null = null;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private streamBackoffMs = STREAM_INITIAL_BACKOFF_MS;
  private streamCursor: string | null = null;
  private streamMessageChain: Promise<void> = Promise.resolve();

  constructor(
    readonly configPath: string,
    readonly config: LocalConfig,
    options: BridgeDaemonOptions = {},
  ) {
    this.bridgeId = options.bridge_id ?? process.env.FLOE_BRIDGE_ID ?? "bridge:local";
    const injectedToken = Object.prototype.hasOwnProperty.call(options, "transport_authority")
      ? options.transport_authority?.bearer_token ?? ""
      : process.env.FLOE_BRIDGE_SERVICE_TOKEN ?? "";
    this.#bridgeServiceToken = injectedToken.trim() || null;
    this.bus = new BusClient(
      bridgeHttpBase(config),
      this.#bridgeServiceToken
        ? { audience: "bridge_service", bearer_token: this.#bridgeServiceToken }
        : null,
    );
    if (!isCredentialTransportSecure(bridgeWsBase(config))) {
      this.bus.markAuthorityUnavailable("insecure_transport");
    }
    this.adapter = chooseAdapter(configPath, config);
  }

  get transportAuthorityState(): BridgeTransportAuthorityState {
    return this.bus.authorityState;
  }

  async start(): Promise<void> {
    if (this.bus.authorityState?.status === "unavailable") {
      throw new BridgeTransportUnavailableError(this.bus.authorityState.reason);
    }
    await this.waitForBus();
    await this.bus.registerBridge({
      runtime_adapters: [this.adapter.name],
      workspace_access: this.config.bridge.workspace_access,
      capabilities: ["workspace_attach", "project_template_init", "agent_endpoint_registration", "delivery_claim"],
      release_version: process.env.FLOE_RELEASE_VERSION ?? null,
      build_sha: process.env.FLOE_BUILD_SHA ?? null,
    });
    this.openEventStream();
    await this.attachKnownWorkspaces();
    await this.processDeliveries();
  }

  async stop(): Promise<void> {
    // D1: cancel the event stream reconnect loop.
    this.streamCancelled = true;
    if (this.streamRetryTimer !== null) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
    if (this.streamSocket !== null) {
      try { this.streamSocket.close(); } catch { /* ignore */ }
      this.streamSocket = null;
    }
    this.firedWebhookEvents.clear();
    // Close all folder watchers so daemon shutdown leaves no dangling fs handles
    for (const [, stops] of this.workspaceWatchers) {
      for (const stop of stops) stop();
    }
    this.workspaceWatchers.clear();
    await this.adapter.dispose?.("bridge_shutdown");
  }

  private async waitForBus(): Promise<void> {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < 30_000) {
      try {
        await this.bus.health();
        return;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for floe-bus");
  }

  private openEventStream(): void {
    const WebSocketCtor = (globalThis as any).WebSocket as (new (url: string) => any) | undefined;
    if (!WebSocketCtor) return;

    const connect = (): void => {
      if (this.streamCancelled) return;
      const url = `${bridgeWsBase(this.config).replace(/\/$/, "")}/v1/events/stream`;
      let socket: any = null;
      try {
        socket = new WebSocketCtor(url);
      } catch {
        // WebSocket unavailable — schedule retry.
        this.scheduleStreamRetry(connect);
        return;
      }
      this.streamSocket = socket as { close(): void; send(data: string): void };
      let connectionAuthenticated = false;
      let connectionFailed = false;

      socket.addEventListener("open", () => {
        if (this.streamCancelled) { try { socket?.close(); } catch { /* ignore */ } return; }
        connectionAuthenticated = false;
        // Authentication is the first frame. The credential is never placed in
        // the URL, where browser history, proxies, and diagnostics could retain it.
        try {
          socket?.send(this.streamAuthenticationFrame());
        } catch (error) {
          if (error instanceof BridgeTransportUnavailableError) {
            try { socket?.close(4401, "bridge authority unavailable"); } catch { /* ignore */ }
            return;
          }
          try { socket?.close(); } catch { /* ignore */ }
        }
      });

      socket.addEventListener("message", (event: { data: string }) => {
        this.streamMessageChain = this.streamMessageChain.then(async () => {
          if (this.streamCancelled || connectionFailed) return;
          const message = JSON.parse(String(event.data));
          if (!connectionAuthenticated) {
            if (
              message?.type !== "authenticated"
              || message?.payload?.audience !== "bridge_service"
              || message?.payload?.bridge_id !== this.bridgeId
            ) {
              this.bus.markAuthorityUnavailable("credential_not_accepted");
              try { socket?.close(4401, "bridge authority unavailable"); } catch { /* ignore */ }
              return;
            }
            connectionAuthenticated = true;
            this.streamBackoffMs = STREAM_INITIAL_BACKOFF_MS;
            return;
          }
          if (message?.type === "caught_up") {
            if (typeof message?.payload?.cursor === "string") {
              this.streamCursor = message.payload.cursor;
            }
            // Catch-up is complete. These one-shot reads recover current host
            // state and any Delivery not represented by a retained stream frame.
            await this.attachKnownWorkspaces();
            await this.processDeliveries();
            return;
          }
          if (message?.type === "cursor_acknowledged") return;
          await this.handleEventStreamMessage(message);
          if (
            typeof message?.cursor === "string"
            && connectionAuthenticated
            && this.streamSocket === socket
          ) {
            socket?.send(JSON.stringify({ type: "acknowledge_cursor", cursor: message.cursor }));
            this.streamCursor = message.cursor;
          }
        }).catch((error) => {
          // Do not process or acknowledge later cursors after a failed frame;
          // reconnect from the last durable acknowledgement instead.
          console.error("[bridge] event stream frame failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          connectionFailed = true;
          connectionAuthenticated = false;
          try { socket?.close(1011, "bridge frame handling failed"); } catch { /* ignore */ }
        });
      });

      socket.addEventListener("close", (event: { code?: number }) => {
        if (this.streamSocket === socket) this.streamSocket = null;
        connectionAuthenticated = false;
        if (this.streamCancelled) return;
        if (event?.code === 4401 || this.bus.authorityState?.status === "unavailable") {
          this.bus.markAuthorityUnavailable?.("credential_not_accepted");
          return;
        }
        // D1: reconnect with exponential back-off.
        this.scheduleStreamRetry(connect);
      });

      socket.addEventListener("error", () => {
        // `close` fires after `error`, reconnect is handled there.
      });
    };

    connect();
  }

  private streamAuthenticationFrame(): string {
    if (!this.#bridgeServiceToken || this.bus.authorityState?.status === "unavailable") {
      const reason = this.bus.authorityState?.status === "unavailable"
        ? this.bus.authorityState.reason
        : "credential_missing";
      throw new BridgeTransportUnavailableError(reason);
    }
    return JSON.stringify({
      type: "authenticate",
      bearer_token: this.#bridgeServiceToken,
      ...(this.streamCursor ? { after_cursor: this.streamCursor } : {}),
    });
  }

  /** Schedule the next WS reconnect attempt with exponential back-off (D1). */
  private scheduleStreamRetry(connect: () => void): void {
    if (this.streamCancelled) return;
    const delay = this.streamBackoffMs;
    this.streamBackoffMs = Math.min(this.streamBackoffMs * 2, STREAM_MAX_BACKOFF_MS);
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = null;
      connect();
    }, delay);
  }

  private async handleEventStreamMessage(message: any): Promise<void> {
    if (message.type === "delivery_cancel_requested" && message.payload?.delivery_id) {
      const deliveryId = String(message.payload.delivery_id);
      this.cancelledDeliveries.add(deliveryId);
      await this.adapter.cancelDelivery?.(deliveryId);
    }
    if (
      message.type === "workspace_registered" ||
      message.type === "workspace_selected" ||
      message.type === "workspace_attachment_requested" ||
      message.type === "config_snapshot_requested" ||
      message.type === "scope_graph_created" ||
      message.type === "scope_graph_updated" ||
      message.type === "scope_graph_deleted" ||
      message.type === "scope_retired" ||
      message.type === "actor_runtime_binding_changed" ||
      message.type === "runtime_binding_updated" ||
      message.type === "runtime_binding_cleared"
    ) {
      await this.attachKnownWorkspaces();
      await this.processDeliveries();
    }
    if (message.type === "config_apply_requested" && message.payload?.workspace_id) {
      await this.applySavedConfig(String(message.payload.workspace_id), message.payload?.config_id ? String(message.payload.config_id) : null);
    }
    if (message.type === "delivery_bundle_available") {
      // D2: consume the pushed bundle directly when this bridge owns the endpoint.
      // The bus broadcasts the full DeliveryBundle at creation time with the lease
      // set server-side — no HTTP round-trip needed for the single-bridge case.
      const delivery = message.payload?.delivery as DeliveryBundle | undefined;
      if (
        delivery &&
        typeof delivery.endpoint_id === "string" &&
        this.endpointRuntime.has(delivery.endpoint_id)
      ) {
        this.dispatchDelivery(delivery);
      } else {
        // Multi-bridge / race fallback: let the HTTP claim path sort it out.
        await this.processDeliveries();
      }
    }
    if (message.type === "config_snapshot_requested" && message.payload?.workspace_id) {
      await this.returnSnapshot(String(message.payload.workspace_id));
    }
    if (message.type === "event_submitted") {
      await this.fireWebhookReceived(message.payload?.event);
    }
    // Slice 0 — context lifecycle hooks
    if (message.type === "context_compacted" && message.payload?.context_id) {
      await this.fireContextLifecycleHook("ContextCompacted", message.payload);
    }
    if (message.type === "context_history_cleared" && message.payload?.context_id) {
      await this.fireContextLifecycleHook("ContextHistoryCleared", message.payload);
    }
    // Slice 1 — dynamic participant hooks
    if (message.type === "participant_added" && message.payload?.context_id) {
      await this.fireContextLifecycleHook("ParticipantAdded", message.payload);
    }
    if (message.type === "participant_removed" && message.payload?.context_id) {
      await this.fireContextLifecycleHook("ParticipantRemoved", message.payload);
    }
  }

  private async fireWebhookReceived(event: any): Promise<void> {
    if (!event || event.type !== "webhook_received" || event.metadata?.trigger_kind !== "webhook") return;
    if (event.source_endpoint_id !== null) return;
    if (typeof event.event_id !== "string" || !event.event_id) return;
    if (typeof event.workspace_id !== "string" || !event.workspace_id) return;
    if (typeof event.metadata?.route_id !== "string" || !event.metadata.route_id) return;
    if (this.firedWebhookEvents.has(event.event_id)) return;
    const hooks = this.workspaceHooks.get(event.workspace_id);
    if (!hooks?.hasHandlers("WebhookReceived")) return;
    const destination = event.destination_json;
    this.firedWebhookEvents.add(event.event_id);
    this.pruneWebhookDedupe();
    await hooks.fire("WebhookReceived", {
      workspace_id: event.workspace_id,
      route_id: event.metadata.route_id,
      event_id: event.event_id,
      context_id: event.context_id ?? null,
      target_endpoint_id: destination?.kind === "endpoint" ? destination.endpoint_id : null,
      content: event.content ?? {},
      metadata: event.metadata ?? {}
    });
  }

  private pruneWebhookDedupe(): void {
    while (this.firedWebhookEvents.size > WEBHOOK_DEDUPE_MAX_EVENTS) {
      const oldestEventId = this.firedWebhookEvents.keys().next().value;
      if (oldestEventId === undefined) break;
      this.firedWebhookEvents.delete(oldestEventId);
    }
  }

  /** (to every registered HookRegistry
   * for the workspace identified by `payload.workspace_id`, if present; or all
   * workspaces when the broadcast payload does not carry workspace_id).
   */
  private async fireContextLifecycleHook(hook: import("./hooks.js").HookName, payload: any): Promise<void> {
    const workspaceId: string | undefined = payload?.workspace_id;
    if (workspaceId) {
      const hooks = this.workspaceHooks.get(workspaceId);
      if (hooks) {
        try {
          await hooks.fire(hook as any, payload);
        } catch (err) {
          console.error(`[bridge] ${hook} hook failed`, err);
        }
      }
    } else {
      for (const [, hooks] of this.workspaceHooks) {
        try {
          await hooks.fire(hook as any, payload);
        } catch (err) {
          console.error(`[bridge] ${hook} hook failed`, err);
        }
      }
    }
  }

  private async attachKnownWorkspaces(): Promise<void> {
    this.attachmentRequested = true;
    if (this.attachmentPass) return this.attachmentPass;
    const pass = (async () => {
      do {
        this.attachmentRequested = false;
        const workspaces = await this.bus.listWorkspaces();
        const currentWorkspaceIds = new Set(workspaces.map(workspace => workspace.workspace_id));
        for (const workspaceId of this.workspaceLocators.keys()) {
          if (!currentWorkspaceIds.has(workspaceId)) this.workspaceLocators.delete(workspaceId);
        }
        for (const workspace of workspaces) {
          await this.attachWorkspace(workspace);
        }
        // A push during this pass may describe a newer binding than we read.
        // Coalesce those notifications into one further pass, without polling.
      } while (this.attachmentRequested && !this.streamCancelled);
    })();
    this.attachmentPass = pass;
    try {
      await pass;
    } finally {
      if (this.attachmentPass === pass) this.attachmentPass = null;
    }
  }

  private async importProjectConfiguration(
    workspaceId: string,
    bindingId: string,
    project: ProjectLoadResult,
  ): Promise<Readonly<{
    inventory: WorkspaceConfigurationInventory;
    import_response: WorkspaceConfigurationImportResponse;
    observed_runtimes: ReadonlyMap<string, ObservedActorRuntime>;
  }>> {
    const observedEntries = await Promise.all(project.agents.map(async (agent) => {
      const endpointId = actorEndpointId(workspaceId, agent.agent_id);
      const runtimeConfig = extractRuntimeConfig(agent.frontmatter);
      const resolvedAuth = await this.resolveAuthProfile(workspaceId, endpointId, runtimeConfig);
      // floe-runtime drives the official vendor CLI, which authenticates itself:
      // Floe brokers no model credential for it. It still needs a model choice.
      // Only the fake adapter needs neither credential nor model.
      const credentialFree = this.adapter.name === "fake" || this.adapter.name === "floe-runtime";
      const observation: WorkspaceRuntimeObservation = {
        agent_id: agent.agent_id,
        adapter_id: this.adapter.name,
        backing_kind: "model",
        provider: resolvedAuth.provider ?? runtimeConfig.provider ?? null,
        model: resolvedAuth.model ?? runtimeConfig.model ?? null,
        thinking_level: resolvedAuth.thinking_level ?? runtimeConfig.thinking_level ?? null,
        credential_requirement: credentialFree ? "none" : "required",
        required_configuration_keys: this.adapter.name === "fake" ? [] : ["model"],
        required_capability_ids: [],
        checkpoint_policy: { mode: "none", schema_ref: null },
        resource_policy: {},
      };
      return [agent.agent_id, {
        endpoint_id: endpointId,
        config: runtimeConfig,
        resolved_auth: resolvedAuth,
        observation,
      }] as const;
    }));
    const observedRuntimes = new Map(observedEntries.map(([agentId, observed]) => [agentId, {
      endpoint_id: observed.endpoint_id,
      config: observed.config,
      resolved_auth: observed.resolved_auth,
    }]));
    const inventory = buildWorkspaceConfigurationInventory({
      binding_id: bindingId,
      project,
      runtimes: observedEntries.map(([, observed]) => observed.observation),
    });
    const importResponse = await this.bus.importWorkspaceConfiguration(workspaceId, inventory);
    return {
      inventory,
      import_response: importResponse,
      observed_runtimes: observedRuntimes,
    };
  }

  private async attachWorkspace(workspace: LocalWorkspaceProjection): Promise<void> {
    if (!workspace?.workspace_id) return;
    this.workspaceLocators.delete(workspace.workspace_id);
    const binding = workspace?.binding;
    if (!binding?.binding_id || !binding.locator) return;
    if (!binding.init_authorized) return;

    const workspaceId = String(workspace.workspace_id);
    const bindingId = String(binding.binding_id);
    const locator = resolve(String(binding.locator));
    if (!this.config.bridge.workspace_access.local_paths || !existsSync(locator)) {
      await this.reportOnce(workspaceId, bindingId, "workspace_inaccessible", "workspace_locator_inaccessible", null, {
        ok: false,
        warnings: [],
        errors: [`Workspace locator is inaccessible: ${locator}`]
      });
      return;
    }
    this.workspaceLocators.set(workspaceId, locator);

    try {
      let project: ProjectLoadResult | undefined;
      let canonicalImport: Awaited<ReturnType<BridgeDaemon["importProjectConfiguration"]>> | undefined;
      let importError: string | null = null;
      try {
        ensureProjectTemplate(locator, String(workspace.name ?? "Floe Project"));
        project = loadProject(locator);
        canonicalImport = await this.importProjectConfiguration(workspaceId, bindingId, project);
      } catch (error) {
        if (error instanceof BridgeTransportUnavailableError) throw error;
        importError = (error as Error).message;
      }
      const importReceipt = canonicalImport?.import_response.import_result.receipt;
      const importApplied = importReceipt?.outcome === "applied";
      // Import observes source files. Attachment discovers current retained
      // Actors, including those created or changed through ordinary operations.
      // Actual instructions, model and authority still come from Delivery pins.
      const runtimes = (await this.bus.listRuntimeEndpoints(workspaceId, bindingId))
        .filter(runtime => runtimeAdapterMatches(runtime.adapter_id, this.adapter.name));
      for (const [endpointId, entry] of this.endpointRuntime) {
        if (entry.workspace_id === workspaceId) this.endpointRuntime.delete(endpointId);
      }
      for (const runtime of runtimes) {
        this.endpointRuntime.set(runtime.endpoint_id, {
          config: {}, instructions: "", workspace_locator: locator, workspace_id: workspaceId,
          agent_id: runtime.agent_id ?? undefined,
        });
        if (this.processingEndpoints.has(runtime.endpoint_id)) continue;
        await this.bus.registerEndpoint({
          endpoint_id: runtime.endpoint_id,
          workspace_id: workspaceId,
          name: runtime.name,
          agent_id: runtime.agent_id,
          status: runtime.runtime_status === "resolved" ? "idle" : "runtime_unconfigured",
          metadata: {
            runtime_adapter: runtime.adapter_id,
            actor_definition_revision_id: runtime.actor_definition_revision_id,
            runtime_profile_revision_id: runtime.runtime_profile_revision_id,
            actor_runtime_binding_id: runtime.actor_runtime_binding_id,
            runtime_unresolved_reasons: runtime.unresolved_reasons,
          }
        });
      }

      const hookRegistry = new HookRegistry();
      this.registerNodeInstructionsHook(hookRegistry);
      this.workspaceHooks.set(workspaceId, hookRegistry);
      if (!importApplied || !project) {
        // Unimported file changes cannot start or replace legacy Event sources.
        const canAttach = runtimes.length > 0;
        await this.reportOnce(workspaceId, bindingId, canAttach ? "attached" : "config_invalid",
          canAttach ? null : importReceipt?.refusal?.code ?? "workspace_configuration_import_refused", null, {
            ok: canAttach,
            import_receipt_id: importReceipt?.import_receipt_id ?? null,
            import_refusal: importReceipt?.refusal ?? null,
            import_error: importError,
            unavailable_actors: runtimes.filter(runtime => runtime.runtime_status !== "resolved")
              .map(runtime => ({ actor_id: runtime.actor_id, reasons: runtime.unresolved_reasons })),
          });
        return;
      }

      // Register pulses defined in floe.yaml
      for (const pulseDef of project.pulses) {
        try {
          await this.bus.createPulse({
            pulse_id: pulseDef.id,
            workspace_id: workspace.workspace_id,
            persistence: pulseDef.persistence ?? "workspace",
            scope_id: pulseDef.scope_id,
            trigger: pulseDef.trigger,
            content: pulseDef.content,
            subscribers: pulseDef.subscribers ?? [],
          });
        } catch (error) {
          console.error("[bridge] pulse registration failed", { pulse_id: pulseDef.id, error });
        }
      }

      // Legacy Scope graphs remain readable for Actor instruction bindings and
      // Event sources. Command execution is owned by the canonical Bus Command
      // host; the Bridge never discovers or executes graph-authored shell text.
      let scopeGraphs: Array<{ graph_id: string; context_id: string; nodes: any[] }> = [];
      try {
        const { graphs } = await this.bus.listScopeGraphsForWorkspace(workspace.workspace_id);
        scopeGraphs = graphs as Array<{ graph_id: string; context_id: string; nodes: any[] }>;
        for (const graph of scopeGraphs) {
          for (const node of graph.nodes) {
            if (node.kind === "actor" && Array.isArray(node.bindings) && node.bindings.length > 0) {
              const text = node.bindings
                .filter((binding: any) => binding.kind === "instructions" && typeof binding.text === "string")
                .map((binding: any) => binding.text)
                .join("\n\n");
              if (text) this.nodeInstructionBindings.set(`${node.endpoint_id}:${graph.context_id}`, text);
            }
          }
        }
      } catch (error) {
        console.error("[bridge] legacy Scope graph inspection failed", { workspace_id: workspace.workspace_id, error });
      }

      // Start folder Event sources. Legacy floe.yaml watchers remain readable,
      // while new sources are stored with the Event node that owns them.
      for (const stop of this.workspaceWatchers.get(workspace.workspace_id) ?? []) stop();
      const watcherStops: Array<() => void> = [];
      const startedWatchers = new Set<string>();
      const startWatcher = (watcherDef: {
        id: string;
        graph_id: string;
        node_id: string;
        path: string;
        extensions?: string[];
        settle_ms?: number;
      }): void => {
        const watchPath = resolve(locator, watcherDef.path);
        const workspaceRelative = relative(locator, watchPath);
        const watcherKey = `${watcherDef.graph_id}:${watcherDef.node_id}:${watchPath}`;
        if (workspaceRelative.startsWith("..") || isAbsolute(workspaceRelative)) {
          console.error("[bridge] watcher path escapes workspace — skipping", { watcher_id: watcherDef.id, path: watchPath });
          return;
        }
        if (!existsSync(watchPath) || startedWatchers.has(watcherKey)) {
          if (!existsSync(watchPath)) {
            console.error("[bridge] watcher path does not exist — skipping", { watcher_id: watcherDef.id, path: watchPath });
          }
          return;
        }
        startedWatchers.add(watcherKey);
        const stop = watchFolder(watchPath, arrival => {
          this.bus.fireScopeGraphTriggerNode(workspace.workspace_id, watcherDef.graph_id, watcherDef.node_id, {
            content: {
              file_name: arrival.file_name,
              file_path: arrival.file_path,
              channel: "watched_folder",
              locator: arrival.file_path,
              observed_at: arrival.observed_at,
              raw_reference: arrival.file_path,
              arrival_id: arrival.arrival_id,
            },
            idempotency_key: `folder-arrival:${watcherDef.graph_id}:${watcherDef.node_id}:${arrival.arrival_id}`,
          }).catch(error => {
            console.error("[bridge] watcher trigger fire failed", { watcher_id: watcherDef.id, error });
          });
        }, {
          extensions: watcherDef.extensions,
          settle_ms: watcherDef.settle_ms
        });
        watcherStops.push(stop);
      };

      for (const watcherDef of project.watchers) startWatcher(watcherDef);
      for (const graph of scopeGraphs) {
        for (const node of graph.nodes) {
          if (node.kind !== "trigger" || node.source?.kind !== "folder" || typeof node.source.path !== "string") {
            continue;
          }
          startWatcher({
            id: `${graph.graph_id}:${node.node_id}`,
            graph_id: graph.graph_id,
            node_id: node.node_id,
            path: node.source.path,
            extensions: node.source.extensions,
            settle_ms: node.source.settle_ms,
          });
        }
      }
      this.workspaceWatchers.set(workspace.workspace_id, watcherStops);

      // Extension installation and activation are owned by the canonical Bus
      // lifecycle. The Bridge never imports workspace package code. Hooks here
      // contain only trusted Bridge-owned behaviour.
      await this.reportOnce(workspaceId, bindingId, "attached", null, importReceipt.config_hash, {
        ...canonicalImport!.inventory.validation,
        import_receipt_id: importReceipt.import_receipt_id,
        unavailable_actors: runtimes
          .filter((actor) => actor.runtime_status !== "resolved")
          .map((actor) => ({
            actor_id: actor.actor_id,
            reasons: actor.unresolved_reasons,
          })),
      });
    } catch (error) {
      await this.reportOnce(workspaceId, bindingId, "attach_failed", "bridge_attach_failed", null, {
        ok: false,
        warnings: [],
        errors: [(error as Error).message]
      });
    }
  }

  private async reportOnce(
    workspaceId: string,
    bindingId: string,
    status: string,
    errorCode: string | null,
    configHash: string | null,
    validation: unknown
  ): Promise<void> {
    const key = JSON.stringify({ bindingId, status, errorCode, configHash, validation });
    if (this.reportedAttachments.get(workspaceId) === key) return;
    await this.bus.reportAttachment(workspaceId, {
      binding_id: bindingId,
      status,
      config_hash: configHash,
      error_code: errorCode,
      validation
    });
    this.reportedAttachments.set(workspaceId, key);
  }

  private async returnSnapshot(workspaceId: string): Promise<void> {
    const workspaces = await this.bus.listWorkspaces();
    const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
    if (!workspace) return;
    const binding = workspace.binding;
    if (!binding?.binding_id || !binding.locator) return;
    const bindingId = String(binding.binding_id);
    const locator = resolve(String(binding.locator));
    if (!existsSync(locator)) return;
    const project = loadProject(locator);
    await this.importProjectConfiguration(workspaceId, bindingId, project);
  }

  private async applySavedConfig(workspaceId: string, configId: string | null): Promise<void> {
    const workspaces = await this.bus.listWorkspaces();
    const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
    if (!workspace) return;
    const binding = workspace.binding;
    if (!binding?.binding_id || !binding.locator) return;
    const bindingId = String(binding.binding_id);
    const locator = resolve(String(binding.locator));
    if (!existsSync(locator)) {
      await this.reportOnce(workspaceId, bindingId, "workspace_inaccessible", "workspace_locator_inaccessible", null, {
        ok: false,
        warnings: [],
        errors: [`Workspace locator is inaccessible: ${locator}`]
      });
      return;
    }
    const configs = await this.bus.listConfigs();
    const record = configs.find((item) => item.config_id === configId);
    if (!record) {
      await this.reportOnce(workspaceId, bindingId, "config_apply_failed", "saved_config_not_found", null, {
        ok: false,
        warnings: [],
        errors: [`Saved config not found: ${configId ?? "(none)"}`]
      });
      return;
    }
    const configJson = typeof record.config_json === "string" ? JSON.parse(record.config_json) : record.config_json;
    materializeSavedConfig(locator, configJson);
    this.reportedAttachments.delete(workspaceId);
    await this.attachWorkspace(workspace);
  }

  private async processDeliveries(): Promise<void> {
    // HTTP-claim fallback path (multi-bridge / race case, startup resync).
    // Per-endpoint locking handled in the direct-consume path; here we just process
    // whatever the claim endpoint returns, skipping any endpoint already in-flight.
    try {
      const deliveries = await this.bus.claimDeliveries();
      for (const delivery of deliveries) {
        this.dispatchDelivery(delivery);
      }
    } catch (error) {
      console.error("[bridge] delivery processing failed", error);
      throw error;
    }
  }

  private dispatchDelivery(delivery: DeliveryBundle): void {
    if (this.processingEndpoints.has(delivery.endpoint_id)) {
      if (this.processingDeliveryIds.get(delivery.endpoint_id) === delivery.delivery_id) return;
      let pending = this.pendingDeliveries.get(delivery.endpoint_id);
      if (!pending) this.pendingDeliveries.set(delivery.endpoint_id, pending = new Map());
      pending.set(delivery.delivery_id, delivery);
      return;
    }
    this.processingEndpoints.add(delivery.endpoint_id);
    this.processingDeliveryIds.set(delivery.endpoint_id, delivery.delivery_id);
    void (async () => {
      try {
        await this.handleDelivery(delivery);
      } catch (error) {
        console.error("[bridge] delivery handling escaped", {
          delivery_id: delivery.delivery_id, endpoint_id: delivery.endpoint_id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.processingEndpoints.delete(delivery.endpoint_id);
        this.processingDeliveryIds.delete(delivery.endpoint_id);
        // A pushed reservation can arrive before the previous runtime finishes
        // unwinding. Retain it until then; prepareRuntimeDelivery still checks
        // the authoritative lease and terminal state before it can execute.
        const pending = this.pendingDeliveries.get(delivery.endpoint_id);
        const next = pending?.values().next().value;
        if (next) pending!.delete(next.delivery_id);
        if (!pending?.size) this.pendingDeliveries.delete(delivery.endpoint_id);
        if (next) this.dispatchDelivery(next);
      }
    })();
  }

  private async handleDelivery(delivery: DeliveryBundle): Promise<void> {
    // A cancellation can overtake a delivery that was already pushed to this
    // bridge but has not started executing yet. Do not let that stale in-memory
    // bundle enter either a command process or a model runtime.
    if (this.cancelledDeliveries.delete(delivery.delivery_id)) {
      console.log("[bridge] cancelled delivery skipped before execution", {
        delivery_id: delivery.delivery_id,
        endpoint_id: delivery.endpoint_id,
      });
      await this.reportTurnEndSafely(delivery.endpoint_id);
      return;
    }

    console.log("[bridge] delivery claimed", {
      delivery_id: delivery.delivery_id,
      endpoint_id: delivery.endpoint_id,
      workspace_id: delivery.workspace_id,
      event_count: delivery.events.length
    });

    try {
      const endpointEntry = this.endpointRuntime.get(delivery.endpoint_id);
      const runtimeConfig = endpointEntry?.config;
      const instructions = endpointEntry?.instructions;
      let preparedAttemptId: string | null = null;
      let operationAuthoritySession: Awaited<ReturnType<BusClient["prepareRuntimeDelivery"]>>["operation_authority_session"] | undefined;
      let pinnedRuntime: PinnedRuntimeSelection | undefined;
      let effectiveRuntime: AgentRuntimeConfig;
      const hasCanonicalRuntimePins = Boolean(
        delivery.processing_contract
        || delivery.node_execution_id
        || (
          delivery.actor_definition_revision_id
          && delivery.runtime_profile_revision_id
          && delivery.actor_runtime_binding_id
        )
      );
      if (hasCanonicalRuntimePins) {
        const prepared = await this.bus.prepareRuntimeDelivery(delivery.delivery_id);
        const contract = prepared.processing_contract;
        const contractMatchesDelivery = contract.contract_kind === "direct_context"
          ? contract.delivery.delivery_id === delivery.delivery_id
            && contract.delivery.endpoint_id === delivery.endpoint_id
          : contract.node_execution.node_execution_id === delivery.node_execution_id;
        if (!contractMatchesDelivery || contract.workspace_id !== delivery.workspace_id) {
          throw new RuntimeAuthError(
            "runtime_processing_contract_mismatch",
            "The prepared runtime processing contract does not belong to this Delivery.",
          );
        }
        const pinned = selectPinnedRuntime(contract);
        pinnedRuntime = pinned;
        if (!runtimeAdapterMatches(pinned.adapter_id, this.adapter.name)) {
          throw new RuntimeAuthError(
            "runtime_profile_provider_mismatch",
            `The pinned runtime profile requires adapter '${pinned.adapter_id}', but this Bridge runs '${this.adapter.name}'.`,
          );
        }
        delivery.processing_contract = contract;
        operationAuthoritySession = prepared.operation_authority_session;
        if (contract.contract_kind === "scope_node") {
          preparedAttemptId = contract.execution_attempt.attempt_id;
          delivery.execution_attempt_id = preparedAttemptId;
        }
        effectiveRuntime = pinned.config;
      } else {
        // Pre-canonical Endpoints remain readable during the current data
        // upgrade. Canonical direct Context work always carries a Bus-issued
        // processing contract and never resolves mutable runtime state here.
        const placementInstructions = delivery.node_contract?.node.kind === "actor"
          ? (delivery.node_contract.node.bindings ?? [])
              .filter((binding) => binding.kind === "instructions" && binding.text.trim().length > 0)
              .map((binding) => binding.text.trim())
              .join("\n\n")
          : "";
        const resolvedAuth = await this.resolveAuthProfile(delivery.workspace_id, delivery.endpoint_id, runtimeConfig);
        effectiveRuntime = {
          ...runtimeConfig,
          provider: resolvedAuth.provider ?? runtimeConfig?.provider ?? undefined,
          auth_profile: resolvedAuth.auth_profile ?? undefined,
          auth_profile_source: resolvedAuth.source ?? undefined,
          model: resolvedAuth.model ?? runtimeConfig?.model ?? undefined,
          model_source: resolvedAuth.model_source ?? undefined,
          thinking_level: resolvedAuth.thinking_level ?? runtimeConfig?.thinking_level ?? undefined,
          instructions: [instructions?.trim(), placementInstructions]
            .filter((value): value is string => Boolean(value))
            .join("\n\n") || undefined,
        };
      }
      console.log("[bridge] effective runtime resolved", {
        delivery_id: delivery.delivery_id,
        provider: effectiveRuntime.provider ?? "(none)",
        model: effectiveRuntime.model ?? "(none)",
        model_source: effectiveRuntime.model_source ?? "(none)",
        auth_profile: effectiveRuntime.auth_profile ?? "(none)",
        auth_profile_source: effectiveRuntime.auth_profile_source ?? "(none)",
        instructions_bytes: instructions?.length ?? 0
      });
      const credentialPin = pinnedRuntime && this.adapter.credentialRequirement !== "none"
        ? {
            provider: pinnedRuntime.config.provider?.trim() ?? "",
            secret_ref_id: pinnedRuntime.secret_ref_ids.length === 1
              ? pinnedRuntime.secret_ref_ids[0]
              : "",
          }
        : undefined;
      if (credentialPin && (!credentialPin.provider || !credentialPin.secret_ref_id)) {
        throw new RuntimeAuthError(
          "runtime_credential_unresolved",
          "The pinned Runtime Profile does not have one unambiguous provider credential.",
        );
      }
      const injected = await this.bus.reportDeliveryStatus(delivery.delivery_id, "injected_to_runtime");
      // Older Bus versions and test doubles acknowledge the transition without
      // returning the canonical attempt handle. Keep that compatibility at the
      // transport seam; a current Bus always returns the handle.
      delivery.execution_attempt_id = injected?.execution_attempt_id ?? delivery.execution_attempt_id ?? null;
      if (preparedAttemptId && delivery.execution_attempt_id !== preparedAttemptId) {
        throw new Error(
          `The Bus changed ExecutionAttempt from '${preparedAttemptId}' to '${delivery.execution_attempt_id ?? "none"}' before runtime injection.`,
        );
      }
      console.log("[bridge] delivery injected to runtime", { delivery_id: delivery.delivery_id, adapter: this.adapter.name });

      let credentialStore: BrokeredDeliveryCredentialStore | undefined;
      if (credentialPin) {
        credentialStore = new BrokeredDeliveryCredentialStore(
          this.bus,
          delivery.delivery_id,
          credentialPin.secret_ref_id,
          credentialPin.provider,
        );
      }

      const hookRegistry = this.workspaceHooks.get(delivery.workspace_id);

      await this.adapter.handleBundle({
        bridge_id: this.bridgeId,
        bus: this.bus,
        workspace_locator: this.workspaceLocators.get(delivery.workspace_id),
        agent_id: endpointEntry?.agent_id,
        hooks: hookRegistry,
        operation_authority_session: operationAuthoritySession,
        credential_store: credentialStore,
      }, delivery, effectiveRuntime);
      if (this.cancelledDeliveries.delete(delivery.delivery_id)) {
        await this.reportTurnEndSafely(delivery.endpoint_id);
        return;
      }
      await this.bus.reportDeliveryStatus(delivery.delivery_id, "acknowledged");
      console.log("[bridge] delivery acknowledged", { delivery_id: delivery.delivery_id });
      await this.reportTurnEndSafely(delivery.endpoint_id);
    } catch (error) {
      console.error("[bridge] adapter failed", error);
      if (this.cancelledDeliveries.delete(delivery.delivery_id)) {
        console.log("[bridge] cancelled delivery stopped", { delivery_id: delivery.delivery_id });
        await this.reportTurnEndSafely(delivery.endpoint_id);
        return;
      }
      const deferCodes = [
        "runtime_profile_required",
        "provider_auth_missing",
        "runtime_profile_provider_mismatch",
        "runtime_provider_required",
        "runtime_model_required",
        "runtime_model_unknown",
        "runtime_credential_unresolved"
      ] as const;
      if (error instanceof RuntimeAuthError && (deferCodes as readonly string[]).includes(error.code)) {
        console.log("[bridge] delivery deferred", { delivery_id: delivery.delivery_id, code: error.code });
        await this.bus.appendRuntimeTelemetry({
          workspace_id: delivery.workspace_id,
          endpoint_id: delivery.endpoint_id,
          delivery_id: delivery.delivery_id,
          kind: error.code,
          payload: {
            code: error.code,
            message: error.message
          }
        });
        await this.bus.reportDeliveryStatus(delivery.delivery_id, "deferred", `${error.code}: ${error.message}`);
        return;
      }

      // Once a turn has entered the runtime it may already have produced file,
      // command, or event effects. Runtime failure is therefore terminal for
      // this invocation; automatic replay would be unsafe. A fresh operator or
      // actor event can deliberately retry after inspecting the recorded work.
      if (error instanceof TurnFailedError) {
        console.log("[bridge] turn failed", {
          delivery_id: error.delivery_id,
          source_endpoint_id: error.source_endpoint_id,
          model: error.model_id,
          http_status: error.http_status
        });
        const errorSummary =
          `Runtime turn failed for model '${error.model_id}' (provider: ${error.provider})` +
          (error.http_status ? `, HTTP ${error.http_status}` : "") +
          `: ${error.message}`;
        await this.bus.reportDeliveryStatus(delivery.delivery_id, "dead_lettered", error.message);
        try {
          await this.bus.recordRuntimeTurnResult({
            delivery_id: delivery.delivery_id,
            outcome: "failed",
            text: errorSummary,
            metadata: {
              runtime: "pi-agent-core",
              origin: "turn_failed",
              model: error.model_id,
              provider: error.provider,
              http_status: error.http_status,
              safe_to_retry_automatically: false
            }
          });
        } catch (recordErr) {
          console.error("[bridge] failed to record terminal turn failure", recordErr);
        }
        await this.reportTurnEndSafely(delivery.endpoint_id);
        return;
      }

      console.log("[bridge] delivery failed", {
        delivery_id: delivery.delivery_id,
        error: (error as Error).message
      });
      const message = error instanceof Error ? error.message : String(error);
      await this.bus.reportDeliveryStatus(delivery.delivery_id, "dead_lettered", message);
      try {
        await this.bus.recordRuntimeTurnResult({
          delivery_id: delivery.delivery_id,
          outcome: "failed",
          text: `Runtime turn stopped before it could report a durable completion: ${message}`,
          metadata: {
            origin: "runtime_error",
            safe_to_retry_automatically: false
          }
        });
      } catch (recordErr) {
        console.error("[bridge] failed to record terminal runtime error", recordErr);
      }
      await this.reportTurnEndSafely(delivery.endpoint_id);
    }
  }

  /**
   * Registers the BeforeTurn handler that injects an actor node's own
   * instructions binding — node-specific material, distinct from the actor's
   * general `.floe/agents/*.md` instructions — using the exact inject-once
   * mechanism extension overlays already use (dedup happens in the adapter's
   * InjectionBaseline, keyed by context_id + this result's `source`). Keying
   * `source` by endpoint_id keeps each actor node's baseline independent
   * within a shared graph Context, so alternating actors don't stomp on each
   * other's dedup state.
   */
  private registerNodeInstructionsHook(hookRegistry: HookRegistry): void {
    hookRegistry.on("BeforeTurn", "_substrate_node_bindings", (payload) => {
      if (payload.origin?.kind !== "context") return;
      const text = this.nodeInstructionBindings.get(`${payload.endpoint_id}:${payload.origin.id}`);
      if (!text) return;
      return { inject: { source: `node_instructions:${payload.endpoint_id}`, content: text } };
    });
  }

  private async reportTurnEndSafely(endpointId: string): Promise<void> {
    try {
      await this.bus.reportTurnEnd(endpointId);
      console.log("[bridge] turn end reported", { endpoint_id: endpointId });
    } catch (error) {
      console.error("[bridge] turn end report failed", {
        endpoint_id: endpointId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async updateEndpointStatusSafely(endpointId: string, status: string): Promise<void> {
    try {
      await this.bus.updateEndpointStatus(endpointId, status);
    } catch (error) {
      console.error("[bridge] endpoint status report failed", {
        endpoint_id: endpointId,
        status,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resolveAuthProfile(
    workspaceId: string,
    endpointId: string,
    runtimeConfig: AgentRuntimeConfig | undefined
  ): Promise<ResolvedAuthProfile> {
    const bindings = await this.bus.resolveRuntimeBinding(workspaceId, endpointId);
    if (bindings.endpoint_auth_profile) {
      return {
        auth_profile: bindings.endpoint_auth_profile,
        provider: bindings.endpoint_provider ?? bindings.workspace_provider ?? bindings.global_provider ?? null,
        model: bindings.endpoint_model ?? bindings.workspace_model ?? bindings.global_model ?? null,
        source: "agent_binding",
        model_source: bindings.endpoint_model ? "agent_binding" : bindings.workspace_model ? "workspace_binding" : bindings.global_model ? "global_binding" : null,
        thinking_level: (bindings.endpoint_thinking_level ?? bindings.workspace_thinking_level ?? bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (bindings.workspace_auth_profile) {
      return {
        auth_profile: bindings.workspace_auth_profile,
        provider: bindings.workspace_provider ?? bindings.global_provider ?? null,
        model: bindings.workspace_model ?? bindings.global_model ?? null,
        source: "workspace_binding",
        model_source: bindings.workspace_model ? "workspace_binding" : bindings.global_model ? "global_binding" : null,
        thinking_level: (bindings.workspace_thinking_level ?? bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (runtimeConfig?.auth_profile?.trim()) {
      return {
        auth_profile: runtimeConfig.auth_profile.trim(),
        provider: runtimeConfig.provider?.trim() || null,
        model: null,
        source: "project_runtime",
        model_source: null,
        thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (bindings.global_auth_profile) {
      return {
        auth_profile: bindings.global_auth_profile,
        provider: bindings.global_provider ?? null,
        model: bindings.global_model ?? null,
        source: "runtime_binding_global",
        model_source: bindings.global_model ? "global_binding" : null,
        thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (this.config.runtime?.default_auth_profile?.trim()) {
      return {
        auth_profile: this.config.runtime.default_auth_profile.trim(),
        provider: runtimeConfig?.provider?.trim() || null,
        model: null,
        source: "config_global_default",
        model_source: null,
        thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    return {
      auth_profile: null,
      provider: runtimeConfig?.provider?.trim() || null,
      model: null,
      source: null,
      model_source: null,
      thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
    };
  }
}

export function chooseAdapter(configPath: string, config: LocalConfig): RuntimeAdapter {
  const configured = process.env.FLOE_RUNTIME_ADAPTER ?? config.bridge.runtime_adapter;
  const live = () => new PiAgentCoreAdapter(createBridgeAuthRuntime(configPath, config));
  if (!configured) return live();
  const selected = configured.trim().toLowerCase();
  if (selected === "fake") return new FakeRuntimeAdapter();
  if (selected === "floe-runtime") return new FloeRuntimeAdapter();
  // pi remains selectable so there is a working checkpoint to fall back to.
  if (["pi", "pi-agent-core"].includes(selected)) return live();
  throw new Error(`Unsupported FLOE runtime adapter "${selected}". Use "fake", "floe-runtime", or "pi-agent-core".`);
}

function runtimeAdapterMatches(requiredAdapterId: string, activeAdapterName: string): boolean {
  const required = requiredAdapterId.trim().toLowerCase();
  const active = activeAdapterName.trim().toLowerCase();
  if (required === active) return true;
  if (active === "pi-agent-core" && ["pi"].includes(required)) return true;
  return false;
}

function actorEndpointId(workspaceId: string, agentId: string): string {
  return `actor:${workspaceId}:${agentId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRuntimeConfig(frontmatter: Record<string, unknown>): AgentRuntimeConfig {
  const runtime = (frontmatter.runtime ?? {}) as Record<string, unknown>;
  return {
    provider: typeof runtime.provider === "string" ? runtime.provider : undefined,
    model: typeof runtime.model === "string" ? runtime.model : undefined,
    auth_profile: typeof runtime.auth_profile === "string" ? runtime.auth_profile : undefined
  };
}
