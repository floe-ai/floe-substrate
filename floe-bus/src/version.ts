/**
 * The version of the Floe package this bus shipped in: the nearest package.json
 * above this module. That is floe-bus/package.json in a checkout, and the single
 * `floe` package's package.json in a released install — both carry the release
 * version. Reported at /health so a client can see which Floe it connected to.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readOwnVersion(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const version = JSON.parse(readFileSync(candidate, "utf8")).version;
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const BUS_VERSION = readOwnVersion();
