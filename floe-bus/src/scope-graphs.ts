/**
 * Legacy mutable Scope graph compatibility.
 *
 * This record predates canonical ScopeCompositionRevision, Port, Edge and
 * ScopeExecution storage. It inferred routing from one shared Context and its
 * subscriptions. That model is retained only to inspect and migrate existing
 * v0.1.x Workspaces; new pipeline topology must use `scope-compositions.ts`
 * and `scope-executions.ts`.
 *
 * Context membership and subscriptions remain valid for collaboration and
 * deliberate non-graph pub/sub. They never define or advance canonical Scope
 * execution. A revision uses either explicit Edge routing or this identified
 * legacy mode, never both.
 *
 * `graph_id` is therefore a legacy storage handle, not a user-facing primitive
 * and not proof of the current published Scope plan.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Binding } from "./bindings.js";

export type ScopeGraphTriggerNode = {
  node_id: string;
  kind: "trigger";
  label?: string;
  /** Event type stamped on the emission this node causes when fired. */
  event_type: string;
  /** Optional world ingress owned by this event node. */
  source?: {
    kind: "folder";
    path: string;
    /** Optional case-insensitive file extensions accepted by this source. */
    extensions?: string[];
    /** Quiet period used to coalesce native filesystem notifications. */
    settle_ms?: number;
  };
};

export type ScopeGraphActorNode = {
  node_id: string;
  kind: "actor";
  label?: string;
  endpoint_id: string;
  /** Event types this actor wakes for within the graph's Context. Defaults to ["*"]. */
  event_types?: string[];
  /**
   * Node-specific material given to the actor for turns arising from this
   * node, e.g. `{ kind: "instructions", text: "..." }`. Distinct from the
   * actor's own general instructions file: this is what the actor is
   * supposed to be doing AS this node, in this graph — never baked into the
   * actor's identity, never hardcoded per graph. See bindings.ts.
   */
  bindings?: Binding[];
};

export type ScopeGraphCommandInput = {
  /** Placeholder name usable in `command` as `{{name}}`. */
  name: string;
  /** Key read from the triggering event's `content`. */
  content_key: string;
  required?: boolean;
};

export type ScopeGraphCommandOutput = {
  /** Content key the result is emitted under. */
  name: string;
  /** Which raw execution fact this output renames. */
  from: "exit_code" | "passed" | "stdout" | "stderr";
};

export type ScopeGraphCommandNode = {
  node_id: string;
  kind: "command";
  label?: string;
  endpoint_id: string;
  /** Event types this node wakes for within the graph's Context. Defaults to ["*"]. */
  event_types?: string[];
  /** Event type stamped on the result this node emits. Defaults to "command.result". */
  result_event_type?: string;
  /** Shell command to run. May reference `inputs[].name` as `{{name}}` placeholders. */
  command: string;
  /** Named parameters resolved from the triggering event's `content` before running. */
  inputs?: ScopeGraphCommandInput[];
  /** Named fields the result is exposed as. With none declared, the raw execution facts (exit_code, passed, stdout, stderr) are emitted as-is. */
  outputs?: ScopeGraphCommandOutput[];
};

export type ScopeGraphNode = ScopeGraphTriggerNode | ScopeGraphActorNode | ScopeGraphCommandNode;

export type ScopeGraphRecord = {
  graph_id: string;
  workspace_id: string;
  scope_id: string;
  /** The Context that ties this graph's nodes together — the wiring, not a separate edge record. */
  context_id: string;
  nodes: ScopeGraphNode[];
  created_at: string;
  updated_at: string;
};

export class ScopeGraphNotFoundError extends Error {
  readonly code = "E_SCOPE_GRAPH_NOT_FOUND" as const;
  constructor(readonly workspace_id: string, readonly graph_id: string) {
    super(`Scope graph not found: ${graph_id}`);
    this.name = "ScopeGraphNotFoundError";
  }
}

export class ScopeGraphInvalidError extends Error {
  readonly code = "E_SCOPE_GRAPH_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid scope graph: ${reason}`);
    this.name = "ScopeGraphInvalidError";
  }
}

export class ScopeGraphNodeNotFoundError extends Error {
  readonly code = "E_SCOPE_GRAPH_NODE_NOT_FOUND" as const;
  constructor(readonly graph_id: string, readonly node_id: string) {
    super(`Scope graph '${graph_id}' has no node '${node_id}'`);
    this.name = "ScopeGraphNodeNotFoundError";
  }
}

export class ScopeGraphNodeNotATriggerError extends Error {
  readonly code = "E_SCOPE_GRAPH_NODE_NOT_A_TRIGGER" as const;
  constructor(readonly graph_id: string, readonly node_id: string) {
    super(`Scope graph '${graph_id}' node '${node_id}' is not a trigger node`);
    this.name = "ScopeGraphNodeNotATriggerError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function applyScopeGraphSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope_graphs (
      graph_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scope_graphs_scope
      ON scope_graphs(workspace_id, scope_id, created_at ASC);
  `);
}

export function validateScopeGraphNodes(nodes: ScopeGraphNode[]): void {
  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.node_id)) {
      throw new ScopeGraphInvalidError(`duplicate node id '${node.node_id}'`);
    }
    seenNodeIds.add(node.node_id);
    if (node.kind === "actor" && !node.endpoint_id) {
      throw new ScopeGraphInvalidError(`actor node '${node.node_id}' is missing endpoint_id`);
    }
    if (node.kind === "actor" && node.bindings) {
      for (const binding of node.bindings) {
        if (binding.kind === "instructions" && !binding.text) {
          throw new ScopeGraphInvalidError(`actor node '${node.node_id}' has an instructions binding missing text`);
        }
      }
    }
    if (node.kind === "trigger" && !node.event_type) {
      throw new ScopeGraphInvalidError(`trigger node '${node.node_id}' is missing event_type`);
    }
    if (node.kind === "command") {
      if (!node.endpoint_id) {
        throw new ScopeGraphInvalidError(`command node '${node.node_id}' is missing endpoint_id`);
      }
      if (!node.command) {
        throw new ScopeGraphInvalidError(`command node '${node.node_id}' is missing command`);
      }
    }
  }
}

/**
 * Pure node-list + Context-id persistence. Realising the wiring (participants,
 * subscriptions) is the caller's job (BusStore.createScopeGraph), using
 * ContextStore — the existing primitive — not this store.
 */
export class ScopeGraphStore {
  constructor(readonly db: DatabaseSync) {}

  listScopeGraphs(workspaceId: string, scopeId: string): ScopeGraphRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scope_graphs WHERE workspace_id = ? AND scope_id = ? ORDER BY created_at ASC
    `).all(workspaceId, scopeId) as any[];
    return rows.map((row) => this.rowToGraph(row));
  }

  /** All retained legacy graphs in a Workspace, used for migration evidence and remaining Event-source/Actor bindings. */
  listScopeGraphsForWorkspace(workspaceId: string): ScopeGraphRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scope_graphs WHERE workspace_id = ? ORDER BY created_at ASC
    `).all(workspaceId) as any[];
    return rows.map((row) => this.rowToGraph(row));
  }

  getScopeGraph(workspaceId: string, graphId: string): ScopeGraphRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM scope_graphs WHERE workspace_id = ? AND graph_id = ?
    `).get(workspaceId, graphId) as any;
    return row ? this.rowToGraph(row) : null;
  }

  getScopeGraphForScope(workspaceId: string, scopeId: string): ScopeGraphRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM scope_graphs
      WHERE workspace_id = ? AND scope_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(workspaceId, scopeId) as any;
    return row ? this.rowToGraph(row) : null;
  }

  insertScopeGraph(input: {
    workspace_id: string;
    scope_id: string;
    context_id: string;
    nodes: ScopeGraphNode[];
  }): ScopeGraphRecord {
    validateScopeGraphNodes(input.nodes);
    const graphId = `graph_${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scope_graphs (
        graph_id, workspace_id, scope_id, context_id, nodes_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      graphId,
      input.workspace_id,
      input.scope_id,
      input.context_id,
      JSON.stringify(input.nodes),
      timestamp,
      timestamp
    );
    return this.getScopeGraph(input.workspace_id, graphId) as ScopeGraphRecord;
  }

  updateScopeGraph(input: {
    workspace_id: string;
    graph_id: string;
    nodes: ScopeGraphNode[];
  }): ScopeGraphRecord {
    validateScopeGraphNodes(input.nodes);
    this.db.prepare(`
      UPDATE scope_graphs
      SET nodes_json = ?, updated_at = ?
      WHERE workspace_id = ? AND graph_id = ?
    `).run(JSON.stringify(input.nodes), nowIso(), input.workspace_id, input.graph_id);
    return this.getScopeGraph(input.workspace_id, input.graph_id) as ScopeGraphRecord;
  }

  private rowToGraph(row: any): ScopeGraphRecord {
    return {
      graph_id: String(row.graph_id),
      workspace_id: String(row.workspace_id),
      scope_id: String(row.scope_id),
      context_id: String(row.context_id),
      nodes: JSON.parse(row.nodes_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }
}
