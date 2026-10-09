/**
 * Every Floe test runs against a throwaway user profile, by construction.
 *
 * Floe finds its home the way it does on a person's machine: from the OS user
 * profile (`~/.floe`, and on Windows `%LOCALAPPDATA%\Floe`). This setup file
 * runs in every test worker before any test module loads and points the
 * profile variables at a fresh temporary directory, so a default config, a
 * `~` path, or a spawned Floe service can only ever reach that directory.
 *
 * The guard is the second wall. The real profile is read from the OS account
 * (not the environment). A test fails loudly, even if the error was swallowed,
 * when it:
 *   - touches a file or SQLite database under the real Floe home;
 *   - writes content that names the real Floe home (a config whose `home` is
 *     it, or a native broker command acting for it);
 *   - lists the real user profile folder;
 *   - reaches the real bus address by any connection (http, WebSocket, fetch,
 *     raw socket) or by a spawned process (the broker names the host-control
 *     credential in the OS keyring by it).
 * Device keys in the OS keyring are named per Floe home, so a test's
 * throwaway home can never name a real one.
 *
 * Every OS keyring entry a test's broker command may create (a host-control
 * credential for a throwaway bus, a device key for a throwaway home) is
 * recorded. A test must remove its own entries; one still left when the test
 * file ends is removed and fails the file, so the keyring never fills.
 */
import { afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const windows = process.platform === "win32";

type Guard = {
  protectedRoots: string[];
  realProfile: string;
  violations: string[];
  isolatedHome: string | null;
  keyring: { buses: Set<string>; homes: Set<string> };
};
const GUARD_KEY = Symbol.for("floe.test.guard");
const slot = globalThis as unknown as Record<symbol, Guard | undefined>;

function normal(path: string): string {
  const full = resolve(path);
  return windows ? full.toLowerCase() : full;
}

/** Read once, before any isolation, from the OS account rather than the environment. */
function realFloeRoots(): string[] {
  const realHome = userInfo().homedir;
  const roots = [join(realHome, ".floe")];
  if (windows) {
    roots.push(join(realHome, "AppData", "Local", "Floe"));
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "Floe"));
  }
  return [...new Set(roots.map(normal))];
}

function pathOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function refuse(guard: Guard, message: string): never {
  guard.violations.push(message);
  process.stderr.write(`\n[floe test guard] ${message}\n`);
  throw new Error(message);
}

function check(operation: string, value: unknown): void {
  const guard = slot[GUARD_KEY];
  const path = pathOf(value);
  if (!guard || !path || path === ":memory:") return;
  const target = normal(path);
  const separator = windows ? "\\" : "/";
  if (/^(fs(\.promises)?)\.(readdir|opendir)(Sync)?$/.test(operation) && target === guard.realProfile) {
    refuse(guard, `A test listed the real user profile: ${operation}(${path}). Tests run against an isolated home (${guard.isolatedHome}).`);
  }
  if (!guard.protectedRoots.some((root) => target === root || target.startsWith(root + separator))) return;
  refuse(guard, `A test reached the real Floe home: ${operation}(${path}). Tests run against an isolated home (${guard.isolatedHome}).`);
}

/** Written content that names the real Floe home, such as a config whose `home` is it, is refused too. */
function checkContent(operation: string, data: unknown): void {
  const guard = slot[GUARD_KEY];
  if (!guard) return;
  const text = typeof data === "string" ? data
    : data instanceof Uint8Array && data.length <= 4 * 1024 * 1024 ? Buffer.from(data).toString("utf8")
      : null;
  if (!text) return;
  const haystack = windows ? text.toLowerCase() : text;
  for (const root of guard.protectedRoots) {
    const forms = [root, root.replaceAll("\\", "/"), root.replaceAll("\\", "\\\\")];
    if (forms.some((form) => haystack.includes(form))) {
      refuse(guard, `A test wrote the real Floe home (${root}) into a file with ${operation}. Tests run against an isolated home (${guard.isolatedHome}).`);
    }
  }
}

const PATH_FUNCTIONS = [
  "access", "appendFile", "chmod", "copyFile", "cp", "createReadStream", "createWriteStream", "exists",
  "lstat", "mkdir", "mkdtemp", "open", "opendir", "readdir", "readFile", "readlink", "realpath",
  "rename", "rm", "rmdir", "stat", "symlink", "truncate", "unlink", "utimes", "watch", "writeFile",
];
const TWO_PATHS = new Set(["copyFile", "cp", "rename", "symlink"]);
const WRITES_CONTENT = new Set(["writeFile", "appendFile"]);

function wrap(target: Record<string, unknown>, label: string, names: string[]): void {
  for (const name of names) {
    const original = target[name] as ((...args: unknown[]) => unknown) & { __floeGuarded?: boolean };
    if (typeof original !== "function" || original.__floeGuarded) continue;
    const base = name.replace(/Sync$/, "");
    const guarded = function (this: unknown, ...args: unknown[]) {
      check(`${label}.${name}`, args[0]);
      if (TWO_PATHS.has(base)) check(`${label}.${name}`, args[1]);
      if (WRITES_CONTENT.has(base)) checkContent(`${label}.${name}`, args[1]);
      return original.apply(this, args);
    };
    Object.assign(guarded, original);
    Object.defineProperty(guarded, "__floeGuarded", { value: true });
    target[name] = guarded;
  }
}

function installGuard(): void {
  const fs = require("node:fs") as Record<string, unknown>;
  wrap(fs, "fs", PATH_FUNCTIONS.flatMap((name) => [name, `${name}Sync`]));
  wrap(fs.promises as Record<string, unknown>, "fs.promises", PATH_FUNCTIONS);
  guardChildProcesses();
  guardFetch();
  guardSockets();

  const sqlite = require("node:sqlite") as Record<string, unknown>;
  const Original = sqlite.DatabaseSync as { new (...args: unknown[]): object; __floeGuarded?: boolean };
  if (!Original.__floeGuarded) {
    class DatabaseSync extends Original {
      static __floeGuarded = true;
      constructor(...args: unknown[]) {
        check("sqlite.DatabaseSync", args[0]);
        super(...args);
      }
    }
    Object.defineProperty(sqlite, "DatabaseSync", { value: DatabaseSync, writable: true, configurable: true, enumerable: true });
  }
  syncBuiltinESMExports();
}

/**
 * The real Floe is also reachable without a path: its Bus answers on the
 * default address, and the native broker names the host-control credential in
 * the OS keyring by that address. Neither may be reached from a test.
 */
const REAL_BUS = /\/\/(127\.0\.0\.1|localhost|\[::1\]):5377(?![0-9])/i;

function checkBusAddress(operation: string, value: unknown): void {
  const guard = slot[GUARD_KEY];
  if (!guard || typeof value !== "string" || !REAL_BUS.test(value)) return;
  refuse(guard, `A test reached the real Floe bus address: ${operation}(${value}). Tests run their own bus on a free port.`);
}

type Spawn = (command: string, args?: unknown, options?: unknown) => { stdin?: { write: Function; end: Function } | null };

function guardChildProcesses(): void {
  const childProcess = require("node:child_process") as Record<string, unknown>;
  const original = childProcess.spawn as Spawn & { __floeGuarded?: boolean };
  if (original.__floeGuarded) return;
  const guarded = function (this: unknown, command: string, args?: unknown, options?: unknown) {
    const opts = (Array.isArray(args) ? options : args) as { env?: Record<string, string | undefined> } | undefined;
    for (const [name, value] of Object.entries(opts?.env ?? {})) checkBusAddress(`child_process.spawn(${command}) env ${name}`, value);
    const child = original.call(this, command, args, options);
    const busBase = opts?.env?.FLOE_BUS_HTTP_BASE;
    const stdin = child.stdin;
    if (stdin) {
      // A broker command names the Floe home it acts for on stdin.
      for (const method of ["write", "end"] as const) {
        const send = stdin[method].bind(stdin);
        stdin[method] = (chunk?: unknown, ...rest: unknown[]) => {
          try {
            checkContent(`child_process.spawn(${command}) stdin`, chunk);
            if (typeof chunk === "string" || chunk instanceof Uint8Array) {
              checkBusAddress(`child_process.spawn(${command}) stdin`, String(chunk));
              if (/floe-authority-broker(\.exe)?$/i.test(command)) recordKeyringEntry(String(chunk), busBase);
            }
          } catch (error) {
            (child as { kill?: () => void }).kill?.();
            throw error;
          }
          return send(chunk, ...rest);
        };
      }
    }
    return child;
  };
  Object.defineProperty(guarded, "__floeGuarded", { value: true });
  childProcess.spawn = guarded;
}

/** Note the keyring entry a broker command may create or remove, so leftovers can be found. */
function recordKeyringEntry(payload: string, busBase: string | undefined): void {
  const guard = slot[GUARD_KEY];
  if (!guard) return;
  let request: { command?: unknown; home?: unknown; create?: unknown };
  try {
    request = JSON.parse(payload);
  } catch {
    return;
  }
  if (request.command === "identity_device_key" && request.create === true && typeof request.home === "string") {
    guard.keyring.homes.add(request.home);
  } else if (request.command === "forget_identity_device_key" && typeof request.home === "string") {
    guard.keyring.homes.delete(request.home);
  } else if (busBase && request.command === "forget_host_control_token") {
    guard.keyring.buses.delete(busBase);
  } else if (busBase) {
    // Any command that opens the broker with a bus address may mint that install's credential.
    guard.keyring.buses.add(busBase);
  }
}

async function removeLeftoverKeyringEntries(guard: Guard): Promise<void> {
  const buses = [...guard.keyring.buses];
  const homes = [...guard.keyring.homes];
  guard.keyring.buses.clear();
  guard.keyring.homes.clear();
  if (buses.length === 0 && homes.length === 0) return;
  const { forgetHostControlToken, forgetIdentityDeviceKey } = await import("../floe-cli/src/operation-client.js");
  const failures: string[] = [];
  for (const bus of buses) await forgetHostControlToken(bus).catch((error) => failures.push(`${bus}: ${error}`));
  for (const home of homes) await forgetIdentityDeviceKey(home).catch((error) => failures.push(`${home}: ${error}`));
  const left = [...buses, ...homes].join("\n");
  if (failures.length > 0) throw new Error(`Test keyring entries were left behind and could not be removed:\n${failures.join("\n")}`);
  throw new Error(`Tests left OS keyring entries behind. Remove each one when its install or home is gone:\n${left}`);
}

function guardFetch(): void {
  const original = globalThis.fetch as typeof fetch & { __floeGuarded?: boolean };
  if (!original || original.__floeGuarded) return;
  const guarded = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      checkBusAddress("fetch", url);
    } catch (error) {
      return Promise.reject(error);
    }
    return original(input, init);
  }) as typeof fetch;
  Object.defineProperty(guarded, "__floeGuarded", { value: true });
  globalThis.fetch = guarded;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Every in-process connection (http, ws, fetch, the global WebSocket, raw net)
 * opens through `net.Socket.prototype.connect`, so a connection to the real bus
 * port is refused there whatever client a test uses.
 */
function guardSockets(): void {
  const net = require("node:net") as { Socket: { prototype: Record<string, unknown> } };
  const proto = net.Socket.prototype;
  const original = proto.connect as ((...args: unknown[]) => unknown) & { __floeGuarded?: boolean };
  if (original.__floeGuarded) return;
  const guarded = function (this: { destroy?: () => void }, ...args: unknown[]) {
    // net.connect passes its normalised [options, callback]; direct calls pass (options) or (port, host).
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = (first && typeof first === "object" ? first : { port: first, host: args[1] }) as { port?: unknown; host?: unknown; path?: unknown };
    const port = Number(options.port);
    const host = typeof options.host === "string" ? options.host.toLowerCase() : "localhost";
    if (!options.path && port === 5377 && LOOPBACK.has(host)) {
      this.destroy?.();
      checkBusAddress("net.Socket.connect", `//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
    }
    return original.apply(this, args);
  };
  Object.defineProperty(guarded, "__floeGuarded", { value: true });
  proto.connect = guarded;
}

function isolateProfile(guard: Guard): void {
  const home = mkdtempSync(join(tmpdir(), "floe-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (windows) {
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  } else {
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_DATA_HOME = join(home, ".local", "share");
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
  }
  if (normal(homedir()) !== normal(home)) {
    throw new Error(`Test isolation failed: the user profile still resolves to ${homedir()}, not ${home}.`);
  }
  guard.isolatedHome = home;
}

const guard = slot[GUARD_KEY] ?? (slot[GUARD_KEY] = {
  protectedRoots: realFloeRoots(),
  realProfile: normal(userInfo().homedir),
  violations: [],
  isolatedHome: null,
  keyring: { buses: new Set(), homes: new Set() },
});
installGuard();
isolateProfile(guard);

afterEach(() => {
  if (guard.violations.length === 0) return;
  const found = guard.violations.splice(0);
  throw new Error(`The real Floe home was reached during this test:\n${found.join("\n")}`);
});

afterAll(async () => {
  try {
    await removeLeftoverKeyringEntries(guard);
  } finally {
    if (guard.isolatedHome) {
      try {
        rmSync(guard.isolatedHome, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A service a test left running may still hold a file; the OS temp cleaner owns it now.
      }
    }
  }
});
