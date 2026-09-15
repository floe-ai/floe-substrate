import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyActorDefinitionSchema } from "./actor-definitions.js";
import {
  ActorRoleAuthorityStore,
  ActorRoleAuthorityValidationError,
} from "./actor-role-authority.js";
import { applyContextSchema, ContextStore } from "./contexts/store.js";
import { ScopeCompositionStore, applyScopeCompositionSchema } from "./scope-compositions.js";
import { applyScopeExecutionSchema } from "./scope-executions.js";
import { applyScopeSchema, ScopeStore } from "./scopes/store.js";

const WORKSPACE = "workspace:roles";
const ACTOR = "actor:reviewer";
const PRINCIPAL = "principal:reviewer-login";

describe("canonical Actor role authority", () => {
  let db: DatabaseSync;
  let now: string;
  let authority: ActorRoleAuthorityStore;
  let contexts: ContextStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    now = "2026-09-04T01:00:00.000Z";
    applyContextSchema(db);
    applyScopeSchema(db);
    applyScopeCompositionSchema(db);
    applyScopeExecutionSchema(db);
    applyActorDefinitionSchema(db);
    db.prepare(`
      INSERT INTO actors (
        actor_id, workspace_id, status, current_definition_revision_id,
        created_at, updated_at, retired_at
      ) VALUES (?, ?, 'active', NULL, ?, ?, NULL)
    `).run(ACTOR, WORKSPACE, now, now);
    authority = new ActorRoleAuthorityStore(db, { now: () => now });
    contexts = new ContextStore(db, () => now);
  });

  afterEach(() => db.close());

  it("derives Workspace, Scope, Context and exact revision-local executor roles from retained state", () => {
    const scopes = new ScopeStore(db);
    scopes.createScope({ workspace_id: WORKSPACE, scope_id: "scope:release", title: "Release" });
    const compositions = new ScopeCompositionStore(db);
    const draft = compositions.createDraft({
      workspace_id: WORKSPACE,
      scope_id: "scope:release",
      revision_id: "revision:release:1",
      content: {
        nodes: [
          {
            node_id: "ingress",
            kind: "event",
            label: "Ready",
            context_policy: { mode: "new_per_execution" },
          },
          {
            node_id: "review",
            kind: "actor",
            label: "Review",
            resource_id: ACTOR,
            activation: { mode: "per_delivery" },
            context_policy: { mode: "new_per_execution" },
          },
        ],
        ports: [
          { port_id: "ready", node_id: "ingress", name: "Ready", direction: "output" },
          {
            port_id: "review-input",
            node_id: "review",
            name: "Review",
            direction: "input",
            min_count: 1,
          },
        ],
        edges: [{ edge_id: "ready-to-review", source_port_id: "ready", target_port_id: "review-input" }],
      },
    });
    const revision = compositions.publishDraft({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    });
    const contextId = contexts.createContext({
      workspace_id: WORKSPACE,
      scope_id: "scope:release",
      context_id: "context:review",
      created_by_endpoint_id: null,
      created_by_principal_id: "principal:coordinator",
      participants: [{ participant_id: ACTOR, role: "verifier", access: "manage" }],
    });
    const principalBinding = authority.bindPrincipal({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      actor_id: ACTOR,
      bound_by_principal_id: "principal:coordinator",
      evidence_refs: [{ kind: "operation_invocation", id: "invocation:bind-reviewer", revision: null }],
      principal_actor_binding_id: "principal-actor:reviewer",
    });
    authority.assignRole({
      workspace_id: WORKSPACE,
      actor_id: ACTOR,
      role: "operator",
      boundary: { kind: "workspace", workspace_id: WORKSPACE },
      assigned_by_principal_id: "principal:coordinator",
      actor_role_assignment_id: "role:workspace:operator",
    });
    authority.assignRole({
      workspace_id: WORKSPACE,
      actor_id: ACTOR,
      role: "approver",
      boundary: { kind: "scope", scope_id: "scope:release" },
      assigned_by_principal_id: "principal:coordinator",
      actor_role_assignment_id: "role:scope:approver",
    });

    db.prepare(`
      INSERT INTO scope_executions (
        execution_id, workspace_id, scope_id, revision_id,
        ingress_node_id, ingress_port_id, state_revision, status,
        environment_json, budget_json, terminal_json, created_at
      ) VALUES ('execution:release', ?, 'scope:release', ?, 'ingress', 'ready', 1,
        'active', '{}', '{}', '{}', ?)
    `).run(WORKSPACE, revision.revision_id, now);
    db.prepare(`
      INSERT INTO node_executions (
        node_execution_id, execution_id, revision_id, node_id, activation_key,
        context_id, state_revision, status, assigned_actor_ids_json,
        failure_json, created_at
      ) VALUES ('node-execution:review', 'execution:release', ?, 'review', 'one', ?, 1,
        'waiting_external', ?, '{"code":"approval_decision_pending"}', ?)
    `).run(revision.revision_id, contextId, JSON.stringify([ACTOR]), now);

    now = "2026-09-04T01:01:00.000Z";
    const resolved = authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { node_execution_id: "node-execution:review" },
    });

    expect(resolved.actor_ids).toEqual([ACTOR]);
    expect(resolved.roles).toEqual(["approver", "executor", "operator", "verifier"]);
    expect(resolved.resolved_target).toEqual({
      scope_id: "scope:release",
      scope_composition_revision_id: revision.revision_id,
      node_placement_id: "review",
      node_execution_id: "node-execution:review",
      context_id: contextId,
    });
    expect(resolved.evidence.find((item) => item.role === "executor")).toMatchObject({
      principal_binding_ref: { id: principalBinding.principal_actor_binding_id },
      role_source_ref: {
        kind: "scope_composition_revision",
        id: revision.revision_id,
        revision: revision.semantic_digest,
      },
      source_boundary: {
        kind: "node_execution",
        id: "node-execution:review",
        scope_composition_revision_id: revision.revision_id,
        node_placement_id: "review",
      },
    });
    expect(authority.validateResolutionEvidence(resolved, {
      at: resolved.resolved_at,
      require_current: true,
    })).toMatchObject({ valid: true });
    const stableEvidenceDigest = resolved.evidence_digest;
    now = "2026-09-04T01:02:00.000Z";
    expect(authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { node_execution_id: "node-execution:review" },
    }).evidence_digest).toBe(stableEvidenceDigest);
  });

  it("fails closed without an explicit principal-to-Actor binding and invalidates current reuse after revocation", () => {
    new ScopeStore(db).createScope({ workspace_id: WORKSPACE, scope_id: "scope:release", title: "Release" });
    authority.assignRole({
      workspace_id: WORKSPACE,
      actor_id: ACTOR,
      role: "approver",
      boundary: { kind: "scope", scope_id: "scope:release" },
      assigned_by_principal_id: "principal:coordinator",
      actor_role_assignment_id: "role:scope:approver",
    });
    expect(authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { scope_id: "scope:release" },
    }).roles).toEqual([]);

    authority.bindPrincipal({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      actor_id: ACTOR,
      bound_by_principal_id: "principal:coordinator",
      evidence_refs: [{ kind: "operation_invocation", id: "invocation:bind-reviewer", revision: null }],
      principal_actor_binding_id: "principal-actor:reviewer",
    });
    now = "2026-09-04T01:01:00.000Z";
    const resolved = authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { scope_id: "scope:release" },
    });
    expect(resolved.roles).toEqual(["approver"]);

    now = "2026-09-04T01:02:00.000Z";
    authority.revokeRoleAssignment({
      workspace_id: WORKSPACE,
      actor_role_assignment_id: "role:scope:approver",
      revoked_by_principal_id: "principal:coordinator",
      reason: "Reviewer rotated",
    });
    expect(authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { scope_id: "scope:release" },
    }).roles).toEqual([]);
    expect(authority.validateResolutionEvidence(resolved, {
      at: resolved.resolved_at,
    })).toMatchObject({ valid: true });
    expect(authority.validateResolutionEvidence(resolved, {
      require_current: true,
    })).toMatchObject({ valid: false });
  });

  it("rejects an ambiguous NodePlacement target without its exact composition revision", () => {
    expect(() => authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { node_placement_id: "review" },
    })).toThrowError(ActorRoleAuthorityValidationError);
  });

  it("invalidates Context role evidence when canonical participation is removed", () => {
    const contextId = contexts.createContext({
      workspace_id: WORKSPACE,
      context_id: "context:review",
      created_by_endpoint_id: null,
      created_by_principal_id: "principal:coordinator",
      participants: [{ participant_id: ACTOR, role: "verifier", access: "contribute" }],
    });
    authority.bindPrincipal({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      actor_id: ACTOR,
      bound_by_principal_id: "principal:coordinator",
      evidence_refs: [{ kind: "operation_invocation", id: "invocation:bind-reviewer", revision: null }],
    });
    now = "2026-09-04T01:01:00.000Z";
    const resolved = authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { context_id: contextId },
    });
    expect(resolved.roles).toEqual(["verifier"]);

    now = "2026-09-04T01:02:00.000Z";
    expect(contexts.removeParticipant(contextId, ACTOR, "principal:coordinator")).toBe(true);
    expect(authority.resolveCurrent({
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      target: { context_id: contextId },
    }).roles).toEqual([]);
    expect(authority.validateResolutionEvidence(resolved, { require_current: true }))
      .toMatchObject({ valid: false });
  });

  it("migrates an existing Actor Context role into retained role authority without changing collaboration", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      applyContextSchema(legacy);
      applyActorDefinitionSchema(legacy);
      legacy.prepare(`
        INSERT INTO actors (
          actor_id, workspace_id, status, current_definition_revision_id,
          created_at, updated_at, retired_at
        ) VALUES (?, ?, 'active', NULL, ?, ?, NULL)
      `).run(ACTOR, WORKSPACE, now, now);
      legacy.prepare(`
        INSERT INTO contexts (
          context_id, workspace_id, scope_id, created_by_endpoint_id,
          created_by_principal_id, created_at, updated_at, state_revision, lifecycle_state
        ) VALUES ('context:legacy', ?, 'scope:legacy', NULL, 'principal:legacy', ?, ?, 1, 'active')
      `).run(WORKSPACE, now, now);
      legacy.prepare(`
        INSERT INTO context_participants (
          context_id, endpoint_id, role, access, joined_at, updated_at
        ) VALUES ('context:legacy', ?, 'quality_judge', 'contribute', ?, ?)
      `).run(ACTOR, now, now);

      const migrated = new ActorRoleAuthorityStore(legacy, { now: () => now });
      const participant = new ContextStore(legacy, () => now)
        .getContextParticipantRecords("context:legacy")[0];
      expect(participant).toMatchObject({
        participant_id: ACTOR,
        role: "quality_judge",
        access: "contribute",
      });
      expect(participant?.actor_role_assignment_id).toBeTruthy();
      expect(migrated.requireRoleAssignment(participant!.actor_role_assignment_id!)).toMatchObject({
        actor_id: ACTOR,
        role: "quality_judge",
        boundary: { kind: "context", context_id: "context:legacy" },
        status: "active",
      });
    } finally {
      legacy.close();
    }
  });

  it("adds retained evidence to pre-evidence principal bindings", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      applyActorDefinitionSchema(legacy);
      legacy.prepare(`
        INSERT INTO actors (
          actor_id, workspace_id, status, current_definition_revision_id,
          created_at, updated_at, retired_at
        ) VALUES (?, ?, 'active', NULL, ?, ?, NULL)
      `).run(ACTOR, WORKSPACE, now, now);
      legacy.exec(`
        CREATE TABLE principal_actor_bindings (
          principal_actor_binding_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          bound_by_principal_id TEXT NOT NULL,
          bound_at TEXT NOT NULL,
          revoked_by_principal_id TEXT,
          revoked_at TEXT,
          revocation_reason TEXT
        )
      `);
      legacy.prepare(`
        INSERT INTO principal_actor_bindings (
          principal_actor_binding_id, workspace_id, principal_id, actor_id,
          bound_by_principal_id, bound_at
        ) VALUES ('principal-binding:legacy', ?, ?, ?, 'principal:legacy', ?)
      `).run(WORKSPACE, PRINCIPAL, ACTOR, now);

      const migrated = new ActorRoleAuthorityStore(legacy, { now: () => now })
        .requirePrincipalBinding("principal-binding:legacy");
      expect(migrated.evidence_refs).toEqual([{
        kind: "legacy_authority_import",
        id: "principal-binding:legacy",
        revision: `bound:${now}`,
      }]);
    } finally {
      legacy.close();
    }
  });
});
