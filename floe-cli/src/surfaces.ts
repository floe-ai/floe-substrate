/**
 * surfaces — the on-disk registry of the things a person actually uses Floe
 * through.
 *
 * Floe is a substrate: on its own it is correct but not something a person
 * interacts with. What they interact with is a *surface* (a console, a map, a
 * bespoke tool). Floe must never name a surface — knowing about "the console"
 * would be the same coupling we remove everywhere else. So surfaces self
 * register: installing one writes a small file here that Floe discovers. Floe
 * has no built-in list and no special case for any entry.
 *
 * A registry entry carries the smallest thing that lets Floe launch something
 * it has never heard of:
 *   - name:   a stable id a person can type (and this file's basename);
 *   - label:  a human label to show when offering a choice;
 *   - launch: how to run it — a command and optional arguments.
 *
 * One file per surface (rather than a shared list) keeps self-registration
 * free of read-modify-write races and keeps each entry independently
 * inspectable when something breaks.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { resolveLocalPath, type LocalConfig } from "./config.js";

/** A typeable, stable id: lowercase, starts alphanumeric, words joined by '-'. */
const SURFACE_NAME = /^[a-z0-9][a-z0-9-]*$/;

const SurfaceEntrySchema = z.object({
  name: z.string().regex(SURFACE_NAME, "must be lowercase letters, digits and hyphens"),
  label: z.string().min(1),
  launch: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
}).strict();

export type SurfaceEntry = z.infer<typeof SurfaceEntrySchema>;

/** A registry file that could not be read as a valid surface, kept visible rather than hidden. */
export type BrokenSurface = { file: string; reason: string };

export function surfacesDir(configPath: string, config: LocalConfig): string {
  return resolveLocalPath(configPath, config.home, "./surfaces");
}

function surfaceFile(configPath: string, config: LocalConfig, name: string): string {
  return join(surfacesDir(configPath, config), `${name}.yaml`);
}

/**
 * Every valid surface on disk, sorted by name, plus any files that failed to
 * parse. Broken entries are surfaced (not silently dropped) because this is
 * configuration a person may have to fix by hand.
 */
export function listSurfaces(
  configPath: string,
  config: LocalConfig,
): { surfaces: SurfaceEntry[]; broken: BrokenSurface[] } {
  const dir = surfacesDir(configPath, config);
  if (!existsSync(dir)) return { surfaces: [], broken: [] };
  const surfaces: SurfaceEntry[] = [];
  const broken: BrokenSurface[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml")) continue;
    const path = join(dir, file);
    try {
      const parsed = SurfaceEntrySchema.parse(YAML.parse(readFileSync(path, "utf8")));
      const expected = basename(file, ".yaml");
      if (parsed.name !== expected) {
        broken.push({ file, reason: `name '${parsed.name}' does not match filename '${expected}'` });
        continue;
      }
      surfaces.push(parsed);
    } catch (error) {
      broken.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  surfaces.sort((a, b) => a.name.localeCompare(b.name));
  return { surfaces, broken };
}

export function getSurface(configPath: string, config: LocalConfig, name: string): SurfaceEntry | null {
  return listSurfaces(configPath, config).surfaces.find((surface) => surface.name === name) ?? null;
}

/**
 * Write (or overwrite) a surface's registry entry. This is the mechanism a
 * surface's own installer calls to self-register; Floe writes exactly what it
 * is told and hardcodes nothing about any particular surface.
 */
export function registerSurface(configPath: string, config: LocalConfig, entry: SurfaceEntry): SurfaceEntry {
  const validated = SurfaceEntrySchema.parse(entry);
  const dir = surfacesDir(configPath, config);
  mkdirSync(dir, { recursive: true });
  writeFileSync(surfaceFile(configPath, config, validated.name), YAML.stringify(validated), "utf8");
  return validated;
}

export function removeSurface(configPath: string, config: LocalConfig, name: string): boolean {
  const path = surfaceFile(configPath, config, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Hand the terminal to a surface and wait for it to exit. The surface owns the
 * session from here; Floe's job was only to make sure the substrate was up
 * first. Resolves with the surface's exit code so a caller can propagate it.
 *
 * No shell: the command and its arguments are passed as a real argv array, so
 * nothing is re-parsed or needs escaping. The OS resolves an executable (or an
 * interpreter like `node`) from PATH. A surface that is only reachable through
 * a shell shim should register the interpreter or the real executable as its
 * launch command.
 */
export function launchSurface(entry: SurfaceEntry): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.launch.command, entry.launch.args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
