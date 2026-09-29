import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StartInProgressError, withStartLock } from "./start-lock.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-start-lock-"));
  roots.push(dir);
  return join(dir, ".floe");
}

/** A separate process that holds the lock until killed, and says so once it does. */
function holder(floeHome: string) {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const lock = pathToFileURL(fileURLToPath(new URL("./start-lock.ts", import.meta.url))).href;
  const script = `const { withStartLock } = await import(${JSON.stringify(lock)});
    await withStartLock(${JSON.stringify(floeHome)}, () => { process.stdout.write("held"); return new Promise(() => {}); });`;
  const child = spawn(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  return { child, held };
}

describe("start lock", () => {
  it("makes starts of one home take turns, and lets other homes start freely", async () => {
    const floeHome = home();
    const events: string[] = [];
    const start = (name: string) => withStartLock(floeHome, async () => {
      events.push(`${name} begins`);
      await new Promise((resolve) => setImmediate(resolve));
      events.push(`${name} ends`);
      return name;
    });
    const other = withStartLock(home(), async () => "other");
    expect(await Promise.all([start("a"), start("b"), start("c"), other])).toEqual(["a", "b", "c", "other"]);
    for (let i = 0; i < events.length; i += 2) expect(events[i + 1]).toBe(events[i]!.replace("begins", "ends"));
  });

  it("releases the lock when a start fails", async () => {
    const floeHome = home();
    await expect(withStartLock(floeHome, async () => { throw new Error("start failed"); })).rejects.toThrow("start failed");
    expect(await withStartLock(floeHome, async () => "next")).toBe("next");
  });

  it("continues as soon as a start in another process ends, even when it dies", async () => {
    const floeHome = home();
    const { child, held } = holder(floeHome);
    await held;
    let ran = false;
    const waiting = withStartLock(floeHome, async () => { ran = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ran).toBe(false);
    child.kill();
    await waiting;
    expect(ran).toBe(true);
  }, 30_000);

  it("says so plainly when another start never finishes", async () => {
    const floeHome = home();
    const { child, held } = holder(floeHome);
    try {
      await held;
      await expect(withStartLock(floeHome, async () => {}, 300)).rejects.toBeInstanceOf(StartInProgressError);
    } finally {
      child.kill();
    }
  }, 30_000);
});
