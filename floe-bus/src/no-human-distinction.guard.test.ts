import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { RUNTIME_PROFILE_CONTENT_SCHEMA } from "./runtime-profile-operations.js";

/**
 * The substrate carries no human/agent distinction. An Actor is an Actor; who
 * or what backs its turns is selected by adapter_id and must never become a
 * type, field, status, value, or role marker that branches on person-ness.
 *
 * This has been reintroduced repeatedly, always under a fresh word (human,
 * operator, person, attended, interactive, manual). A written rule did not
 * hold, so this guard fails loudly the moment the concept returns - by its
 * structural shape, not one spelling. If it trips, the fix is to remove the
 * distinction, not to rename it or add an allowlist entry for it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// Production substrate source. Tests may name the concept to prove it is
// rejected, so *.test.ts is scanned only for the closed-set structural slots
// (below), not the vocabulary sweep.
const SCANNED_SOURCE_DIRS = [
  join(REPO_ROOT, "floe-bus", "src"),
  join(REPO_ROOT, "floe-bridge", "src"),
  join(REPO_ROOT, "floe-cli", "src"),
  join(REPO_ROOT, "floe-native-authority", "src"),
];

const GUARD_FILE = fileURLToPath(import.meta.url);

/** Structural expressions of the human/agent distinction, not bare words. */
const CONCEPT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "person-backed lifecycle status (waiting_<person>)",
    pattern: /\bwaiting[_-]?(human|person|user|operator|manual|attended|interactive)\b/i,
  },
  {
    name: "person-backed identifier (<person>_backed/actor/runtime/attention)",
    pattern: /\b(human|person|attended|interactive|manual)[_-]?(backed|backing|actor|runtime|endpoint|attention)\b/i,
  },
  {
    name: "person predicate (isHuman / requires_human)",
    pattern: /\b(is|requires?)[_-]?(human|person)\b/i,
  },
  {
    name: "endpoint metadata role marker (human discovery)",
    pattern: /(\bmetadata\b[^\n]*\brole["']?\s*[:=]=?\s*["'](operator|human|person)["']|\bmetadata\.role\b)/i,
  },
];

/** backing_kind must never carry a person-backing value. */
const PERSONISH = /\b(human|person|attended|interactive|manual)\b/i;

function collectTsFiles(dir: string): string[] {
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
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && full !== GUARD_FILE) {
      files.push(full);
    }
  }
  return files;
}

describe("substrate carries no human/agent distinction", () => {
  it("keeps runtime backing_kind free of any person-backing value", () => {
    const backingKind = (RUNTIME_PROFILE_CONTENT_SCHEMA.properties as Record<string, { enum?: readonly string[] }>).backing_kind;
    const values = backingKind?.enum ?? [];
    expect(values.length).toBeGreaterThan(0);
    const personish = values.filter((value) => PERSONISH.test(value));
    expect(personish, `backing_kind must not encode person-backing: ${personish.join(", ")}`).toEqual([]);
  });

  it("keeps substrate source free of the human/agent distinction", () => {
    const productionFiles = SCANNED_SOURCE_DIRS
      .flatMap((dir) => collectTsFiles(dir))
      .filter((file) => !file.endsWith(".test.ts"));

    const violations: string[] = [];
    for (const file of productionFiles) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { name, pattern } of CONCEPT_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${relative(REPO_ROOT, file)}:${index + 1} [${name}] ${line.trim()}`);
          }
        }
        if (/\bbacking[_-]?kind\b/i.test(line) && PERSONISH.test(line)) {
          violations.push(`${relative(REPO_ROOT, file)}:${index + 1} [backing_kind person value] ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `The human/agent distinction reappeared. Remove it - do not rename it:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
