import React, { useCallback, useEffect, useState } from "react";
import type { ContextRef, EndpointRef, ScopeExecutionRecord, ScopeRef } from "../../bus-client/types.ts";
import { listContextScopeExecutions, listContextTree, subscribeEvents } from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";
import { ScopeWorkView } from "./ScopeWorkView.tsx";
import { executionLabel } from "./executionPresentation.ts";

export function ContextWorkView({
  workspaceId,
  rootContextId,
  scopes,
  endpoints,
  operatorEndpointId,
  onBackToConversation,
}: {
  workspaceId: string;
  rootContextId: string;
  scopes: ScopeRef[];
  endpoints: EndpointRef[];
  operatorEndpointId: string;
  onBackToConversation: () => void;
}): React.ReactElement {
  const [executions, setExecutions] = useState<ScopeExecutionRecord[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listContextScopeExecutions(workspaceId, rootContextId);
      setExecutions(next);
      setSelectedExecutionId((selected) => selected && next.some((execution) => execution.execution_id === selected)
        ? selected
        : next.length === 1 ? next[0]!.execution_id : null);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load linked organised work");
    } finally {
      setLoading(false);
    }
  }, [rootContextId, workspaceId]);

  useEffect(() => {
    setLoading(true);
    setSelectedExecutionId(null);
    setDiagnosticsOpen(false);
    void load();
  }, [load]);

  useEffect(() => subscribeEvents((message) => {
    if (["scope_execution_started", "scope_execution_updated", "scope_execution_stopped", "scope_output_published"].includes(message.type)) void load();
  }, { workspaceId }), [load, workspaceId]);

  const selected = executions.find((execution) => execution.execution_id === selectedExecutionId) ?? null;
  const scope = selected ? scopes.find((candidate) => candidate.scope_id === selected.scope_id) ?? {
    scope_id: selected.scope_id,
    workspace_id: selected.workspace_id,
    title: selected.scope_id,
    description: null,
    status: "active" as const,
    created_at: selected.created_at,
    updated_at: selected.created_at,
  } : null;

  if (selected && scope) {
    const idsInScope = executions.filter((execution) => execution.scope_id === selected.scope_id).map((execution) => execution.execution_id);
    return <ScopeWorkView
      workspaceId={workspaceId}
      scope={scope}
      endpoints={endpoints}
      operatorEndpointId={operatorEndpointId}
      initialExecutionId={selected.execution_id}
      allowedExecutionIds={idsInScope}
      onBack={executions.length === 1 ? onBackToConversation : () => setSelectedExecutionId(null)}
    />;
  }

  return <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: tk.fontUi }}>
    <header style={{ padding: "16px 22px 13px", borderBottom: `1px solid ${tk.border}`, background: tk.surface }}>
      <button type="button" onClick={onBackToConversation} style={{ padding: 0, border: "none", background: "transparent", color: tk.ink3, fontSize: 12.5, cursor: "pointer" }}>← Conversation</button>
      <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: tk.ink, fontSize: 19, fontWeight: 550 }}>Work linked to this conversation</h2>
          <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45 }}>Choose a recorded run to see its progress and saved outputs.</p>
        </div>
        <button type="button" onClick={() => setDiagnosticsOpen((value) => !value)} style={{ padding: "7px 10px", color: diagnosticsOpen ? tk.ink : tk.ink3, background: diagnosticsOpen ? tk.surfaceHov : "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 12 }}>{diagnosticsOpen ? "Back to work" : "Diagnostics"}</button>
      </div>
    </header>
    {diagnosticsOpen ? <ContextTreeDiagnostics workspaceId={workspaceId} rootContextId={rootContextId} endpoints={endpoints} operatorEndpointId={operatorEndpointId} />
      : loading ? <Status>Loading linked work…</Status>
      : error ? <div role="alert" style={{ padding: 28, color: tk.danger, fontSize: 13 }}>{error}</div>
      : executions.length === 0 ? <Status>No organised work is linked to this conversation yet.</Status>
      : <section aria-label="Linked work" style={{ padding: 24, overflow: "auto" }}>
        <div style={{ display: "grid", gap: 9, maxWidth: 760, margin: "0 auto" }}>
          {executions.map((execution) => {
            const linkedScope = scopes.find((candidate) => candidate.scope_id === execution.scope_id);
            return <button key={execution.execution_id} type="button" onClick={() => setSelectedExecutionId(execution.execution_id)} style={{ width: "100%", padding: 14, textAlign: "left", border: `1px solid ${tk.border}`, borderRadius: tk.r3, background: tk.surface, color: tk.ink, cursor: "pointer" }}>
              <strong style={{ display: "block", fontSize: 13.5, fontWeight: 560 }}>{linkedScope?.title || execution.scope_id}</strong>
              <span style={{ display: "block", marginTop: 5, color: tk.ink3, fontSize: 11.5 }}>{executionLabel(execution)}</span>
            </button>;
          })}
        </div>
      </section>}
  </div>;
}

function ContextTreeDiagnostics({ workspaceId, rootContextId, endpoints, operatorEndpointId }: {
  workspaceId: string;
  rootContextId: string;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
}): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [selectedContextId, setSelectedContextId] = useState(rootContextId);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listContextTree(rootContextId, 200, workspaceId)
      .then((tree) => {
        if (cancelled) return;
        setContexts(tree.contexts);
        setTruncated(tree.truncated);
      })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load Context diagnostics"); });
    return () => { cancelled = true; };
  }, [rootContextId, workspaceId]);

  if (error) return <div role="alert" style={{ padding: 28, color: tk.danger }}>{error}</div>;
  return <section aria-label="Context diagnostics" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 20, background: tk.canvas }}>
    <p style={{ margin: "0 0 12px", color: tk.ink3, fontSize: 12 }}>This is Context parentage for diagnosis. It is not the pipeline plan or an execution route.</p>
    {truncated && <div role="status" style={{ marginBottom: 8, color: "#c9a14a", fontSize: 11.5 }}>Showing the first 200 Contexts.</div>}
    <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(220px, 32%) 1fr", border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden" }}>
      <nav aria-label="Context parentage" style={{ padding: 10, overflow: "auto", borderRight: `1px solid ${tk.border}` }}>{contexts.map((context) => <button key={context.context_id} type="button" onClick={() => setSelectedContextId(context.context_id)} style={{ display: "block", width: "100%", padding: "8px", textAlign: "left", border: "none", borderRadius: tk.r2, background: context.context_id === selectedContextId ? tk.surfaceHov : "transparent", color: tk.ink2, cursor: "pointer", fontSize: 11.5 }}>{context.title || context.context_id}</button>)}</nav>
      <ContextConversation key={selectedContextId} contextId={selectedContextId} workspaceId={workspaceId} endpoints={endpoints} alignRightEndpointId={operatorEndpointId} showWorkEvents readOnly />
    </div>
  </section>;
}

function Status({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>{children}</div>;
}
