/**
 * surface-catalog — the one list of surfaces `floe` offers, merged from two
 * sources:
 *
 *   1. installed packages that declare `floe.surface` in their package.json;
 *   2. registry files under <floe home>/surfaces (surfaces that are not packages).
 *
 * Rule when both describe the same name: the installed package wins. A package
 * manifest describes what is actually installed right now; a registry file is a
 * record written earlier that can go stale (the same reason start-at-login is
 * read from the OS rather than recorded). The shadowed file is kept visible in
 * `floe surface list`, not silently hidden.
 *
 * Two installed packages claiming the same name are ambiguous, so neither is
 * offered and the conflict is reported — Floe does not guess.
 */
import type { LocalConfig } from "./config.js";
import { listSurfaces, type BrokenSurface, type SurfaceEntry } from "./surfaces.js";
import { detectPackageSurfaces, globalPackageRoot, type BrokenManifest } from "./surface-manifests.js";

export type SurfaceSource =
  | { kind: "package"; package: string }
  | { kind: "registry" };

export type CatalogSurface = SurfaceEntry & { source: SurfaceSource };

export type SurfaceCatalog = {
  surfaces: CatalogSurface[];
  /** Registry files unreadable as a surface. */
  brokenFiles: BrokenSurface[];
  /** Packages whose `floe.surface` declaration is malformed. */
  brokenManifests: BrokenManifest[];
  /** Registry entries hidden because an installed package declares the same name. */
  shadowed: { name: string; byPackage: string }[];
  /** Names claimed by more than one installed package; none of them is offered. */
  conflicts: { name: string; packages: string[] }[];
};

export function buildSurfaceCatalog(
  configPath: string,
  config: LocalConfig,
  packageRoot: string | null = globalPackageRoot(),
): SurfaceCatalog {
  const registry = listSurfaces(configPath, config);
  const detected = detectPackageSurfaces(packageRoot);

  const byName = new Map<string, typeof detected.surfaces>();
  for (const surface of detected.surfaces) {
    byName.set(surface.name, [...(byName.get(surface.name) ?? []), surface]);
  }

  const surfaces: CatalogSurface[] = [];
  const conflicts: SurfaceCatalog["conflicts"] = [];
  for (const [name, claims] of byName) {
    if (claims.length > 1) {
      conflicts.push({ name, packages: claims.map((c) => c.package).sort() });
      continue;
    }
    const { package: pkg, packageDir: _dir, ...entry } = claims[0]!;
    surfaces.push({ ...entry, source: { kind: "package", package: pkg } });
  }

  const shadowed: SurfaceCatalog["shadowed"] = [];
  for (const entry of registry.surfaces) {
    const claims = byName.get(entry.name);
    if (claims) {
      if (claims.length === 1) shadowed.push({ name: entry.name, byPackage: claims[0]!.package });
      continue; // a conflicted name is not rescued by a registry file either
    }
    surfaces.push({ ...entry, source: { kind: "registry" } });
  }

  surfaces.sort((a, b) => a.name.localeCompare(b.name));
  return { surfaces, brokenFiles: registry.broken, brokenManifests: detected.broken, shadowed, conflicts };
}
