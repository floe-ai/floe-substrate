/**
 * Render hook injection results into a labelled context block, shared by every
 * runtime adapter. Extensions returning `{ inject: { source, content } }` from a
 * BeforeTurn hook get folded into the turn prompt through this one renderer.
 *
 * Each injection is bounded to MAX_INJECTION_CHARS per source; the total is
 * bounded to MAX_TOTAL_INJECTION_CHARS. Injections are ordered deterministically
 * by their position in the results array.
 */
const MAX_INJECTION_CHARS = 4000;
const MAX_TOTAL_INJECTION_CHARS = 16000;

export function renderHookInjections(results: Array<{ inject?: Record<string, unknown> }>): string {
  const injections = results
    .filter((r): r is { inject: Record<string, unknown> } => r.inject != null)
    .map(r => r.inject);

  if (injections.length === 0) return "";

  const lines: string[] = ["[Injected Context — extension-provided, not a message]"];
  let totalChars = 0;

  for (const injection of injections) {
    const source = typeof injection.source === "string" ? injection.source : "extension";
    const content = typeof injection.content === "string"
      ? injection.content
      : JSON.stringify(injection, null, 2);

    // Bound per-source
    const bounded = content.length > MAX_INJECTION_CHARS
      ? content.slice(0, MAX_INJECTION_CHARS) + `\n... (truncated from ${content.length} chars)`
      : content;

    // Check total budget
    if (totalChars + bounded.length > MAX_TOTAL_INJECTION_CHARS) {
      lines.push(`\n[injection truncated — total limit reached]`);
      break;
    }

    lines.push(`\n--- from: ${source} ---`);
    lines.push(bounded);
    totalChars += bounded.length;
  }

  lines.push("\n[End Injected Context]");
  return lines.join("\n");
}
