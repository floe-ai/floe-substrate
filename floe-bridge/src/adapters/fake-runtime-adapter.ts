import { randomUUID } from "node:crypto";
import type { AgentRuntimeConfig } from "../auth.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";
import { executeRequest, type SubstrateToolIdentity, type SubstrateTurnAnchor } from "../runtime-core/substrate-tools.js";

const FAKE_IDENTITY: SubstrateToolIdentity = {
  runtimeName: "fake",
  emitOrigin: "fake_emit_tool",
  requestOrigin: "fake_request_tool",
};

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "fake";

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, _runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const trigger = bundle.events[0];
    const text = firstText(trigger);

    // Fire Pulse hooks for pulse.fired events. This enables the deterministic
    // overseer driver to run on heartbeat pulses without a real LLM configured.
    const pulseEvents = bundle.events.filter((e) => e.type === "pulse.fired");
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
          content: pulseEvent.content,
        });
      }
    }

    // A delivered event may instruct this turn to ask another Actor. When it
    // does, the turn issues a REAL `request` through the shared substrate tool —
    // the same code path every runtime uses — so the pending dependency and the
    // eventual resume are produced by the substrate, not hand-planted. The ask
    // is data on the delivered event, exactly as a prompt would drive a model.
    const ask = (trigger?.content as any)?.data?.ask as { actor?: string; work?: string } | undefined;
    if (ask?.actor && trigger?.type !== "request.result") {
      const anchor: SubstrateTurnAnchor = {
        workspace_id: bundle.workspace_id,
        endpoint_id: bundle.endpoint_id,
        thread_id: typeof trigger?.thread_id === "string" ? trigger.thread_id : "",
        context_id: (trigger as any)?.context_id ?? null,
        runtime_turn_id: `rt_${randomUUID()}`,
        delivery_id: bundle.delivery_id,
        execution_attempt_id: bundle.execution_attempt_id ?? null,
        scope_execution_id: bundle.scope_execution_id ?? null,
        composition_revision_id: bundle.composition_revision_id ?? null,
        node_execution_id: bundle.node_execution_id ?? null,
        target_node_id: bundle.target_node_id ?? null,
        invocation_request_event_id: null,
      };
      await executeRequest(context.bus, anchor, { actor: ask.actor, work: ask.work ?? "" }, FAKE_IDENTITY, false);
      await context.bus.recordRuntimeTurnResult({
        delivery_id: bundle.delivery_id,
        outcome: "completed",
        text: `Fake Floe asked ${ask.actor} and is waiting for its response.`,
        metadata: { runtime: this.name, delivery_id: bundle.delivery_id, asked: ask.actor },
      });
      return;
    }

    // A request.result delivery is the asked Actor's answer arriving back. The
    // turn resumes on the ordinary delivery loop and records the answer it saw,
    // which is the observable proof the asking Actor resumed.
    if (trigger?.type === "request.result") {
      await context.bus.appendRuntimeTelemetry({
        workspace_id: bundle.workspace_id,
        endpoint_id: bundle.endpoint_id,
        delivery_id: bundle.delivery_id,
        kind: "visible_output",
        payload: { text: `Fake runtime resumed with an actor response.` },
      });
      await context.bus.recordRuntimeTurnResult({
        delivery_id: bundle.delivery_id,
        outcome: "completed",
        text: `Fake Floe resumed with the response: "${text}".`,
        metadata: { runtime: this.name, delivery_id: bundle.delivery_id, resumed_with: text },
      });
      return;
    }

    await context.bus.appendRuntimeTelemetry({
      workspace_id: bundle.workspace_id,
      endpoint_id: bundle.endpoint_id,
      delivery_id: bundle.delivery_id,
      kind: "visible_output",
      payload: {
        text: `Fake runtime accepted ${bundle.events.length} event(s).`
      }
    });

    await context.bus.recordRuntimeTurnResult({
      delivery_id: bundle.delivery_id,
      outcome: "completed",
      text: `Fake Floe received: "${text}". I processed the local delivery and ended the turn normally.`,
      metadata: {
        runtime: this.name,
        delivery_id: bundle.delivery_id
      }
    });
  }
}

function firstText(event: DeliveryBundle["events"][number]): string {
  const value = event.content?.text;
  return typeof value === "string" && value.trim() ? value.trim() : event.type;
}
