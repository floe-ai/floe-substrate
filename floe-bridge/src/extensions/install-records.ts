/**
 * Reads a Workspace's installed Extensions and decides which may run.
 *
 * Each installed Extension has a record at `.floe/extensions/NAME/installed.json`
 * that points at its code (anywhere on the machine) and pins the version an
 * Actor accepted. Code whose current version differs from the accepted one is
 * held until an Actor accepts it; nothing changes silently.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const INSTALL_RECORD_FILE = "installed.json";
export const INSTALL_RECORD_SCHEMA = "floe.extension-install.v1";
export const MANIFEST_FILE = "extension.json";
export const MANIFEST_SCHEMA = "floe.extension.v1";
export const EXTENSION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Folders that never count towards a content digest. */
const DIGEST_SKIPPED = new Set([".git", "node_modules"]);

export type InstallRecord = Readonly<{
  schema: typeof INSTALL_RECORD_SCHEMA;
  /** Code folder, relative to the record's folder or absolute. "." means the record's folder. */
  code: string;
  enabled: boolean;
  accepted_version: string | null;
}>;

export type ExtensionManifest = Readonly<{
  schema: typeof MANIFEST_SCHEMA;
  name: string;
  description?: string;
  entry: string;
}>;

/** Where a version came from: a committed git folder, or files that are not committed. */
export type ExtensionVersionSource =
  | Readonly<{ kind: "git"; commit: string; path: string }>
  | Readonly<{ kind: "digest" }>;

export type ExtensionCheck =
  | Readonly<{
    name: string;
    state: "ready";
    version: string;
    source: ExtensionVersionSource;
    code_dir: string;
    entry_path: string;
    description?: string;
  }>
  | Readonly<{ name: string; state: "off" }>
  | Readonly<{
    name: string;
    state: "new_version";
    accepted_version: string | null;
    current_version: string;
    source: ExtensionVersionSource;
  }>
  | Readonly<{ name: string; state: "failed"; message: string }>;

export class ExtensionRecordError extends Error {}

/** Checks every installed Extension in a Workspace's `.floe` folder, sorted by name. */
export async function checkInstalledExtensions(floeDir: string): Promise<ExtensionCheck[]> {
  const extensionsDir = join(floeDir, "extensions");
  let names: string[];
  try {
    names = (await readdir(extensionsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
  return Promise.all(names.map(name => checkInstalledExtension(join(extensionsDir, name), name)));
}

export async function checkInstalledExtension(recordDir: string, name: string): Promise<ExtensionCheck> {
  try {
    if (!EXTENSION_NAME.test(name)) {
      throw new ExtensionRecordError(
        `folder name '${name}' must use lowercase letters, digits and hyphens (it is the Extension's name)`,
      );
    }
    const record = parseInstallRecord(await readJson(join(recordDir, INSTALL_RECORD_FILE), INSTALL_RECORD_FILE));
    if (!record.enabled) return { name, state: "off" };

    const codeDir = isAbsolute(record.code) ? resolve(record.code) : resolve(recordDir, record.code);
    const manifest = parseManifest(await readJson(join(codeDir, MANIFEST_FILE), MANIFEST_FILE));
    if (manifest.name !== name) {
      throw new ExtensionRecordError(`${MANIFEST_FILE} names '${manifest.name}' but it is installed as '${name}'`);
    }
    const entryPath = resolve(codeDir, manifest.entry);
    if (!isInside(codeDir, entryPath)) {
      throw new ExtensionRecordError(`entry '${manifest.entry}' must stay inside the Extension's code folder`);
    }
    if (!(await isFile(entryPath))) {
      throw new ExtensionRecordError(`entry '${manifest.entry}' does not exist`);
    }

    const { version, source } = await currentVersion(codeDir, entryPath, join(recordDir, INSTALL_RECORD_FILE));
    if (version !== record.accepted_version) {
      return { name, state: "new_version", accepted_version: record.accepted_version, current_version: version, source };
    }
    return {
      name,
      state: "ready",
      version,
      source,
      code_dir: codeDir,
      entry_path: entryPath,
      ...(manifest.description ? { description: manifest.description } : {}),
    };
  } catch (error) {
    return { name, state: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The version of an Extension's code folder: a digest of every file in it,
 * leaving out `.git`, installed dependencies (`node_modules`) and the install
 * record itself (which sits in the code folder when the code lives there).
 * The same files always give the same version, wherever they came from.
 *
 * When the folder is committed in git with nothing changed, the source also
 * pins the commit and folder, so the exact code can be fetched again.
 */
export async function currentVersion(
  codeDir: string,
  entryPath: string,
  recordPath: string,
): Promise<{ version: string; source: ExtensionVersionSource }> {
  const [digest, pinned] = await Promise.all([digestFolder(codeDir, recordPath), gitSource(codeDir, entryPath, recordPath)]);
  return { version: `sha256:${digest}`, source: pinned ?? { kind: "digest" } };
}

async function gitSource(codeDir: string, entryPath: string, recordPath: string): Promise<ExtensionVersionSource | null> {
  try {
    const git = (...args: string[]) => run("git", ["-C", codeDir, ...args], { windowsHide: true })
      .then(({ stdout }) => stdout.trim());
    const prefix = await git("rev-parse", "--show-prefix");
    const record = isInside(codeDir, recordPath) ? relative(codeDir, recordPath).split(sep).join("/") : null;
    const changes = await git(
      "status", "--porcelain", "--untracked-files=all", "--", ".", ...(record ? [`:(exclude)${record}`] : []),
    );
    if (changes !== "") return null;
    const tracked = await git("ls-files", "--", relative(codeDir, entryPath).split(sep).join("/"));
    if (tracked === "") return null;
    const folder = prefix.replace(/\/$/, "");
    return { kind: "git", commit: await git("rev-parse", "HEAD"), path: folder === "" ? "." : folder };
  } catch {
    return null;
  }
}

async function digestFolder(codeDir: string, recordPath: string): Promise<string> {
  const files: string[] = [];
  const skippedRecord = resolve(recordPath);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (DIGEST_SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && resolve(path) !== skippedRecord) files.push(path);
    }
  };
  await walk(codeDir);
  const hash = createHash("sha256");
  const ordered = files
    .map(path => ({ path, key: relative(codeDir, path).split(sep).join("/") }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  for (const { path, key } of ordered) {
    const content = await readFile(path);
    hash.update(`${key}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export function parseInstallRecord(value: unknown): InstallRecord {
  const record = object(value, INSTALL_RECORD_FILE);
  if (record.schema !== INSTALL_RECORD_SCHEMA) {
    throw new ExtensionRecordError(`${INSTALL_RECORD_FILE} schema must be '${INSTALL_RECORD_SCHEMA}'`);
  }
  if (typeof record.code !== "string" || record.code.trim() === "") {
    throw new ExtensionRecordError(`${INSTALL_RECORD_FILE} code must name the Extension's code folder ('.' for this folder)`);
  }
  if (typeof record.enabled !== "boolean") {
    throw new ExtensionRecordError(`${INSTALL_RECORD_FILE} enabled must be true or false`);
  }
  if (record.accepted_version !== null && (typeof record.accepted_version !== "string" || record.accepted_version === "")) {
    throw new ExtensionRecordError(`${INSTALL_RECORD_FILE} accepted_version must be a version or null`);
  }
  return {
    schema: INSTALL_RECORD_SCHEMA,
    code: record.code,
    enabled: record.enabled,
    accepted_version: record.accepted_version,
  };
}

export function parseManifest(value: unknown): ExtensionManifest {
  const manifest = object(value, MANIFEST_FILE);
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new ExtensionRecordError(`${MANIFEST_FILE} schema must be '${MANIFEST_SCHEMA}'`);
  }
  if (typeof manifest.name !== "string" || !EXTENSION_NAME.test(manifest.name)) {
    throw new ExtensionRecordError(`${MANIFEST_FILE} name must use lowercase letters, digits and hyphens`);
  }
  if (typeof manifest.entry !== "string" || manifest.entry.trim() === "") {
    throw new ExtensionRecordError(`${MANIFEST_FILE} entry must name the code file to load`);
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    throw new ExtensionRecordError(`${MANIFEST_FILE} description must be text`);
  }
  return {
    schema: MANIFEST_SCHEMA,
    name: manifest.name,
    entry: manifest.entry,
    ...(manifest.description ? { description: manifest.description } : {}),
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ExtensionRecordError(`${label} is missing`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtensionRecordError(`${label} is not valid JSON`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionRecordError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
