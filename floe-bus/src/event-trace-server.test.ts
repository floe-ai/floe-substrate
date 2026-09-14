import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-trace-srv-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

describe("GET /v1/events/:event_id/trace", () => {
  let handle: ServerHandle;
  let tmp: string;

  beforeEach(async () => { const m = await makeServer(); handle = m.handle; tmp = m.tmp; });
  afterEach(async () => { try { await handle.app.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  it("returns 404 for an unknown event", async () => {
    const res = await handle.app.inject({ method: "GET", url: "/v1/events/evt_nope/trace" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("event_not_found");
  });

  it("returns the trace for an emitted event, joined by its producing delivery", async () => {
    const ws = "workspace:test-trace-srv";
    await handle.app.inject({
      method: "POST",
      url: "/v1/endpoints/register",
      payload: { endpoint_id: "actor:test:e1", workspace_id: ws, name: "e1", status: "idle" }
    });
    await handle.app.inject({
      method: "POST",
      url: "/v1/endpoints/register",
      payload: { endpoint_id: "actor:test:e2", workspace_id: ws, name: "e2", status: "idle" }
    });
    const emitted = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: ws,
        source_endpoint_id: "actor:test:e1",
        destination: { kind: "endpoint", endpoint_id: "actor:test:e2" },
        content: { text: "done" },
        metadata: { delivery_id: "del_srv_1" }
      }
    });
    expect(emitted.statusCode).toBe(202);
    const eventId = emitted.json().event_id;

    await handle.app.inject({
      method: "POST",
      url: "/v1/runtime/telemetry",
      payload: { workspace_id: ws, endpoint_id: "actor:test:e1", delivery_id: "del_srv_1", kind: "tool_use", payload: { tool: "bash" } }
    });

    const trace = await handle.app.inject({ method: "GET", url: `/v1/events/${encodeURIComponent(eventId)}/trace` });
    expect(trace.statusCode).toBe(200);
    const body = trace.json();
    expect(body.delivery_id).toBe("del_srv_1");
    expect(body.telemetry).toHaveLength(1);
    expect(body.telemetry[0].delivery_id).toBe("del_srv_1");
  });
});
