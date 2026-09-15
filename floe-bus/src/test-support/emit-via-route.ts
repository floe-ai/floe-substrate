import type { createBusServer } from "../server.js";
import type { EventCommand } from "../store.js";

type BusServerHandle = Awaited<ReturnType<typeof createBusServer>>;

export interface EmitViaRouteResult {
  status: number;
  body: any;
  /** The persisted event envelope the route returns on success (202). */
  event: any;
}

/**
 * Emit an event through the real Bus route, exactly as an unprivileged client
 * would. Tests must never call `store.submitEvent` directly — that write path
 * is capability-gated so no test can fabricate state no Actor could produce.
 * This helper drives `POST /v1/events/emit` on an in-process server built with
 * the explicit test auth bypass, so the write carries real ingress authority.
 */
export async function emitViaRoute(
  handle: BusServerHandle,
  command: EventCommand,
): Promise<EmitViaRouteResult> {
  // The direct store path accepted an empty `thread_id` to mean "unthreaded".
  // The real route requires the field absent instead, so normalise that idiom
  // and drop undefined keys, keeping conversions a faithful mechanical swap.
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(command as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (key === "thread_id" && value === "") continue;
    payload[key] = value;
  }
  const res = await handle.app.inject({
    method: "POST",
    url: "/v1/events/emit",
    payload,
  });
  const body = res.statusCode === 204 ? null : res.json();
  return { status: res.statusCode, body, event: body?.event };
}
