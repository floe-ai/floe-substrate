/**
 * In-process MCP-over-HTTP server exposing Floe's substrate write-back tools
 * (`emit` / `request`) to the vendor CLI driven by floe-runtime.
 *
 * WHY HTTP, NOT STDIO: the ACP spec mandates stdio ("All Agents MUST support
 * connecting to MCP servers via stdio", agentclientprotocol.com session-setup),
 * but `copilot --acp` does NOT honour that MUST — its live `initialize` response
 * advertises only `mcpCapabilities: { http: true, sse: true }` and it silently
 * ignores stdio MCP server entries (verified live: a stdio server passed via
 * session/new is never spawned). copilot DOES connect over HTTP, which the spec
 * defines for `mcpCapabilities.http`. So Floe serves its substrate tools over an
 * in-process HTTP MCP endpoint that copilot connects to directly.
 *
 * The vendor CLI and its children hold NO Floe credential — that is the whole
 * reason floe-runtime replaces pi. This server runs INSIDE the authenticated
 * Bridge: it performs the real bus write anchored to the live runtime turn,
 * using the Bridge's own BusClient. The only secret copilot carries is a
 * per-session capability token (sent as an HTTP header) that authorises tool
 * forwarding for one session; it grants no bus authority by itself.
 *
 * Transport: a single localhost HTTP server (127.0.0.1, ephemeral port) speaking
 * the MCP Streamable HTTP protocol via the official SDK transport in stateless
 * mode. This is request/response IPC between two local processes, not polling.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { BusClient } from "../bus-client.js";
import { executeEmit, executeRequest, type EmittedEventSummary, type SubstrateTurnAnchor } from "../runtime-core/index.js";

/** Per-session hooks the Bridge registers so a tool call resolves to a turn. */
export type SubstrateSessionHandle = {
  /** Resolve the authenticated Bridge bus client at call time. */
  getBus: () => BusClient;
  /** The anchor for the currently-active turn, or null when none is running. */
  getAnchor: () => SubstrateTurnAnchor | null;
  /** Whether the active turn has already made its one allowed dependency request. */
  isDependencyRequested: () => boolean;
  /** Flip the active turn's dependency flag after an accepted request. */
  markDependencyRequested: () => void;
  /** Record an emitted-event summary on the active turn (for the work log). */
  recordEmitted: (summary: EmittedEventSummary) => void;
};

const IDENTITY = {
  runtimeName: "floe-runtime",
  emitOrigin: "floe_emit_tool",
  requestOrigin: "floe_request_tool",
} as const;

/** Header copilot echoes on every MCP request, carrying the session token. */
const SESSION_TOKEN_HEADER = "x-floe-session-token";

/** Path copilot connects to for the MCP Streamable HTTP endpoint. */
const MCP_PATH = "/mcp";

const EMIT_INPUT_SCHEMA = {
  type: z.string(),
  destination: z.string().describe("A neutral actor ref from list_endpoints, or 'current_context'."),
  text: z.string(),
  references: z.array(z.object({
    name: z.string().min(1).describe("Useful name shown on the Open button, such as Local preview approval."),
    resource_ref: z.object({
      kind: z.string().min(1),
      id: z.string().min(1),
      revision: z.union([z.string().min(1), z.null()]),
    }).describe("Exact resource reference returned by an operation. Do not infer kind or revision from an ID."),
  })).optional(),
  attachments: z.array(z.object({
    artefact_version_id: z.string().min(1).describe("Exact published ArtefactVersion to attach."),
    name: z.string().min(1).describe("Clear result name shown on the attachment button."),
  })).optional(),
  artefact_version_ids: z.array(z.string()).optional().describe("Additional exact published ArtefactVersion IDs without display names."),
  data: z.record(z.string(), z.unknown()).optional().describe("Optional structured Event data. Use only when a client or extension contract requires it."),
} as const;

const REQUEST_INPUT_SCHEMA = {
  actor: z.string().describe("A neutral actor ref from list_endpoints."),
  work: z.string().describe("The bounded work or question for that actor."),
  artefact_version_ids: z.array(z.string().min(1)).optional().describe("Exact published input versions for the actor to inspect with read_artefact."),
} as const;

const EMIT_DESCRIPTION =
  "Deliberately publish an event that should cause or communicate something beyond your local turn result. Use attachments for named, openable saved results and references for named links to records returned by discovered operations, such as a saved approval. A reference is navigation, not proof of approval or authority. The returned Event reference confirms acceptance and its exact attachments. Your normal final answer is already recorded in the current Context. Use 'current_context' as the destination only when you intentionally want Context subscription/effect semantics.";

const REQUEST_DESCRIPTION =
  "Ask one actor for work whose result you need before continuing. Attach the exact published ArtefactVersion IDs when the work concerns saved inputs. Floe stores the dependency, ends this processing cycle normally, and resumes you when that actor completes or fails. The return path is automatic.";

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export class SubstrateToolBridge {
  private server: Server | null = null;
  private port = 0;
  private startPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, SubstrateSessionHandle>();

  async ensureStarted(): Promise<void> {
    if (this.server) return;
    if (!this.startPromise) this.startPromise = this.start();
    await this.startPromise;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      server.on("error", reject);
      // Bind to loopback only; the port is ephemeral and never advertised off-host.
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  register(token: string, handle: SubstrateSessionHandle): void {
    this.sessions.set(token, handle);
  }

  unregister(token: string): void {
    this.sessions.delete(token);
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  /** URL copilot connects to as an HTTP MCP server. Valid only after ensureStarted(). */
  get mcpUrl(): string {
    return `http://127.0.0.1:${this.port}${MCP_PATH}`;
  }

  /** The header name copilot must send the per-session token in. */
  get sessionTokenHeader(): string {
    return SESSION_TOKEN_HEADER;
  }

  /**
   * Build a fresh MCP server whose emit/request tools re-enter the Bridge and
   * write to the bus anchored to `handle`'s currently-active turn. A new server
   * is built per request (stateless MCP mode); the handle is looked up per
   * request from the session token, so tools always target the live turn.
   */
  private buildMcpServer(handle: SubstrateSessionHandle): McpServer {
    const server = new McpServer({ name: "floe-substrate", version: "1.0.0" });

    server.registerTool(
      "emit",
      { title: "Emit Floe Event", description: EMIT_DESCRIPTION, inputSchema: EMIT_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const anchor = handle.getAnchor();
        if (!anchor) return errorResult("emit: no active Floe turn is running for this session.");
        try {
          const { result, emitted } = await executeEmit(handle.getBus(), anchor, params, IDENTITY);
          if (emitted) handle.recordEmitted(emitted);
          return { content: result.content };
        } catch (error) {
          return errorResult(`emit: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "request",
      { title: "Request Actor Work", description: REQUEST_DESCRIPTION, inputSchema: REQUEST_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const anchor = handle.getAnchor();
        if (!anchor) return errorResult("request: no active Floe turn is running for this session.");
        try {
          const { result, emitted, dependencyRequested } = await executeRequest(
            handle.getBus(), anchor, params, IDENTITY, handle.isDependencyRequested(),
          );
          if (dependencyRequested) handle.markDependencyRequested();
          if (emitted) handle.recordEmitted(emitted);
          return { content: result.content };
        } catch (error) {
          return errorResult(`request: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.url.startsWith(MCP_PATH)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const token = headerValue(req, SESSION_TOKEN_HEADER);
    const handle = token ? this.sessions.get(token) : undefined;
    if (!handle) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // Stateless MCP: one server + transport per request, torn down on close.
    const server = this.buildMcpServer(handle);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    this.sessions.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}
