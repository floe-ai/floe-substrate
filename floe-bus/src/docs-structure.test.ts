import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Standing regression check: the set of standing documents is closed.
// New knowledge routes into living documents, not new files:
//   - what Floe is, terms and rules -> docs/design/ (see docs/design/README.md)
//   - decisions              -> the design document they concern
// A new top-level doc fails this test until the operator approves a new standing
// document and it is registered here with its tier. A registered doc that no
// longer exists fails too — delete its entry when the doc is deleted.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// repo-relative path -> tier (canonical | working | historical | operational)
const REGISTERED: Record<string, string> = {
  "CLAUDE.md": "canonical (entry pointer to AGENTS.md)",
  "AGENTS.md": "canonical",
  "README.md": "operational",
  "THIRD_PARTY_NOTICES.md": "operational (dependency licence notices)",
  "docs/README.md": "canonical (how documentation works, operator-approved 2026-10-08)"
};

// New subdirectories of docs/ are NOT free-form — register them here only with
// operator approval. History lives in git, not in docs/.
const FREE_FORM_DOC_DIRS = new Set([
  "reference", // non-markdown reference assets
  "architecture", // living architecture graph (operator-approved, standing — docs/architecture/overview.md)
  "guide", // user documentation (operator-approved, standing — docs/guide/README.md)
  "contributing", // working on Floe itself (operator-approved 2026-10-08)
  "surfaces", // building products on Floe (operator-approved 2026-10-08)
  "design" // what Floe is and is meant to be (operator-approved 2026-10-08)
]);

function topLevelMarkdown(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((entry) => entry.endsWith(".md"))
    .filter((entry) => statSync(join(REPO_ROOT, dir, entry)).isFile())
    .map((entry) => (dir === "." ? entry : `${dir}/${entry}`));
}

describe("docs structure lint", () => {
  it("standing documents are a closed, registered set", () => {
    const found = [...topLevelMarkdown("."), ...topLevelMarkdown("docs")];
    const unregistered = found.filter((path) => !(path in REGISTERED));
    expect(
      unregistered,
      "new standing doc — does this belong in docs/design/? " +
        "Register it here only if the operator approved a new standing document"
    ).toEqual([]);
    const missing = Object.keys(REGISTERED).filter(
      (path) => !existsSync(join(REPO_ROOT, path))
    );
    expect(missing, "registered doc no longer exists — delete its entry").toEqual([]);
  });

  it("docs/ subdirectories are explicitly accounted for", () => {
    const unknown = readdirSync(join(REPO_ROOT, "docs")).filter((entry) => {
      if (!statSync(join(REPO_ROOT, "docs", entry)).isDirectory()) return false;
      return !FREE_FORM_DOC_DIRS.has(entry);
    });
    expect(
      unknown,
      "new docs/ subdirectory — register it in FREE_FORM_DOC_DIRS only with operator approval"
    ).toEqual([]);
  });
});
