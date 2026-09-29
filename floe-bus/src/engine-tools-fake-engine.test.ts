/**
 * Engine tool governance proved against the real pinned Copilot CLI.
 *
 * The CLI runs with a local scripted model (the SDK's own bring-your-own-key
 * provider), so no account is needed and every tool call the "model" makes is
 * chosen by the test. Everything else is real: the Bus, the Bridge daemon, the
 * FloeRuntimeAdapter, the CLI's pre-tool hook and its built-in tools.
 * Engine readiness is the one stand-in: it reports ready without an account.
 */
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { CopilotClient } from "@github/copilot-sdk";
import { CopilotRuntime } from "floe-runtime/adapters/copilot";

import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";
import { localProductWorkspacePolicy } from "./local-product-policy.js";
import type { ActorDefinitionContent } from "./actor-definitions.js";
import { BridgeDaemon } from "../../floe-bridge/src/daemon.js";
import { defaultConfig as bridgeConfig } from "../../floe-bridge/src/config.js";
import { FloeRuntimeAdapter } from "../../floe-bridge/src/adapters/floe-runtime-adapter.js";
import { copilotEnvironment } from "../../floe-bridge/src/engines/copilot.js";
import { EngineControl } from "../../floe-bridge/src/engines/engine-control.js";

const WS = "workspace:engine-tools-real";
const BRIDGE = "bridge:engine-tools-real";
const OPERATOR = "operator:engine-tools-real";
const HOST_CONTROL_TOKEN = `engine-tools-real-host-${"h".repeat(40)}`;
const MODEL = "gpt-4.1";

type ToolCall = { name: string; args: Record<string, unknown> };
type Handle = Awaited<ReturnType<typeof createBusServer>>;

/** An OpenAI-compatible model that makes exactly the tool call each turn is scripted to make. */
function scriptedModel() {
  const next: ToolCall[] = [];
  const requests: Array<{ tools: string[]; body: string }> = [];
  const toolResults: string[] = [];
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url?.includes("chat/completions")) {
        hits.push(req.url ?? "");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("fetched-by-tool");
        return;
      }
      const request = JSON.parse(body);
      requests.push({ tools: (request.tools ?? []).map((tool: any) => tool.function?.name), body });
      const last = request.messages.at(-1);
      let delta: Record<string, unknown>;
      let finish: string;
      const call = last.role === "tool" ? undefined : next.shift();
      if (last.role === "tool") toolResults.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
      if (call) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
        finish = "tool_calls";
      } else {
        delta = { role: "assistant", content: "done" };
        finish = "stop";
      }
      const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ delta, finish_reason: null }));
      res.write(chunk({ delta: {}, finish_reason: finish }, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, next, requests, toolResults, hits };
}

function readyEngine() {
  const state = {
    engine: "copilot", phase: "ready", authentication: "signed_in", access: "entitled", reachability: "reachable",
    action: null, revision: 1, checked_at: new Date().toISOString(), message: "Ready.",
  } as any;
  return Object.assign(new EventEmitter(), { currentState: () => state, check: async () => state });
}

describe.runIf(process.platform === "win32")("engine tools through the real pinned Copilot CLI", () => {
  let root: string;
  let workspace: string;
  let handle: Handle;
  let daemon: BridgeDaemon;
  let model: ReturnType<typeof scriptedModel>;
  let modelUrl: string;
  let actorId: string;
  let workspaceHeaders: { authorization: string };
  let sent = 0;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-engine-tools-real-"));
    workspace = join(root, "workspace");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(root, "outside"));
    writeFileSync(join(workspace, "src", "a.txt"), "inside-content");
    writeFileSync(join(root, "outside", "secret.txt"), "outside-secret");
    symlinkSync(join(root, "outside"), join(workspace, "escape"), "junction");

    model = scriptedModel();
    await new Promise<void>((resolve) => model.server.listen(0, "127.0.0.1", resolve));
    modelUrl = `http://127.0.0.1:${(model.server.address() as any).port}`;

    const busHome = join(root, "bus");
    mkdirSync(busHome);
    const config = defaultConfig(busHome);
    writeFileSync(join(busHome, "config.yaml"), YAML.stringify(config), "utf8");
    handle = await createBusServer(join(busHome, "config.yaml"), config, {
      host_control_token: HOST_CONTROL_TOKEN, workspace_configuration_policy: localProductWorkspacePolicy,
    });
    await handle.app.ready();
    const at = new Date().toISOString();
    handle.store.workspaceIdentityStore.restoreWorkspace({
      snapshot: { workspace_id: WS, name: "Engine tools", creation_kind: "created", source_workspace_id: null, created_at: at, updated_at: at },
      binding: { host_id: handle.store.localHostId, platform: "windows", locator: workspace, init_authorized: true },
    });
    // The person who created the Workspace; its Floe Actor acts with their access.
    const admitted = await handle.app.inject({ method: "POST", url: "/v1/identities",
      headers: { authorization: ["Be", "arer ", HOST_CONTROL_TOKEN].join("") },
      payload: { display_name: "Operator", pubkey: getPublicKey(generateSecretKey()), workspace_id: WS, until_revoked: true } });
    expect(admitted.statusCode, admitted.body).toBe(201);
    const bridgeToken = handle.issueBridgeServiceCredential(BRIDGE).bearer_token;
    const bindingId = handle.store.workspaceIdentityStore.getCurrentBinding(WS, handle.store.localHostId)!.binding_id;
    const imported = await handle.app.inject({
      method: "POST", url: `/v1/workspaces/${encodeURIComponent(WS)}/import-config`,
      headers: { authorization: `Bearer ${bridgeToken}` }, payload: inventory(bindingId),
    });
    expect(imported.statusCode, imported.body).toBe(200);
    actorId = imported.json().import_result.receipt.imported_actors[0].actor_id;
    handle.store.registerEndpoint({ endpoint_id: OPERATOR, workspace_id: WS, name: "Operator" }, () => {});
    const session = await handle.app.inject({
      method: "POST", url: `/v1/local/workspaces/${encodeURIComponent(WS)}/operation-sessions`,
      headers: { authorization: `Bearer ${HOST_CONTROL_TOKEN}` }, payload: { interaction_session_id: `interaction:${WS}` },
    });
    expect(session.statusCode, session.body).toBe(201);
    workspaceHeaders = { authorization: `Bearer ${session.json().bearer_token}` };

    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const bridge = bridgeConfig(workspace);
    bridge.bus.http_base_url = address;
    bridge.bus.ws_base_url = address.replace("http:", "ws:");
    bridge.bridge.bus_url = bridge.bus.ws_base_url;
    bridge.bridge.runtime_adapter = "floe-runtime";
    daemon = new BridgeDaemon(join(root, "bridge-config.yaml"), bridge, {
      bridge_id: BRIDGE,
      transport_authority: { audience: "bridge_service", bearer_token: bridgeToken },
      engines: new EngineControl(new Map([["copilot", readyEngine() as any]]), null),
    });
    const copilotHome = join(root, "copilot-home");
    const provider = { type: "openai", baseUrl: `${modelUrl}/v1`, apiKey: "local-test" };
    (daemon as any).adapter = new FloeRuntimeAdapter({
      runtimeFactory: (options) => new CopilotRuntime({
        ...options,
        clientOptions: { env: copilotEnvironment() },
        clientFactory: (clientOptions: any) => {
          const client: any = new CopilotClient({ ...clientOptions, baseDirectory: copilotHome, useLoggedInUser: false });
          const create = client.createSession.bind(client);
          const resume = client.resumeSession.bind(client);
          client.createSession = (sessionConfig: any) => create({ ...sessionConfig, provider });
          client.resumeSession = (id: string, sessionConfig: any) => resume(id, { ...sessionConfig, provider });
          return client;
        },
      } as any),
    });
    await daemon.start();
    await vi.waitFor(() => expect(handle.store.getEndpoint(actorId)?.bridge_id).toBe(BRIDGE), { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await daemon?.stop();
    try { await handle?.app.close(); } catch {}
    model?.server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function inventory(bindingId: string) {
    return {
      schema: "floe.workspace-configuration-inventory.v1", importer_version: "1", binding_id: bindingId,
      config_hash: `sha256:${"a".repeat(64)}`, source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
      validation: { ok: true, issues: [] },
      actors: [{
        source_actor_id: "floe",
        source: { kind: "workspace_actor_file", path: "agents/floe.md", source_fingerprint: `sha256:${"b".repeat(64)}` },
        definition: {
          label: "Floe", charter: "Help achieve the operator outcome.", responsibilities: [],
          instructions: "Work through the canonical substrate.", knowledge_refs: [],
          policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [],
        },
        runtime: {
          label: "Copilot", backing_kind: "model", adapter_id: "floe-runtime", configuration: { model: MODEL },
          required_capability_ids: [], checkpoint_policy: { mode: "none", schema_ref: null }, resource_policy: {},
          credential_requirement: "none", required_configuration_keys: ["model"],
        },
      }],
    };
  }

  function republish(change: Partial<ActorDefinitionContent>) {
    const store = handle.store.actorDefinitionStore;
    const current = store.getCurrentDefinition(actorId)!;
    const content = { ...current.content, ...change } as ActorDefinitionContent;
    if (change.scope === undefined && "scope" in change) delete (content as any).scope;
    const draft = store.createDraft({ actor_id: actorId, created_by_principal_id: "principal:operator", definition: content });
    store.publishDraft({ actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: current.actor_definition_revision_id, changed_by_principal_id: "principal:operator" });
  }

  function publishPolicy(category: "approval" | "operation", rules: unknown[]) {
    const created = handle.store.policyStore.createPolicy({
      workspace_id: WS, category, content: { label: `${category} policy`, description: "chosen by a person", rules: rules as never },
      created_by_principal_id: "principal:operator",
    });
    return handle.store.policyStore.publishRevision({
      workspace_id: WS, policy_revision_id: created.draft.policy_revision_id, expected_current_revision_id: null,
    }).revision;
  }

  /** One real turn in which the scripted model makes one tool call; returns what the model was told. */
  async function turn(call: ToolCall, onWaiting?: () => Promise<void>): Promise<string> {
    model.next.push(call);
    const results = model.toolResults.length;
    sent += 1;
    await emitViaRoute(handle, {
      type: "message", workspace_id: WS, source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: actorId }, thread_id: "", correlation_id: null,
      metadata: {}, content: { text: `turn ${sent}` }, idempotency_key: `turn-${sent}`,
    }, { headers: workspaceHeaders });
    if (onWaiting) await onWaiting();
    await vi.waitFor(() => expect(model.toolResults.length).toBe(results + 1), { timeout: 90_000, interval: 100 });
    await vi.waitFor(() => expect(handle.store.db.prepare(
      "SELECT COUNT(*) AS n FROM delivery_bundles WHERE endpoint_id = ? AND state NOT IN ('acknowledged', 'failed', 'dead_lettered')",
    ).get(actorId)).toEqual({ n: 0 }), { timeout: 30_000, interval: 100 });
    return model.toolResults[results]!;
  }

  function lastDecision(operationId: string) {
    const rows = handle.store.db.prepare(
      "SELECT evaluation_id, decision, facts_json, denial_reasons_json FROM policy_evaluations WHERE workspace_id = ? ORDER BY rowid DESC",
    ).all(WS) as Array<{ evaluation_id: string; decision: string; facts_json: string; denial_reasons_json: string }>;
    const row = rows.find((item) => JSON.parse(item.facts_json).operation_id === operationId)!;
    return { decision: row.decision, facts: JSON.parse(row.facts_json), denials: JSON.parse(row.denial_reasons_json) as string[] };
  }

  it("offers every built-in and runs any call inside the Workspace by default, recording each decision (proofs 2, 8)", async () => {
    const outside = join(root, "outside", "secret.txt");
    const blocked = await turn({ name: "view", args: { path: outside } });
    expect(blocked).toContain("authority.tool_path_outside_workspace");
    expect(blocked).not.toContain("outside-secret");
    const offered = model.requests.at(-1)!.tools;
    expect(offered).toEqual(expect.arrayContaining(["view", "grep", "glob", "create", "edit", "powershell", "web_fetch"]));
    expect(lastDecision("engine.tool.filesystem.read")).toMatchObject({ decision: "deny", facts: { tool: { paths: [], outside_path_count: 1 } } });

    expect(await turn({ name: "view", args: { path: join(workspace, "src", "a.txt") } })).toContain("inside-content");
    // A second folder is reachable once added.
    handle.store.workspaceAccessStore.addFolder({ workspace_id: WS, path: join(root, "outside"), principal_id: "principal:operator" });
    expect(await turn({ name: "view", args: { path: outside } })).toContain("outside-secret");
    handle.store.workspaceAccessStore.removeFolder({ workspace_id: WS,
      folder_id: handle.store.workspaceAccessStore.inspect(WS).folders[1]!.folder_id, principal_id: "principal:operator" });
    expect(await turn({ name: "view", args: { path: outside } })).toContain("authority.tool_path_outside_workspace");
    // System access reaches anywhere.
    handle.store.workspaceAccessStore.setSystemAccess({ workspace_id: WS, enabled: true, principal_id: "principal:operator" });
    expect(await turn({ name: "view", args: { path: outside } })).toContain("outside-secret");
    handle.store.workspaceAccessStore.setSystemAccess({ workspace_id: WS, enabled: false, principal_id: "principal:operator" });

    const marker = join(workspace, "made-by-shell.txt");
    await turn({ name: "powershell", args: { command: `Set-Content -Path '${marker}' -Value made`, description: "write a marker" } });
    expect(existsSync(marker)).toBe(true);
    expect(lastDecision("engine.tool.process.execute")).toMatchObject({ decision: "allow", facts: { tool: { executables: ["set-content"] } } });
    const stored = handle.store.db.prepare("SELECT facts_json FROM policy_evaluations WHERE workspace_id = ?").all(WS) as Array<{ facts_json: string }>;
    expect(stored.some((row) => row.facts_json.includes("-Value made") || row.facts_json.includes("outside-secret"))).toBe(false);

    const fetched = await turn({ name: "web_fetch", args: { url: `${modelUrl}/fetched` } });
    // Floe lets the fetch run; the CLI's own guard then refuses loopback addresses,
    // which keeps this proof off the internet.
    expect(lastDecision("engine.tool.network.fetch")).toMatchObject({ decision: "allow", facts: { tool: { native_tools: ["web_fetch"] } } });
    expect(fetched).toContain("WebFetchBlockedUrlError");
    expect(fetched).not.toContain("tool_policy_denied");
  }, 240_000);

  it("enforces chosen limits before any side effect, and refuses what the evidence cannot show (proofs 1, 4)", async () => {
    republish({ scope: { paths: ["src"] } });

    const inside = await turn({ name: "view", args: { path: join(workspace, "src", "a.txt") } });
    expect(inside).toContain("inside-content");

    for (const path of [join(root, "outside", "secret.txt"), join(workspace, "escape", "secret.txt")]) {
      const refused = await turn({ name: "view", args: { path } });
      expect(refused).toContain("authority.tool_path_outside_workspace");
      expect(refused).not.toContain("outside-secret");
    }
    expect(model.requests.some((request) => request.body.includes("outside-secret") && request.body.includes("tool_path_outside_workspace"))).toBe(false);

    const created = join(workspace, "src", "created.txt");
    await turn({ name: "create", args: { path: created, file_text: "written-inside" } });
    expect((await import("node:fs")).readFileSync(created, "utf8")).toBe("written-inside");
    expect(lastDecision("engine.tool.filesystem.write")).toMatchObject({ decision: "allow", facts: { tool: { paths: ["src/created.txt"] } } });
    const outsideWrite = join(workspace, "not-in-src.txt");
    const refusedWrite = await turn({ name: "create", args: { path: outsideWrite, file_text: "no" } });
    expect(refusedWrite).toContain("authority.tool_path_outside_scope");
    expect(existsSync(outsideWrite)).toBe(false);

    const marker = join(workspace, "blocked-shell.txt");
    const shell = await turn({ name: "powershell", args: { command: `Set-Content -Path '${marker}' -Value no`, description: "blocked" } });
    expect(shell).toContain("authority.tool_shell_unconfined");
    expect(existsSync(marker)).toBe(false);

    const ceiling = publishPolicy("operation", [{
      rule_id: "no-fetch", priority: 1, match: { operation_ids: ["engine.tool.network.fetch"] },
      effect: { kind: "deny", reason: "This Workspace does not fetch." },
    }]);
    handle.store.policyStore.bindRevision({ workspace_id: WS, policy_revision_id: ceiling.policy_revision_id,
      subject: { kind: "workspace", id: WS }, bound_by_principal_id: "principal:operator" });
    const hits = model.hits.length;
    const fetch = await turn({ name: "web_fetch", args: { url: `${modelUrl}/blocked` } });
    expect(fetch).toContain("This Workspace does not fetch.");
    expect(model.hits.length).toBe(hits);
    expect(lastDecision("engine.tool.network.fetch").decision).toBe("deny");
  }, 240_000);

  it("asks a person only under a chosen rule, and runs the same call once on approval (proof 3)", async () => {
    handle.store.capabilityGrantStore.issueGrant({
      principal_id: OPERATOR, boundary: { kind: "workspace", workspace_id: WS }, operation_ids: ["approval.decide"],
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "principal:operator", evidence: [{ kind: "test_fixture", ref: "approver" }],
    });
    const approval = publishPolicy("approval", [{
      rule_id: "ask-before-shell", priority: 1, match: { operation_ids: ["engine.tool.process.execute"] },
      effect: { kind: "require_approval", reason: "Shell needs a person.", approvers: { mode: "any", principal_ids: [OPERATOR], roles: [] } },
    }]);
    republish({ scope: undefined, policy_refs: { budget: null, trust: null,
      approval: { kind: "policy", id: approval.policy_id, revision: approval.policy_revision_id } } } as any);

    const marker = join(workspace, "approved-shell.txt");
    let requestId = "";
    await turn({ name: "powershell", args: { command: `Add-Content -Path '${marker}' -Value once`, description: "needs approval" } }, async () => {
      await vi.waitFor(() => {
        const pending = handle.store.db.prepare("SELECT approval_request_id FROM approval_requests WHERE workspace_id = ? AND status = 'pending'")
          .all(WS) as Array<{ approval_request_id: string }>;
        expect(pending).toHaveLength(1);
        requestId = pending[0]!.approval_request_id;
      }, { timeout: 90_000, interval: 100 });
      expect(existsSync(marker)).toBe(false);
      const request = handle.store.approvalStore.requireRequestForWorkspace(requestId, WS);
      handle.store.decideApprovalRequest({
        workspace_id: WS, approval_request_id: requestId, expected_state_revision: request.state_revision,
        decision: "approved", decided_by_principal_id: OPERATOR, decision_reason: "checked", operation_invocation_id: `invoke:${requestId}`,
      });
    });
    expect(existsSync(marker)).toBe(true);
    expect((await import("node:fs")).readFileSync(marker, "utf8").trim()).toBe("once");
    const receipt = handle.store.approvalStore.getReceiptForRequest(requestId)!;
    expect(handle.store.approvalStore.getReceipt(receipt.approval_receipt_id)!.use_count).toBe(1);
  }, 240_000);
});
