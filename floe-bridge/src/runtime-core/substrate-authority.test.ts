import { describe, expect, it } from "vitest";
import type { BusClient } from "../bus-client.js";
import { executeUseCapability } from "./substrate-capability-tools.js";

describe("operation authority for a turn", () => {
  it("tells an Actor with no permissions that it cannot use Floe operations, without calling one", async () => {
    let invoked = false;
    const bus = {
      async prepareRuntimeDelivery() {
        return {
          delivery: { state: "injected_to_runtime" },
          processing_contract: { processing_contract_id: "contract:1" },
          operation_authority_session: null,
          engine_tool_operation_ids: [],
        };
      },
      async invokeOperation() { invoked = true; throw new Error("must not be called"); },
    } as unknown as BusClient;
    const turn = { delivery_id: "delivery:1", processing_contract_id: "contract:1", operation_authority_session: null };

    const result = await executeUseCapability(bus, "workspace:1", turn, {
      operation_id: "actor.list", operation_version: "1", input_schema_version: "1", input: {},
    });

    expect(invoked).toBe(false);
    expect(JSON.stringify(result.content)).toContain("This Actor holds no permissions");
  });
});
