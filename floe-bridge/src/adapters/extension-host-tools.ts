import type { HostTool } from "floe-runtime/adapters/copilot";

import type { ExtensionToolBinding } from "../extensions/workspace-extensions.js";
import type { SubstrateSessionHandle } from "../runtime-core/substrate-tool-definitions.js";
import { recordedTool } from "./floe-direct-tools.js";

/** Offers an Actor's Extension tools to its runtime session; each call runs in the Extension process. */
export function createExtensionHostTools(
  bindings: readonly ExtensionToolBinding[],
  handle: Pick<SubstrateSessionHandle, "recordToolActivity">,
): HostTool[] {
  return bindings.map(binding => recordedTool({
    name: binding.name,
    description: binding.description,
    parameters: binding.parameters,
    handle,
    execute: async (args, callId) => {
      const params = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
      const value = await binding.call(params, callId);
      return { content: value.content, details: value.details ?? {} };
    },
  }));
}
