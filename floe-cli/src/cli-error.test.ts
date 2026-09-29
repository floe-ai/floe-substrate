import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { defaultConfig } from "./config.js";

const runFile = promisify(execFile);
const cleanup: Array<() => Promise<void> | void> = [];
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "floe-cli-error-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function config(path: string, busUrl = "http://127.0.0.1:9"): string {
  const value = defaultConfig(path);
  value.services.start_on_demand = false;
  value.bus.http_base_url = busUrl;
  value.bus.ws_base_url = busUrl.replace("http", "ws");
  const parsed = new URL(busUrl);
  value.bus.listen = `${parsed.hostname}:${parsed.port}`;
  const configPath = join(path, "config.yaml");
  writeFileSync(configPath, YAML.stringify(value), "utf8");
  return configPath;
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await runFile(process.execPath, ["--import", tsx, entry, ...args], {
      env: { ...process.env },
      timeout: 15_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const failed = error as Error & { stdout: string; stderr: string; code: number };
    return { stdout: failed.stdout, stderr: failed.stderr, code: failed.code };
  }
}

function namedLog(stderr: string): string {
  const match = stderr.match(/Full error details were saved to (.+)\r?\n/);
  if (!match) throw new Error(`No error log was named:\n${stderr}`);
  return match[1]!;
}

describe("CLI terminal failure boundary", () => {
  it("turns a corrupt config into a plain explanation and keeps the full detail in the named log", async () => {
    const root = home();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, "schema: [broken", "utf8");

    const result = await run(["--config", configPath, "status"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Floe could not read its config file.");
    expect(result.stderr).toContain(`Next: Fix or replace ${configPath}, then try again.`);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(readFileSync(namedLog(result.stderr), "utf8")).toMatch(/YAMLParseError|Flow sequence/);
  });

  it("shows the stack only when debug output is explicitly enabled", async () => {
    const root = home();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, "schema: [broken", "utf8");

    const result = await run(["--debug", "--config", configPath, "status"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Debug details:");
    expect(result.stderr).toMatch(/\n\s+at /);
  });

  it("explains a missing local service without leaking a stack", async () => {
    const root = home();
    const configPath = config(root);

    const result = await run(["--config", configPath, "identity", "status"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("the required local service is not running");
    expect(result.stderr).toContain("Next: Start Floe through the normal app or service");
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(readFileSync(namedLog(result.stderr), "utf8")).toContain("ChannelUnavailableError");
  });

  it("refuses a bus owned by another install and gives a recovery action", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, instance_id: "another-install" }));
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const root = home();
    const configPath = config(root, `http://127.0.0.1:${port}`);

    const result = await run(["--config", configPath, "start"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("another Floe bus is already using its configured address");
    expect(result.stderr).toContain("Next: Stop the stale Floe process");
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(readFileSync(namedLog(result.stderr), "utf8")).toContain("ForeignBusError");
  });

  it("explains when the configured port is already occupied", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const root = home();
    const configPath = config(root, `http://127.0.0.1:${port}`);

    const result = await run(["--config", configPath, "start"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("its configured address is already in use");
    expect(result.stderr).toContain("Next: Stop the program using that address");
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(readFileSync(namedLog(result.stderr), "utf8")).toContain("EADDRINUSE");
  });
});
