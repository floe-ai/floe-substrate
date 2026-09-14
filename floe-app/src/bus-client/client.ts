/**
 * Bus client — the ONLY substrate seam for floe-app.
 * All bus communication goes through these functions.
 * Base URL: http://127.0.0.1:5377
 */
import type {
  WorkspaceRef,
  ScopeRef,
  ScopeComposition,
  ScopeCompositionRevisionPage,
  ScopeExecutionPage,
  ScopeExecutionRecord,
  ScopeExecutionProjection,
  SemanticOperationDescriptor,
  OperationInvocationRequest,
  OperationInvocationReceipt,
  OperationInvocationResponse,
  ScopeProjection,
  ScopeProjectionLayout,
  ContextRef,
  EventEnvelope,
  EventTrace,
  EndpointRef,
  PendingResponse,
  PulseRef,
  PulseSubscriber,
  CreatePulseInput,
  Watermark,
  EmitInput,
  StreamMsg,
  DeliveryRow,
  DeliveryBundle,
  TelemetryRow,
  ContextDiagnosticEvidence,
  RuntimeBindingRecord,
  RuntimeBindingScope,
  RuntimeBindingResolution,
  AuthProfileRecord,
  AuthModelRecord,
  SavedConfigRow,
  RuntimeStatus,
  LocalConfigStatus,
  ResolvedEndpoint,
} from "./types.ts";
import { subscribeEvents as _subscribeEvents } from "./stream.ts";
import { FloeHttpError } from "../runtime/startup.ts";
import { getBrowserSession } from "./browser.ts";
import {
  busFetch,
  confirmAndInvokeHostOperation as confirmAndInvokeHostOperationTransport,
  confirmAndInvokeOperation as confirmAndInvokeOperationTransport,
  discoverHostOperations as discoverHostOperationsTransport,
  invokeHostOperation as invokeHostOperationTransport,
  isNativeFloeApp,
  localRuntimeStatusFetch,
  localWorkspaceBindingsFetch,
  workspaceMediaObjectUrl,
} from "./transport.ts";
const BUS_MUTATION_TIMEOUT_MS = 5_000;

async function get<T>(path: string, signal?: AbortSignal, workspaceId?: string): Promise<T> {
  const res = await busFetch(path, { signal }, workspaceId);
  if (!res.ok) throw new FloeHttpError(res.status, path);
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await busFetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bus PUT ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown, workspaceId?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUS_MUTATION_TIMEOUT_MS);
  let res: Response;
  try {
    res = await busFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, workspaceId);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Floe's local service stopped responding. Close and reopen Floe, then try again.", { cause: error });
    }
    throw new Error("Floe's local service is unavailable. Close and reopen Floe, then try again.", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Bus POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await busFetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bus PATCH ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await busFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(`Bus DELETE ${path} → ${res.status}`);
  // 204 No Content has no body
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export async function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceRef[]> {
  const response = await localWorkspaceBindingsFetch({ path: "/v1/local/workspaces", init: { signal } });
  if (!response.ok) throw new FloeHttpError(response.status, "/v1/local/workspaces");
  const data = await response.json() as { workspaces: WorkspaceRef[] };
  return data.workspaces;
}

export class DirectoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryNotFoundError";
  }
}

export class SemanticOperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly refusal?: { required_action?: { title?: string; description?: string } | null },
  ) {
    super(message);
    this.name = "SemanticOperationError";
  }
}

/** Discover host-bound actions from the same Bus contract used by Actors. */
export async function listHostOperations(
  query?: string,
  target?: { kind: string; id: string },
): Promise<SemanticOperationDescriptor[]> {
  const response = await discoverHostOperationsTransport(query, target);
  if (!response.ok) throw new Error(`Floe could not load actions for this computer (HTTP ${response.status}).`);
  const data = await response.json() as { operations: SemanticOperationDescriptor[] };
  return data.operations;
}

/** Invoke one host operation only after its Bus-owned native confirmation. */
export async function confirmAndInvokeHostOperation(
  request: OperationInvocationRequest,
): Promise<{ confirmed: false } | { confirmed: true; receipt: OperationInvocationReceipt }> {
  const result = await confirmAndInvokeHostOperationTransport(request);
  if (!result.confirmed) return { confirmed: false };
  if (!result.response) {
    throw new Error("Floe did not receive a result for the confirmed action.");
  }
  if (!result.response.ok) {
    throw new Error(`Bus confirmed host operation → ${result.response.status}`);
  }
  return {
    confirmed: true,
    receipt: receiptFromOperationResponse(await result.response.json() as OperationInvocationResponse),
  };
}

/** Invoke an exact host-bound descriptor. Authority is supplied by the desktop broker. */
export async function invokeHostOperation(
  request: OperationInvocationRequest,
): Promise<OperationInvocationReceipt> {
  const response = await invokeHostOperationTransport(request);
  if (!response.ok) throw new Error(`Bus POST /v1/local/operations/invoke → ${response.status}`);
  return receiptFromOperationResponse(await response.json() as OperationInvocationResponse);
}

/** Register a host-local Workspace through the discovered host operation. */
export async function registerWorkspace(input: {
  locator: string;
  name?: string;
  init_authorized?: boolean;
  create_directory?: boolean;
}): Promise<WorkspaceRef> {
  const operation = (await listHostOperations("register workspace"))
    .find((candidate) => candidate.operation_id === "workspace.register");
  if (!operation) {
    throw new SemanticOperationError(
      "This Floe installation cannot add a Workspace yet.",
      "workspace_register_unavailable",
    );
  }
  if (!operation.availability.available) {
    throw new SemanticOperationError(
      operation.availability.refusal.message,
      operation.availability.refusal.code,
      operation.availability.refusal,
    );
  }
  const receipt = await invokeHostOperation({
    operation_id: operation.operation_id,
    operation_version: operation.operation_version,
    input_schema_version: operation.input.version,
    idempotency_key: createClientIdempotencyKey("workspace-register"),
    input,
  });
  if (receipt.refusal?.code === "workspace_directory_not_found") {
    throw new DirectoryNotFoundError(receipt.refusal.message);
  }
  if (receipt.refusal) {
    throw new SemanticOperationError(receipt.refusal.message, receipt.refusal.code, receipt.refusal);
  }
  const workspaceId = (receipt.result as { workspace?: { workspace_id?: unknown } } | null)
    ?.workspace?.workspace_id;
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new SemanticOperationError(
      "Floe added the Workspace but did not return its identity.",
      "workspace_register_result_invalid",
    );
  }
  const localProjection = (await listWorkspaces()).find((workspace) => workspace.workspace_id === workspaceId);
  if (!localProjection) {
    throw new SemanticOperationError(
      "Floe added the Workspace but its local folder is not available on this computer.",
      "workspace_binding_unavailable",
    );
  }
  return localProjection;
}

/** POST /v1/workspaces/:id/select — mark a workspace as selected */
export async function selectWorkspace(ws: string): Promise<WorkspaceRef> {
  if (isNativeFloeApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const response = await invoke<{ status: number; body: string }>("select_workspace", { workspaceId: ws });
    if (response.status !== 200) throw new FloeHttpError(response.status, `/v1/workspaces/${ws}/select`);
    return (JSON.parse(response.body) as { workspace: WorkspaceRef }).workspace;
  }
  const data = await post<{ workspace: WorkspaceRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/select`,
    {},
  );
  return data.workspace;
}

/** POST /v1/workspaces/:id/delete — remove a workspace (and optionally its locator) */
export async function deleteWorkspace(
  ws: string,
  options?: { delete_locator?: boolean }
): Promise<{ ok: true; workspace_id: string; locator_deleted: boolean }> {
  if (isNativeFloeApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const response = await invoke<{ status: number; body: string }>("delete_workspace", {
      workspaceId: ws,
      deleteLocator: options?.delete_locator ?? false,
    });
    if (response.status !== 200) throw new FloeHttpError(response.status, `/v1/workspaces/${ws}/delete`);
    return JSON.parse(response.body) as { ok: true; workspace_id: string; locator_deleted: boolean };
  }
  return post(
    `/v1/workspaces/${encodeURIComponent(ws)}/delete`,
    options ?? {},
  );
}

/** GET /v1/workspaces/:id/config-status — workspace config/attachment status */
export async function getWorkspaceConfigStatus(ws: string): Promise<WorkspaceRef> {
  const data = await get<{ workspace: WorkspaceRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/config-status`
  );
  return data.workspace;
}

// ---------------------------------------------------------------------------
// Workspace filesystem (remote/bus-backed — see floe-app/src/fs/workspaceFs.ts)
// ---------------------------------------------------------------------------
// Plain HTTP direct disk I/O served by the bus on the box, for when the
// console is not co-located with workspace files (e.g. console tunneled
// into a remote substrate). Gated server-side on workspace_access.local_paths.

/** GET /v1/fs/capability — cheap probe for whether the bus can serve workspace files. */
export async function busFsCapability(): Promise<{ local_paths: boolean }> {
  return get("/v1/fs/capability");
}

/** GET /v1/fs/browse?path=... — directory browser for the register-workspace folder picker. */
export async function busBrowseDir(path?: string): Promise<{
  path: string;
  parent: string | null;
  entries: { name: string; is_dir: boolean }[];
}> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return get(`/v1/fs/browse${qs}`);
}

/** GET /v1/workspaces/:id/fs/agents — list `.floe/agents/**\/*.md` files, workspace-root-relative. */
export async function busListAgentFiles(workspaceId: string): Promise<string[]> {
  const data = await get<{ files: string[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/agents`);
  return data.files;
}

/** GET /v1/workspaces/:id/fs/file?path=... — read a UTF-8 text file under the workspace root. */
export async function busReadFile(workspaceId: string, relPath: string): Promise<string> {
  const data = await get<{ contents: string }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/file?path=${encodeURIComponent(relPath)}`
  );
  return data.contents;
}

/** Authenticated Workspace image preview exposed as a revocable object URL. */
export function busWorkspaceMediaSource(workspaceId: string, relPath: string): Promise<string> {
  return workspaceMediaObjectUrl(workspaceId, relPath);
}

/** PUT /v1/workspaces/:id/fs/file — write a file under the workspace root, creating parent dirs as needed. */
export async function busWriteFile(workspaceId: string, relPath: string, contents: string): Promise<void> {
  await put(`/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/file`, { path: relPath, contents });
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export async function listScopes(ws: string): Promise<ScopeRef[]> {
  const data = await get<{ scopes: ScopeRef[] }>(`/v1/workspaces/${encodeURIComponent(ws)}/scopes`);
  return data.scopes;
}

export async function listScopeCompositions(ws: string, scope: string): Promise<ScopeComposition[]> {
  const data = await get<{ graphs: ScopeComposition[] }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/graphs`
  );
  return data.graphs;
}

/** Current and retained canonical Scope plan revisions. */
export async function listScopeCompositionRevisions(
  ws: string,
  scope: string,
): Promise<ScopeCompositionRevisionPage> {
  return get<ScopeCompositionRevisionPage>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/compositions`,
  );
}

/** Bounded canonical executions of one Scope, newest first. */
export async function listScopeExecutions(
  ws: string,
  scope: string,
  options: { limit?: number; before?: string } = {},
): Promise<ScopeExecutionPage> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.before) params.set("before", options.before);
  const query = params.toString();
  return get<ScopeExecutionPage>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/executions${query ? `?${query}` : ""}`,
  );
}

/** Exact execution evidence pinned to the plan revision it used. */
export async function getScopeExecutionProjection(
  ws: string,
  executionId: string,
): Promise<ScopeExecutionProjection> {
  const data = await get<{ projection?: ScopeExecutionProjection } & Partial<ScopeExecutionProjection>>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scope-executions/${encodeURIComponent(executionId)}`,
  );
  return data.projection ?? data as ScopeExecutionProjection;
}

/** Executions explicitly caused by one conversation Event. Context membership is not routing. */
export async function listContextScopeExecutions(
  ws: string,
  contextId: string,
): Promise<ScopeExecutionRecord[]> {
  const data = await get<{ executions: ScopeExecutionRecord[] }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts/${encodeURIComponent(contextId)}/scope-executions`,
  );
  return data.executions;
}

/** Discover the shared operation contract in the authority of an authenticated app session. */
export async function listOperations(
  ws: string,
  target?: { kind: string; id: string },
): Promise<SemanticOperationDescriptor[]> {
  const params = new URLSearchParams();
  if (target) {
    params.set("target_kind", target.kind);
    params.set("target_id", target.id);
  }
  const query = params.toString();
  const res = await busFetch(
    `/v1/workspaces/${encodeURIComponent(ws)}/operations${query ? `?${query}` : ""}`,
    {},
    ws,
  );
  if (!res.ok) throw new Error(`Bus GET operations → ${res.status}`);
  const data = await res.json() as { operations: SemanticOperationDescriptor[] };
  return data.operations;
}

/** Read canonical completion after an asynchronous operation returned a receipt. */
export async function getOperationReceipt(ws: string, receiptId: string): Promise<OperationInvocationReceipt> {
  const response = await get<{ receipt: OperationInvocationReceipt }>(`/v1/workspaces/${encodeURIComponent(ws)}/operation-receipts/${encodeURIComponent(receiptId)}`, undefined, ws);
  return response.receipt;
}

/** Invoke the exact descriptor returned by listOperations. Authority never travels in the body. */
export async function invokeOperation(
  ws: string,
  request: OperationInvocationRequest,
): Promise<OperationInvocationReceipt> {
  const data = await post<OperationInvocationResponse>(
    `/v1/workspaces/${encodeURIComponent(ws)}/operations/invoke`,
    request,
  );
  return receiptFromOperationResponse(data);
}

/** Invoke one confirmed operation through the native, non-reusable trust boundary. */
export async function confirmAndInvokeOperation(
  ws: string,
  request: OperationInvocationRequest,
): Promise<{ confirmed: false } | { confirmed: true; receipt: OperationInvocationReceipt }> {
  const result = await confirmAndInvokeOperationTransport(ws, request);
  if (!result.confirmed) return { confirmed: false };
  if (!result.response) {
    throw new Error("Floe did not receive a result for the confirmed action.");
  }
  if (!result.response.ok) {
    throw new Error(`Bus confirmed operation → ${result.response.status}`);
  }
  return {
    confirmed: true,
    receipt: receiptFromOperationResponse(await result.response.json() as OperationInvocationResponse),
  };
}

function receiptFromOperationResponse(response: OperationInvocationResponse): OperationInvocationReceipt {
  if (response.kind === "receipt") return response.receipt;
  if (response.kind === "conflict") {
    throw new SemanticOperationError(response.refusal.message, response.refusal.code, response.refusal);
  }
  throw new SemanticOperationError(response.refusal.message, response.refusal.code, response.refusal);
}

function createClientIdempotencyKey(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

export async function getScopeProjection(ws: string, scope: string): Promise<ScopeProjection> {
  const data = await get<{ projection: ScopeProjection }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/projection`
  );
  return data.projection;
}

export async function getScopeProjectionLayout(ws: string, scope: string, renderer: string): Promise<ScopeProjectionLayout | null> {
  try {
    const data = await get<{ layout: ScopeProjectionLayout }>(
      `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/projection/layout/${encodeURIComponent(renderer)}`
    );
    return data.layout;
  } catch {
    return null;
  }
}

/** POST /v1/workspaces/:ws/scopes — create a new scope */
export async function createScope(
  ws: string,
  input: { scope_id?: string; title: string; description?: string | null }
): Promise<ScopeRef> {
  const operation = (await listOperations(ws)).find(item => item.operation_id === "scope.create");
  if (!operation) throw new Error("This Floe installation cannot create a Scope yet.");
  if (!operation.availability.available) throw new Error(operation.availability.refusal.message);
  const receipt = await invokeOperation(ws, {
    operation_id: operation.operation_id, operation_version: operation.operation_version,
    input_schema_version: operation.input.version, input, idempotency_key: createClientIdempotencyKey("scope-create"),
  });
  if (receipt.refusal) throw new SemanticOperationError(receipt.refusal.message, receipt.refusal.code, receipt.refusal);
  if (receipt.state !== "completed" || !receipt.result) throw new Error("Floe has not confirmed the Scope. Refresh its saved state before retrying.");
  return (receipt.result as { scope: ScopeRef }).scope;
}

/** PATCH /v1/workspaces/:ws/scopes/:scope — update scope title/description */
export async function updateScope(
  ws: string,
  scope: string,
  input: { title?: string; description?: string | null }
): Promise<ScopeRef> {
  const data = await patch<{ scope: ScopeRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}`,
    input
  );
  return data.scope;
}

/** Stop a Scope without deleting its durable Context or Event history. */
export async function retireScope(ws: string, scope: string): Promise<{
  status: "retired";
  cancelled_delivery_count: number;
  cancelled_queue_count: number;
  cancelled_pulse_count: number;
}> {
  return post(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/retire`,
    {},
  );
}

/** Structured error thrown when deleteScope fails because scope is non-empty */
export class ScopeNotEmptyError extends Error {
  readonly context_count: number;
  readonly pulse_count: number;
  constructor(context_count: number, pulse_count: number) {
    super(`scope_not_empty: ${context_count} context(s), ${pulse_count} pulse(s)`);
    this.name = "ScopeNotEmptyError";
    this.context_count = context_count;
    this.pulse_count = pulse_count;
  }
}

/** DELETE /v1/workspaces/:ws/scopes/:scope — delete an empty scope.
 *  Throws ScopeNotEmptyError on HTTP 409 scope_not_empty. */
export async function deleteScope(ws: string, scope: string): Promise<void> {
  const res = await busFetch(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}`,
    { method: "DELETE" }
  );
  if (res.status === 409) {
    const body = await res.json() as { error?: string; context_count?: number; pulse_count?: number };
    if (body.error === "scope_not_empty") {
      throw new ScopeNotEmptyError(body.context_count ?? 0, body.pulse_count ?? 0);
    }
    throw new Error(`Bus DELETE scopes/${scope} → 409: ${JSON.stringify(body)}`);
  }
  if (!res.ok) throw new Error(`Bus DELETE scopes/${scope} → ${res.status}`);
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

export async function listContexts(ws: string, options?: {
  scope?: "all" | "scoped" | "unscoped";
  limit?: number;
  before?: string;
}): Promise<ContextRef[]> {
  const params = new URLSearchParams();
  if (options?.scope) params.set("scope", options.scope);
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.before) params.set("before", options.before);
  const qs = params.toString();
  const data = await get<{ contexts: ContextRef[] }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts${qs ? `?${qs}` : ""}`
  );
  return data.contexts;
}

export async function listContextsPage(ws: string, options?: {
  scope?: "all" | "scoped" | "unscoped";
  limit?: number;
  before?: string;
}): Promise<{ contexts: ContextRef[]; next_cursor: string | null }> {
  const params = new URLSearchParams();
  if (options?.scope) params.set("scope", options.scope);
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.before) params.set("before", options.before);
  const qs = params.toString();
  return get<{ contexts: ContextRef[]; next_cursor: string | null }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts${qs ? `?${qs}` : ""}`
  );
}

/** GET /v1/contexts?participant=...&workspace_id=...&scope_id=... — list contexts by participant */
export async function listContextsByParticipant(q: {
  participant: string;
  workspace_id?: string;
  scope_id?: string;
  limit?: number;
  before?: string;
}): Promise<ContextRef[]> {
  const params = new URLSearchParams({ participant: q.participant });
  if (q.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q.scope_id) params.set("scope_id", q.scope_id);
  if (q.limit != null) params.set("limit", String(q.limit));
  if (q.before) params.set("before", q.before);
  const data = await get<{ contexts: ContextRef[] }>(`/v1/contexts?${params.toString()}`);
  return data.contexts;
}

export async function listContextsByParticipantPage(q: {
  participant: string;
  workspace_id?: string;
  scope_id?: string;
  limit?: number;
  before?: string;
}): Promise<{ contexts: ContextRef[]; next_cursor: string | null }> {
  const params = new URLSearchParams({ participant: q.participant });
  if (q.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q.scope_id) params.set("scope_id", q.scope_id);
  if (q.limit != null) params.set("limit", String(q.limit));
  if (q.before) params.set("before", q.before);
  return get<{ contexts: ContextRef[]; next_cursor: string | null }>(`/v1/contexts?${params.toString()}`);
}

export async function getContext(id: string, workspaceId?: string): Promise<ContextRef> {
  return get<ContextRef>(`/v1/contexts/${encodeURIComponent(id)}`, undefined, workspaceId);
}

export async function listContextTree(id: string, limit = 200, workspaceId?: string): Promise<{
  contexts: ContextRef[];
  truncated: boolean;
}> {
  return get(`/v1/contexts/${encodeURIComponent(id)}/tree?limit=${encodeURIComponent(String(limit))}`, undefined, workspaceId);
}

/** POST /v1/contexts/:id/participants — idempotently add an endpoint as participant */
export async function addContextParticipant(
  contextId: string,
  endpointId: string,
  workspaceId?: string,
): Promise<{ ok: boolean }> {
  return post(`/v1/contexts/${encodeURIComponent(contextId)}/participants`, {
    endpoint_id: endpointId,
  }, workspaceId);
}

export async function listContextEvents(id: string, options?: { limit?: number; all?: boolean; workspace_id?: string }): Promise<EventEnvelope[]> {
  if (options?.all) {
    const events: EventEnvelope[] = [];
    let since: string | undefined;
    const pageSize = 500;
    while (true) {
      const page = await listEvents({ context_id: id, workspace_id: options.workspace_id, since, limit: pageSize });
      events.push(...page.events);
      if (page.events.length < pageSize || !page.next_cursor || page.next_cursor === since) break;
      since = page.next_cursor;
    }
    return events;
  }
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  const qs = params.toString();
  const data = await get<{ events: EventEnvelope[] }>(
    `/v1/contexts/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`,
    undefined,
    options?.workspace_id,
  );
  return data.events;
}

export type ContextEventHistoryPage = {
  events: EventEnvelope[];
  previous_cursor: string | null;
};

/** Read one chronological page from the newest end of a Context. */
export async function listContextEventHistoryPage(
  id: string,
  options?: { before?: string; limit?: number; type?: string; workspace_id?: string },
): Promise<ContextEventHistoryPage> {
  const page = await listEvents({
    context_id: id,
    workspace_id: options?.workspace_id,
    type: options?.type,
    before: options?.before,
    direction: "backward",
    limit: options?.limit,
  });
  return { events: page.events, previous_cursor: page.previous_cursor ?? null };
}

/** POST /v1/workspaces/:ws/contexts — create a workspace-level context with the given participants */
export async function createDirectContext(
  ws: string,
  input: { participants: string[]; context_id?: string; created_by_endpoint_id?: string | null }
): Promise<ContextRef> {
  const data = await post<{ context: ContextRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts`,
    input
  );
  return data.context;
}

/**
 * POST /v1/workspaces/:ws/contexts — create a scoped context (card-as-context).
 * Accepts scope_id and optional title; participants may be empty when scope_id is set.
 */
export async function createContext(
  ws: string,
  input: {
    participants?: string[];
    scope_id?: string | null;
    context_id?: string;
    created_by_endpoint_id?: string | null;
    title?: string | null;
  }
): Promise<ContextRef> {
  const data = await post<{ context: ContextRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts`,
    input
  );
  return data.context;
}

/**
 * GET /v1/workspaces/:ws/contexts?scope_id=... — list contexts belonging to a specific scope.
 * Uses the server-side indexed query (no client-side filtering required).
 */
export async function listContextsForScope(ws: string, scopeId: string): Promise<ContextRef[]> {
  const data = await get<{ contexts: ContextRef[] }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts?scope_id=${encodeURIComponent(scopeId)}`
  );
  return data.contexts;
}

/** POST /v1/workspaces/:ws/contexts/:id/assign-scope */
export async function assignContextScope(
  ws: string,
  contextId: string,
  input: { scope_id: string; assigned_by?: string | null; reason?: string | null }
): Promise<{ ok: true; context: ContextRef; audit_event: EventEnvelope }> {
  return post(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts/${encodeURIComponent(contextId)}/assign-scope`,
    input
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function listEvents(q: {
  workspace_id?: string;
  scope_id?: string;
  context_id?: string;
  thread_id?: string;
  type?: string;
  since?: string;
  before?: string;
  direction?: "forward" | "backward";
  limit?: number;
}): Promise<{ events: EventEnvelope[]; next_cursor: string | null; previous_cursor?: string | null }> {
  const params = new URLSearchParams();
  if (q.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q.scope_id) params.set("scope_id", q.scope_id);
  if (q.context_id) params.set("context_id", q.context_id);
  if (q.thread_id) params.set("thread_id", q.thread_id);
  if (q.type) params.set("type", q.type);
  if (q.since) params.set("since", q.since);
  if (q.before) params.set("before", q.before);
  if (q.direction) params.set("direction", q.direction);
  if (q.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  return get<{ events: EventEnvelope[]; next_cursor: string | null; previous_cursor?: string | null }>(`/v1/events${qs ? `?${qs}` : ""}`, undefined, q.workspace_id);
}

export async function getEventTrace(eventId: string): Promise<EventTrace> {
  return get<EventTrace>(`/v1/events/${encodeURIComponent(eventId)}/trace`);
}

/** POST /v1/events/emit */
export async function emit(event: EmitInput): Promise<EventEnvelope> {
  const data = await post<{ event: EventEnvelope }>("/v1/events/emit", event, event.workspace_id);
  return data.event;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** POST /v1/endpoints/register — register (create or upsert) an endpoint/actor */
export async function registerEndpoint(input: {
  endpoint_id: string;
  workspace_id: string;
  name: string;
  agent_id?: string | null;
  bridge_id?: string | null;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<EndpointRef> {
  const data = await post<{ endpoint: EndpointRef }>("/v1/endpoints/register", input, input.workspace_id);
  return data.endpoint;
}

/** DELETE /v1/endpoints/:id — delete an endpoint/actor and its pending deliveries */
export async function deleteEndpoint(endpointId: string): Promise<{ ok: true; endpoint_id: string }> {
  return del(`/v1/endpoints/${encodeURIComponent(endpointId)}`);
}

/** GET /v1/endpoints?workspace_id=... — list endpoints; workspace_id is optional */
export async function listEndpointsGlobal(workspace_id?: string): Promise<EndpointRef[]> {
  const qs = workspace_id ? `?workspace_id=${encodeURIComponent(workspace_id)}` : "";
  const data = await get<{ endpoints: EndpointRef[] }>(`/v1/endpoints${qs}`);
  return data.endpoints;
}

/** GET /v1/workspaces/:ws/endpoints — list endpoints for a specific workspace */
export async function listEndpoints(ws: string): Promise<EndpointRef[]> {
  const data = await get<{ endpoints: EndpointRef[] }>(`/v1/workspaces/${encodeURIComponent(ws)}/endpoints`);
  return data.endpoints;
}

/** GET /v1/workspaces/:ws/resolve-endpoint?ref=... */
export async function resolveEndpoint(ws: string, ref: string): Promise<ResolvedEndpoint> {
  return get<ResolvedEndpoint>(
    `/v1/workspaces/${encodeURIComponent(ws)}/resolve-endpoint?ref=${encodeURIComponent(ref)}`
  );
}

/** POST /v1/endpoints/:id/status — set endpoint status */
export async function setEndpointStatus(endpointId: string, status: string): Promise<EndpointRef> {
  const data = await post<{ endpoint: EndpointRef }>(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/status`,
    { status }
  );
  return data.endpoint;
}

/** POST /v1/endpoints/:id/turn-end — signal that the endpoint's turn has ended */
export async function reportTurnEnd(endpointId: string): Promise<EndpointRef> {
  const data = await post<{ endpoint: EndpointRef }>(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/turn-end`,
    {}
  );
  return data.endpoint;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** Context filtering includes explicitly requested work, with active responses first. */
export async function listDeliveries(q?: {
  workspace_id?: string;
  context_id?: string;
  limit?: number;
}): Promise<DeliveryRow[]> {
  const params = new URLSearchParams();
  if (q?.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q?.context_id) params.set("context_id", q.context_id);
  if (q?.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  const data = await get<{ deliveries: DeliveryRow[] }>(`/v1/delivery${qs ? `?${qs}` : ""}`);
  return data.deliveries;
}

/**
 * GET /v1/delivery/claim?bridge_id=...&limit=...
 *
 * CONSUMING OPERATION: claiming a delivery transitions it to `delivered_to_bridge`.
 * Only call this from bridge-equivalent code; do not use for read-only UI display.
 */
export async function claimDelivery(bridgeId: string, limit?: number): Promise<DeliveryBundle[]> {
  const params = new URLSearchParams({ bridge_id: bridgeId });
  if (limit != null) params.set("limit", String(limit));
  const data = await get<{ deliveries: DeliveryBundle[] }>(`/v1/delivery/claim?${params.toString()}`);
  return data.deliveries;
}

/** POST /v1/delivery/:id/status — report delivery state transition */
export async function setDeliveryStatus(
  deliveryId: string,
  input: {
    bridge_id: string;
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered" | "deferred";
    error?: string | null;
  }
): Promise<DeliveryRow> {
  const data = await post<{ delivery: DeliveryRow }>(
    `/v1/delivery/${encodeURIComponent(deliveryId)}/status`,
    input
  );
  return data.delivery;
}

// ---------------------------------------------------------------------------
// Pulses
// ---------------------------------------------------------------------------

/** GET /v1/pulses?workspace_id=... — list pulses for a workspace */
export async function listPulses(ws: string): Promise<PulseRef[]> {
  const data = await get<{ pulses: PulseRef[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(ws)}`);
  return data.pulses;
}

/** GET /v1/pulses — list pulses with optional filters (workspace, status, scope) */
export async function queryPulses(q?: {
  workspace_id?: string;
  status?: string;
  scope_id?: string;
}): Promise<PulseRef[]> {
  const params = new URLSearchParams();
  if (q?.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q?.status) params.set("status", q.status);
  if (q?.scope_id) params.set("scope_id", q.scope_id);
  const qs = params.toString();
  const data = await get<{ pulses: PulseRef[] }>(`/v1/pulses${qs ? `?${qs}` : ""}`);
  return data.pulses;
}

/** POST /v1/pulses — create a new pulse */
export async function createPulse(input: CreatePulseInput): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>("/v1/pulses", input);
  return data.pulse;
}

/** POST /v1/pulses/:id/pause */
export async function pausePulse(pulseId: string): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>(
    `/v1/pulses/${encodeURIComponent(pulseId)}/pause`,
    {}
  );
  return data.pulse;
}

/** POST /v1/pulses/:id/resume */
export async function resumePulse(pulseId: string): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>(
    `/v1/pulses/${encodeURIComponent(pulseId)}/resume`,
    {}
  );
  return data.pulse;
}

/** POST /v1/pulses/:id/cancel */
export async function cancelPulse(pulseId: string): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>(
    `/v1/pulses/${encodeURIComponent(pulseId)}/cancel`,
    {}
  );
  return data.pulse;
}

/** POST /v1/pulses/:id/subscribe */
export async function subscribePulse(pulseId: string, subscriber: PulseSubscriber): Promise<{ ok: true; pulse: PulseRef }> {
  return post(`/v1/pulses/${encodeURIComponent(pulseId)}/subscribe`, subscriber);
}

/** POST /v1/pulses/:id/unsubscribe */
export async function unsubscribePulse(pulseId: string, subscriber: PulseSubscriber): Promise<{ ok: true; pulse: PulseRef }> {
  return post(`/v1/pulses/${encodeURIComponent(pulseId)}/unsubscribe`, subscriber);
}

// ---------------------------------------------------------------------------
// Pending responses
// ---------------------------------------------------------------------------

export async function listPendingResponses(ws: string): Promise<PendingResponse[]> {
  const data = await get<{ pending: PendingResponse[] }>(`/v1/pending-responses?workspace_id=${encodeURIComponent(ws)}`);
  return data.pending;
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

export async function getWatermark(ws: string, endpoint: string): Promise<Watermark | null> {
  const data = await get<{ watermark: Watermark | null }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent(endpoint)}/watermark`
  );
  return data.watermark;
}

export async function putWatermark(ws: string, endpoint: string, cursor: string): Promise<void> {
  await put(`/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent(endpoint)}/watermark`, { cursor });
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** GET /v1/runtime/telemetry?workspace_id=...&delivery_id=...&limit=... */
export async function listRuntimeTelemetry(q?: {
  workspace_id?: string;
  delivery_id?: string;
  limit?: number;
}): Promise<TelemetryRow[]> {
  const params = new URLSearchParams();
  if (q?.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q?.delivery_id) params.set("delivery_id", q.delivery_id);
  if (q?.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  const data = await get<{ records: TelemetryRow[] }>(`/v1/runtime/telemetry${qs ? `?${qs}` : ""}`);
  return data.records;
}

/**
 * GET a bounded, read-only evidence envelope for one Context. The Bus owns the
 * joins between Context Events, deliveries, runtime telemetry, and capability
 * metadata so the app never reads or reconstructs internal storage.
 */
export async function getContextDiagnosticEvidence(
  workspaceId: string,
  contextId: string,
  options: { event_limit?: number; delivery_limit?: number; telemetry_limit?: number } = {},
): Promise<ContextDiagnosticEvidence> {
  const params = new URLSearchParams();
  if (options.event_limit != null) params.set("event_limit", String(options.event_limit));
  if (options.delivery_limit != null) params.set("delivery_limit", String(options.delivery_limit));
  if (options.telemetry_limit != null) params.set("telemetry_limit", String(options.telemetry_limit));
  const query = params.toString();
  return get(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/diagnostics/contexts/${encodeURIComponent(contextId)}${query ? `?${query}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** GET /v1/runtime/bindings?workspace_id=... */
export async function getRuntimeBindings(workspace_id?: string): Promise<RuntimeBindingRecord[]> {
  if (!isNativeFloeApp()) {
    const session = await getBrowserSession(undefined, workspace_id);
    return session.bindings.filter(binding => !workspace_id || binding.workspace_id === workspace_id);
  }
  const qs = workspace_id ? `?workspace_id=${encodeURIComponent(workspace_id)}` : "";
  const data = await get<{ bindings: RuntimeBindingRecord[] }>(`/v1/runtime/bindings${qs}`);
  return data.bindings;
}

/** GET /v1/runtime/bindings/resolve?workspace_id=...&endpoint_id=... */
export async function resolveRuntimeBinding(
  workspace_id: string,
  endpoint_id: string
): Promise<RuntimeBindingResolution> {
  return get<RuntimeBindingResolution>(
    `/v1/runtime/bindings/resolve?workspace_id=${encodeURIComponent(workspace_id)}&endpoint_id=${encodeURIComponent(endpoint_id)}`,
  );
}

/** POST /v1/runtime/bindings — upsert a runtime binding */
export async function upsertRuntimeBinding(input: {
  scope: RuntimeBindingScope;
  workspace_id?: string | null;
  endpoint_id?: string | null;
  auth_profile: string;
  provider: string;
  model?: string | null;
  thinking_level?: string | null;
}): Promise<RuntimeBindingRecord> {
  const data = await post<{ binding: RuntimeBindingRecord }>("/v1/runtime/bindings", input);
  return data.binding;
}

/** POST /v1/runtime/bindings/clear — remove a runtime binding */
export async function clearRuntimeBindings(input: {
  scope: RuntimeBindingScope;
  workspace_id?: string | null;
  endpoint_id?: string | null;
}): Promise<{ ok: true; binding_key: string }> {
  return post("/v1/runtime/bindings/clear", input);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** GET /v1/auth/profiles */
export async function getAuthProfiles(signal?: AbortSignal): Promise<{
  profiles: AuthProfileRecord[];
  default_auth_profile: string | null;
}> {
  if (isNativeFloeApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("get_substrate_auth_profiles");
  }
  const session = await getBrowserSession(signal);
  return { profiles: session.profiles, default_auth_profile: null };
}

/** GET /v1/auth/models?provider=... */
export async function getAuthModels(provider?: string): Promise<AuthModelRecord[]> {
  if (isNativeFloeApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const response = await invoke<{ status: number; body: string }>("get_auth_models", { provider: provider ?? null });
    if (response.status !== 200) throw new FloeHttpError(response.status, "/v1/auth/models");
    return (JSON.parse(response.body) as { models: AuthModelRecord[] }).models;
  }
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  const data = await get<{ models: AuthModelRecord[] }>(`/v1/browser/session/models${qs}`);
  return data.models;
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

/** GET /v1/configs */
export async function listConfigs(): Promise<SavedConfigRow[]> {
  const data = await get<{ configs: SavedConfigRow[] }>("/v1/configs");
  return data.configs;
}

/** POST /v1/configs — save a named config snapshot */
export async function postConfig(input: {
  name: string;
  config: Record<string, unknown>;
}): Promise<SavedConfigRow> {
  const data = await post<{ config: SavedConfigRow }>("/v1/configs", input);
  return data.config;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** POST /v1/webhooks/:workspace_id/:route_id — ingest a webhook payload */
export async function ingestWebhook(
  workspaceId: string,
  routeId: string,
  body: Record<string, unknown>
): Promise<{ ok: true; event: EventEnvelope }> {
  return post(
    `/v1/webhooks/${encodeURIComponent(workspaceId)}/${encodeURIComponent(routeId)}`,
    body
  );
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

/** GET /v1/runtime/status — bridge liveness and runtime adapter */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isNativeFloeApp()) return (await getBrowserSession()).runtime;
  const response = await localRuntimeStatusFetch();
  if (!response.ok) throw new FloeHttpError(response.status, "/v1/runtime/status");
  return response.json() as Promise<RuntimeStatus>;
}

/** GET /v1/local-config/status — local config paths and sections */
export async function getLocalConfigStatus(): Promise<LocalConfigStatus> {
  return get("/v1/local-config/status");
}

// ---------------------------------------------------------------------------
// Scope projection layout
// ---------------------------------------------------------------------------

export async function putScopeProjectionLayout(ws: string, scope: string, renderer: string, layout: ScopeProjectionLayout): Promise<void> {
  await put(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/projection/layout/${encodeURIComponent(renderer)}`,
    layout
  );
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export { subscribeEvents } from "./stream.ts";

// Re-export types for convenience
export type { StreamMsg };
