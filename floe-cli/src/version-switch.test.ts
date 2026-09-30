import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { switchToThisVersion, type RunningTurn, type VersionSwitchDependencies } from "./version-switch.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-version-switch-"));
  dirs.push(dir);
  return join(dir, "config.yaml");
}

const turn: RunningTurn = { workspace_id: "workspace_a", endpoint_id: "actor:workspace_a:floe", name: "Floe" };

function fake(overrides: Partial<VersionSwitchDependencies> & { serving?: string | null; running?: RunningTurn[] } = {}) {
  const calls = { restarted: 0, checkedWorkUnderLock: 0 };
  let serving = overrides.serving === undefined ? "0.4.7" : overrides.serving;
  const deps: VersionSwitchDependencies = {
    ownVersion: () => "0.4.8",
    servingVersion: async () => ({ running: true, version: serving }),
    isThisFloe: async () => true,
    runningTurns: async () => overrides.running ?? [],
    restart: async (_path, _config, beforeStop) => {
      calls.checkedWorkUnderLock++;
      if (!(await beforeStop())) return false;
      calls.restarted++;
      serving = "0.4.8";
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("switching Floe to the surface's newer copy", () => {
  it("restarts from the newer copy when nothing is mid-turn", async () => {
    const { deps, calls } = fake();
    const outcome = await switchToThisVersion({ configPath: configPath() }, deps);
    expect(outcome).toEqual({ kind: "switched", from: "0.4.7", to: "0.4.8", interrupted: [] });
    expect(calls.restarted).toBe(1);
  });

  it("switches an older Floe that does not report its version", async () => {
    const { deps } = fake({ serving: null });
    expect((await switchToThisVersion({ configPath: configPath() }, deps)).kind).toBe("switched");
  });

  it("never interrupts a turn silently: declines and names the running turns", async () => {
    const { deps, calls } = fake({ running: [turn] });
    const outcome = await switchToThisVersion({ configPath: configPath() }, deps);
    expect(outcome.kind).toBe("work_running");
    expect(outcome.kind === "work_running" && outcome.running).toEqual([turn]);
    expect(calls.checkedWorkUnderLock).toBe(1);
    expect(calls.restarted).toBe(0);
  });

  it("interrupts only when asked, and names what it interrupted", async () => {
    const { deps, calls } = fake({ running: [turn] });
    const outcome = await switchToThisVersion({ configPath: configPath(), interrupt_running_work: true }, deps);
    expect(outcome).toEqual({ kind: "switched", from: "0.4.7", to: "0.4.8", interrupted: [turn] });
    expect(calls.restarted).toBe(1);
  });

  it("does nothing when the same version is already serving", async () => {
    const { deps, calls } = fake({ serving: "0.4.8" });
    expect(await switchToThisVersion({ configPath: configPath() }, deps)).toEqual({ kind: "already_serving", version: "0.4.8" });
    expect(calls.restarted).toBe(0);
  });

  it("refuses to go back a version", async () => {
    const { deps, calls } = fake({ serving: "0.5.0" });
    const outcome = await switchToThisVersion({ configPath: configPath() }, deps);
    expect(outcome.kind === "refused" && outcome.reason).toBe("would_downgrade");
    expect(calls.restarted).toBe(0);
  });

  it("leaves a Floe this home did not start alone", async () => {
    const { deps, calls } = fake({ isThisFloe: async () => false });
    const outcome = await switchToThisVersion({ configPath: configPath() }, deps);
    expect(outcome.kind === "refused" && outcome.reason).toBe("not_this_floe");
    expect(calls.restarted).toBe(0);
  });

  it("does not start Floe when it is not running", async () => {
    const { deps, calls } = fake({ servingVersion: async () => ({ running: false, version: null }) });
    const outcome = await switchToThisVersion({ configPath: configPath() }, deps);
    expect(outcome.kind === "refused" && outcome.reason).toBe("not_running");
    expect(calls.restarted).toBe(0);
  });
});
