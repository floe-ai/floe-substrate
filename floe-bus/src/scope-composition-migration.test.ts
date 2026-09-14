import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyScopeSchema, ScopeStore } from "./scopes/store.js";
import { applyScopeCompositionSchema, ScopeCompositionStore } from "./scope-compositions.js";
import {
  importLegacyScopeGraph,
  projectLegacyScopeGraph,
} from "./scope-composition-migration.js";
import type { ScopeGraphRecord } from "./scope-graphs.js";

function legacyGraph(): ScopeGraphRecord {
  return {
    graph_id: "graph_legacy",
    workspace_id: "workspace:test",
    scope_id: "concept-pipeline",
    context_id: "ctx_legacy",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    nodes: [
      {
        node_id: "concept-found",
        kind: "trigger",
        label: "Concept found",
        event_type: "concept.found",
        source: {
          kind: "folder",
          path: "concepts",
          extensions: [".png"],
          settle_ms: 250,
        },
      },
      {
        node_id: "registry-analyst",
        kind: "actor",
        label: "Registry analyst",
        endpoint_id: "actor:workspace:test:registry-analyst",
        event_types: ["concept.found"],
        bindings: [{ kind: "instructions", text: "Create the registry." }],
      },
      {
        node_id: "registry-check",
        kind: "command",
        label: "Registry check",
        endpoint_id: "actor:workspace:test:registry-check",
        event_types: ["registry.ready"],
        result_event_type: "registry.checked",
        command: "npm run check-registry -- {{manifest}}",
        inputs: [{ name: "manifest", content_key: "manifest_path", required: true }],
        outputs: [{ name: "passed", from: "passed" }],
      },
      {
        node_id: "reviewer",
        kind: "actor",
        endpoint_id: "actor:workspace:test:reviewer",
        event_types: ["registry.checked"],
      },
      {
        node_id: "observer",
        kind: "actor",
        endpoint_id: "actor:workspace:test:observer",
      },
    ],
  };
}

describe("legacy Scope graph migration", () => {
  let db: DatabaseSync;
  let store: ScopeCompositionStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyScopeSchema(db);
    applyScopeCompositionSchema(db);
    new ScopeStore(db).createScope({
      workspace_id: "workspace:test",
      scope_id: "concept-pipeline",
      title: "Concept pipeline",
    });
    store = new ScopeCompositionStore(db);
  });

  afterEach(() => db.close());

  it("preserves effective legacy node configuration and imports only declared Event routes", () => {
    const projection = projectLegacyScopeGraph(legacyGraph());

    expect(projection.content.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node_id: "concept-found",
        kind: "event",
        label: "Concept found",
        config: {
          event_type: "concept.found",
          source: { kind: "folder", path: "concepts", extensions: [".png"], settle_ms: 250 },
        },
        context_policy: { mode: "fixed", context_id: "ctx_legacy" },
      }),
      expect.objectContaining({
        node_id: "registry-analyst",
        kind: "actor",
        resource_id: "actor:workspace:test:registry-analyst",
        config: { event_types: ["concept.found"] },
        bindings: [{ kind: "instructions", text: "Create the registry." }],
      }),
      expect.objectContaining({
        node_id: "registry-check",
        kind: "command",
        resource_id: "actor:workspace:test:registry-check",
        config: {
          event_types: ["registry.ready"],
          result_event_type: "registry.checked",
          command: "npm run check-registry -- {{manifest}}",
          inputs: [{ name: "manifest", content_key: "manifest_path", required: true }],
          outputs: [{ name: "passed", from: "passed" }],
        },
      }),
      expect.objectContaining({
        node_id: "observer",
        config: { event_types: ["*"] },
      }),
    ]));

    expect(projection.content.edges.map((edge) => [edge.source_port_id, edge.target_port_id]))
      .toEqual(expect.arrayContaining([
        ["concept-found:event-out", "registry-analyst:events-in"],
        ["concept-found:event-out", "observer:events-in"],
        ["registry-check:result-out", "reviewer:events-in"],
        ["registry-check:result-out", "observer:events-in"],
      ]));
    expect(projection.content.edges).toHaveLength(4);
    expect(projection.content.edges.some((edge) => edge.source_port_id.startsWith("registry-analyst:")))
      .toBe(false);
    expect(projection.ambiguities).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "actor_output_contract_unknown", node_ids: ["registry-analyst"] }),
      expect.objectContaining({
        code: "subscription_source_unknown",
        node_ids: ["registry-check"],
        event_types: ["registry.ready"],
      }),
      expect.objectContaining({ code: "wildcard_subscription_has_unknown_sources", node_ids: ["observer"] }),
    ]));
  });

  it("does not assign a shared endpoint subscription to either duplicate placement", () => {
    const graph = legacyGraph();
    graph.nodes.push({
      node_id: "second-reviewer-placement",
      kind: "actor",
      endpoint_id: "actor:workspace:test:reviewer",
      event_types: ["concept.found"],
    });

    const projection = projectLegacyScopeGraph(graph);

    expect(projection.content.edges.some((edge) =>
      edge.target_port_id === "reviewer:events-in"
      || edge.target_port_id === "second-reviewer-placement:events-in"))
      .toBe(false);
    expect(projection.ambiguities).toContainEqual(expect.objectContaining({
      code: "duplicate_endpoint_placement",
      node_ids: ["reviewer", "second-reviewer-placement"],
    }));
  });

  it("creates and publishes one legacy revision once when retried", () => {
    const publish = vi.spyOn(store, "publishDraft");
    const first = importLegacyScopeGraph(store, legacyGraph(), {
      created_by_endpoint_id: "actor:workspace:test:floe",
    });
    const second = importLegacyScopeGraph(store, legacyGraph(), {
      created_by_endpoint_id: "actor:workspace:test:floe",
    });

    expect(first.created).toBe(true);
    expect(first.published_now).toBe(true);
    expect(first.revision.routing_mode).toBe("legacy_subscription");
    expect(first.revision.created_by_endpoint_id).toBe("actor:workspace:test:floe");
    expect(second.created).toBe(false);
    expect(second.published_now).toBe(false);
    expect(second.revision.revision_id).toBe(first.revision.revision_id);
    expect(second.is_current).toBe(true);
    expect(store.listRevisions("workspace:test", "concept-pipeline")).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("imports a changed legacy graph as a new immutable revision without republishing the old snapshot", () => {
    const original = legacyGraph();
    const first = importLegacyScopeGraph(store, original);
    const changed = legacyGraph();
    changed.updated_at = "2026-08-02T00:00:00.000Z";
    const analyst = changed.nodes.find((node) => node.node_id === "registry-analyst");
    if (analyst?.kind !== "actor") throw new Error("test fixture lost registry analyst");
    analyst.event_types = ["concept.changed"];

    const second = importLegacyScopeGraph(store, changed);
    const oldRetry = importLegacyScopeGraph(store, original);

    expect(second.revision.revision_id).not.toBe(first.revision.revision_id);
    expect(second.revision.based_on_revision_id).toBe(first.revision.revision_id);
    expect(store.getRevision(first.revision.revision_id)?.nodes
      .find((node) => node.node_id === "registry-analyst")?.config)
      .toEqual({ event_types: ["concept.found"] });
    expect(oldRetry.published_now).toBe(false);
    expect(oldRetry.is_current).toBe(false);
    expect(store.getPublishedRevision("workspace:test", "concept-pipeline")?.revision_id)
      .toBe(second.revision.revision_id);
    expect(store.listRevisions("workspace:test", "concept-pipeline")).toHaveLength(2);
  });
});
