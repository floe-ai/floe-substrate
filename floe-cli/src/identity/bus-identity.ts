/**
 * The agent's calls to the Bus. Unprivileged routes carry a signed NIP-42 proof
 * (ADR-0015); the few host routes (re-admission, revocation) carry host_control
 * obtained from the native broker for that one call.
 */
import type { Event as NostrEvent } from "nostr-tools/pure";

export type Workspace = { workspace_id: string; name: string; folder_path: string | null; last_used_at: string | null };

export type FolderLookup =
  | { kind: "workspace"; workspace: { workspace_id: string; name: string; folder_path: string | null }; joined: boolean }
  | { kind: "none" }
  | { kind: "invalid"; error: string; message: string }
  | { kind: "refused"; message: string };

export type AuthenticateReply =
  | { kind: "bearer"; bearer_token: string; authority_session_id: string | null; identity_id: string; workspace: Workspace; expires_at: string; workspaces: Workspace[] }
  | { kind: "selection_required"; workspaces: Workspace[] }
  | { kind: "not_admitted" }
  | { kind: "not_admitted_to_workspace"; workspaces: Workspace[] };

export type JoinOutcome =
  | { kind: "ready" | "pending"; workspace_id: string }
  | { kind: "failed"; workspace_id: string; reason: string }
  | { kind: "invalid"; error: string; message: string }
  | { kind: "refused"; message: string };

export class BusUnreachableError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`Floe's bus is not answering at ${url} (${cause instanceof Error ? cause.message : String(cause)}).`);
    this.name = "BusUnreachableError";
  }
}

export class BusIdentityClient {
  constructor(private readonly base: string, private readonly httpFetch: typeof fetch = globalThis.fetch) {}

  private url(path: string): string {
    return `${this.base.replace(/\/+$/, "")}${path}`;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.httpFetch(this.url(path), init);
    } catch (error) {
      throw new BusUnreachableError(this.base, error);
    }
  }

  async challenge(): Promise<{ challenge: string; relay: string }> {
    const response = await this.call("/v1/identity/challenge");
    if (!response.ok) throw new Error(`The bus refused a challenge (${response.status}).`);
    return await response.json() as { challenge: string; relay: string };
  }

  async authenticate(event: NostrEvent, workspaceId?: string): Promise<AuthenticateReply> {
    const response = await this.call("/v1/identity/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workspaceId ? { auth_event: event, workspace_id: workspaceId } : { auth_event: event }),
    });
    if (response.status === 401) return { kind: "not_admitted" };
    const body = await response.json() as Record<string, any>;
    if (response.status === 403) return { kind: "not_admitted_to_workspace", workspaces: body.workspaces ?? [] };
    if (!response.ok) throw new Error(`The bus refused authentication (${response.status}: ${body.error ?? "unknown"}).`);
    if (!body.bearer_token) return { kind: "selection_required", workspaces: body.workspaces ?? [] };
    const workspaces: Workspace[] = body.workspaces ?? [];
    return {
      kind: "bearer",
      bearer_token: body.bearer_token,
      authority_session_id: body.authority_session_id ?? null,
      identity_id: body.identity?.identity_id,
      workspace: workspaces.find((w) => w.workspace_id === body.workspace_id)
        ?? { workspace_id: body.workspace_id, name: body.workspace_id, folder_path: null, last_used_at: null },
      expires_at: body.expires_at,
      workspaces,
    };
  }

  /** Display name the Bus holds for this key, if it is admitted anywhere. */
  async displayNameFor(event: NostrEvent): Promise<string | null> {
    const response = await this.call("/v1/identity/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_event: event }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { identity?: { display_name?: string } };
    return body.identity?.display_name ?? null;
  }

  async registerWorkspace(
    event: NostrEvent,
    input: { locator: string; display_name: string; name?: string; create_directory?: boolean },
  ): Promise<JoinOutcome> {
    const response = await this.call("/v1/identity/register-workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auth_event: event,
        locator: input.locator,
        display_name: input.display_name,
        ...(input.name ? { name: input.name } : {}),
        ...(input.create_directory ? { create_directory: true } : {}),
      }),
    });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (response.status === 201) return { kind: "ready", workspace_id: body.workspace_id };
    if (response.status === 202) return { kind: "pending", workspace_id: body.workspace_id };
    if (response.status === 422) return { kind: "failed", workspace_id: body.workspace_id, reason: body.materialization?.reason ?? "unknown" };
    if (response.status === 401) return { kind: "refused", message: "The bus rejected the identity's proof." };
    const error = typeof body.error === "string" ? body.error : `http_${response.status}`;
    return { kind: "invalid", error, message: joinInvalidMessage(error, body.message) };
  }

  /** The identity's workspaces, most recently used first. Mints nothing. */
  async listWorkspaces(event: NostrEvent): Promise<Workspace[] | null> {
    const response = await this.call("/v1/identity/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_event: event }),
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`The bus refused to list workspaces (${response.status}).`);
    return ((await response.json()) as { workspaces: Workspace[] }).workspaces;
  }

  /** Which workspace a folder already is, if any. Read-only: never registers or joins. */
  async workspaceForFolder(event: NostrEvent, locator: string): Promise<FolderLookup> {
    const response = await this.call("/v1/identity/workspace-for-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_event: event, locator }),
    });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (response.ok) return body.workspace ? { kind: "workspace", workspace: body.workspace, joined: body.joined === true } : { kind: "none" };
    if (response.status === 401) return { kind: "refused", message: "The bus rejected the identity's proof." };
    const error = typeof body.error === "string" ? body.error : `http_${response.status}`;
    return { kind: "invalid", error, message: joinInvalidMessage(error, body.message) };
  }

  // ── host routes ────────────────────────────────────────────────────────────

  async listClients(hostToken: string): Promise<Array<{ identity_id: string; pubkey_hex: string; display_name: string; revoked_at: string | null; workspaces: Workspace[] }>> {
    const response = await this.call("/v1/clients", { headers: hostHeaders(hostToken) });
    if (!response.ok) throw new Error(`The bus refused to list identities (${response.status}).`);
    return ((await response.json()) as { clients: any[] }).clients;
  }

  async admit(hostToken: string, input: { display_name: string; pubkey: string; workspace_id: string }): Promise<void> {
    const response = await this.call("/v1/identities", {
      method: "POST",
      headers: { ...hostHeaders(hostToken), "content-type": "application/json" },
      body: JSON.stringify({ ...input, until_revoked: true }),
    });
    if (!response.ok) throw new Error(`The bus refused to admit the new identity to ${input.workspace_id} (${response.status}).`);
  }

  async revokeIdentity(hostToken: string, identityId: string): Promise<void> {
    const response = await this.call(`/v1/clients/${encodeURIComponent(identityId)}`, { method: "DELETE", headers: hostHeaders(hostToken) });
    if (!response.ok) throw new Error(`The bus refused to revoke ${identityId} (${response.status}).`);
  }

  async revokeSession(hostToken: string, identityId: string, authoritySessionId: string): Promise<boolean> {
    const response = await this.call(
      `/v1/clients/${encodeURIComponent(identityId)}/sessions/${encodeURIComponent(authoritySessionId)}`,
      { method: "DELETE", headers: hostHeaders(hostToken) },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`The bus refused to revoke the session (${response.status}).`);
    return true;
  }
}

function hostHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function joinInvalidMessage(error: string, detail: unknown): string {
  switch (error) {
    case "workspace_locator_invalid":
      return "That path is not usable. Choose a folder by its full location on this machine.";
    case "workspace_directory_not_found":
      return "That folder does not exist. Choose an existing folder, or ask to create it.";
    default:
      return typeof detail === "string" && detail ? detail : `The folder could not be registered (${error}).`;
  }
}
