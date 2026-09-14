/**
 * actor-seed — seed a default human actor after workspace registration.
 *
 * Stores the actor exclusively in the bus DB via POST /v1/endpoints/register
 * (an upsert). No file is written to the workspace tree, so git status stays
 * clean in any workspace. The actor persists across bridge restarts; a factory
 * reset wipes the bus DB, but the next `floe register` call re-seeds it.
 *
 * Authority: seeding a self-owned actor is a native-host-owner capability. The
 * caller obtains the host-control credential from the native broker (the same
 * trust path `floe register` already uses) and passes it here. The registration
 * is idempotent, so re-seeding an existing operator actor is a harmless upsert.
 */

export const DEFAULT_ACTOR_SLUG = "operator";
export const DEFAULT_ACTOR_NAME = "Operator";

/** Mirror of the endpoint-id convention used across the substrate. */
export function actorEndpointId(workspaceId: string, slug: string): string {
  return `actor:${workspaceId}:${slug}`;
}

export type SeedResult =
  | { seeded: true; endpoint_id: string }
  | { seeded: false; reason: "register_failed" };

/**
 * Seed the default human operator actor for a workspace.
 *
 * @param busHttpBase       HTTP base URL for the bus (e.g. "http://127.0.0.1:5174")
 * @param workspaceId       The workspace_id returned by /v1/workspaces/register
 * @param hostControlToken  The broker-owned host-control credential authorizing the seed
 * @param fetchFn           Optional fetch implementation (defaults to globalThis.fetch; injectable for tests)
 * @returns                 A SeedResult indicating whether the actor was registered
 */
export async function seedDefaultActor(
  busHttpBase: string,
  workspaceId: string,
  hostControlToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SeedResult> {
  const endpointId = actorEndpointId(workspaceId, DEFAULT_ACTOR_SLUG);
  const base = busHttpBase.replace(/\/$/, "");

  // Register the default operator actor as the native host owner. The route is
  // an upsert, so this is safe to call on every registration. The endpoint is
  // bridgeless: it belongs to the substrate/operator, not to any Bridge.
  let regRes: Response;
  try {
    regRes = await fetchFn(`${base}/v1/endpoints/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hostControlToken}`,
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        name: DEFAULT_ACTOR_NAME,
        agent_id: DEFAULT_ACTOR_SLUG,
        bridge_id: null,
        status: "idle",
      }),
    });
  } catch {
    return { seeded: false, reason: "register_failed" };
  }
  if (!regRes.ok) return { seeded: false, reason: "register_failed" };

  return { seeded: true, endpoint_id: endpointId };
}
