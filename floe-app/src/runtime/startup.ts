/** A response from Floe is distinct from an unavailable service. */
export class FloeHttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`Floe request ${path} returned ${status}`);
    this.name = "FloeHttpError";
  }
}

export async function waitForFloe<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      return await load(controller.signal);
    } catch (error) {
      // Repeating an unauthorized or invalid request cannot start a service.
      if (error instanceof FloeHttpError && error.status >= 400 && error.status < 500) throw error;
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 9) await new Promise(resolve => setTimeout(resolve, Math.min(150 + attempt * 50, 500)));
  }
  throw new Error("Floe's local services are unavailable. Open the Floe app, then try connecting again.", { cause: lastError });
}

export function startupFailure(error: unknown): { title: string; detail: string; needsConnection: boolean } {
  if (error instanceof FloeHttpError && error.status === 401) {
    return {
      title: "Connect to Floe",
      detail: "Floe is running, but this window does not have an authorized connection.",
      needsConnection: true,
    };
  }
  if (error instanceof FloeHttpError) {
    return { title: "Floe could not open this workspace", detail: error.status === 403
      ? "This connection does not have permission to open the workspace."
      : error.message, needsConnection: false };
  }
  return { title: "Floe could not connect", detail: error instanceof Error ? error.message : String(error), needsConnection: false };
}
