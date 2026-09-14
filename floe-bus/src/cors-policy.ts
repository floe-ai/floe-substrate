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

export function trustedBrowserOrigins(configured = process.env.FLOE_ALLOWED_ORIGINS): ReadonlySet<string> {
  const additions = (configured ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_TRUSTED_BROWSER_ORIGINS, ...additions]);
}

export function createCorsOriginPolicy(
  trusted: ReadonlySet<string> = trustedBrowserOrigins(),
): (origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void) => void {
  return (origin, callback) => {
    // Native processes and same-origin requests do not carry an Origin header.
    if (!origin || trusted.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}
