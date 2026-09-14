/**
 * Floe workspace tool — edit
 *
 * Performs precise search-and-replace edits on files in the workspace.
 * Supports fuzzy matching (line-ending tolerance, trailing whitespace tolerance,
 * Unicode/smart-quote normalisation). Produces a unified diff on success.
 * Workspace-scoped: all paths are resolved and validated within the workspace root.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type Edit,
} from "./edit-diff.js";
import type { ToolContext } from "./types.js";

export function createEditTool(ctx: ToolContext): AgentTool {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Edit a file in the workspace using exact text replacement. Each edit specifies " +
      "an `old_text` to find and a `new_text` to replace it with. The old_text must match " +
      "a unique region of the file. Supports minor whitespace and Unicode tolerance. " +
      "Use multiple edits in one call for multiple non-overlapping changes to the same file. " +
      "Returns the diff, SHA-256 and byte count of the written file for exact content references. " +
      "Paths are relative to the workspace root.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to workspace root" }),
      edits: Type.Array(
        Type.Object({
          old_text: Type.String({ description: "Exact text to find (must be unique in the file)" }),
          new_text: Type.String({ description: "Replacement text" }),
        }),
        { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping edits." }
      ),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const filePath = String(params?.path ?? "");
      const rawEdits = params?.edits as Array<{ old_text?: string; new_text?: string; oldText?: string; newText?: string }> | undefined;

      if (!filePath) {
        enrichToolActivity(ctx, toolCallId, "edit — no path provided", true, [], startTime);
        return { content: [{ type: "text", text: "Error: path is required." }], details: { ok: false } };
      }

      // Normalise edit field names (accept both old_text/new_text and oldText/newText)
      const edits: Edit[] = [];
      if (Array.isArray(rawEdits)) {
        for (const e of rawEdits) {
          const oldText = e.old_text ?? e.oldText ?? "";
          const newText = e.new_text ?? e.newText ?? "";
          edits.push({ oldText: String(oldText), newText: String(newText) });
        }
      }

      if (edits.length === 0) {
        enrichToolActivity(ctx, toolCallId, "edit — no edits provided", true, [], startTime);
        return { content: [{ type: "text", text: "Error: edits array must contain at least one replacement." }], details: { ok: false } };
      }

      const resolved = safeWorkspacePath(ctx.workspaceRoot, filePath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `edit ${filePath} — path rejected`, true, [], startTime);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      try {
        const rawContent = readFileSync(resolved.path, "utf-8");
        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);

        const { baseContent, newContent } = applyEditsToNormalizedContent(
          normalizedContent,
          edits,
          filePath,
        );

        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        const bytes = Buffer.from(finalContent, "utf-8");
        writeFileSync(resolved.path, bytes);
        const identity = { digest: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, size_bytes: bytes.length };

        const diffResult = generateDiffString(baseContent, newContent);
        const relPath = relative(ctx.workspaceRoot, resolved.path);
        const summary = `edit ${relPath} (${edits.length} replacement${edits.length > 1 ? "s" : ""})`;
        enrichToolActivity(ctx, toolCallId, summary, false, [relPath], startTime);

        return {
          content: [
            { type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.\nWritten file snapshot: ${JSON.stringify(identity)}` },
            { type: "text", text: diffResult.diff },
          ],
          details: { ok: true, diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine, ...identity }
        };
      } catch (err: any) {
        const relPath = relative(ctx.workspaceRoot, resolved.path);
        const isMatchError = err.message?.includes("Could not find") ||
                             err.message?.includes("occurrences") ||
                             err.message?.includes("overlap") ||
                             err.message?.includes("empty");
        const msg = err.code === "ENOENT"
          ? `File not found: '${filePath}'`
          : err.message;
        enrichToolActivity(ctx, toolCallId, `edit ${filePath} — ${isMatchError ? "match failed" : err.code ?? "error"}`, true, [relPath], startTime);
        return { content: [{ type: "text", text: msg }], details: { ok: false } };
      }
    }
  };
}

function enrichToolActivity(
  ctx: ToolContext,
  toolCallId: string,
  summary: string,
  isError: boolean,
  filesTouched: string[],
  startTime: number
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find((t) => t.call_id === toolCallId);
  if (entry) {
    entry.summary = summary;
    entry.is_error = isError;
    entry.files_touched = filesTouched;
    entry.duration_ms = Date.now() - startTime;
  }
}
