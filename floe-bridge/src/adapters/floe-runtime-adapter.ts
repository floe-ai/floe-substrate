/**
 * @invariant This adapter drives Floe runtime turns through floe-runtime's
 * CopilotRuntime. The runtime uses the official Copilot SDK. floe-runtime holds NO credentials:
 * the vendor CLI authenticates itself
 * through its own supported flow. This adapter therefore never resolves or
 * brokers a model credential — that is the whole point of replacing pi here.
 *
 * A delivery is rendered to a prompt, run as one SDK turn, and its final
 * message is recorded with telemetry and a work-log entry. Bridge-owned
 * substrate tools are direct SDK tools. Cancellation reports quiesced only
 * after the runtime proves all tool activity terminal; otherwise the owning
 * isolated session must be retired before Floe reports paused.
 */
import { randomUUID } from "node:crypto";
import { COPILOT_BUILTIN_TOOL_MANIFEST, copilotToolCatalogForModel } from "floe-runtime/adapters/copilot";
import type {
  ActivityEvent,
  CopilotPermissionRequest,
  CopilotRuntime,
  CopilotRuntimeOptions,
  HostTool,
  PermissionPolicyDecision,
  RunResult,
} from "floe-runtime/adapters/copilot";
import type { AgentRuntimeConfig } from "../auth.js";
import type { DeliveryBundle, RuntimeOperationAuthoritySession } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { HookPayload } from "../hooks.js";
import type { WorkLogEntry, WorkLogToolEntry } from "../runtime-core/index.js";
import { buildSystemPrompt, deliveryToPrompt, appendWorkLog, renderHookInjections } from "../runtime-core/index.js";
import type { EmittedEventSummary, SubstrateTurnAnchor } from "../runtime-core/index.js";
import { createDirectSubstrateTools } from "./floe-direct-tools.js";
import type { SubstrateSessionHandle } from "../runtime-core/substrate-tool-definitions.js";
import { TurnFailedError } from "./turn-failed-error.js";
import { turnUsage } from "./turn-usage.js";
import { createCopilotAccount, createCopilotRuntime } from "../engines/copilot.js";
import type { EngineAccount } from "../engines/engine-control.js";
import { EngineToolGate } from "./engine-tool-gate.js";

export type RuntimeFactory = (options: Pick<CopilotRuntimeOptions, "permissionPolicy" | "expectedAccount">) => CopilotRuntime;
type EngineAccountRef = NonNullable<RuntimeContext["engine_account"]>;

/** The pinned manifest's built-ins, in the model's catalog, that the Actor's granted operations may use. */
export function grantedBuiltinTools(
  operationIds: readonly string[] = [],
  model?: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const manifest = COPILOT_BUILTIN_TOOL_MANIFEST[platform] ?? {};
  return copilotToolCatalogForModel(model, platform)
    .filter((name) => operationIds.includes(manifest[name]!.operationId))
    .map((name) => `builtin:${name}`)
    .sort();
}

type FloeTurn = {
  runtime_turn_id: string;
  delivery_id: string;
  started_at: string;
  endpoint_id: string;
  workspace_id: string;
  thread_id: string;
  context_id: string | null;
  scope_id: string | null;
  scope_execution_id: string | null;
  node_execution_id: string | null;
  target_node_id: string | null;
  composition_revision_id: string | null;
  invocation_request_event_id: string | null;
  source_endpoint_id: string;
  trigger_event_id: string;
  execution_attempt_id: string | null;
  operation_authority_session: RuntimeOperationAuthoritySession | null;
  processing_contract_id: string | null;
  visible_output: string;
  tool_activity: WorkLogToolEntry[];
  emitted_events: EmittedEventSummary[];
  dependency_requested: boolean;
  finalized: boolean;
  cancelled: boolean;
  requiresRetirement: boolean;
  cancellation: Promise<void> | null;
  cancellationFault: unknown;
  cancellationRequestedAt: string | null;
  runtimeQuiescedAt: string | null;
  settledAt: string | null;
  settled: Promise<void>;
  settle: () => void;
};

type FloeSession = {
  runtime: CopilotRuntime;
  /** The readiness account this runtime was built to run as. */
  account: EngineAccountRef;
  /** SDK sessionId once run() has started a turn; null until the first turn. */
  sessionId: string | null;
  endpointId: string;
  contextId: string;
  workspaceId: string;
  directTools: HostTool[];
  /** The exact tool list the live SDK session was created with. */
  offeredTools: string | null;
  model?: string;
  context?: RuntimeContext;
  activeTurn?: FloeTurn;
};

function sameAccount(a: EngineAccountRef, b: EngineAccountRef): boolean {
  return a.label.toLowerCase() === b.label.toLowerCase() && (a.host ?? "") === (b.host ?? "");
}

function recordToolActivity(turn: FloeTurn, entry: WorkLogToolEntry): void {
  const existing = entry.call_id ? turn.tool_activity.find(activity => activity.call_id === entry.call_id) : undefined;
  if (!existing) {
    turn.tool_activity.push(entry);
    return;
  }
  if (!existing.name && entry.name) existing.name = entry.name;
  if (entry.is_error !== undefined) existing.is_error = entry.is_error;
  if (
    entry.lifecycle !== undefined
    && (existing.lifecycle === undefined || entry.lifecycle !== "started")
  ) existing.lifecycle = entry.lifecycle;
  if (entry.provenance !== undefined) existing.provenance = entry.provenance;
  if (entry.summary !== undefined) existing.summary = entry.summary;
  if (entry.duration_ms !== undefined) existing.duration_ms = entry.duration_ms;
  if (entry.arguments !== undefined) existing.arguments = entry.arguments;
  if (entry.result_type !== undefined) existing.result_type = entry.result_type;
  if (entry.result_value !== undefined) existing.result_value = entry.result_value;
  if (entry.result_code !== undefined) existing.result_code = entry.result_code;
  if (entry.started_at !== undefined) existing.started_at = entry.started_at;
  if (entry.ended_at !== undefined) existing.ended_at = entry.ended_at;
}

export class FloeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "floe-runtime";
  readonly engine = "copilot";
  // floe-runtime holds no credentials; the vendor CLI authenticates itself.
  private readonly sessions = new Map<string, FloeSession>();
  private readonly runtimeFactory: RuntimeFactory;
  private readonly toolGate = new EngineToolGate();
  /** Present only on the production engine; a unit-test runtime has no account to sign in to. */
  readonly createEngineAccount?: () => EngineAccount;
  /**
   * Production gives Floe's Copilot folder and gets the real engine. A unit
   * test gives a stand-in runtime instead; it can never also be a real engine.
   */
  constructor(options: { copilotHome: string } | { runtimeFactory: RuntimeFactory }) {
    if ("copilotHome" in options) {
      const home = options.copilotHome;
      this.runtimeFactory = (runtimeOptions) => createCopilotRuntime(home, runtimeOptions);
      this.createEngineAccount = () => createCopilotAccount(home);
    } else {
      this.runtimeFactory = options.runtimeFactory;
    }
  }

  approvalChanged(approvalRequestId: string): void {
    this.toolGate.approvalChanged(approvalRequestId);
  }

  private async decideToolCall(session: FloeSession, request: CopilotPermissionRequest): Promise<PermissionPolicyDecision> {
    const turn = session.activeTurn;
    const context = session.context;
    if (!turn || turn.finalized || turn.cancelled || !context) {
      return { decision: "cancel", refusal: { code: "tool_policy_cancelled", reason: "No Floe turn is running." } };
    }
    return this.toolGate.decide({
      bus: context.bus,
      deliveryId: turn.delivery_id,
      workspaceLocator: context.workspace_locator ?? null,
      request,
    });
  }

  private beginCancellation(session: FloeSession, turn: FloeTurn): void {
    if (!session.sessionId || turn.cancellation) return;
    turn.cancellationRequestedAt ??= new Date().toISOString();
    turn.cancellation = session.runtime.quiesce(session.sessionId)
      .then(() => {
        turn.runtimeQuiescedAt = new Date().toISOString();
      })
      .catch(error => {
        turn.cancellationFault = error;
      });
  }

  private async throwIfCancelled(session: FloeSession, turn: FloeTurn): Promise<void> {
    if (!turn.cancelled) return;
    this.beginCancellation(session, turn);
    await turn.cancellation;
    if (turn.cancellationFault) throw turn.cancellationFault;
    const interrupted = new Error("Runtime turn was cancelled before quiescence completed.");
    (interrupted as Error & { code?: string }).code = "interrupted";
    throw interrupted;
  }

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const session = this.getOrCreateSession(context, bundle);
    if (session.activeTurn && (!session.activeTurn.finalized || session.activeTurn.requiresRetirement)) {
      throw new Error(`Runtime turn already active for endpoint '${bundle.endpoint_id}'.`);
    }

    const model = runtimeConfig?.model?.trim() || undefined;
    const freshSession = session.sessionId === null;
    const turn = this.startTurn(bundle);
    turn.operation_authority_session = context.operation_authority_session ?? null;
    session.activeTurn = turn;

    // Scope is retained as structural metadata for the work log; actor
    // participants and history are deliberately not injected (parity with pi).
    if (turn.context_id) {
      try {
        const ctx = await context.bus.getContext(turn.context_id);
        if (ctx && typeof ctx.scope_id === "string" && ctx.scope_id.trim()) turn.scope_id = ctx.scope_id;
      } catch (ctxErr) {
        console.warn("[bridge] getContext failed; continuing with delivery identity", {
          context_id: turn.context_id,
          error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr),
        });
      }
    }

    if (freshSession && context.hooks?.hasHandlers("SessionStart")) {
      await context.hooks.fire("SessionStart", {
        endpoint_id: bundle.endpoint_id,
        workspace_id: bundle.workspace_id,
        delivery_id: bundle.delivery_id,
        trigger_event_id: bundle.trigger_event_id,
        provider: this.name,
        model_id: model ?? "(default)",
        reason: "session_created",
      });
    }

    // BeforeTurn extension injections, folded into the turn prompt.
    let injectedContext = "";
    if (context.hooks?.hasHandlers("BeforeTurn")) {
      const origin: { id: string; kind: "context" | "thread" } | undefined = turn.context_id
        ? { id: turn.context_id, kind: "context" as const }
        : { id: turn.thread_id, kind: "thread" as const };
      const hookResults = await context.hooks.fire("BeforeTurn", {
        endpoint_id: bundle.endpoint_id,
        workspace_id: bundle.workspace_id,
        delivery_id: bundle.delivery_id,
        trigger_event_id: bundle.trigger_event_id,
        thread_id: turn.thread_id,
        origin,
      });
      injectedContext = renderHookInjections(hookResults);
    }

    // The SDK owns system-message composition. Floe appends its instructions on
    // creation so vendor guardrails remain active and user prompt ordering is
    // unchanged.
    const parts: string[] = [];
    if (injectedContext) parts.push(injectedContext);
    parts.push(deliveryToPrompt(bundle));
    const prompt = parts.join("\n\n");

    await this.throwIfCancelled(session, turn);
    const cwd = context.workspace_locator ?? process.cwd();
    const systemMessage = freshSession
      ? buildSystemPrompt(runtimeConfig?.instructions?.trim() ?? "")
      : "";
    console.log("[bridge] floe-runtime prompt injected", {
      delivery_id: bundle.delivery_id,
      runtime_turn_id: turn.runtime_turn_id,
      endpoint_id: bundle.endpoint_id,
      fresh_session: freshSession,
      model: model ?? "(default)",
      prompt_length: prompt.length,
      // Instructions reach the model only as the system message of a new
      // session; a resumed session already holds them, so this is 0 there.
      system_message_bytes: systemMessage.length,
    });

    const availableTools = [
      ...session.directTools.map(tool => tool.name),
      ...grantedBuiltinTools(context.engine_tool_operation_ids, model),
    ];
    try {
      await this.throwIfCancelled(session, turn);
      // An SDK session keeps the tool list it was created with; a changed grant
      // set resumes it under the new list instead of reporting catalog drift.
      const offeredTools = JSON.stringify(availableTools);
      if (session.sessionId && session.offeredTools !== null && session.offeredTools !== offeredTools) {
        await session.runtime.retire(session.sessionId);
      }
      if (session.sessionId && model && session.model !== model) {
        await session.runtime.setModel(session.sessionId, model);
      }
      const result = await session.runtime.run(
        "actor",
        { prompt },
        cwd,
        async (sessionId) => {
          session.sessionId = sessionId;
          turn.thread_id = sessionId;
          await this.throwIfCancelled(session, turn);
        },
        {
          ...(model ? { model } : {}),
          ...(session.directTools.length ? { tools: session.directTools } : {}),
          availableTools,
          ...(systemMessage ? { systemMessage: { mode: "append" as const, content: systemMessage } } : {}),
        },
        session.sessionId ? { sessionId: session.sessionId, scope: session.contextId } : { scope: session.contextId },
      );

      session.offeredTools = offeredTools;
      await this.throwIfCancelled(session, turn);
      turn.visible_output = typeof result.text === "string" ? result.text : "";
      if (model) session.model = model;
      await this.appendTelemetry(context, turn, "sdk_tool_evidence", {
        sdk_session_id: result.sessionId,
        offered_tool_names: availableTools,
        registration_acknowledgement: {
          exposed: false,
          reason: "copilot_sdk_does_not_expose_tool_registration_acknowledgement",
        },
        exposure_proof: turn.tool_activity.length > 0
          ? {
              kind: "first_exact_callback",
              tool_call_id: turn.tool_activity[0]?.call_id ?? null,
            }
          : null,
        tool_calls: turn.tool_activity,
      });
      await this.recordUsage(context, turn, result);
      await this.finalizeTurn(context, turn, result);

      if (context.hooks?.hasHandlers("TurnEnd")) {
        await context.hooks.fire("TurnEnd", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          visible_output: turn.visible_output,
          tool_activity: turn.tool_activity,
          emitted_events: turn.emitted_events,
        });
      }

      this.writeWorkLog(context, bundle, turn, "completed");
      turn.settledAt = new Date().toISOString();
      turn.settle();
    } catch (caught) {
      let error = caught;
      if (turn.cancelled) {
        this.beginCancellation(session, turn);
        await turn.cancellation;
        if (turn.cancellationFault) error = turn.cancellationFault;
      }
      const faultCode = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : null;
      const errorMessage = faultCode ? `[${faultCode}] ${error instanceof Error ? error.message : String(error)}` : error instanceof Error ? error.message : String(error);
      const httpStatus = (() => {
        const status = (error as { httpStatus?: unknown; status?: unknown })?.httpStatus ?? (error as { status?: unknown })?.status;
        if (typeof status === "number") return status;
        const m = errorMessage.match(/:\s*(\d{3})\b/);
        return m ? parseInt(m[1], 10) : null;
      })();

      console.error("[bridge] floe-runtime error", {
        delivery_id: bundle.delivery_id,
        runtime_turn_id: turn.runtime_turn_id,
        endpoint_id: bundle.endpoint_id,
        http_status: httpStatus,
        error: errorMessage,
      });

      await this.appendTelemetry(context, turn, "runtime_error", {
        error_message: errorMessage,
        fault_code: faultCode,
        http_status: httpStatus,
        provider: this.name,
        model: model ?? "(default)",
      });

      if (context.hooks?.hasHandlers("Error")) {
        await context.hooks.fire("Error", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          error: errorMessage,
        });
      }

      turn.finalized = true;
      turn.requiresRetirement = turn.cancelled
        && turn.tool_activity.some((activity) => activity.lifecycle === "started");
      this.toolGate.abandonDelivery(turn.delivery_id);
      if (session.activeTurn === turn && !turn.requiresRetirement) session.activeTurn = undefined;
      this.writeWorkLog(context, bundle, turn, "error");
      turn.settledAt = new Date().toISOString();
      turn.settle();

      throw new TurnFailedError(
        bundle.delivery_id,
        turn.source_endpoint_id,
        bundle.workspace_id,
        turn.context_id,
        turn.thread_id,
        model ?? "(default)",
        this.name,
        httpStatus,
        errorMessage,
      );
    }
  }

  cancelDelivery(deliveryId: string): boolean {
    for (const session of this.sessions.values()) {
      const turn = session.activeTurn;
      if (!turn || turn.delivery_id !== deliveryId || turn.finalized) continue;
      turn.cancelled = true;
      turn.cancellationRequestedAt ??= new Date().toISOString();
      this.toolGate.abandonDelivery(deliveryId);
      this.beginCancellation(session, turn);
      return true;
    }
    return false;
  }

  async waitForDeliveryCancellation(deliveryId: string) {
    for (const session of this.sessions.values()) {
      const turn = session.activeTurn;
      if (!turn || turn.delivery_id !== deliveryId) continue;
      if (turn.cancellation) await turn.cancellation;
      await turn.settled;
      if (turn.cancellationFault) return null;
      if (turn.tool_activity.some((activity) => activity.lifecycle === "started")) {
        turn.requiresRetirement = true;
        return null;
      }
      return {
        outcome: "quiesced" as const,
        evidence: {
          runtime_turn_id: turn.runtime_turn_id,
          session_id: session.sessionId,
          timeline: {
            adapter_cancel_requested_at: turn.cancellationRequestedAt,
            runtime_quiesced_at: turn.runtimeQuiescedAt,
            delivery_settled_at: turn.settledAt,
            tool_activity: turn.tool_activity,
          },
        },
      };
    }
    return null;
  }

  async forceRetireDelivery(deliveryId: string) {
    for (const [key, session] of this.sessions) {
      const turn = session.activeTurn;
      if (!turn || turn.delivery_id !== deliveryId || (turn.finalized && !turn.requiresRetirement)) continue;
      turn.cancelled = true;
      turn.cancellationRequestedAt ??= new Date().toISOString();
      this.toolGate.abandonDelivery(deliveryId);
      await session.runtime.close();
      await turn.settled;
      this.sessions.delete(key);
      return {
        outcome: "session_retired" as const,
        evidence: {
          runtime_turn_id: turn.runtime_turn_id,
          session_id: session.sessionId,
          timeline: {
            adapter_cancel_requested_at: turn.cancellationRequestedAt,
            session_retired_at: new Date().toISOString(),
            delivery_settled_at: turn.settledAt,
            tool_activity: turn.tool_activity,
          },
        },
      };
    }
    return null;
  }

  async dispose(_reason: HookPayload<"SessionEnd">["reason"] = "bridge_shutdown"): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      try {
        await session.runtime.close();
      } catch (err) {
        console.error("[bridge] floe-runtime close failed", { endpoint_id: session.endpointId, error: String(err) });
      }
    }
  }

  private getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle): FloeSession {
    // One SDK session per (endpoint, context); a session for context A is never
    // reused for context B. Session continuity across deliveries is handed to
    // floe-runtime via continuation.sessionId on run().
    const contextId = bundle.context_id ?? bundle.events[0]?.context_id ?? "no-context";
    const key = `${bundle.endpoint_id}:${contextId}`;
    const account = context.engine_account;
    if (!account) {
      throw Object.assign(new Error("Copilot readiness did not report a signed-in account for this turn."), { code: "engine_account_unknown" });
    }
    const existing = this.sessions.get(key);
    if (existing && sameAccount(existing.account, account)) {
      existing.context = context;
      return existing;
    }
    if (existing) {
      // Readiness now reports a different account; the old session never runs again.
      this.sessions.delete(key);
      void existing.runtime.close().catch((err) => {
        console.error("[bridge] floe-runtime close failed", { endpoint_id: existing.endpointId, error: String(err) });
      });
    }

    const session = {
      sessionId: null,
      endpointId: bundle.endpoint_id,
      contextId,
      workspaceId: bundle.workspace_id,
      directTools: [],
      offeredTools: null,
      context,
      account,
    } as Omit<FloeSession, "runtime"> as FloeSession;
    const runtime = this.runtimeFactory({
      permissionPolicy: (request) => this.decideToolCall(session, request),
      expectedAccount: account,
    });
    session.runtime = runtime;
    const toolHandle: SubstrateSessionHandle = {
        getBus: () => session.context?.bus ?? context.bus,
        getAnchor: () => (session.activeTurn && !session.activeTurn.finalized && !session.activeTurn.cancelled ? this.turnAnchor(session.activeTurn) : null),
        getActiveTurn: () => {
          const turn = session.activeTurn;
          if (!turn || turn.finalized || turn.cancelled) return null;
          // Getters/setters delegate to the live turn so the operation-authority
          // helper's cache refresh persists across tool calls within one turn.
          return {
            workspace_id: turn.workspace_id,
            context_id: turn.context_id,
            workspace_locator: session.context?.workspace_locator ?? null,
            delivery_id: turn.delivery_id,
            get processing_contract_id() { return turn.processing_contract_id; },
            set processing_contract_id(value: string | null) { turn.processing_contract_id = value; },
            get operation_authority_session() { return turn.operation_authority_session; },
            set operation_authority_session(value: RuntimeOperationAuthoritySession | null) { turn.operation_authority_session = value; },
          };
        },
        isDependencyRequested: () => session.activeTurn?.dependency_requested ?? true,
        markDependencyRequested: () => { if (session.activeTurn) session.activeTurn.dependency_requested = true; },
        recordEmitted: (summary) => { session.activeTurn?.emitted_events.push(summary); },
        recordToolActivity: (entry) => {
          const turn = session.activeTurn;
          if (!turn || turn.finalized) return;
          recordToolActivity(turn, entry);
        },
    };
    session.directTools = createDirectSubstrateTools(toolHandle);
    // Normalized activity events feed the work log's tool activity. floe-runtime
    // pushes these (no polling); a started/completed pair shares one toolCallId.
    runtime.on("activity", (event: ActivityEvent) => {
      const turn = session.activeTurn;
      if (!turn || turn.finalized) return;
      if (event.status === "started") {
        recordToolActivity(turn, {
          name: event.title || event.kind,
          call_id: event.id,
          lifecycle: "started",
          started_at: new Date(event.startedAt ?? Date.now()).toISOString(),
        });
      } else {
        recordToolActivity(turn, {
          name: event.title || event.kind,
          call_id: event.id,
          lifecycle: event.status === "failed" ? "failed" : "completed",
          is_error: event.status === "failed",
          ended_at: new Date(event.endedAt ?? Date.now()).toISOString(),
        });
      }
    });
    runtime.on("diagnostic", (text: string) => {
      console.log("[bridge] floe-runtime diagnostic", { endpoint_id: session.endpointId, text });
    });
    this.sessions.set(key, session);
    return session;
  }

  private startTurn(bundle: DeliveryBundle): FloeTurn {
    const trigger = bundle.events[0];
    const contextId = bundle.context_id ?? trigger?.context_id ?? null;
    const threadId = contextId ?? trigger?.thread_id ?? `thread:${bundle.workspace_id}:floe-runtime`;
    const sourceEndpoint = trigger?.source_endpoint_id || `actor:${bundle.workspace_id}:operator`;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    return {
      runtime_turn_id: `rt_${randomUUID()}`,
      delivery_id: bundle.delivery_id,
      started_at: new Date().toISOString(),
      endpoint_id: bundle.endpoint_id,
      workspace_id: bundle.workspace_id,
      thread_id: threadId,
      context_id: contextId,
      scope_id: typeof trigger?.scope_id === "string" && trigger.scope_id.trim() ? trigger.scope_id : null,
      scope_execution_id: bundle.scope_execution_id ?? null,
      node_execution_id: bundle.node_execution_id ?? null,
      target_node_id: bundle.target_node_id ?? null,
      composition_revision_id: bundle.composition_revision_id ?? null,
      invocation_request_event_id:
        trigger?.type === "request"
          ? (trigger.event_id ?? null)
          : trigger?.type === "request.result" && typeof trigger.metadata?.request_continuation_event_id === "string"
            ? trigger.metadata.request_continuation_event_id
            : null,
      source_endpoint_id: sourceEndpoint,
      trigger_event_id: trigger?.event_id ?? `evt:${bundle.delivery_id}`,
      execution_attempt_id: bundle.execution_attempt_id ?? null,
      operation_authority_session: null,
      processing_contract_id: bundle.processing_contract?.processing_contract_id ?? null,
      visible_output: "",
      tool_activity: [],
      emitted_events: [],
      dependency_requested: false,
      finalized: false,
      cancelled: false,
      requiresRetirement: false,
      cancellation: null,
      cancellationFault: null,
      cancellationRequestedAt: null,
      runtimeQuiescedAt: null,
      settledAt: null,
      settled,
      settle,
    };
  }

  /** Build the neutral write-back anchor the substrate tools require. */
  private turnAnchor(turn: FloeTurn): SubstrateTurnAnchor {
    return {
      workspace_id: turn.workspace_id,
      endpoint_id: turn.endpoint_id,
      thread_id: turn.thread_id,
      context_id: turn.context_id,
      runtime_turn_id: turn.runtime_turn_id,
      delivery_id: turn.delivery_id,
      execution_attempt_id: turn.execution_attempt_id,
      scope_execution_id: turn.scope_execution_id,
      composition_revision_id: turn.composition_revision_id,
      node_execution_id: turn.node_execution_id,
      target_node_id: turn.target_node_id,
      invocation_request_event_id: turn.invocation_request_event_id,
    };
  }

  private async finalizeTurn(context: RuntimeContext, turn: FloeTurn, result: RunResult): Promise<void> {
    if (turn.finalized) return;
    turn.finalized = true;
    const output = turn.visible_output.trim();
    // Every turn that ends records a result, with empty text when the turn
    // produced none, so the finished state is recorded rather than inferred.
    const recorded = await context.bus.recordRuntimeTurnResult({
      delivery_id: turn.delivery_id,
      outcome: "completed",
      text: output,
      metadata: {
        runtime: this.name,
        runtime_turn_id: turn.runtime_turn_id,
        execution_attempt_id: turn.execution_attempt_id,
        node_execution_id: turn.node_execution_id,
        composition_revision_id: turn.composition_revision_id,
        stop_reason: result.stopReason,
        session_id: result.sessionId,
      },
    });
    console.log("[bridge] floe-runtime turn result recorded", {
      runtime_turn_id: turn.runtime_turn_id,
      delivery_id: turn.delivery_id,
      output_length: output.length,
      request_resolved: recorded.request_resolved,
    });
    await this.appendTelemetry(context, turn, "turn_result", {
      text: output,
      result_event_id: recorded.result_event.event_id,
      request_resolved: recorded.request_resolved,
      return_event_id: recorded.return_event?.event_id ?? null,
      stop_reason: result.stopReason,
    });
  }

  private async recordUsage(context: RuntimeContext, turn: FloeTurn, result: RunResult): Promise<void> {
    await this.appendTelemetry(context, turn, "visible_output", { text: turn.visible_output });
    await this.appendTelemetry(context, turn, "usage", {
      ...turnUsage(result.usage),
      usage: result.usage ?? null,
      stop_reason: result.stopReason,
      elapsed_ms: result.elapsedMs,
    });
  }

  private async appendTelemetry(context: RuntimeContext, turn: FloeTurn, kind: string, payload: Record<string, unknown>): Promise<void> {
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
        ...payload,
      },
    });
  }

  private writeWorkLog(context: RuntimeContext, bundle: DeliveryBundle, turn: FloeTurn, outcome: string): void {
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
      delivered_events: (bundle.events ?? []).map((e) => ({
        event_id: e.event_id ?? "unknown",
        type: e.type ?? "unknown",
        source_endpoint_id: e.source_endpoint_id ?? "unknown",
        text: ((e.content as Record<string, unknown>)?.text as string ?? JSON.stringify(e.content ?? "")).slice(0, 200),
      })),
      visible_output: turn.visible_output || null,
      tool_activity: turn.tool_activity ?? [],
      emitted_events: turn.emitted_events ?? [],
      lifecycle_outcome: outcome,
    };
    try {
      appendWorkLog(context.workspace_locator, entry);
    } catch (err) {
      console.error("[bridge] work-log write failed", { agent_id: context.agent_id, error: String(err) });
    }
  }
}
