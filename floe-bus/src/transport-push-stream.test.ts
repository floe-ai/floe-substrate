import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InvalidTransportPushCursorError,
  TransportPushStreamStore,
  decodeTransportPushCursor,
} from "./transport-push-stream.js";
import {
  ActorDefinitionStore,
  type ActorDefinitionContent,
} from "./actor-definitions.js";

const actorDefinition: ActorDefinitionContent = {
  label: "Builder",
  charter: "Build the requested outcome.",
  responsibilities: [],
  instructions: "Build and verify.",
  knowledge_refs: [],
  capability_grant_ids: [],
  policy_refs: { budget: null, trust: null, approval: null },
  escalation_rules: [],
};

describe("transport push stream", () => {
  let db: DatabaseSync;
  let stream: TransportPushStreamStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    stream = new TransportPushStreamStore(db);
  });

  afterEach(() => db.close());

  it("persists an opaque ordered cursor and filters catch-up to one Workspace", () => {
    const first = stream.append({ workspace_id: "workspace:one", type: "changed", payload: { value: 1 } });
    stream.append({ workspace_id: "workspace:two", type: "changed", payload: { value: 2 } });
    const third = stream.append({ workspace_id: "workspace:one", type: "changed", payload: { value: 3 } });

    expect(first.cursor).not.toBe("1");
    expect(decodeTransportPushCursor(first.cursor)).toBe(1);
    expect(stream.listAfter({
      after_cursor: first.cursor,
      workspace_id: "workspace:one",
    })).toEqual([third]);
  });

  it("rejects a malformed cursor rather than falling back to a full replay", () => {
    expect(() => stream.listAfter({ after_cursor: "not-a-cursor" }))
      .toThrow(InvalidTransportPushCursorError);
  });

  it("advances a durable Bridge checkpoint only after an explicit monotonic acknowledgement", () => {
    const first = stream.append({ workspace_id: "workspace:one", type: "one", payload: {} });
    const second = stream.append({ workspace_id: "workspace:one", type: "two", payload: {} });

    expect(stream.getBridgeCheckpoint("bridge:desktop")).toBeNull();
    expect(stream.acknowledgeBridge("bridge:desktop", second.cursor)).toBe(second.cursor);
    expect(stream.acknowledgeBridge("bridge:desktop", first.cursor)).toBe(second.cursor);

    const reopened = new TransportPushStreamStore(db);
    expect(reopened.getBridgeCheckpoint("bridge:desktop")).toBe(second.cursor);
  });

  it("promotes Actor create, publish, and retire outbox records once in order", () => {
    const actors = new ActorDefinitionStore(db, () => "2026-09-29T12:00:00.000Z");
    const created = actors.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_in_context_id: "context:task",
      created_in_scope_execution_id: "scope-execution:task",
      created_by_principal_id: "principal:operator",
      definition: actorDefinition,
    });
    const published = actors.publishDraft({
      actor_definition_revision_id: created.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    actors.setActorStatus({
      actor_id: created.actor.actor_id,
      status: "retired",
      expected_current_definition_revision_id: published.actor_definition_revision_id,
    });

    const entries = stream.drainActorLifecycleOutbox();
    expect(entries.map((entry) => entry.type)).toEqual([
      "actor_created",
      "actor_definition_published",
      "actor_retired",
    ]);
    expect(entries[0]?.payload).toMatchObject({
      workspace_id: "workspace:one",
      actor: {
        actor_id: "actor:builder",
        created_in_context_id: "context:task",
        created_in_scope_execution_id: "scope-execution:task",
      },
    });
    expect(stream.drainActorLifecycleOutbox()).toEqual([]);
    expect(stream.listAfter({ workspace_id: "workspace:one" })).toEqual(entries);
  });
});
