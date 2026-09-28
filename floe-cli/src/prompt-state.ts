/**
 * prompt-state — remembers which one-time questions a person has already been
 * asked, so "first launch" means "never asked", not "config file is new".
 *
 * This is a record of a conversation with the person, not a claim about the
 * machine: whether start-at-login is installed is still read from the OS. It
 * lives beside the config, not in it, because it is not a setting.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveLocalPath, type LocalConfig } from "./config.js";

export type PromptKey = "start_at_login";

type PromptRecord = Partial<Record<PromptKey, { asked_at: string }>>;

function statePath(configPath: string, config: LocalConfig): string {
  return resolveLocalPath(configPath, config.home, "./asked.json");
}

function read(configPath: string, config: LocalConfig): PromptRecord {
  const path = statePath(configPath, config);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PromptRecord;
  } catch {
    return {}; // an unreadable record means we ask again, which is the safe side
  }
}

export function hasBeenAsked(configPath: string, config: LocalConfig, key: PromptKey): boolean {
  return read(configPath, config)[key] !== undefined;
}

export function markAsked(configPath: string, config: LocalConfig, key: PromptKey): void {
  const path = statePath(configPath, config);
  const record = read(configPath, config);
  record[key] = { asked_at: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
}
