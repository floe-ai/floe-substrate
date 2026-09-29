import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workLogDirectory } from "./runtime-core/worklog.js";

/**
 * Floe once wrote Actor work logs into `.floe/agents/<id>/worklogs/`, beside
 * committed configuration. They now live in the git-ignored `.floe/state`.
 * Logs git does not track are moved there. Logs a person committed are theirs:
 * moving them would change tracked files, so they are kept and reported.
 * When git cannot say which logs are tracked, every log is kept and reported.
 */
export type WorkLogLocationMigration = Readonly<{
  moved: readonly string[];
  kept_tracked: readonly string[];
  kept_uncertain: Readonly<{ paths: readonly string[]; reason: string }> | null;
}>;

const LEGACY_ROOT = [".floe", "agents"];

export function migrateWorkLogsToState(workspacePath: string): WorkLogLocationMigration {
  const legacy = legacyWorkLogs(workspacePath);
  if (legacy.length === 0) return { moved: [], kept_tracked: [], kept_uncertain: null };
  const tracked = trackedPaths(workspacePath);
  if ("reason" in tracked) {
    return { moved: [], kept_tracked: [], kept_uncertain: { paths: legacy.map(item => item.relative), reason: tracked.reason } };
  }
  const moved: string[] = [];
  const keptTracked: string[] = [];
  for (const log of legacy) {
    if (tracked.paths.has(log.relative)) {
      keptTracked.push(log.relative);
      continue;
    }
    const destination = join(workLogDirectory(workspacePath, log.agentId), log.file);
    const content = readFileSync(log.absolute);
    // An older day's entries come before any written since.
    if (existsSync(destination)) writeFileSync(destination, Buffer.concat([content, readFileSync(destination)]));
    else writeFileSync(destination, content);
    rmSync(log.absolute);
    moved.push(log.relative);
  }
  for (const agentId of new Set(legacy.map(log => log.agentId))) {
    removeIfEmpty(join(workspacePath, ...LEGACY_ROOT, agentId, "worklogs"));
    removeIfEmpty(join(workspacePath, ...LEGACY_ROOT, agentId));
  }
  return { moved, kept_tracked: keptTracked, kept_uncertain: null };
}

type LegacyWorkLog = { agentId: string; file: string; absolute: string; relative: string };

function legacyWorkLogs(workspacePath: string): LegacyWorkLog[] {
  const agentsRoot = join(workspacePath, ...LEGACY_ROOT);
  if (!existsSync(agentsRoot)) return [];
  const logs: LegacyWorkLog[] = [];
  for (const agent of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const directory = join(agentsRoot, agent.name, "worklogs");
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      logs.push({ agentId: agent.name, file: file.name, absolute: join(directory, file.name),
        relative: [...LEGACY_ROOT, agent.name, "worklogs", file.name].join("/") });
    }
  }
  return logs;
}

/** Workspace-relative paths git tracks under `.floe/agents`, or why that cannot be told. */
function trackedPaths(workspacePath: string): { paths: ReadonlySet<string> } | { reason: string } {
  const result = spawnSync("git", ["ls-files", "--full-name", "-z", "--", LEGACY_ROOT.join("/")],
    { cwd: workspacePath, encoding: "utf8", windowsHide: true });
  // No git on this machine, or not a repository: nothing here is tracked.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { paths: new Set() };
  if (result.status !== 0 && /not a git repository/i.test(result.stderr ?? "")) return { paths: new Set() };
  if (result.error || result.status !== 0) {
    return { reason: `git could not list tracked files: ${(result.stderr || String(result.error ?? "")).trim()}` };
  }
  const prefix = repositoryPrefix(workspacePath);
  if (prefix === null) return { reason: "git could not report where this workspace sits in its repository" };
  const paths = result.stdout.split("\0").filter(Boolean)
    .filter(path => path.startsWith(prefix))
    .map(path => path.slice(prefix.length));
  return { paths: new Set(paths) };
}

/** The workspace folder's path inside its repository, e.g. "" or "apps/site/". */
function repositoryPrefix(workspacePath: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd: workspacePath, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function removeIfEmpty(directory: string): void {
  if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
}
