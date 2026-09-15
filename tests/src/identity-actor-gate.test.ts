import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateSeedWords, privateKeyFromSeedWords } from "nostr-tools/nip06";
import { nip19 } from "nostr-tools";
import { SliceHarness, waitFor, type SliceTier } from "./slice-harness.js";
import { fetchHostControlToken } from "../../floe-cli/src/operation-client.js";

/**
 * The identity-actor gate.
 *
 * The whole premise, proven end to end with nothing hand-made:
 *   an Actor, during a REAL turn, asks another Actor whose turns a client
 *   executes; the client LEARNS OF THE WORK BY PUSH on the stream it already
 *   holds, CLAIMS the delivery, and ENDS ITS TURN by reporting a result with no
 *   context and no assembled event — exactly as a model's turn ends. The asking
 *   Actor resumes IN ITS ORIGINAL CONTEXT.
 *
 * This gate is context-checking, not context-blind. The prior gate passed only
 * because the fake adapter recorded any delivered text regardless of context,
 * so a reply landing in a fresh context still looked like success. Here the
 * asker's resumed output is asserted to carry the request's own
 * request_return_context_id, so a reply that misroutes to a new context fails.
 *
 * The operator Actor is created by `register` (the same act that creates any
 * Actor) — the test never seeds it. The asking Actor's request is issued by the
 * fake runtime executing the shared `request` substrate tool during its turn —
 * the pending dependency is produced by the substrate, not planted. The client
 * holds only an admitted-keypair workspace_operation bearer, and answers through
 * the same claim + turn-result routes a model runtime uses.
 */
const FAKE_TIER: SliceTier = { id: "fake", adapter: "fake", provider: "fake", model: "fake", live: false };

describe("identity-actor gate [fake]", () => {
  const h = new SliceHarness(FAKE_TIER);

  beforeEach(async () => {
    await h.start();
  }, 60_000);

  afterEach(async () => {
    await h.stop();
  });

  it("an Actor asks a client-executed Actor, a client answers over real routes, the asker resumes", async () => {
    const busUrl = h.busUrl;
    const authz = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
    const jsonAuth = (token: string): Record<string, string> => ({ "content-type": "application/json", ...authz(token) });
    const asJson = async (res: Response): Promise<any> => { try { return await res.json(); } catch { return {}; } };

    // 1. Register the workspace. This alone creates the operator Actor — the
    //    same creation path as any Actor. Nothing here seeds it by hand.
    const workspaceId = await h.registerAndAuthorize(h.projectPath);
    const operatorEndpoint = `actor:${workspaceId}:operator`;
    const askerEndpoint = `actor:${workspaceId}:floe`;

    // The operator Actor exists purely from register, with no bridge behind it.
    await waitFor(async () => {
      const { endpoints } = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.some((e) => e.endpoint_id === operatorEndpoint);
    }, "operator Actor created by register");

    // The asking Actor (the workspace's floe agent) reaches idle on the fake
    // adapter, ready to run a turn.
    await waitFor(async () => {
      const { endpoints } = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.some((e) => e.endpoint_id === askerEndpoint);
    }, "asking Actor registered");
    await h.post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: "fake",
      model: "fake",
    });
    await waitFor(async () => {
      const { endpoints } = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.some((e) => e.endpoint_id === askerEndpoint && e.status === "idle");
    }, "asking Actor runtime configured");

    // 2. Admit a client keypair to this workspace (host_control, the trust
    //    anchor). The client owns the key; the substrate only stores the pubkey.
    const hostToken = await fetchHostControlToken();
    const mnemonic = generateSeedWords();
    const sk = privateKeyFromSeedWords(mnemonic);
    const npub = nip19.npubEncode(getPublicKey(sk));
    const admitted = await asJson(await fetch(`${busUrl}/v1/identities`, {
      method: "POST",
      headers: jsonAuth(hostToken),
      body: JSON.stringify({ display_name: "Console", pubkey: npub, workspace_id: workspaceId }),
    }));
    expect(admitted?.identity?.identity_id ?? admitted?.identity_id).toBeTruthy();

    // 3. The client authenticates with a signed challenge and is minted a
    //    workspace-scoped bearer. No host_control, no configured workspace id.
    const challenge = async (): Promise<{ challenge: string; relay: string }> =>
      asJson(await fetch(`${busUrl}/v1/identity/challenge`));
    const sign = (ch: { challenge: string; relay: string }) =>
      finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [["relay", ch.relay], ["challenge", ch.challenge]], content: "" }, sk);
    const authed = await asJson(await fetch(`${busUrl}/v1/identity/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, auth_event: sign(await challenge()) }),
    }));
    const clientBearer = authed?.bearer_token as string;
    expect(clientBearer).toBeTruthy();
    expect(authed.workspace_id).toBe(workspaceId);

    // The client discovers the Actor it executes through ORDINARY Actor listing:
    // it filters on the resolved runtime adapter (`client`), never a role marker
    // and never a constructed id convention. It is also refused a host_control
    // route. F-DISCOVERY: ordinary listing alone is sufficient.
    const listed = await asJson(await fetch(`${busUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`, { headers: authz(clientBearer) }));
    const clientExecuted = (listed.endpoints ?? []).filter((e: any) => e.adapter_id === "client");
    expect(clientExecuted.length).toBeGreaterThan(0);
    const operator = clientExecuted.find((e: any) => e.endpoint_id === operatorEndpoint);
    expect(operator).toBeTruthy();
    const clientsProbe = await fetch(`${busUrl}/v1/clients`, { headers: authz(clientBearer) });
    expect([401, 403]).toContain(clientsProbe.status);

    // 4. Drive a REAL turn on the asking Actor that issues a `request` to the
    //    operator. The ask is data on a delivered event; the fake runtime runs
    //    the shared substrate request tool — the pending row is the substrate's.
    const question = "Operator, approve the deploy?";
    await h.post("/v1/events/emit", {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: operatorEndpoint,
      destination: { kind: "endpoint", endpoint_id: askerEndpoint },
      thread_id: "thread:gate",
      correlation_id: null,
      content: { text: "Ask the operator to approve.", data: { ask: { actor: operatorEndpoint, work: question } } },
      response: { expected: false },
      metadata: {},
    });

    // 5. The client opens the authenticated stream it already holds and LEARNS
    //    OF THE WORK BY PUSH — a delivery_bundle_available frame for the operator
    //    Actor's own Endpoint. It never polls and never constructs an id: the
    //    push carries the Endpoint the work is for.
    const clientStream = new (globalThis as any).WebSocket(`${h.wsUrl}/v1/events/stream`);
    const clientFrames: any[] = [];
    clientStream.addEventListener("open", () => {
      clientStream.send(JSON.stringify({ type: "authenticate", bearer_token: clientBearer, workspace_id: workspaceId }));
    });
    clientStream.addEventListener("message", (event: any) => clientFrames.push(JSON.parse(String(event.data))));
    await waitFor(() => clientFrames.some((f) => f.type === "authenticated"), "client stream authenticated");

    const pushed = await waitFor(() => {
      const frame = clientFrames.find((f) => f.type === "delivery_bundle_available"
        && f.payload?.delivery?.endpoint_id === operatorEndpoint);
      return frame ? frame.payload.delivery : false;
    }, "delivery-available pushed to the client for the operator Actor", 20_000);
    expect(pushed.delivery_id).toBeTruthy();

    // Capture the asking turn's return context from its own request event, so
    // the resume can be checked to land there rather than in a fresh context.
    const askContextId = await waitFor(async () => {
      const { events } = await h.get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=200`);
      const request = events.find((e) => e.type === "request"
        && e.destination_json?.endpoint_id === operatorEndpoint
        && typeof e.metadata?.request_return_context_id === "string");
      return request ? String(request.metadata.request_return_context_id) : false;
    }, "asking Actor's request stamped a return context", 20_000);

    // 6. The client CLAIMS the delivery for its own client-executed Endpoint and
    //    reads the question straight from the bundle — no context handling.
    const claimed = await asJson(await fetch(
      `${busUrl}/v1/delivery/claim?endpoint_id=${encodeURIComponent(operatorEndpoint)}`,
      { headers: authz(clientBearer) },
    ));
    const delivery = (claimed.deliveries ?? []).find((d: any) => d.delivery_id === pushed.delivery_id);
    expect(delivery).toBeTruthy();
    expect(JSON.stringify(delivery.events)).toContain(question);

    // 7. The client ENDS ITS TURN: it reports a result by delivery_id alone.
    //    No context, no correlation id, no assembled event — the same shape a
    //    model's turn end takes.
    const answerText = "Approved by the console operator.";
    const ended = await fetch(`${busUrl}/v1/runtime/turn-result`, {
      method: "POST",
      headers: jsonAuth(clientBearer),
      body: JSON.stringify({ delivery_id: delivery.delivery_id, text: answerText }),
    });
    expect(ended.status).toBe(202);

    // 8. The asking Actor resumes IN ITS ORIGINAL CONTEXT. The resumed output
    //    must carry the answer AND the request's own return context — a reply
    //    that landed in a fresh context would fail this, which is exactly the
    //    blindness the prior gate could not catch.
    await waitFor(async () => {
      const results = await h.runtimeResults(workspaceId, askerEndpoint);
      return results.some((e) => typeof e.content?.text === "string"
        && e.content.text.includes(answerText)
        && e.context_id === askContextId);
    }, "asking Actor resumes with the answer, in its original context", 20_000);

    // The substrate's correlated return landed in the asking turn's context too,
    // not a new one — correlation alone resumed the turn.
    const { events: afterEvents } = await h.get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=200`);
    const returned = afterEvents.find((e) => e.type === "request.result"
      && e.destination_json?.endpoint_id === askerEndpoint);
    expect(returned).toBeTruthy();
    expect(returned.context_id).toBe(askContextId);

    // The pending question is now resolved — the loop closed through real routes.
    await waitFor(async () => {
      const res = await fetch(`${busUrl}/v1/pending-responses?workspace_id=${encodeURIComponent(workspaceId)}&destination_endpoint_id=${encodeURIComponent(operatorEndpoint)}`, { headers: authz(clientBearer) });
      const rows = (await asJson(res)).pending ?? [];
      const open = rows.filter((r: any) => r.waiting_endpoint_id === askerEndpoint && r.status === "pending");
      return open.length === 0;
    }, "pending question resolved");

    clientStream.close();
    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 90_000);
});
