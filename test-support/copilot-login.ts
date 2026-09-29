/**
 * The live runtime tier drives the real Copilot SDK, whose login lives in the
 * person's Copilot home, not in Floe's. Isolating the user profile would hide
 * it, so point Copilot at its real home explicitly. Floe's own home stays
 * isolated; this reaches only Copilot's.
 */
import { userInfo } from "node:os";
import { join } from "node:path";

process.env.COPILOT_HOME ??= join(userInfo().homedir, ".copilot");
