import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EndpointRef, NodeExecutionRecord, ScopeCompositionRevision, ScopeEdge, ScopeExecutionProjection, ScopeNodePlacement, ScopePort } from "../../bus-client/types.ts";
import { CanonicalArtefactDetail } from "./CanonicalArtefactDetail.tsx";
import { ActionsButton } from "../actions/ActionsButton.tsx";
import { nodeExecutionStateRevision } from "../../../../floe-bus/src/scope-execution-contract.ts";
import { pipelineInputs, pipelineOutputs, usePipelineActorNames, usePipelinePreviews, type PipelineArtefact, type PipelinePreview } from "./pipelinePreviews.ts";
import "./ScopePipelineFocusView.css";
export type CanonicalPipelineRoute = {
  edge: ScopeEdge;
  sourcePort: ScopePort;
  targetPort: ScopePort;
  sourceNode: ScopeNodePlacement;
  targetNode: ScopeNodePlacement;
};

export type CanonicalPipelineNode = {
  node: ScopeNodePlacement;
  inputs: ScopePort[];
  outputs: ScopePort[];
  executions: NodeExecutionRecord[];
};

export type CanonicalPipelineProjection = {
  nodes: CanonicalPipelineNode[];
  routes: CanonicalPipelineRoute[];
};

/**
 * Builds the operator projection from the immutable plan and canonical
 * execution records only. Context membership, Event subscriptions, and file
 * paths never create a Node, Edge, execution, or Artifact relationship here.
 */
export function buildCanonicalScopePipelineProjection(
  revision: ScopeCompositionRevision,
  executionProjection?: ScopeExecutionProjection | null,
): CanonicalPipelineProjection {
  if (executionProjection && executionProjection.execution.revision_id !== revision.revision_id) {
    throw new Error("The selected execution does not belong to the displayed plan revision.");
  }
  const portsById = new Map(revision.ports.map((port) => [port.port_id, port]));
  const nodesById = new Map(revision.nodes.map((node) => [node.node_id, node]));
  const nodes = revision.nodes.map((node) => ({
    node,
    inputs: revision.ports.filter((port) => port.node_id === node.node_id && port.direction === "input"),
    outputs: revision.ports.filter((port) => port.node_id === node.node_id && port.direction === "output"),
    executions: (executionProjection?.node_executions ?? [])
      .filter((execution) => execution.node_id === node.node_id && execution.revision_id === revision.revision_id)
      .sort((left, right) => left.created_at.localeCompare(right.created_at)),
  }));
  const routes = revision.edges.flatMap((edge) => {
    if (edge.enabled === false) return [];
    const sourcePort = portsById.get(edge.source_port_id);
    const targetPort = portsById.get(edge.target_port_id);
    const sourceNode = sourcePort ? nodesById.get(sourcePort.node_id) : null;
    const targetNode = targetPort ? nodesById.get(targetPort.node_id) : null;
    return sourcePort && targetPort && sourceNode && targetNode
      ? [{ edge, sourcePort, targetPort, sourceNode, targetNode }]
      : [];
  });
  return { nodes, routes };
}

function labelForNode(node: ScopeNodePlacement, endpoints: EndpointRef[]): string {
  return node.label?.trim() || endpoints.find(endpoint => endpoint.endpoint_id === node.resource_id)?.name || kindLabel(node);
}

function kindLabel(node: ScopeNodePlacement): string {
  return ({ event: "Event", actor: "Work step", command: "Command", context: "Context", scope: "Scope", capability: "Capability", connector: "Connector" })[node.kind];
}

function statusLabel(status?: string): string {
  return ({ active: "Working", waiting_external: "Waiting for a response", waiting_human: "Needs your input", paused: "Paused", retrying: "Retrying", blocked: "Blocked", superseded: "Replaced", failed: "Needs attention", cancelled: "Stopped", completed: "Complete", ready: "Ready", collecting: "Waiting for inputs" } as Record<string, string>)[status ?? ""] ?? "Planned";
}

type Selection = { nodeId: string; nodeExecutionId: string | null };
type LayerCard = { key: string; route: CanonicalPipelineRoute; item: CanonicalPipelineNode; execution: NodeExecutionRecord | null };
type Link = { key: string; from: string; to: string; edgeId: string; label: string };

export function outputReachesExecution(output: PipelineArtefact, execution: NodeExecutionRecord, route: CanonicalPipelineRoute, selected: NodeExecutionRecord, projection: ScopeExecutionProjection): boolean {
  // A shared filename/version alone cannot establish a route. Require its exact Delivery.
  const publications = new Set(selected.publications.filter(publication => publication.port_id === output.portId
    && [...(publication.artefact_version_ids ?? []), ...(publication.outputs ?? []).map(item => item.artefact_version_id)].includes(output.versionId))
    .map(publication => publication.publication_id));
  const deliveries = new Set(projection.traversals.filter(traversal => traversal.edge_id === route.edge.edge_id
    && publications.has(traversal.publication_id) && traversal.target_node_execution_id === execution.node_execution_id).map(traversal => traversal.delivery_id));
  return execution.inputs.some(input => deliveries.has(input.delivery_id) && input.artefact_version_id === output.versionId
    && input.port_id === route.targetPort.port_id && (!output.memberKey || input.member_key === output.memberKey));
}

function PipelineConnections({ layout, links, layoutKey }: { layout: React.RefObject<HTMLDivElement>; links: Link[]; layoutKey: string }): React.ReactElement {
  const [paths, setPaths] = useState<Array<Link & { d: string; x: number; y: number }>>([]);
  const linkKey = JSON.stringify(links);
  useLayoutEffect(() => {
    const element = layout.current;
    if (!element) return;
    const connections = JSON.parse(linkKey) as Link[];
    let frame = 0;
    function measure() {
      if (!element) return;
      const origin = element.getBoundingClientRect();
      const cards = [...element.querySelectorAll<HTMLElement>("[data-pipeline-card]")];
      const next = connections.flatMap(link => {
        const from = cards.find(card => card.dataset.pipelineCard === link.from)?.getBoundingClientRect();
        const to = cards.find(card => card.dataset.pipelineCard === link.to)?.getBoundingClientRect();
        if (!from?.width || !to?.width) return [];
        const vertical = Math.abs(to.left - from.left) < 8;
        const x1 = (vertical ? from.left + from.width / 2 : from.right) - origin.left;
        const y1 = (vertical ? from.bottom : from.top + from.height / 2) - origin.top;
        const x2 = (vertical ? to.left + to.width / 2 : to.left) - origin.left;
        const y2 = (vertical ? to.top : to.top + to.height / 2) - origin.top;
        const d = vertical ? `M ${x1} ${y1} C ${x1} ${(y1+y2)/2}, ${x2} ${(y1+y2)/2}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2} ${y2}`;
        return [{ ...link, d, x: (x1+x2)/2, y: (y1+y2)/2 }];
      });
      setPaths(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    element.querySelectorAll("[data-pipeline-card]").forEach(card => observer?.observe(card));
    element.addEventListener("load", schedule, true);
    window.addEventListener("resize", schedule);
    measure();
    return () => { observer?.disconnect(); cancelAnimationFrame(frame); element.removeEventListener("load", schedule, true); window.removeEventListener("resize", schedule); };
  }, [layout, linkKey, layoutKey]);
  return <svg className="pf-lines" aria-hidden="true">
    {paths.map(path => <g key={path.key}><path className="pf-line" data-edge-id={path.edgeId} d={path.d} /></g>)}
  </svg>;
}

function ArtefactTile({ reference, preview, selected = false, onSelect, compact = false }: {
  reference: PipelineArtefact; preview?: PipelinePreview; selected?: boolean; onSelect?: () => void; compact?: boolean;
}): React.ReactElement {
  const name = preview?.name ?? (reference.memberKey || "Loading saved output…");
  const content = <>{preview?.image ? <img src={preview.image} alt={name} /> : <span className="pf-file-icon" aria-hidden="true">{preview?.mediaType.startsWith("image/") ? "▧" : "▤"}</span>}<span>{name}</span></>;
  return onSelect
    ? <button className={`pf-file ${preview?.image && !compact ? "pf-file-image" : ""}`} type="button" aria-label={`Open ${name}`} aria-pressed={selected} title={preview?.error ?? name} onClick={onSelect} data-version-id={reference.versionId}>{content}</button>
    : <span className={`pf-file ${preview?.image && !compact ? "pf-file-image" : ""}`} title={preview?.error ?? name}>{content}</span>;
}

function NodeCard({ item, execution, endpoints, previews, actorNamesByRevision, cardKey, mode, onFollow, onOpenVersion, onOpenContext, selectedOutput, onSelectOutput }: {
  item: CanonicalPipelineNode; execution: NodeExecutionRecord | null; endpoints: EndpointRef[]; previews: Map<string, PipelinePreview>; actorNamesByRevision: Map<string, string>;
  cardKey: string; mode: "focus" | "previous" | "next"; onFollow?: () => void; onOpenVersion: (id: string) => void;
  onOpenContext?: (id: string) => void; selectedOutput?: string | null; onSelectOutput?: (key: string) => void;
}): React.ReactElement {
  const [allInputs, setAllInputs] = useState(false);
  const inputs = pipelineInputs(execution);
  const outputs = pipelineOutputs(execution);
  const hero = item.node.kind === "event" ? [...outputs, ...inputs].find(ref => previews.get(ref.versionId)?.image)
    : mode === "next" ? inputs.find(ref => previews.get(ref.versionId)?.image) : null;
  const actorIds = execution?.assigned_actor_ids.length ? execution.assigned_actor_ids : item.node.kind === "actor" && item.node.resource_id ? [item.node.resource_id] : [];
  const pinnedName = execution?.actor_definition_revision_id ? actorNamesByRevision.get(execution.actor_definition_revision_id) : null;
  const actorNames = actorIds.map(id => pinnedName || endpoints.find(endpoint => endpoint.endpoint_id === id)?.name || "Assigned actor");
  const description = typeof item.node.config?.description === "string" ? item.node.config.description : null;
  const name = labelForNode(item.node, endpoints);
  const inputLimit = mode === "next" ? 1 : mode === "focus" && allInputs ? inputs.length : 6;
  const body = <>
    {hero && <img className="pf-node-image" src={previews.get(hero.versionId)!.image} alt={previews.get(hero.versionId)!.name} />}
    <span className="pf-node-body">
      <span className="pf-card-top"><span className="pf-kind">{kindLabel(item.node)}</span><span className={`pf-status pf-status-${execution?.status ?? "planned"}`}>{statusLabel(execution?.status)}</span></span>
      <strong className="pf-title">{name}</strong>
      {description && <span className="pf-subtitle">{description}</span>}
      {actorNames.map((actor, index) => <span key={`${actor}:${index}`} className="pf-actor-chip"><span aria-hidden="true">A</span> Actor · {actor}</span>)}
      {inputs.length > 0 && <span className="pf-section"><span className="pf-section-label">{inputs.length === 1 ? "Input" : "Inputs"}</span><span className="pf-files">
        {inputs.slice(0, inputLimit).map(ref => <ArtefactTile key={`${ref.portId}:${ref.versionId}:${ref.memberKey}`} reference={ref} preview={previews.get(ref.versionId)} compact onSelect={mode === "focus" ? () => onOpenVersion(ref.versionId) : undefined} />)}
        {inputs.length > inputLimit && (mode === "focus" ? <button type="button" className="pf-show-more" onClick={() => setAllInputs(true)}>Show {inputs.length - inputLimit} more inputs</button> : <span className="pf-subtitle">+{inputs.length - inputLimit} more inputs · open this step to inspect</span>)}
      </span></span>}
      {mode !== "next" && <span className="pf-section"><span className="pf-section-label">{item.node.kind === "event" ? "Attached artefacts" : "Outputs in this run"}{outputs.length > 1 && mode === "focus" ? " · choose a branch" : ""}</span>
        {outputs.length ? <span className={outputs.some(ref => previews.get(ref.versionId)?.image) ? "pf-sheet-picker" : "pf-files"}>
          {outputs.map(ref => { const key = `${ref.portId}:${ref.versionId}:${ref.memberKey}`; return <ArtefactTile key={key} reference={ref} preview={previews.get(ref.versionId)} selected={selectedOutput === key} compact={mode !== "focus"} onSelect={mode === "focus" ? () => { onSelectOutput?.(key); } : undefined} />; })}
        </span> : <span className="pf-subtitle">{execution ? execution.publications.length ? "This step published a signal without attached outputs." : "No output has been published yet." : "Outputs appear here when this step runs."}</span>}
      </span>}
      {mode === "next" && <span className="pf-next-arrow">Follow this step →</span>}
      {mode !== "next" && <span className="pf-card-meta">
        {mode === "focus" && execution && onOpenContext ? <button type="button" className="pf-context-action" onClick={() => onOpenContext(execution.context_id)}>Open conversation</button> : <span>{mode === "previous" ? "Open this step" : "Not started"}</span>}
        <span>{outputs.length ? `${outputs.length} ${outputs.length === 1 ? "output" : "outputs"}` : statusLabel(execution?.status)}</span>
      </span>}
    </span>
  </>;
  return mode === "focus"
    ? <article className={`pf-node focus ${item.node.kind}`} data-pipeline-card={cardKey} data-node-kind={item.node.kind}>{body}</article>
    : <button type="button" className={`pf-node ${mode} ${item.node.kind}`} data-pipeline-card={cardKey} data-node-kind={item.node.kind} onClick={onFollow} aria-label={`Follow ${name} · ${statusLabel(execution?.status)}`}>{body}</button>;
}

export function ScopePipelineFocusView({ workspaceId, revision, executionProjection, endpoints, onOpenContext }: {
  workspaceId: string; revision: ScopeCompositionRevision; executionProjection?: ScopeExecutionProjection | null;
  endpoints: EndpointRef[]; onOpenContext?: (contextId: string) => void;
}): React.ReactElement {
  const projection = useMemo(() => buildCanonicalScopePipelineProjection(revision, executionProjection), [executionProjection, revision]);
  const initial = useMemo(() => {
    const first = projection.nodes.find(item => item.node.node_id === executionProjection?.execution.ingress_node_id)
      ?? projection.nodes.find(item => !projection.routes.some(route => route.targetNode.node_id === item.node.node_id)) ?? projection.nodes[0];
    return first ? { nodeId: first.node.node_id, nodeExecutionId: first.executions.at(-1)?.node_execution_id ?? null } : null;
  }, [projection, executionProjection]);
  const [trail, setTrail] = useState<Selection[]>(() => initial ? [initial] : []);
  const [selectedOutput, setSelectedOutput] = useState<string | null>(null);
  const [openedVersion, setOpenedVersion] = useState<string | null>(null);
  const [branchLimit, setBranchLimit] = useState(12);
  const layout = useRef<HTMLDivElement>(null);
  const selection = trail.at(-1) ?? initial;
  const selected = projection.nodes.find(item => item.node.node_id === selection?.nodeId) ?? null;
  const selectedExecution = selected?.executions.find(execution => execution.node_execution_id === selection?.nodeExecutionId) ?? null;
  const publications = new Set(selectedExecution?.publications.map(publication => publication.publication_id) ?? []);
  const previous: LayerCard[] = selected ? projection.routes.filter(route => route.targetNode.node_id === selected.node.node_id).map(route => {
    const traversal = executionProjection?.traversals.find(item => item.edge_id === route.edge.edge_id && item.target_node_execution_id === selectedExecution?.node_execution_id);
    const item = projection.nodes.find(candidate => candidate.node.node_id === route.sourceNode.node_id)!;
    const execution = item.executions.find(candidate => candidate.publications.some(publication => publication.publication_id === traversal?.publication_id)) ?? null;
    return { key: `previous:${route.edge.edge_id}`, route, item, execution };
  }) : [];
  const next: LayerCard[] = selected ? projection.routes.filter(route => route.sourceNode.node_id === selected.node.node_id).flatMap<LayerCard>(route => {
    const item = projection.nodes.find(candidate => candidate.node.node_id === route.targetNode.node_id)!;
    const ids = new Set(executionProjection?.traversals.filter(traversal => traversal.edge_id === route.edge.edge_id && publications.has(traversal.publication_id)).map(traversal => traversal.target_node_execution_id));
    const actual = item.executions.filter(execution => ids.has(execution.node_execution_id));
    return actual.length ? actual.map(execution => ({ key: `next:${route.edge.edge_id}:${execution.node_execution_id}`, route, item, execution }))
      : [{ key: `next:${route.edge.edge_id}`, route, item, execution: null }];
  }) : [];
  const outputs = pipelineOutputs(selectedExecution);
  const chosen = outputs.find(ref => `${ref.portId}:${ref.versionId}:${ref.memberKey}` === selectedOutput);
  const matching = chosen && selectedExecution && executionProjection ? next.filter(card => card.execution && outputReachesExecution(chosen, card.execution, card.route, selectedExecution, executionProjection)) : next;
  const visibleNext = matching.slice(0, branchLimit);
  const visibleExecutions = [selectedExecution, ...previous.map(card => card.execution), ...visibleNext.map(card => card.execution)];
  const actorNamesByRevision = usePipelineActorNames(workspaceId, visibleExecutions);
  const previews = usePipelinePreviews(workspaceId, visibleExecutions.flatMap(execution => [...pipelineInputs(execution), ...pipelineOutputs(execution)].map(ref => ref.versionId)));
  const links: Link[] = [...previous.map(card => ({ key: card.key, from: card.key, to: "focus", edgeId: card.route.edge.edge_id, label: card.route.sourcePort.name })),
    ...visibleNext.map(card => ({ key: card.key, from: "focus", to: card.key, edgeId: card.route.edge.edge_id, label: card.route.sourcePort.name }))];
  function follow(nodeId: string, nodeExecutionId: string | null) {
    setTrail(current => {
      const found = current.findIndex(item => item.nodeId === nodeId && item.nodeExecutionId === nodeExecutionId);
      return found >= 0 ? current.slice(0, found + 1) : [...current, { nodeId, nodeExecutionId }];
    });
    setSelectedOutput(null); setOpenedVersion(null); setBranchLimit(12);
  }
  useEffect(() => { setOpenedVersion(null); }, [selection?.nodeId, selection?.nodeExecutionId]);
  if (!selected) return <div className="pf-empty">This plan has no steps yet.</div>;
  const chosenName = chosen ? previews.get(chosen.versionId)?.name ?? "selected output" : "";
  const shared = { endpoints, previews, actorNamesByRevision, onOpenVersion: setOpenedVersion, onOpenContext };
  return <section className="scope-pipeline-focus" aria-label="Focused Scope pipeline">
    <div className="pf-scroll">
    <div className="pf-nav"><nav className="pf-breadcrumb" aria-label="Current pipeline path">
      {trail.map((item, index) => { const node = projection.nodes.find(candidate => candidate.node.node_id === item.nodeId); return node && <React.Fragment key={`${item.nodeId}:${index}`}>
        {index > 0 && <span aria-hidden="true">›</span>}<button className="pf-crumb" type="button" aria-current={index === trail.length - 1 ? "step" : undefined} onClick={() => { setTrail(trail.slice(0, index + 1)); setSelectedOutput(null); setBranchLimit(12); }}>{labelForNode(node.node, endpoints)}</button>
      </React.Fragment>; })}
    </nav><div className="pf-legend"><span>Event</span><span>Work</span><span>Artefact</span></div></div>
    <div className="pf-canvas">
      <p className="pf-stage-label">{chosen ? `Following ${chosenName}.` : "Follow the work one step at a time. Select an output to explore its branches."}</p>
      <div className={`pf-layout ${visibleNext.length > 1 ? "branch-view" : ""} ${previous.length === 0 ? "source-view" : ""}`} ref={layout}>
        <PipelineConnections layout={layout} links={links} layoutKey={`${selection?.nodeId}:${selection?.nodeExecutionId}:${previews.size}:${selectedOutput}`} />
        <section className="pf-upstream" aria-label="Previous pipeline layer">{previous.length ? previous.map(card => <NodeCard key={card.key} {...shared} item={card.item} execution={card.execution} cardKey={card.key} mode="previous" onFollow={() => follow(card.item.node.node_id, card.execution?.node_execution_id ?? null)} />) : <span className="pf-empty-upstream">Start of this path</span>}</section>
        <section className="pf-focus" aria-label="Focused pipeline step">
          <NodeCard {...shared} item={selected} execution={selectedExecution} cardKey="focus" mode="focus" selectedOutput={selectedOutput} onSelectOutput={key => setSelectedOutput(current => current === key ? null : key)} />
          {chosen && <div className="pf-output-actions"><button type="button" onClick={() => setOpenedVersion(chosen.versionId)}>Open {chosenName}</button><button type="button" onClick={() => setSelectedOutput(null)}>Show all branches</button></div>}
          {selectedExecution && <details className="pf-evidence"><summary>Work details</summary>
            <ActionsButton workspaceId={workspaceId} target={{ kind: "node_execution", id: selectedExecution.node_execution_id, revision: nodeExecutionStateRevision(selectedExecution) }} label={labelForNode(selected.node, endpoints)} caption="Actions for this step"
              fieldChoices={{ "scope.node-output.publish": { port_id: { label: "Output", options: selected.outputs.map(port => ({ value: port.port_id, label: port.name })) } } }} />
            {selected.executions.length > 1 && <label>Recorded work at this step <select aria-label="Step execution" value={selectedExecution.node_execution_id} onChange={event => follow(selected.node.node_id, event.target.value)}>
              {selected.executions.map((execution, index) => <option key={execution.node_execution_id} value={execution.node_execution_id}>Run {index + 1} · {statusLabel(execution.status)} · {new Date(execution.created_at).toLocaleString()}</option>)}
            </select></label>}
            <dl><dt>Context</dt><dd>{selectedExecution.context_id}</dd><dt>Attempts</dt><dd>{selectedExecution.attempts.length}</dd><dt>Inputs</dt><dd>{selectedExecution.inputs.length}</dd><dt>Published outputs</dt><dd>{selectedExecution.publications.length}</dd></dl>
            {selectedExecution.attempts.map(attempt => <p key={attempt.attempt_id}>Attempt {attempt.ordinal} · {attempt.status}</p>)}
            {[...pipelineInputs(selectedExecution), ...outputs].map((ref, index) => <button key={`${ref.versionId}:${index}`} type="button" onClick={() => setOpenedVersion(ref.versionId)}>Inspect exact version {ref.versionId}</button>)}
          </details>}
        </section>
        <section className="pf-next-layer" aria-label="Next pipeline layer"><div className="pf-next-heading"><strong>Next layer</strong><span>{matching.length > 1 ? `${matching.length} branches` : matching.length === 1 ? "One step ahead" : ""}</span></div>
          <div className={visibleNext.length > 1 ? "pf-branch-grid" : "pf-next-single"}>{visibleNext.map(card => <NodeCard key={card.key} {...shared} item={card.item} execution={card.execution} cardKey={card.key} mode="next" onFollow={() => follow(card.item.node.node_id, card.execution?.node_execution_id ?? null)} />)}</div>
          {matching.length > branchLimit && <button className="pf-show-more" type="button" onClick={() => setBranchLimit(value => value + 12)}>Show {Math.min(12, matching.length - branchLimit)} more branches</button>}
          {matching.length === 0 && <p className="pf-end-state">{chosen ? "No recorded downstream work uses this exact output yet." : "End of this path. Published outputs remain available in this step."}</p>}
        </section>
      </div>
    </div>
    </div>
    {openedVersion && <aside className="pf-detail-panel" aria-label="Selected output" onKeyDown={event => { if (event.key === "Escape") setOpenedVersion(null); }}><header><strong>{previews.get(openedVersion)?.name ?? "Saved output"}</strong><button autoFocus type="button" onClick={() => setOpenedVersion(null)}>Close output</button></header><div className="pf-detail-content"><CanonicalArtefactDetail key={openedVersion} workspaceId={workspaceId} artefactVersionId={openedVersion} onOpenContext={onOpenContext} /></div></aside>}
  </section>;
}
