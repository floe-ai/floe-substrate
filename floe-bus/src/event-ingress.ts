/**
 * event-ingress — the capability that authorises a write into the event log.
 *
 * `submitEvent` is the substrate's single write path for events, and it is
 * reachable ONLY by holding this capability. The Bus server wiring passes it on
 * every real ingress call, so events written through a real route carry real
 * authority. A test must drive event writes through a real route (for example
 * `POST /v1/events/emit`), never by importing this capability — the concept
 * guard forbids test files from referencing it.
 *
 * This is what stops a test fabricating state no Actor could produce: writing an
 * event as an arbitrary endpoint, bypassing every route and authority check, is
 * no longer reachable by importing the store.
 */
export const EVENT_INGRESS_CAPABILITY: unique symbol = Symbol("floe.bus.event-ingress");

export type EventIngressCapability = typeof EVENT_INGRESS_CAPABILITY;

/**
 * Guard the event write path. Throws unless the caller holds the ingress
 * capability, i.e. the call arrived through the Bus server's real ingress
 * wiring rather than a direct store import.
 */
export function requireEventIngress(capability: EventIngressCapability | undefined): void {
  if (capability !== EVENT_INGRESS_CAPABILITY) {
    throw new Error(
      "submitEvent is an ingress-only write path: submit events through a real route "
        + "(e.g. POST /v1/events/emit), not by calling the store directly.",
    );
  }
}
