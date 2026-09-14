import { createHash } from "node:crypto";
import {
  ScopeCompositionStore,
  scopeCompositionDigest,
  type ScopeCompositionContent,
  type ScopeCompositionRevision,
  type ScopeEdge,
  type ScopeNodePlacement,
  type ScopePort,
} from "./scope-compositions.js";
import type { ScopeGraphNode, ScopeGraphRecord } from "./scope-graphs.js";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type LegacyScopeGraphAmbiguityCode =
  | "actor_output_contract_unknown"
  | "duplicate_endpoint_placement"
  | "subscription_source_unknown"
  | "wildcard_subscription_has_unknown_sources";

export type LegacyScopeGraphAmbiguity = {
  code: LegacyScopeGraphAmbiguityCode;
  message: string;
  node_ids: string[];
  event_types?: string[];
};

export type LegacyScopeGraphProjection = {
  source_graph_id: string;
  content: ScopeCompositionContent;
  ambiguities: LegacyScopeGraphAmbiguity[];
};

export type LegacyScopeGraphImportResult = LegacyScopeGraphProjection & {
  revision: ScopeCompositionRevision;
  created: boolean;
  published_now: boolean;
  is_current: boolean;
};

export class LegacyScopeGraphMigrationConflictError extends Error {
  readonly code = "E_LEGACY_SCOPE_GRAPH_MIGRATION_CONFLICT" as const;

  constructor(readonly revision_id: string) {
    super(`Legacy Scope graph migration revision '${revision_id}' does not match the requested graph snapshot.`);
    this.name = "LegacyScopeGraphMigrationConflictError";
  }
}

type KnownEventSource = {
  node_id: string;
  port_id: string;
  event_type: string;
};

function copyArray<T extends Record<string, unknown>>(items: T[] | undefined): T[] {
  return items?.map((item) => ({ ...item })) ?? [];
}

function effectiveEventTypes(node: Extract<ScopeGraphNode, { kind: "actor" | "command" }>): string[] {
  return [...(node.event_types ?? ["*"])];
}

function canonicalNodeIds(nodes: ScopeGraphNode[]): Map<string, string> {
  return new Map(nodes.map((node, index) => {
    if (STABLE_ID.test(node.node_id)) return [node.node_id, node.node_id];
    const digest = createHash("sha256").update(node.node_id).digest("hex").slice(0, 12);
    return [node.node_id, `legacy-node-${index + 1}-${digest}`];
  }));
}

function nodePlacement(
  graph: ScopeGraphRecord,
  node: ScopeGraphNode,
  nodeId: string,
): ScopeNodePlacement {
  const originalId = nodeId === node.node_id ? {} : { legacy_node_id: node.node_id };
  const common: Pick<ScopeNodePlacement, "node_id" | "label" | "activation" | "context_policy"> = {
    node_id: nodeId,
    ...(node.label === undefined ? {} : { label: node.label }),
    activation: {
      mode: "legacy_subscription",
      graph_id: graph.graph_id,
    },
    context_policy: {
      mode: "fixed",
      context_id: graph.context_id,
    },
  };

  if (node.kind === "trigger") {
    return {
      ...common,
      kind: "event",
      config: {
        ...originalId,
        event_type: node.event_type,
        ...(node.source === undefined
          ? {}
          : {
              source: {
                ...node.source,
                ...(node.source.extensions === undefined
                  ? {}
                  : { extensions: [...node.source.extensions] }),
              },
            }),
      },
    };
  }

  if (node.kind === "actor") {
    return {
      ...common,
      kind: "actor",
      resource_id: node.endpoint_id,
      config: {
        ...originalId,
        event_types: effectiveEventTypes(node),
      },
      bindings: node.bindings?.map((binding) => ({ ...binding })) ?? [],
    };
  }

  return {
    ...common,
    kind: "command",
    resource_id: node.endpoint_id,
    config: {
      ...originalId,
      event_types: effectiveEventTypes(node),
      result_event_type: node.result_event_type ?? "command.result",
      command: node.command,
      inputs: copyArray(node.inputs),
      outputs: copyArray(node.outputs),
    },
  };
}

function duplicateEndpointNodes(graph: ScopeGraphRecord): Map<string, ScopeGraphNode[]> {
  const byEndpoint = new Map<string, ScopeGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "actor" && node.kind !== "command") continue;
    const placements = byEndpoint.get(node.endpoint_id) ?? [];
    placements.push(node);
    byEndpoint.set(node.endpoint_id, placements);
  }
  return new Map([...byEndpoint].filter(([, placements]) => placements.length > 1));
}

function migrationRevisionId(graph: ScopeGraphRecord, digest: string): string {
  const identity = createHash("sha256")
    .update(`${graph.workspace_id}\0${graph.scope_id}\0${graph.graph_id}\0${digest}`)
    .digest("hex")
    .slice(0, 32);
  return `legacy-revision-${identity}`;
}

/**
 * Converts one stored legacy graph snapshot without consulting mutable Context
 * subscriptions. The legacy graph itself is the import boundary: explicit
 * Trigger outputs and Command result outputs may be connected to matching
 * subscriptions; Actor output routes cannot be recovered and are never guessed.
 */
export function projectLegacyScopeGraph(graph: ScopeGraphRecord): LegacyScopeGraphProjection {
  const nodeIds = canonicalNodeIds(graph.nodes);
  const duplicates = duplicateEndpointNodes(graph);
  const duplicateEndpoints = new Set(duplicates.keys());
  const ambiguities: LegacyScopeGraphAmbiguity[] = [];
  const nodes = graph.nodes.map((node) => nodePlacement(graph, node, nodeIds.get(node.node_id) as string));
  const ports: ScopePort[] = [];
  const edges: ScopeEdge[] = [];
  const sources: KnownEventSource[] = [];

  for (const [endpointId, placements] of duplicates) {
    ambiguities.push({
      code: "duplicate_endpoint_placement",
      message: `Endpoint '${endpointId}' appears in more than one legacy Node; its single Context subscription cannot identify a placement.`,
      node_ids: placements.map((node) => nodeIds.get(node.node_id) as string),
    });
  }

  for (const node of graph.nodes) {
    const nodeId = nodeIds.get(node.node_id) as string;
    if (node.kind === "trigger") {
      const portId = `${nodeId}:event-out`;
      ports.push({
        port_id: portId,
        node_id: nodeId,
        name: node.event_type,
        direction: "output",
        event_types: [node.event_type],
        min_count: 0,
        max_count: null,
      });
      sources.push({ node_id: nodeId, port_id: portId, event_type: node.event_type });
      continue;
    }

    const eventTypes = effectiveEventTypes(node);
    ports.push({
      port_id: `${nodeId}:events-in`,
      node_id: nodeId,
      name: "Subscribed Events",
      direction: "input",
      event_types: eventTypes,
      min_count: 0,
      max_count: null,
    });

    if (node.kind === "actor") {
      ambiguities.push({
        code: "actor_output_contract_unknown",
        message: `Actor Node '${node.node_id}' has no declared output Event contract, so no outgoing route was imported.`,
        node_ids: [nodeId],
      });
      continue;
    }

    const resultEventType = node.result_event_type ?? "command.result";
    const resultPortId = `${nodeId}:result-out`;
    ports.push({
      port_id: resultPortId,
      node_id: nodeId,
      name: resultEventType,
      direction: "output",
      event_types: [resultEventType],
      min_count: 0,
      max_count: null,
    });
    if (!duplicateEndpoints.has(node.endpoint_id)) {
      sources.push({ node_id: nodeId, port_id: resultPortId, event_type: resultEventType });
    }
  }

  for (const node of graph.nodes) {
    if (node.kind !== "actor" && node.kind !== "command") continue;
    const nodeId = nodeIds.get(node.node_id) as string;
    const eventTypes = effectiveEventTypes(node);
    if (duplicateEndpoints.has(node.endpoint_id)) continue;

    const matchingSources = sources.filter((source) =>
      eventTypes.includes("*") || eventTypes.includes(source.event_type));
    for (const source of matchingSources) {
      edges.push({
        edge_id: `${source.node_id}:to:${nodeId}:${edges.length + 1}`,
        source_port_id: source.port_id,
        target_port_id: `${nodeId}:events-in`,
        enabled: true,
        priority: edges.length,
        policy: {
          mode: "legacy_subscription",
          context_id: graph.context_id,
          event_type: source.event_type,
        },
      });
    }

    if (eventTypes.includes("*")) {
      ambiguities.push({
        code: "wildcard_subscription_has_unknown_sources",
        message: `Node '${node.node_id}' subscribes to every Event; only declared Trigger and Command outputs can be displayed.`,
        node_ids: [nodeId],
        event_types: ["*"],
      });
      continue;
    }

    const unresolved = eventTypes.filter((eventType) =>
      !sources.some((source) => source.event_type === eventType));
    if (unresolved.length > 0) {
      ambiguities.push({
        code: "subscription_source_unknown",
        message: `Node '${node.node_id}' subscribes to Event type(s) with no declared legacy Trigger or Command source.`,
        node_ids: [nodeId],
        event_types: unresolved,
      });
    }
  }

  return {
    source_graph_id: graph.graph_id,
    content: { nodes, ports, edges },
    ambiguities,
  };
}

/**
 * Imports and publishes a legacy snapshot once. Its deterministic identity is
 * based on graph identity plus semantic content, so retrying the same snapshot
 * is inert while a later mutation becomes a new immutable revision.
 */
export function importLegacyScopeGraph(
  store: ScopeCompositionStore,
  graph: ScopeGraphRecord,
  options: { created_by_endpoint_id?: string | null } = {},
): LegacyScopeGraphImportResult {
  const projection = projectLegacyScopeGraph(graph);
  const digest = scopeCompositionDigest(projection.content);
  const revisionId = migrationRevisionId(graph, digest);
  let revision = store.getRevision(revisionId);
  let created = false;

  if (!revision) {
    const current = store.getPublishedRevision(graph.workspace_id, graph.scope_id);
    try {
      revision = store.createDraft({
        revision_id: revisionId,
        workspace_id: graph.workspace_id,
        scope_id: graph.scope_id,
        routing_mode: "legacy_subscription",
        based_on_revision_id: current?.revision_id ?? null,
        created_by_endpoint_id: options.created_by_endpoint_id ?? null,
        content: projection.content,
      });
      created = true;
    } catch (error) {
      revision = store.getRevision(revisionId);
      if (!revision) throw error;
    }
  }

  if (
    revision.workspace_id !== graph.workspace_id
    || revision.scope_id !== graph.scope_id
    || revision.routing_mode !== "legacy_subscription"
    || revision.semantic_digest !== digest
  ) {
    throw new LegacyScopeGraphMigrationConflictError(revisionId);
  }

  let publishedNow = false;
  if (!revision.published_at) {
    const current = store.getPublishedRevision(graph.workspace_id, graph.scope_id);
    revision = store.publishDraft({
      revision_id: revision.revision_id,
      expected_published_revision_id: current?.revision_id ?? null,
    });
    publishedNow = true;
  }

  return {
    ...projection,
    revision,
    created,
    published_now: publishedNow,
    is_current: store.getPublishedRevision(graph.workspace_id, graph.scope_id)?.revision_id === revision.revision_id,
  };
}
