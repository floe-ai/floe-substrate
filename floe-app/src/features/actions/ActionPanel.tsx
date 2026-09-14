import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { confirmAndInvokeOperation, getContext, listEndpoints, getOperationReceipt, invokeOperation, listOperations, SemanticOperationError } from "../../bus-client/client.ts";
import type { OperationInvocationReceipt, OperationInvocationRequest, OperationResourceRef, SemanticOperationDescriptor } from "../../bus-client/types.ts";
import { ActionResult } from "./ActionResult.tsx";
import { ApprovalResult } from "./ApprovalResult.tsx";
import { initialValue, record, SchemaFields, words, type FieldChoices } from "./SchemaFields.tsx";
import { clearPendingAction, readPendingAction, retainPendingAction } from "./pendingAction.ts";
import "./actions.css";

type Selection = { ref: OperationResourceRef; label: string };
const responseOperation = "approval.response.configure";

export function ActionPanel({ workspaceId, workspaceName, initialTarget, onClose, fieldChoices, artefactLabels, initialReadOperationId }: {
  workspaceId: string; workspaceName: string; initialTarget?: Selection; onClose: () => void;
  fieldChoices?: Record<string, FieldChoices>;
  artefactLabels?: ReadonlyMap<string, string>;
  initialReadOperationId?: string;
}): React.ReactElement {
  const [restored] = useState(() => readPendingAction(workspaceId));
  const [target, setTarget] = useState<Selection | undefined>(restored?.target ?? initialTarget);
  const [operations, setOperations] = useState<SemanticOperationDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<SemanticOperationDescriptor | null>(restored?.descriptor ?? null);
  const [input, setInput] = useState<unknown>(restored?.request.input ?? {});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [receipt, setReceipt] = useState<OperationInvocationReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(!!restored);
  const [refresh, setRefresh] = useState(0);
  const [responseChoices, setResponseChoices] = useState<FieldChoices | null>(null);
  const pending = useRef<OperationInvocationRequest | null>(restored?.request ?? null);
  const panel = useRef<HTMLDivElement>(null);
  const focusBeforeOpen = useRef<Element | null>(null);
  const initialReadStarted = useRef(false);

  useEffect(() => {
    focusBeforeOpen.current = document.activeElement;
    panel.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
    return () => { if (focusBeforeOpen.current instanceof HTMLElement) focusBeforeOpen.current.focus(); };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(null); setOperations([]);
    void listOperations(workspaceId, target?.ref).then(items => { if (current) setOperations(items); }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "Could not load actions."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [workspaceId, target, refresh]);

  useEffect(() => {
    // A client-selected inspection can open the record directly. A message may
    // supply only its reference, never an operation or input to execute.
    // Unknown submitted actions always take precedence over a fresh inspection.
    if (!initialReadOperationId || initialReadStarted.current || restored || !target) return;
    const operation = operations.find(item => item.operation_id === initialReadOperationId);
    if (!operation || !operation.availability.available || operation.effects.mode !== "read"
      || !operation.target.resource_kinds.includes(target.ref.kind)
      || (Array.isArray(operation.input.schema.required) && operation.input.schema.required.length > 0)
      || (operation.target.expected_revision === "required" && !target.ref.revision)) return;
    initialReadStarted.current = true;
    let current = true;
    const initialInput = initialValue(operation.input.schema);
    setSelected(operation); setInput(initialInput); setBusy(true); setError(null);
    void invokeOperation(workspaceId, {
      operation_id: operation.operation_id, operation_version: operation.operation_version,
      input_schema_version: operation.input.version, target: {kind: target.ref.kind, id: target.ref.id},
      ...(operation.target.expected_revision !== "not_applicable" && target.ref.revision ? {expected_resource_revision: target.ref.revision} : {}),
      input: initialInput, idempotency_key: `app-inspect:${crypto.randomUUID()}`,
    }).then(result => { if (current) setReceipt(result); })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "Could not open this record."); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [workspaceId, operations, target, restored, initialReadOperationId]);

  function selectResource(ref: OperationResourceRef, label: string) {
    if (busy || uncertain) return;
    setTarget({ ref, label }); setSelected(null); setReceipt(null); setQuery(""); setCategory(""); setReviewing(false); pending.current = null;
  }
  async function selectOperation(operation: SemanticOperationDescriptor) {
    if (busy || uncertain) return;
    setSelected(operation); setInput(initialValue(operation.input.schema)); setReceipt(null); setError(null); setReviewing(false); pending.current = null;
    setResponseChoices(null);
    if (operation.operation_id !== responseOperation || target?.ref.kind !== "approval_request") return;
    setBusy(true);
    try {
      const inspect = operations.find(item => item.operation_id === "approval.inspect");
      if (!inspect?.availability.available) throw new Error("Inspect this approval before choosing its responding collaborator.");
      const inspected = await invokeOperation(workspaceId, {operation_id:inspect.operation_id, operation_version:inspect.operation_version,
        input_schema_version:inspect.input.version, target:{kind:target.ref.kind,id:target.ref.id},
        input:{}, idempotency_key:`app-action:${crypto.randomUUID()}`});
      const request = record(inspected.result) && record(inspected.result.request) ? inspected.result.request : null;
      if (inspected.state !== "completed" || typeof request?.context_id !== "string" || !record(request.resource_ref)
        || request.resource_ref.kind !== target.ref.kind || request.resource_ref.id !== target.ref.id
        || typeof request.resource_ref.revision !== "string") {
        throw new Error("This approval needs a conversation before a collaborator can respond to its decision.");
      }
      const [context, endpoints] = await Promise.all([getContext(request.context_id, workspaceId), listEndpoints(workspaceId)]);
      const available = endpoints.filter(endpoint => context.participants.includes(endpoint.endpoint_id) && endpoint.status !== "retired");
      setResponseChoices({response_participant_id:{label:"Responding collaborator", options:[
        {label:"No automatic response",value:null}, ...available.map(endpoint => ({label:endpoint.name,value:endpoint.endpoint_id})),
      ]}});
      setInput({response_participant_id:typeof request.response_participant_id === "string" ? request.response_participant_id : null});
      setTarget({ref:{kind:target.ref.kind,id:target.ref.id,revision:request.resource_ref.revision},label:target.label});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load responding collaborators.");
    } finally {setBusy(false);}
  }
  async function run() {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      // Once submitted, an uncertain action is retried with its exact original
      // intent and key. New schemas or changed input never alter that request.
      if (!pending.current) {
        const operationTarget = selected.target.resource_kinds.length ? target?.ref : undefined;
        const current = (await listOperations(workspaceId, operationTarget)).find(item => item.operation_id === selected.operation_id);
        if (!current) throw new Error("This action is no longer available. Refresh the actions.");
        if (!current.availability.available) throw new Error(current.availability.refusal.message);
        if (current.operation_version !== selected.operation_version || current.input.version !== selected.input.version || JSON.stringify(current.input.schema) !== JSON.stringify(selected.input.schema)
          || JSON.stringify(current.effects) !== JSON.stringify(selected.effects) || JSON.stringify(current.interaction_constraints) !== JSON.stringify(selected.interaction_constraints)) {
          setSelected(current); setInput(initialValue(current.input.schema)); setReviewing(false);
          throw new Error("This action changed. Review its current details before continuing.");
        }
        if (current.target.resource_kinds.length && !target) throw new Error("Select a record before using this action.");
        if (current.target.expected_revision === "required" && !target?.ref.revision) throw new Error("Open the latest record before changing it. Floe needs its current version.");
        const request: OperationInvocationRequest = {
          operation_id: current.operation_id, operation_version: current.operation_version, input_schema_version: current.input.version,
          target: operationTarget ? { kind: operationTarget.kind, id: operationTarget.id } : null,
          ...(current.target.expected_revision !== "not_applicable" && target?.ref.revision ? { expected_resource_revision: target.ref.revision } : {}),
          input, idempotency_key: `app-action:${crypto.randomUUID()}`,
        };
        retainPendingAction(workspaceId, { request, descriptor: current, target });
        pending.current = request;
        setSelected(current);
      }
      const request = pending.current;
      const confirmation = selected.interaction_constraints.confirmation;
      let result: OperationInvocationReceipt;
      if (record(confirmation) && confirmation.required === true) {
        const confirmed = await confirmAndInvokeOperation(workspaceId, request);
        if (!confirmed.confirmed) { clearPendingAction(workspaceId); pending.current = null; setUncertain(false); setReviewing(false); return; }
        result = confirmed.receipt;
      } else result = await invokeOperation(workspaceId, request);
      setReceipt(result); setUncertain(false); setReviewing(false); pending.current = null; clearPendingAction(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Floe could not return the action result.");
      // A refusal on a later retrieval cannot prove that the earlier dispatch
      // did not commit. Retain its intent until a receipt resolves the outcome.
      if (cause instanceof SemanticOperationError && !uncertain) { pending.current = null; clearPendingAction(workspaceId); setReviewing(false); }
      setUncertain(pending.current !== null);
    } finally { setBusy(false); }
  }

  const listed = operations.filter(item => (!category || item.category === category) && (!target || !item.target.resource_kinds.length || item.target.resource_kinds.includes(target.ref.kind)) && `${item.title} ${item.description} ${item.category}`.toLowerCase().includes(query.toLowerCase()));
  const confirmation = selected?.interaction_constraints.confirmation;
  const canRun = selected?.availability.available && (!selected.target.resource_kinds.length || !!target) && (selected.target.expected_revision !== "required" || !!target?.ref.revision)
    && (selected.operation_id !== responseOperation || responseChoices !== null);
  return createPortal(<div className="action-backdrop"><div className="action-panel" role="dialog" aria-modal="true" aria-labelledby="action-panel-title" ref={panel} onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter(node => !node.closest("fieldset:disabled"));
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header className="action-header"><div><h2 id="action-panel-title">Actions</h2><p>{target?.label ?? workspaceName}</p></div><button type="button" disabled={busy} onClick={onClose}>Close actions</button></header>
    <div className="action-body"><aside className="action-catalogue"><label htmlFor="action-search">Find an action</label><input id="action-search" type="search" value={query} disabled={busy || uncertain} onChange={event => setQuery(event.target.value)} />
      <label htmlFor="action-category">Category</label><select id="action-category" value={category} disabled={busy || uncertain} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{[...new Set(operations.map(item => item.category))].sort().map(item => <option key={item} value={item}>{words(item)}</option>)}</select>
      {target && <button type="button" disabled={busy || uncertain} onClick={() => { setTarget(undefined); setSelected(null); setReceipt(null); }}>Workspace actions</button>}
      <button type="button" disabled={loading || busy || uncertain} onClick={() => setRefresh(value => value + 1)}>Refresh actions</button>
      {loading ? <p role="status">Loading available actions…</p> : <p className="action-help">{listed.length} actions</p>}
      <nav aria-label="Available actions">{listed.map(item => <button key={item.operation_id} type="button" aria-pressed={selected?.operation_id === item.operation_id} disabled={busy || uncertain} onClick={() => selectOperation(item)}><strong>{item.title}</strong><span>{item.availability.available ? item.effects.mode === "read" ? "Inspect" : "Change" : item.availability.refusal.required_action?.title ?? "Unavailable"}</span></button>)}</nav>
    </aside><section className="action-content">
      {!selected && <p>Select an action to see what it does and what it needs. Actions use your current permissions.</p>}
      {selected && <><h2>{selected.title}</h2><p>{selected.description}</p>
        {!selected.availability.available && <p role="status">{selected.availability.refusal.message}</p>}
        {selected.target.resource_kinds.length > 0 && !target && <p>Choose a record from an action result or open Actions from that record.</p>}
        {selected.target.expected_revision === "required" && target && !target.ref.revision && <p>Inspect this record first, then use its returned action reference to change the current version.</p>}
        {selected.effects.external && <p>This action affects an external service.</p>}
        {selected.effects.mode === "write" && selected.effects.reversibility === "irreversible" && <p>This action records a permanent change.</p>}
        {record(confirmation) && confirmation.required === true && <p>{String(confirmation.description ?? "Floe requires a trusted confirmation for this action.")}</p>}
        {!receipt && <form onSubmit={event => { event.preventDefault(); if (selected.effects.mode === "write" && !reviewing && !uncertain) setReviewing(true); else void run(); }}>
          <fieldset disabled={busy || reviewing || uncertain}><SchemaFields key={`${selected.operation_id}:${selected.input.version}`} schema={selected.input.schema} value={input} onChange={setInput} fieldChoices={selected.operation_id === responseOperation ? responseChoices ?? undefined : target?.ref.kind === initialTarget?.ref.kind && target?.ref.id === initialTarget?.ref.id ? fieldChoices?.[selected.operation_id] : undefined} /></fieldset>
          {reviewing && <div className="action-review"><h3>Review action</h3><p>{selected.title} · {selected.target.resource_kinds.length ? target?.label : workspaceName}</p>{selected.operation_id === responseOperation && record(input)
            ? <p>Responding collaborator: {responseChoices?.response_participant_id.options.find(option => option.value === input.response_participant_id)?.label ?? "Unavailable"}</p>
            : <ActionResult value={input} schema={selected.input.schema} label="Your choices" onSelectResource={() => {}} />}<button type="button" onClick={() => setReviewing(false)} disabled={busy}>Edit choices</button></div>}
          <button type="submit" disabled={busy || (!canRun && !uncertain)}>{busy ? "Waiting for Floe…" : uncertain ? "Retrieve result / retry same action" : reviewing ? "Confirm action" : selected.effects.mode === "write" ? "Review action" : "Run action"}</button>
        </form>}
      </>}
      {error && <p role="alert">{error}</p>}
      {uncertain && <p role="status">The result is unknown. Retrieve it before starting another action. Your submitted request is retained for this browser session, including if you close Actions or reload. Retrying uses the same request to prevent duplicate changes.</p>}
      {receipt && selected && <section aria-label="Action result"><h3>{receipt.state === "completed" ? "Completed" : receipt.state === "refused" ? "Action refused" : "Work accepted — completion pending"}</h3>
        {receipt.refusal && <div role="alert"><p>{receipt.refusal.message}</p>{receipt.refusal.required_action && <p>{receipt.refusal.required_action.description}</p>}</div>}
        {receipt.result !== null && (selected.category === "approvals" ? <ApprovalResult workspaceId={workspaceId} result={receipt.result} schema={selected.result.schema} onSelectResource={selectResource} artefactLabels={artefactLabels} /> : <ActionResult value={receipt.result} schema={selected.result.schema} onSelectResource={selectResource} />)}
        {receipt.changed_refs.map(ref => <button key={`${ref.kind}:${ref.id}`} type="button" onClick={() => selectResource(ref, `${words(ref.kind)} from ${selected.title}`)}>Actions for {words(ref.kind).toLowerCase()}</button>)}
        {receipt.target && <button type="button" onClick={() => selectResource(receipt.target!, target?.label ?? words(receipt.target!.kind))}>Actions for inspected record</button>}
        {(receipt.state === "running" || receipt.state === "accepted") && <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(null); void getOperationReceipt(workspaceId, receipt.receipt_id).then(setReceipt).catch(cause => setError(cause instanceof Error ? cause.message : "Could not retrieve the action result.")).finally(() => setBusy(false)); }}>Check action result</button>}
        {receipt.cancel_ref && <button type="button" onClick={() => { const ref = receipt.cancel_ref!.target; if (ref) selectResource(ref, "Work in progress"); }}>Open work controls</button>}
        <details><summary>Action record</summary><p>{receipt.receipt_id}</p><p>{receipt.operation_id}</p><p>{receipt.completed_at ?? receipt.updated_at}</p></details>
        <button type="button" onClick={() => { setReceipt(null); setInput(initialValue(selected.input.schema)); setRefresh(value => value + 1); }}>Start another action</button>
      </section>}
    </section></div>
  </div></div>, document.body);
}
