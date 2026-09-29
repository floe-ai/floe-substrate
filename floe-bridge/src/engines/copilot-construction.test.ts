/**
 * A real model turn has exactly one construction path: the Bridge daemon
 * chooses its adapter from config, and engines/copilot.ts builds the runtime.
 * F-k shipped because the live tests hand-built their own client and never
 * ran that path. This scan keeps any test or script from doing so again.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE_ROOTS = ["floe-bus/src", "floe-bridge/src", "floe-cli/src", "tests/src", "scripts"];
const PRODUCTION = "floe-bridge/src/engines/copilot.ts";
const SELF = "floe-bridge/src/engines/copilot-construction.test.ts";

function sources(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c|m)?(t|j)s$/.test(entry.name)) {
        const path = relative(ROOT, full).split(sep).join("/");
        if (path !== SELF) found.push({ path, text: readFileSync(full, "utf8") });
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(ROOT, root));
  return found;
}

/** The argument text of each `new Name(...)` call, parentheses balanced. */
function constructions(text: string, name: string): string[] {
  const calls: string[] = [];
  let at = text.indexOf(`new ${name}(`);
  while (at !== -1) {
    let depth = 0;
    let end = at + name.length + 4;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(at, end + 1));
    at = text.indexOf(`new ${name}(`, end);
  }
  return calls;
}

describe("a real Copilot turn is only ever built the production way", () => {
  const files = sources();

  it("never builds a Copilot SDK client outside floe-runtime", () => {
    const offenders = files.filter(f => /new\s+CopilotClient\s*\(|clientFactory/.test(f.text)).map(f => f.path);
    expect(offenders).toEqual([]);
  });

  it("builds a real runtime only in the engine module; tests may wrap only a stand-in client", () => {
    const offenders = files
      .filter(f => f.path !== PRODUCTION)
      .flatMap(f => constructions(f.text, "CopilotRuntime")
        // A supplied `client` replaces the SDK entirely; clientOptions then configure nothing.
        .filter(call => !(f.path.endsWith(".test.ts") && /\bclient:\s/.test(call) && !/clientFactory/.test(call)))
        .map(call => `${f.path}: ${call.replace(/\s+/g, " ").slice(0, 80)}`));
    expect(offenders).toEqual([]);
  });

  it("gives the real engine only to the daemon's own adapter choice", () => {
    const offenders = files.flatMap(f => [
      ...constructions(f.text, "FloeRuntimeAdapter")
        .filter(call => /copilotHome/.test(call))
        .filter(() => f.path !== "floe-bridge/src/daemon.ts" && f.path !== "floe-bridge/src/engines/copilot.test.ts")
        .map(call => `${f.path}: ${call}`),
      ...(/\.adapter\s*=\s*new\s+FloeRuntimeAdapter/.test(f.text) ? [`${f.path}: replaces a daemon's adapter`] : []),
      // A daemon may run a fake engine only inside a test.
      ...(/stand_in_engine\s*:/.test(f.text) && !f.path.endsWith(".test.ts") ? [`${f.path}: gives a daemon a stand-in engine`] : []),
      // The live tier reads the model catalogue through the production builder; it runs no turn.
      ...(/createCopilotRuntime\s*\(/.test(f.text) && f.path !== PRODUCTION
        && f.path !== "floe-bridge/src/adapters/floe-runtime-adapter.ts"
        && f.path !== "tests/src/live-runtime.ts" ? [`${f.path}: builds the engine itself`] : []),
    ]);
    expect(offenders).toEqual([]);
  });
});
