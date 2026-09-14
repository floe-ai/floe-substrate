import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionsButton } from "../actions/ActionsButton.tsx";
import type {
  ContextRef,
  EndpointRef,
  ScopeCompositionRevision,
  ScopeExecutionProjection,
  ScopeExecutionRecord,
  ScopeRef,
} from "../../bus-client/types.ts";
import {
  getScopeExecutionProjection,
  invokeOperation,
  listContextsForScope,
  listEvents,
  listOperations,
  listScopeCompositionRevisions,
  listScopeExecutions,
  subscribeEvents,
} from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { readWorkspaceFile } from "../../fs/workspaceFs.ts";
import {
  ArtifactLineageView,
  findArtifactGraphPath,
  parseArtifactLineageGraph,
  type ArtifactLineageGraph,
} from "./ArtifactLineageView.tsx";
import { ScopePipelineFocusView } from "./ScopePipelineFocusView.tsx";

const STOP_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.stop";
const ACTIVE_EXECUTION_STATES = new Set(["queued", "active", "waiting_external", "waiting_human", "paused", "blocked"]);
export { scopeExecutionStateRevision } from "../../../../floe-bus/src/scope-execution-contract.ts";
import { scopeExecutionStateRevision } from "../../../../floe-bus/src/scope-execution-contract.ts";

import { executionLabel, executionPresentation } from "./executionPresentation.ts";

export function ScopeWorkView({
  workspaceId,
  workspace,
  scope,
  endpoints,
  operatorEndpointId,
  onBack,
  initialExecutionId,
  allowedExecutionIds,
}: {
  workspaceId: string;
  workspace?: WorkspaceFsRef;
  scope: ScopeRef;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
  onBack: () => void;
  initialExecutionId?: string | null;
  allowedExecutionIds?: string[];
}): React.ReactElement {
  const [publishedRevision, setPublishedRevision] = useState<ScopeCompositionRevision | null>(null);
  const [executions, setExecutions] = useState<ScopeExecutionRecord[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(initialExecutionId ?? null);
  const [executionProjection, setExecutionProjection] = useState<ScopeExecutionProjection | null>(null);
  const loadedExecution = useRef<string | null>(null);
  const [executionReload, setExecutionReload] = useState(0);
  const [shownContextId, setShownContextId] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticContexts, setDiagnosticContexts] = useState<ContextRef[]>([]);
  const [diagnosticGraphPath, setDiagnosticGraphPath] = useState<string | null>(null);
  const [diagnosticGraph, setDiagnosticGraph] = useState<ArtifactLineageGraph | null>(null);
  const [diagnosticContextId, setDiagnosticContextId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [executionLoading, setExecutionLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [plans, executionPage] = await Promise.all([
        listScopeCompositionRevisions(workspaceId, scope.scope_id),
        listScopeExecutions(workspaceId, scope.scope_id, { limit: 50 }),
      ]);
      const filtered = allowedExecutionIds
        ? executionPage.executions.filter((execution) => allowedExecutionIds.includes(execution.execution_id))
        : executionPage.executions;
      const current = plans.revisions.find((revision) => revision.revision_id === plans.published_revision_id) ?? null;
      setPublishedRevision(current);
      setExecutions(filtered);
      setSelectedExecutionId((selected) => {
        if (selected && filtered.some((execution) => execution.execution_id === selected)) return selected;
        if (initialExecutionId && filtered.some((execution) => execution.execution_id === initialExecutionId)) return initialExecutionId;
        return filtered[0]?.execution_id ?? null;
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load organised work");
    } finally {
      setLoading(false);
    }
  }, [allowedExecutionIds, initialExecutionId, scope.scope_id, workspaceId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedExecutionId) {
      loadedExecution.current = null;
      setExecutionProjection(null);
      setExecutionLoading(false);
      return;
    }
    let cancelled = false;
    const selectionKey = `${workspaceId}:${selectedExecutionId}`;
    if (loadedExecution.current !== selectionKey) {
      setExecutionProjection(null);
      setExecutionLoading(true);
    }
    void getScopeExecutionProjection(workspaceId, selectedExecutionId)
      .then((projection) => {
        if (!cancelled) {
          loadedExecution.current = selectionKey;
          setExecutionProjection(projection);
          setExecutionLoading(false);
        }
      })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load execution"); });
    return () => { cancelled = true; };
  }, [executionReload, selectedExecutionId, workspaceId]);

  useEffect(() => {
    if (executionProjection || !selectedExecutionId) setExecutionLoading(false);
  }, [executionProjection, selectedExecutionId]);

  useEffect(() => subscribeEvents((message) => {
    if ([
      "scope_composition_published",
      "scope_execution_started",
      "scope_output_published",
      "scope_execution_stopped",
      "scope_execution_updated",
      "operation_invocation_updated",
      "delivery_deferred",
    ].includes(message.type)) {
      void load();
      setExecutionReload((value) => value + 1);
    }
  }, { workspaceId }), [load, workspaceId]);

  const loadDiagnostics = useCallback(async () => {
    const [contexts, lineageEvents] = await Promise.all([
      listContextsForScope(workspaceId, scope.scope_id).catch(() => []),
      listEvents({ workspace_id: workspaceId, scope_id: scope.scope_id, direction: "backward", limit: 100 }).catch(() => ({ events: [], next_cursor: null })),
    ]);
    const graphPath = findArtifactGraphPath(lineageEvents.events);
    const graph = workspace && graphPath
      ? await readWorkspaceFile(workspace, graphPath).then(parseArtifactLineageGraph).catch(() => null)
      : null;
    setDiagnosticContexts(contexts);
    setDiagnosticGraphPath(graphPath);
    setDiagnosticGraph(graph);
    setDiagnosticContextId((current) => current && contexts.some((context) => context.context_id === current) ? current : contexts[0]?.context_id ?? null);
  }, [scope.scope_id, workspace, workspaceId]);

  useEffect(() => {
    if (diagnosticsOpen) void loadDiagnostics();
  }, [diagnosticsOpen, loadDiagnostics]);

  const selectedExecution = executions.find((execution) => execution.execution_id === selectedExecutionId) ?? null;
  const displayedRevision = selectedExecutionId ? executionProjection?.revision ?? null : publishedRevision;
  const status = executionPresentation(selectedExecution?.status ?? null);
  const isHistoricalPlan = !!executionProjection
    && !!publishedRevision
    && executionProjection.revision.revision_id !== publishedRevision.revision_id;
  const canStop = !!selectedExecution && ACTIVE_EXECUTION_STATES.has(selectedExecution.status);

  const stopWork = useCallback(async () => {
    if (!selectedExecution || stopping) return;
    if (!window.confirm(`Stop this execution of ${scope.title || scope.scope_id}? Its plan, Contexts, Events, and Artifact references will be kept.`)) return;
    setStopping(true);
    setError(null);
    try {
      const target = { kind: "scope_execution", id: selectedExecution.execution_id };
      const operations = await listOperations(workspaceId, target);
      const operation = operations.find((candidate) => candidate.operation_id === STOP_SCOPE_EXECUTION_OPERATION_ID);
      if (!operation) throw new Error("The authenticated app session does not expose Stop Scope execution.");
      if (!operation.availability.available) throw new Error(operation.availability.refusal.message);
      const receipt = await invokeOperation(workspaceId, {
        operation_id: operation.operation_id,
        operation_version: operation.operation_version,
        input_schema_version: operation.input.version,
        target,
        expected_resource_revision: scopeExecutionStateRevision(selectedExecution),
        idempotency_key: `app-stop:${selectedExecution.execution_id}:${crypto.randomUUID()}`,
        input: { reason: "Stopped by the operator in floe-app." },
      });
      if (receipt.state === "refused") throw new Error(receipt.refusal?.message ?? "Floe refused to stop this execution.");
      await load();
      setExecutionReload((value) => value + 1);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Could not stop this execution");
    } finally {
      setStopping(false);
    }
  }, [load, scope.scope_id, scope.title, selectedExecution, stopping, workspaceId]);

  return <div className="scope-work-shell" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: tk.fontUi }}>
    <header className="scope-work-header">
      <button type="button" onClick={onBack} style={{ padding: 0, border: "none", background: "transparent", color: tk.ink3, fontSize: 12.5, cursor: "pointer" }}>← Workspace</button>
      <div className="scope-work-heading">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, color: tk.ink, fontSize: 19, fontWeight: 550 }}>{scope.title || scope.scope_id}</h2>
            {!loading && displayedRevision && <span style={{ color: tk.ink4, fontSize: 11.5 }}>Plan revision {displayedRevision.revision_number}{isHistoricalPlan ? " · retained execution" : " · current"}</span>}
            {!loading && <span role="status" style={{ padding: "2px 7px", borderRadius: 999, color: status.color, background: status.background, fontSize: 10.5 }}>{status.label}</span>}
          </div>
          <p style={{ margin: "5px 0 0", color: "#9aa39d", fontSize: 12.5, lineHeight: 1.45 }}>Explore the work, inspect its outputs and join the conversation.</p>
        </div>
        <div className="scope-work-controls">
          {selectedExecution && <ActionsButton workspaceId={workspaceId} target={{ kind: "scope_execution", id: selectedExecution.execution_id, revision: scopeExecutionStateRevision(selectedExecution) }} label={scope.title || "Organised work"} />}
          {selectedExecution && <button type="button" onClick={() => void stopWork()} disabled={!canStop || stopping} style={{ padding: "7px 10px", color: canStop ? tk.danger : tk.ink4, background: "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: canStop && !stopping ? "pointer" : "default", fontSize: 12 }}>{stopping ? "Stopping…" : "Stop execution"}</button>}
          <button type="button" onClick={() => setDiagnosticsOpen((value) => !value)} style={{ padding: "7px 10px", color: diagnosticsOpen ? tk.ink : tk.ink3, background: diagnosticsOpen ? tk.surfaceHov : "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 12 }}>{diagnosticsOpen ? "Back to plan" : "Diagnostics"}</button>
        </div>
      </div>
      {!loading && executions.length > 0 && !diagnosticsOpen && <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, color: tk.ink3, fontSize: 11.5 }}>
        Execution
        <select aria-label="Scope execution" value={selectedExecutionId ?? ""} onChange={(event) => setSelectedExecutionId(event.target.value)} style={{ minWidth: 260, padding: "6px 8px", color: tk.ink, background: tk.canvas, border: `1px solid ${tk.border}`, borderRadius: tk.r2 }}>
          {executions.map((execution) => <option key={execution.execution_id} value={execution.execution_id}>{executionLabel(execution)}</option>)}
        </select>
      </label>}
    </header>

    {loading ? <Status>Loading organised work…</Status>
      : error ? <div role="alert" style={{ padding: 28, color: tk.danger, fontSize: 13 }}>{error}</div>
      : diagnosticsOpen ? <ScopeDiagnostics workspaceId={workspaceId} workspace={workspace} contexts={diagnosticContexts} selectedContextId={diagnosticContextId} onSelectContext={setDiagnosticContextId} graphPath={diagnosticGraphPath} graph={diagnosticGraph} endpoints={endpoints} operatorEndpointId={operatorEndpointId} />
      : executionLoading ? <Status>Loading the selected execution…</Status>
      : !displayedRevision ? <Status>This Scope has no published plan.</Status>
      : <ScopePipelineFocusView key={`${workspaceId}:${displayedRevision.revision_id}:${executionProjection?.execution.execution_id ?? "plan"}`} workspaceId={workspaceId} revision={displayedRevision} executionProjection={executionProjection} endpoints={endpoints} onOpenContext={setShownContextId} />}
    {shownContextId && <aside className="pf-conversation-panel" aria-label="Work conversation" onKeyDown={event => { if (event.key === "Escape") setShownContextId(null); }}>
      <header><strong>Work conversation</strong><button autoFocus type="button" onClick={() => setShownContextId(null)}>Close conversation</button></header>
      <ContextConversation key={shownContextId} contextId={shownContextId} workspaceId={workspaceId} endpoints={endpoints} alignRightEndpointId={operatorEndpointId} showWorkEvents operatorEntry={{ operatorEndpointId, showContextIdentity: true }} />
    </aside>}
  </div>;
}

function ScopeDiagnostics({ workspaceId, workspace, contexts, selectedContextId, onSelectContext, graphPath, graph, endpoints, operatorEndpointId }: {
  workspaceId: string;
  workspace?: WorkspaceFsRef;
  contexts: ContextRef[];
  selectedContextId: string | null;
  onSelectContext: (id: string) => void;
  graphPath: string | null;
  graph: ArtifactLineageGraph | null;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
}): React.ReactElement {
  const [showLegacyLineage, setShowLegacyLineage] = useState(false);
  if (showLegacyLineage && workspace && graphPath && graph) return <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
    <div style={{ padding: "10px 18px", borderBottom: `1px solid ${tk.border}`, color: tk.ink3, fontSize: 11.5 }}><button type="button" onClick={() => setShowLegacyLineage(false)} style={{ border: "none", background: "transparent", color: tk.accentHov, cursor: "pointer" }}>← Diagnostics</button> · Legacy extension lineage; not canonical pipeline state</div>
    <div style={{ flex: 1, minHeight: 0 }}><ArtifactLineageView workspace={workspace} graphPath={graphPath} endpoints={endpoints} operatorEndpointId={operatorEndpointId} /></div>
  </div>;
  return <section aria-label="Scope diagnostics" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24, background: tk.canvas }}>
    <h3 style={{ margin: "0 0 6px", color: tk.ink, fontSize: 16 }}>Diagnostics</h3>
    <p style={{ margin: "0 0 18px", color: tk.ink3, fontSize: 12.5 }}>Context parentage and legacy extension lineage are supporting evidence. They do not define this pipeline.</p>
    {workspace && graphPath && graph && <button type="button" onClick={() => setShowLegacyLineage(true)} style={{ marginBottom: 16, padding: "7px 10px", border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: tk.surface, color: tk.ink2, cursor: "pointer" }}>Open legacy extension lineage</button>}
    {contexts.length === 0 ? <Status>No Scope Context diagnostics are available.</Status> : <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 32%) 1fr", minHeight: 480, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden" }}>
      <nav aria-label="Diagnostic Contexts" style={{ padding: 10, borderRight: `1px solid ${tk.border}`, overflow: "auto" }}>{contexts.map((context) => <button key={context.context_id} type="button" onClick={() => onSelectContext(context.context_id)} style={{ display: "block", width: "100%", padding: "8px", textAlign: "left", border: "none", borderRadius: tk.r2, background: selectedContextId === context.context_id ? tk.surfaceHov : "transparent", color: tk.ink2, cursor: "pointer", fontSize: 11.5 }}>{context.title || context.context_id}</button>)}</nav>
      {selectedContextId && <ContextConversation key={selectedContextId} contextId={selectedContextId} workspaceId={workspaceId} endpoints={endpoints} alignRightEndpointId={operatorEndpointId} showWorkEvents readOnly />}
    </div>}
  </section>;
}

function Status({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>{children}</div>;
}
