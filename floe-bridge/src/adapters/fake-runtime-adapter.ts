import type { AgentRuntimeConfig } from "../auth.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";

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
