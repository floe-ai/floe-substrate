import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectTemplate } from "./project.js";
import { appendWorkLog, type WorkLogEntry } from "./runtime-core/worklog.js";
import { migrateWorkLogsToState } from "./worklog-location-migration.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const entry = (turn: string): WorkLogEntry => ({
  runtime_turn_id: turn, agent_id: "floe", started_at: "2026-09-29T10:00:00Z", ended_at: "2026-09-29T10:00:05Z",
  trigger_type: "message", scope_id: null, thread_id: "thread", delivery_id: "delivery",
  delivered_events: [], visible_output: "done", tool_activity: [], emitted_events: [], lifecycle_outcome: "completed",
});
const legacyLog = (root: string, agent = "floe", day = "2026-09-28") => join(root, ".floe", "agents", agent, "worklogs", `${day}.md`);
const stateLog = (root: string, agent = "floe", day = "2026-09-28") => join(root, ".floe", "state", "agents", agent, "worklogs", `${day}.md`);

// Real git runs several times per test, which is slow under a parallel suite.
describe("Actor work logs live in git-ignored .floe/state", { timeout: 60_000 }, () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function workspace(options: { git: boolean; commitStateIgnore?: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), "floe-worklog-location-"));
    roots.push(root);
    ensureProjectTemplate(root, "Test");
    if (!options.commitStateIgnore) rmSync(join(root, ".floe", "state"), { recursive: true, force: true });
    if (options.git) {
      git(root, "init", "-q");
      git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
      git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "workspace");
    }
    return root;
  }
  const writeLegacy = (root: string, text: string, agent = "floe", day = "2026-09-28") => {
    mkdirSync(join(root, ".floe", "agents", agent, "worklogs"), { recursive: true });
    writeFileSync(legacyLog(root, agent, day), text, "utf8");
  };

  it("a turn's work log leaves git status clean, even when .floe/state was never committed", () => {
    for (const commitStateIgnore of [true, false]) {
      const root = workspace({ git: true, commitStateIgnore });
      appendWorkLog(root, entry("turn-1"));
      expect(readFileSync(stateLog(root, "floe", "2026-09-29"), "utf8")).toContain("## Turn turn-1");
      expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }
  });

  it("moves untracked legacy logs into .floe/state and leaves no trace beside the Actor's definition", () => {
    const root = workspace({ git: true });
    writeLegacy(root, "## Turn old\n");
    writeLegacy(root, "## Turn reviewer\n", "reviewer");
    const migration = migrateWorkLogsToState(root);
    expect([...migration.moved].sort()).toEqual([".floe/agents/floe/worklogs/2026-09-28.md", ".floe/agents/reviewer/worklogs/2026-09-28.md"]);
    expect(readFileSync(stateLog(root), "utf8")).toBe("## Turn old\n");
    expect(readFileSync(stateLog(root, "reviewer"), "utf8")).toBe("## Turn reviewer\n");
    expect(existsSync(join(root, ".floe", "agents", "floe"))).toBe(false);
    expect(existsSync(join(root, ".floe", "agents", "floe.md"))).toBe(true);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("keeps logs a person committed, so migrating never changes tracked files", () => {
    const root = workspace({ git: true });
    writeLegacy(root, "## Turn committed\n");
    git(root, "add", "-A");
    git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "logs");
    writeLegacy(root, "## Turn loose\n", "floe", "2026-09-27");
    const migration = migrateWorkLogsToState(root);
    expect(migration).toMatchObject({ moved: [".floe/agents/floe/worklogs/2026-09-27.md"],
      kept_tracked: [".floe/agents/floe/worklogs/2026-09-28.md"], kept_uncertain: null });
    expect(readFileSync(legacyLog(root), "utf8")).toBe("## Turn committed\n");
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("recognises committed logs when the workspace is a subfolder of its repository", () => {
    const repo = workspace({ git: false });
    const root = join(repo, "apps", "site");
    mkdirSync(root, { recursive: true });
    ensureProjectTemplate(root, "Site");
    writeLegacy(root, "## Turn committed\n");
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "all");
    expect(migrateWorkLogsToState(root).kept_tracked).toEqual([".floe/agents/floe/worklogs/2026-09-28.md"]);
  });

  it("moves logs in a workspace that is not a git repository, keeping older entries first", () => {
    const root = workspace({ git: false });
    writeLegacy(root, "## Turn older\n");
    mkdirSync(join(root, ".floe", "state", "agents", "floe", "worklogs"), { recursive: true });
    writeFileSync(stateLog(root), "## Turn newer\n", "utf8");
    expect(migrateWorkLogsToState(root).moved).toEqual([".floe/agents/floe/worklogs/2026-09-28.md"]);
    expect(readFileSync(stateLog(root), "utf8")).toBe("## Turn older\n## Turn newer\n");
    expect(migrateWorkLogsToState(root)).toEqual({ moved: [], kept_tracked: [], kept_uncertain: null });
  });
});
