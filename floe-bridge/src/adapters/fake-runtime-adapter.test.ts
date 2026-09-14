import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { BusClient, type DeliveryBundle } from "../bus-client.js";
import type { RuntimeContext } from "./runtime-adapter.js";

function makeDelivery(contextId: string | null = "ctx_delivery"): DeliveryBundle {
  const trigger: DeliveryBundle["events"][number] = {
    event_id: "evt_trigger",
    type: "message",
    workspace_id: "workspace:test",
    source_endpoint_id: "actor:workspace:test:operator",
    thread_id: "thread:test",
    context_id: contextId,
    correlation_id: null,
    artefact_version_ids: [],
    destination_json: {
      kind: "endpoint",
      endpoint_id: "actor:workspace:test:floe"
    },
    content: {
      text: "hello"
    },
    response: {
      expected: false
    },
    metadata: {},
    created_at: new Date().toISOString()
  };

  return {
    delivery_id: "del_test",
    endpoint_id: "actor:workspace:test:floe",
    workspace_id: "workspace:test",
    trigger_event_id: trigger.event_id,
    events: [trigger],
    delivered_at: new Date().toISOString()
  };
}

function makeContext(): {
  context: RuntimeContext;
  emittedEvents: Array<Parameters<BusClient["emit"]>[0]>;
  turnResults: Array<Parameters<BusClient["recordRuntimeTurnResult"]>[0]>;
} {
  const emittedEvents: Array<Parameters<BusClient["emit"]>[0]> = [];
  const turnResults: Array<Parameters<BusClient["recordRuntimeTurnResult"]>[0]> = [];
  const bus = new BusClient("http://127.0.0.1");
  bus.appendRuntimeTelemetry = async () => {};
  bus.recordRuntimeTurnResult = async (input) => {
    turnResults.push(input);
    return {
      result_event: { event_id: `result:${input.delivery_id}` } as any,
      return_event: null,
      request_resolved: false
    };
  };
  bus.emit = async (event) => {
    emittedEvents.push(event);
    return { event_id: "event:accepted", accepted_at: "2026-09-05T00:00:00Z",
      event: { ...makeDelivery().events[0]!, ...event,
        event_id: "event:accepted", destination_json: event.destination } };
  };
  return {
    emittedEvents,
    turnResults,
    context: {
      bridge_id: "bridge:test",
      bus
    }
  };
}

describe("FakeRuntimeAdapter", () => {
  it("records its natural completion without emitting a routed reply", async () => {
    const { context, emittedEvents, turnResults } = makeContext();
    const adapter = new FakeRuntimeAdapter();

    await adapter.handleBundle(context, makeDelivery("ctx_delivery"), undefined);

    expect(emittedEvents).toHaveLength(0);
    expect(turnResults).toEqual([expect.objectContaining({
      delivery_id: "del_test",
      outcome: "completed",
      text: expect.stringContaining('Fake Floe received: "hello"')
    })]);
  });
});
