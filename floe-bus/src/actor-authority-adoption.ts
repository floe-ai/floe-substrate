/**
 * @invariant An Actor's access that Floe itself issued (import policy or an
 * older local product policy) is only ever moved onto a person's root grant,
 * never widened: the same operations and targets, cut to what the root holds.
 * The move revokes the old grant in the same transaction. Access heading for
 * a lapse always has a standing notice that names the date.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ActorDefinitionStore } from "./actor-definitions.js";
import { inSavepoint, type CapabilityGrantRecord, type SqliteCapabilityGrantStore } from "./capability-grants.js";
import type { IdentityWorkspaceAuthorityRecord, IdentityWorkspaceAuthorityStore } from "./identity-workspace-authority.js";
import type { WorkspaceAccessStore } from "./workspace-access.js";

/** Evidence kinds that mark access Floe issued on nobody's behalf. */
const FLOE_ISSUED_EVIDENCE = new Set(["workspace_configuration_import_policy", "local_product_policy"]);

export const AUTOMATIC_ADOPTION_PRINCIPAL = "system:actor-access-adoption:v0.4.0";

export type ActorAccessMove = Readonly<{
  actor_id: string;
  workspace_id: string;
  identity_id: string;
  moved_grant_ids: readonly string[];
  issued_grant_ids: readonly string[];
  /** Operations the old access had that the person's root does not hold, so they were not carried over. */
  dropped_operation_ids: readonly string[];
  actor_definition_revision_id: string;
}>;

type Dependencies = Readonly<{
  db: DatabaseSync;
  grants: SqliteCapabilityGrantStore;
  actors: ActorDefinitionStore;
  authorities: IdentityWorkspaceAuthorityStore;
  access: WorkspaceAccessStore;
  identity_name: (identityId: string) => string;
  /** Operations a new Actor gets when a person gives it access and it has none. */
  default_actor_operation_ids: () => readonly string[];
  /** Lets the import continue from a revision that changed only grants. */
  accept_authority_only_revision: (actorId: string, revisionId: string) => void;
  now?: () => string;
}>;

export class ActorAccessAdoption {
  constructor(private readonly deps: Dependencies) {}

  /** The active authorities in a Workspace. Exactly one means its owner is not in doubt. */
  activeAuthorities(workspaceId: string): IdentityWorkspaceAuthorityRecord[] {
    return (this.deps.db.prepare(`
      SELECT authority_id FROM identity_workspace_authorities
      WHERE workspace_id = ? AND status = 'active' ORDER BY issued_at, authority_id
    `).all(workspaceId) as Array<{ authority_id: string }>)
      .map(row => this.deps.authorities.get(row.authority_id)!)
      .filter(record => this.deps.grants.isActiveGrant(this.deps.authorities.rootGrant(record)));
  }

  /** The Actor's live access that Floe issued on nobody's behalf and that no person's root carries yet. */
  movableGrants(actorId: string): CapabilityGrantRecord[] {
    const definition = this.deps.actors.getCurrentDefinition(actorId);
    if (!definition) return [];
    return definition.content.capability_grant_ids
      .map(id => this.deps.grants.getGrant(id))
      .filter((grant): grant is CapabilityGrantRecord => grant !== null
        && this.deps.grants.getDelegation(grant.grant_id) === null
        && grant.evidence.some(item => FLOE_ISSUED_EVIDENCE.has(item.kind))
        && this.deps.grants.isActiveGrant(grant));
  }

  /**
   * Move an Actor's Floe-issued access onto a person's root. When the Actor
   * holds no live access at all and `give_default` is set, it gets the default
   * Actor access from that root instead. Returns null when nothing changed.
   */
  adopt(input: Readonly<{
    actor_id: string;
    authority: IdentityWorkspaceAuthorityRecord;
    changed_by: string;
    give_default: boolean;
  }>): ActorAccessMove | null {
    const actor = this.deps.actors.getActor(input.actor_id);
    const definition = this.deps.actors.getCurrentDefinition(input.actor_id);
    if (!actor || actor.status !== "active" || !definition || actor.workspace_id !== input.authority.workspace_id) return null;
    const root = this.deps.authorities.rootGrant(input.authority);
    const movable = this.movableGrants(input.actor_id);
    const hasLiveAccess = definition.content.capability_grant_ids
      .some(id => { const grant = this.deps.grants.getGrant(id); return grant !== null && this.deps.grants.isActiveGrant(grant); });
    const plans = movable.length > 0
      ? movable.map(grant => ({ from: grant.grant_id, operation_ids: grant.operation_ids, targets: grant.targets }))
      : !hasLiveAccess && input.give_default
        ? [{ from: null, operation_ids: this.deps.default_actor_operation_ids(), targets: [] }]
        : [];
    if (plans.length === 0) return null;

    return inSavepoint(this.deps.db, () => {
      const issued: string[] = [];
      const dropped = new Set<string>();
      for (const plan of plans) {
        const kept = plan.operation_ids.filter(id => root.operation_ids.includes(id));
        for (const id of plan.operation_ids) if (!kept.includes(id)) dropped.add(id);
        if (kept.length === 0) continue;
        const grant = this.deps.grants.issueDependentGrant({
          grant_id: `capgrant_adopted_${digest([input.actor_id, plan.from ?? "default", root.grant_id])}`,
          source_grant_id: root.grant_id,
          principal_id: input.actor_id,
          operation_ids: kept,
          targets: plan.targets,
          evidence: [plan.from
            ? { kind: "actor_access_adoption", ref: plan.from }
            : { kind: "actor_access_default", ref: input.authority.authority_id }],
        });
        issued.push(grant.grant_id);
      }
      const movedIds = movable.map(grant => grant.grant_id);
      const draft = this.deps.actors.createDraft({
        actor_id: input.actor_id,
        created_by_principal_id: input.changed_by,
        definition: { ...definition.content, capability_grant_ids: [
          ...definition.content.capability_grant_ids.filter(id => !movedIds.includes(id)), ...issued,
        ] },
      });
      const published = this.deps.actors.publishDraft({
        actor_definition_revision_id: draft.actor_definition_revision_id,
        expected_current_revision_id: definition.actor_definition_revision_id,
        changed_by_principal_id: input.changed_by,
      });
      for (const id of movedIds) this.deps.grants.revokeGrant(id);
      this.deps.accept_authority_only_revision(input.actor_id, published.actor_definition_revision_id);
      const move: ActorAccessMove = {
        actor_id: input.actor_id, workspace_id: actor.workspace_id, identity_id: input.authority.identity_id,
        moved_grant_ids: movedIds, issued_grant_ids: issued, dropped_operation_ids: [...dropped].sort(),
        actor_definition_revision_id: published.actor_definition_revision_id,
      };
      this.recordMove(move, definition.content.label, input.changed_by, movable.length > 0);
      return move;
    });
  }

  /**
   * Startup migration. In a Workspace with exactly one person, that person is
   * the real owner of its Actors' Floe-issued access, so it moves onto their
   * root now. Elsewhere nothing moves; a person adopts it. Idempotent: access
   * already carried by a root is never moved again.
   */
  migrate(): ActorAccessMove[] {
    const moves: ActorAccessMove[] = [];
    for (const workspaceId of this.workspaceIds()) {
      const authorities = this.activeAuthorities(workspaceId);
      if (authorities.length === 1) {
        for (const actor of this.deps.actors.listActors(workspaceId)) {
          if (this.movableGrants(actor.actor_id).length === 0) continue;
          const move = this.adopt({ actor_id: actor.actor_id, authority: authorities[0]!,
            changed_by: AUTOMATIC_ADOPTION_PRINCIPAL, give_default: false });
          if (move) moves.push(move);
        }
      }
      this.noteLapses(workspaceId);
    }
    return moves;
  }

  /**
   * Keep one standing notice per Actor whose access ends on a date, naming the
   * date and what a person can do. Written as soon as the ending is known,
   * which is when the access is issued or found, so it always comes well
   * before the lapse.
   */
  noteLapses(workspaceId: string): void {
    for (const actor of this.deps.actors.listActors(workspaceId)) this.noteLapse(actor.actor_id);
  }

  noteLapse(actorId: string): void {
    const actor = this.deps.actors.getActor(actorId);
    if (!actor || actor.status !== "active") return;
    const definition = this.deps.actors.getCurrentDefinition(actorId);
    if (!definition) return;
    const ending = this.deps.grants
      .listActiveGrantsForPrincipalBoundary(actorId, { kind: "workspace", workspace_id: actor.workspace_id })
      .map(grant => ({ grant, ends: this.deps.grants.effectiveExpiry(grant.grant_id) }))
      .filter((item): item is { grant: CapabilityGrantRecord; ends: string } => item.ends !== null)
      .sort((a, b) => Date.parse(a.ends) - Date.parse(b.ends))[0];
    if (!ending) {
      // Nothing ends any more, so the standing warning no longer holds.
      this.deps.access.removeStandingNotice(`notice:actor-access-lapse:${actorId}`);
      return;
    }
    const date = ending.ends.slice(0, 10);
    const floeIssued = ending.grant.evidence.some(item => FLOE_ISSUED_EVIDENCE.has(item.kind))
      && this.deps.grants.getDelegation(ending.grant.grant_id) === null;
    this.deps.access.recordStandingNotice({
      record_id: `notice:actor-access-lapse:${actorId}`,
      workspace_id: actor.workspace_id,
      kind: "actor_access_lapsing",
      summary: floeIssued
        ? `${definition.content.label} loses its access to this workspace on ${date}, unless a person here adopts it.`
        : `${definition.content.label} loses some of its access to this workspace on ${date}, when the access it was given ends.`,
      principal_id: "system:actor-access-lapse",
    });
  }

  private recordMove(move: ActorAccessMove, label: string, changedBy: string, moved: boolean): void {
    const person = this.deps.identity_name(move.identity_id);
    const summary = moved
      ? `${label} now acts with ${person}'s access in this workspace. Nothing was added, and it no longer expires.`
      : `${label} was given access to this workspace by ${person}. It lasts until ${person}'s access is revoked.`;
    this.deps.access.recordStandingNotice({
      record_id: `notice:actor-access-moved:${move.actor_id}:${move.actor_definition_revision_id}`,
      workspace_id: move.workspace_id,
      kind: "actor_access_moved",
      summary: move.dropped_operation_ids.length > 0
        ? `${summary} ${person}'s own access does not include ${move.dropped_operation_ids.join(", ")}, so ${label} no longer has them.`
        : summary,
      principal_id: changedBy,
    });
  }

  private workspaceIds(): string[] {
    return (this.deps.db.prepare("SELECT DISTINCT workspace_id FROM actors WHERE status = 'active' ORDER BY workspace_id")
      .all() as Array<{ workspace_id: string }>).map(row => row.workspace_id);
  }
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}
