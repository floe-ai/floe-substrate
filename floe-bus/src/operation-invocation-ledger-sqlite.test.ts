import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  SemanticOperationRegistry,
  type OperationAuthorityContext,
  type OperationInvocationRequest,
  type OperationSchemaValidator,
  type SemanticOperationDefinition,
} from "./operations.js";
import { ALLOWING_TEST_OPERATION_GOVERNANCE } from "./operation-test-fixtures.js";
import {
  applyOperationInvocationLedgerSchema,
  SqliteOperationInvocationLedger,
} from "./operation-invocation-ledger-sqlite.js";

const validator: OperationSchemaValidator = {
  validate: () => ({ valid: true }),
};
const issuedAt = "2026-09-03T12:00:00.000Z";

const authority: OperationAuthorityContext = {
  principal_id: "principal:desktop-session",
  boundary: { kind: "workspace", workspace_id: "workspace:test" },
  grants: new Set(["workspace.rename"]),
  interaction: {
    mode: "interactive",
    session_id: "desktop-window:1",
    broker_id: null,
    confirmed_prompts: new Set(),
    approval_refs: new Set(),
  },
};

const request: OperationInvocationRequest = {
  operation_id: "workspace.rename",
  operation_version: "1",
  input_schema_version: "1",
  idempotency_key: "rename-once",
  input: { name: "Floe" },
};

describe("SqliteOperationInvocationLedger", () => {
  const cleanupDirectories: string[] = [];

  afterEach(() => {
    for (const directory of cleanupDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically reserves one invocation across clients and replays it after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "floe-operation-ledger-"));
    cleanupDirectories.push(directory);
    const path = join(directory, "bus.sqlite");
    const firstDb = new DatabaseSync(path);
    applyOperationInvocationLedgerSchema(firstDb);
    const secondDb = new DatabaseSync(path);

    let handlerCalls = 0;
    let releaseHandler!: () => void;
    let markHandlerStarted!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
    const definition: SemanticOperationDefinition<{ name: string }, { name: string }> = {
      operation_id: "workspace.rename",
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Rename Workspace",
      description: "Changes the Workspace display name.",
      effects: {
        mode: "write",
        reversibility: "reversible",
        external: false,
        secret_access: "none",
      },
      required_grants: ["workspace.rename"],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: { version: "1", schema: { type: "object" } },
      result: { version: "1", schema: { type: "object" } },
      handler: async (_context, input) => {
        handlerCalls += 1;
        markHandlerStarted();
        await handlerGate;
        return {
          state: "completed",
          result: input,
          changed_refs: [{ kind: "workspace", id: "workspace:test", revision: "2" }],
        };
      },
    };

    const firstRegistry = new SemanticOperationRegistry(
      validator,
      new SqliteOperationInvocationLedger(firstDb),
      ALLOWING_TEST_OPERATION_GOVERNANCE,
    ).register(definition);
    const secondRegistry = new SemanticOperationRegistry(
      validator,
      new SqliteOperationInvocationLedger(secondDb),
      ALLOWING_TEST_OPERATION_GOVERNANCE,
    ).register(definition);
    const environment = {
      authority,
      resolve_resource: async () => null,
      now: () => "2026-09-03T12:00:00.000Z",
    };

    const firstInvocation = firstRegistry.invoke(environment, request);
    await handlerStarted;
    const concurrentReplay = await secondRegistry.invoke(environment, request);

    expect(concurrentReplay.kind).toBe("receipt");
    if (concurrentReplay.kind !== "receipt") throw new Error("Expected a receipt replay");
    expect(concurrentReplay.replayed).toBe(true);
    expect(concurrentReplay.receipt.state).toBe("running");
    expect(handlerCalls).toBe(1);

    releaseHandler();
    const completed = await firstInvocation;
    expect(completed.kind).toBe("receipt");
    if (completed.kind !== "receipt") throw new Error("Expected a completed receipt");
    expect(completed.receipt.state).toBe("completed");

    const completedReceipt = completed.receipt;
    firstDb.close();
    secondDb.close();

    const reopenedDb = new DatabaseSync(path);
    const reopenedLedger = new SqliteOperationInvocationLedger(reopenedDb);
    const restartedRegistry = new SemanticOperationRegistry(
      validator,
      reopenedLedger,
      ALLOWING_TEST_OPERATION_GOVERNANCE,
    ).register({
      ...definition,
      handler: async () => {
        handlerCalls += 1;
        return { state: "completed", result: { name: "should-not-run" } };
      },
    });
    const afterRestart = await restartedRegistry.invoke(environment, request);

    expect(afterRestart).toEqual({ kind: "receipt", replayed: true, receipt: completedReceipt });
    expect(reopenedLedger.getByReceiptId(completedReceipt.receipt_id)).toEqual(completedReceipt);
    expect(reopenedLedger.getByInvocationId(completedReceipt.invocation_id)).toEqual(completedReceipt);
    expect(handlerCalls).toBe(1);
    reopenedDb.close();
  });

  it("migrates Workspace-only invocation rows without losing receipt provenance", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE operation_invocation_ledger (
        ledger_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        receipt_id TEXT NOT NULL UNIQUE,
        invocation_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_version TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    const legacyReceipt = {
      receipt_id: "receipt:legacy",
      invocation_id: "invocation:legacy",
      operation_id: "scope.inspect",
      operation_version: "1",
      principal_id: "principal:legacy",
      workspace_id: "workspace:legacy",
      target: null,
      expected_resource_revision: null,
      idempotency_key: "legacy-once",
      request_digest: "digest:legacy",
      provenance: {
        cause_event_id: "event:source",
        delivery_ids: ["delivery:legacy"],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
      state: "completed",
      result_schema_version: "1",
      result: { found: true },
      refusal: null,
      changed_refs: [],
      progress_ref: null,
      cancel_ref: null,
      audit_ref: null,
      started_at: issuedAt,
      updated_at: issuedAt,
      completed_at: issuedAt,
    };
    db.prepare(`
      INSERT INTO operation_invocation_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-ledger-key",
      "digest:legacy",
      "receipt:legacy",
      "invocation:legacy",
      "workspace:legacy",
      "principal:legacy",
      "scope.inspect",
      "1",
      "legacy-once",
      "completed",
      JSON.stringify(legacyReceipt),
      issuedAt,
      issuedAt,
      issuedAt,
    );

    applyOperationInvocationLedgerSchema(db);
    const stored = db.prepare(`
      SELECT boundary_kind, boundary_id
      FROM operation_invocation_ledger WHERE receipt_id = 'receipt:legacy'
    `).get();
    expect(stored).toEqual({
      boundary_kind: "workspace",
      boundary_id: "workspace:legacy",
    });
    expect(new SqliteOperationInvocationLedger(db).getByReceiptId("receipt:legacy")).toMatchObject({
      authority_boundary: { kind: "workspace", workspace_id: "workspace:legacy" },
      provenance: { cause_event_id: "event:source", delivery_ids: ["delivery:legacy"] },
    });
    expect(new SqliteOperationInvocationLedger(db).getByReceiptId("receipt:legacy"))
      .not.toHaveProperty("workspace_id");
    expect((db.prepare("PRAGMA table_info(operation_invocation_ledger)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("workspace_id");
    db.close();
  });
});
