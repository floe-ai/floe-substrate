import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";

const HOST_TOKEN = `floe-native-host-${"w".repeat(48)}`;
const provenance = { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "floe-workspace-access-")));
  const configPath = join(dir, "config.yaml"), config = defaultConfig(dir);
  writeFileSync(configPath, YAML.stringify(config));
  const handle = await createBusServer(configPath, config, {
    host_control_token: HOST_TOKEN, host_control_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  cleanups.push(async () => { await handle.app.close(); rmSync(dir, { recursive: true, force: true }); });
  await handle.app.ready();
  const home = join(dir, "home"), second = join(dir, "second");
  mkdirSync(home); mkdirSync(second);
  const workspaceId = (handle.store.registerWorkspace({ locator: home, name: "Access", init_authorized: true }, handle.broadcast) as
    { workspace_id: string }).workspace_id;
  const pushed: Array<{ type: string; payload: any }> = [];
  handle.store.setBroadcast((type, payload) => pushed.push({ type, payload }));
  const session = await handle.app.inject({ method: "POST",
    url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
    headers: { authorization: `Bearer ${HOST_TOKEN}` }, payload: { interaction_session_id: "interaction:access" } });
  expect(session.statusCode, session.body).toBe(201);
  let sequence = 0;
  const invoke = async (operationId: string, input: object, token: string = session.json().bearer_token) => {
    const response = await handle.app.inject({ method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: { authorization: `Bearer ${token}` },
      payload: { operation_id: operationId, operation_version: "1", input_schema_version: "1", input,
        target: null, expected_resource_revision: null, idempotency_key: `test:access:${++sequence}` } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().receipt;
  };
  return { handle, workspaceId, home, second, dir, pushed, invoke };
}

describe("Workspace folders and System access operations", () => {
  it("lets a surface list, add and remove folders and turn System access on, recording and pushing each change", async () => {
    const f = await fixture();
    const shown = await f.invoke("workspace.access.inspect", {});
    expect(shown.result).toMatchObject({ system_access: false, records: [],
      folders: [{ folder_id: "home", path: f.home, home: true, available: true }] });

    const added = await f.invoke("workspace.folder.add", { path: f.second });
    expect(added.state).toBe("completed");
    expect(added.result.folders.map((folder: { path: string }) => folder.path)).toEqual([f.home, f.second]);
    await Promise.resolve();
    expect(f.pushed.filter((item) => item.type === "workspace_access_changed")).toEqual([{ type: "workspace_access_changed",
      payload: { workspace_id: f.workspaceId, access: expect.objectContaining({ folders: added.result.folders }) } }]);

    const turnedOn = await f.invoke("workspace.system_access.set", { enabled: true });
    expect(turnedOn.result.system_access).toBe(true);
    const removed = await f.invoke("workspace.folder.remove", { folder_id: added.result.folders[1].folder_id });
    expect(removed.result.folders.map((folder: { path: string }) => folder.path)).toEqual([f.home]);
    expect(removed.result.records.map((record: { kind: string; summary: string }) => record.kind)).toEqual([
      "folder_removed", "system_access_turned_on", "folder_added",
    ]);
    expect(removed.result.records[1].summary).toMatch(/anywhere on this machine/);
  });

  it("refuses folders that cannot be one, and never removes the Workspace's own folder", async () => {
    const f = await fixture();
    const code = async (operationId: string, input: object) => (await f.invoke(operationId, input)).refusal?.code;
    expect(await code("workspace.folder.add", { path: "relative/folder" })).toBe("folder_invalid");
    expect(await code("workspace.folder.add", { path: join(f.dir, "missing") })).toBe("folder_invalid");
    expect(await code("workspace.folder.add", { path: join(f.dir, "config.yaml") })).toBe("folder_invalid");
    mkdirSync(join(f.home, "inner"));
    expect(await code("workspace.folder.add", { path: join(f.home, "inner") })).toBe("folder_already_included");
    await f.invoke("workspace.folder.add", { path: f.second });
    expect(await code("workspace.folder.add", { path: f.second })).toBe("folder_already_included");
    expect(await code("workspace.folder.remove", { folder_id: "home" })).toBe("home_folder_fixed");
    expect(await code("workspace.folder.remove", { folder_id: "folder_unknown" })).toBe("folder_not_found");
    // Turning on what is already on changes and records nothing.
    const off = await f.invoke("workspace.system_access.set", { enabled: false });
    expect(off.result.records.map((record: { kind: string }) => record.kind)).toEqual(["folder_added"]);
  });

  it("records a notice as seen per person, pushes it, and shows a changed notice as new again", async () => {
    const f = await fixture();
    const notice = (summary: string) => f.handle.store.workspaceAccessStore.recordStandingNotice({ record_id: "notice:test",
      workspace_id: f.workspaceId, kind: "actor_access_lapsing", summary, principal_id: "system:test" });
    const pushes = () => f.pushed.filter((item) => item.type === "workspace_access_changed").length;
    expect(notice("Access ends on 2099-01-01.")).toBe(true);
    await Promise.resolve();
    expect(pushes()).toBe(1);

    const grant = f.handle.store.capabilityGrantStore.issueGrant({ principal_id: "person:two",
      boundary: { kind: "workspace", workspace_id: f.workspaceId },
      operation_ids: ["workspace.access.inspect", "workspace.notice.acknowledge"],
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "policy:test", evidence: [{ kind: "test_fixture", ref: "notice" }] });
    const other = f.handle.store.operationAuthoritySessions.issueSession({ principal_id: "person:two",
      workspace_id: f.workspaceId, grant_ids: [grant.grant_id], interaction: { mode: "interactive", session_id: "test:two" },
      provenance, expires_at: "2099-01-01T00:00:00.000Z" }).bearer_token;

    const seen = await f.invoke("workspace.notice.acknowledge", { record_id: "notice:test" });
    expect(seen.result.records[0]).toMatchObject({ record_id: "notice:test", seen: true, seen_by: [seen.principal_id] });
    await Promise.resolve();
    expect(pushes()).toBe(2);
    expect(f.pushed.at(-1)!.payload.access.records[0].seen_by).toEqual([seen.principal_id]);
    expect((await f.invoke("workspace.access.inspect", {}, other)).result.records[0].seen).toBe(false);
    // Seeing it again changes nothing and pushes nothing.
    await f.invoke("workspace.notice.acknowledge", { record_id: "notice:test" });
    await Promise.resolve();
    expect(pushes()).toBe(2);

    notice("Access ends on 2099-02-01.");
    expect((await f.invoke("workspace.access.inspect", {})).result.records[0]).toMatchObject({ seen: false, seen_by: [] });
    expect((await f.invoke("workspace.notice.acknowledge", { record_id: "notice:missing" })).refusal.code).toBe("notice_not_found");
    f.handle.store.workspaceAccessStore.removeStandingNotice("notice:test");
    await Promise.resolve();
    expect(f.pushed.at(-1)!.payload.access.records).toEqual([]);
  });

  it("does not let an unattended session, such as an Actor's, widen the boundary", async () => {
    const f = await fixture();
    const grant = f.handle.store.capabilityGrantStore.issueGrant({ principal_id: "actor:access:worker",
      boundary: { kind: "workspace", workspace_id: f.workspaceId },
      operation_ids: ["workspace.access.inspect", "workspace.folder.add", "workspace.system_access.set"],
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "policy:test", evidence: [{ kind: "test_fixture", ref: "access" }] });
    const token = f.handle.store.operationAuthoritySessions.issueSession({ principal_id: "actor:access:worker",
      workspace_id: f.workspaceId, grant_ids: [grant.grant_id], interaction: { mode: "unattended", session_id: "test:unattended" },
      provenance, expires_at: "2099-01-01T00:00:00.000Z" }).bearer_token;
    expect((await f.invoke("workspace.access.inspect", {}, token)).state).toBe("completed");
    expect((await f.invoke("workspace.folder.add", { path: f.second }, token)).state).toBe("refused");
    expect((await f.invoke("workspace.system_access.set", { enabled: true }, token)).state).toBe("refused");
    expect(f.handle.store.workspaceAccessStore.inspect(f.workspaceId)).toMatchObject({ system_access: false, records: [] });
  });
});
