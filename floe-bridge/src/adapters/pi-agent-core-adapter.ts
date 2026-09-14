/**
 * @invariant This adapter is the only Pi Agent Core embodiment for Floe runtime turns.
 * Session reuse must stay keyed to the effective runtime configuration so that model or
 * thinking changes rebuild the session before processing the next delivery.
 */
import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AgentRuntimeConfig, BridgeAuthRuntime, ModelThinkingCapability, RuntimeAuthResolved } from "../auth.js";
import { resolveBrokeredRuntimeAuth, resolveRuntimeAuth } from "../auth.js";
import type { DeliveryBundle, EventEnvelope, RuntimeOperationAuthoritySession } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { HookPayload, HookRegistry } from "../hooks.js";
import { InjectionBaseline } from "../injection-baseline.js";
import { buildSystemPrompt, appendWorkLog, toNeutralRef, toNeutralEndpoint, deliveryToPrompt, eventAttachments, renderHookInjections, executeEmit, executeRequest } from "../runtime-core/index.js";
import type { NeutralEndpoint } from "../runtime-core/index.js";
import type { WorkLogEntry } from "../runtime-core/index.js";
import { createRuntimeTools, runtimeToolsFingerprint } from "../tools/runtime-tools.js";
import { TurnFailedError } from "./turn-failed-error.js";

export { TurnFailedError } from "./turn-failed-error.js";
// eventContentToPrompt/eventAttachments now live in runtime-core; re-exported
// here to preserve this module's existing public test surface.
export { eventContentToPrompt, eventAttachments } from "../runtime-core/index.js";

/**
 * Internal sentinel thrown from finalizeTurn when pi completes a turn with
 * stopReason === 'error' (no HTTP throw from the runtime). Carries the pi
 * errorMessage so the handleBundle catch path can build a TurnFailedError
 * without re-recording telemetry that finalizeTurn already emitted.
 */
class PiErrorStopReasonSignal extends Error {
  readonly code = "pi_error_stop_reason" as const;
  constructor(
    readonly piErrorMessage: string | null,
    readonly piHttpStatus: number | null
  ) {
    super(piErrorMessage ?? "Pi runtime returned stop_reason 'error' with no error message.");
    this.name = "PiErrorStopReasonSignal";
  }
}

type AgentLike = {
  prompt(input: unknown): Promise<void>;
  subscribe(listener: (event: any) => void | Promise<void>): void;
  abort?(): void;
  followUp?(input: unknown): void;
  reset?(): void;
};

type AgentFactoryInput = {
  model: RuntimeAuthResolved["model"];
  tools: AgentTool[];
  getApiKey: () => Promise<string>;
  systemPrompt: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

type AgentFactory = (input: AgentFactoryInput) => AgentLike;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

type TurnCompletion =
  | { outcome: "completed" }
  | { outcome: "failed"; error: unknown };

type RuntimeTurnContext = {
  runtime_turn_id: string;
  delivery_id: string;
  processing_contract_id?: string;
  operation_authority_session?: RuntimeOperationAuthoritySession;
  stable_delivery_ids: string[];
  execution_attempt_id: string | null;
  scope_execution_id: string | null;
  composition_revision_id: string | null;
  node_execution_id: string | null;
  target_node_id: string | null;
  target_port_ids: string[];
  output_ports: Array<{
    port_id: string;
    name: string;
    event_types?: string[];
    artefact_types?: string[];
    schema_ref?: string | null;
    min_count?: number;
    max_count?: number | null;
  }>;
  endpoint_id: string;
  workspace_id: string;
  scope_id: string | null;
  thread_id: string;
  source_endpoint_id: string;
  started_at: string;
  trigger_event_id: string;
  invocation_request_event_id: string | null;
  context_id: string | null;
  visible_output: string;
  last_visible_telemetry_text: string;
  dependency_requested: boolean;
  finalized: boolean;
  cancelled?: boolean;
  usage_messages: WeakSet<object>;
  usage_response_count: number;
  completion: Deferred<TurnCompletion>;
  tool_activity: Array<{ name: string; call_id?: string; summary?: string; is_error?: boolean; files_touched?: string[]; duration_ms?: number }>;
  emitted_events: Array<{ type: string; destination: string; text_preview: string; response_expected: boolean }>;
};

type SessionState = {
  agent: AgentLike;
  initialized: boolean;
  endpointId: string;
  contextId: string;          // The context this session is bound to ("no-context" when none)
  workspaceId: string;
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  instructionsHash: string;
  systemInstructionChars: number;
  runtimeToolsFingerprint: string;
  getApiKey: () => Promise<string>;
  context?: RuntimeContext;
  activeTurn?: RuntimeTurnContext;
};

export class PiAgentCoreAdapter implements RuntimeAdapter {
  readonly name = "pi-agent-core";
  private sessions = new Map<string, SessionState>();
  private readonly agentFactory: AgentFactory;
  private readonly turnFinalizeTimeoutMs: number;
  /** Slice C: inject-once dedup — tracks last-injected content hash per (context, source). */
  private readonly baseline = new InjectionBaseline();
  /**
   * Slice C: registries we have already wired the lifecycle-reset handlers into.
   * WeakSet so GC can collect dead registries without explicit cleanup.
   */
  private readonly registeredHookRegistries = new WeakSet<HookRegistry>();

  constructor(
    private readonly authRuntime: BridgeAuthRuntime,
    options?: {
      agentFactory?: AgentFactory;
      turnFinalizeTimeoutMs?: number;
    }
  ) {
    this.agentFactory = options?.agentFactory ?? createDefaultAgent;
    this.turnFinalizeTimeoutMs = options?.turnFinalizeTimeoutMs ?? 5_000;
  }

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const resolved = context.credential_store
      ? await resolveBrokeredRuntimeAuth(this.authRuntime, runtimeConfig, context.credential_store)
      : await resolveRuntimeAuth(this.authRuntime, runtimeConfig);
    // Apply thinking capability clamping (Fix 2): when a model has an explicit
    // thinking capability declaration, enforce it before handing off to pi-ai.
    const clampedRuntimeConfig = applyThinkingCapabilityClamp(runtimeConfig, resolved.thinkingCapability, resolved.model.id);
    const session = await this.getOrCreateSession(context, bundle, resolved, clampedRuntimeConfig);
    if (!session.initialized) {
      this.subscribeAgentEvents(session);
      session.initialized = true;
      console.log("[bridge] pi session created", {
        endpoint_id: bundle.endpoint_id,
        provider: resolved.provider,
        model: resolved.model.id
      });
      // Fire SessionStart hook
      if (context.hooks?.hasHandlers("SessionStart")) {
        await context.hooks.fire("SessionStart", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          provider: resolved.provider,
          model_id: resolved.model.id,
          reason: "session_created"
        });
      }
    } else {
      console.log("[bridge] pi session reused", {
        endpoint_id: bundle.endpoint_id,
        provider: resolved.provider,
        model: resolved.model.id
      });
      // Fire SessionResume hook
      if (context.hooks?.hasHandlers("SessionResume")) {
        await context.hooks.fire("SessionResume", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          provider: resolved.provider,
          model_id: resolved.model.id,
          reason: "session_reused"
        });
      }
    }

    if (session.activeTurn && !session.activeTurn.finalized) {
      throw new Error(`Runtime turn already active for endpoint '${bundle.endpoint_id}'.`);
    }

    const turn = this.startTurn(bundle, context.operation_authority_session);
    session.activeTurn = turn;

    if (resolved.usedEnvFallback) {
      await this.appendTelemetry(context, turn, "runtime_config", {
        source: "env_fallback",
        provider: resolved.provider,
        model: resolved.modelId
      });
    }

    // Context identity is enough for orientation. Scope is retained as structural
    // metadata, but actor participants and history are deliberately not injected.
    if (turn.context_id) {
      try {
        const ctx = await context.bus.getContext(turn.context_id);
        if (ctx && typeof ctx.scope_id === "string" && ctx.scope_id.trim()) {
          turn.scope_id = ctx.scope_id;
        }
      } catch (ctxErr) {
        console.warn("[bridge] getContext failed; continuing with delivery identity", {
          context_id: turn.context_id,
          error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr)
        });
      }
    }

    const prompt = deliveryToPrompt(bundle);
    console.log("[bridge] pi prompt injected", {
      delivery_id: bundle.delivery_id,
      runtime_turn_id: turn.runtime_turn_id,
      endpoint_id: bundle.endpoint_id,
      prompt_length: prompt.length
    });
    try {
      // Slice C: lazily register lifecycle-reset handlers in the workspace HookRegistry
      // so the injection baseline is cleared when a context's history is reset.
      this.maybeRegisterLifecycleHooks(context.hooks);

      // Fire BeforeTurn hook — collect injected context
      let injectedContext = "";
      if (context.hooks?.hasHandlers("BeforeTurn")) {
        // Build a typed origin reference symmetric with the emit destination.
        // kind="context" when the trigger event belongs to a context thread;
        // kind="thread"  when it only has a thread_id.
        const origin: { id: string; kind: "context" | "thread" } | undefined =
          turn.context_id
            ? { id: turn.context_id, kind: "context" as const }
            : turn.thread_id
            ? { id: turn.thread_id, kind: "thread" as const }
            : undefined;
        const hookResults = await context.hooks.fire("BeforeTurn", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          thread_id: turn.thread_id,
          origin
        });
        // Slice C (F2): apply inject-once dedup keyed on (context_id, source).
        // Content unchanged since last inject → stripped from filteredResults.
        // No context_id → all results pass through (can’t key without a context binding).
        const filteredResults = this.baseline.applyDedup(turn.context_id, hookResults);
        injectedContext = renderHookInjections(filteredResults);
        if (injectedContext) {
          await this.appendTelemetry(context, turn, "hook_injection", {
            hook: "BeforeTurn",
            injection_length: injectedContext.length,
            source_count: filteredResults.filter(r => r.inject).length
          });
        }
      }

      // Fire Pulse hook when delivery contains pulse.fired events
      const pulseEvents = bundle.events.filter(e => e.type === "pulse.fired");
      if (pulseEvents.length > 0 && context.hooks?.hasHandlers("Pulse")) {
        for (const pulseEvent of pulseEvents) {
          await context.hooks.fire("Pulse", {
            endpoint_id: bundle.endpoint_id,
            workspace_id: bundle.workspace_id,
            delivery_id: bundle.delivery_id,
            trigger_event_id: bundle.trigger_event_id,
            pulse_id: (pulseEvent.content as any)?.pulse_id ?? (pulseEvent.metadata as any)?.pulse_id,
            event_id: pulseEvent.event_id,
            thread_id: pulseEvent.thread_id,
            content: pulseEvent.content
          });
        }
      }

      // Build a turn-scoped prompt: optional extension overlay plus the compact
      // causal envelope. Durable Context history remains available through a tool.
      const parts: string[] = [];
      if (injectedContext) parts.push(injectedContext);
      parts.push(prompt);
      const finalPrompt = parts.join("\n\n");

      // Pi retains provider message history by default. Clear it before every
      // delivery so prior Context content is loaded only when the actor asks.
      session.agent.reset?.();
      await this.appendTelemetry(context, turn, "prompt_context", {
        system_instruction_chars: session.systemInstructionChars,
        turn_prompt_chars: finalPrompt.length,
        hook_injection_chars: injectedContext.length,
        automatic_history_events: 0,
        automatic_history_chars: 0,
        automatic_actor_directory_entries: 0,
        automatic_participant_entries: 0
      });

      await session.agent.prompt({
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: finalPrompt }]
      } as any);
      await this.awaitTurnCompletion(context, session, turn);
      // Fire TurnEnd hook
      if (context.hooks?.hasHandlers("TurnEnd")) {
        await context.hooks.fire("TurnEnd", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          visible_output: turn.visible_output,
          tool_activity: turn.tool_activity,
          emitted_events: turn.emitted_events
        });
      }

      // Write work log after successful turn completion
      this.writeWorkLog(context, bundle, turn, "completed");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // PiErrorStopReasonSignal carries a pre-parsed http_status; for genuine
      // thrown errors, extract from the message text (e.g. "POST … failed: 400 …").
      const httpStatus =
        error instanceof PiErrorStopReasonSignal
          ? error.piHttpStatus
          : (() => {
              const m = errorMessage.match(/:\s*(\d{3})\b/);
              return m ? parseInt(m[1], 10) : null;
            })();

      console.error("[bridge] pi runtime error", {
        delivery_id: bundle.delivery_id,
        runtime_turn_id: turn.runtime_turn_id,
        endpoint_id: bundle.endpoint_id,
        http_status: httpStatus,
        error: errorMessage,
        source: error instanceof PiErrorStopReasonSignal ? "stop_reason_error" : "thrown"
      });
      // Surface runtime error as telemetry — but only for thrown errors; for
      // PiErrorStopReasonSignal the runtime_error entry was already written by
      // finalizeTurn before it rejected the completion promise.
      if (!(error instanceof PiErrorStopReasonSignal)) {
        await this.appendTelemetry(context, turn, "runtime_error", {
          error_message: errorMessage,
          http_status: httpStatus,
          provider: resolved.provider,
          model: resolved.model.id
        });
      }

      // Fire Error hook
      if (context.hooks?.hasHandlers("Error")) {
        await context.hooks.fire("Error", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          error: errorMessage
        });
      }

      if (session.activeTurn === turn) session.activeTurn = undefined;
      if (!turn.finalized) {
        turn.finalized = true;
        turn.completion.resolve({ outcome: "failed", error });
      }
      // Write work log for failed turn
      this.writeWorkLog(context, bundle, turn, "error");
      // Invalidate session on request body errors (likely state corruption)
      if (errorMessage.includes("invalid_request_body") || errorMessage.includes("400")) {
        const errContextId = bundle.context_id ?? bundle.events[0]?.context_id ?? "no-context";
        const errKey = `${bundle.endpoint_id}:${errContextId}`;
        console.log("[bridge] pi session invalidated due to error", { endpoint_id: bundle.endpoint_id, context_id: errContextId });
        this.sessions.delete(errKey);
      }
      // Re-throw as TurnFailedError so the daemon can apply bounded retry and,
      // on terminal failure, record/return the failure through the turn cause.
      throw new TurnFailedError(
        bundle.delivery_id,
        turn.source_endpoint_id,
        bundle.workspace_id,
        turn.context_id,
        turn.thread_id,
        resolved.model.id,
        resolved.provider,
        httpStatus,
        errorMessage
      );
    }
  }

  async dispose(reason: HookPayload<"SessionEnd">["reason"] = "bridge_shutdown"): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      if (session.activeTurn && !session.activeTurn.finalized) session.agent.abort?.();
      await this.fireSessionEnd(session, { reason });
    }
  }

  cancelDelivery(deliveryId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.activeTurn?.delivery_id !== deliveryId || session.activeTurn.finalized) continue;
      if (!session.agent.abort) return false;
      session.activeTurn.cancelled = true;
      session.agent.abort();
      return true;
    }
    return false;
  }

  private async getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle, resolved: RuntimeAuthResolved, runtimeConfig?: AgentRuntimeConfig): Promise<SessionState> {
    // Session key per (endpoint, context): runtime objects and tools may be reused
    // within that pair, while provider-private messages are reset before each turn.
    // A session for context A is never reused for context B.
    const contextId = bundle.context_id ?? bundle.events[0]?.context_id ?? "no-context";
    const key = `${bundle.endpoint_id}:${contextId}`;
    const rawInstructions = runtimeConfig?.instructions?.trim() ?? "";
    // Build the full system prompt: agent instructions + Floe substrate guidance
    const systemPrompt = buildSystemPrompt(rawInstructions);
    const thinkingLevel = runtimeConfig?.thinking_level ?? "off";

    const instructionsHash = instructionHash(systemPrompt);
    const toolsFingerprint = runtimeToolsFingerprint({
      workspaceLocator: context.workspace_locator,
    });

    const existing = this.sessions.get(key);
    if (
      existing &&
      existing.provider === resolved.provider &&
      existing.modelId === resolved.model.id &&
      existing.thinkingLevel === thinkingLevel &&
      existing.instructionsHash === instructionsHash &&
      existing.runtimeToolsFingerprint === toolsFingerprint
    ) {
      existing.context = context;
      // Agent sessions retain provider-private conversation only. Credential
      // authority is replaced for every Delivery so a reused session cannot
      // outlive the Delivery that currently authorises its provider request.
      existing.getApiKey = resolved.getApiKey;
      return existing;
    }
    if (existing) {
      await this.fireSessionEnd(existing, {
        reason: "session_replaced",
        delivery_id: bundle.delivery_id,
        trigger_event_id: bundle.trigger_event_id,
        next_session: {
          provider: resolved.provider,
          model_id: resolved.model.id
        }
      });
    }

    const state: SessionState = {
      agent: null as unknown as AgentLike,
      initialized: false,
      endpointId: bundle.endpoint_id,
      contextId,
      workspaceId: bundle.workspace_id,
      provider: resolved.provider,
      modelId: resolved.model.id,
      thinkingLevel,
      instructionsHash,
      systemInstructionChars: systemPrompt.length,
      runtimeToolsFingerprint: toolsFingerprint,
      getApiKey: resolved.getApiKey,
      context
    };

    const model = resolved.model;

    console.log("[bridge] pi agent instructions loaded", {
      endpoint_id: bundle.endpoint_id,
      instructions_bytes: rawInstructions.length,
      thinking_level: thinkingLevel,
      instructions_hash: instructionsHash
    });

    const emitTool = this.createEmitTool(state);
    const requestTool = this.createRequestTool(state);
    const contextHistoryTool = this.createContextHistoryTool(state);
    const listEndpointsTool = this.createListEndpointsTool(state);
    const resolveDestinationTool = this.createResolveDestinationTool(state);

    const runtimeTools = createRuntimeTools({
      bus: context.bus,
      workspaceId: bundle.workspace_id,
      endpointId: bundle.endpoint_id,
      workspaceLocator: context.workspace_locator,
      toolContext: { getActiveTurn: () => state.activeTurn },
    });

    state.agent = this.agentFactory({
      model,
      tools: [emitTool, requestTool, contextHistoryTool, listEndpointsTool, resolveDestinationTool, ...runtimeTools],
      systemPrompt,
      getApiKey: () => state.getApiKey(),
      thinkingLevel
    });

    this.sessions.set(key, state);
    return state;
  }

  private async fireSessionEnd(
    session: SessionState,
    details: Omit<HookPayload<"SessionEnd">, "endpoint_id" | "workspace_id" | "previous_session">
  ): Promise<void> {
    if (!session.context?.hooks?.hasHandlers("SessionEnd")) return;
    await session.context.hooks.fire("SessionEnd", {
      ...details,
      endpoint_id: session.endpointId,
      workspace_id: session.workspaceId,
      previous_session: {
        provider: session.provider,
        model_id: session.modelId
      }
    });
  }

  /**
   * Slice C (F2): lazily register ContextHistoryCleared / ContextCompacted handlers
   * in a workspace HookRegistry so the injection baseline is reset when a context
   * is cleared. Called once per registry instance (tracked via WeakSet).
   *
   * The extension name "_substrate_inject_once" is intentionally prefixed with "_"
   * to distinguish it from user-registered extensions. It is extension-agnostic.
   */
  private maybeRegisterLifecycleHooks(hooks: HookRegistry | undefined): void {
    if (!hooks) return;
    if (this.registeredHookRegistries.has(hooks)) return;
    this.registeredHookRegistries.add(hooks);

    hooks.on("ContextHistoryCleared", "_substrate_inject_once", (payload) => {
      this.baseline.clearContext(payload.context_id);
    });
    hooks.on("ContextCompacted", "_substrate_inject_once", (payload) => {
      this.baseline.clearContext(payload.context_id);
    });
  }

  private createEmitTool(session: SessionState): AgentTool {
    return {
      name: "emit",
      label: "Emit Floe Event",
      description: "Deliberately publish an event that should cause or communicate something beyond your local turn result. Use attachments for named, openable saved results and references for named links to records returned by discovered operations, such as a saved approval. A reference is navigation, not proof of approval or authority. The returned Event reference confirms acceptance and its exact attachments. Your normal final answer is already recorded in the current Context. Use 'current_context' as the destination only when you intentionally want Context subscription/effect semantics.",
      parameters: Type.Object({
        type: Type.String(),
        destination: Type.String({ description: "A neutral actor ref from list_endpoints, or 'current_context'." }),
        text: Type.String(),
        references: Type.Optional(Type.Array(Type.Object({
          name: Type.String({ minLength: 1, description: "Useful name shown on the Open button, such as Local preview approval." }),
          resource_ref: Type.Object({
            kind: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }),
            revision: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          }, { additionalProperties: false, description: "Exact resource reference returned by an operation. Do not infer kind or revision from an ID." }),
        }))),
        attachments: Type.Optional(Type.Array(Type.Object({
          artefact_version_id: Type.String({ minLength: 1, description: "Exact published ArtefactVersion to attach; it need not be repeated in artefact_version_ids." }),
          name: Type.String({ minLength: 1, description: "Clear result name shown on the attachment button, such as Teal Lantern or Revised Courtyard." }),
        }))),
        artefact_version_ids: Type.Optional(Type.Array(Type.String({
          description: "Additional exact published ArtefactVersion IDs without display names. Prefer attachments for results the operator should open; do not put attachment IDs in data.",
        }))),
        data: Type.Optional(Type.Record(Type.String(), Type.Unknown({
          description: "Optional structured Event data. Use only when a client or extension contract requires it."
        })))
      }),
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context is available for emit.");
        const { result, emitted } = await executeEmit(context.bus, turn, params, {
          runtimeName: "pi-agent-core",
          emitOrigin: "pi_emit_tool",
          requestOrigin: "pi_request_tool",
        });
        if (emitted) turn.emitted_events.push(emitted);
        return result;
      }
    };
  }

  private createRequestTool(session: SessionState): AgentTool {
    return {
      name: "request",
      label: "Request Actor Work",
      description: "Ask one actor for work whose result you need before continuing. Attach the exact published ArtefactVersion IDs when the work concerns saved inputs. Floe stores the dependency, ends this processing cycle normally, and resumes you when that actor completes or fails. The return path is automatic.",
      parameters: Type.Object({
        actor: Type.String({ description: "A neutral actor ref from list_endpoints." }),
        work: Type.String({ description: "The bounded work or question for that actor." }),
        artefact_version_ids: Type.Optional(Type.Array(Type.String({
          minLength: 1, description: "Exact published input versions for the actor to inspect with read_artefact. Omit when no saved input is needed.",
        }))),
      }),
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context is available for request.");
        const { result, emitted, dependencyRequested } = await executeRequest(
          context.bus, turn, params,
          { runtimeName: "pi-agent-core", emitOrigin: "pi_emit_tool", requestOrigin: "pi_request_tool" },
          turn.dependency_requested,
        );
        if (dependencyRequested) turn.dependency_requested = true;
        if (emitted) turn.emitted_events.push(emitted);
        return result;
      }
    };
  }

  private createContextHistoryTool(session: SessionState): AgentTool {
    return {
      name: "context_history",
      label: "Read Context History",
      description: "Retrieve bounded history from the current durable Context when needed. By default start with recent contributions and page toward older history. Each page is chronological. Stop when you have the relevant evidence. Use forward explicitly to start at the oldest contribution. Follow next_cursor unchanged with the returned direction. Large fields are explicitly marked truncated or omitted; saved history is unchanged. History is not otherwise loaded into your prompt.",
      parameters: Type.Object({
        cursor: Type.Optional(Type.String({ description: "Opaque next_cursor from a previous page." })),
        direction: Type.Optional(Type.Union([Type.Literal("backward"), Type.Literal("forward")], { description: "backward (default): recent to older pages; forward: oldest to newer pages. Keep the returned direction when following its cursor." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Events to retrieve (default 10, maximum 25)." }))
      }),
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context || !turn.context_id) throw new Error("No current Context is available for history retrieval.");
        const limit = Math.min(Math.max(Number(params?.limit ?? 10), 1), 25);
        const cursor = params?.cursor ?? null;
        const direction = params?.direction ?? "backward";
        if (direction !== "forward" && direction !== "backward") throw new Error("History direction must be forward or backward.");
        let page = await context.bus.listContextEvents(turn.context_id, cursor, limit, direction);
        let readCount = 1;
        const preview = (event: EventEnvelope): Record<string, unknown> => ({
          event_id: event.event_id,
          type: event.type,
          actor: event.source_endpoint_id
            ? toNeutralRef(event.source_endpoint_id)
            : typeof event.metadata?.responding_endpoint_id === "string"
              ? toNeutralRef(event.metadata.responding_endpoint_id)
              : "system",
          created_at: event.created_at,
          text: typeof event.content?.text === "string" ? event.content.text.slice(0, 4_000) : undefined,
          truncated_fields: typeof event.content?.text === "string" && event.content.text.length > 4_000 ? ["text"] : undefined,
          data: event.content?.data ?? undefined,
          references: event.content?.references ?? undefined,
          attachments: eventAttachments(event.content, event.artefact_version_ids)
        });
        let events = page.events.map(preview);
        const render = (selected = events) => JSON.stringify({ events: selected, direction, next_cursor: page.next_cursor }, null, 2);
        let rendered = render();
        // Keep whole contributions and obtain the matching cursor from the Bus.
        // This bounded read narrows one request; it never polls for new work.
        while (rendered.length > 16_000 && events.length > 1) {
          let smallerLimit = events.length - 1;
          while (smallerLimit > 1 && render(direction === "backward" ? events.slice(-smallerLimit) : events.slice(0, smallerLimit)).length > 16_000) smallerLimit--;
          page = await context.bus.listContextEvents(turn.context_id, cursor, smallerLimit, direction);
          readCount++;
          events = page.events.map(preview);
          rendered = render();
        }
        // One large Event remains visible by identity. Never cut serialized JSON
        // or silently discard a field, and never advance past an unreturned Event.
        if (rendered.length > 16_000 && events.length === 1) {
          const event = events[0]!;
          const omitted: string[] = [];
          for (const field of ["data", "attachments", "references", "text"]) {
            if (rendered.length <= 16_000) break;
            if (event[field] === undefined) continue;
            delete event[field];
            omitted.push(field);
            event.omitted_fields = omitted;
            rendered = render();
          }
        }
        if (rendered.length > 16_000) throw new Error("This history page's identity metadata exceeds the display limit; no continuation was advanced.");
        await this.appendTelemetry(context, turn, "context_history_retrieval", {
          requested_limit: limit,
          direction,
          returned_events: events.length,
          returned_chars: rendered.length,
          page_reads: readCount,
          omitted_field_count: events.reduce((count, event) => count + (Array.isArray(event.omitted_fields) ? event.omitted_fields.length : 0), 0),
          used_cursor: !!params?.cursor,
          next_cursor_available: !!page.next_cursor
        });
        return {
          content: [{ type: "text", text: rendered }],
          details: { ok: true, count: events.length, direction, next_cursor: page.next_cursor }
        };
      }
    };
  }

  private createListEndpointsTool(session: SessionState): AgentTool {
    // TODO: Future visibility should be: workspace scope + subscriptions + permissions
    // For V0, workspace-scoped visibility is sufficient (no cross-workspace exposure).
    return {
      name: "list_endpoints",
      label: "List Visible Actors",
      description: "Discover actors visible/addressable in the current workspace when the work requires another actor. Returns { ref, name, status } entries for emit or request.",
      parameters: Type.Object({}),
      execute: async () => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context for list_endpoints.");

        // Scoped to current workspace only — no cross-workspace endpoints exposed
        const endpoints = await context.bus.listEndpoints(turn.workspace_id);
        const visible: NeutralEndpoint[] = endpoints
          .filter((ep: any) => ep.endpoint_id !== turn.endpoint_id)
          .map((ep: any) => toNeutralEndpoint({
            endpoint_id: ep.endpoint_id,
            name: ep.name,
            status: ep.status,
          }));

        return {
          content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
          details: { ok: true, count: visible.length }
        };
      }
    };
  }

  private createResolveDestinationTool(session: SessionState): AgentTool {
    return {
      name: "resolve_destination",
      label: "Resolve Destination",
      description: "Resolve a neutral actor ref (like 'operator' or 'floe') to a known actor in this workspace. Use list_endpoints to discover refs.",
      parameters: Type.Object({
        ref: Type.String({ description: "Neutral actor ref (e.g. 'operator', 'floe')" })
      }),
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context.");
        const ref = String(params.ref);
        const endpoints = await context.bus.listEndpoints(turn.workspace_id);
        const matched = endpoints.find((ep: any) => toNeutralRef(ep.endpoint_id) === ref || ep.endpoint_id === ref);
        if (!matched) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ref, found: false }, null, 2) }],
            details: { ok: false, ref, found: false }
          };
        }
        const neutral = toNeutralEndpoint({
          endpoint_id: matched.endpoint_id,
          name: matched.name,
          status: matched.status,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(neutral, null, 2) }],
          details: { ok: true, ...neutral }
        };
      }
    };
  }

  private subscribeAgentEvents(session: SessionState): void {
    session.agent.subscribe(async (event) => {
      const turn = session.activeTurn;
      const context = session.context;
      if (!turn || !context) return;

      try {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          await this.recordResponseUsage(context, turn, event.message);
        }
        if ((event.type === "message_update" || event.type === "message_end") && event.message?.role === "assistant") {
          const text = extractText((event as any).message);
          if (text) {
            turn.visible_output = text;
            if (text !== turn.last_visible_telemetry_text) {
              turn.last_visible_telemetry_text = text;
              console.log("[bridge] pi visible_output observed", {
                runtime_turn_id: turn.runtime_turn_id,
                delivery_id: turn.delivery_id,
                text_length: text.length,
                event_type: event.type
              });
              await this.appendTelemetry(context, turn, "visible_output", { text });
            }
          } else if (event.type === "message_end") {
            const msg = (event as any).message;
            console.log("[bridge] pi message_end no text extracted", {
              runtime_turn_id: turn.runtime_turn_id,
              role: msg?.role,
              content_types: Array.isArray(msg?.content) ? msg.content.map((c: any) => c?.type) : "(no content array)",
              stop_reason: msg?.stopReason ?? msg?.stop_reason
            });
          }
        }

        if (event.type === "tool_execution_start") {
          await this.appendTelemetry(context, turn, "BeforeToolUse", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          });
          // Fire BeforeToolUse hook
          if (context.hooks?.hasHandlers("BeforeToolUse")) {
            await context.hooks.fire("BeforeToolUse", {
              endpoint_id: turn.endpoint_id,
              workspace_id: turn.workspace_id,
              delivery_id: turn.delivery_id,
              trigger_event_id: turn.trigger_event_id,
              toolCallId: event.toolCallId,
              toolName: event.toolName
            });
          }
          // Track tool activity for work log
          turn.tool_activity.push({
            name: event.toolName,
            call_id: event.toolCallId
          });
        }

        if (event.type === "tool_execution_end") {
          // Collect enriched data from tool activity (set by workspace tools during execute)
          const toolEntry = turn.tool_activity.find((t) => t.call_id === event.toolCallId);
          // Pi's isError covers thrown execution errors. Floe tools can also
          // return a valid failure result, such as a nonzero command exit.
          const isError = event.isError === true || toolEntry?.is_error === true || event.result?.details?.ok === false;
          await this.appendTelemetry(context, turn, isError ? "ToolUseFailed" : "AfterToolUse", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError,
            summary: toolEntry?.summary,
            files_touched: toolEntry?.files_touched,
            duration_ms: toolEntry?.duration_ms,
          });
          // Update tool activity with error status
          if (toolEntry) toolEntry.is_error = isError;
          // Fire AfterToolUse or ToolUseFailed hook
          const hookName = isError ? "ToolUseFailed" as const : "AfterToolUse" as const;
          if (context.hooks?.hasHandlers(hookName)) {
            await context.hooks.fire(hookName, {
              endpoint_id: turn.endpoint_id,
              workspace_id: turn.workspace_id,
              delivery_id: turn.delivery_id,
              trigger_event_id: turn.trigger_event_id,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError
            });
          }
        }

        // agent_end is the correct finalization signal — it fires ONCE after all
        // tool-call loops complete. turn_end fires after each inner iteration, so
        // finalizing on turn_end would cut the agent short when it uses multiple tools.
        if (event.type === "agent_end") {
          const messages = (event as any).messages as any[] | undefined;
          for (const message of messages ?? []) {
            if (message?.role === "assistant") await this.recordResponseUsage(context, turn, message);
          }
          await this.appendTelemetry(context, turn, "usage_coverage", {
            agent_end_observed: true,
            model_response_count: turn.usage_response_count,
          });
          const lastAssistant = messages
            ?.filter((m: any) => m.role === "assistant")
            .pop() ?? null;
          console.log("[bridge] pi agent_end finalizing", {
            runtime_turn_id: turn.runtime_turn_id,
            last_assistant_stop_reason: lastAssistant?.stopReason,
            last_assistant_has_text: !!extractText(lastAssistant),
            visible_output_len: turn.visible_output.length
          });
          await this.finalizeTurn(context, session, turn, lastAssistant);
        }
      } catch (error) {
        if (session.activeTurn === turn) session.activeTurn = undefined;
        if (!turn.finalized) {
          turn.completion.resolve({ outcome: "failed", error });
        }
        console.error("[bridge] pi adapter event handling failed", error);
      }
    });
  }

  private startTurn(
    bundle: DeliveryBundle,
    operationAuthoritySession?: RuntimeOperationAuthoritySession,
  ): RuntimeTurnContext {
    const trigger = bundle.events[0];
    const sourceEndpoint = trigger?.source_endpoint_id || `actor:${bundle.workspace_id}:operator`;
    const contextId = bundle.context_id ?? trigger?.context_id ?? null;
    const threadId = contextId ?? trigger?.thread_id ?? `thread:${bundle.workspace_id}:pi`;
    return {
      runtime_turn_id: `rt_${randomUUID()}`,
      delivery_id: bundle.delivery_id,
      processing_contract_id: bundle.processing_contract?.processing_contract_id,
      operation_authority_session: operationAuthoritySession,
      stable_delivery_ids: bundle.stable_delivery_ids ?? [],
      execution_attempt_id: bundle.execution_attempt_id ?? null,
      scope_execution_id: bundle.scope_execution_id ?? null,
      composition_revision_id: bundle.composition_revision_id ?? null,
      node_execution_id: bundle.node_execution_id ?? null,
      target_node_id: bundle.target_node_id ?? null,
      target_port_ids: bundle.target_port_ids ?? [],
      output_ports: (bundle.node_contract?.output_ports ?? []).map((port) => ({
        port_id: port.port_id,
        name: port.name,
        event_types: port.event_types,
        artefact_types: port.artefact_types,
        schema_ref: port.schema_ref,
        min_count: port.min_count,
        max_count: port.max_count,
      })),
      endpoint_id: bundle.endpoint_id,
      workspace_id: bundle.workspace_id,
      thread_id: threadId,
      scope_id: typeof trigger?.scope_id === "string" && trigger.scope_id.trim() ? trigger.scope_id : null,
      source_endpoint_id: sourceEndpoint,
      started_at: new Date().toISOString(),
      trigger_event_id: trigger?.event_id ?? `evt:${bundle.delivery_id}`,
      invocation_request_event_id:
        trigger?.type === "request"
          ? trigger.event_id
          : trigger?.type === "request.result" && typeof trigger.metadata?.request_continuation_event_id === "string"
            ? trigger.metadata.request_continuation_event_id
            : null,
      context_id: contextId,
      visible_output: "",
      last_visible_telemetry_text: "",
      dependency_requested: false,
      finalized: false,
      usage_messages: new WeakSet<object>(),
      usage_response_count: 0,
      completion: createDeferred<TurnCompletion>(),
      tool_activity: [],
      emitted_events: []
    };
  }

  private async awaitTurnCompletion(context: RuntimeContext, session: SessionState, turn: RuntimeTurnContext): Promise<void> {
    const timedOut = { outcome: "timed_out" } as const;
    let completion: TurnCompletion | typeof timedOut = await Promise.race([
      turn.completion.promise,
      sleep(this.turnFinalizeTimeoutMs).then(() => timedOut)
    ]);
    if (completion.outcome === "timed_out") {
      console.log("[bridge] pi turn timeout, finalizing", {
        runtime_turn_id: turn.runtime_turn_id,
        delivery_id: turn.delivery_id,
        visible_output_length: turn.visible_output.length
      });
      if (session.activeTurn === turn && !turn.finalized) {
        await this.finalizeTurn(context, session, turn, null);
      }
      completion = await turn.completion.promise;
    }
    if (completion.outcome === "failed") throw completion.error;
  }

  private async finalizeTurn(
    context: RuntimeContext,
    session: SessionState,
    turn: RuntimeTurnContext,
    assistantMessage: any | null
  ): Promise<void> {
    if (turn.finalized) return;
    turn.finalized = true;

    try {
      const stopReason = assistantMessage?.stopReason ?? assistantMessage?.stop_reason ?? null;
      const piErrorMessage = assistantMessage?.errorMessage ?? null;
      if (turn.cancelled || stopReason === "aborted") {
        turn.completion.resolve({ outcome: "failed", error: new Error("Runtime response was stopped.") });
        return;
      }
      if (stopReason === "error") {
        const httpStatusMatch = piErrorMessage?.match(/\b(\d{3})\b/);
        const piHttpStatus = httpStatusMatch ? parseInt(httpStatusMatch[1], 10) : null;
        await this.appendTelemetry(context, turn, "runtime_error", {
          note: "Pi runtime returned stop_reason 'error' without throwing.",
          stop_reason: stopReason, error_message: piErrorMessage, http_status: piHttpStatus,
        });
        turn.completion.resolve({ outcome: "failed", error: new PiErrorStopReasonSignal(piErrorMessage, piHttpStatus) });
        return;
      }
      const output = turn.visible_output.trim() || extractText(assistantMessage)?.trim() || "";
      if (output.length > 0) {
        // A model's natural public completion is the local result of this turn.
        // The bus records it without destination routing or subscriber fanout.
        const recorded = await context.bus.recordRuntimeTurnResult({
          delivery_id: turn.delivery_id,
          outcome: "completed",
          text: output,
          metadata: {
            runtime: "pi-agent-core",
            runtime_turn_id: turn.runtime_turn_id,
            execution_attempt_id: turn.execution_attempt_id,
            node_execution_id: turn.node_execution_id,
            composition_revision_id: turn.composition_revision_id
          }
        });
        console.log("[bridge] natural turn result recorded", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          output_length: output.length,
          request_resolved: recorded.request_resolved
        });
        await this.appendTelemetry(context, turn, "turn_result", {
          text: output,
          result_event_id: recorded.result_event.event_id,
          request_resolved: recorded.request_resolved,
          return_event_id: recorded.return_event?.event_id ?? null
        });
      } else {
        console.log("[bridge] no visible output", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          had_assistant_message: !!assistantMessage,
          stop_reason: stopReason
        });
      }

      turn.completion.resolve({ outcome: "completed" });
    } catch (error) {
      turn.completion.resolve({ outcome: "failed", error });
      throw error;
    } finally {
      if (session.activeTurn === turn) session.activeTurn = undefined;
    }
  }

  private async recordResponseUsage(
    context: RuntimeContext,
    turn: RuntimeTurnContext,
    message: any,
  ): Promise<void> {
    // Pi emits the same final message object at message_end and agent_end.
    // Record at message_end so completed responses survive later interruption.
    // The agent_end pass also covers adapters that supply terminal messages only.
    if (turn.usage_messages.has(message)) return;
    turn.usage_messages.add(message);
    await this.appendTelemetry(context, turn, "usage", {
      measurement_scope: "model_response",
      response_index: ++turn.usage_response_count,
      usage: message.usage ?? null,
      model: message.model ?? null,
      provider: message.provider ?? null,
      stop_reason: message.stopReason ?? message.stop_reason ?? null,
      error_message: message.errorMessage ?? null,
    });
  }

  private async appendTelemetry(
    context: RuntimeContext,
    turn: RuntimeTurnContext,
    kind: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await context.bus.appendRuntimeTelemetry({
      workspace_id: turn.workspace_id,
      endpoint_id: turn.endpoint_id,
      delivery_id: turn.delivery_id,
      kind,
      payload: {
        runtime_turn_id: turn.runtime_turn_id,
        delivery_id: turn.delivery_id,
        execution_attempt_id: turn.execution_attempt_id,
        node_execution_id: turn.node_execution_id,
        composition_revision_id: turn.composition_revision_id,
        endpoint_id: turn.endpoint_id,
        thread_id: turn.thread_id,
        scope_id: turn.scope_id,
        started_at: turn.started_at,
        trigger_event_id: turn.trigger_event_id,
        context_id: turn.context_id,
        ...payload
      }
    });
  }

  private writeWorkLog(
    context: RuntimeContext,
    bundle: DeliveryBundle,
    turn: RuntimeTurnContext,
    outcome: string
  ): void {
    if (!context.workspace_locator || !context.agent_id) return;
    const entry: WorkLogEntry = {
      runtime_turn_id: turn.runtime_turn_id,
      agent_id: context.agent_id,
      started_at: turn.started_at,
      ended_at: new Date().toISOString(),
      trigger_type: bundle.events?.[0]?.type ?? "unknown",
      scope_id: turn.scope_id,
      thread_id: turn.thread_id,
      delivery_id: turn.delivery_id,
      delivered_events: (bundle.events ?? []).map(e => ({
        event_id: e.event_id ?? "unknown",
        type: e.type ?? "unknown",
        source_endpoint_id: e.source_endpoint_id ?? "unknown",
        text: ((e.content as Record<string, unknown>)?.text as string ?? JSON.stringify(e.content ?? "")).slice(0, 200)
      })),
      visible_output: turn.visible_output || null,
      tool_activity: turn.tool_activity ?? [],
      emitted_events: turn.emitted_events ?? [],
      lifecycle_outcome: outcome
    };
    try {
      appendWorkLog(context.workspace_locator, entry);
    } catch (err) {
      console.error("[bridge] work-log write failed", { agent_id: context.agent_id, error: String(err) });
    }
  }
}

export function summarizePiRequestPayload(payload: any, model: any) {
  const inputItems = Array.isArray(payload?.input) ? payload.input : [];
  const roles = inputItems.map((m: any) => m?.role ?? m?.type ?? "unknown");
  return {
    model_id: model?.id,
    provider: model?.provider,
    api: model?.api,
    input_items: inputItems.length,
    roles: roles.slice(0, 20),
    has_reasoning: !!payload?.reasoning,
    reasoning: payload?.reasoning ?? null,
    has_thinking: !!payload?.thinking,
    thinking: payload?.thinking ?? null,
    has_tools: Array.isArray(payload?.tools) && payload.tools.length > 0,
    tool_count: Array.isArray(payload?.tools) ? payload.tools.length : 0
  };
}

function createDefaultAgent(input: AgentFactoryInput): AgentLike {
  return new Agent({
    initialState: {
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      thinkingLevel: input.thinkingLevel ?? "off"
    },
    streamFn: streamSimple,
    getApiKey: input.getApiKey,
    onPayload: (payload: any, model: any) => {
      // Log request structure (no content/tokens) for diagnostics
      console.log("[bridge] pi request payload", summarizePiRequestPayload(payload, model));
      return payload;
    },
    onResponse: (response: any, model: any) => {
      console.log("[bridge] pi response received", {
        status: response?.status,
        model_id: model?.id,
        provider: model?.provider
      });
    }
  });
}

function instructionHash(text: string): string {
  // FNV-1a 32-bit — cheap, no crypto import needed, good enough for cache key
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * renderHookInjections moved to runtime-core so every adapter shares one
 * renderer; re-exported here to preserve this module's public test surface.
 */
export { renderHookInjections };

function extractText(message: any): string {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("");
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply thinking capability clamping at the bridge/bus boundary.
 *
 * When a model entry declares an explicit `thinking` capability, the requested
 * `thinking_level` is clamped before anything is handed to pi-ai, preventing
 * the pi runtime from sending thinking params the model cannot accept.
 *
 * Capability mapping:
 * - "always-on" / "none"  → force thinking_level to "off" (pi-ai will omit the
 *   thinking param when thinkingLevel="off", regardless of model.reasoning)
 * - "adaptive" / "budget" → pass through unchanged (pi-ai handles these correctly
 *   when reasoning=true; the custom registry entry should set reasoning accordingly)
 * - undefined             → no change (existing behaviour; pi-ai's own inference applies)
 */
export function applyThinkingCapabilityClamp(
  runtimeConfig: AgentRuntimeConfig | undefined,
  thinkingCapability: ModelThinkingCapability | undefined,
  modelId: string
): AgentRuntimeConfig | undefined {
  if (!thinkingCapability) return runtimeConfig;
  if (thinkingCapability === "always-on" || thinkingCapability === "none") {
    const requested = runtimeConfig?.thinking_level ?? "off";
    if (requested !== "off") {
      console.log(
        `[bridge] thinking_level '${requested}' clamped to 'off' for model '${modelId}' ` +
        `(declared capability: '${thinkingCapability}')`
      );
    }
    return { ...runtimeConfig, thinking_level: "off" };
  }
  // "adaptive" or "budget": pass through; pi-ai handles serialization
  return runtimeConfig;
}
