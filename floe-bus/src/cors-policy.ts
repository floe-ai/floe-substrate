/**
 * Browser origins allowed to call a local Floe Bus.
 *
 * CORS is not authentication. This policy only prevents an arbitrary website
 * from using a browser as a confused deputy against a loopback Bus. Every
 * privileged route still requires an authenticated transport/session.
 */

export const DEFAULT_TRUSTED_BROWSER_ORIGINS = Object.freeze([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "http://localhost:5379",
  "http://127.0.0.1:5379",
]);

export function trustedBrowserOrigins(configured?: string): ReadonlySet<string> {
  const additions = (configured ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_TRUSTED_BROWSER_ORIGINS, ...additions]);
}

/**
 * Per-request CORS: a built-in trusted origin, or whatever the browser
 * connections allow for this exact origin and path (an active pass's origin,
 * or a loopback origin asking to pair). Credentials are allowed because a pass
 * is an HttpOnly cookie; the cookie, not CORS, carries any authority.
 */
export function createCorsDelegator(
  allows: (origin: string, path: string) => boolean,
): (request: Readonly<{ headers: Readonly<{ origin?: string }>; url: string }>,
  callback: (error: Error | null, options: { origin: boolean; credentials: boolean }) => void) => void {
  return (request, callback) => {
    const origin = request.headers.origin;
    // Native processes and same-origin requests do not carry an Origin header.
    const allowed = !origin || allows(origin, request.url.split("?", 1)[0]!);
    callback(null, { origin: allowed, credentials: allowed && origin !== undefined });
  };
}
