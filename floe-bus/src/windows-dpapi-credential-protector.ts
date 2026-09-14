import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { WindowsCredentialProtector } from "./credential-broker.js";

export const WINDOWS_DPAPI_CREDENTIAL_BROKER_ID = "windows-dpapi-current-user-v1";

type DpapiMode = "protect" | "unprotect";

export type WindowsDpapiCredentialProtectorDependencies = Readonly<{
  platform?: NodeJS.Platform;
  local_app_data?: string;
  run_dpapi?: (mode: DpapiMode, input: Uint8Array) => Promise<Uint8Array>;
}>;

/**
 * A headless CurrentUser DPAPI vault. Only DPAPI-protected bytes are written
 * to disk; plaintext crosses the short-lived PowerShell helper over anonymous
 * pipes and is never placed in arguments, environment variables, or files.
 */
export class WindowsDpapiCredentialProtector implements WindowsCredentialProtector {
  readonly protection_kind = "windows-os-credential-protection" as const;
  private readonly vaultDirectory: string;
  private readonly runDpapi: (mode: DpapiMode, input: Uint8Array) => Promise<Uint8Array>;

  constructor(dependencies: WindowsDpapiCredentialProtectorDependencies = {}) {
    const platform = dependencies.platform ?? process.platform;
    if (platform !== "win32") {
      throw new Error("The Windows DPAPI credential protector is available only on Windows.");
    }
    const localAppData = dependencies.local_app_data
      ?? process.env.LOCALAPPDATA
      ?? join(homedir(), "AppData", "Local");
    this.vaultDirectory = resolve(localAppData, "Floe", "credential-vault", "v1");
    this.runDpapi = dependencies.run_dpapi ?? runWindowsDpapi;
  }

  async writeAtomic(locator: string, material: Uint8Array): Promise<void> {
    requireMaterial(material);
    const target = this.pathForLocator(locator);
    const temporary = join(this.vaultDirectory, `.pending-${randomUUID()}`);
    const protectedBytes = await this.runDpapi("protect", copy(material));
    try {
      if (protectedBytes.byteLength === 0) throw new Error("Windows credential protection returned no data.");
      await mkdir(this.vaultDirectory, { recursive: true });
      await writeFile(temporary, protectedBytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Windows credential protection could not persist the credential.");
    } finally {
      protectedBytes.fill(0);
    }
  }

  async read(locator: string): Promise<Uint8Array | null> {
    const target = this.pathForLocator(locator);
    let protectedBytes: Buffer;
    try {
      protectedBytes = await readFile(target);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error("Windows credential protection could not read the credential.");
    }
    try {
      const material = await this.runDpapi("unprotect", protectedBytes);
      requireMaterial(material);
      return material;
    } catch {
      throw new Error("Windows credential protection could not open the credential.");
    } finally {
      protectedBytes.fill(0);
    }
  }

  async remove(locator: string): Promise<void> {
    await rm(this.pathForLocator(locator), { force: true });
  }

  private pathForLocator(locator: string): string {
    const normalized = requireLocator(locator);
    const name = createHash("sha256")
      .update("floe-windows-dpapi-vault:v1\0", "utf8")
      .update(normalized, "utf8")
      .digest("hex");
    return join(this.vaultDirectory, `${name}.dpapi`);
  }
}

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = Add-Type -AssemblyName System.Security -PassThru
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$memory = New-Object System.IO.MemoryStream
$plain = $null
$protected = $null
try {
  $inputStream.CopyTo($memory)
  $plain = $memory.ToArray()
  $entropy = [Text.Encoding]::UTF8.GetBytes('Floe provider credential vault v1')
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $outputStream.Write($protected, 0, $protected.Length)
  $outputStream.Flush()
} finally {
  if ($plain -ne $null) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($protected -ne $null) { [Array]::Clear($protected, 0, $protected.Length) }
  $memory.Dispose()
}
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = Add-Type -AssemblyName System.Security -PassThru
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$memory = New-Object System.IO.MemoryStream
$protected = $null
$plain = $null
try {
  $inputStream.CopyTo($memory)
  $protected = $memory.ToArray()
  $entropy = [Text.Encoding]::UTF8.GetBytes('Floe provider credential vault v1')
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $outputStream.Write($plain, 0, $plain.Length)
  $outputStream.Flush()
} finally {
  if ($protected -ne $null) { [Array]::Clear($protected, 0, $protected.Length) }
  if ($plain -ne $null) { [Array]::Clear($plain, 0, $plain.Length) }
  $memory.Dispose()
}
`;

async function runWindowsDpapi(mode: DpapiMode, input: Uint8Array): Promise<Uint8Array> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = mode === "protect" ? PROTECT_SCRIPT : UNPROTECT_SCRIPT;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ], {
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
    },
  });

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes <= 16 * 1024 * 1024) stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
  });

  const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
    child.once("error", () => rejectCompletion(new Error("Windows credential protection could not start.")));
    child.once("close", (code) => {
      // Windows PowerShell can emit a harmless CLIXML progress record while it
      // initialises framework assemblies. ErrorActionPreference makes an
      // actual script failure non-zero, so stderr content is deliberately not
      // surfaced (and can never echo credential material).
      if (code !== 0 || stderrBytes > 64 * 1024 || stdoutBytes === 0 || stdoutBytes > 16 * 1024 * 1024) {
        rejectCompletion(new Error("Windows credential protection failed."));
        return;
      }
      resolveCompletion();
    });
  });

  child.stdin.on("error", () => undefined);
  const inputCopy = Buffer.from(input);
  try {
    child.stdin.end(inputCopy);
    await completion;
    const combined = Buffer.concat(stdout);
    try {
      return Uint8Array.from(combined);
    } finally {
      combined.fill(0);
    }
  } finally {
    inputCopy.fill(0);
    for (const chunk of stdout) chunk.fill(0);
  }
}

function requireLocator(locator: string): string {
  if (typeof locator !== "string" || !/^floe\/[A-Za-z0-9%._~/-]{1,1024}$/.test(locator)) {
    throw new Error("The credential broker locator is invalid.");
  }
  return locator;
}

function requireMaterial(material: Uint8Array): void {
  if (!(material instanceof Uint8Array) || material.byteLength === 0 || material.byteLength > 16 * 1024 * 1024) {
    throw new Error("Credential material must contain between 1 byte and 16 MiB.");
  }
}

function copy(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
