/** The Bus's own answer to "who is serving here?", read from its /health. */
export type BusHealth = { ok: boolean; instance_id: string | null; version: string | null };

export async function fetchBusHealth(baseUrl: string): Promise<BusHealth | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; instance_id?: string | null; version?: string | null };
    return { ok: body.ok === true, instance_id: body.instance_id ?? null, version: body.version ?? null };
  } catch {
    return null;
  }
}
