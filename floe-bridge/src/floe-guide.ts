import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Floe user guide that ships with the install.
 *
 * This file sits at the root of the Bridge's source and of its built and
 * bundled dist, so two levels up is the repository during development and the
 * installed package after release. Both carry `docs/guide/`.
 */
export const FLOE_GUIDE_DIR = fileURLToPath(new URL("../../docs/guide/", import.meta.url));

export const FLOE_GUIDE_INDEX = join(FLOE_GUIDE_DIR, "README.md");

export function requireFloeGuide(): string {
  if (!existsSync(FLOE_GUIDE_INDEX)) {
    throw new Error(`The Floe user guide is missing from this install: ${FLOE_GUIDE_INDEX} does not exist.`);
  }
  return FLOE_GUIDE_DIR;
}
