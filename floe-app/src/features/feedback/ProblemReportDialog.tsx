import React, { useEffect, useMemo, useState } from "react";
import { getContextDiagnosticEvidence } from "../../bus-client/client.ts";
import type { ContextDiagnosticEvidence } from "../../bus-client/types.ts";
import { getClientBuildIdentity } from "../../buildInfo.ts";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import type { RuntimeHealth } from "../../runtime/health.ts";
import { tk } from "../../theme.ts";
import {
  buildProblemReport,
  developerHandoffText,
  newProblemReportId,
  renderProblemReportMarkdown,
  saveProblemReport,
  type FloeProblemReport,
  type ProblemClassification,
  type ProblemReportDraft,
  type ProblemReportReceipt,
  type ReproductionSafety,
} from "./problemReport.ts";

type Props = {
  workspace: WorkspaceFsRef;
  contextId: string;
  operatorEndpointId: string;
  runtimeHealth: RuntimeHealth;
  initialDraft?: Partial<ProblemReportDraft>;
  onSaved?: (receipt: ProblemReportReceipt) => void;
  onClose: () => void;
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  background: tk.surfaceHov,
  color: tk.ink,
  padding: "9px 10px",
  fontSize: 13,
  lineHeight: 1.5,
  resize: "vertical",
};

function latestFloeInterpretation(evidence: ContextDiagnosticEvidence, operatorEndpointId: string): string {
  const event = [...evidence.events].reverse().find((candidate) =>
    candidate.type === "message"
    && candidate.source_endpoint_id !== operatorEndpointId
    && typeof candidate.content?.["text"] === "string"
    && candidate.content["text"].trim().length > 0
  );
  return typeof event?.content?.["text"] === "string" ? event.content["text"].trim() : "";
}

function absolutePath(workspaceRoot: string | undefined, relativePath: string): string {
  if (!workspaceRoot) return relativePath;
  const windows = /^[A-Za-z]:[\\/]/.test(workspaceRoot) || workspaceRoot.includes("\\");
  const separator = windows ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

export function ProblemReportDialog({
  workspace,
  contextId,
  operatorEndpointId,
  runtimeHealth,
  initialDraft,
  onSaved,
  onClose,
}: Props): React.ReactElement {
  const [evidence, setEvidence] = useState<ContextDiagnosticEvidence | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [stage, setStage] = useState<"edit" | "preview" | "saved">("edit");
  const [previewTab, setPreviewTab] = useState<"markdown" | "json">("markdown");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedPaths, setSavedPaths] = useState<{
    markdown: string;
    json: string;
    receipt: ProblemReportReceipt;
  } | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [createdAt] = useState(() => new Date().toISOString());
  const [reportId] = useState(() => newProblemReportId(createdAt));
  const [draft, setDraft] = useState<ProblemReportDraft>({
    expected: initialDraft?.expected ?? "",
    actual: initialDraft?.actual ?? "",
    impact: initialDraft?.impact ?? "",
    tentativeClassification: initialDraft?.tentativeClassification ?? "not-sure",
    floeInterpretation: initialDraft?.floeInterpretation ?? "",
    reproductionSafety: initialDraft?.reproductionSafety ?? "isolated-workspace-first",
    includeConversation: initialDraft?.includeConversation ?? true,
  });

  useEffect(() => {
    let cancelled = false;
    setLoadingError(null);
    void getContextDiagnosticEvidence(workspace.workspace_id, contextId, {
      event_limit: 12,
      delivery_limit: 30,
      telemetry_limit: 100,
    }).then((result) => {
      if (cancelled) return;
      setEvidence(result);
      const interpretation = latestFloeInterpretation(result, operatorEndpointId);
      if (interpretation) {
        setDraft((current) => current.floeInterpretation
          ? current
          : { ...current, floeInterpretation: interpretation });
      }
    }).catch((error) => {
      if (!cancelled) setLoadingError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [contextId, operatorEndpointId, workspace.workspace_id]);

  const report = useMemo<FloeProblemReport | null>(() => evidence ? buildProblemReport({
    reportId,
    createdAt,
    draft,
    evidence,
    runtimeHealth,
    client: getClientBuildIdentity(),
  }) : null, [createdAt, draft, evidence, reportId, runtimeHealth]);
  const markdown = useMemo(() => report ? renderProblemReportMarkdown(report) : "", [report]);
  const json = useMemo(() => report ? `${JSON.stringify(report, null, 2)}\n` : "", [report]);
  const valid = draft.expected.trim().length > 0 && draft.actual.trim().length > 0 && !!evidence;

  async function save(): Promise<void> {
    if (!report) return;
    setSaving(true);
    setSaveError(null);
    try {
      const paths = await saveProblemReport(workspace, report);
      setSavedPaths(paths);
      setStage("saved");
      onSaved?.(paths.receipt);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function copyFolderPath(): Promise<void> {
    if (!savedPaths) return;
    const folder = savedPaths.markdown.slice(0, savedPaths.markdown.lastIndexOf("/"));
    try {
      await navigator.clipboard.writeText(absolutePath(workspace.locator, folder));
      setCopyNotice("Folder path copied.");
    } catch {
      setCopyNotice("Could not copy the path. Select it below instead.");
    }
  }

  async function copyDeveloperHandoff(): Promise<void> {
    if (!savedPaths) return;
    try {
      await navigator.clipboard.writeText(developerHandoffText(workspace, savedPaths.receipt));
      setCopyNotice("Developer handoff copied.");
    } catch {
      setCopyNotice("Could not copy the developer handoff. Copy the report path below instead.");
    }
  }

  return (
    <div
      role="presentation"
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.72)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="problem-report-title"
        style={{
          width: "min(820px, 100%)", maxHeight: "min(860px, 94vh)", overflow: "auto",
          border: `1px solid ${tk.border}`, borderRadius: tk.r3,
          background: tk.surface, boxShadow: "0 24px 80px rgba(0,0,0,0.48)",
          fontFamily: tk.fontUi,
        }}
      >
        <header style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
          padding: "22px 24px 18px", borderBottom: `1px solid ${tk.border}`,
        }}>
          <div>
            <div style={{ color: tk.accent, fontSize: 11.5, fontWeight: 590, marginBottom: 5 }}>Local support report</div>
            <h2 id="problem-report-title" style={{ margin: 0, color: tk.ink, fontSize: 21, fontWeight: 520 }}>
              Report a Floe problem
            </h2>
            <p style={{ margin: "7px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.5 }}>
              Floe collects bounded system facts through its supported APIs. Nothing is sent; you review the exact files before sharing them.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close report" style={{
            border: "none", background: "transparent", color: tk.ink3, fontSize: 21, lineHeight: 1,
          }}>×</button>
        </header>

        <div style={{ padding: 24 }}>
          {loadingError && (
            <div role="alert" style={{ color: tk.danger, marginBottom: 16 }}>
              Floe could not collect diagnostic evidence: {loadingError}
            </div>
          )}
          {!evidence && !loadingError && <p style={{ color: tk.ink3 }}>Collecting bounded diagnostic evidence…</p>}

          {evidence && stage === "edit" && (
            <div style={{ display: "grid", gap: 17 }}>
              <label style={{ display: "grid", gap: 6, color: tk.ink2, fontSize: 12.5 }}>
                What did you expect?
                <textarea
                  aria-label="What did you expect?"
                  rows={3}
                  value={draft.expected}
                  onChange={(event) => setDraft({ ...draft, expected: event.target.value })}
                  style={fieldStyle}
                  autoFocus
                />
              </label>
              <label style={{ display: "grid", gap: 6, color: tk.ink2, fontSize: 12.5 }}>
                What happened instead?
                <textarea
                  aria-label="What happened instead?"
                  rows={4}
                  value={draft.actual}
                  onChange={(event) => setDraft({ ...draft, actual: event.target.value })}
                  style={fieldStyle}
                />
              </label>
              <label style={{ display: "grid", gap: 6, color: tk.ink2, fontSize: 12.5 }}>
                What was the impact? <span style={{ color: tk.ink4 }}>(optional)</span>
                <textarea
                  aria-label="What was the impact?"
                  rows={2}
                  value={draft.impact}
                  onChange={(event) => setDraft({ ...draft, impact: event.target.value })}
                  style={fieldStyle}
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label style={{ display: "grid", gap: 6, color: tk.ink2, fontSize: 12.5 }}>
                  Tentative classification
                  <select
                    aria-label="Tentative classification"
                    value={draft.tentativeClassification}
                    onChange={(event) => setDraft({ ...draft, tentativeClassification: event.target.value as ProblemClassification })}
                    style={fieldStyle}
                  >
                    <option value="not-sure">Not sure</option>
                    <option value="workspace-or-configuration">Workspace or configuration</option>
                    <option value="missing-capability">Missing capability</option>
                    <option value="possible-substrate-defect">Possible substrate defect</option>
                    <option value="product-usability">Product usability</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, color: tk.ink2, fontSize: 12.5 }}>
                  Safe verification boundary
                  <select
                    aria-label="Safe verification boundary"
                    value={draft.reproductionSafety}
                    onChange={(event) => setDraft({ ...draft, reproductionSafety: event.target.value as ReproductionSafety })}
                    style={fieldStyle}
                  >
                    <option value="isolated-workspace-first">Use an isolated workspace first</option>
                    <option value="safe-in-originating-workspace">Safe to retry here</option>
                    <option value="not-sure">Not sure</option>
                  </select>
                </label>
              </div>
              <label style={{ display: "grid", gap: 6, color: tk.ink2, fontSize: 12.5 }}>
                Floe’s tentative interpretation <span style={{ color: tk.ink4 }}>(optional, from the latest reply)</span>
                <textarea
                  aria-label="Floe’s tentative interpretation"
                  rows={4}
                  value={draft.floeInterpretation}
                  onChange={(event) => setDraft({ ...draft, floeInterpretation: event.target.value })}
                  style={fieldStyle}
                />
              </label>
              <label style={{ display: "flex", gap: 9, alignItems: "flex-start", color: tk.ink2, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={draft.includeConversation}
                  onChange={(event) => setDraft({ ...draft, includeConversation: event.target.checked })}
                  style={{ marginTop: 2 }}
                />
                Include the latest {evidence.events.length} public conversation Events. Tool arguments, tool output, visible-output telemetry, and scratch reasoning are never included.
              </label>
              <div style={{
                border: `1px solid ${tk.border}`, borderRadius: tk.r2, padding: "11px 12px",
                color: tk.ink3, fontSize: 12, lineHeight: 1.5, background: tk.surfaceSunk,
              }}>
                Evidence: {evidence.deliveries.length} related deliveries, {evidence.telemetry.length} runtime records, {evidence.operations.length} registered semantic operations. Sensitive keys, credentials, personal paths, and email addresses are redacted before preview.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
                <button type="button" onClick={onClose} style={{
                  border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: "transparent",
                  color: tk.ink2, padding: "8px 12px", fontSize: 12.5,
                }}>Cancel</button>
                <button type="button" disabled={!valid} onClick={() => setStage("preview")} style={{
                  border: "none", borderRadius: tk.r2, background: tk.accent, color: "#0c1714",
                  padding: "8px 13px", fontSize: 12.5, fontWeight: 590,
                  opacity: valid ? 1 : 0.45,
                }}>Review exact report</button>
              </div>
            </div>
          )}

          {evidence && stage === "preview" && report && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
                <div>
                  <h3 style={{ margin: 0, color: tk.ink, fontSize: 16, fontWeight: 520 }}>Exact local export</h3>
                  <p style={{ margin: "4px 0 0", color: tk.ink3, fontSize: 12 }}>Review both formats. Save writes these exact contents under ignored workspace state.</p>
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                  {(["markdown", "json"] as const).map((tab) => (
                    <button key={tab} type="button" onClick={() => setPreviewTab(tab)} style={{
                      border: `1px solid ${tk.border}`, borderRadius: tk.r2,
                      background: previewTab === tab ? tk.accentSoft2 : "transparent",
                      color: previewTab === tab ? tk.accentHov : tk.ink3,
                      padding: "6px 9px", fontSize: 11.5, textTransform: "uppercase",
                    }}>{tab}</button>
                  ))}
                </div>
              </div>
              <pre aria-label={`${previewTab} report preview`} style={{
                margin: 0, maxHeight: "52vh", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
                border: `1px solid ${tk.border}`, borderRadius: tk.r2, padding: 14,
                background: tk.surfaceSunk, color: tk.ink2, fontSize: 11.5, lineHeight: 1.55,
              }}>{previewTab === "markdown" ? markdown : json}</pre>
              {saveError && <div role="alert" style={{ marginTop: 12, color: tk.danger }}>{saveError}</div>}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 9, marginTop: 15 }}>
                <button type="button" onClick={() => setStage("edit")} style={{
                  border: "none", background: "transparent", color: tk.ink3, padding: "8px 0", fontSize: 12.5,
                }}>← Edit report</button>
                <button type="button" disabled={saving} onClick={() => void save()} style={{
                  border: "none", borderRadius: tk.r2, background: tk.accent, color: "#0c1714",
                  padding: "8px 13px", fontSize: 12.5, fontWeight: 590, opacity: saving ? 0.6 : 1,
                }}>{saving ? "Saving…" : "Save report locally"}</button>
              </div>
            </div>
          )}

          {stage === "saved" && savedPaths && (
            <div>
              <div style={{ color: tk.ok, fontSize: 12, fontWeight: 590, marginBottom: 7 }}>Saved locally</div>
              <h3 style={{ margin: "0 0 8px", color: tk.ink, fontSize: 18, fontWeight: 520 }}>Ready for developer handoff</h3>
              <p style={{ margin: "0 0 16px", color: tk.ink3, fontSize: 12.5, lineHeight: 1.5 }}>
                The report is now visible in this workspace. It has not been shared because no development connection is configured.
              </p>
              <div style={{ border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: tk.surfaceSunk, padding: 12 }}>
                <code style={{ color: tk.ink2, wordBreak: "break-all" }}>
                  {absolutePath(workspace.locator, savedPaths.markdown.slice(0, savedPaths.markdown.lastIndexOf("/")))}
                </code>
              </div>
              {copyNotice && <p role="status" style={{ margin: "9px 0 0", color: tk.ink3, fontSize: 12 }}>{copyNotice}</p>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 18 }}>
                <button type="button" onClick={() => void copyFolderPath()} style={{
                  border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: "transparent",
                  color: tk.ink2, padding: "8px 12px", fontSize: 12.5,
                }}>Copy folder path</button>
                <button type="button" onClick={() => void copyDeveloperHandoff()} style={{
                  border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: "transparent",
                  color: tk.ink2, padding: "8px 12px", fontSize: 12.5,
                }}>Copy developer handoff</button>
                <button type="button" onClick={onClose} style={{
                  border: "none", borderRadius: tk.r2, background: tk.accent, color: "#0c1714",
                  padding: "8px 13px", fontSize: 12.5, fontWeight: 590,
                }}>Done</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
