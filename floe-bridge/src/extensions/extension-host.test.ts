import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.js";
import type { ExtensionLoadResult } from "./extension-protocol.js";

const TODO_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples/extensions/todo/index.ts");

let root: string;
let host: ExtensionHost;
let reloaded: Array<{ workspaceId: string; results: readonly ExtensionLoadResult[] }>;
let reloadWaiters: Array<() => void>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "floe-ext-host-"));
  reloaded = [];
  reloadWaiters = [];
  host = new ExtensionHost({
    restartDelaysMs: [20],
    onReloaded: (workspaceId, results) => {
      reloaded.push({ workspaceId, results });
      reloadWaiters.splice(0).forEach(wake => wake());
    },
  });
});

afterEach(() => {
  host.dispose();
  rmSync(root, { recursive: true, force: true });
});

function entry(name: string, source: string): string {
  const path = join(root, name, "index.mjs");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

const ECHO = `
export default (ctx) => {
  ctx.hooks.on("TurnEnd", () => {});
  return [{
    name: "echo",
    label: "Echo",
    description: "Echo the input",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    async execute(callId, params) {
      if (params.text === "boom") throw new Error("echo refused");
      if (params.text === "crash") process.exit(3);
      return { content: [{ type: "text", text: params.text }], details: { callId, workspace: ctx.workspaceId, ext: ctx.extensionName } };
    },
  }];
};
`;

function nextReload(): Promise<void> {
  return new Promise(resolve => reloadWaiters.push(resolve));
}

describe("Extension process", () => {
  it("loads tools under the Extension's name and runs them in the Workspace", async () => {
    const results = await host.load("ws1", root, [{ name: "echo", entry_path: entry("echo", ECHO), version: "v1" }]);
    expect(results).toEqual([{
      name: "echo",
      version: "v1",
      ok: true,
      hooks: ["TurnEnd"],
      tools: [{
        name: "echo_echo",
        label: "Echo",
        description: "Echo the input",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      }],
    }]);
    expect(await host.call("ws1", "echo", "echo", "call-1", { text: "hi" })).toEqual({
      content: [{ type: "text", text: "hi" }],
      details: { callId: "call-1", workspace: "ws1", ext: "echo" },
    });
  });

  it("reports a broken Extension without stopping the others", async () => {
    const results = await host.load("ws1", root, [
      { name: "broken", entry_path: entry("broken", "export default () => [{ name: 'x' }];"), version: "v1" },
      { name: "echo", entry_path: entry("echo", ECHO), version: "v1" },
    ]);
    expect(results[0]).toMatchObject({ name: "broken", ok: false, error: expect.stringMatching(/description is required/) });
    expect(results[1]).toMatchObject({ name: "echo", ok: true });
  });

  it("returns a tool's error to the caller", async () => {
    await host.load("ws1", root, [{ name: "echo", entry_path: entry("echo", ECHO), version: "v1" }]);
    await expect(host.call("ws1", "echo", "echo", "c", { text: "boom" })).rejects.toThrow("echo refused");
    await expect(host.call("ws1", "echo", "missing", "c", {})).rejects.toThrow(/'echo_missing' is not loaded/);
  });

  it("restarts after a crash and loads every Workspace again", async () => {
    await host.load("ws1", root, [{ name: "echo", entry_path: entry("echo", ECHO), version: "v1" }]);
    const restarted = nextReload();
    await expect(host.call("ws1", "echo", "echo", "c", { text: "crash" })).rejects.toThrow(/stopped unexpectedly/);
    await restarted;
    expect(reloaded).toEqual([{ workspaceId: "ws1", results: [expect.objectContaining({ name: "echo", ok: true })] }]);
    expect((await host.call("ws1", "echo", "echo", "c", { text: "again" })).content).toEqual([{ type: "text", text: "again" }]);
  });

  it("runs the new code when a new version is loaded", async () => {
    const path = entry("echo", ECHO);
    await host.load("ws1", root, [{ name: "echo", entry_path: path, version: "v1" }]);
    writeFileSync(path, ECHO.replace("params.text }]", "'v2:' + params.text }]"));
    await host.load("ws1", root, [{ name: "echo", entry_path: path, version: "v2" }]);
    expect((await host.call("ws1", "echo", "echo", "c", { text: "x" })).content).toEqual([{ type: "text", text: "v2:x" }]);
  });

  it("runs an Extension's hook handlers in order and skips a failing one", async () => {
    await host.load("ws1", root, [{ name: "notes", entry_path: entry("notes", `
      export default (ctx) => {
        ctx.hooks.on("BeforeTurn", (payload) => ({ inject: { source: "notes", content: "first for " + payload.endpoint_id } }));
        ctx.hooks.on("BeforeTurn", () => { throw new Error("broken handler"); });
        ctx.hooks.on("BeforeTurn", () => ({ inject: { source: "notes", content: "second" } }));
        ctx.hooks.on("TurnEnd", () => {});
        return [];
      };
    `), version: "v1" }]);
    expect(await host.hook("ws1", "notes", "BeforeTurn", { endpoint_id: "actor:a" })).toEqual([
      { inject: { source: "notes", content: "first for actor:a" } },
      { inject: { source: "notes", content: "second" } },
    ]);
    expect(await host.hook("ws1", "notes", "TurnEnd", {})).toEqual([]);
    expect(await host.hook("ws1", "notes", "SessionStart", {})).toEqual([]);
  });

  it("refuses a hook Floe does not offer", async () => {
    const [result] = await host.load("ws1", root, [{ name: "hooky", entry_path: entry("hooky", `
      export default (ctx) => { ctx.hooks.on("WebhookReceived", () => {}); return []; };
    `), version: "v1" }]);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/hook 'WebhookReceived' is not offered/) });
  });

  it("loads the todo example as written", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const [result] = await host.load("ws1", workspace, [{ name: "todo", entry_path: TODO_ENTRY, version: "v1" }]);
    expect(result).toMatchObject({ ok: true, hooks: ["TurnEnd"] });
    expect(result!.ok && result!.tools.map(tool => tool.name)).toEqual(["todo_add", "todo_list", "todo_update", "todo_remove"]);
    const added = await host.call("ws1", "todo", "add", "c1", { text: "Ship Extensions" });
    expect(added.content[0]!.text).toMatch(/Ship Extensions/);
  });
});
