import { describe, expect, it } from "vitest";
import type { ContextDiagnosticEvidence } from "../../bus-client/types.ts";
import {
  buildProblemReport,
  problemReportPaths,
  problemReportDraftFromEvent,
  redactDiagnosticValue,
  renderProblemReportMarkdown,
} from "./problemReport.ts";

const evidence: ContextDiagnosticEvidence = {
  schema: "floe.context-diagnostic.v1",
  generated_at: "2026-09-01T03:00:00.000Z",
  source: { component: "floe-bus", release_version: "0.1.29", build_sha: "abc123" },
  workspace: { workspace_id: "workspace:test" },
  context: {
    context_id: "ctx:test",
    workspace_id: "workspace:test",
    scope_id: null,
    parent_context_id: null,
    created_by_endpoint_id: "actor:operator",
    created_at: "2026-09-01T02:00:00.000Z",
    title: "A conversation",
    participants: ["actor:operator", "actor:floe"],
    endpoints: [
      { endpoint_id: "actor:operator", name: "Operator", agent_id: "operator", bridge_id: null, status: "idle" },
      { endpoint_id: "actor:floe", name: "Floe", agent_id: "floe", bridge_id: "bridge:main", status: "idle" },
    ],
  },
  events: [{
    event_id: "event:one",
    type: "message",
    workspace_id: "workspace:test",
    source_endpoint_id: "actor:operator",
    thread_id: "ctx:test",
    context_id: "ctx:test",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: "actor:floe" },
    content: { text: "Open C:\\Users\\alice\\secret.txt with sk-abcdefghijklmnopqrstuvwxyz" },
    response: { expected: true },
    metadata: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
    artefact_version_ids: [],
    created_at: "2026-09-01T02:01:00.000Z",
  }],
  deliveries: [{
    delivery_id: "delivery:one",
    endpoint_id: "actor:floe",
    trigger_event_id: "event:one",
    state: "failed",
    lease_expires_at: null,
    attempt_count: 1,
    last_error: "Contact alice@example.com from C:\\Users\\alice\\workspace",
    created_at: "2026-09-01T02:01:00.000Z",
    claimed_at: null,
  }],
  telemetry: [{
    telemetry_id: "telemetry:one",
    endpoint_id: "actor:floe",
    delivery_id: "delivery:one",
    kind: "runtime.failed",
    payload: { api_key: "not-for-export", url: "https://alice:password@example.com?token=secret" },
    created_at: "2026-09-01T02:02:00.000Z",
  }],
  runtime: { bridge: { online: false, runtime_adapter: "pi" } },
  operations: [{
    operation_id: "scope.plan.inspect",
    operation_version: "1",
    category: "scope",
    title: "Inspect Scope plan",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
  }],
  limits: {
    events: 30,
    deliveries: 30,
    telemetry: 100,
    events_truncated: false,
    deliveries_truncated: false,
    telemetry_truncated: false,
  },
};

describe("problem report export", () => {
  it("redacts nested secrets, credential patterns, identities, and user-home paths", () => {
    const redacted = redactDiagnosticValue({
      password: "plain secret",
      nested: {
        authorization: "Bearer abcdefghijklmnop",
        detail: "C:\\Users\\alice\\work alice@example.com sk-abcdefghijklmnopqrstuvwxyz OPENAI_API_KEY=another-secret",
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("<user-home>");
    expect(serialized).toContain("<email>");
    expect(serialized).not.toContain("plain secret");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("another-secret");
  });

  it("builds the exact versioned JSON and Markdown that may be shared", () => {
    const report = buildProblemReport({
      reportId: "problem:test",
      createdAt: "2026-09-01T03:00:00.000Z",
      draft: {
        expected: "Floe should finish",
        actual: "It stayed working",
        impact: "Token use was unclear",
        tentativeClassification: "possible-substrate-defect",
        floeInterpretation: "A delivery may be stuck",
        reproductionSafety: "isolated-workspace-first",
        includeConversation: true,
      },
      evidence,
      runtimeHealth: {
        state: "offline",
        label: "Floe needs attention",
        detail: "C:\\Users\\alice\\runtime stopped",
        technicalDetail: "Authorization: Bearer abcdefghijklmnop",
      },
      client: { component: "floe-app", release_version: "0.1.29", build_sha: "abc123" },
    });
    const json = JSON.stringify(report);
    const markdown = renderProblemReportMarkdown(report);

    expect(report.schema).toBe("floe.problem-report.v1");
    expect(report.sharing.transmitted).toBe(false);
    expect(json).not.toContain("not-for-export");
    expect(json).not.toContain("alice@example.com");
    expect(json).not.toContain("C:\\\\Users\\\\alice");
    expect(markdown).toContain("# Floe problem report");
    expect(markdown).toContain("saved locally; not transmitted");
    expect(markdown).toContain("Reproduce in an isolated workspace first");
    expect(problemReportPaths(report.report_id)).toEqual({
      markdown: ".floe/state/feedback/problem-test/report.md",
      json: ".floe/state/feedback/problem-test/report.json",
    });
  });

  it("excludes public conversation Events when the operator opts out", () => {
    const report = buildProblemReport({
      reportId: "problem:no-chat",
      createdAt: "2026-09-01T03:00:00.000Z",
      draft: {
        expected: "Expected",
        actual: "Actual",
        impact: "",
        tentativeClassification: "not-sure",
        floeInterpretation: "",
        reproductionSafety: "not-sure",
        includeConversation: false,
      },
      evidence,
      runtimeHealth: { state: "healthy", label: "Ready", detail: "Ready" },
      client: { component: "floe-app", release_version: null, build_sha: null },
    });
    expect(report.evidence.conversation_included).toBe(false);
    expect(report.evidence.bus.events).toEqual([]);
  });

  it("accepts a complete Floe semantic draft without trusting it as diagnostics", () => {
    const draft = problemReportDraftFromEvent({
      ...evidence.events[0]!,
      content: {
        text: "Report ready",
        data: {
          problem_report: {
            schema: "floe.problem-report-draft.v1",
            expected: "The work should stop",
            actual: "It kept running",
            impact: "Token use continued",
            tentative_classification: "possible-substrate-defect",
            interpretation: "A delivery may still be active",
            reproduction_safety: "isolated-workspace-first",
          },
        },
      },
    });
    expect(draft).toMatchObject({
      expected: "The work should stop",
      actual: "It kept running",
      tentativeClassification: "possible-substrate-defect",
      includeConversation: true,
    });
  });
});
