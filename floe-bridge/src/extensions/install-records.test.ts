import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkInstalledExtensions, INSTALL_RECORD_SCHEMA, MANIFEST_SCHEMA } from "./install-records.js";

let root: string;
let floeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "floe-ext-records-"));
  floeDir = join(root, "workspace", ".floe");
  mkdirSync(floeDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, content: string | object): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function writeCode(dir: string, name: string): void {
  write(join(dir, "extension.json"), { schema: MANIFEST_SCHEMA, name, description: "Test tools", entry: "./index.ts" });
  write(join(dir, "index.ts"), "export default () => [];\n");
}

function install(name: string, record: Partial<{ code: string; enabled: boolean; accepted_version: string | null }> = {}): string {
  const recordDir = join(floeDir, "extensions", name);
  write(join(recordDir, "installed.json"), {
    schema: INSTALL_RECORD_SCHEMA, code: ".", enabled: true, accepted_version: null, ...record,
  });
  return recordDir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=test@floe.local", "-c", "user.name=Test", ...args], { cwd })
    .toString().trim();
}

async function only() {
  const checks = await checkInstalledExtensions(floeDir);
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe("installed Extensions", () => {
  it("finds nothing when the Workspace has no extensions folder", async () => {
    expect(await checkInstalledExtensions(floeDir)).toEqual([]);
  });

  it("reports a disabled Extension as off without reading its code", async () => {
    install("todo", { enabled: false, code: "../../missing" });
    expect(await only()).toEqual({ name: "todo", state: "off" });
  });

  it("holds code until a version is accepted, then runs exactly that version", async () => {
    const recordDir = install("todo");
    writeCode(recordDir, "todo");

    const held = await only();
    expect(held).toMatchObject({ name: "todo", state: "new_version", accepted_version: null, source: { kind: "digest" } });
    const version = held.state === "new_version" ? held.current_version : "";
    expect(version).toMatch(/^sha256:[0-9a-f]{64}$/);

    install("todo", { accepted_version: version });
    expect(await only()).toMatchObject({
      state: "ready",
      version,
      code_dir: recordDir,
      entry_path: join(recordDir, "index.ts"),
      description: "Test tools",
    });

    write(join(recordDir, "index.ts"), "export default () => [{ name: 'changed' }];\n");
    expect(await only()).toMatchObject({ state: "new_version", accepted_version: version });
  });

  it("leaves installed dependencies out of the digest", async () => {
    const recordDir = install("todo");
    writeCode(recordDir, "todo");
    const before = await only();
    write(join(recordDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const after = await only();
    expect(after.state === "new_version" && after.current_version)
      .toBe(before.state === "new_version" && before.current_version);
  });

  it("pins committed code to its git commit and folder; other commits do not make a new version", async () => {
    const repo = join(root, "tools-repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const codeDir = join(repo, "todo");
    writeCode(codeDir, "todo");
    write(join(repo, "README.md"), "tools\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");

    install("todo", { code: codeDir });
    const first = await only();
    expect(first).toMatchObject({
      state: "new_version",
      source: { kind: "git", commit: git(repo, "rev-parse", "HEAD"), path: "todo" },
    });
    const version = first.state === "new_version" ? first.current_version : "";
    expect(version).toMatch(/^sha256:/);

    write(join(repo, "README.md"), "tools, updated\n");
    git(repo, "commit", "-q", "-am", "unrelated");
    install("todo", { code: codeDir, accepted_version: version });
    expect(await only()).toMatchObject({ state: "ready", version, source: { kind: "git", path: "todo" } });

    write(join(codeDir, "index.ts"), "export default () => [{ name: 'edited' }];\n");
    expect(await only()).toMatchObject({ state: "new_version", source: { kind: "digest" } });
  });

  it("keeps a version settled when code and install record share a committed folder", async () => {
    const workspace = join(root, "workspace");
    git(workspace, "init", "-q");
    const recordDir = install("todo");
    writeCode(recordDir, "todo");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "install todo");

    const held = await only();
    expect(held).toMatchObject({ state: "new_version", source: { kind: "git", path: ".floe/extensions/todo" } });
    install("todo", { accepted_version: held.state === "new_version" ? held.current_version : "" });
    expect(await only()).toMatchObject({ state: "ready", source: { kind: "git" } });
  });

  it("reports a clear failure for each broken install", async () => {
    install("Bad_Name");
    install("no-record");
    rmSync(join(floeDir, "extensions", "no-record", "installed.json"));
    writeCode(install("mismatch"), "other");
    const escaping = install("escaping");
    write(join(escaping, "extension.json"), { schema: MANIFEST_SCHEMA, name: "escaping", entry: "../outside.ts" });
    const missing = install("missing-entry");
    write(join(missing, "extension.json"), { schema: MANIFEST_SCHEMA, name: "missing-entry", entry: "./gone.ts" });

    const failures = Object.fromEntries((await checkInstalledExtensions(floeDir))
      .map(check => [check.name, check.state === "failed" ? check.message : check.state]));
    expect(failures).toEqual({
      "Bad_Name": expect.stringMatching(/lowercase letters, digits and hyphens/),
      "escaping": expect.stringMatching(/must stay inside/),
      "mismatch": expect.stringMatching(/names 'other' but it is installed as 'mismatch'/),
      "missing-entry": expect.stringMatching(/does not exist/),
      "no-record": "installed.json is missing",
    });
  });
});
