/**
 * Canonical path text for Workspace folders: a real (symlink-resolved) absolute
 * path with forward slashes. Paths inside the Workspace's home folder are kept
 * relative ("." is the home folder), so Actor scopes and grant targets written
 * against the home folder keep their meaning. Paths inside any other folder
 * stay absolute, so a relative scope or target can never contain them.
 */
import path from "node:path";

export function canonicalAbsolutePath(realPath: string): string {
  const slashed = realPath.split(path.sep).join("/");
  return slashed.length > 1 && slashed.endsWith("/") && !/^[A-Za-z]:\/$/.test(slashed) ? slashed.slice(0, -1) : slashed;
}

export function isAbsoluteCanonicalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

/** Relative path of `candidate` under `folder`, "." for the folder itself, or null when outside. */
export function pathUnder(folder: string, candidate: string): string | null {
  const insensitive = /^[A-Za-z]:\//.test(folder);
  const base = insensitive ? folder.toLowerCase() : folder;
  const value = insensitive ? candidate.toLowerCase() : candidate;
  if (value === base) return ".";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return value.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}
