/**
 * Factory reset logic for Floe.
 *
 * Wipes all runtime/state data back to a first-run experience while preserving
 * provider credentials and service configuration.
 *
 * Preserved:
 *   - ~/.floe/config.yaml          (service settings: ports, listen addresses)
 *   - ~/.floe/auth/                (provider credentials: OAuth tokens, API keys, profiles)
 *
 * Wiped (all configured data directories):
 *   - bus data + log dirs          (floe-bus.sqlite — workspaces, contexts, scopes, agents)
 *   - bridge data + log dirs       (bridge runtime state)
 *   - app data + log dirs          (app state)
 *   - library dirs                 (configs, skills, extensions, mcp, templates)
 *   - services.json                (stale PID/process-manager records)
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath, ensureLocalDirs } from "./config.js";
import { recordsPath } from "./process-manager.js";

export interface ResetTarget {
  path: string;
  label: string;
}

export interface ResetPlan {
  wipe: ResetTarget[];
  preserve: ResetTarget[];
}

/**
 * Build the set of paths that will be wiped vs preserved.
 * Does NOT mutate anything on disk.
 */
export function buildResetPlan(configPath: string, config: LocalConfig): ResetPlan {
  const r = (p: string): string => resolveLocalPath(configPath, config.home, p);

  const wipeTargets: ResetTarget[] = [
    { path: r(config.bus.data_dir), label: "bus data (workspaces, contexts, agents)" },
    { path: r(config.bus.log_dir), label: "bus logs" },
    { path: r(config.bridge.data_dir), label: "bridge data" },
    { path: r(config.bridge.log_dir), label: "bridge logs" },
    { path: r(config.library.configs_dir), label: "library: configs" },
    { path: r(config.library.skills_dir), label: "library: skills" },
    { path: r(config.library.extensions_dir), label: "library: extensions" },
    { path: r(config.library.mcp_dir), label: "library: mcp" },
    { path: r(config.library.templates_dir), label: "library: templates" },
    { path: recordsPath(configPath, config), label: "service process records (services.json)" },
  ];

  // Deduplicate by path (two config keys may resolve to the same directory)
  const seen = new Set<string>();
  const wipe: ResetTarget[] = [];
  for (const target of wipeTargets) {
    if (!seen.has(target.path)) {
      seen.add(target.path);
      wipe.push(target);
    }
  }

  const authDir = join(r("."), "auth");
  const preserve: ResetTarget[] = [
    { path: configPath, label: "config.yaml (service settings)" },
    { path: authDir, label: "auth/ (provider credentials)" },
  ];

  return { wipe, preserve };
}

/**
 * Execute the reset: delete all wipeable paths, then recreate the empty
 * directory structure so Floe can start cleanly without re-running setup.
 *
 * Safe to call multiple times (idempotent).
 */
export function executeReset(configPath: string, config: LocalConfig): void {
  const { wipe } = buildResetPlan(configPath, config);

  for (const target of wipe) {
    if (!existsSync(target.path)) continue;
    const stat = statSync(target.path);
    rmSync(target.path, { recursive: stat.isDirectory(), force: true });
  }

  // Recreate empty directories so the next boot doesn't need to re-run setup.
  ensureLocalDirs(configPath, config);
}
