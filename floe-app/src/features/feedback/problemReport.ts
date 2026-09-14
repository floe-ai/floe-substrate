import type { ContextDiagnosticEvidence, EventEnvelope } from "../../bus-client/types.ts";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { readWorkspaceFile, writeWorkspaceFile } from "../../fs/workspaceFs.ts";
import type { RuntimeHealth } from "../../runtime/health.ts";

export type ProblemClassification =
  | "not-sure"
  | "workspace-or-configuration"
  | "missing-capability"
  | "possible-substrate-defect"
  | "product-usability";

export type ReproductionSafety = "not-sure" | "safe-in-originating-workspace" | "isolated-workspace-first";

export type ProblemReportDraft = {
  expected: string;
  actual: string;
  impact: string;
  tentativeClassification: ProblemClassification;
  floeInterpretation: string;
  reproductionSafety: ReproductionSafety;
  includeConversation: boolean;
};

const PROBLEM_CLASSIFICATIONS = new Set<ProblemClassification>([
  "not-sure",
  "workspace-or-configuration",
  "missing-capability",
  "possible-substrate-defect",
  "product-usability",
]);
const REPRODUCTION_SAFETY = new Set<ReproductionSafety>([
  "not-sure",
  "safe-in-originating-workspace",
  "isolated-workspace-first",
]);

/** A Floe-authored semantic draft. Diagnostics remain app-owned and operator-reviewed. */
export function problemReportDraftFromEvent(event: EventEnvelope): Partial<ProblemReportDraft> | null {
  const data = event.content?.["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const candidate = (data as Record<string, unknown>)["problem_report"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (value["schema"] !== "floe.problem-report-draft.v1") return null;
  const expected = typeof value["expected"] === "string" ? value["expected"].trim() : "";
  const actual = typeof value["actual"] === "string" ? value["actual"].trim() : "";
  if (!expected || !actual) return null;
  const classification = String(value["tentative_classification"] ?? "not-sure") as ProblemClassification;
  const safety = String(value["reproduction_safety"] ?? "isolated-workspace-first") as ReproductionSafety;
  return {
    expected,
    actual,
    impact: typeof value["impact"] === "string" ? value["impact"].trim() : "",
    tentativeClassification: PROBLEM_CLASSIFICATIONS.has(classification) ? classification : "not-sure",
    floeInterpretation: typeof value["interpretation"] === "string" ? value["interpretation"].trim() : "",
    reproductionSafety: REPRODUCTION_SAFETY.has(safety) ? safety : "isolated-workspace-first",
    includeConversation: true,
  };
}

export type ProblemReportReceipt = {
  report_id: string;
  created_at: string;
  expected: string;
  markdown_path: string;
  json_path: string;
  status: "saved-locally";
};

type ProblemReportIndex = {
  schema: "floe.problem-report-index.v1";
  reports: ProblemReportReceipt[];
};

export type ClientBuildIdentity = {
  component: "floe-app";
  release_version: string | null;
  build_sha: string | null;
};

export type FloeProblemReport = {
  schema: "floe.problem-report.v1";
  report_id: string;
  created_at: string;
  sharing: {
    transmitted: false;
    operator_preview_required: true;
  };
  problem: {
    expected: string;
    actual: string;
    impact: string | null;
    tentative_classification: ProblemClassification;
    floe_interpretation: string | null;
    reproduction_safety: ReproductionSafety;
  };
  evidence: {
    app: {
      source: ClientBuildIdentity;
      runtime_health: RuntimeHealth;
    };
    bus: ContextDiagnosticEvidence;
    conversation_included: boolean;
  };
  redaction: {
    policy: "floe.diagnostic-redaction.v1";
    notice: string;
  };
};

const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|cookie|set-cookie|secret|password|passphrase|credential|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key)(?:$|[_-])/i;

export function redactDiagnosticString(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => `${match.split(/\s+/, 1)[0]} [REDACTED]`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED CREDENTIAL]")
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b[A-Za-z]:\\Users\\[^\\/\s]+/gi, "<user-home>")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "<user-home>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>");
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnosticString(value);
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDiagnosticValue(item),
  ]));
}

function withoutConversation(evidence: ContextDiagnosticEvidence): ContextDiagnosticEvidence {
  if (evidence.events.length === 0) return evidence;
  return { ...evidence, events: [] };
}

export function buildProblemReport(input: {
  reportId: string;
  createdAt: string;
  draft: ProblemReportDraft;
  evidence: ContextDiagnosticEvidence;
  runtimeHealth: RuntimeHealth;
  client: ClientBuildIdentity;
}): FloeProblemReport {
  const busEvidence = input.draft.includeConversation ? input.evidence : withoutConversation(input.evidence);
  const report: FloeProblemReport = {
    schema: "floe.problem-report.v1",
    report_id: input.reportId,
    created_at: input.createdAt,
    sharing: {
      transmitted: false,
      operator_preview_required: true,
    },
    problem: {
      expected: input.draft.expected.trim(),
      actual: input.draft.actual.trim(),
      impact: input.draft.impact.trim() || null,
      tentative_classification: input.draft.tentativeClassification,
      floe_interpretation: input.draft.floeInterpretation.trim() || null,
      reproduction_safety: input.draft.reproductionSafety,
    },
    evidence: {
      app: {
        source: input.client,
        runtime_health: input.runtimeHealth,
      },
      bus: busEvidence,
      conversation_included: input.draft.includeConversation,
    },
    redaction: {
      policy: "floe.diagnostic-redaction.v1",
      notice: "Sensitive keys, credential patterns, user-home paths, URL credentials, and email addresses were redacted before preview and export. Review the exact files before sharing.",
    },
  };
  return redactDiagnosticValue(report) as FloeProblemReport;
}

function quoteMarkdown(value: string | null): string {
  if (!value) return "_Not provided._";
  return value.split(/\r?\n/).map((line) => `> ${line || " "}`).join("\n");
}

function displayClassification(value: ProblemClassification): string {
  return ({
    "not-sure": "Not sure",
    "workspace-or-configuration": "Workspace or configuration",
    "missing-capability": "Missing capability",
    "possible-substrate-defect": "Possible substrate defect",
    "product-usability": "Product usability",
  } as const)[value];
}

function eventText(event: ContextDiagnosticEvidence["events"][number]): string {
  const text = event.content?.["text"];
  if (typeof text === "string" && text.trim()) return text.trim();
  return `[${event.type} Event; no text content]`;
}

function telemetrySummary(report: FloeProblemReport): string[] {
  const records = report.evidence.bus.telemetry;
  if (records.length === 0) return ["_No related telemetry was found in the bounded evidence._"];
  const byKind = new Map<string, { count: number; latest: string }>();
  for (const record of records) {
    const current = byKind.get(record.kind);
    byKind.set(record.kind, {
      count: (current?.count ?? 0) + 1,
      latest: current && current.latest > record.created_at ? current.latest : record.created_at,
    });
  }
  return [...byKind.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .map(([kind, value]) => `- \`${kind}\`: ${value.count}; latest ${value.latest}`);
}

export function renderProblemReportMarkdown(report: FloeProblemReport): string {
  const bus = report.evidence.bus;
  const lines = [
    "# Floe problem report",
    "",
    `- Report: \`${report.report_id}\``,
    `- Created: ${report.created_at}`,
    `- Tentative classification: ${displayClassification(report.problem.tentative_classification)}`,
    `- Reproduction safety: ${report.problem.reproduction_safety}`,
    "- Sharing: saved locally; not transmitted",
    "",
    "## Expected",
    "",
    quoteMarkdown(report.problem.expected),
    "",
    "## Actual",
    "",
    quoteMarkdown(report.problem.actual),
    "",
    "## Impact",
    "",
    quoteMarkdown(report.problem.impact),
    "",
    "## Floe's tentative interpretation",
    "",
    quoteMarkdown(report.problem.floe_interpretation),
    "",
    "## Deterministic evidence",
    "",
    `- App: ${report.evidence.app.source.release_version ?? "unknown version"} (${report.evidence.app.source.build_sha ?? "build unavailable"})`,
    `- App health: ${report.evidence.app.runtime_health.state} — ${report.evidence.app.runtime_health.detail}`,
    `- Bus: ${bus.source.release_version ?? "unknown version"} (${bus.source.build_sha ?? "build unavailable"})`,
    `- Bridge online: ${String(bus.runtime.bridge.online)}`,
    `- Bridge: ${bus.runtime.bridge.release_version ?? "unknown version"} (${bus.runtime.bridge.build_sha ?? "build unavailable"})`,
    `- Runtime adapter: ${bus.runtime.bridge.runtime_adapter ?? "none reported"}`,
    `- Workspace: \`${bus.workspace.workspace_id}\``,
    `- Context: \`${bus.context.context_id}\``,
    `- Scope: ${bus.context.scope_id ? `\`${bus.context.scope_id}\`` : "none"}`,
    `- Participants: ${bus.context.participants.map((participant) => `\`${participant}\``).join(", ") || "none"}`,
    `- Related deliveries: ${bus.deliveries.length}${bus.limits.deliveries_truncated ? "+ (bounded)" : ""}`,
    `- Related telemetry records: ${bus.telemetry.length}${bus.limits.telemetry_truncated ? "+ (bounded)" : ""}`,
    `- Registered semantic operations: ${bus.operations.map((operation) => `${operation.operation_id}@${operation.operation_version}`).join(", ") || "none"}`,
    "",
    "### Delivery state",
    "",
    ...(bus.deliveries.length > 0
      ? bus.deliveries.map((delivery) => `- \`${delivery.delivery_id}\` → ${delivery.state}; attempts ${delivery.attempt_count}${delivery.last_error ? `; error: ${delivery.last_error}` : ""}`)
      : ["_No related deliveries were found in the bounded evidence._"]),
    "",
    "### Runtime telemetry",
    "",
    ...telemetrySummary(report),
    "",
    "### Conversation excerpts",
    "",
    ...(report.evidence.conversation_included && bus.events.length > 0
      ? bus.events.map((event) => [
          `**${event.source_endpoint_id ?? "System"}** — ${event.created_at}`,
          "",
          quoteMarkdown(eventText(event)),
          "",
        ]).flat()
      : ["_Conversation excerpts were not included._", ""]),
    "## Verification guidance",
    "",
    report.problem.reproduction_safety === "isolated-workspace-first"
      ? "Reproduce in an isolated workspace first. Confirm the fix in the originating workspace only after the reproduction no longer creates unbounded or durable unwanted state."
      : report.problem.reproduction_safety === "safe-in-originating-workspace"
        ? "The operator marked the scenario safe to retry in the originating workspace. Preserve the report IDs and compare the observed result."
        : "Choose an isolated workspace before replay if the failure could create persistent Contexts, repeated work, external effects, or material token use.",
    "",
    "## Redaction",
    "",
    report.redaction.notice,
    "",
    "The adjacent `report.json` contains the versioned machine-readable evidence represented by this report.",
    "",
  ];
  return lines.join("\n");
}

export function problemReportPaths(reportId: string): { markdown: string; json: string } {
  const safeId = reportId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const root = `.floe/state/feedback/${safeId}`;
  return { markdown: `${root}/report.md`, json: `${root}/report.json` };
}

export async function saveProblemReport(
  workspace: WorkspaceFsRef,
  report: FloeProblemReport,
): Promise<{ markdown: string; json: string; receipt: ProblemReportReceipt }> {
  const paths = problemReportPaths(report.report_id);
  const markdown = renderProblemReportMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([
    writeWorkspaceFile(workspace, paths.markdown, markdown),
    writeWorkspaceFile(workspace, paths.json, json),
  ]);
  const receipt: ProblemReportReceipt = {
    report_id: report.report_id,
    created_at: report.created_at,
    expected: report.problem.expected,
    markdown_path: paths.markdown,
    json_path: paths.json,
    status: "saved-locally",
  };
  const current = await listProblemReports(workspace);
  const index: ProblemReportIndex = {
    schema: "floe.problem-report-index.v1",
    reports: [receipt, ...current.filter((candidate) => candidate.report_id !== receipt.report_id)]
      .sort((left, right) => right.created_at.localeCompare(left.created_at)),
  };
  await writeWorkspaceFile(workspace, ".floe/state/feedback/index.json", `${JSON.stringify(index, null, 2)}\n`);
  return { ...paths, receipt };
}

export async function listProblemReports(workspace: WorkspaceFsRef): Promise<ProblemReportReceipt[]> {
  try {
    const raw = await readWorkspaceFile(workspace, ".floe/state/feedback/index.json");
    const parsed = JSON.parse(raw) as Partial<ProblemReportIndex>;
    if (parsed.schema !== "floe.problem-report-index.v1" || !Array.isArray(parsed.reports)) {
      return discoverUnindexedProblemReports(workspace);
    }
    return parsed.reports.filter((candidate): candidate is ProblemReportReceipt =>
      !!candidate
      && typeof candidate.report_id === "string"
      && typeof candidate.created_at === "string"
      && typeof candidate.expected === "string"
      && typeof candidate.markdown_path === "string"
      && typeof candidate.json_path === "string"
      && candidate.status === "saved-locally"
    );
  } catch {
    return discoverUnindexedProblemReports(workspace);
  }
}

function normalizedHostPath(value: string): string {
  return value.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
}

async function discoverUnindexedProblemReports(workspace: WorkspaceFsRef): Promise<ProblemReportReceipt[]> {
  if (!workspace.locator) return [];
  try {
    const separator = /^[A-Za-z]:[\\/]/.test(workspace.locator) || workspace.locator.includes("\\") ? "\\" : "/";
    const reportRoot = `${workspace.locator.replace(/[\\/]+$/, "")}${separator}.floe${separator}state${separator}feedback`;
    const { busBrowseDir } = await import("../../bus-client/client.ts");
    const listing = await busBrowseDir(reportRoot);
    if (normalizedHostPath(listing.path) !== normalizedHostPath(reportRoot)) return [];
    const reportDirs = listing.entries
      .filter((entry) => entry.is_dir && /^problem-[a-zA-Z0-9._-]+$/.test(entry.name))
      .slice(0, 50);
    const reports = await Promise.all(reportDirs.map(async (entry): Promise<ProblemReportReceipt | null> => {
      try {
        const jsonPath = `.floe/state/feedback/${entry.name}/report.json`;
        const raw = await readWorkspaceFile(workspace, jsonPath);
        const report = JSON.parse(raw) as Partial<FloeProblemReport>;
        if (report.schema !== "floe.problem-report.v1"
          || typeof report.report_id !== "string"
          || typeof report.created_at !== "string"
          || typeof report.problem?.expected !== "string") return null;
        return {
          report_id: report.report_id,
          created_at: report.created_at,
          expected: report.problem.expected,
          markdown_path: `.floe/state/feedback/${entry.name}/report.md`,
          json_path: jsonPath,
          status: "saved-locally",
        };
      } catch {
        return null;
      }
    }));
    return reports
      .filter((report): report is ProblemReportReceipt => !!report)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  } catch {
    return [];
  }
}

export function developerHandoffText(workspace: WorkspaceFsRef, receipt: ProblemReportReceipt): string {
  if (!workspace.locator) return `Review the saved Floe problem report ${receipt.markdown_path} in workspace ${workspace.workspace_id} and resolve the demonstrated issue.`;
  const separator = /^[A-Za-z]:[\\/]/.test(workspace.locator) || workspace.locator.includes("\\") ? "\\" : "/";
  const absolute = `${workspace.locator.replace(/[\\/]+$/, "")}${separator}${receipt.markdown_path.replace(/[\\/]/g, separator)}`;
  return `Review this saved Floe problem report and resolve the demonstrated issue: ${absolute}`;
}

export function newProblemReportId(createdAt = new Date().toISOString()): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `problem-${stamp}-${suffix}`;
}
