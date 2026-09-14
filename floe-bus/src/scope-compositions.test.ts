import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyScopeSchema, ScopeStore } from "./scopes/store.js";
import {
  ScopeCompositionConflictError,
  ScopeCompositionImpactConflictError,
  ScopeCompositionImmutableError,
  ScopeCompositionInvalidError,
  ScopeCompositionStore,
  applyScopeCompositionSchema,
  inspectScopeCompositionValidation,
  simulateScopeComposition,
  type ScopeCompositionContent,
} from "./scope-compositions.js";
import { ScopeExecutionStore, applyScopeExecutionSchema } from "./scope-executions.js";

function content(actor = "actor:workspace:test:builder"): ScopeCompositionContent {
  return {
    nodes: [
      {
        node_id: "work-arrived",
        kind: "event",
        label: "Work arrived",
        config: { event_type: "work.arrived", source: { kind: "manual" } },
        context_policy: { mode: "new_per_execution" },
      },
      {
        node_id: "builder",
        kind: "actor",
        label: "Builder",
        resource_id: actor,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "reuse_by_key", key_template: "{{scope_execution_id}}:builder" },
      },
    ],
    ports: [
      {
        port_id: "work-arrived:out",
        node_id: "work-arrived",
        name: "arrived",
        direction: "output",
        event_types: ["work.arrived"],
      },
      {
        port_id: "builder:in",
        node_id: "builder",
        name: "work",
        direction: "input",
        event_types: ["work.arrived"],
        min_count: 1,
        max_count: 1,
      },
      {
        port_id: "builder:completed",
        node_id: "builder",
        name: "completed",
        direction: "output",
        event_types: ["work.completed"],
      },
    ],
    edges: [{
      edge_id: "arrival-to-builder",
      source_port_id: "work-arrived:out",
      target_port_id: "builder:in",
    }],
  };
}

describe("canonical Scope composition storage", () => {
  let db: DatabaseSync;
  let store: ScopeCompositionStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyScopeSchema(db);
    applyScopeCompositionSchema(db);
    applyScopeExecutionSchema(db);
    new ScopeStore(db).createScope({ workspace_id: "workspace:test", scope_id: "delivery", title: "Delivery" });
    store = new ScopeCompositionStore(db);
  });

  afterEach(() => db.close());

  it("publishes an immutable revision and atomically makes it current", () => {
    const draft = store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: content(),
      created_by_endpoint_id: "actor:workspace:test:floe",
    });
    expect(draft.published_at).toBeNull();
    expect(draft.routing_mode).toBe("edge");
    expect(draft.nodes).toHaveLength(2);
    expect(draft.ports).toHaveLength(3);
    expect(draft.edges).toEqual([
      expect.objectContaining({ edge_id: "arrival-to-builder", enabled: true }),
    ]);

    const published = store.publishDraft({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    });
    expect(published.published_at).toEqual(expect.any(String));
    expect(store.getPublishedRevision("workspace:test", "delivery")?.revision_id).toBe(draft.revision_id);
    expect(() => store.replaceDraft(draft.revision_id, content("actor:workspace:test:reviewer")))
      .toThrow(ScopeCompositionImmutableError);
  });

  it("keeps old published revisions exact when a new revision becomes current", () => {
    const first = store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: content(),
    });
    store.publishDraft({ revision_id: first.revision_id, expected_published_revision_id: null });

    const second = store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      based_on_revision_id: first.revision_id,
      content: content("actor:workspace:test:reviewer"),
    });
    store.publishDraft({
      revision_id: second.revision_id,
      expected_published_revision_id: first.revision_id,
    });

    expect(store.getPublishedRevision("workspace:test", "delivery")?.revision_id).toBe(second.revision_id);
    expect(store.getRevision(first.revision_id)?.nodes.find((node) => node.node_id === "builder")?.resource_id)
      .toBe("actor:workspace:test:builder");
    expect(store.listRevisions("workspace:test", "delivery").map((revision) => revision.revision_number))
      .toEqual([2, 1]);
  });

  it("refuses to publish over a current revision the caller did not inspect", () => {
    const first = store.createDraft({ workspace_id: "workspace:test", scope_id: "delivery", content: content() });
    store.publishDraft({ revision_id: first.revision_id, expected_published_revision_id: null });
    const second = store.createDraft({ workspace_id: "workspace:test", scope_id: "delivery", content: content() });
    expect(() => store.publishDraft({
      revision_id: second.revision_id,
      expected_published_revision_id: null,
    })).toThrow(ScopeCompositionConflictError);
  });

  it("validates explicit Port direction and contracts before storing an Edge", () => {
    const invalidDirection = content();
    invalidDirection.ports.find((port) => port.port_id === "work-arrived:out")!.direction = "input";
    expect(() => store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: invalidDirection,
    })).toThrow(ScopeCompositionInvalidError);

    const incompatible = content();
    incompatible.ports.find((port) => port.port_id === "builder:in")!.event_types = ["review.requested"];
    expect(() => store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: incompatible,
    })).toThrow(/incompatible Event contracts/);
  });

  it("refuses implicit, legacy-named, and internally inconsistent activation or Context policies", () => {
    const missingActivation = content();
    delete missingActivation.nodes.find((node) => node.node_id === "builder")!.activation;
    expect(() => store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: missingActivation,
    })).toThrow(/must declare an activation policy/);

    const obsoletePolicy = content();
    (obsoletePolicy.nodes.find((node) => node.node_id === "builder") as any).activation = { mode: "keyed_all" };
    expect(() => store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: obsoletePolicy,
    })).toThrow(/unsupported activation mode 'keyed_all'/);

    const implicitContext = content();
    (implicitContext.nodes.find((node) => node.node_id === "builder") as any).context_policy = { mode: "create" };
    expect(() => store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: implicitContext,
    })).toThrow(/unsupported Context mode 'create'/);

    const invalidDynamic = content();
    invalidDynamic.nodes.find((node) => node.node_id === "builder")!.activation = {
      mode: "keyed_gather",
      join_key: { source: "event_content", path: "batch_id" },
      expected_members: {
        mode: "from_collection",
        collection_port_id: "builder:in",
        member_port_id: "builder:in",
        member_key: { source: "event_content", path: "member_key" },
        match: "member_key_and_version",
      },
    };
    expect(() => store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: invalidDynamic,
    })).toThrow(/collection and member Ports must be different/);
  });

  it("validates and simulates a draft without writing execution state", () => {
    const draft = store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      content: content(),
    });
    const revisionsBefore = store.listRevisions("workspace:test", "delivery").length;
    const executionsBefore = Number((db.prepare(`SELECT COUNT(*) AS count FROM scope_executions`).get() as { count: number }).count);

    expect(inspectScopeCompositionValidation(draft, draft.routing_mode)).toEqual({
      valid: true,
      semantic_digest: draft.semantic_digest,
      diagnostics: [],
    });
    expect(simulateScopeComposition(draft, "work-arrived", "work-arrived:out")).toMatchObject({
      revision_id: draft.revision_id,
      reachable_node_ids: ["builder", "work-arrived"],
      reachable_edge_ids: ["arrival-to-builder"],
      steps: [{
        edge_id: "arrival-to-builder",
        source_node_id: "work-arrived",
        target_node_id: "builder",
        activation: { mode: "per_delivery" },
        context_policy: { mode: "reuse_by_key" },
      }],
    });
    expect(store.listRevisions("workspace:test", "delivery")).toHaveLength(revisionsBefore);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM scope_executions`).get() as { count: number }).count)
      .toBe(executionsBefore);
  });

  it("requires exact publication impact and rolls back without changing in-flight pins", () => {
    const executions = new ScopeExecutionStore(db);
    const first = store.createDraft({ workspace_id: "workspace:test", scope_id: "delivery", content: content() });
    const firstImpact = store.assessImpact(first.revision_id);
    store.publishDraft({
      revision_id: first.revision_id,
      expected_published_revision_id: null,
      expected_impact_digest: firstImpact.impact_digest,
    });
    const inFlight = executions.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: first.revision_id,
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const second = store.createDraft({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      based_on_revision_id: first.revision_id,
      content: content("actor:workspace:test:reviewer"),
    });
    expect(() => store.publishDraft({
      revision_id: second.revision_id,
      expected_published_revision_id: first.revision_id,
      expected_impact_digest: "stale-impact",
    })).toThrow(ScopeCompositionImpactConflictError);
    const secondImpact = store.assessImpact(second.revision_id);
    expect(secondImpact.active_execution_ids_pinned_to_current).toEqual([inFlight.execution_id]);
    store.publishDraft({
      revision_id: second.revision_id,
      expected_published_revision_id: first.revision_id,
      expected_impact_digest: secondImpact.impact_digest,
    });

    const rollbackImpact = store.assessImpact(first.revision_id);
    expect(rollbackImpact.active_execution_ids_pinned_to_target).toEqual([inFlight.execution_id]);
    store.rollbackPublishedRevision({
      target_revision_id: first.revision_id,
      expected_published_revision_id: second.revision_id,
      expected_impact_digest: rollbackImpact.impact_digest,
    });
    expect(store.getPublishedRevision("workspace:test", "delivery")?.revision_id).toBe(first.revision_id);
    expect(executions.getExecution(inFlight.execution_id)?.revision_id).toBe(first.revision_id);
    expect(store.getRevision(second.revision_id)?.published_at).not.toBeNull();
  });

  it("clones and portably exports/imports exact composition content without a template record", () => {
    new ScopeStore(db).createScope({ workspace_id: "workspace:test", scope_id: "target", title: "Target" });
    const source = store.createDraft({ workspace_id: "workspace:test", scope_id: "delivery", content: content() });
    const clone = store.cloneRevision({
      source_revision_id: source.revision_id,
      target_workspace_id: "workspace:test",
      target_scope_id: "target",
    });
    expect(clone).toMatchObject({
      scope_id: "target",
      based_on_revision_id: source.revision_id,
      semantic_digest: source.semantic_digest,
      published_at: null,
    });

    const portable = store.exportRevision(source.revision_id);
    expect(portable).toMatchObject({
      format: "floe.scope-composition",
      format_version: 1,
      semantic_digest: source.semantic_digest,
    });
    const imported = store.importRevision({
      target_workspace_id: "workspace:test",
      target_scope_id: "target",
      portable,
    });
    expect(imported.semantic_digest).toBe(source.semantic_digest);
    expect(imported.based_on_revision_id).toBeNull();
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name LIKE '%template%'
    `).get() as { count: number }).count).toBe(0);
  });
});
