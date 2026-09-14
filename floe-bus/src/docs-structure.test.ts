import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Standing regression check: the set of standing documents is closed.
// New knowledge routes into living documents, not new files:
//   - terminology/invariants -> edit CONTEXT.md in place
//   - lasting decisions      -> new ADR in docs/adr/ (append-only, NNNN-slug.md)
//   - slice plans            -> docs/plans/ (disposable; delete once executed)
// A new top-level doc fails this test until the operator approves a new standing
// document and it is registered here with its tier. A registered doc that no
// longer exists fails too — delete its entry when the doc is deleted.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// repo-relative path -> tier (canonical | working | historical | operational)
const REGISTERED: Record<string, string> = {
  "MISSION.md": "canonical (why the substrate exists)",
  "CLAUDE.md": "canonical (entry pointer to AGENTS.md)",
  "AGENTS.md": "canonical",
  "CONTEXT.md": "canonical",
  "PRODUCT.md": "canonical",
  "README.md": "operational",
  "THIRD_PARTY_NOTICES.md": "operational (dependency licence notices)",
  "docs/ROADMAP.md": "working",
  "docs/tech-debt.md": "working (removal queue)",
  "docs/floe_thought_log.md": "working (owner's direction log)",
  "docs/contracts.md": "working",
  "docs/substrate-semantics.md": "working",
  "docs/floe-instruction-layering.md": "working",
  "docs/self-hosting-continuity.md": "working",
  "docs/followup-extension-self-install.md": "working",
  "docs/extension-substrate-slice-prd.md": "working",
  "docs/floe-substrate-extension-pulse-prd.md": "working"
};

// Point-in-time directories under docs/ are free-form; their READMEs declare them
// historical. New subdirectories of docs/ are NOT free-form — register them here
// only with operator approval.
const FREE_FORM_DOC_DIRS = new Set([
  "plans",
  "implementation-reviews",
  "evidence",
  "qa",
  "reference", // non-markdown reference assets
  "architecture", // living architecture graph (operator-approved, standing — docs/architecture/overview.md)
  "guide" // user documentation (operator-approved, standing — docs/guide/README.md)
]);

const ADR_NAME = /^\d{4}-[a-z0-9-]+\.md$/;

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
      "new standing doc — does this belong in CONTEXT.md, a new ADR, or docs/plans/? " +
        "Register it here only if the operator approved a new standing document"
    ).toEqual([]);
    const missing = Object.keys(REGISTERED).filter(
      (path) => !existsSync(join(REPO_ROOT, path))
    );
    expect(missing, "registered doc no longer exists — delete its entry").toEqual([]);
  });

  it("docs/adr/ is an append-only decision log with NNNN-slug names", () => {
    const offenders = readdirSync(join(REPO_ROOT, "docs", "adr")).filter(
      (entry) => !ADR_NAME.test(entry)
    );
    expect(offenders, "ADR files must be named NNNN-kebab-slug.md").toEqual([]);
  });

  it("docs/ subdirectories are explicitly accounted for", () => {
    const unknown = readdirSync(join(REPO_ROOT, "docs")).filter((entry) => {
      if (!statSync(join(REPO_ROOT, "docs", entry)).isDirectory()) return false;
      return entry !== "adr" && !FREE_FORM_DOC_DIRS.has(entry);
    });
    expect(
      unknown,
      "new docs/ subdirectory — register it in FREE_FORM_DOC_DIRS only with operator approval"
    ).toEqual([]);
  });
});
