import type { BusClient, DeliveryBundle, RuntimeOperationAuthoritySession } from "../bus-client.js";
import type { AgentRuntimeConfig } from "../auth.js";
import type { HookPayload, HookRegistry } from "../hooks.js";

export type RuntimeContext = {
  bridge_id: string;
  bus: BusClient;
  /** Workspace locator (filesystem path) for work-log writing */
  workspace_locator?: string;
  /** Agent ID extracted from the endpoint for work-log paths */
  agent_id?: string;
  /** Hook registry for firing lifecycle hooks */
  hooks?: HookRegistry;
  /** Ephemeral, Delivery-scoped Bus operation authority; never persisted. */
  operation_authority_session?: RuntimeOperationAuthoritySession;
};

export interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void>;
  /** Interrupt one active delivery when the Bus has durably cancelled it. */
  cancelDelivery?(deliveryId: string): Promise<boolean> | boolean;
  dispose?(reason?: HookPayload<"SessionEnd">["reason"]): Promise<void>;
}
