import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect } from "vitest";

type Injectable = Readonly<{ app: { inject: (options: any) => Promise<any> } }>;

const bearer = (token: string) => ({ authorization: ["Be", "arer ", token].join("") });
export const cookieOf = (value: string | string[] | undefined, name: string): string => {
  const cookies = Array.isArray(value) ? value : value ? [value] : [];
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";", 1)[0]! : "";
};

/** Admits a person to one Workspace and signs them in, returning a session bearer. */
export async function admitPerson(handle: Injectable, hostToken: string, workspaceId: string, name = "Ada") {
  const secret = generateSecretKey();
  const admitted = await handle.app.inject({ method: "POST", url: "/v1/identities", headers: bearer(hostToken),
    payload: { display_name: name, pubkey: getPublicKey(secret), workspace_id: workspaceId, until_revoked: true } });
  expect(admitted.statusCode, admitted.body).toBe(201);
  const authenticate = async () => {
    const { challenge, relay } = (await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" })).json();
    const event = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
      tags: [["relay", relay], ["challenge", challenge]], content: "" }, secret);
    const response = await handle.app.inject({ method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: workspaceId, auth_event: event } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().bearer_token as string;
  };
  return { identity_id: admitted.json().identity.identity_id as string, token: await authenticate(), authenticate };
}

let sequence = 0;
export async function invokeAs(handle: Injectable, token: string | null, workspaceId: string, operationId: string,
  input: object, headers: Record<string, string> = {}) {
  const response = await handle.app.inject({ method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
    headers: { ...(token ? bearer(token) : {}), ...headers }, payload: {
      operation_id: operationId, operation_version: "1", input_schema_version: "1", input,
      target: null, expected_resource_revision: null, idempotency_key: `browser-pass-test:${++sequence}`,
    } });
  return response;
}

/**
 * The whole pairing: the browser asks, the person sees and allows it with the
 * operations given, the browser claims. Returns the browser's request headers.
 * `staleCookie` is whatever Floe cookie the browser still sends from an earlier pairing.
 */
export async function pairBrowser(handle: Injectable, personToken: string, workspaceId: string, origin: string,
  operationIds: readonly string[] = ["actor.list"], staleCookie = "") {
  const start = await handle.app.inject({ method: "POST", url: "/v1/browser/connections",
    headers: { origin, ...(staleCookie ? { cookie: staleCookie } : {}) } });
  expect(start.statusCode, start.body).toBe(201);
  const pending = cookieOf(start.headers["set-cookie"], "floe_browser_pending");
  const listed = await invokeAs(handle, personToken, workspaceId, "browser.connection.list", {});
  const connection = listed.json().receipt.result.connections
    .find((item: { code: string }) => item.code === start.json().code);
  expect(connection).toMatchObject({ origin, code: start.json().code });
  const approved = await invokeAs(handle, personToken, workspaceId, "browser.pass.approve", {
    connection_id: connection.connection_id, workspace_id: workspaceId, operation_ids: operationIds, until_revoked: true });
  expect(approved.json().receipt?.state, approved.body).toBe("completed");
  expect(approved.body).not.toMatch(/bearer|token_hash/);
  const claim = await handle.app.inject({ method: "POST", url: "/v1/browser/connections/claim",
    headers: { origin, cookie: staleCookie ? `${staleCookie}; ${pending}` : pending } });
  expect(claim.statusCode, claim.body).toBe(200);
  return { headers: { origin, cookie: cookieOf(claim.headers["set-cookie"], "floe_browser_pass") },
    pass_id: approved.json().receipt.result.pass.pass_id as string };
}
