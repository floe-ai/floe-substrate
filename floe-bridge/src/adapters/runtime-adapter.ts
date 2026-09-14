import type { BusClient, DeliveryBundle, RuntimeOperationAuthoritySession } from "../bus-client.js";
import type { AgentRuntimeConfig } from "../auth.js";
import type { HookPayload, HookRegistry } from "../hooks.js";
import type { CredentialStore } from "@earendil-works/pi-ai";

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
  /** Exact Delivery-scoped credential access; absent only for legacy Deliveries. */
  credential_store?: CredentialStore;
};

export interface RuntimeAdapter {
  readonly name: string;
  /**
   * Whether this adapter needs a brokered provider credential to run a turn.
   * Defaults to "required" when omitted (pi's historical behaviour). An adapter
   * that declares "none" authenticates outside Floe (e.g. floe-runtime, whose
   * vendor CLI authenticates itself), so the Bridge must not force provider
   * credential resolution or build a credential store for it.
   */
  readonly credentialRequirement?: "required" | "none";
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void>;
  /** Interrupt one active delivery when the Bus has durably cancelled it. */
  cancelDelivery?(deliveryId: string): Promise<boolean> | boolean;
  dispose?(reason?: HookPayload<"SessionEnd">["reason"]): Promise<void>;
}
