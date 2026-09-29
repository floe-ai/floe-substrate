import type { BusClient, DeliveryBundle, RuntimeOperationAuthoritySession } from "../bus-client.js";
import type { AgentRuntimeConfig } from "../auth.js";
import type { HookPayload, HookRegistry } from "../hooks.js";
import type { EngineAccount } from "../engines/engine-control.js";

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
  /** Engine tool operations the Actor's live grants cover; the only built-ins offered. */
  engine_tool_operation_ids?: string[];
};

export interface RuntimeAdapter {
  readonly name: string;
  /**
   * The engine this adapter's turns run on, when it has an account that must
   * be ready first (see engines/engine-control.ts). Work waits until it is.
   */
  readonly engine?: string;
  createEngineAccount?(): EngineAccount;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void>;
  /** Interrupt one active delivery when the Bus has durably cancelled it. */
  cancelDelivery?(deliveryId: string): Promise<boolean> | boolean;
  /** A pushed answer or invalidation for an approval a tool call may be waiting on. */
  approvalChanged?(approvalRequestId: string): void;
  dispose?(reason?: HookPayload<"SessionEnd">["reason"]): Promise<void>;
}
