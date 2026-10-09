/**
 * Hook registry — lifecycle hook points for extensions.
 *
 * Extensions register handlers via `ExtensionContext.hooks.on(...)`.
 * The adapter fires hooks at the appropriate lifecycle points.
 * Handlers run sequentially in registration order; failures are
 * caught and logged, never crashing the adapter.
 */

// Hook names from North Star §14
export type HookName =
  | "SessionStart"
  | "BeforeTurn"
  | "TurnEnd"
  | "BeforeToolUse"
  | "AfterToolUse"
  | "ToolUseFailed"
  | "SessionResume"
  | "SessionEnd"
  | "Pulse"
  | "WebhookReceived"
  | "Error"
  // Slice 0 — context lifecycle
  | "ContextCompacted"
  | "ContextHistoryCleared"
  // Slice 1 — dynamic participants
  | "ParticipantAdded"
  | "ParticipantRemoved"
;

type RuntimeSessionSummary = {
  provider: string;
  model_id: string;
};

type EndpointDeliveryPayload = {
  endpoint_id: string;
  workspace_id: string;
  delivery_id: string;
  trigger_event_id: string;
};

type RuntimeSessionPayload = EndpointDeliveryPayload & {
  provider: string;
  model_id: string;
};

export type HookPayloadByName = {
  SessionStart: RuntimeSessionPayload & { reason: "session_created" };
  BeforeTurn: EndpointDeliveryPayload & {
    thread_id?: string | null;
    /**
     * Typed reference to the delivery origin — symmetric with the emit destination.
     * kind="context" when the trigger event belongs to a specific context thread.
     * kind="thread"  when the trigger event has only a thread_id (no context).
     * Undefined when neither is present (e.g. bare endpoint delivery).
     *
     * Hooks use this to scope their view to a single thread without coupling to
     * event-type identity. An extension's BeforeTurn hook can narrow to the card whose
     * context_id === origin.id when origin.kind === "context".
     */
    origin?: { id: string; kind: "context" | "thread" };
  };
  TurnEnd: EndpointDeliveryPayload & {
    visible_output: string;
    tool_activity: Array<Record<string, unknown>>;
    emitted_events: Array<Record<string, unknown>>;
  };
  BeforeToolUse: EndpointDeliveryPayload & {
    toolCallId: string;
    toolName: string;
  };
  AfterToolUse: EndpointDeliveryPayload & {
    toolCallId: string;
    toolName: string;
    isError: false;
  };
  ToolUseFailed: EndpointDeliveryPayload & {
    toolCallId: string;
    toolName: string;
    isError: true;
  };
  SessionResume: RuntimeSessionPayload & { reason: "session_reused" };
  SessionEnd: {
    endpoint_id: string;
    workspace_id: string;
    reason: "session_replaced" | "bridge_shutdown";
    previous_session: RuntimeSessionSummary;
    delivery_id?: string;
    trigger_event_id?: string;
    next_session?: RuntimeSessionSummary;
  };
  Pulse: EndpointDeliveryPayload & {
    pulse_id?: string;
    event_id: string;
    thread_id?: string | null;
    content: Record<string, unknown>;
  };
  WebhookReceived: {
    workspace_id: string;
    route_id: string;
    event_id: string;
    context_id: string | null;
    target_endpoint_id: string | null;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
  Error: EndpointDeliveryPayload & {
    error: string;
  };
  // Slice 0 — context lifecycle hooks
  ContextCompacted: {
    workspace_id: string;
    context_id: string;
    summary_event_id: string;
  };
  ContextHistoryCleared: {
    workspace_id: string;
    context_id: string;
    events_deleted: number;
  };
  // Slice 1 — dynamic participant hooks
  ParticipantAdded: {
    workspace_id: string;
    context_id: string;
    endpoint_id: string;
  };
  ParticipantRemoved: {
    workspace_id: string;
    context_id: string;
    endpoint_id: string;
  };
  // Side thread lifecycle
};

export type HookPayload<Name extends HookName = HookName> = HookPayloadByName[Name];

/**
 * Hook result with optional context injection.
 *
 * inject.source — identifies the extension providing the injection (e.g., "memory", "todo")
 * inject.content — string content to inject into the agent's context
 * inject.<other> — additional structured data (rendered as JSON if no content string)
 */
export type HookResult = {
  inject?: Record<string, unknown>;
};

// Handler can return void (fire-and-forget), an object with inject data, or several (one per Extension handler)
type HookReturn = void | HookResult | readonly HookResult[];
export type HookHandler<Name extends HookName = HookName> = (payload: HookPayload<Name>) => HookReturn | Promise<HookReturn>;

export class HookRegistry {
  private handlers = new Map<HookName, Array<{ extensionName: string; handler: HookHandler<any> }>>();

  /** Register a handler for a hook. */
  on<Name extends HookName>(hook: Name, extensionName: string, handler: HookHandler<Name>): void {
    if (!this.handlers.has(hook)) {
      this.handlers.set(hook, []);
    }
    this.handlers.get(hook)!.push({ extensionName, handler });
  }

  /** A new registry holding the same handlers; adding to it leaves this one unchanged. */
  copy(): HookRegistry {
    const copy = new HookRegistry();
    for (const [hook, handlers] of this.handlers) copy.handlers.set(hook, [...handlers]);
    return copy;
  }

  /** Remove all handlers registered by an extension. */
  removeAll(extensionName: string): void {
    for (const [, handlers] of this.handlers) {
      const filtered = handlers.filter(h => h.extensionName !== extensionName);
      // Mutate in-place via splice so the Map entry stays valid
      handlers.length = 0;
      handlers.push(...filtered);
    }
  }

  /** Fire a hook — runs all handlers sequentially, collects results. */
  async fire<Name extends HookName>(hook: Name, payload: HookPayload<Name>): Promise<HookResult[]> {
    const handlers = this.handlers.get(hook) ?? [];
    const results: HookResult[] = [];
    for (const { extensionName, handler } of handlers) {
      try {
        const returned = await handler(payload);
        for (const result of Array.isArray(returned) ? returned : [returned]) {
          if (result && typeof result === "object" && "inject" in result) results.push(result);
        }
      } catch (error) {
        console.error(`[hooks] ${hook} handler from extension '${extensionName}' failed`, error);
      }
    }
    return results;
  }

  /** Check if any handlers are registered for a hook. */
  hasHandlers(hook: HookName): boolean {
    return (this.handlers.get(hook)?.length ?? 0) > 0;
  }

  /** List all hooks that have registered handlers with their counts. */
  listRegistered(): Array<{ hook: HookName; count: number }> {
    const result: Array<{ hook: HookName; count: number }> = [];
    for (const [hook, handlers] of this.handlers) {
      if (handlers.length > 0) {
        result.push({ hook, count: handlers.length });
      }
    }
    return result;
  }
}
