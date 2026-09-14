/**
 * Reusable vertical-slice harness.
 *
 * Brings up a real Floe instance (Bus + Bridge) through the exact product start
 * sequence and hands back the authenticated client helpers the slice tests use.
 * It is parameterised by runtime adapter so the same lifecycle can be proven on
 * both the fake adapter (fast, no network) and the real FloeRuntimeAdapter
 * (spawns the vendor `copilot --acp` CLI). Nothing here bypasses authority: every
 * privileged call is authenticated with a real broker-minted credential.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import YAML from "yaml";
import type { LocalConfig } from "../../floe-cli/src/config.js";
import { startAll } from "../../floe-cli/src/startup.js";
import { stopService } from "../../floe-cli/src/process-manager.js";
import {
  fetchHostControlToken,
  registerLocalWorkspaceViaBroker
} from "../../floe-cli/src/operation-client.js";

/** One runtime-adapter tier the slice can be proven against. */
export interface SliceTier {
  /** Stable id used in test names. */
  id: string;
  /** Runtime adapter the Bridge selects (drives FLOE_RUNTIME_ADAPTER). */
  adapter: "fake" | "floe-runtime";
  /** Provider recorded on the runtime binding. */
  provider: string;
  /** Model pinned on the runtime binding and forwarded to the adapter. */
  model: string;
  /** Whether this tier drives a real vendor CLI over the network. */
  live: boolean;
}

export class SliceHarness {
  temp!: string;
  projectPath!: string;
  configPath!: string;
  busUrl!: string;
  wsUrl!: string;
  cliConfig!: LocalConfig;
  private hostControlToken = "";
  private operationSessionBearer = "";
  private eventSocket: any;
  busMessages: any[] = [];

  constructor(private readonly tier: SliceTier) {}

  async start(): Promise<void> {
    this.temp = mkdtempSync(join(tmpdir(), "floe-test-"));
    this.projectPath = join(this.temp, "project");
    mkdirSync(this.projectPath, { recursive: true });
    const busPort = await freePort();
    this.busUrl = `http://127.0.0.1:${busPort}`;
    this.wsUrl = `ws://127.0.0.1:${busPort}`;
    this.configPath = join(this.temp, "config.yaml");
    writeFileSync(this.configPath, YAML.stringify({
      schema: "floe.local.v1",
      version: 1,
      home: this.temp,
      services: { autostart: false, manager: "auto" },
      bus: {
        listen: `127.0.0.1:${busPort}`,
        http_base_url: this.busUrl,
        ws_base_url: this.wsUrl,
        data_dir: "./bus",
        log_dir: "./logs/bus"
      },
      bridge: {
        data_dir: "./bridge",
        log_dir: "./logs/bridge",
        bus_url: this.wsUrl,
        workspace_access: { local_paths: true }
      },
      library: {
        configs_dir: "./configs",
        skills_dir: "./skills",
        extensions_dir: "./extensions",
        mcp_dir: "./mcp",
        templates_dir: "./templates"
      }
    }), "utf8");

    // The native broker mints the Bridge service credential and workspace
    // operation sessions against a Bus URL it resolves from the environment.
    // Point it at this isolated Bus so the harness runs the real broker path
    // instead of the default-port product instance.
    process.env.FLOE_BUS_HTTP_BASE = this.busUrl;

    // The CLI-shaped config the product start path consumes. It shares the home,
    // ports and log dirs of the on-disk Bus config, and selects this tier's
    // runtime adapter through configuration exactly as a local install would:
    // process-manager forwards bridge.runtime_adapter to the Bridge as
    // FLOE_RUNTIME_ADAPTER, which chooseAdapter() honours.
    this.cliConfig = {
      schema: "floe.local.v1",
      version: 1,
      home: this.temp,
      services: { autostart: false, manager: "auto" },
      bus: {
        listen: `127.0.0.1:${busPort}`,
        http_base_url: this.busUrl,
        ws_base_url: this.wsUrl,
        data_dir: "./bus",
        log_dir: "./logs/bus"
      },
      bridge: {
        data_dir: "./bridge",
        log_dir: "./logs/bridge",
        bus_url: this.wsUrl,
        workspace_access: { local_paths: true },
        runtime_adapter: this.tier.adapter
      },
      library: {
        configs_dir: "./configs",
        skills_dir: "./skills",
        extensions_dir: "./extensions",
        mcp_dir: "./mcp",
        templates_dir: "./templates"
      }
    } as LocalConfig;

    // Bring up Bus and Bridge through the exact product start sequence: the Bus
    // boots with the broker-owned host-control credential, and the Bridge with a
    // broker-minted service credential. No hand-made tokens, no in-process Bus.
    await startAll(this.configPath, this.cliConfig);

    this.hostControlToken = await fetchHostControlToken();

    this.busMessages = [];
    this.eventSocket = new (globalThis as any).WebSocket(`${this.wsUrl}/v1/events/stream`);
    this.eventSocket.addEventListener("open", () => {
      this.eventSocket.send(JSON.stringify({ type: "authenticate", bearer_token: this.hostControlToken }));
    });
    this.eventSocket.addEventListener("message", (event: any) => {
      this.busMessages.push(JSON.parse(String(event.data)));
    });
    await waitFor(() => this.busMessages.some((message) => message.type === "authenticated"), "bus event stream authentication");
  }

  async stop(): Promise<void> {
    this.eventSocket?.close();
    if (this.configPath && this.cliConfig) {
      stopService(this.configPath, this.cliConfig, "bridge");
      stopService(this.configPath, this.cliConfig, "bus");
    }
    delete process.env.FLOE_BUS_HTTP_BASE;
    if (this.temp) await removeTemp(this.temp);
  }

  sawBusEvents(types: string[]): boolean {
    return types.every((type) => this.busMessages.some((message) => message.type === type));
  }

  async runtimeResults(workspaceId: string, agentEndpointId: string): Promise<any[]> {
    const result = await this.get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    return result.events.filter((event) =>
      event.source_endpoint_id === agentEndpointId &&
      event.content?.data?.origin === "runtime_turn_result"
    );
  }

  /**
   * Register (and select) the local workspace through the native broker exactly
   * as `floe start` does, then open an operator operation session for it. The
   * session is the real workspace-scoped authority a client holds; the harness
   * uses it for every operator/workspace call so those calls are authenticated,
   * not bypassed.
   */
  async registerAndAuthorize(locator: string): Promise<string> {
    const { workspace_id } = await registerLocalWorkspaceViaBroker(locator, true);
    this.operationSessionBearer = await this.mintOperationSession(workspace_id);
    return workspace_id;
  }

  /**
   * Mint a workspace operation session over the Bus' host-control-authenticated
   * route — the same route the broker uses internally. The harness holds the
   * broker-owned host-control credential, so this is the genuine issuance path,
   * not a fabricated bearer.
   */
  async mintOperationSession(workspaceId: string): Promise<string> {
    const response = await fetch(
      `${this.busUrl}/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.hostControlToken}`
        },
        body: JSON.stringify({ expires_in_seconds: 3_600 })
      }
    );
    if (!response.ok) {
      throw new Error(`operation-session mint failed ${response.status}: ${await response.text()}`);
    }
    const issued = (await response.json()) as { bearer_token: string };
    return issued.bearer_token;
  }

  /**
   * Select the real broker-minted credential for a route by the authority class
   * the Bus enforces for it: host-control for native-owner bootstrap routes and
   * Bridge-only endpoint registration, and the operator operation session for
   * everything workspace-scoped.
   */
  private bearerFor(path: string): string {
    const route = path.split("?", 1)[0];
    if (
      route === "/v1/workspaces"
      || route.endsWith("/delete")
      || route === "/v1/runtime/bindings"
      || route === "/v1/endpoints/register"
    ) {
      return this.hostControlToken;
    }
    return this.operationSessionBearer;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.busUrl}${path}`, {
      headers: { authorization: `Bearer ${this.bearerFor(path)}` }
    });
    if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  async post<T = any>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.busUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.bearerFor(path)}`
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
}

export function fileExists(path: string): boolean {
  try {
    return readFileSync(path).length >= 0;
  } catch {
    return false;
  }
}

async function removeTemp(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

export async function waitFor<T>(check: () => Promise<T | false> | T | false, label: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
