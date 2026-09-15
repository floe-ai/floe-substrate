import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-read-by-id-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

/**
 * F-READBYID: a read by id must return exactly the requested Event or 404 — it
 * must never silently substitute a different record. The old path (an event_id
 * query param on GET /v1/events) was dropped by validation, so it returned a
 * workspace-filtered list instead of the asked-for Event. GET /v1/events/:id is
 * the honest read.
 */
describe("GET /v1/events/:event_id", () => {
  let handle: ServerHandle;
  let tmp: string;

  beforeEach(async () => { const m = await makeServer(); handle = m.handle; tmp = m.tmp; });
  afterEach(async () => { try { await handle.app.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  it("returns 404 for an unknown event rather than a substitute", async () => {
    const res = await handle.app.inject({ method: "GET", url: "/v1/events/evt_nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("event_not_found");
  });

  it("returns exactly the requested event, not the newest in the workspace", async () => {
    const ws = "workspace:test-read-by-id";
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

    const emit = async (text: string) => {
      const res = await handle.app.inject({
        method: "POST",
        url: "/v1/events/emit",
        payload: {
          type: "message",
          workspace_id: ws,
          source_endpoint_id: "actor:test:e1",
          destination: { kind: "endpoint", endpoint_id: "actor:test:e2" },
          content: { text }
        }
      });
      expect(res.statusCode).toBe(202);
      return res.json().event_id as string;
    };

    const firstId = await emit("first");
    await emit("second");
    await emit("third");

    // Reading the FIRST event by id must return the first event — not the
    // newest event in the workspace, which is what the dropped query filter did.
    const res = await handle.app.inject({ method: "GET", url: `/v1/events/${encodeURIComponent(firstId)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event.event_id).toBe(firstId);
    expect(body.event.content.text).toBe("first");
  });
});
