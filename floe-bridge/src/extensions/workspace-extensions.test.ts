import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkInstalledExtensions } from "./install-records.js";
import { WorkspaceExtensions, type ExtensionStatus } from "./workspace-extensions.js";

let workspace: string;
let extensions: WorkspaceExtensions;
let pushed: Array<readonly ExtensionStatus[]>;
let waiters: Array<() => void>;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "floe-ws-ext-"));
  mkdirSync(join(workspace, ".floe"), { recursive: true });
  pushed = [];
  waiters = [];
  extensions = new WorkspaceExtensions({
    watchDebounceMs: 50,
    onStatusChanged: (_workspaceId, statuses) => {
      pushed.push(statuses);
      waiters.splice(0).forEach(wake => wake());
    },
  });
});

afterEach(() => {
  extensions.dispose();
  rmSync(workspace, { recursive: true, force: true });
});

function tool(name: string): string {
  return `export default () => [{
    name: "${name}",
    description: "${name}",
    parameters: { type: "object" },
    async execute() { return { content: [{ type: "text", text: "${name}" }] }; },
  }];`;
}

function writeExtension(name: string, source: string, codeDir = join(workspace, ".floe", "extensions", name)): string {
  const recordDir = join(workspace, ".floe", "extensions", name);
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "extension.json"), JSON.stringify({ schema: "floe.extension.v1", name, entry: "./index.mjs" }));
  writeFileSync(join(codeDir, "index.mjs"), source);
  writeFileSync(
    join(recordDir, "installed.json"),
    JSON.stringify({ schema: "floe.extension-install.v1", code: codeDir, enabled: true, accepted_version: null }),
  );
  return recordDir;
}

async function accept(name: string): Promise<void> {
  const check = (await checkInstalledExtensions(join(workspace, ".floe"))).find(item => item.name === name);
  if (check?.state !== "new_version") throw new Error(`expected ${name} to be waiting, got ${check?.state}`);
  updateRecord(name, { accepted_version: check.current_version });
}

function updateRecord(name: string, change: Record<string, unknown>): void {
  const path = join(workspace, ".floe", "extensions", name, "installed.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...change }));
}

/** Waits until a pushed status list satisfies the check. */
async function pushedUntil(check: (statuses: readonly ExtensionStatus[]) => boolean): Promise<readonly ExtensionStatus[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = pushed.find(check);
    if (match) return match;
    if (Date.now() > deadline) throw new Error(`no matching status was pushed: ${JSON.stringify(pushed)}`);
    await new Promise<void>(resolve => {
      waiters.push(resolve);
      setTimeout(resolve, 500);
    });
  }
}

const statusOf = (statuses: readonly ExtensionStatus[], name: string) => statuses.find(item => item.name === name);

describe("WorkspaceExtensions watching", () => {
  it("pushes new statuses when install records or Extension code change", async () => {
    writeExtension("echo", tool("one"));
    await accept("echo");
    const first = await extensions.reconcile("ws", workspace);
    expect(statusOf(first, "echo")).toMatchObject({ status: "running", tools: ["echo_one"] });

    writeFileSync(join(workspace, ".floe", "extensions", "echo", "index.mjs"), tool("two"));
    const held = await pushedUntil(statuses => statusOf(statuses, "echo")?.status === "new_version");
    expect(statusOf(held, "echo")).toMatchObject({ status: "new_version" });
    expect(extensions.toolsFor("ws", ["echo"])).toEqual([]);

    pushed = [];
    await accept("echo");
    await pushedUntil(statuses => statusOf(statuses, "echo")?.status === "running");
    expect(extensions.toolsFor("ws", ["echo"]).map(item => item.name)).toEqual(["echo_two"]);

    pushed = [];
    updateRecord("echo", { enabled: false });
    await pushedUntil(statuses => statusOf(statuses, "echo")?.status === "off");
    expect(extensions.toolsFor("ws", ["echo"])).toEqual([]);
  });

  it("notices an Extension installed after the Workspace attached, with its code outside the Workspace", async () => {
    expect(await extensions.reconcile("ws", workspace)).toEqual([]);

    const outside = mkdtempSync(join(tmpdir(), "floe-ext-code-"));
    try {
      writeExtension("late", tool("tool"), outside);
      await pushedUntil(statuses => statusOf(statuses, "late")?.status === "new_version");
      pushed = [];
      await accept("late");
      await pushedUntil(statuses => statusOf(statuses, "late")?.status === "running");

      pushed = [];
      writeFileSync(join(outside, "index.mjs"), tool("changed"));
      await pushedUntil(statuses => statusOf(statuses, "late")?.status === "new_version");
    } finally {
      extensions.stop("ws");
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops watching a stopped Workspace", async () => {
    writeExtension("echo", tool("one"));
    await extensions.reconcile("ws", workspace);
    extensions.stop("ws");

    await accept("echo");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(pushed).toEqual([]);
  });
});
