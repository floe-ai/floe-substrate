/**
 * Every identity Floe holds in one home: the current one and each one set aside
 * by restore, replace or import. Listing never decrypts anything; deleting
 * removes the file for good, with no copy kept.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { identityDir, parseIdentityFile, type IdentityFile } from "./identity-file.js";

export const CURRENT_IDENTITY_ID = "current";
const CURRENT_FILE = "identity.json";
const SET_ASIDE = /^identity\.(set-aside-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z)\.json$/;

export type HeldIdentity = {
  /** `current`, or `set-aside-<when>` for one set aside. */
  id: string;
  current: boolean;
  file_name: string;
  /** Null when the file cannot be read; it can still be deleted. */
  file: IdentityFile | null;
  set_aside_at: string | null;
};

export function listHeldIdentities(home: string): HeldIdentity[] {
  let names: string[];
  try {
    names = readdirSync(identityDir(home));
  } catch {
    return [];
  }
  const held: HeldIdentity[] = [];
  for (const name of names) {
    if (name === CURRENT_FILE) {
      held.push({ id: CURRENT_IDENTITY_ID, current: true, file_name: name, file: read(home, name), set_aside_at: null });
      continue;
    }
    const match = SET_ASIDE.exec(name);
    if (!match) continue;
    const [, id, day, hh, mm, ss, ms] = match;
    held.push({ id: id!, current: false, file_name: name, file: read(home, name), set_aside_at: `${day}T${hh}:${mm}:${ss}.${ms}Z` });
  }
  // The current identity first, then the most recently set aside.
  return held.sort((a, b) => Number(b.current) - Number(a.current) || (b.set_aside_at ?? "").localeCompare(a.set_aside_at ?? ""));
}

export function findHeldIdentity(home: string, id: string): HeldIdentity | null {
  return listHeldIdentities(home).find((entry) => entry.id === id) ?? null;
}

/** Delete one identity file for good, with any half-written copy of the current one. */
export function deleteHeldIdentityFile(home: string, entry: HeldIdentity): void {
  const dir = identityDir(home);
  rmSync(join(dir, entry.file_name), { force: true });
  if (!entry.current) return;
  for (const name of readdirSync(dir)) {
    if (/^identity\.json\.\d+\.tmp$/.test(name)) rmSync(join(dir, name), { force: true });
  }
}

/** Does any identity still held need the device key to open? An unreadable one might, so it counts. */
export function anyNeedsDeviceKey(home: string): boolean {
  return listHeldIdentities(home).some((entry) => entry.file === null || entry.file.protection === "device");
}

function read(home: string, name: string): IdentityFile | null {
  try {
    return parseIdentityFile(JSON.parse(readFileSync(join(identityDir(home), name), "utf8")));
  } catch {
    return null;
  }
}
