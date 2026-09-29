const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The exact web origin a browser pass is bound to, as `scheme://host[:port]`.
 * Only HTTPS, or HTTP on this computer's loopback, can hold a pass. Null,
 * opaque, wildcard and user-info origins are refused, so a match is exact.
 */
export function normalizeBrowserOrigin(value: string | undefined): string | null {
  if (!value || value === "null" || value.includes("*")) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.origin === "null") return null;
  if (url.origin !== value.replace(/\/$/, "")) return null;
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname) ? url.origin : null;
}

export function isLoopbackBrowserOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
