/**
 * Notifications — web browser Notification API wrapper with console fallback.
 *
 * Tauri-native notifications will wrap this later; for now the web
 * Notification API is used when available and permitted.
 *
 * Environments without the Notification API (e.g. jsdom, server) are guarded
 * safely — all functions degrade to console.log.
 */
import { subscribeEvents } from "../bus-client/client.ts";
import type { StreamMsg } from "../bus-client/types.ts";

export type NotificationPayload = {
  title: string;
  body?: string;
  tag?: string;
};

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function notificationApiAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Request permission to show browser notifications.
 * Returns true if the user grants (or has already granted) permission.
 * Returns false when the API is unavailable or permission is denied/dismissed.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationApiAvailable()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

/**
 * Show a notification.
 *
 * - When the Notification API is available and permission is granted:
 *   opens a browser notification.
 * - Otherwise: falls back to console.log.
 */
export function showNotification(payload: NotificationPayload): void {
  if (
    notificationApiAvailable() &&
    Notification.permission === "granted"
  ) {
    new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
    });
  } else {
    console.log(
      `[floe notification] ${payload.title}${payload.body ? ` — ${payload.body}` : ""}`
    );
  }
}

// ---------------------------------------------------------------------------
// Decision notifications
// ---------------------------------------------------------------------------

/**
 * Event types considered decision-relevant / pending-response.
 * Extend this set as the substrate evolves.
 */
const DECISION_EVENT_TYPES = new Set([
  "floe.pending_response",
  "floe.decision_required",
  "floe.awaiting_operator",
]);

export type DecisionNotificationsOptions = {
  /** Workspace to watch. Only events belonging to this workspace trigger a notification. */
  workspaceId: string;
  /** Optional custom filter — return true to show a notification for the given stream message. */
  filter?: (msg: StreamMsg) => boolean;
};

/**
 * Start listening for decision-relevant events on the bus stream and raise
 * a browser notification (or console fallback) when one arrives. Start with new
 * activity; reconnects still catch up on events missed by this listener.
 *
 * Returns an unsubscribe function — call it to stop listening.
 *
 * Guards for unsupported environments: if the WebSocket stream cannot be
 * opened (e.g. bus not running), errors are swallowed silently.
 */
export function startDecisionNotifications(
  options: DecisionNotificationsOptions
): () => void {
  const { workspaceId, filter } = options;

  let unsubscribe: (() => void) | null = null;

  try {
    unsubscribe = subscribeEvents((msg: StreamMsg) => {
      // Allow caller-supplied filter to short-circuit
      if (filter) {
        if (!filter(msg)) return;
      } else {
        // Default: match known decision event types or a workspace_id match
        const isDecision = DECISION_EVENT_TYPES.has(msg.type);
        const matchesWorkspace =
          typeof msg.payload?.workspace_id === "string" &&
          msg.payload.workspace_id === workspaceId;

        if (!isDecision || !matchesWorkspace) return;
      }

      const title =
        typeof msg.payload?.title === "string"
          ? msg.payload.title
          : "Decision pending";
      const body =
        typeof msg.payload?.body === "string"
          ? msg.payload.body
          : `Event: ${msg.type}`;

      showNotification({ title, body, tag: msg.type });
    }, { workspaceId, startAtCurrent: true });
  } catch {
    // subscribeEvents may throw in environments where WebSocket is unavailable.
    // Degrade silently — the app works without notifications.
  }

  return () => {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore teardown errors
      }
      unsubscribe = null;
    }
  };
}
