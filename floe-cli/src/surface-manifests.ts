/**
 * surface-manifests — detect surfaces from what installed packages say about
 * themselves.
 *
 * A package declares that it is a surface in its own package.json:
 *
 *   "floe": {
 *     "surface": { "name": "console", "label": "Floe Console", "bin": "floe-console" }
 *   }
 *
 *   - name:  the id a person types (`floe console`); lowercase, digits, hyphens.
 *   - label: what a person sees when choosing.
 *   - bin:   which of the package's own `bin` entries launches it.
 *
 * The manifest IS the registration: nothing runs at install time, so it works
 * for git installs (where npm refuses packages with install scripts). Floe never
 * names a surface; it only reads what packages declare.
 *
 * Detection reads globally installed packages (`npm root -g`), because a global
 * install is how a person puts a surface on this machine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { SURFACE_NAME, type SurfaceEntry } from "./surfaces.js";

const ManifestSchema = z.object({
  name: z.string().regex(SURFACE_NAME, "must be lowercase letters, digits and hyphens"),
  label: z.string().min(1),
  bin: z.string().min(1),
}).strict();

export type PackageSurface = SurfaceEntry & { package: string; packageDir: string };
export type BrokenManifest = { package: string; reason: string };

/** The global node_modules directory, or null when npm cannot say. */
export function globalPackageRoot(): string | null {
  // npm is a shell shim on Windows; one command string (no args array) keeps
  // node from warning about shell-concatenated arguments in the person's terminal.
  const result = spawnSync("npm root -g", {
    encoding: "utf8",
    shell: true,
    timeout: 15000,
  });
  const root = result.status === 0 ? result.stdout.trim() : "";
  return root && existsSync(root) ? root : null;
}

/** Package directories directly under a node_modules root, including @scope/name. */
function packageDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    const path = join(root, entry);
    if (entry.startsWith("@")) {
      try {
        for (const scoped of readdirSync(path)) dirs.push(join(path, scoped));
      } catch { /* unreadable scope dir: nothing to detect */ }
    } else {
      dirs.push(path);
    }
  }
  return dirs;
}

/** Surfaces declared by packages installed under `root`, plus declarations that are malformed. */
export function detectPackageSurfaces(root: string | null): { surfaces: PackageSurface[]; broken: BrokenManifest[] } {
  const surfaces: PackageSurface[] = [];
  const broken: BrokenManifest[] = [];
  if (!root) return { surfaces, broken };
  for (const dir of packageDirs(root)) {
    const manifestPath = join(dir, "package.json");
    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // not a readable package: not ours to judge
    }
    const declared = pkg?.floe?.surface;
    if (declared === undefined) continue;
    const packageName = typeof pkg.name === "string" ? pkg.name : dir;
    const parsed = ManifestSchema.safeParse(declared);
    if (!parsed.success) {
      broken.push({ package: packageName, reason: parsed.error.issues.map((i) => `${i.path.join(".") || "surface"}: ${i.message}`).join("; ") });
      continue;
    }
    const binTarget = resolveBinTarget(pkg, parsed.data.bin);
    if (!binTarget) {
      broken.push({ package: packageName, reason: `floe.surface.bin '${parsed.data.bin}' is not one of this package's bins` });
      continue;
    }
    const script = resolve(dir, binTarget);
    if (!existsSync(script)) {
      broken.push({ package: packageName, reason: `bin '${parsed.data.bin}' points at ${binTarget}, which is not installed` });
      continue;
    }
    surfaces.push({
      name: parsed.data.name,
      label: parsed.data.label,
      launch: launchFor(script),
      package: packageName,
      packageDir: dir,
    });
  }
  return { surfaces, broken };
}

/** The file a package's named bin points at (handles the string shorthand form of `bin`). */
function resolveBinTarget(pkg: any, binName: string): string | null {
  if (typeof pkg.bin === "string") {
    const implied = String(pkg.name ?? "").replace(/^@[^/]+\//, "");
    return implied === binName ? pkg.bin : null;
  }
  if (pkg.bin && typeof pkg.bin === "object" && typeof pkg.bin[binName] === "string") return pkg.bin[binName];
  return null;
}

/**
 * Launch a bin the way npm's own shim would: a node script runs under this
 * node; anything else is executed directly. Resolving the file (not a PATH shim)
 * means no shell and no dependence on PATH.
 */
function launchFor(script: string): SurfaceEntry["launch"] {
  if ([".js", ".mjs", ".cjs"].includes(extname(script).toLowerCase()) || hasNodeShebang(script)) {
    return { command: process.execPath, args: [script] };
  }
  return { command: script, args: [] };
}

function hasNodeShebang(path: string): boolean {
  const buffer = Buffer.alloc(128);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, read).toString("utf8").split(/\r?\n/)[0] ?? "";
    return firstLine.startsWith("#!") && firstLine.includes("node");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
