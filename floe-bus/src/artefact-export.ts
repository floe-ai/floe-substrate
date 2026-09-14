import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtefactStore } from "./artefacts.js";
import { resolveArtefactVersionContent } from "./artefact-content-resolver.js";
import { resolveWithinRoot } from "./fs/resolveWithinRoot.js";
import { refusal, requiredAction, requireWorkspaceAuthorityId, type SemanticOperationDefinition } from "./operations.js";

export const EXPORT_ARTEFACT_VERSION_OPERATION_ID = "artefact.version.export";

export class ArtefactExportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type ArtefactExportResult = {
  artefact_version_id: string;
  destination_path: string;
  digest: { algorithm: "sha256"; value: string };
  size_bytes: number;
  created: boolean;
};

/** Materialise verified immutable content; an exported file is not a new version. */
export function exportArtefactVersion(input: {
  store: ArtefactStore; workspace_id: string; workspace_locator: string;
  artefact_version_id: string; destination_path: string;
}): ArtefactExportResult {
  const path = input.destination_path.replace(/\\/g, "/");
  // Reject ambiguous Windows paths on every host, including alternate streams.
  if (path.split("/").some(part => !part || part === "." || part === ".."
    || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new ArtefactExportError("artefact_export_path_invalid", "Choose an unambiguous relative file path inside this Workspace.");
  }
  const content = resolveArtefactVersionContent(input);
  let destination: string;
  try { destination = resolveWithinRoot(input.workspace_locator, path); }
  catch { throw new ArtefactExportError("artefact_export_path_invalid", "The export destination must remain inside this Workspace."); }
  const result = (created: boolean): ArtefactExportResult => ({
    artefact_version_id: content.artefact_version_id, destination_path: path,
    digest: content.digest, size_bytes: content.size_bytes, created,
  });
  function existingMatches(): boolean {
    // Never follow a destination link, even to another file inside the Workspace.
    let stat;
    try { stat = lstatSync(join(input.workspace_locator, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== content.size_bytes
      || createHash("sha256").update(readFileSync(destination)).digest("hex") !== content.digest.value) {
      throw new ArtefactExportError("artefact_export_destination_exists", "The destination already contains something different. Choose another path; existing content was preserved.");
    }
    return true;
  }
  if (existingMatches()) return result(false);
  mkdirSync(dirname(destination), { recursive: true });
  // Recheck newly created parents through the existing Workspace containment contract.
  destination = resolveWithinRoot(input.workspace_locator, path);
  const temporary = join(dirname(destination), `.floe-export-${randomUUID()}.tmp`);
  let staged = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    staged = true;
    try { writeFileSync(fd, content.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // A hard link publishes complete bytes atomically and cannot replace a target.
    // A retry after publication can verify the same destination without rewriting it.
    try { linkSync(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && existingMatches()) return result(false);
      throw error;
    }
    return result(true);
  } finally {
    if (staged && existsSync(temporary)) unlinkSync(temporary);
  }
}

export function exportArtefactVersionOperation(
  store: ArtefactStore, workspaceLocator: (workspaceId: string) => string | null,
): SemanticOperationDefinition<{ destination_path: string }, ArtefactExportResult> {
  return {
    operation_id: EXPORT_ARTEFACT_VERSION_OPERATION_ID, operation_version: "1",
    authority_boundary_kinds: ["workspace"], category: "artefacts",
    title: "Export saved version",
    description: "Save the exact retained bytes of this ArtefactVersion to a relative file path in this Workspace. Verifies content identity, creates missing folders, and preserves existing different content. An identical existing file is reused. This does not publish on the internet or create a new ArtefactVersion. Current Policy determines whether approval is required.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [EXPORT_ARTEFACT_VERSION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended", "brokered"] },
    target: { resource_kinds: ["artefact_version"], expected_revision: "not_applicable" },
    describe_effect: (context, input) => `Save exact version ${context.target!.ref.id} to ${JSON.stringify(input.destination_path)} in this Workspace. Preserve existing different content. No internet publication.`,
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["destination_path"], properties: {
      destination_path: { type: "string", minLength: 1, description: "Relative destination file path within this Workspace. Existing different content is never overwritten." },
    } } },
    result: { version: "1", schema: { type: "object", additionalProperties: false,
      required: ["artefact_version_id", "destination_path", "digest", "size_bytes", "created"], properties: {
        artefact_version_id: { type: "string" }, destination_path: { type: "string" },
        digest: { type: "object", additionalProperties: false, required: ["algorithm", "value"], properties: {
          algorithm: { const: "sha256" }, value: { type: "string", pattern: "^[a-f0-9]{64}$" },
        } }, size_bytes: { type: "integer", minimum: 0 }, created: { type: "boolean" },
      } } },
    handler: (context, input) => {
      try {
        const workspace_id = requireWorkspaceAuthorityId(context.authority);
        const workspace_locator = workspaceLocator(workspace_id);
        if (!workspace_locator) throw new ArtefactExportError("artefact_export_workspace_unavailable", "This Workspace has no available folder on this host.");
        return { state: "completed", result: exportArtefactVersion({ store, workspace_id, workspace_locator,
          artefact_version_id: context.target!.ref.id, destination_path: input.destination_path }) };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "artefact_export_failed";
        const message = error instanceof Error ? error.message : "The saved version could not be exported.";
        return { state: "refused", refusal: refusal(code, message, false,
          requiredAction("inspect_export", "Inspect export", "Inspect the exact saved version and destination before retrying. Existing different content will not be overwritten.")) };
      }
    },
  };
}
