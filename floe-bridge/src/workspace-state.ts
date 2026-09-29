import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `.floe/state` holds what Floe writes while it runs: local, never committed.
 * A workspace may not have committed the template's ignore file, so one that
 * ignores everything (itself included) is written when none exists. Writing
 * runtime output therefore never shows up in the person's git status.
 */
export function workspaceStateDirectory(workspacePath: string, ...segments: string[]): string {
  const root = join(workspacePath, ".floe", "state");
  mkdirSync(root, { recursive: true });
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n", "utf8");
  const directory = join(root, ...segments);
  mkdirSync(directory, { recursive: true });
  return directory;
}
