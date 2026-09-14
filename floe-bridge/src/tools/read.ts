/**
 * Floe workspace tool — read
 *
 * Reads file contents from the workspace. Supports line range selection.
 * Workspace-scoped: all paths are resolved and validated within the workspace root.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import { truncateOutput } from "./truncation.js";
import type { ToolContext } from "./types.js";

export function createReadTool(ctx: ToolContext): AgentTool {
  return {
    name: "read",
    label: "Read File",
    description:
      "Read the contents of a file in the workspace. Returns the file text with line numbers. " +
      "Use `start_line` and `end_line` to read a specific range. " +
      "Includes SHA-256 and byte count of the whole file snapshot for exact content references. " +
      "Paths are relative to the workspace root. Absolute paths within the workspace are also accepted.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to workspace root" }),
      start_line: Type.Optional(Type.Number({ description: "First line to read (1-based, inclusive)" })),
      end_line: Type.Optional(Type.Number({ description: "Last line to read (1-based, inclusive)" })),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const filePath = String(params?.path ?? "");

      const resolved = safeWorkspacePath(ctx.workspaceRoot, filePath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `read ${filePath} — path rejected`, true, [], startTime);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      try {
        const stat = statSync(resolved.path);
        if (!stat.isFile()) {
          const msg = `'${filePath}' is not a file (it is a ${stat.isDirectory() ? "directory" : "other"}).`;
          enrichToolActivity(ctx, toolCallId, `read ${filePath} — not a file`, true, [], startTime);
          return { content: [{ type: "text", text: msg }], details: { ok: false } };
        }

        const bytes = readFileSync(resolved.path);
        const raw = bytes.toString("utf-8");
        const identity = { digest: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, size_bytes: bytes.length };
        const allLines = raw.split("\n");
        const totalLines = allLines.length;

        const startLine = Math.max(1, params?.start_line ?? 1);
        const endLine = Math.min(totalLines, params?.end_line ?? totalLines);

        const selectedLines = allLines.slice(startLine - 1, endLine);
        const numbered = selectedLines.map((line, i) => `${startLine + i}. ${line}`).join("\n");

        const truncated = truncateOutput(numbered);
        const relPath = relative(ctx.workspaceRoot, resolved.path);
        const rangeLabel = params?.start_line || params?.end_line ? `:${startLine}-${endLine}` : "";
        const summary = `read ${relPath}${rangeLabel} (${totalLines} lines)`;

        enrichToolActivity(ctx, toolCallId, summary, false, [relPath], startTime);

        return {
          content: [{ type: "text", text: `Whole-file snapshot: ${JSON.stringify(identity)}\n\n${truncated.text}` }],
          details: { ok: true, lines: totalLines, truncated: truncated.truncated, ...identity }
        };
      } catch (err: any) {
        const msg = err.code === "ENOENT"
          ? `File not found: '${filePath}'`
          : `Error reading '${filePath}': ${err.message}`;
        enrichToolActivity(ctx, toolCallId, `read ${filePath} — ${err.code ?? "error"}`, true, [], startTime);
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
