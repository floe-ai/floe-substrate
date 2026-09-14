import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  CommandDefinitionConflictError,
  CommandDefinitionDraftConflictError,
  CommandDefinitionImmutableError,
  CommandDefinitionStore,
  CommandDefinitionValidationError,
  type CommandDefinitionContent,
} from "./command-definitions.js";

const OWNER = { kind: "workspace", id: "workspace:test" } as const;
const NOW = "2026-09-04T00:00:00.000Z";

function definition(label = "Write workspace file"): CommandDefinitionContent {
  return {
    label,
    description: "Writes exact content to a path contained by the Workspace binding.",
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
      },
    },
    output: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["artefact_version_id"],
        properties: { artefact_version_id: { type: "string", minLength: 1 } },
      },
    },
    side_effects: [{
      effect_id: "workspace-content-write",
      title: "Write Workspace content",
      external: false,
      reversibility: "reversible",
      resource_kinds: ["workspace_content"],
    }],
    permissions: [{
      permission_id: "write-output",
      operation_id: "workspace.content.write",
      purpose: "Write the declared output inside the bound Workspace root.",
    }],
    timeout_ms: 30_000,
    cancellation: "supported",
    idempotency: { mode: "caller_key", key_schema_ref: "floe:idempotency-key:v1" },
    implementation_ref: {
      kind: "core_command_implementation",
      id: "workspace-content-write",
      revision: "sha256:implementation-v1",
    },
    entry_point: "workspace.content.write",
  };
}

function store(): CommandDefinitionStore {
  return new CommandDefinitionStore(new DatabaseSync(":memory:"), () => NOW);
}

describe("CommandDefinitionStore", () => {
  it("owns a stable Command with immutable published revisions and exact implementation identity", () => {
    const commands = store();
    const created = commands.createCommand({
      owner: OWNER,
      command_id: "command:workspace-content-write",
      created_by_principal_id: "principal:operator",
      definition: definition(),
    });

    expect(created.command).toMatchObject({
      command_id: "command:workspace-content-write",
      owner: OWNER,
      current_revision_id: null,
      status: "active",
    });
    expect(created.draft.content.implementation_ref).toEqual({
      kind: "core_command_implementation",
      id: "workspace-content-write",
      revision: "sha256:implementation-v1",
    });

    const published = commands.publishDraft({
      command_definition_revision_id: created.draft.command_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });

    expect(published.published_at).toBe(NOW);
    expect(commands.getCurrentDefinition(created.command.command_id)?.semantic_digest)
      .toBe(created.draft.semantic_digest);
    expect(() => commands.replaceDraft({
      command_definition_revision_id: published.command_definition_revision_id,
      expected_digest: published.semantic_digest,
      definition: definition("Changed after publication"),
    })).toThrow(CommandDefinitionImmutableError);
  });

  it("uses compare-and-swap for draft edits and published-head changes", () => {
    const commands = store();
    const first = commands.createCommand({
      owner: OWNER,
      command_id: "command:test",
      created_by_principal_id: "principal:operator",
      definition: definition(),
    });

    expect(() => commands.replaceDraft({
      command_definition_revision_id: first.draft.command_definition_revision_id,
      expected_digest: "stale",
      definition: definition("Next"),
    })).toThrow(CommandDefinitionDraftConflictError);

    const edited = commands.replaceDraft({
      command_definition_revision_id: first.draft.command_definition_revision_id,
      expected_digest: first.draft.semantic_digest,
      definition: definition("Next"),
    });
    const published = commands.publishDraft({
      command_definition_revision_id: edited.command_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const second = commands.createDraft({
      command_id: first.command.command_id,
      created_by_principal_id: "principal:operator",
      definition: definition("Second revision"),
    });

    expect(() => commands.publishDraft({
      command_definition_revision_id: second.command_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    })).toThrow(CommandDefinitionConflictError);

    const next = commands.publishDraft({
      command_definition_revision_id: second.command_definition_revision_id,
      expected_current_revision_id: published.command_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });
    expect(commands.listHeadChanges(first.command.command_id).map((change) => change.to_revision_id))
      .toEqual([published.command_definition_revision_id, next.command_definition_revision_id]);
  });

  it("rolls the current head back without rewriting either published revision", () => {
    const commands = store();
    const first = commands.createCommand({
      owner: OWNER,
      command_id: "command:test",
      created_by_principal_id: "principal:operator",
      definition: definition("First"),
    });
    const revisionOne = commands.publishDraft({
      command_definition_revision_id: first.draft.command_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const revisionTwoDraft = commands.createDraft({
      command_id: first.command.command_id,
      created_by_principal_id: "principal:operator",
      definition: definition("Second"),
    });
    const revisionTwo = commands.publishDraft({
      command_definition_revision_id: revisionTwoDraft.command_definition_revision_id,
      expected_current_revision_id: revisionOne.command_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    commands.rollback({
      command_id: first.command.command_id,
      to_published_revision_id: revisionOne.command_definition_revision_id,
      expected_current_revision_id: revisionTwo.command_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    expect(commands.getCurrentDefinition(first.command.command_id)?.command_definition_revision_id)
      .toBe(revisionOne.command_definition_revision_id);
    expect(commands.requireRevision(revisionOne.command_definition_revision_id).published_at).toBe(NOW);
    expect(commands.requireRevision(revisionTwo.command_definition_revision_id).published_at).toBe(NOW);
    expect(commands.listHeadChanges(first.command.command_id).at(-1)).toMatchObject({
      from_revision_id: revisionTwo.command_definition_revision_id,
      to_revision_id: revisionOne.command_definition_revision_id,
      reason: "rollback",
    });
  });

  it("keeps owners separate and retirement reversible without deleting history", () => {
    const commands = store();
    const created = commands.createCommand({
      owner: OWNER,
      command_id: "command:test",
      created_by_principal_id: "principal:operator",
      definition: definition(),
    });
    const published = commands.publishDraft({
      command_definition_revision_id: created.draft.command_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });

    commands.setCommandStatus({
      command_id: created.command.command_id,
      status: "retired",
      expected_current_revision_id: published.command_definition_revision_id,
    });
    expect(commands.listCommands(OWNER)).toEqual([]);
    expect(commands.listCommands(OWNER, { include_retired: true })).toHaveLength(1);
    expect(commands.listCommands({ kind: "workspace", id: "workspace:other" }, { include_retired: true }))
      .toEqual([]);
    expect(commands.listRevisions(created.command.command_id)).toHaveLength(1);

    commands.setCommandStatus({
      command_id: created.command.command_id,
      status: "active",
      expected_current_revision_id: published.command_definition_revision_id,
    });
    expect(commands.listCommands(OWNER)).toHaveLength(1);
  });

  it("rejects definitions that cannot be reproduced or safely retried", () => {
    const commands = store();
    expect(() => commands.createCommand({
      owner: OWNER,
      created_by_principal_id: "principal:operator",
      definition: {
        ...definition(),
        implementation_ref: {
          kind: "core_command_implementation",
          id: "workspace-content-write",
          revision: null,
        },
      },
    })).toThrow(/must pin an exact revision/);

    expect(() => commands.createCommand({
      owner: OWNER,
      created_by_principal_id: "principal:operator",
      definition: {
        ...definition(),
        side_effects: [{
          effect_id: "publish",
          title: "Publish externally",
          external: true,
          reversibility: "irreversible",
          resource_kinds: ["external_release"],
        }],
        idempotency: { mode: "content_addressed", key_schema_ref: null },
      },
    })).toThrow(/external side effect requires caller_key or effect_receipt/);

    expect(() => commands.createCommand({
      owner: OWNER,
      created_by_principal_id: "principal:operator",
      definition: {
        ...definition(),
        side_effects: [],
        idempotency: { mode: "effect_receipt", key_schema_ref: null },
      },
    })).toThrow(CommandDefinitionValidationError);
  });
});
