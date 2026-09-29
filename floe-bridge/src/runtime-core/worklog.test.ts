import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendWorkLog } from "./worklog.js";
import type { WorkLogEntry } from "./worklog.js";

describe("Work Logs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "floe-worklog-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
    return {
      runtime_turn_id: "turn-001",
      agent_id: "floe",
      started_at: "2025-01-15T10:00:00Z",
      ended_at: "2025-01-15T10:01:30Z",
      trigger_type: "message",
      scope_id: "research",
      thread_id: "thread:ws1:main",
      delivery_id: "delivery-001",
      delivered_events: [
        {
          event_id: "evt-001",
          type: "message",
          source_endpoint_id: "actor:ws1:operator",
          text: "Hello agent",
        },
      ],
      visible_output: "I processed your request successfully.",
      tool_activity: [
        {
          name: "read_file",
          call_id: "tc-001",
          summary: "Read config.json",
          files_touched: ["config.json"],
          duration_ms: 45,
        },
      ],
      emitted_events: [
        {
          type: "message",
          destination: "actor:ws1:operator",
          text_preview: "Done processing your request",
          response_expected: false,
        },
      ],
      lifecycle_outcome: "completed",
      ...overrides,
    };
  }

  function readLog(agentId = "floe", date = "2025-01-15"): string {
    const filePath = join(
      tempDir,
      ".floe",
      "state",
      "agents",
      agentId,
      "worklogs",
      `${date}.md`,
    );
    return readFileSync(filePath, "utf-8");
  }

  it("creates directory and file", () => {
    appendWorkLog(tempDir, makeEntry());
    const filePath = join(
      tempDir,
      ".floe",
      "state",
      "agents",
      "floe",
      "worklogs",
      "2025-01-15.md",
    );
    expect(existsSync(filePath)).toBe(true);
  });

  it("renders unscoped work logs without inventing Default Scope", () => {
    appendWorkLog(tempDir, makeEntry({ scope_id: null }));

    const logPath = join(tempDir, ".floe", "state", "agents", "floe", "worklogs", "2025-01-15.md");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("**Scope:** (unscoped)");
  });

  it("contains turn header", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("## Turn turn-001");
  });

  it("contains timestamps", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("2025-01-15T10:00:00Z");
    expect(content).toContain("2025-01-15T10:01:30Z");
  });

  it("contains trigger and thread info", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("message");
    expect(content).toContain("thread:ws1:main");
  });

  it("contains the derived Scope", () => {
    appendWorkLog(tempDir, makeEntry({ scope_id: "research" }));
    const content = readLog();
    expect(content).toContain("**Scope:** research");
  });

  it("contains delivered events", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("[message]");
    expect(content).toContain("actor:ws1:operator");
    expect(content).toContain("Hello agent");
  });

  it("contains visible output", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("I processed your request successfully.");
  });

  it("handles empty visible output", () => {
    appendWorkLog(tempDir, makeEntry({ visible_output: "" }));
    const content = readLog();
    expect(content).toContain("(no visible output)");
  });

  it("contains tool activity", () => {
    appendWorkLog(
      tempDir,
      makeEntry({
        tool_activity: [
          {
            name: "read_file",
            call_id: "tc-001",
            summary: "Read config.json",
            files_touched: ["config.json"],
            duration_ms: 45,
          },
          {
            name: "write_file",
            call_id: "tc-002",
            summary: "Wrote output",
            is_error: true,
            duration_ms: 12,
          },
        ],
      }),
    );
    const content = readLog();
    expect(content).toContain("read_file");
    expect(content).toContain("Read config.json");
    expect(content).toContain("write_file");
    expect(content).toContain("❌");
  });

  it("contains files_touched", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("📄 config.json");
  });

  it("contains emitted events", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("[message]");
    expect(content).toContain("actor:ws1:operator");
    expect(content).toContain("Done processing your request");
  });

  it("handles no emitted events", () => {
    appendWorkLog(tempDir, makeEntry({ emitted_events: [] }));
    const content = readLog();
    expect(content).toContain("(none — no explicit communication)");
  });

  it("separates activity from communication", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();

    const toolIdx = content.indexOf("### Tool activity");
    const emitIdx = content.indexOf("### Emitted events");

    expect(toolIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeLessThan(emitIdx);

    // Tool activity section contains tool info, not emitted event info
    const toolSection = content.slice(toolIdx, emitIdx);
    expect(toolSection).toContain("read_file");

    // Emitted events section contains communication info
    const emitSection = content.slice(emitIdx);
    expect(emitSection).toContain("Done processing your request");
  });

  it("contains lifecycle outcome", () => {
    appendWorkLog(tempDir, makeEntry());
    const content = readLog();
    expect(content).toContain("completed");
  });

  it("multiple appends accumulate in same file", () => {
    appendWorkLog(tempDir, makeEntry({ runtime_turn_id: "turn-001" }));
    appendWorkLog(tempDir, makeEntry({ runtime_turn_id: "turn-002" }));
    const content = readLog();
    expect(content).toContain("## Turn turn-001");
    expect(content).toContain("## Turn turn-002");
  });
});
