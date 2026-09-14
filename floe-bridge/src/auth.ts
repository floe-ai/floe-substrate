/**
 * @invariant This module holds the bridge-side runtime configuration contract.
 * Floe does NOT broker model credentials: the vendor CLI driven by floe-runtime
 * authenticates itself. This module therefore carries only the runtime-config
 * shape passed to an adapter and the runtime auth error taxonomy used for
 * delivery control flow. It must not import any provider SDK.
 */

/**
 * Declared thinking capability for a model.
 *
 * - "adaptive"  : model accepts { type: "adaptive" }
 * - "budget"    : model accepts legacy { type: "enabled", budget_tokens:N } shapes
 * - "always-on" : model rejects any explicit thinking param; it must be omitted entirely
 * - "none"      : no thinking support; the thinking param must be omitted
 */
export type ModelThinkingCapability = "adaptive" | "budget" | "always-on" | "none";

/**
 * Runtime configuration for a single agent's turns. The values are plain
 * selectors (provider/model strings, instructions); the runtime adapter is
 * responsible for interpreting them. No credential material is carried here.
 */
export type AgentRuntimeConfig = {
  provider?: string;
  model?: string;
  auth_profile?: string;
  thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Source of the auth_profile selection. "agent_binding" and "workspace_binding" indicate
   *  a local override; project-declared provider/model do not take precedence in that case. */
  auth_profile_source?: string;
  /** Source of the model selection. "agent_binding" and "workspace_binding" indicate the model
   *  was explicitly chosen by the user and must not be stripped when providers differ. */
  model_source?: string;
  /** Agent markdown body to use as the system prompt for this agent's runtime sessions. */
  instructions?: string;
};

export type RuntimeAuthErrorCode =
  | "runtime_profile_required"
  | "provider_auth_missing"
  | "runtime_provider_required"
  | "runtime_model_required"
  | "runtime_model_unknown"
  | "runtime_credential_unresolved"
  | "runtime_processing_contract_mismatch"
  | "runtime_profile_provider_mismatch";

export class RuntimeAuthError extends Error {
  constructor(readonly code: RuntimeAuthErrorCode, message: string) {
    super(message);
    this.name = "RuntimeAuthError";
  }
}
