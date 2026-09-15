import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig, type LocalConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import { BusClient } from "../../floe-bridge/src/bus-client.js";
import {
  encodeTransportPushCursor,
  TransportPushStreamStore,
} from "./transport-push-stream.js";

const HOST_TOKEN = `floe-native-host-${"h".repeat(48)}`;
const WORKSPACE_ONE = "workspace:transport-one";
const WORKSPACE_TWO = "workspace:transport-two";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
type WsClient = {
  close(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
};

describe("authenticated Bus transport boundary", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function makeServer(): Promise<{
    handle: ServerHandle;
    cleanup: () => Promise<void>;
  }> {
    const directory = mkdtempSync(join(tmpdir(), "floe-transport-boundary-"));
    const configPath = join(directory, "config.yaml");
    const config: LocalConfig = defaultConfig(directory);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const handle = await createBusServer(configPath, config, {
      host_control_token: HOST_TOKEN,
      host_control_expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    await handle.app.ready();
    const timestamp = new Date().toISOString();
    for (const [workspaceId, name, locator] of [
      [WORKSPACE_ONE, "Transport One", "C:\\FloeTest\\TransportOne"],
      [WORKSPACE_TWO, "Transport Two", "C:\\FloeTest\\TransportTwo"],
    ] as const) {
      handle.store.workspaceIdentityStore.restoreWorkspace({
        snapshot: {
          workspace_id: workspaceId,
          name,
          creation_kind: "created",
          source_workspace_id: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
        binding: {
          host_id: handle.store.localHostId,
          platform: "windows",
          locator,
          init_authorized: true,
        },
      });
    }
    const cleanup = async () => {
      try { await handle.app.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    };
    cleanups.push(cleanup);
    return { handle, cleanup };
  }

  async function issueWorkspaceSession(handle: ServerHandle, workspaceId: string): Promise<string> {
    const response = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      headers: bearer(HOST_TOKEN),
      payload: { interaction_session_id: `interaction:${workspaceId}` },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().bearer_token as string;
  }

  it("separates audiences and derives identity instead of trusting request bodies", async () => {
    const { handle } = await makeServer();
    const issuedBridge = handle.issueBridgeServiceCredential("bridge:desktop");
    const bridgeHeaders = bearer(issuedBridge.bearer_token);
    const workspaceToken = await issueWorkspaceSession(handle, WORKSPACE_ONE);

    const hostAtBridge = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearer(HOST_TOKEN),
      payload: { capabilities: {} },
    });
    const bridgeAtHost = await handle.app.inject({
      method: "GET",
      url: "/v1/local/workspaces",
      headers: bridgeHeaders,
    });
    const workspaceAtHost = await handle.app.inject({
      method: "GET",
      url: "/v1/local/workspaces",
      headers: bearer(workspaceToken),
    });
    expect([hostAtBridge.statusCode, bridgeAtHost.statusCode, workspaceAtHost.statusCode])
      .toEqual([401, 401, 401]);

    const spoofed = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bridgeHeaders,
      payload: { bridge_id: "bridge:attacker", capabilities: {} },
    });
    expect(spoofed.statusCode).toBe(403);

    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bridgeHeaders,
      payload: { capabilities: { runtime_adapters: ["pi-agent-core"] } },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().bridge.bridge_id).toBe("bridge:desktop");

    const issuerSpoof = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(WORKSPACE_ONE)}/operation-sessions`,
      headers: bearer(HOST_TOKEN),
      payload: {
        principal_id: "principal:attacker",
        grant_ids: ["grant:attacker"],
      },
    });
    expect(issuerSpoof.statusCode).toBe(400);
    expect(issuerSpoof.json()).toMatchObject({
      error: "workspace_operation_session_request_invalid",
    });

    const workspaceAtOtherWorkspace = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(WORKSPACE_TWO)}/scopes`,
      headers: bearer(workspaceToken),
    });
    expect(workspaceAtOtherWorkspace.statusCode).toBe(401);
  });

  it("keeps a real Bridge connected after a watcher operation rejects its audience", async () => {
    const { handle } = await makeServer();
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const issued = handle.issueBridgeServiceCredential("bridge:refused-watcher");
    const client = new BusClient(address, { audience: "bridge_service", bearer_token: issued.bearer_token });
    await client.registerBridge({});
    await expect(client.fireScopeGraphTriggerNode(WORKSPACE_ONE, "legacy-graph", "folder-arrival"))
      .rejects.toThrow(/401/);
    expect(client.authorityState).toEqual({ status: "available", audience: "bridge_service" });
    // The refused route stays inaccessible. Other authorised work still uses
    // the original credential; no reprovisioning or privileged fallback occurs.
    await expect(client.listWorkspaces()).resolves.toBeInstanceOf(Array);
    await expect(client.reportBridgeLiveness()).resolves.toBeUndefined();
  });

  it.each(["claim", "push"] as const)("issues runtime operation authority only to the owning Bridge through %s", async (deliveryPath) => {
    const { handle } = await makeServer();
    const owner = handle.issueBridgeServiceCredential("bridge:runtime-owner");
    const other = handle.issueBridgeServiceCredential("bridge:runtime-other");
    const workspaceToken = await issueWorkspaceSession(handle, WORKSPACE_ONE);
    for (const issued of [owner, other]) {
      const registered = await handle.app.inject({
        method: "POST",
        url: "/v1/bridges/register",
        headers: bearer(issued.bearer_token),
        payload: { capabilities: {} },
      });
      expect(registered.statusCode, registered.body).toBe(201);
    }

    const actorId = "actor:transport-one:runtime-worker";
    const registeredActor = await handle.app.inject({
      method: "POST",
      url: "/v1/endpoints/register",
      headers: bearer(owner.bearer_token),
      payload: {
        endpoint_id: actorId,
        workspace_id: WORKSPACE_ONE,
        name: "Runtime worker",
      },
    });
    expect(registeredActor.statusCode, registeredActor.body).toBe(201);
    registerExecutableActorFixture(handle.store, WORKSPACE_ONE, actorId);
    handle.store.registerEndpoint({
      endpoint_id: "operator:transport-one",
      workspace_id: WORKSPACE_ONE,
      name: "Operator",
      bridge_id: null,
      status: "idle",
    }, handle.broadcast);
    const stream = deliveryPath === "push"
      ? await openSocket((await handle.app.listen({ host: "127.0.0.1", port: 0 })).replace(/^http/, "ws") + "/v1/events/stream")
      : null;
    if (stream) {
      cleanups.push(async () => { await closeSocket(stream.socket); });
      stream.socket.send(JSON.stringify({ type: "authenticate", bearer_token: owner.bearer_token }));
      await waitFor(stream.messages, message => message.type === "caught_up");
    }
    const submitted = await emitViaRoute(handle, {
      type: "message",
      workspace_id: WORKSPACE_ONE,
      source_endpoint_id: "operator:transport-one",
      destination: { kind: "endpoint", endpoint_id: actorId },
      thread_id: "",
      correlation_id: null,
      content: { text: "Do the bounded work." },
      metadata: {},
      idempotency_key: null,
    }, { headers: bearer(workspaceToken) });

    let claimed: Record<string, unknown>;
    if (stream) {
      const frame = await waitFor(stream.messages, message => message.type === "delivery_bundle_available");
      claimed = frame.payload.delivery;
    } else {
      const claim = await handle.app.inject({ method: "GET", url: "/v1/delivery/claim", headers: bearer(owner.bearer_token) });
      expect(claim.statusCode, claim.body).toBe(200);
      claimed = claim.json().deliveries[0];
    }
    expect(claimed).not.toHaveProperty("processing_contract");
    const deliveryId = String(claimed.delivery_id);

    const refused = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
      headers: bearer(other.bearer_token),
    });
    expect(refused.statusCode).toBe(403);

    if (stream) {
      const reservation = handle.store.db.prepare(
        "SELECT state, claimed_at, lease_expires_at FROM delivery_bundles WHERE delivery_id = ?",
      ).get(deliveryId) as { state: string; claimed_at: string | null; lease_expires_at: string };
      expect(reservation).toMatchObject({ state: "reserved", claimed_at: null });
      handle.store.db.prepare("UPDATE delivery_bundles SET lease_expires_at = ? WHERE delivery_id = ?")
        .run("2000-01-01T00:00:00.000Z", deliveryId);
      const expired = await handle.app.inject({
        method: "POST",
        url: `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
        headers: bearer(owner.bearer_token),
      });
      expect(expired.statusCode, expired.body).toBe(409);
      expect(expired.json().message).toMatch(/reservation expired/);
      expect(handle.store.db.prepare("SELECT state, claimed_at FROM delivery_bundles WHERE delivery_id = ?")
        .get(deliveryId)).toMatchObject({ state: "reserved", claimed_at: null });
      handle.store.db.prepare("UPDATE delivery_bundles SET lease_expires_at = ? WHERE delivery_id = ?")
        .run(reservation.lease_expires_at, deliveryId);
    }

    const response = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
      headers: bearer(owner.bearer_token),
    });
    expect(response.statusCode, response.body).toBe(200);
    const prepared = response.json();
    expect(handle.store.db.prepare("SELECT state, claimed_at FROM delivery_bundles WHERE delivery_id = ?")
      .get(deliveryId)).toMatchObject({ state: "delivered_to_bridge", claimed_at: expect.any(String) });
    expect(handle.store.db.prepare("SELECT state FROM event_queue WHERE delivery_id = ?")
      .all(deliveryId)).toEqual([expect.objectContaining({ state: "delivered_to_bridge" })]);
    expect(prepared).toMatchObject({
      delivery: {
        delivery_id: deliveryId,
        operation_authority_session_id: expect.any(String),
      },
      processing_contract: {
        contract_kind: "direct_context",
        workspace_id: WORKSPACE_ONE,
        actor: { actor_id: actorId },
      },
      operation_authority_session: {
        authority_session_id: expect.any(String),
        bearer_token: expect.stringMatching(/^floe_operation_/),
        expires_at: expect.any(String),
      },
    });
    expect(prepared.delivery.operation_authority_session_id)
      .toBe(prepared.operation_authority_session.authority_session_id);
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      prepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WORKSPACE_ONE } },
    )).toMatchObject({
      verified: true,
      authority: { principal_id: actorId },
      provenance: {
        cause_event_id: submitted.event.event_id,
        delivery_ids: claimed.stable_delivery_ids,
      },
    });

    const injected = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/status`,
      headers: bearer(owner.bearer_token),
      payload: { state: "injected_to_runtime" },
    });
    expect(injected.statusCode, injected.body).toBe(200);
    const inspected = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(WORKSPACE_ONE)}/operations/invoke`,
      headers: bearer(prepared.operation_authority_session.bearer_token),
      payload: {
        operation_id: "context.inspect",
        operation_version: "1",
        input_schema_version: "1",
        idempotency_key: `runtime-inspection:${deliveryId}`,
        target: { kind: "context", id: submitted.event.context_id },
        input: {},
      },
    });
    expect(inspected.statusCode, inspected.body).toBe(200);
    expect(inspected.json().receipt, inspected.body).toMatchObject({ state: "completed" });
    const wrongBridgeRenewal = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
      headers: bearer(other.bearer_token),
    });
    expect(wrongBridgeRenewal.statusCode).toBe(403);
    const renewal = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
      headers: bearer(owner.bearer_token),
    });
    expect(renewal.statusCode, renewal.body).toBe(200);
    const renewed = renewal.json();
    expect(renewed.processing_contract).toEqual(prepared.processing_contract);
    expect(renewed.operation_authority_session.authority_session_id)
      .not.toBe(prepared.operation_authority_session.authority_session_id);
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      prepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WORKSPACE_ONE } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });

    const acknowledged = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/status`,
      headers: bearer(owner.bearer_token),
      payload: { state: "acknowledged" },
    });
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    const terminalRenewal = await handle.app.inject({
      method: "POST",
      url: `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
      headers: bearer(owner.bearer_token),
    });
    expect(terminalRenewal.statusCode).toBe(409);
  });

  it("filters Bridge workspace bindings by the credential-bound host", async () => {
    const { handle } = await makeServer();
    const local = handle.issueBridgeServiceCredential("bridge:local");
    const remote = handle.store.transportCredentialStore.issueBridgeServiceCredential({
      bridge_id: "bridge:remote",
      host_id: "host:remote",
      expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });

    const localResponse = await handle.app.inject({
      method: "GET",
      url: "/v1/bridge/workspace-bindings",
      headers: bearer(local.bearer_token),
    });
    expect(localResponse.statusCode).toBe(200);
    expect(localResponse.json().workspaces.map((item: any) => item.workspace_id).sort())
      .toEqual([WORKSPACE_ONE, WORKSPACE_TWO].sort());
    expect(localResponse.json().workspaces[0].binding).toMatchObject({
      host_id: handle.store.localHostId,
      binding_id: expect.any(String),
    });

    const remoteResponse = await handle.app.inject({
      method: "GET",
      url: "/v1/bridge/workspace-bindings",
      headers: bearer(remote.bearer_token),
    });
    expect(remoteResponse.statusCode).toBe(200);
    expect(remoteResponse.json().workspaces).toEqual([]);
  });

  it("refuses cross-Workspace resource evidence instead of trusting a claimed Workspace", async () => {
    const { handle } = await makeServer();
    const localBridge = handle.issueBridgeServiceCredential("bridge:boundary");
    const remoteBridge = handle.store.transportCredentialStore.issueBridgeServiceCredential({
      bridge_id: "bridge:remote-boundary",
      host_id: "host:remote",
      expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    for (const [workspaceId, endpointId] of [
      [WORKSPACE_ONE, "actor:transport-one:worker"],
      [WORKSPACE_TWO, "actor:transport-two:worker"],
    ] as const) {
      const response = await handle.app.inject({
        method: "POST",
        url: "/v1/endpoints/register",
        headers: bearer(localBridge.bearer_token),
        payload: { endpoint_id: endpointId, workspace_id: workspaceId, name: endpointId },
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    const contextInTwo = handle.store.contextStore.createContext({
      workspace_id: WORKSPACE_TWO,
      created_by_endpoint_id: "actor:transport-two:worker",
      participants: ["actor:transport-two:worker"],
    });
    const workspaceOneToken = await issueWorkspaceSession(handle, WORKSPACE_ONE);

    const conflictingContext = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(contextInTwo)}?workspace_id=${encodeURIComponent(WORKSPACE_ONE)}`,
      headers: bearer(workspaceOneToken),
    });
    expect(conflictingContext.statusCode).toBe(403);
    expect(conflictingContext.json()).toEqual({
      error: "transport_authority_forbidden",
      message: "The authenticated connection cannot act on that resource.",
    });

    const remoteAtLocalWorkspace = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(WORKSPACE_ONE)}/endpoints`,
      headers: bearer(remoteBridge.bearer_token),
    });
    expect(remoteAtLocalWorkspace.statusCode).toBe(403);

    const spoofedEventWorkspace = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      headers: bearer(localBridge.bearer_token),
      payload: {
        type: "message",
        workspace_id: WORKSPACE_TWO,
        source_endpoint_id: "actor:transport-one:worker",
        destination: {
          kind: "endpoint",
          endpoint_id: "actor:transport-two:worker",
        },
        content: { text: "cross-boundary" },
      },
    });
    expect(spoofedEventWorkspace.statusCode).toBe(403);
  });

  it("preserves exact emitted attachments independently of later Artefact associations", async () => {
    const { handle } = await makeServer();
    const bridge = handle.issueBridgeServiceCredential("bridge:attachments");
    const actorId = "actor:transport-one:publisher";
    const readerId = "actor:transport-one:reader";
    for (const endpointId of [actorId, readerId]) {
      handle.store.registerEndpoint({
        endpoint_id: endpointId, workspace_id: WORKSPACE_ONE, name: endpointId,
        bridge_id: "bridge:attachments", status: "idle",
      }, handle.broadcast);
    }
    const artefact = handle.store.artefactStore.createArtefact({
      workspace_id: WORKSPACE_ONE, type_ref: "core:text", idempotency_key: "attachment-brief",
    });
    const versions = ["first", "later"].map(key => handle.store.artefactStore.publishVersion({
      artefact_id: artefact.artefact_id, idempotency_key: key,
      content_ref: { kind: "external-revision", resolver_id: "fixture", external_id: "brief", revision: key },
    }).artefact_version_id);
    const payload = {
      type: "message", workspace_id: WORKSPACE_ONE, source_endpoint_id: actorId,
      destination: { kind: "endpoint", endpoint_id: readerId },
      content: { text: "The exact brief is attached." },
      artefact_version_ids: [versions[0]], idempotency_key: "emit-exact-brief",
    };
    const emitted = await handle.app.inject({
      method: "POST", url: "/v1/events/emit", headers: bearer(bridge.bearer_token), payload,
    });
    expect(emitted.statusCode, emitted.body).toBe(202);
    expect(emitted.json().event.artefact_version_ids).toEqual([versions[0]]);
    const eventId = emitted.json().event_id;
    for (const [index, role] of ["output", "attachment"].entries()) {
      handle.store.artefactStore.associateVersion({
        artefact_version_id: versions[1], target_kind: "event", target_id: eventId,
        role: role as "output" | "attachment", idempotency_key: `later-association:${index}`,
      });
    }
    expect(handle.store.getEvent(eventId)?.artefact_version_ids).toEqual([versions[0]]);
    const replayed = await handle.app.inject({
      method: "POST", url: "/v1/events/emit", headers: bearer(bridge.bearer_token), payload,
    });
    expect(replayed.json().event).toEqual(emitted.json().event);
    const claimed = await handle.app.inject({
      method: "GET", url: "/v1/delivery/claim?limit=10", headers: bearer(bridge.bearer_token),
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().deliveries.flatMap((delivery: any) => delivery.events))
      .toEqual([emitted.json().event]);
  });

  it("returns the same denial for revoked and expired Bridge credentials", async () => {
    const { handle } = await makeServer();
    const revoked = handle.issueBridgeServiceCredential("bridge:revoked");
    expect(handle.revokeBridgeServiceCredential(
      revoked.credential.transport_credential_id,
      "bridge:revoked",
    )).toBe(true);

    const revokedResponse = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearer(revoked.bearer_token),
      payload: { capabilities: {} },
    });
    expect(revokedResponse.statusCode).toBe(401);
    expect(revokedResponse.json()).toEqual(genericTransportDenial());

    const expired = handle.issueBridgeServiceCredential(
      "bridge:expired",
      new Date(Date.now() + 40).toISOString(),
    );
    await delay(80);
    const expiredResponse = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearer(expired.bearer_token),
      payload: { capabilities: {} },
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(expiredResponse.json()).toEqual(genericTransportDenial());
  });

  it("atomically replaces the trusted Bridge process credential on restart", async () => {
    const { handle } = await makeServer();
    const previous = handle.issueBridgeServiceCredential("bridge:restarted");
    const current = handle.replaceBridgeServiceCredential("bridge:restarted");

    const previousResponse = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearer(previous.bearer_token),
      payload: { capabilities: {} },
    });
    expect(previousResponse.statusCode).toBe(401);
    expect(previousResponse.json()).toEqual(genericTransportDenial());

    const currentResponse = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearer(current.bearer_token),
      payload: { capabilities: {} },
    });
    expect(currentResponse.statusCode, currentResponse.body).toBe(201);
    expect(currentResponse.json().bridge.bridge_id).toBe("bridge:restarted");
  });

  it("sends no WebSocket state before the first-frame credential is authorized", async () => {
    const { handle } = await makeServer();
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const { socket, messages } = await openSocket(address.replace(/^http/, "ws") + "/v1/events/stream");

    await delay(100);
    expect(messages).toEqual([]);

    socket.send(JSON.stringify({ type: "authenticate", bearer_token: HOST_TOKEN }));
    await waitFor(messages, (message) => message.type === "caught_up");
    expect(messages[0]).toMatchObject({
      type: "authenticated",
      payload: { audience: "host_control", host_id: handle.store.localHostId },
    });
    socket.close();
  });

  it("isolates Workspace streams and replays missed updates from an opaque cursor", async () => {
    const { handle } = await makeServer();
    const firstToken = await issueWorkspaceSession(handle, WORKSPACE_ONE);
    const secondToken = await issueWorkspaceSession(handle, WORKSPACE_TWO);
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const streamUrl = address.replace(/^http/, "ws") + "/v1/events/stream";
    const first = await openSocket(streamUrl);
    const second = await openSocket(streamUrl);
    first.socket.send(JSON.stringify({
      type: "authenticate",
      bearer_token: firstToken,
      workspace_id: WORKSPACE_ONE,
    }));
    second.socket.send(JSON.stringify({
      type: "authenticate",
      bearer_token: secondToken,
      workspace_id: WORKSPACE_TWO,
    }));
    await Promise.all([
      waitFor(first.messages, (message) => message.type === "caught_up"),
      waitFor(second.messages, (message) => message.type === "caught_up"),
    ]);

    handle.broadcast("transport_test_update", { workspace_id: WORKSPACE_ONE, value: "first" });
    const received = await waitFor(
      first.messages,
      (message) => message.type === "transport_test_update" && message.payload?.value === "first",
    );
    await delay(75);
    expect(second.messages.some((message) => message.type === "transport_test_update")).toBe(false);
    expect(received.cursor).toEqual(expect.any(String));
    expect(received.cursor).not.toBe("1");

    await closeSocket(first.socket);
    handle.broadcast("transport_test_update", { workspace_id: WORKSPACE_TWO, value: "hidden" });
    handle.broadcast("transport_test_update", { workspace_id: WORKSPACE_ONE, value: "missed" });

    const resumed = await openSocket(streamUrl);
    resumed.socket.send(JSON.stringify({
      type: "authenticate",
      bearer_token: firstToken,
      workspace_id: WORKSPACE_ONE,
      after_cursor: received.cursor,
    }));
    const replayed = await waitFor(
      resumed.messages,
      (message) => message.type === "transport_test_update" && message.payload?.value === "missed",
    );
    expect(replayed.cursor).toEqual(expect.any(String));
    expect(resumed.messages.some((message) => message.payload?.value === "hidden")).toBe(false);

    second.socket.close();
    resumed.socket.close();
  });

  it("starts a snapshot client at the current cursor and still replays changes missed on reconnect", async () => {
    const { handle } = await makeServer();
    const token = await issueWorkspaceSession(handle, WORKSPACE_ONE);
    handle.broadcast("snapshot_test", { workspace_id: WORKSPACE_ONE, value: "old" });
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const url = address.replace(/^http/, "ws") + "/v1/events/stream";
    const first = await openSocket(url);
    first.socket.send(JSON.stringify({ type: "authenticate", bearer_token: token,
      workspace_id: WORKSPACE_ONE, start_at: "current" }));
    await waitFor(first.messages, message => message.type === "caught_up");
    expect(first.messages.map(message => message.type)).toEqual(["authenticated", "caught_up"]);
    const cursor = first.messages[0].payload.cursor;
    expect(cursor).toEqual(expect.any(String));
    // The subscription is established before the client reads its snapshot.
    handle.broadcast("snapshot_test", { workspace_id: WORKSPACE_ONE, value: "during snapshot" });
    await waitFor(first.messages, message => message.payload?.value === "during snapshot");
    await closeSocket(first.socket);
    handle.broadcast("snapshot_test", { workspace_id: WORKSPACE_ONE, value: "offline" });
    const resumed = await openSocket(url);
    resumed.socket.send(JSON.stringify({ type: "authenticate", bearer_token: token,
      workspace_id: WORKSPACE_ONE, after_cursor: cursor }));
    await waitFor(resumed.messages, message => message.type === "caught_up");
    expect(resumed.messages.filter(message => message.type === "snapshot_test").map(message => message.payload.value))
      .toEqual(["during snapshot", "offline"]);
    resumed.socket.close();
  });

  it("refuses an ambiguous current-start cursor and preserves Bridge checkpoint discipline", async () => {
    const { handle } = await makeServer();
    const token = await issueWorkspaceSession(handle, WORKSPACE_ONE);
    const bridge = handle.issueBridgeServiceCredential("bridge:start-position");
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    for (const authentication of [
      { bearer_token: token, workspace_id: WORKSPACE_ONE, start_at: "current", after_cursor: null },
      { bearer_token: bridge.bearer_token, start_at: "current" },
    ]) {
      const stream = await openSocket(address.replace(/^http/, "ws") + "/v1/events/stream");
      const closed = socketClose(stream.socket);
      stream.socket.send(JSON.stringify({ type: "authenticate", ...authentication }));
      await expect(closed).resolves.toBe(4400);
      expect(stream.messages).toEqual([]);
    }
  });

  it("rejects a fabricated future cursor and durably resumes a Bridge from its acknowledged cursor", async () => {
    const { handle } = await makeServer();
    const bridge = handle.issueBridgeServiceCredential("bridge:cursor");
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearer(bridge.bearer_token),
      payload: { capabilities: {} },
    });
    expect(registered.statusCode).toBe(201);
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const streamUrl = address.replace(/^http/, "ws") + "/v1/events/stream";

    const future = await openSocket(streamUrl);
    const futureClosed = socketClose(future.socket);
    future.socket.send(JSON.stringify({
      type: "authenticate",
      bearer_token: bridge.bearer_token,
      after_cursor: encodeTransportPushCursor(9_999_999),
    }));
    await expect(futureClosed).resolves.toBe(4400);
    expect(future.messages).toEqual([]);

    const first = await openSocket(streamUrl);
    first.socket.send(JSON.stringify({ type: "authenticate", bearer_token: bridge.bearer_token }));
    await waitFor(first.messages, (message) => message.type === "caught_up");
    handle.broadcast("bridge_cursor_test", { workspace_id: WORKSPACE_ONE, value: "accepted" });
    const accepted = await waitFor(
      first.messages,
      (message) => message.type === "bridge_cursor_test" && message.payload?.value === "accepted",
    );
    first.socket.send(JSON.stringify({ type: "acknowledge_cursor", cursor: accepted.cursor }));
    await waitFor(
      first.messages,
      (message) => message.type === "cursor_acknowledged" && message.payload?.cursor === accepted.cursor,
    );
    expect(new TransportPushStreamStore(handle.store.db).getBridgeCheckpoint("bridge:cursor"))
      .toBe(accepted.cursor);
    await closeSocket(first.socket);

    handle.broadcast("bridge_cursor_test", { workspace_id: WORKSPACE_ONE, value: "after-restart" });
    const resumed = await openSocket(streamUrl);
    resumed.socket.send(JSON.stringify({ type: "authenticate", bearer_token: bridge.bearer_token }));
    const authenticated = await waitFor(resumed.messages, (message) => message.type === "authenticated");
    expect(authenticated.payload?.cursor).toBe(accepted.cursor);
    await waitFor(
      resumed.messages,
      (message) => message.type === "bridge_cursor_test" && message.payload?.value === "after-restart",
    );
    resumed.socket.close();
  });
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function genericTransportDenial() {
  return {
    error: "transport_auth_required",
    message: "The transport credential was not accepted.",
  };
}

async function openSocket(url: string): Promise<{ socket: WsClient; messages: any[] }> {
  const wsModule = await import("ws" as any);
  const WebSocketConstructor = (wsModule as any).WebSocket ?? (wsModule as any).default;
  const socket = new WebSocketConstructor(url) as WsClient;
  const messages: any[] = [];
  socket.on("message", (data: any) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  return { socket, messages };
}

async function waitFor(
  messages: any[],
  predicate: (message: any) => boolean,
  timeoutMs = 2_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await delay(10);
  }
  throw new Error(`Timed out waiting for stream frame. Received: ${JSON.stringify(messages)}`);
}

function socketClose(socket: WsClient): Promise<number> {
  return new Promise((resolve) => socket.on("close", (code: number) => resolve(code)));
}

async function closeSocket(socket: WsClient): Promise<void> {
  const closed = socketClose(socket);
  socket.close();
  await closed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
