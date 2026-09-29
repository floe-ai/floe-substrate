import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import type { CapabilityGrantTarget } from "./capability-grants.js";
import type { RuntimeToolCallRequest } from "./runtime-tool-policy.js";
import type { ActorDefinitionContent } from "./actor-definitions.js";

const WS = "workspace:tool-policy";
const ACTOR = "actor:tool-policy:builder";
const OPERATOR = "actor:tool-policy:operator";
const BRIDGE = "bridge:tool-policy";
const PRINCIPAL = "principal:test-fixture";
const noop = () => {};

type Handle = Awaited<ReturnType<typeof createBusServer>>;

describe("runtime tool policy", () => {
  let handle: Handle;
  let tmp: string;
  let pushed: Array<{ type: string; payload: Record<string, unknown> }>;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-tool-policy-"));
    const cfgPath = join(tmp, "config.yaml");
    const cfg = defaultConfig(tmp);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
    await handle.app.ready();
    const at = new Date().toISOString();
    handle.store.workspaceIdentityStore.restoreWorkspace({
      snapshot: { workspace_id: WS, name: "Tools", creation_kind: "created", source_workspace_id: null, created_at: at, updated_at: at },
    });
    handle.store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, at, at);
    handle.store.registerEndpoint({ endpoint_id: OPERATOR, workspace_id: WS, name: "Operator" }, noop);
    handle.store.registerEndpoint({ endpoint_id: ACTOR, workspace_id: WS, name: "Builder", bridge_id: BRIDGE, status: "idle" }, noop);
    registerExecutableActorFixture(handle.store, WS, ACTOR);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  function grant(operationIds: string[], targets: CapabilityGrantTarget[] = []) {
    return handle.store.capabilityGrantStore.issueGrant({
      principal_id: ACTOR,
      boundary: { kind: "workspace", workspace_id: WS },
      operation_ids: operationIds,
      targets,
      expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: PRINCIPAL,
      evidence: [{ kind: "test_fixture", ref: "tool-policy" }],
    });
  }

  function publishDefinition(change: Partial<ActorDefinitionContent>) {
    const store = handle.store.actorDefinitionStore;
    const current = store.getRevision(store.getActor(ACTOR)!.current_definition_revision_id!)!;
    const draft = store.createDraft({
      actor_id: ACTOR,
      based_on_revision_id: current.actor_definition_revision_id,
      created_by_principal_id: PRINCIPAL,
      definition: {
        ...current.content,
        ...change,
        capability_grant_ids: [...current.content.capability_grant_ids, ...(change.capability_grant_ids ?? [])],
      },
    });
    return store.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: current.actor_definition_revision_id,
      changed_by_principal_id: PRINCIPAL,
    });
  }

  function publishPolicy(category: "approval" | "operation", rules: unknown[]) {
    const created = handle.store.policyStore.createPolicy({
      workspace_id: WS,
      category,
      content: { label: `${category} policy`, description: "test", rules: rules as never },
      created_by_principal_id: PRINCIPAL,
    });
    return handle.store.policyStore.publishRevision({
      workspace_id: WS,
      policy_revision_id: created.draft.policy_revision_id,
      expected_current_revision_id: null,
    }).revision;
  }

  async function runningDelivery() {
    await emitViaRoute(handle, {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: ACTOR },
      thread_id: "",
      correlation_id: null,
      content: { text: "build" },
      metadata: {},
      idempotency_key: null,
    });
    const claimed = handle.store.claimDeliveries(BRIDGE, 1, noop)[0]!;
    handle.store.prepareRuntimeDelivery({ bridge_id: BRIDGE, delivery_id: claimed.delivery_id }, noop);
    handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: claimed.delivery_id, state: "injected_to_runtime" }, noop);
    return claimed.delivery_id;
  }

  function call(overrides: Partial<RuntimeToolCallRequest>): RuntimeToolCallRequest {
    return {
      operation_id: "engine.tool.filesystem.read",
      tool_call_id: "call-1",
      engine: "copilot",
      manifest_version: "copilot-cli-1.0.83-win32-v2",
      native_tools: ["view"],
      paths: ["src/app.ts"],
      executables: [],
      urls: [],
      write_redirection: false,
      sandbox_bypass: false,
      argument_digest: "a".repeat(64),
      ...overrides,
    };
  }

  function evaluate(deliveryId: string, request: RuntimeToolCallRequest) {
    pushed = [];
    return handle.store.evaluateRuntimeToolCall(
      { bridge_id: BRIDGE, delivery_id: deliveryId, request },
      (type, payload) => pushed.push({ type, payload: payload as Record<string, unknown> }),
    );
  }

  it("is unrestricted by default, and records every call as a decision", async () => {
    const all = grant(["engine.tool.filesystem.read", "engine.tool.filesystem.write", "engine.tool.process.execute", "engine.tool.network.fetch"]);
    publishDefinition({ capability_grant_ids: [all.grant_id] });
    const deliveryId = await runningDelivery();

    const allowed = evaluate(deliveryId, call({}));
    expect(allowed).toMatchObject({ decision: "allow", refusal: null });
    const record = handle.store.policyStore.getEvaluation(allowed.evaluation_id)!;
    expect(record.facts?.tool).toMatchObject({ engine: "copilot", native_tools: ["view"], paths: ["src/app.ts"] });
    expect(pushed).toEqual([{ type: "policy_decision", payload: expect.objectContaining({
      evaluation_id: allowed.evaluation_id, workspace_id: WS, actor_id: ACTOR, delivery_id: deliveryId,
      operation_id: "engine.tool.filesystem.read", decision: "allow", tool_call_id: "call-1",
    }) }]);

    const decision = (request: Partial<RuntimeToolCallRequest>) => evaluate(deliveryId, call(request)).decision;
    // Paths outside the Workspace, or unreported, are allowed when no folder limit was chosen.
    expect(decision({ paths: [null] })).toBe("allow");
    expect(decision({ paths: [] })).toBe("allow");
    expect(decision({ operation_id: "engine.tool.filesystem.write", native_tools: ["apply_patch"] })).toBe("allow");
    expect(decision({ operation_id: "engine.tool.network.fetch", native_tools: ["web_fetch"], paths: [], urls: ["ftp://anywhere.test/"] })).toBe("allow");
    const sh = { operation_id: "engine.tool.process.execute", native_tools: ["powershell"], paths: [] as string[] };
    expect(decision({ ...sh, executables: [] })).toBe("allow");
    expect(decision({ ...sh, executables: ["npm", null], write_redirection: true, urls: ["https://anywhere.test/"] })).toBe("allow");
    expect(evaluate(deliveryId, call({ operation_id: "engine.tool.unknown" })).refusal?.rule_id).toBe("authority.tool_operation_unknown");
    expect(evaluate(deliveryId, call({ sandbox_bypass: true })).refusal?.rule_id).toBe("authority.tool_sandbox_bypass");

    handle.store.capabilityGrantStore.revokeGrant(all.grant_id);
    expect(evaluate(deliveryId, call({})).refusal?.rule_id).toBe("authority.tool_grant_missing");
  });

  it("enforces only the limits a person chose, and refuses what the evidence cannot show", async () => {
    const read = grant(["engine.tool.filesystem.read"], [{ kind: "filesystem_path", id: "src" }]);
    const fetch = grant(["engine.tool.network.fetch"], [{ kind: "network_domain", id: "example.com" }]);
    const shell = grant(["engine.tool.process.execute"], [{ kind: "executable", id: "git" }]);
    publishDefinition({ capability_grant_ids: [read.grant_id, fetch.grant_id, shell.grant_id], scope: { paths: ["src", "docs"] } });
    const deliveryId = await runningDelivery();

    expect(evaluate(deliveryId, call({})).decision).toBe("allow");
    const refused = (request: Partial<RuntimeToolCallRequest>) => evaluate(deliveryId, call(request)).refusal?.rule_id;
    expect(refused({ paths: ["docs/readme.md"] })).toBe("authority.tool_target_not_granted");
    expect(refused({ paths: ["other/file.ts"] })).toBe("authority.tool_path_outside_scope");
    expect(refused({ paths: [null] })).toBe("authority.tool_path_unresolved");
    expect(refused({ paths: [] })).toBe("authority.tool_path_missing");
    expect(refused({ operation_id: "engine.tool.filesystem.write", native_tools: ["apply_patch"] })).toBe("authority.tool_grant_missing");

    const web = { operation_id: "engine.tool.network.fetch", native_tools: ["web_fetch"], paths: [] as string[] };
    expect(evaluate(deliveryId, call({ ...web, urls: ["https://api.example.com/x?token=secret"] })).decision).toBe("allow");
    expect(JSON.stringify(pushed)).not.toContain("token=secret");
    expect(refused({ ...web, urls: ["https://api.example.com/", "https://evil.test/"] })).toBe("authority.tool_target_not_granted");
    expect(refused({ ...web, urls: ["ftp://example.com/"] })).toBe("authority.tool_network_not_granted");
    expect(refused({ ...web, urls: ["not a url"] })).toBe("authority.tool_network_not_granted");

    // A folder limit cannot be shown to hold for shell, whose evidence names only commands.
    const sh = { operation_id: "engine.tool.process.execute", native_tools: ["powershell"], paths: [] as string[] };
    const unconfined = evaluate(deliveryId, call({ ...sh, executables: ["git"] }));
    expect(unconfined).toMatchObject({ decision: "deny", approval_request_ids: [] });
    expect(unconfined.refusal).toMatchObject({ rule_id: "authority.tool_shell_unconfined", reason: expect.stringMatching(/chosen folders/) });
  });

  it("checks a chosen command allowlist on the commands the engine reports", async () => {
    const shell = grant(["engine.tool.process.execute"], [{ kind: "executable", id: "git" }]);
    const fetch = grant(["engine.tool.network.fetch"], [{ kind: "network_domain", id: "example.com" }]);
    publishDefinition({ capability_grant_ids: [shell.grant_id, fetch.grant_id] });
    const deliveryId = await runningDelivery();
    const sh = { operation_id: "engine.tool.process.execute", native_tools: ["powershell"], paths: [] as string[] };
    const refused = (request: Partial<RuntimeToolCallRequest>) => evaluate(deliveryId, call({ ...sh, ...request })).refusal?.rule_id;

    expect(evaluate(deliveryId, call({ ...sh, executables: ["Git", "git"] })).decision).toBe("allow");
    expect(evaluate(deliveryId, call({ ...sh, executables: ["git"], urls: ["https://example.com/repo"] })).decision).toBe("allow");
    expect(refused({ executables: ["git"], urls: ["https://evil.test/"] })).toBe("authority.tool_network_not_granted");
    expect(refused({ executables: ["git", null] })).toBe("authority.tool_shell_ambiguous");
    expect(refused({ executables: [] })).toBe("authority.tool_shell_ambiguous");
    expect(refused({ executables: ["git"], write_redirection: true })).toBe("authority.tool_shell_ambiguous");
    expect(refused({ executables: ["npm"] })).toBe("authority.tool_target_not_granted");
  });

  it("refuses shell under a folder limit on its grant, since shell evidence names no files", async () => {
    const folders = grant(["engine.tool.process.execute"], [{ kind: "filesystem_path", id: "src" }]);
    publishDefinition({ capability_grant_ids: [folders.grant_id] });
    const deliveryId = await runningDelivery();
    const shell = call({ operation_id: "engine.tool.process.execute", native_tools: ["powershell"], paths: [], executables: ["git"] });
    expect(evaluate(deliveryId, shell).refusal?.rule_id).toBe("authority.tool_shell_unconfined");
  });

  it("applies the Actor's pinned Approval Policy and bound policies, which only restrict", async () => {
    const read = grant(["engine.tool.filesystem.read", "engine.tool.network.fetch"]);
    const approval = publishPolicy("approval", [{
      rule_id: "ask-before-reading", priority: 1,
      match: { operation_ids: ["engine.tool.filesystem.read"] },
      effect: { kind: "require_approval", reason: "Reading needs a person.", approvers: { mode: "any", principal_ids: [OPERATOR], roles: [] } },
    }]);
    const ceiling = publishPolicy("operation", [{
      rule_id: "no-network", priority: 1,
      match: { operation_ids: ["engine.tool.network.fetch"] },
      effect: { kind: "deny", reason: "This Workspace does not fetch." },
    }]);
    handle.store.policyStore.bindRevision({
      workspace_id: WS, policy_revision_id: ceiling.policy_revision_id,
      subject: { kind: "workspace", id: WS }, bound_by_principal_id: PRINCIPAL,
    });
    publishDefinition({
      capability_grant_ids: [read.grant_id],
      scope: { paths: ["."] },
      policy_refs: { budget: null, trust: null, approval: { kind: "policy", id: approval.policy_id, revision: approval.policy_revision_id } },
    });
    const deliveryId = await runningDelivery();

    const asked = evaluate(deliveryId, call({}));
    expect(asked.decision).toBe("require_approval");
    expect(asked.approval_requirements).toEqual([expect.objectContaining({
      policy_revision_id: approval.policy_revision_id, rule_id: "ask-before-reading",
    })]);
    expect(handle.store.policyStore.getEvaluation(asked.evaluation_id)!.matched_rules[0]!.policy_binding_id).toBeNull();

    const fetched = evaluate(deliveryId, call({ operation_id: "engine.tool.network.fetch", paths: [], urls: ["https://example.com/"] }));
    expect(fetched.refusal).toMatchObject({ rule_id: "no-network", reason: "This Workspace does not fetch." });
  });

  it("refuses a wrong Approval Policy at publish and a retired one at run time", async () => {
    const read = grant(["engine.tool.filesystem.read"]);
    const wrongCategory = publishPolicy("operation", []);
    const ref = (revision: { policy_id: string; policy_revision_id: string }) => ({
      budget: null, trust: null, approval: { kind: "policy", id: revision.policy_id, revision: revision.policy_revision_id },
    });
    expect(() => publishDefinition({ capability_grant_ids: [read.grant_id], scope: { paths: ["."] }, policy_refs: ref(wrongCategory) }))
      .toThrow(/not an approval policy/);
    const withLimit = publishPolicy("approval", [{
      rule_id: "cap", priority: 1, match: {}, effect: { kind: "limit", limits: [{ metric: "calls", maximum: 1, window: "operation" }] },
    }]);
    expect(() => publishDefinition({ capability_grant_ids: [read.grant_id], scope: { paths: ["."] }, policy_refs: ref(withLimit) }))
      .toThrow(/budget limits/);

    const approval = publishPolicy("approval", []);
    publishDefinition({ capability_grant_ids: [read.grant_id], scope: { paths: ["."] }, policy_refs: ref(approval) });
    const deliveryId = await runningDelivery();
    expect(evaluate(deliveryId, call({})).decision).toBe("allow");
    handle.store.policyStore.retirePolicy({ workspace_id: WS, policy_id: approval.policy_id });
    expect(evaluate(deliveryId, call({})).refusal?.reason).toMatch(/not published and live/);
  });

  it("waits for a pushed decision and uses one approval for one exact call", async () => {
    const read = grant(["engine.tool.filesystem.read"]);
    handle.store.capabilityGrantStore.issueGrant({
      principal_id: OPERATOR, boundary: { kind: "workspace", workspace_id: WS }, operation_ids: ["approval.decide"],
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: PRINCIPAL, evidence: [{ kind: "test_fixture", ref: "approver" }],
    });
    const approval = publishPolicy("approval", [{
      rule_id: "ask", priority: 1, match: { operation_ids: ["engine.tool.filesystem.read"] },
      effect: { kind: "require_approval", reason: "Reading needs an answer.", approvers: { mode: "any", principal_ids: [OPERATOR], roles: [] } },
    }]);
    publishDefinition({
      capability_grant_ids: [read.grant_id], scope: { paths: ["."] },
      policy_refs: { budget: null, trust: null, approval: { kind: "policy", id: approval.policy_id, revision: approval.policy_revision_id } },
    });
    const deliveryId = await runningDelivery();
    const actorDeliveries = () => (handle.store.db.prepare(
      "SELECT COUNT(*) AS n FROM delivery_bundles WHERE endpoint_id = ?",
    ).get(ACTOR) as { n: number }).n;
    const resolve = (evaluationId: string, abandon: "cancelled" | "unavailable" | null = null) => {
      pushed = [];
      return handle.store.resolveRuntimeToolApproval(
        { bridge_id: BRIDGE, delivery_id: deliveryId, evaluation_id: evaluationId, abandon },
        (type, payload) => pushed.push({ type, payload: payload as Record<string, unknown> }),
      );
    };
    const decide = (requestId: string, decision: "approved" | "rejected") => {
      const request = handle.store.approvalStore.requireRequestForWorkspace(requestId, WS);
      return handle.store.decideApprovalRequest({
        workspace_id: WS, approval_request_id: requestId, expected_state_revision: request.state_revision,
        decision, decided_by_principal_id: OPERATOR, decision_reason: "checked", operation_invocation_id: `invoke:${requestId}`,
      });
    };

    const asked = evaluate(deliveryId, call({}));
    expect(asked).toMatchObject({ decision: "require_approval", refusal: null, approval_request_ids: [expect.any(String)] });
    expect(asked.approval_expires_at).not.toBeNull();
    const [requestId] = asked.approval_request_ids;
    expect(pushed.map((item) => item.type)).toEqual(["policy_decision", "approval_requested"]);
    expect(pushed[1]!.payload.request).toMatchObject({
      approval_request_id: requestId, status: "pending",
      action: { operation_id: "engine.tool.filesystem.read", input_digest: "a".repeat(64), target: { kind: "runtime_delivery", id: deliveryId } },
    });
    expect(resolve(asked.evaluation_id)).toMatchObject({ outcome: "pending", refusal: null });
    expect(pushed).toEqual([]);

    const before = actorDeliveries();
    expect(decide(requestId!, "approved").request.status).toBe("approved");
    expect(actorDeliveries()).toBe(before);
    expect(resolve(asked.evaluation_id)).toMatchObject({ outcome: "allowed", refusal: null, responder_principal_ids: [OPERATOR] });
    expect(pushed).toEqual([{ type: "policy_decision_resolved", payload: expect.objectContaining({
      evaluation_id: asked.evaluation_id, outcome: "allowed", delivery_id: deliveryId, workspace_id: WS,
    }) }]);
    expect(resolve(asked.evaluation_id).outcome).toBe("allowed");
    const receipt = handle.store.approvalStore.getReceiptForRequest(requestId!)!;
    expect(handle.store.approvalStore.getReceipt(receipt.approval_receipt_id)!.use_count).toBe(1);

    const again = evaluate(deliveryId, call({}));
    expect(again.approval_request_ids).not.toEqual(asked.approval_request_ids);
    expect(resolve(again.evaluation_id).outcome).toBe("pending");
    decide(again.approval_request_ids[0]!, "rejected");
    expect(resolve(again.evaluation_id).refusal).toMatchObject({ code: "tool_policy_denied", rule_id: "approval.denied" });

    const cancelled = evaluate(deliveryId, call({}));
    expect(resolve(cancelled.evaluation_id, "cancelled").outcome).toBe("cancelled");
    expect(handle.store.approvalStore.getRequest(cancelled.approval_request_ids[0]!)!.status).toBe("cancelled");

    const stale = evaluate(deliveryId, call({}));
    handle.store.capabilityGrantStore.revokeGrant(read.grant_id);
    expect(resolve(stale.evaluation_id).outcome).toBe("unavailable");
    expect(handle.store.approvalStore.getRequest(stale.approval_request_ids[0]!)!.status).toBe("invalidated");
  });

  it("asks a person about shell only when an Approval Policy rule says so", async () => {
    const shell = grant(["engine.tool.process.execute"]);
    const approval = publishPolicy("approval", [{
      rule_id: "ask-before-shell", priority: 1, match: { operation_ids: ["engine.tool.process.execute"] },
      effect: { kind: "require_approval", reason: "Shell needs a person.", approvers: { mode: "any", principal_ids: [OPERATOR], roles: [] } },
    }]);
    publishDefinition({
      capability_grant_ids: [shell.grant_id],
      policy_refs: { budget: null, trust: null, approval: { kind: "policy", id: approval.policy_id, revision: approval.policy_revision_id } },
    });
    const deliveryId = await runningDelivery();
    const asked = evaluate(deliveryId, call({ operation_id: "engine.tool.process.execute", native_tools: ["powershell"], paths: [], executables: ["git"] }));
    expect(asked).toMatchObject({ decision: "require_approval", refusal: null, approval_request_ids: [expect.any(String)] });
  });

  it("is reachable only by the owning Bridge with well-formed facts", async () => {
    const deliveryId = await runningDelivery();
    const bad = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/tool-policy/evaluate`,
      payload: { ...call({}), command_text: "rm -rf /" },
    });
    expect(bad.statusCode).toBe(400);
    const badResolve = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/tool-policy/eval-1/resolve`,
      payload: { abandon: "later" },
    });
    expect(badResolve.statusCode).toBe(400);
    expect(() => handle.store.evaluateRuntimeToolCall(
      { bridge_id: "bridge:other", delivery_id: deliveryId, request: call({}) }, noop,
    )).toThrow(/does not own/);
  });
});
