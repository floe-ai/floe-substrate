import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The event ingress capability must never be reachable from a test. A test that
 * held it could call submitEvent directly and write any event as any endpoint,
 * bypassing every route and authority check — fabricating state no Actor could
 * produce. That is exactly how a past "live gate" faked a pending request.
 *
 * Tests write events only through real routes. This guard fails loudly if any
 * test file imports the capability or names it, so a new fake cannot be written.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const SCANNED_SOURCE_DIRS = [
  join(REPO_ROOT, "floe-bus", "src"),
  join(REPO_ROOT, "floe-bridge", "src"),
  join(REPO_ROOT, "floe-cli", "src"),
  join(REPO_ROOT, "floe-native-authority", "src"),
];

const GUARD_FILE = fileURLToPath(import.meta.url);

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "names the ingress capability", pattern: /\bEVENT_INGRESS_CAPABILITY\b/ },
  { name: "imports the ingress capability module", pattern: /from\s+["'][^"']*\/event-ingress(\.js)?["']/ },
];

function collectTestFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      files.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.ts") && full !== GUARD_FILE) {
      files.push(full);
    }
  }
  return files;
}

describe("event ingress capability is unreachable from tests", () => {
  it("keeps test files free of the ingress capability", () => {
    const testFiles = SCANNED_SOURCE_DIRS.flatMap((dir) => collectTestFiles(dir));
    const violations: string[] = [];
    for (const file of testFiles) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { name, pattern } of FORBIDDEN) {
          if (pattern.test(line)) {
            violations.push(`${relative(REPO_ROOT, file)}:${index + 1} [${name}] ${line.trim()}`);
          }
        }
      });
    }
    expect(
      violations,
      `A test reached for the event ingress capability. Write events through a real route instead:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
