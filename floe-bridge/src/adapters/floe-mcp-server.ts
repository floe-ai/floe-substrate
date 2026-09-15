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
import {
  executeEmit,
  executeRequest,
  executeDiscoverCapabilities,
  executeUseCapability,
  executeCreatePulse,
  executeListPulses,
  executePausePulse,
  executeResumePulse,
  executeCancelPulse,
  executeReadArtefact,
  type EmittedEventSummary,
  type SubstrateTurnAnchor,
  type OperationAuthorityTurn,
} from "../runtime-core/index.js";

/**
 * The live, mutable active turn the operation-authority tools (capability
 * invocation, pulses, artefact reads) need. It carries the Bus operation
 * scope (workspace/context) plus the mutable authority cache the helper reads
 * and refreshes. Unlike the emit/request anchor, this MUST be a stable
 * reference to the runtime's own turn object so the cached authority session
 * persists across tool calls within one turn.
 */
export type SubstrateActiveTurn = OperationAuthorityTurn & {
  workspace_id: string;
  context_id: string | null;
  /** Filesystem locator for workspace-persisted state (e.g. floe.yaml), or null. */
  workspace_locator: string | null;
};

/** Per-session hooks the Bridge registers so a tool call resolves to a turn. */
export type SubstrateSessionHandle = {
  /** Resolve the authenticated Bridge bus client at call time. */
  getBus: () => BusClient;
  /** The anchor for the currently-active turn, or null when none is running. */
  getAnchor: () => SubstrateTurnAnchor | null;
  /**
   * The live mutable active turn for operation-authority tools, or null when
   * none is running. Must be a stable reference so the authority cache persists.
   */
  getActiveTurn: () => SubstrateActiveTurn | null;
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

export const EMIT_INPUT_SCHEMA = {
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

export const REQUEST_INPUT_SCHEMA = {
  actor: z.string().describe("A neutral actor ref from list_endpoints."),
  work: z.string().describe("The bounded work or question for that actor."),
  artefact_version_ids: z.array(z.string().min(1)).optional().describe("Exact published input versions for the actor to inspect with read_artefact."),
} as const;

export const EMIT_DESCRIPTION =
  "Deliberately publish an event that should cause or communicate something beyond your local turn result. Use attachments for named, openable saved results and references for named links to records returned by discovered operations, such as a saved approval. A reference is navigation, not proof of approval or authority. The returned Event reference confirms acceptance and its exact attachments. Your normal final answer is already recorded in the current Context. Use 'current_context' as the destination only when you intentionally want Context subscription/effect semantics.";

export const REQUEST_DESCRIPTION =
  "Ask one actor for work whose result you need before continuing. Attach the exact published ArtefactVersion IDs when the work concerns saved inputs. Floe stores the dependency, ends this processing cycle normally, and resumes you when that actor completes or fails. The return path is automatic.";

const CAPABILITY_TARGET_SCHEMA = z.object({
  kind: z.string().min(1).describe("Canonical resource kind"),
  id: z.string().min(1).describe("Canonical resource id"),
});

export const DISCOVER_CAPABILITIES_INPUT_SCHEMA = {
  query: z.string().optional().describe("One or two specific keywords. Long sentences match unrelated operations."),
  operation_id: z.string().optional().describe("Exact operation_id from a search result; returns this operation's authoritative input contract."),
  include_result_schema: z.boolean().optional().describe("Include the selected operation's full result schema when building an integration. Ordinary invocation returns its result directly."),
  category: z.string().optional().describe("Optional category returned by an earlier discovery."),
  target: CAPABILITY_TARGET_SCHEMA.optional().describe("Optional selected resource used to evaluate target-specific availability. Omit until the operation's target kind is known from discovery."),
  limit: z.number().min(1).max(20).optional().describe("Maximum matching operations to return."),
} as const;

export const USE_CAPABILITY_INPUT_SCHEMA = {
  operation_id: z.string().min(1).describe("Exact operation_id returned by discover_capabilities."),
  operation_version: z.string().min(1).describe("Exact operation_version returned by discover_capabilities."),
  input_schema_version: z.string().min(1).describe("Exact input.version returned by discover_capabilities."),
  target: CAPABILITY_TARGET_SCHEMA.optional().describe("Target required by the discovered operation, when applicable."),
  expected_resource_revision: z.string().optional().describe("Exact target revision when the operation requires or accepts optimistic concurrency."),
  idempotency_key: z.string().optional().describe("Stable caller key. Reuse it after a timeout when the operation outcome is unknown."),
  input: z.record(z.string(), z.unknown()).describe("Input matching the exact discovered input.schema."),
} as const;

export const DISCOVER_CAPABILITIES_DESCRIPTION =
  "Find current Bus operations for a concrete need. Search returns short summaries. Pass an operation_id from a summary to load its exact input contract before using it. Reuse a discovered contract within this turn; rediscover after a version or authority refusal.";

export const USE_CAPABILITY_DESCRIPTION =
  "Invoke one Bus semantic operation using the exact operation and input-schema versions returned by discover_capabilities. Authority and causal provenance come from the active Delivery, not from this input.";

const PULSE_SUBSCRIBER_SCHEMA = z.union([
  z.object({
    kind: z.literal("context"),
    context_id: z.string().min(1).describe("Context that should render the pulse.fired event without waking an actor."),
  }),
  z.object({
    kind: z.literal("endpoint").optional(),
    endpoint_ref: z.string().min(1).describe("Neutral actor ref that should receive the pulse delivery as work."),
    context_id: z.string().min(1).optional().describe("Context associated with this endpoint delivery for reply/continuation."),
  }),
]);

const PULSE_CONTENT_SCHEMA = z.object({
  text: z.string().optional().describe("Text to render for context subscribers."),
  instructions: z.string().optional().describe("Instructions for endpoint subscribers to process when delivered."),
});

export const CREATE_PULSE_INPUT_SCHEMA = {
  pulse_id: z.string().min(1).describe("Unique pulse identifier within the workspace."),
  trigger: z.object({
    type: z.enum(["once", "cron"]).describe("'once' for a one-off scheduled pulse, 'cron' for a recurring one."),
    at: z.string().optional().describe("ISO 8601 timestamp for one-off pulses, or relative text like '30 seconds from now'."),
    after_seconds: z.number().optional().describe("Relative one-off delay in seconds. Use 30 for '30 seconds from now'."),
    schedule: z.string().optional().describe("Cron expression for recurring pulses."),
    timezone: z.string().optional().describe("IANA timezone (default: UTC)."),
  }).describe("When the pulse fires."),
  event: z.object({
    type: z.literal("pulse.fired"),
    content: PULSE_CONTENT_SCHEMA.optional(),
  }).optional().describe("The pulse.fired event content delivered to subscribers."),
  content: PULSE_CONTENT_SCHEMA.optional().describe("Alias for event.content; prefer event.content."),
  subscribers: z.array(PULSE_SUBSCRIBER_SCHEMA).describe("Who receives the pulse: context subscribers render it, endpoint subscribers act on it."),
  persistence: z.enum(["workspace", "local"]).optional().describe("'workspace' persists into committed floe.yaml; 'local' is runtime-backed (default)."),
  scope_id: z.string().optional().describe("Optional organising Scope id. Omit unless a Scope must own the pulse."),
} as const;

export const LIST_PULSES_INPUT_SCHEMA = {
  status: z.string().optional().describe("Filter by status: active, paused, cancelled, or fired."),
} as const;

export const PULSE_ID_INPUT_SCHEMA = {
  pulse_id: z.string().min(1).describe("The exact pulse identifier."),
} as const;

export const READ_ARTEFACT_INPUT_SCHEMA = {
  artefact_version_id: z.string().min(1).describe("Exact immutable ArtefactVersion identity to read."),
  offset: z.number().int().min(0).optional().describe("Text offset (UTF-16 units), starting at 0. Use the previous page's next_offset to continue."),
  limit: z.number().int().min(1).max(16_000).optional().describe("Maximum text units to return (default 16,000). Smaller for a focused inspection."),
} as const;

export const CREATE_PULSE_DESCRIPTION =
  "Create a scheduled pulse that fires canonical pulse.fired events to its subscribers. Use trigger.type 'once' with trigger.at (or trigger.after_seconds) for a one-off, or 'cron' with trigger.schedule for recurring. Use a context subscriber to render a reminder in a conversation; use an endpoint subscriber to wake an actor. Use persistence 'workspace' to persist into committed floe.yaml, or 'local' (default) for a runtime-backed pulse.";

export const LIST_PULSES_DESCRIPTION =
  "List pulses registered for this workspace. Optionally filter by status (active, paused, cancelled, fired).";

export const PAUSE_PULSE_DESCRIPTION = "Pause an active pulse. It stops firing until resumed.";
export const RESUME_PULSE_DESCRIPTION = "Resume a paused pulse. Cron pulses recompute their next fire from now.";
export const CANCEL_PULSE_DESCRIPTION = "Permanently cancel a pulse. This cannot be undone.";

export const READ_ARTEFACT_DESCRIPTION =
  "Read one exact ArtefactVersion shared into your work. Images enter your model context for visual inspection. Text returns a bounded page; use next_offset to read the remainder without rereading a mutable workspace file. Uses your active Delivery authority and verifies the saved content, up to 20MB.";

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

    server.registerTool(
      "discover_capabilities",
      { title: "Discover Capabilities", description: DISCOVER_CAPABILITIES_DESCRIPTION, inputSchema: DISCOVER_CAPABILITIES_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const turn = handle.getActiveTurn();
        if (!turn) return errorResult("discover_capabilities: no active Floe turn is running for this session.");
        try {
          const result = await executeDiscoverCapabilities(handle.getBus(), turn.workspace_id, turn, params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`discover_capabilities: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "use_capability",
      { title: "Use Capability", description: USE_CAPABILITY_DESCRIPTION, inputSchema: USE_CAPABILITY_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const turn = handle.getActiveTurn();
        if (!turn) return errorResult("use_capability: no active Floe turn is running for this session.");
        try {
          const result = await executeUseCapability(handle.getBus(), turn.workspace_id, turn, params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`use_capability: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "create_pulse",
      { title: "Create Pulse", description: CREATE_PULSE_DESCRIPTION, inputSchema: CREATE_PULSE_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const turn = handle.getActiveTurn();
        if (!turn) return errorResult("create_pulse: no active Floe turn is running for this session.");
        try {
          const result = await executeCreatePulse(handle.getBus(), turn, params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`create_pulse: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "list_pulses",
      { title: "List Pulses", description: LIST_PULSES_DESCRIPTION, inputSchema: LIST_PULSES_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const turn = handle.getActiveTurn();
        if (!turn) return errorResult("list_pulses: no active Floe turn is running for this session.");
        try {
          const result = await executeListPulses(handle.getBus(), turn, params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`list_pulses: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "pause_pulse",
      { title: "Pause Pulse", description: PAUSE_PULSE_DESCRIPTION, inputSchema: PULSE_ID_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        if (!handle.getActiveTurn()) return errorResult("pause_pulse: no active Floe turn is running for this session.");
        try {
          const result = await executePausePulse(handle.getBus(), params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`pause_pulse: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "resume_pulse",
      { title: "Resume Pulse", description: RESUME_PULSE_DESCRIPTION, inputSchema: PULSE_ID_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        if (!handle.getActiveTurn()) return errorResult("resume_pulse: no active Floe turn is running for this session.");
        try {
          const result = await executeResumePulse(handle.getBus(), params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`resume_pulse: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "cancel_pulse",
      { title: "Cancel Pulse", description: CANCEL_PULSE_DESCRIPTION, inputSchema: PULSE_ID_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        if (!handle.getActiveTurn()) return errorResult("cancel_pulse: no active Floe turn is running for this session.");
        try {
          const result = await executeCancelPulse(handle.getBus(), params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`cancel_pulse: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );

    server.registerTool(
      "read_artefact",
      { title: "Read Shared Content", description: READ_ARTEFACT_DESCRIPTION, inputSchema: READ_ARTEFACT_INPUT_SCHEMA },
      async (params: Record<string, unknown>) => {
        const turn = handle.getActiveTurn();
        if (!turn) return errorResult("read_artefact: no active Floe turn is running for this session.");
        try {
          const result = await executeReadArtefact(handle.getBus(), turn, params);
          return { content: result.content };
        } catch (error) {
          return errorResult(`read_artefact: ${error instanceof Error ? error.message : String(error)}`);
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
