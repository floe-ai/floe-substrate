/**
 * Floe Runtime Core — Agent Work Log (Actor Diary)
 *
 * Writes curated, human-readable Markdown work logs to the agent's directory.
 * Each processing cycle appends a section to the day's log file.
 *
 * This is the committed agent diary / audit artefact — NOT raw telemetry.
 * It is intended for:
 *   - Human-auditable activity history
 *   - Actor diary / memory input
 *   - Project-readable record of agent activity
 *
 * Must NOT contain: tokens, secrets, credentials, raw telemetry dumps, or
 * excessive unbounded stream content. Summarise instead.
 *
 * Raw runtime telemetry (full payloads, usage, lifecycle) remains in bus
 * telemetry storage, separate from this committed diary.
 *
 * Path: .floe/agents/<agent_id>/worklogs/YYYY-MM-DD.md
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export type WorkLogEntry = {
  runtime_turn_id: string;
  agent_id: string;
  started_at: string;
  ended_at: string;
  trigger_type: string;
  scope_id: string | null;
  thread_id: string;
  delivery_id: string;
  delivered_events: WorkLogEvent[];
  visible_output: string | null;
  tool_activity: WorkLogToolEntry[];
  emitted_events: WorkLogEmitEntry[];
  lifecycle_outcome: string;
};

export type WorkLogEvent = {
  event_id: string;
  type: string;
  source_endpoint_id: string;
  text: string;
};

export type WorkLogToolEntry = {
  name: string;
  call_id?: string;
  lifecycle?: "started" | "completed" | "failed";
  provenance?: string;
  summary?: string;
  is_error?: boolean;
  arguments?: Record<string, unknown>;
  result_type?: "success" | "failure";
  result_value?: string;
  result_code?: string;
  files_touched?: string[];
  duration_ms?: number;
};

export type WorkLogEmitEntry = {
  type: string;
  destination: string;
  text_preview: string;
  response_expected: boolean;
};

/**
 * Append a work-log entry for a completed processing cycle.
 * Creates the directory structure if it doesn't exist.
 */
export function appendWorkLog(workspaceLocator: string, entry: WorkLogEntry): void {
  const date = entry.started_at.slice(0, 10); // YYYY-MM-DD
  const dir = join(workspaceLocator, ".floe", "agents", entry.agent_id, "worklogs");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${date}.md`);
  const markdown = renderWorkLogEntry(entry);
  appendFileSync(filePath, markdown, "utf-8");
}

function renderWorkLogEntry(entry: WorkLogEntry): string {
  const lines: string[] = [];

  lines.push(`## Turn ${entry.runtime_turn_id}`);
  lines.push("");
  lines.push(`**Started:** ${entry.started_at}`);
  lines.push(`**Ended:** ${entry.ended_at}`);
  lines.push(`**Trigger:** ${entry.trigger_type}`);
  lines.push(`**Scope:** ${entry.scope_id ?? "(unscoped)"}`);
  lines.push(`**Thread:** ${entry.thread_id}`);
  lines.push(`**Delivery:** ${entry.delivery_id}`);
  lines.push("");

  // Delivered events
  lines.push("### Delivered events");
  if (entry.delivered_events.length === 0) {
    lines.push("- (none)");
  } else {
    for (const evt of entry.delivered_events) {
      const preview = evt.text.length > 120 ? evt.text.slice(0, 120) + "…" : evt.text;
      lines.push(`- [${evt.type}] from ${evt.source_endpoint_id}: ${preview}`);
    }
  }
  lines.push("");

  // Visible output (work log only)
  lines.push("### Runtime notes / visible output");
  if (entry.visible_output && entry.visible_output.trim()) {
    lines.push("");
    lines.push(entry.visible_output.trim());
  } else {
    lines.push("(no visible output)");
  }
  lines.push("");

  // Tool activity
  lines.push("### Tool activity");
  if (entry.tool_activity.length === 0) {
    lines.push("- (none)");
  } else {
    for (const tool of entry.tool_activity) {
      const status = tool.is_error ? " ❌" : "";
      const summary = tool.summary ? `: ${tool.summary}` : "";
      const duration = tool.duration_ms != null ? ` (${tool.duration_ms}ms)` : "";
      const lifecycle = tool.lifecycle ? ` [${tool.lifecycle}]` : "";
      lines.push(`- ${tool.name}${lifecycle}${summary}${duration}${status}`);
      if (tool.files_touched && tool.files_touched.length > 0) {
        for (const file of tool.files_touched) {
          lines.push(`  - 📄 ${file}`);
        }
      }
    }
  }
  lines.push("");

  // Emitted events
  lines.push("### Emitted events");
  if (entry.emitted_events.length === 0) {
    lines.push("- (none — no explicit communication)");
  } else {
    for (const emit of entry.emitted_events) {
      const preview = emit.text_preview.length > 80 ? emit.text_preview.slice(0, 80) + "…" : emit.text_preview;
      lines.push(`- [${emit.type}] → ${emit.destination}: ${preview}`);
    }
  }
  lines.push("");

  // Outcome
  lines.push(`### Outcome`);
  lines.push(`${entry.lifecycle_outcome}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  return lines.join("\n");
}
