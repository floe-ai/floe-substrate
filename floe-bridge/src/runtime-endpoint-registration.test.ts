import { describe, expect, it } from "vitest";
import { runtimeEndpointRegistration } from "./runtime-endpoint-registration.js";

const runtime = {
  endpoint_id: "actor:workspace:w:floe",
  actor_id: "actor:workspace:w:floe",
  name: "Floe",
  agent_id: "floe",
  adapter_id: "floe-runtime",
  actor_definition_revision_id: "adr:1",
  runtime_profile_revision_id: "rpr:1",
  actor_runtime_binding_id: "arb:1",
  runtime_status: "resolved",
  unresolved_reasons: [],
} as const;

describe("runtimeEndpointRegistration", () => {
  it("tells surfaces which engine gates the Actor's work", () => {
    expect(runtimeEndpointRegistration("workspace:w", runtime as never, "copilot", false))
      .toMatchObject({ status: "idle", metadata: { runtime_adapter: "floe-runtime", engine: "copilot" } });
  });

  it("says plainly when the runtime needs no engine", () => {
    expect(runtimeEndpointRegistration("workspace:w", runtime as never, null, false).metadata.engine).toBeNull();
  });

  it("stays unconfigured while its engine holds work or its binding is unresolved", () => {
    expect(runtimeEndpointRegistration("workspace:w", runtime as never, "copilot", true).status).toBe("runtime_unconfigured");
    expect(runtimeEndpointRegistration("workspace:w", { ...runtime, runtime_status: "unresolved" } as never, "copilot", false).status)
      .toBe("runtime_unconfigured");
  });
});
