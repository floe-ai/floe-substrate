import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  CONTENT_REF_SCHEMA,
  CREATE_ARTEFACT_INPUT_SCHEMA,
  INSPECT_ARTEFACT_OPERATION_ID,
  PUBLISH_ARTEFACT_VERSION_INPUT_SCHEMA,
  SEARCH_ARTEFACTS_OPERATION_ID,
  artefactOperationDefinitions,
  registerArtefactOperations,
} from "./artefact-operations.js";
import { ArtefactStore, applyArtefactSchema } from "./artefacts.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  requireWorkspaceAuthorityId,
  type JsonSchema,
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type OperationSchemaIssue,
  type OperationSchemaValidation,
  type OperationSchemaValidator,
  type ResolvedOperationResource,
} from "./operations.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

class TestSchemaValidator implements OperationSchemaValidator {
  readonly calls: Array<{ schema: JsonSchema; value: unknown }> = [];

  validate(schema: JsonSchema, value: unknown): OperationSchemaValidation {
    this.calls.push({ schema, value });
    const issues: OperationSchemaIssue[] = [];
    validateValue(schema, value, "", "#", issues);
    return issues.length === 0 ? { valid: true } : { valid: false, issues };
  }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  instancePath: string,
  schemaPath: string,
  issues: OperationSchemaIssue[],
): void {
  if (Array.isArray(schema.oneOf)) {
    const alternatives = schema.oneOf as JsonSchema[];
    const valid = alternatives.filter((candidate) => {
      const candidateIssues: OperationSchemaIssue[] = [];
      validateValue(candidate, value, instancePath, `${schemaPath}/oneOf`, candidateIssues);
      return candidateIssues.length === 0;
    });
    if (valid.length !== 1) {
      issues.push({
        instance_path: instancePath,
        schema_path: `${schemaPath}/oneOf`,
        keyword: "oneOf",
        message: "must match exactly one schema",
      });
    }
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/enum`, keyword: "enum", message: "must be an allowed value" });
    return;
  }
  if ("const" in schema && value !== schema.const) {
    issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/const`, keyword: "const", message: "must equal constant" });
    return;
  }
  if (schema.type === "null") {
    if (value !== null) issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be null" });
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be object" });
      return;
    }
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in object)) {
        issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/required`, keyword: "required", message: `must have '${required}'` });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) {
          issues.push({ instance_path: `${instancePath}/${key}`, schema_path: `${schemaPath}/additionalProperties`, keyword: "additionalProperties", message: "must not have additional properties" });
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) validateValue(child, object[key], `${instancePath}/${key}`, `${schemaPath}/properties/${key}`, issues);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be array" });
      return;
    }
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        validateValue(schema.items as JsonSchema, item, `${instancePath}/${index}`, `${schemaPath}/items`, issues);
      }
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be string" });
      return;
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/minLength`, keyword: "minLength", message: "is too short" });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "i").test(value)) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/pattern`, keyword: "pattern", message: "does not match pattern" });
    }
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be boolean" });
    return;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be integer" });
      return;
    }
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/minimum`, keyword: "minimum", message: "is below minimum" });
    }
  }
}

function authority(
  principalId: string,
  mode: "interactive" | "unattended",
): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  return {
    principal_id: principalId,
    boundary: { kind: "workspace", workspace_id: "workspace:test" },
    grants: new Set(["artefact.create", "artefact.version.publish", "artefact.inspect", "artefact.search"]),
    interaction: {
      mode,
      session_id: `session:${principalId}`,
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function environment(
  store: ArtefactStore,
  principal: OperationAuthorityContext,
): OperationInvocationEnvironment {
  const workspaceId = requireWorkspaceAuthorityId(principal);
  return {
    authority: principal,
    resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
      if (target.kind === "artefact") {
        const artefact = store.getArtefact(target.id);
        return artefact && artefact.workspace_id === workspaceId
          ? { ref: { ...target, revision: null }, state: artefact }
          : null;
      }
      if (target.kind === "artefact_version") {
        const version = store.getVersion(target.id);
        const artefact = version ? store.getArtefact(version.artefact_id) : null;
        return version && artefact?.workspace_id === workspaceId
          ? { ref: { ...target, revision: version.artefact_version_id }, state: version }
          : null;
      }
      return null;
    },
    now: () => "2026-09-03T12:00:00.000Z",
  };
}

function request(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  target?: { kind: string; id: string },
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    ...(target ? { target } : {}),
    idempotency_key: idempotencyKey,
    input,
  };
}

function completedResult<T>(response: OperationInvocationResponse): T {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  expect(response.receipt.state).toBe("completed");
  return response.receipt.result as T;
}

describe("Bus-owned Artefact semantic operations", () => {
  let db: DatabaseSync;
  let store: ArtefactStore;
  let validator: TestSchemaValidator;
  let registry: ReturnType<typeof createTestOperationRegistry>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyArtefactSchema(db);
    store = new ArtefactStore(db);
    validator = new TestSchemaValidator();
    registry = registerArtefactOperations(createTestOperationRegistry(validator), store, input => store.publishVersion(input));
  });

  afterEach(() => db.close());

  it("projects the same definitions and executes them for interactive and unattended principals", async () => {
    const interactive = authority("principal:desktop-session", "interactive");
    const unattended = authority("principal:runtime-turn", "unattended");
    const [interactiveDefinitions, unattendedDefinitions] = await Promise.all([
      registry.project({ authority: interactive }),
      registry.project({ authority: unattended }),
    ]);

    expect(interactiveDefinitions).toEqual(unattendedDefinitions);
    expect(interactiveDefinitions.map((definition) => definition.operation_id)).toEqual([
      "artefact.create",
      "artefact.version.publish",
      "artefact.inspect",
      "artefact.search",
    ]);
    expect(interactiveDefinitions[0]?.input.schema).toBe(CREATE_ARTEFACT_INPUT_SCHEMA);
    expect(interactiveDefinitions[1]?.input.schema).toBe(PUBLISH_ARTEFACT_VERSION_INPUT_SCHEMA);

    const operation = request(
      "artefact.create",
      { type_ref: "concept:image" },
      "same-intent-from-two-clients",
    );
    const first = completedResult<{ artefact: { artefact_id: string } }>(
      await registry.invoke(environment(store, interactive), operation),
    );
    const second = completedResult<{ artefact: { artefact_id: string } }>(
      await registry.invoke(environment(store, unattended), operation),
    );

    expect(second.artefact.artefact_id).toBe(first.artefact.artefact_id);
    expect(store.listArtefacts("workspace:test")).toHaveLength(1);
  });

  it("retains exact versions when one workspace path resolves to new content", async () => {
    const principal = authority("principal:runtime-turn", "unattended");
    const artefact = store.createArtefact({
      workspace_id: principal.boundary.workspace_id,
      type_ref: "concept:image",
      idempotency_key: "courtyard",
    });
    const target = { kind: "artefact", id: artefact.artefact_id };

    const first = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request("artefact.version.publish", {
        content_ref: {
          kind: "workspace-relative",
          path: "concepts/courtyard.png",
          digest: { algorithm: "sha256", value: DIGEST_A },
        },
      }, "courtyard-v1", target),
    )).version;
    const second = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request("artefact.version.publish", {
        content_ref: {
          kind: "workspace-relative",
          path: "concepts/courtyard.png",
          digest: { algorithm: "sha256", value: DIGEST_B },
        },
        lineage: [{ relation_type: "core:supersedes", object_version_id: first.artefact_version_id }],
      }, "courtyard-v2", target),
    )).version;

    const inspection = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request(INSPECT_ARTEFACT_OPERATION_ID, {
        artefact_version_id: first.artefact_version_id,
        include_history: true,
      }, "inspect-courtyard", target),
    ));

    expect(inspection.history_complete).toBe(true);
    expect(inspection.versions).toHaveLength(2);
    expect(inspection.versions.map((version: any) => version.content_ref.path)).toEqual([
      "concepts/courtyard.png",
      "concepts/courtyard.png",
    ]);
    expect(inspection.versions.map((version: any) => version.content_ref.digest.value)).toEqual([
      DIGEST_A,
      DIGEST_B,
    ]);
    expect(inspection.selected.version.artefact_version_id).toBe(first.artefact_version_id);
    expect(inspection.selected.version.content_ref.digest.value).toBe(DIGEST_A);
    expect(inspection.heads.map((version: any) => version.artefact_version_id)).toEqual([
      second.artefact_version_id,
    ]);
  });

  it("rejects mutable or absolute paths through the discovered schema before publishing", async () => {
    const principal = authority("principal:desktop-session", "interactive");
    const artefact = store.createArtefact({
      workspace_id: principal.boundary.workspace_id,
      type_ref: "concept:image",
      idempotency_key: "schema-validation",
    });
    const target = { kind: "artefact", id: artefact.artefact_id };

    for (const contentRef of [
      { kind: "workspace-relative", path: "concepts/courtyard.png" },
      {
        kind: "workspace-relative",
        path: "C:\\Users\\person\\courtyard.png",
        digest: { algorithm: "sha256", value: DIGEST_A },
      },
    ]) {
      const response = await registry.invoke(
        environment(store, principal),
        request("artefact.version.publish", { content_ref: contentRef }, `invalid-${contentRef.path}`, target),
      );
      expect(response.kind).toBe("receipt");
      if (response.kind !== "receipt") continue;
      expect(response.receipt.refusal).toMatchObject({ code: "operation_input_invalid" });
    }

    expect(store.listVersions(artefact.artefact_id)).toHaveLength(0);
    expect(validator.calls.some((call) => call.schema === PUBLISH_ARTEFACT_VERSION_INPUT_SCHEMA)).toBe(true);
    expect((CONTENT_REF_SCHEMA.oneOf as unknown[])).toHaveLength(3);
  });

  it("keeps extension metadata namespaced and exposes exact lineage, membership, and execution references", async () => {
    const principal = authority("principal:runtime-turn", "unattended");
    const source = store.createArtefact({
      workspace_id: principal.boundary.workspace_id,
      type_ref: "concept:image",
      idempotency_key: "source",
    });
    const sourceVersion = store.publishVersion({
      artefact_id: source.artefact_id,
      idempotency_key: "source-v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "workspace-cas",
        digest: { algorithm: "sha256", value: DIGEST_A },
      },
    });
    const collection = store.createArtefact({
      workspace_id: principal.boundary.workspace_id,
      type_ref: "core:collection",
      idempotency_key: "collection",
    });
    const target = { kind: "artefact", id: collection.artefact_id };

    const published = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request("artefact.version.publish", {
        content_ref: {
          kind: "content-addressed",
          resolver_id: "workspace-cas",
          digest: { algorithm: "sha256", value: DIGEST_B },
        },
        lineage: [{ relation_type: "core:derived-from", object_version_id: sourceVersion.artefact_version_id }],
        members: [{ member_key: "source", member_version_id: sourceVersion.artefact_version_id, position: 0 }],
        associations: [{ target_kind: "node_execution", target_id: "node-execution:registry:1", role: "output" }],
        annotations: [{
          namespace: "extension:concept-exploder",
          key: "review-status",
          extension_package_version_ref: "concept-exploder@2.0.0",
          value: { status: "accepted" },
        }],
      }, "publish-collection", target),
    ));

    expect(published).toMatchObject({
      lineage_from: [{ object_version_id: sourceVersion.artefact_version_id }],
      members: [{ member_key: "source", member_version_id: sourceVersion.artefact_version_id }],
      associations: [{ target_kind: "node_execution", role: "output" }],
      annotations: [{ namespace: "extension:concept-exploder", value: { status: "accepted" } }],
    });

    const invalid = await registry.invoke(
      environment(store, principal),
      request("artefact.version.publish", {
        content_ref: {
          kind: "content-addressed",
          resolver_id: "workspace-cas",
          digest: { algorithm: "sha256", value: DIGEST_A },
        },
        annotations: [{
          namespace: "core",
          key: "review-status",
          extension_package_version_ref: "concept-exploder@2.0.0",
          value: "accepted",
        }],
      }, "invalid-core-annotation", target),
    );
    expect(invalid.kind).toBe("receipt");
    if (invalid.kind === "receipt") {
      expect(invalid.receipt.refusal).toMatchObject({ code: "operation_input_invalid" });
    }
    expect(store.listVersions(collection.artefact_id)).toHaveLength(1);
  });

  it("pages and filters the canonical catalogue without choosing one branch as current", async () => {
    const principal = authority("principal:desktop-session", "interactive");
    const create = (id: string, typeRef: string, association?: { target_id: string; role: "input" | "output" }) => {
      const artefact = store.createArtefact({
        workspace_id: principal.boundary.workspace_id,
        type_ref: typeRef,
        artefact_id: id,
        idempotency_key: `create:${id}`,
      });
      const version = store.publishVersion({
        artefact_id: artefact.artefact_id,
        artefact_version_id: `${id}:v1`,
        idempotency_key: `publish:${id}`,
        content_ref: {
          kind: "workspace-relative",
          path: `outputs/${id}.txt`,
          digest: { algorithm: "sha256", value: DIGEST_A },
          media_type: "text/plain",
        },
        ...(association ? {
          associations: [{
            target_kind: "context" as const,
            target_id: association.target_id,
            role: association.role,
          }],
        } : {}),
      });
      return { artefact, version };
    };
    create("artefact:concept-a", "media:image", { target_id: "context:one", role: "input" });
    create("artefact:concept-b", "media:image", { target_id: "context:two", role: "output" });
    const matchingVersion = create("artefact:report", "document:report").version;

    const firstPage = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request(SEARCH_ARTEFACTS_OPERATION_ID, { type_ref: "media:image", limit: 1 }, "search-images-1"),
    ));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0].heads).toHaveLength(1);
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const secondPage = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request(SEARCH_ARTEFACTS_OPERATION_ID, {
        type_ref: "media:image",
        limit: 1,
        after: firstPage.next_cursor,
      }, "search-images-2"),
    ));
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.next_cursor).toBeNull();
    expect(new Set([
      firstPage.items[0].artefact.artefact_id,
      secondPage.items[0].artefact.artefact_id,
    ])).toEqual(new Set(["artefact:concept-a", "artefact:concept-b"]));

    const byAssociation = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request(SEARCH_ARTEFACTS_OPERATION_ID, {
        association: { target_kind: "context", target_id: "context:one", role: "input" },
      }, "search-context-one"),
    ));
    expect(byAssociation.items.map((item: any) => item.artefact.artefact_id)).toEqual(["artefact:concept-a"]);

    const byExactVersion = completedResult<any>(await registry.invoke(
      environment(store, principal),
      request(SEARCH_ARTEFACTS_OPERATION_ID, { query: matchingVersion.artefact_version_id }, "search-version"),
    ));
    expect(byExactVersion.items.map((item: any) => item.artefact.artefact_id)).toEqual(["artefact:report"]);
    expect(byExactVersion.items[0]).not.toHaveProperty("current");
  });

  it("discovers and invokes the same schema objects instead of maintaining a second client contract", async () => {
    const definitions = artefactOperationDefinitions(store, input => store.publishVersion(input));
    const publish = definitions.find((definition) => definition.operation_id === "artefact.version.publish");
    const inspect = definitions.find((definition) => definition.operation_id === "artefact.inspect");
    const search = definitions.find((definition) => definition.operation_id === "artefact.search");

    expect(publish?.input.schema).toBe(PUBLISH_ARTEFACT_VERSION_INPUT_SCHEMA);
    expect(inspect?.operation_version).toBe("1");
    expect(publish?.interaction_constraints.allowed_modes).toEqual(["interactive", "unattended"]);
    expect(inspect?.interaction_constraints.allowed_modes).toEqual(["interactive", "unattended"]);
    expect(search?.interaction_constraints.allowed_modes).toEqual(["interactive", "unattended"]);
  });
});
