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
 *   executes; the client discovers that Actor through the same listing every
 *   Actor appears in, answers through real routes with a real minted
 *   credential, and the asking Actor resumes.
 *
 * The operator Actor is created by `register` (the same act that creates any
 * Actor) — the test never seeds it. The asking Actor's request is issued by the
 * fake runtime executing the shared `request` substrate tool during its turn —
 * the pending dependency is produced by the substrate, not planted. The client
 * holds only an admitted-keypair workspace_operation bearer.
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

    // The client discovers the operator through ORDINARY Actor listing — no role
    // marker to hunt for — and is refused a host_control route.
    const listed = await asJson(await fetch(`${busUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`, { headers: authz(clientBearer) }));
    const operator = (listed.endpoints ?? []).find((e: any) => e.endpoint_id === operatorEndpoint);
    expect(operator).toBeTruthy();
    const clientsProbe = await fetch(`${busUrl}/v1/clients`, { headers: authz(clientBearer) });
    expect([401, 403]).toContain(clientsProbe.status);

    // 4. Drive a REAL turn on the asking Actor that issues a `request` to the
    //    operator. The ask is data on a delivered event; the fake runtime runs
    //    the shared substrate request tool — the pending row is the substrate's.
    const question = "Operator, approve the deploy?";
    const answerText = "Approved by the console operator.";
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

    // 5. The client discovers the operator's pending question through the real
    //    route and answers it exactly as the protocol document specifies.
    const pendingRow = await waitFor(async () => {
      const res = await fetch(`${busUrl}/v1/pending-responses?workspace_id=${encodeURIComponent(workspaceId)}&destination_endpoint_id=${encodeURIComponent(operatorEndpoint)}`, { headers: authz(clientBearer) });
      const rows = (await asJson(res)).pending ?? [];
      return rows.find((r: any) => r.waiting_endpoint_id === askerEndpoint) ?? false;
    }, "operator's pending question discoverable by the client", 20_000);
    expect(pendingRow.correlation_id).toBeTruthy();

    const reply = await fetch(`${busUrl}/v1/events/emit`, {
      method: "POST",
      headers: jsonAuth(clientBearer),
      body: JSON.stringify({
        type: "response",
        workspace_id: workspaceId,
        source_endpoint_id: operatorEndpoint,
        destination: { kind: "endpoint", endpoint_id: pendingRow.waiting_endpoint_id },
        correlation_id: pendingRow.correlation_id,
        content: { text: answerText },
      }),
    });
    expect(reply.status).toBe(202);

    // 6. The asking Actor resumes: its second turn records the operator's answer.
    await waitFor(async () => {
      const results = await h.runtimeResults(workspaceId, askerEndpoint);
      return results.some((e) => typeof e.content?.text === "string" && e.content.text.includes(answerText));
    }, "asking Actor resumes with the operator's answer", 20_000);

    // The pending question is now resolved — the loop closed through real routes.
    await waitFor(async () => {
      const res = await fetch(`${busUrl}/v1/pending-responses?workspace_id=${encodeURIComponent(workspaceId)}&destination_endpoint_id=${encodeURIComponent(operatorEndpoint)}`, { headers: authz(clientBearer) });
      const rows = (await asJson(res)).pending ?? [];
      const row = rows.find((r: any) => r.correlation_id === pendingRow.correlation_id);
      return !row || row.status === "resolved";
    }, "pending question resolved");

    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 90_000);
});
