/**
 * @invariant Runtime adapters interrupt and retire only the exact Delivery
 * session requested by the Bus, and report completion only after quiescence or
 * isolated session termination is confirmed.
 */
import type { BusClient, DeliveryBundle, RuntimeOperationAuthoritySession } from "../bus-client.js";
import type { AgentRuntimeConfig } from "../auth.js";
import type { HookPayload, HookRegistry } from "../hooks.js";
import type { EngineAccount } from "../engines/engine-control.js";
import type { ExtensionToolBinding } from "../extensions/workspace-extensions.js";

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
  /** The account the engine's readiness admitted this turn under; the turn must run as it. */
  engine_account?: { label: string; host?: string };
  /** Tools of the running Extensions the Actor's pinned definition lists. */
  extension_tools?: readonly ExtensionToolBinding[];
};

export type RuntimeCancellationResult =
  | Readonly<{ outcome: "quiesced"; evidence?: Record<string, unknown> }>
  | Readonly<{ outcome: "session_retired"; evidence?: Record<string, unknown> }>;

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
  cancelDelivery?(deliveryId: string): boolean;
  /** Resolves only after the cancelled runtime confirms quiescence. */
  waitForDeliveryCancellation?(deliveryId: string): Promise<RuntimeCancellationResult | null>;
  /** Force-terminate only the isolated session that owns one overdue delivery. */
  forceRetireDelivery?(deliveryId: string): Promise<RuntimeCancellationResult | null>;
  /** A pushed answer or invalidation for an approval a tool call may be waiting on. */
  approvalChanged?(approvalRequestId: string): void;
  /** Retire runtime state after the Bus pushes a canonical Context-history change. */
  contextHistoryChanged?(contextId: string): Promise<void>;
  dispose?(reason?: HookPayload<"SessionEnd">["reason"]): Promise<void>;
}
