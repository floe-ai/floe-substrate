import type { RuntimeEndpointProjection } from "./bus-client.js";

/**
 * What a Bridge tells the Bus about an Actor it runs. `metadata.engine` names
 * the engine whose readiness gates this Actor's work (the engine ids used by
 * engine control), or null when the runtime needs no engine sign-in. Surfaces
 * read it from the endpoint to warn about the right engine before sending work.
 */
export function runtimeEndpointRegistration(
  workspaceId: string,
  runtime: RuntimeEndpointProjection,
  engine: string | null,
  heldForEngine: boolean,
) {
  return {
    endpoint_id: runtime.endpoint_id,
    workspace_id: workspaceId,
    name: runtime.name,
    agent_id: runtime.agent_id,
    status: runtime.runtime_status === "resolved" && !heldForEngine ? "idle" : "runtime_unconfigured",
    metadata: {
      runtime_adapter: runtime.adapter_id,
      engine,
      actor_definition_revision_id: runtime.actor_definition_revision_id,
      runtime_profile_revision_id: runtime.runtime_profile_revision_id,
      actor_runtime_binding_id: runtime.actor_runtime_binding_id,
      runtime_unresolved_reasons: runtime.unresolved_reasons,
    },
  };
}
