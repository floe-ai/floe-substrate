/**
 * Operation-authority acquisition for substrate-write tools that invoke Bus
 * semantic operations under the active Delivery's authority.
 *
 * `emit` and `request` write through the Bridge's own BusClient and need no
 * operation-authority session. Capability invocation, pulses, and artefact
 * reads DO: they call Bus operation endpoints that require the ephemeral
 * per-Delivery authority bearer the Bus issues from `prepareRuntimeDelivery`.
 *
 * The bearer is short-lived and never persisted beyond the live turn. This
 * helper caches it on the active turn and refreshes it from the Bus before it
 * expires, re-validating that the immutable processing contract has not changed
 * underneath the Delivery.
 */
import type { BusClient, RuntimeOperationAuthoritySession } from "../bus-client.js";

/**
 * The mutable subset of a runtime turn that authority acquisition reads and
 * writes. The runtime owns the turn object; this helper caches the issued
 * session and the contract id on it so repeated tool calls in one turn reuse
 * one authority session until it is close to expiring.
 */
export type OperationAuthorityTurn = {
  delivery_id: string;
  processing_contract_id: string | null;
  operation_authority_session: RuntimeOperationAuthoritySession | null;
};

/**
 * Return a valid operation-authority session for the active Delivery, issuing
 * or refreshing it from the Bus when the cached one is missing or within one
 * minute of expiry. Throws when no Delivery is bound or when the Bus returns a
 * different immutable processing contract for the same Delivery.
 */
export async function requireOperationAuthority(
  bus: BusClient,
  turn: OperationAuthorityTurn,
): Promise<RuntimeOperationAuthoritySession> {
  if (!turn.delivery_id) {
    throw new Error("No active Delivery is bound to this substrate tool call.");
  }
  let session = turn.operation_authority_session;
  const expiresAt = session ? Date.parse(session.expires_at) : Number.NaN;
  if (!session || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    const prepared = await bus.prepareRuntimeDelivery(turn.delivery_id);
    if (
      turn.processing_contract_id
      && prepared.processing_contract.processing_contract_id !== turn.processing_contract_id
    ) {
      throw new Error("Runtime preparation returned a different immutable processing contract for the active Delivery.");
    }
    session = prepared.operation_authority_session;
    turn.operation_authority_session = session;
    turn.processing_contract_id = prepared.processing_contract.processing_contract_id;
  }
  return session;
}
