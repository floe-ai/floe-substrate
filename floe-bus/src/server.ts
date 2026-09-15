/**
 * @invariant This file is the only public HTTP/WebSocket boundary for floe-bus.
 * API handlers must expose bus-owned truth without bypassing BusStore precedence,
 * bridge-reported runtime state, or the shared auth/model registry.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import type { WorkspaceConfigurationPolicyProvider } from "./workspace-config-import.js";
import { parseListen } from "./config.js";
import { BROADCAST_TARGETS, BusStore, ContextAnchorError, ContextNotFoundError, ContextParticipantError, ContextScopeAssignmentError, EndpointRetirementBlockedError, PulseNotFoundError, ScopeRequiredError, ScopeRetiredError, type EventCommand, type PulsePersistence, type PulseSubscriber } from "./store.js";
import { PulseScheduler } from "./pulse-scheduler.js";
import { EVENT_INGRESS_CAPABILITY } from "./event-ingress.js";
import {
  isValidRenderer,
  loadScopeProjectionLayout,
  upsertScopeProjectionLayout
} from "./scope-projection-layout-store.js";
import { ScopeAlreadyExistsError, ScopeNotEmptyError, ScopeNotFoundError, ScopeReservedIdError } from "./scopes/store.js";
import {
  ScopeGraphInvalidError,
  ScopeGraphNodeNotATriggerError,
  ScopeGraphNodeNotFoundError,
  ScopeGraphNotFoundError,
  type ScopeGraphNode
} from "./scope-graphs.js";
import {
  ScopeCompositionConflictError,
  ScopeCompositionImmutableError,
  ScopeCompositionInvalidError,
  ScopeCompositionNotFoundError,
  type ScopeCompositionContent,
} from "./scope-compositions.js";
import { encodeEventCursor, InvalidEventCursorError } from "./event-cursor.js";
import { buildScopeProjection } from "./scopes/projection.js";
import { listAuthModels, listAuthProfiles } from "./auth.js";
import { encodeNpub, normalizePubkeyToHex, verifyAuthEvent } from "./client-identity-auth.js";
import { browseDir } from "./fs/browseDir.js";
import { listAgentFiles } from "./fs/agentFiles.js";
import { PathEscapesRootError, resolveWithinRoot, RootNotFoundError } from "./fs/resolveWithinRoot.js";
import { registerContextDiagnosticRoutes } from "./context-diagnostics.js";
import { createCorsOriginPolicy, trustedBrowserOrigins } from "./cors-policy.js";
import { BrowserConnections, BrowserConnectionError, loopbackBrowserOrigins } from "./browser-connections.js";
import {
  ArtefactContentMismatchError,
  ArtefactContentNotFoundError,
  ArtefactContentTooLargeError,
  ArtefactContentUnresolvedError,
  resolveArtefactVersionContent,
} from "./artefact-content-resolver.js";
import { INSPECT_ARTEFACT_OPERATION_ID } from "./artefact-operations.js";
import { HTML_PREVIEW_CSP, HTML_PREVIEW_HOST_DOCUMENT, HTML_PREVIEW_HOST_PATH } from "./html-preview-host.js";
import { OperationInvocationSchema, registerHostOperationRoutes, registerOperationRoutes } from "./operation-routes.js";
import { workspaceOperationRefusal } from "./workspace-operations.js";
import {
  COPY_WORKSPACE_OPERATION_ID,
  FORK_WORKSPACE_OPERATION_ID,
  HOST_LOCAL_WORKSPACE_OPERATION_IDS,
  REBIND_WORKSPACE_OPERATION_ID,
  REGISTER_WORKSPACE_OPERATION_ID,
  RESTORE_WORKSPACE_OPERATION_ID,
} from "./workspace-operations.js";
import type {
  OperationAuthorityBoundary,
  OperationInvocationProvenance,
  OperationInvocationRequest,
  OperationResourceIdentity,
} from "./operations.js";
import { createOperationAuthorityContext } from "./operations.js";
import {
  ARCHIVE_CONTEXT_OPERATION_ID,
  CREATE_CONTEXT_OPERATION_ID,
  EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
  REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID,
  SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
} from "./context-operations.js";
import {
  BusTransportAuthenticator,
  parseBearerHeader,
  type BridgeServiceAuthority,
  type BusTransportAuthority,
  type HostControlAuthority,
  type WorkspaceOperationAuthority,
} from "./transport-auth.js";
import {
  decodeTransportPushCursor,
  InvalidTransportPushCursorError,
  TransportPushStreamStore,
  type TransportPushEntry,
} from "./transport-push-stream.js";
import type {
  IssuedBridgeServiceCredential,
} from "./transport-credentials.js";
import {
  ACCOUNT_CONNECTION_PURPOSE,
  BIND_CREDENTIAL_OPERATION_ID,
  CREDENTIAL_MAINTENANCE_PURPOSE,
  HEALTH_CREDENTIAL_OPERATION_ID,
  REVOKE_CREDENTIAL_OPERATION_ID,
  ROTATE_CREDENTIAL_OPERATION_ID,
} from "./credential-operations.js";
import { WINDOWS_DPAPI_CREDENTIAL_BROKER_ID } from "./windows-dpapi-credential-protector.js";
import { WorkspacePortabilityError } from "./workspace-portability.js";
import {
  AttachmentIngressError,
  MAX_ATTACHMENT_INGRESS_BYTES,
} from "./attachment-ingress.js";

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const BRIDGE_LIVENESS_MS = 90_000;
const MAX_WORKSPACE_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_RUNTIME_CREDENTIAL_BYTES = 1024 * 1024;
const ConfirmedOperationInvocationSchema = z.object({
  interaction_session_id: z.string().min(1),
  invocation: OperationInvocationSchema.strict(),
}).strict();
const OPERATOR_CREDENTIAL_OPERATION_IDS = Object.freeze([
  BIND_CREDENTIAL_OPERATION_ID,
  HEALTH_CREDENTIAL_OPERATION_ID,
  ROTATE_CREDENTIAL_OPERATION_ID,
  REVOKE_CREDENTIAL_OPERATION_ID,
]);
const HOST_CREDENTIAL_OPERATION_IDS = new Set([
  "credential.runtime-access.grant",
  "credential.runtime-access.revoke",
  ...OPERATOR_CREDENTIAL_OPERATION_IDS,
]);

function workspaceMediaType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return null;
  }
}

const EventCommandSchema = z.object({
  type: z.string().min(1),
  workspace_id: z.string().min(1),
  source_endpoint_id: z.string().min(1),
  destination: z.union([
    z.object({
      kind: z.literal("endpoint"),
      endpoint_id: z.string().min(1)
    }),
    z.object({
      kind: z.literal("broadcast"),
      scope: z.literal("workspace"),
      target: z.enum(BROADCAST_TARGETS),
      exclude_source: z.boolean().optional()
    }),
    z.object({
      kind: z.literal("context"),
      context_id: z.string().min(1)
    })
  ]),
  thread_id: z.string().min(1).optional(),
  context_id: z.string().min(1).nullable().optional(),
  current_delivery_context_id: z.string().min(1).nullable().optional(),
  scope_id: z.string().min(1).nullable().optional(),
  correlation_id: z.string().nullable().optional(),
  content: z.record(z.unknown()),
  artefact_version_ids: z.array(z.string().min(1)).optional(),
  response: z.object({
    expected: z.boolean(),
    mode: z.enum(["open", "thread_affine", "correlated"]).optional(),
    correlation_id: z.string().nullable().optional(),
    timeout_at: z.string().nullable().optional()
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  idempotency_key: z.string().nullable().optional()
});

const RuntimeBindingUpsertSchema = z.object({
  scope: z.enum(["agent", "workspace_default", "global_default"]),
  workspace_id: z.string().nullable().optional(),
  endpoint_id: z.string().nullable().optional(),
  auth_profile: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  thinking_level: ThinkingLevelSchema.nullable().optional()
});

const PulseSubscriberSchema = z.union([
  z.object({
    kind: z.literal("context"),
    context_id: z.string().min(1)
  }),
  z.object({
    kind: z.literal("endpoint").optional(),
    endpoint_ref: z.string().min(1),
    context_id: z.string().min(1).nullable().optional()
  })
]);

const RuntimeBindingClearSchema = z.object({
  scope: z.enum(["agent", "workspace_default", "global_default"]),
  workspace_id: z.string().nullable().optional(),
  endpoint_id: z.string().nullable().optional()
});

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
};

export type BusServerOptions = Readonly<{
  workspace_configuration_policy?: WorkspaceConfigurationPolicyProvider;
  /** Supplied out-of-band by the trusted native owner. Never logged or returned over HTTP. */
  host_control_token?: string;
  host_control_expires_at?: string;
  /** Local product policy: the configured loopback frontend opens without pairing. */
  local_browser_access?: boolean;
  /**
   * UNSAFE, in-process test only. When set, requests that arrive without a
   * bearer are allowed through with a fabricated authority so old unit tests
   * can exercise route logic without minting real credentials. This is NOT a
   * supported configuration option: it cannot be set through config, an
   * environment variable, or `floe start`, and production never enables it.
   * Do not add new callers — prefer minting real credentials.
   */
  unsafe_in_process_test_auth_bypass?: boolean;
}>;

export async function createBusServer(
  configPath: string,
  config: LocalConfig,
  options: BusServerOptions = {},
): Promise<{
  app: ReturnType<typeof Fastify>;
  store: BusStore;
  /** Every HTTP route the Bus registered, for authority-boundary enumeration. */
  routes: ReadonlyArray<{ method: string; url: string }>;
  /** Trusted process hand-off only. Never exposed by an HTTP response or log. */
  localControlToken: string;
  issueBridgeServiceCredential: (bridgeId: string, expiresAt?: string) => IssuedBridgeServiceCredential;
  replaceBridgeServiceCredential: (bridgeId: string, expiresAt?: string) => IssuedBridgeServiceCredential;
  rotateBridgeServiceCredential: (
    credentialId: string,
    bridgeId: string,
    expiresAt?: string,
  ) => IssuedBridgeServiceCredential;
  revokeBridgeServiceCredential: (credentialId: string, bridgeId: string) => boolean;
  broadcast: (type: string, payload?: Record<string, unknown>) => void;
  listen: () => Promise<void>;
}> {
  // Resource ids are opaque substrate identifiers. Exact revisions and legacy
  // retained ids can exceed Fastify's 100-character default, so keep the HTTP
  // router aligned with identifiers the substrate itself creates.
  const app = Fastify({ logger: true, routerOptions: { maxParamLength: 2_048 } });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: Math.max(MAX_RUNTIME_CREDENTIAL_BYTES, MAX_ATTACHMENT_INGRESS_BYTES) },
    (_request, body, done) => done(null, body),
  );
  // The registered transport surface, captured as each route is added so the
  // authority-boundary test can enumerate every route from the router itself
  // rather than a hand-maintained list a newly added route could silently
  // escape. Read-only substrate self-description; never a product surface.
  const registeredRoutes: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registeredRoutes.push({ method, url: route.url });
  });
  // Single error boundary for the whole transport surface. Without it, any
  // uncaught throw reaches Fastify's default handler, which returns the raw
  // Error.message to the caller — leaking internal detail (SQLite driver text
  // and schema/table names, filesystem paths, stack fragments) across the trust
  // boundary to an unprivileged client, and giving that client nothing it can
  // act on. Internal failures are logged where an operator can see them and
  // answered with a generic, correlatable error; request-level failures (4xx,
  // schema validation) describe the caller's own request and are safe to return.
  app.setErrorHandler((error, request, reply) => {
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === "number" ? rawStatus : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error, request_id: request.id }, "Unhandled bus error");
      return reply.code(500).send({
        error: "internal_error",
        message: "The bus encountered an internal error. An operator can find the detail in the bus logs.",
        request_id: request.id,
      });
    }
    const isValidation = Boolean((error as { validation?: unknown }).validation);
    return reply.code(statusCode).send({
      error: isValidation ? "request_invalid" : "request_error",
      message: (error as Error).message,
      request_id: request.id,
    });
  });
  const store = new BusStore(configPath, config, { workspace_configuration_policy: options.workspace_configuration_policy });
  const unsafeInProcessTestAuthBypass = options.unsafe_in_process_test_auth_bypass ?? false;
  const localControlToken = options.host_control_token
    ?? (unsafeInProcessTestAuthBypass
      ? `floe_test_host_${createHash("sha256").update(configPath).digest("base64url")}`
      : "");
  if (!localControlToken) {
    store.close();
    throw new Error("A host-control credential must be supplied by the trusted native owner.");
  }
  const hostControlCredential = store.transportCredentialStore.installHostControlCredential({
    host_id: store.localHostId,
    bearer_token: localControlToken,
    expires_at: options.host_control_expires_at ?? oneYearFromNow(),
  });
  const transportAuthenticator = new BusTransportAuthenticator(store);
  const browserOrigins = trustedBrowserOrigins();
  const localOrigins = options.local_browser_access ? loopbackBrowserOrigins(browserOrigins) : new Set<string>();
  const browserConnections = new BrowserConnections(browserOrigins, id => {
    store.operationAuthoritySessions.revokeSession(id);
  }, Date.now, options.local_browser_access ? {
    origins: localOrigins,
    issueSession: workspaceId => {
      const host = transportAuthenticator.authenticateHostControl(localControlToken);
      if (!host.verified || host.authority.audience !== "host_control") throw new BrowserConnectionError(401, "The local Floe app needs to restart.");
      const workspaces = store.listRemoteWorkspaces();
      const workspace = workspaceId ? workspaces.find(item => item.workspace_id === workspaceId) : workspaces[0];
      if (!workspace) {
        if (workspaceId) throw new BrowserConnectionError(404, "This workspace is not available on this computer.");
        return null;
      }
      return issueWorkspaceOperationSession(host.authority, workspace.workspace_id, {
        interaction_session_id: `browser:local:${randomUUID()}`, expires_in_seconds: 3_600,
      }, "floe-local-browser-session");
    },
  } : undefined);
  const pushStream = new TransportPushStreamStore(store.db);
  const socketAuthorities = new Map<SocketLike, BusTransportAuthority>();
  const requestAuthorities = new WeakMap<object, BusTransportAuthority>();
  const testBypassedRequests = new WeakSet<object>();
  /** Maps bridge_id → the WS socket it opened; used for socket-presence liveness (D4). */
  const bridgeSockets = new Map<string, SocketLike>();

  function broadcast(type: string, payload: Record<string, unknown> = {}): void {
    const entry = pushStream.append({
      workspace_id: resolveBroadcastWorkspaceId(store, payload),
      type,
      payload,
    });
    const message = serializePushEntry(entry);
    for (const [socket, authority] of socketAuthorities) {
      try {
        if (socket.readyState === 1 && mayReceivePushEntry(authority, entry, store)) socket.send(message);
      } catch {
        socketAuthorities.delete(socket);
      }
    }
  }

  function requireLocalControl(request: object, reply: any): HostControlAuthority | null {
    if (testBypassedRequests.has(request)) {
      return {
        audience: "host_control",
        host_id: store.localHostId,
        credential_id: "test-bypass",
      };
    }
    const authority = requestAuthorities.get(request);
    if (authority?.audience === "host_control") return authority;
    sendTransportDenied(reply);
    return null;
  }

  function requireBridgeService(request: object, reply: any): BridgeServiceAuthority | null {
    if (testBypassedRequests.has(request)) {
      return {
        audience: "bridge_service",
        bridge_id: bridgeIdentityFromRequest(request) ?? "bridge:test-bypass",
        host_id: store.localHostId,
        credential_id: "test-bypass",
      };
    }
    const authority = requestAuthorities.get(request);
    if (authority?.audience === "bridge_service") return authority;
    sendTransportDenied(reply);
    return null;
  }

  function requireWorkspaceOperation(
    request: object,
    reply: any,
    workspaceId: string,
  ): WorkspaceOperationAuthority | null {
    if (testBypassedRequests.has(request)) {
      return null;
    }
    const authority = requestAuthorities.get(request);
    if (authority?.audience === "workspace_operation" && authority.workspace_id === workspaceId) {
      return authority;
    }
    sendTransportDenied(reply);
    return null;
  }

  function sendWorkspaceOperationError(error: unknown, reply: any) {
    const candidate = error as { code?: string; retryable?: boolean } | null;
    const refusal = candidate && typeof candidate.retryable === "boolean"
      ? error as ReturnType<typeof workspaceOperationRefusal>
      : workspaceOperationRefusal(error);
    const status = refusal.code === "workspace_locator_invalid" || refusal.code === "workspace_directory_not_found"
      ? 400
      : refusal.code === "workspace_operation_failed" || !refusal.code
        ? 500
        : 409;
    return reply.code(status).send({ error: refusal.code ?? "workspace_operation_failed", ...refusal });
  }

  function sendAttachmentIngressError(error: unknown, reply: any) {
    const code = error instanceof AttachmentIngressError
      ? error.code
      : "attachment_ingress_refused";
    const status = code === "attachment_ingress_not_found" ? 404
      : code === "attachment_ingress_capacity_exceeded" ? 429
      : code === "attachment_ingress_content_invalid" ? 400
        : 409;
    return reply.code(status).send({
      error: code,
      message: code === "attachment_ingress_capacity_exceeded"
        ? "Floe's temporary upload storage is busy. Retry after pending uploads complete or expire."
        : "The attachment transfer was refused.",
    });
  }

  const emptyOperationProvenance: OperationInvocationProvenance = {
    cause_event_id: null,
    delivery_ids: [],
    execution_attempt_id: null,
    node_execution_id: null,
    scope_execution_id: null,
  };
  const hostPrincipalId = store.localOperatorPrincipalId;
  const hostBoundary = { kind: "host" as const, host_id: store.localHostId };
  const hostOperationIds = store.operationRegistry.listCurrentOperationIds({
    interaction_mode: "interactive",
    boundary_kind: "host",
  }).filter((operationId) =>
    HOST_LOCAL_WORKSPACE_OPERATION_IDS.has(operationId));
  const hostPolicyRevision = createHash("sha256").update(JSON.stringify({
    host_id: store.localHostId,
    principal_id: hostPrincipalId,
    operation_ids: hostOperationIds,
    transport_credential_id: hostControlCredential.transport_credential_id,
    expires_at: hostControlCredential.expires_at,
  })).digest("hex");
  const { grant: hostOperationGrant } = store.capabilityGrantStore.activateHostPolicyGrant({
    host_id: store.localHostId,
    principal_id: hostPrincipalId,
    purpose: "local_host_operations",
    policy_revision: hostPolicyRevision,
    operation_ids: hostOperationIds,
    expires_at: hostControlCredential.expires_at,
    issuer_id: `transport:${hostControlCredential.transport_credential_id}`,
    evidence: [{
      kind: "authenticated_host_control",
      ref: hostControlCredential.transport_credential_id,
    }],
  });

  function resolveHostOperationAuthority(
    request: object,
    reply: any,
    target: OperationResourceIdentity | null,
  ) {
    const transport = requireLocalControl(request, reply);
    if (!transport) return null;
    try { return hostOperationAuthority(transport, target); }
    catch (error) {
      if (!(error instanceof BrowserConnectionError)) throw error;
      reply.code(error.status).send({ error: "operation_target_not_found", target });
      return null;
    }
  }

  function hostOperationAuthority(transport: HostControlAuthority, target: OperationResourceIdentity | null, sessionId?: string) {
    const grantIds = [hostOperationGrant.grant_id];
    if (target?.kind === "secret_ref") {
      const ref = store.secretRefStore.getSecretRef(target.id);
      if (!ref || ref.owner.kind !== "host" || ref.owner.host_id !== store.localHostId) {
        throw new BrowserConnectionError(404, "This provider account is unavailable.");
      }
      const operationIds = store.operationRegistry.listCurrentOperationIds({
        interaction_mode: "interactive",
        boundary_kind: "host",
      }).filter((operationId) => HOST_CREDENTIAL_OPERATION_IDS.has(operationId));
      const policyRevision = createHash("sha256").update(JSON.stringify({
        host_id: store.localHostId,
        secret_ref_id: ref.secret_ref_id,
        generation: ref.generation,
        operation_ids: operationIds,
        expires_at: hostControlCredential.expires_at,
      })).digest("hex");
      const { grant } = store.capabilityGrantStore.activateHostPolicyGrant({
        host_id: store.localHostId,
        principal_id: hostPrincipalId,
        purpose: `local_host_credential:${ref.secret_ref_id}`,
        policy_revision: policyRevision,
        operation_ids: operationIds,
        targets: [
          { kind: "secret_ref", id: ref.secret_ref_id },
          { kind: ref.resource.kind, id: ref.resource.id },
        ],
        expires_at: hostControlCredential.expires_at,
        issuer_id: `transport:${hostControlCredential.transport_credential_id}`,
        evidence: [{ kind: "authenticated_host_control", ref: hostControlCredential.transport_credential_id }],
      });
      if (!store.secretRefStore.getGrantConstraint(grant.grant_id)) {
        store.secretRefStore.attachGrantConstraint({
          grant_id: grant.grant_id,
          secret_ref_id: ref.secret_ref_id,
          authority_boundary: hostBoundary,
          purposes: [ACCOUNT_CONNECTION_PURPOSE, CREDENTIAL_MAINTENANCE_PURPOSE],
        }, store.capabilityGrantStore);
      }
      grantIds.push(grant.grant_id);
    }
    const resolved = store.capabilityGrantStore.resolveSessionAuthority({
      principal_id: hostPrincipalId,
      boundary: hostBoundary,
      grant_ids: grantIds,
      interaction: {
        mode: "interactive",
        session_id: sessionId ?? `host-control:${transport.credential_id}`,
        broker_id: WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
        confirmed_prompts: [],
        approval_refs: [],
      },
    }, target);
    return { authority: resolved.authority, provenance: emptyOperationProvenance };
  }

  async function invokeHostWorkspaceCompatibility(
    request: any,
    reply: any,
    operationId: string,
    target: OperationResourceIdentity | null,
    input: unknown,
    successStatus: number,
  ) {
    const verified = resolveHostOperationAuthority(request, reply, target);
    if (!verified) return reply;
    const headerKey = request.headers?.["idempotency-key"];
    const invocation: OperationInvocationRequest = {
      operation_id: operationId,
      operation_version: "1",
      input_schema_version: "1",
      target,
      expected_resource_revision: null,
      idempotency_key: typeof headerKey === "string" && headerKey.trim()
        ? headerKey.trim()
        : `legacy-http:${randomUUID()}`,
      input,
    };
    const response = await store.operationRegistry.invoke({
      authority: verified.authority,
      provenance: verified.provenance,
      resolve_resource: (resource) => store.resolveOperationResource(resource, verified.authority.boundary),
    }, invocation);
    if (response.kind === "rejected" || response.kind === "conflict") {
      return sendWorkspaceOperationError(response.refusal, reply);
    }
    if (response.receipt.state === "refused") {
      return sendWorkspaceOperationError(response.receipt.refusal, reply);
    }
    const result = response.receipt.result as { workspace?: { workspace_id?: string } } | null;
    const workspaceId = result?.workspace?.workspace_id;
    const workspace = workspaceId ? store.getWorkspace(workspaceId) : null;
    if (!workspace) {
      return reply.code(500).send({
        error: "workspace_operation_result_unavailable",
        message: "The Workspace operation completed without a readable local projection.",
        receipt_id: response.receipt.receipt_id,
      });
    }
    return reply.code(successStatus).send({ workspace, receipt_id: response.receipt.receipt_id });
  }

  function resolveWorkspaceSemanticAuthority(
    request: any,
    reply: any,
    workspaceId: string,
  ): { authority: import("./operations.js").OperationAuthorityContext; provenance: OperationInvocationProvenance } | null {
    if (testBypassedRequests.has(request)) {
      return {
        authority: createOperationAuthorityContext({
          principal_id: "principal:test-bypass",
          boundary: { kind: "workspace", workspace_id: workspaceId },
          grants: new Set(store.operationRegistry.listCurrentOperationIds({
            interaction_mode: "interactive",
            boundary_kind: "workspace",
          })),
          interaction: {
            mode: "interactive",
            session_id: "test-bypass",
            confirmed_prompts: new Set(),
            approval_refs: new Set(),
          },
        }),
        provenance: emptyOperationProvenance,
      };
    }
    const transport = requireWorkspaceOperation(request, reply, workspaceId);
    if (!transport) return null;
    return {
      authority: transport.verification.authority,
      provenance: emptyOperationProvenance,
    };
  }

  async function invokeWorkspaceCompatibility(
    request: any,
    reply: any,
    input: Readonly<{
      workspace_id: string;
      operation_id: string;
      target?: OperationResourceIdentity | null;
      expected_revision?: string | null;
      value: unknown;
    }>,
  ) {
    const verified = resolveWorkspaceSemanticAuthority(request, reply, input.workspace_id);
    if (!verified) return null;
    const headerKey = request.headers?.["idempotency-key"];
    const invocation: OperationInvocationRequest = {
      operation_id: input.operation_id,
      operation_version: "1",
      input_schema_version: "1",
      target: input.target ?? null,
      expected_resource_revision: input.expected_revision ?? null,
      idempotency_key: typeof headerKey === "string" && headerKey.trim()
        ? headerKey.trim()
        : `legacy-http:${input.operation_id}:${randomUUID()}`,
      input: input.value,
    };
    const response = await store.operationRegistry.invoke({
      authority: verified.authority,
      provenance: verified.provenance,
      resolve_resource: (resource) => store.resolveOperationResource(resource, verified.authority.boundary),
    }, invocation);
    if (response.kind === "rejected" || response.kind === "conflict") {
      const code = response.refusal.code;
      const status = code.includes("not_found") ? 404
        : code.includes("grant_required") ? 403
          : code.includes("invalid") || code.includes("schema") || code === "context_parent_cycle" || code === "scope_id_reserved" ? 400
            : 409;
      reply.code(status).send({ error: code, ...response.refusal });
      return null;
    }
    if (response.receipt.state === "refused") {
      const refusal = response.receipt.refusal!;
      const status = refusal.code.includes("not_found") ? 404
        : refusal.code.includes("grant_required") ? 403
          : refusal.code.includes("invalid") || refusal.code.includes("schema") || refusal.code === "context_parent_cycle" || refusal.code === "scope_id_reserved" ? 400
            : 409;
      reply.code(status).send({ error: refusal.code, ...refusal, receipt_id: response.receipt.receipt_id });
      return null;
    }
    return response.receipt;
  }

  // Inject broadcast into the store so lease-expiry requeue can self-schedule (D5).
  store.setBroadcast(broadcast);

  await app.register(cors, { origin: createCorsOriginPolicy(browserOrigins) });
  await app.register(websocket);
  app.addHook("preHandler", async (request, reply) => {
    // Static sandbox bootstrap only: no Workspace, content or authority. An
    // opaque iframe must not acquire a browser session to load this document.
    if (request.routeOptions.url === HTML_PREVIEW_HOST_PATH) return;
    // A browser cookie is only a transport handle to a canonical Workspace
    // bearer. The same verifier and operation routes still decide authority.
    try {
      const workspace = resolveRequestWorkspace(request, store);
      const session = workspace.conflicted ? null : browserConnections.session(request, workspace.workspace_id ?? undefined);
      if (session && !request.headers.authorization) request.headers.authorization = `Bearer ${session.bearer_token}`;
    } catch (error) {
      if (error instanceof BrowserConnectionError) return reply.code(error.status).send({ error: "browser_origin_refused", message: error.message });
      throw error;
    }
    const requirement = resolveTransportRequirement(request, store);
    if (
      requirement.kind === "public"
      || requirement.kind === "websocket"
      || requirement.kind === "credential_ingress"
      || requirement.kind === "attachment_ingress"
    ) return;

    const bearer = parseBearerHeader(request.headers.authorization);
    if (!bearer && unsafeInProcessTestAuthBypass) {
      testBypassedRequests.add(request);
      return;
    }

    const authenticated = requirement.kind === "host_control"
      ? transportAuthenticator.authenticateHostControl(bearer)
      : requirement.kind === "bridge_service"
        ? transportAuthenticator.authenticateBridgeService(bearer)
        : requirement.kind === "workspace_operation"
          ? transportAuthenticator.authenticateWorkspaceOperation(bearer, requirement.workspace_id)
          : requirement.kind === "bridge_or_workspace"
            ? authenticateBridgeOrWorkspace(
                transportAuthenticator,
                bearer,
                requirement.workspace_id,
              )
            : requirement.kind === "bridge_workspace_or_host"
              ? authenticateBridgeWorkspaceOrHost(
                  transportAuthenticator,
                  bearer,
                  requirement.workspace_id,
                )
              : requirement.kind === "workspace_conflict"
                ? authenticateConflictedWorkspaceRequest(
                    transportAuthenticator,
                    bearer,
                    requirement.workspace_ids,
                  )
                : authenticateBridgeOrHost(transportAuthenticator, bearer);
    if (!authenticated.verified) {
      // Some in-process unit tests opt into one explicit, unsafe bypass so they
      // can exercise route logic without minting real credentials. It is never
      // inferred from environment or config, cannot be reached through
      // `floe start`, and production always leaves it disabled. Strict
      // transport tests exercise the real boundary.
      if (unsafeInProcessTestAuthBypass) {
        const trustedTestHost = transportAuthenticator.authenticateHostControl(bearer);
        if (trustedTestHost.verified) {
          testBypassedRequests.add(request);
          return;
        }
      }
      sendTransportDenied(reply);
      return reply;
    }
    if (requirement.kind === "workspace_conflict") {
      sendTransportForbidden(reply);
      return reply;
    }
    if (
      !testBypassedRequests.has(request)
      && authenticated.authority.audience === "bridge_service"
      && (
        (requirement.kind === "bridge_service"
          && requirement.workspace_id !== null
          && !bridgeMayUseWorkspace(store, authenticated.authority, requirement.workspace_id))
        || (requirement.kind === "bridge_or_workspace"
          && requirement.workspace_id !== null
          && !bridgeMayUseWorkspace(store, authenticated.authority, requirement.workspace_id))
        || (requirement.kind === "bridge_workspace_or_host"
          && !bridgeMayUseWorkspace(store, authenticated.authority, requirement.workspace_id))
        || (requirement.kind === "bridge_or_host"
          && authenticated.authority.host_id !== store.localHostId)
      )
    ) {
      sendTransportForbidden(reply);
      return reply;
    }
    requestAuthorities.set(request, authenticated.authority);
  });
  registerOperationRoutes(app, store, resolveHostOperationAuthority);
  registerHostOperationRoutes(app, store, (request, reply, target) => {
    try {
      // Only the installed host's origin-bound local cookie can use this
      // adapter. A paired remote Workspace session never becomes host authority.
      const owner = browserConnections.localOwner(request);
      const host = transportAuthenticator.authenticateHostControl(localControlToken);
      if (!host.verified || host.authority.audience !== "host_control") {
        throw new BrowserConnectionError(401, "Restart the local Floe app to restore access.");
      }
      reply.header("cache-control", "no-store");
      return hostOperationAuthority(host.authority, target, `browser-local-host:${owner}`);
    } catch (error) {
      browserFailure(error, reply);
      return null;
    }
  }, "/v1/browser/host");

  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const socket of socketAuthorities.keys()) socket.close();
    socketAuthorities.clear();
    bridgeSockets.clear();
    browserConnections.close();
    store.close();
  });

  const timer = setInterval(() => undefined, 60_000);

  const getRuntimeStatus = () => {
    // D4: liveness is determined by socket presence, not a time-window check.
    // A bridge is online if and only if its WS socket is currently connected.
    const onlineBridges = store.listBridges().filter((bridge) => {
      const socket = bridgeSockets.get(bridge.bridge_id);
      return socket !== undefined && socket.readyState === 1;
    });
    const runtimeAdapter = onlineBridges
      .flatMap((bridge) => {
        const adapters = Array.isArray(bridge.capabilities.runtime_adapters)
          ? bridge.capabilities.runtime_adapters
          : [];
        return adapters.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      })[0] ?? null;
    const reportingBridge = onlineBridges[0] ?? null;
    return {
      bridge: {
        online: onlineBridges.length > 0,
        runtime_adapter: runtimeAdapter,
        release_version: typeof reportingBridge?.capabilities.release_version === "string"
          ? reportingBridge.capabilities.release_version
          : null,
        build_sha: typeof reportingBridge?.capabilities.build_sha === "string"
          ? reportingBridge.capabilities.build_sha
          : null,
      },
    };
  };

  app.get("/health", async () => ({
    ok: true,
    service: "floe-bus",
    // The instance id is minted by whoever started this process (the CLI sets
    // FLOE_BUS_INSTANCE_ID) and recorded alongside the pid. It lets the starter
    // prove that a bus answering on a URL is the exact process it launched — not
    // a stale predecessor or a different install that happens to hold the port.
    instance_id: process.env.FLOE_BUS_INSTANCE_ID ?? null,
    time: new Date().toISOString()
  }));

  app.get(HTML_PREVIEW_HOST_PATH, async (_request, reply) => reply
    .header("content-security-policy", HTML_PREVIEW_CSP)
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("permissions-policy", "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=()")
    .type("text/html; charset=utf-8")
    .send(HTML_PREVIEW_HOST_DOCUMENT));

  app.get("/v1/local-config/status", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    return {
    ok: true,
    config_path: configPath,
    home: config.home,
    bus: config.bus,
    bridge: config.bridge
    };
  });

  app.get("/v1/runtime/status", async () => getRuntimeStatus());

  function browserFailure(error: unknown, reply: any) {
    if (error instanceof BrowserConnectionError) {
      return reply.code(error.status).send({ error: "browser_connection_refused", message: error.message });
    }
    throw error;
  }

  app.post("/v1/browser/session/local", async (request, reply) => {
    try {
      if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: "browser_connection_request_invalid" });
      reply.header("cache-control", "no-store").header("set-cookie", browserConnections.connectLocal(request));
      return { connected: true, mode: "local" };
    } catch (error) { return browserFailure(error, reply); }
  });
  app.post("/v1/browser/connections", async (request, reply) => {
    try {
      if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: "browser_connection_request_invalid" });
      const started = browserConnections.start(request);
      reply.header("cache-control", "no-store");
      if (started.cookie) reply.header("set-cookie", started.cookie);
      return reply.code(201).send(started.connection);
    } catch (error) { return browserFailure(error, reply); }
  });
  app.post("/v1/browser/connections/claim", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store").header("set-cookie", browserConnections.claim(request));
      return { connected: true };
    } catch (error) { return browserFailure(error, reply); }
  });
  app.delete("/v1/browser/session", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store").header("set-cookie", browserConnections.disconnect(request));
      return { connected: false };
    } catch (error) { return browserFailure(error, reply); }
  });
  app.get("/v1/browser/session", async (request, reply) => {
    try {
      const mode = browserConnections.mode(request);
      const query = z.object({ workspace_id: z.string().min(1).optional() }).strict().safeParse(request.query);
      if (!mode || !query.success) return sendTransportDenied(reply);
      const session = browserConnections.session(request, query.data.workspace_id);
      if (session && !transportAuthenticator.authenticateWorkspaceOperation(session.bearer_token, session.workspace_id).verified) return sendTransportDenied(reply);
      const workspaces = store.listRemoteWorkspaces().filter(item => mode === "local" || item.workspace_id === session?.workspace_id);
      if (!session && (mode !== "local" || workspaces.length > 0)) return sendTransportDenied(reply);
      const bindings = workspaces.flatMap(workspace => store.listRuntimeBindings(workspace.workspace_id).filter(item => item.workspace_id === workspace.workspace_id));
      const profileIds = new Set(bindings.map(item => item.auth_profile));
      const profiles = listAuthProfiles(configPath, config).filter(item => profileIds.has(item.id));
      reply.header("cache-control", "no-store");
      return { mode, workspaces, profiles, bindings, runtime: getRuntimeStatus(), expires_at: session?.expires_at ?? null };
    } catch (error) { return browserFailure(error, reply); }
  });
  app.get("/v1/local/browser-connections", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    return { connections: browserConnections.list() };
  });
  app.get("/v1/browser/session/models", async (request, reply) => {
    try {
      const session = browserConnections.session(request);
      if (!session || !transportAuthenticator.authenticateWorkspaceOperation(session.bearer_token, session.workspace_id).verified) return sendTransportDenied(reply);
      const query = z.object({ provider: z.string().min(1) }).strict().safeParse(request.query);
      const workspaces = store.listRemoteWorkspaces().filter(item => browserConnections.mode(request) === "local" || item.workspace_id === session.workspace_id);
      const bindings = workspaces.flatMap(workspace => store.listRuntimeBindings(workspace.workspace_id).filter(item => item.workspace_id === workspace.workspace_id));
      if (!query.success || !bindings.some(item => item.provider === query.data.provider)) return sendTransportForbidden(reply);
      reply.header("cache-control", "no-store");
      return { models: await listAuthModels(configPath, config, query.data.provider) };
    } catch (error) { return browserFailure(error, reply); }
  });
  app.post("/v1/local/browser-connections/:code/approve", async (request, reply) => {
    const authority = requireLocalControl(request, reply);
    if (!authority) return reply;
    const params = z.object({ code: z.string().regex(/^[A-F0-9]{8}$/) }).safeParse(request.params);
    const body = z.object({ workspace_id: z.string().min(1) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "browser_connection_request_invalid" });
    if (!store.getWorkspace(body.data.workspace_id)) return reply.code(404).send({ error: "workspace_not_found" });
    try {
      browserConnections.approve(params.data.code, () => issueWorkspaceOperationSession(
        authority, body.data.workspace_id,
        { interaction_session_id: `browser:${params.data.code}`, expires_in_seconds: 3_600 },
        "floe-browser-session",
      ));
      return { approved: true };
    } catch (error) { return browserFailure(error, reply); }
  });

  app.get("/v1/events/stream", { websocket: true }, (socket, request) => {
    const client = socket as unknown as SocketLike;
    let connectedBridgeId: string | null = null;
    let authenticated = false;
    let socketAuthority: BusTransportAuthority | null = null;
    let sessionExpiryTimeout: ReturnType<typeof setTimeout> | undefined;
    const authenticationTimeout = setTimeout(() => {
      if (!authenticated) client.close(4401, "Authentication required");
    }, 5_000);

    client.on("message", (raw) => {
      if (authenticated) {
        if (socketAuthority?.audience !== "bridge_service") return;
        try {
          const acknowledgement = z.object({
            type: z.literal("acknowledge_cursor"),
            cursor: z.string().min(1),
          }).strict().parse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
          const cursor = pushStream.acknowledgeBridge(
            socketAuthority.bridge_id,
            acknowledgement.cursor,
          );
          client.send(JSON.stringify({
            type: "cursor_acknowledged",
            payload: { cursor },
            at: new Date().toISOString(),
          }));
        } catch (error) {
          client.close(
            error instanceof InvalidTransportPushCursorError ? 4400 : 4400,
            "Invalid cursor acknowledgement",
          );
        }
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        clearTimeout(authenticationTimeout);
        client.close(4400, "Invalid authentication frame");
        return;
      }
      const parsed = z.object({
        type: z.literal("authenticate"),
        bearer_token: z.string().min(1).optional(),
        browser_session: z.literal(true).optional(),
        workspace_id: z.string().min(1).optional(),
        after_cursor: z.string().min(1).nullable().optional(),
        start_at: z.literal("current").optional(),
      }).strict().safeParse(message);
      if (!parsed.success) {
        clearTimeout(authenticationTimeout);
        client.close(4401, "Authentication required");
        return;
      }

      let socketBearer = parsed.data.bearer_token ?? "";
      if (parsed.data.browser_session) {
        try {
          const session = browserConnections.session(request, parsed.data.workspace_id);
          if (socketBearer || !session || parsed.data.workspace_id !== session.workspace_id) throw new Error("Invalid browser session");
          socketBearer = session.bearer_token;
        } catch {
          clearTimeout(authenticationTimeout);
          client.close(4401, "Authentication required");
          return;
        }
      }

      const verified = parsed.data.workspace_id
        ? transportAuthenticator.authenticateWorkspaceOperation(
            socketBearer,
            parsed.data.workspace_id,
          )
        : authenticatePrivilegedSocket(transportAuthenticator, socketBearer);
      if (!verified.verified) {
        clearTimeout(authenticationTimeout);
        client.close(4401, "Authentication required");
        return;
      }

      const authority = verified.authority;
      const highWater = pushStream.latestSequence();
      let afterSequence: number;
      try {
        if (parsed.data.start_at && (parsed.data.after_cursor !== undefined || authority.audience === "bridge_service")) {
          throw new InvalidTransportPushCursorError();
        }
        const requestedSequence = decodeTransportPushCursor(parsed.data.after_cursor ?? null);
        if (requestedSequence > highWater) throw new InvalidTransportPushCursorError();
        if (authority.audience === "bridge_service") {
          const durableSequence = decodeTransportPushCursor(
            pushStream.getBridgeCheckpoint(authority.bridge_id),
          );
          afterSequence = parsed.data.after_cursor
            ? Math.min(requestedSequence, durableSequence)
            : durableSequence;
        } else {
          afterSequence = parsed.data.start_at === "current" ? highWater : requestedSequence;
        }
      } catch (error) {
        clearTimeout(authenticationTimeout);
        client.close(
          error instanceof InvalidTransportPushCursorError ? 4400 : 1011,
          error instanceof InvalidTransportPushCursorError ? "Invalid cursor" : "Stream unavailable",
        );
        return;
      }

      authenticated = true;
      socketAuthority = authority;
      if (authority.audience === "workspace_operation") {
        sessionExpiryTimeout = setTimeout(() => client.close(4401, "Session expired"), Math.max(0, Date.parse(authority.verification.expires_at) - Date.now()));
      }
      clearTimeout(authenticationTimeout);
      client.send(JSON.stringify({
        type: "authenticated",
        payload: {
          ...socketAuthenticationProjection(authority),
          cursor: pushStream.cursorForSequence(afterSequence),
        },
        at: new Date().toISOString(),
      }));

      let replaySequence = afterSequence;
      while (replaySequence < highWater) {
        const replay = pushStream.listAfter({
          after_cursor: pushStream.cursorForSequence(replaySequence),
          workspace_id: authority.audience === "workspace_operation" ? authority.workspace_id : null,
          through_sequence: highWater,
          limit: 1_000,
        });
        for (const entry of replay) {
          if (mayReceivePushEntry(authority, entry, store)) {
            client.send(serializePushEntry(entry));
          }
        }
        if (replay.length === 0) break;
        replaySequence = replay.at(-1)?.sequence ?? replaySequence;
      }
      client.send(JSON.stringify({
        type: "caught_up",
        payload: { cursor: pushStream.cursorForSequence(highWater) },
        at: new Date().toISOString(),
      }));
      socketAuthorities.set(client, authority);

      if (authority.audience === "bridge_service") {
        connectedBridgeId = authority.bridge_id;
        const previous = bridgeSockets.get(authority.bridge_id);
        if (previous && previous !== client) previous.close(4409, "Bridge connection replaced");
        bridgeSockets.set(authority.bridge_id, client);
        store.reportBridgeLiveness(authority.bridge_id);
        broadcast("bridge_connected", { bridge_id: authority.bridge_id });
      }
    });

    const removeSocket = () => {
      clearTimeout(authenticationTimeout);
      socketAuthorities.delete(client);
      clearTimeout(sessionExpiryTimeout);
      if (connectedBridgeId !== null && bridgeSockets.get(connectedBridgeId) === client) {
        bridgeSockets.delete(connectedBridgeId);
        broadcast("bridge_disconnected", { bridge_id: connectedBridgeId });
      }
    };
    client.on("close", removeSocket);
    client.on("error", removeSocket);
  });

  app.get("/v1/workspaces", async () => ({
    workspaces: store.listRemoteWorkspaces()
  }));

  app.get("/v1/local/workspaces", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    return { workspaces: store.listWorkspaces() };
  });

  app.post("/v1/local/credential-ingress-sessions", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const parsed = z.object({
      secret_ref_id: z.string().min(1),
      purpose: z.enum([ACCOUNT_CONNECTION_PURPOSE, CREDENTIAL_MAINTENANCE_PURPOSE]),
      expires_in_seconds: z.number().int().min(30).max(600).optional(),
    }).strict().safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "credential_ingress_request_invalid",
        message: "The credential transfer request is invalid.",
      });
    }
    const ref = store.secretRefStore.getSecretRef(parsed.data.secret_ref_id);
    if (!ref || ref.owner.kind !== "host" || ref.owner.host_id !== store.localHostId
      || ref.resource.kind !== "provider_account") {
      return reply.code(404).send({
        error: "credential_reference_not_found",
        message: "The provider account is not available on this host.",
      });
    }
    const issued = store.credentialIngressStore.issue({
      secret_ref_id: ref.secret_ref_id,
      authority_boundary: ref.owner,
      principal_id: store.localOperatorPrincipalId,
      provider_id: ref.resource.id,
      audience: `provider-auth:${ref.resource.id}`,
      purpose: parsed.data.purpose,
      ttl_ms: (parsed.data.expires_in_seconds ?? 300) * 1_000,
    });
    return reply
      .header("cache-control", "no-store")
      .code(201)
      .send(issued);
  });

  app.put("/v1/credential-ingress-sessions/:ingress_session_id/material", async (request, reply) => {
    const parsedParams = z.object({ ingress_session_id: z.string().min(1) }).safeParse(request.params);
    const audience = request.headers["x-floe-credential-ingress-audience"];
    const purpose = request.headers["x-floe-credential-ingress-purpose"];
    if (!parsedParams.success || typeof audience !== "string"
      || !audience.startsWith("provider-auth:")
      || (purpose !== ACCOUNT_CONNECTION_PURPOSE && purpose !== CREDENTIAL_MAINTENANCE_PURPOSE)
      || !Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      return reply.code(400).send({
        error: "credential_ingress_request_invalid",
        message: "The credential transfer request is invalid.",
      });
    }
    const material = new Uint8Array(request.body);
    try {
      const status = store.credentialIngressStore.upload({
        ingress_session_id: parsedParams.data.ingress_session_id,
        bearer_token: parseBearerHeader(request.headers.authorization),
        audience: audience as `provider-auth:${string}`,
        purpose,
        material,
      });
      return reply.header("cache-control", "no-store").send({ session: status });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "credential_ingress_refused";
      return reply.code(409).send({ error: code, message: "The credential transfer was refused." });
    } finally {
      material.fill(0);
      request.body.fill(0);
    }
  });

  app.post("/v1/local/credential-ingress-sessions/:ingress_session_id/revoke", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const parsed = z.object({ ingress_session_id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "credential_ingress_request_invalid",
        message: "The credential transfer request is invalid.",
      });
    }
    return { revoked: store.credentialIngressStore.revoke(parsed.data.ingress_session_id) };
  });

  app.post("/v1/workspaces/:workspace_id/attachment-ingress-sessions", async (request, reply) => {
    const parsedParams = z.object({ workspace_id: z.string().min(1) }).safeParse(request.params);
    const parsedBody = z.object({
      context_id: z.string().min(1),
      name: z.string().min(1).max(255),
      media_type: z.string().min(1).max(255),
      size_bytes: z.number().int().positive().max(MAX_ATTACHMENT_INGRESS_BYTES),
    }).strict().safeParse(request.body ?? {});
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        error: "attachment_ingress_request_invalid",
        message: "The attachment transfer request is invalid.",
      });
    }
    const verified = resolveWorkspaceSemanticAuthority(request, reply, parsedParams.data.workspace_id);
    if (!verified) return reply;
    if (!verified.authority.grants.has(EMIT_CONTEXT_COMMUNICATION_OPERATION_ID)) {
      return reply.code(403).send({
        error: "operation_grant_required",
        message: "The current principal is not authorised to communicate in this Context.",
      });
    }
    const context = store.contextStore.getContext(parsedBody.data.context_id);
    if (!context
      || context.workspace_id !== parsedParams.data.workspace_id
      || context.lifecycle_state !== "active") {
      return reply.code(404).send({
        error: "context_not_active",
        message: "This Context is not available for an attachment.",
      });
    }
    try {
      const issued = store.attachmentIngressStore.issue({
        workspace_id: parsedParams.data.workspace_id,
        context_id: parsedBody.data.context_id,
        principal_id: verified.authority.principal_id,
        name: parsedBody.data.name,
        media_type: parsedBody.data.media_type,
        size_bytes: parsedBody.data.size_bytes,
      });
      return reply.header("cache-control", "no-store").code(201).send(issued);
    } catch (error) {
      return sendAttachmentIngressError(error, reply);
    }
  });

  app.put("/v1/attachment-ingress-sessions/:ingress_session_id/content", async (request, reply) => {
    const parsedParams = z.object({ ingress_session_id: z.string().min(1) }).safeParse(request.params);
    if (!parsedParams.success || !Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      return reply.code(400).send({
        error: "attachment_ingress_request_invalid",
        message: "The attachment transfer request is invalid.",
      });
    }
    const bytes = new Uint8Array(request.body);
    try {
      const status = store.attachmentIngressStore.upload({
        ingress_session_id: parsedParams.data.ingress_session_id,
        bearer_token: parseBearerHeader(request.headers.authorization),
        bytes,
      });
      return reply.header("cache-control", "no-store").send({ session: status });
    } catch (error) {
      return sendAttachmentIngressError(error, reply);
    } finally {
      bytes.fill(0);
      request.body.fill(0);
    }
  });

  app.post("/v1/workspaces/:workspace_id/attachment-ingress-sessions/:ingress_session_id/revoke", async (request, reply) => {
    const parsedParams = z.object({
      workspace_id: z.string().min(1),
      ingress_session_id: z.string().min(1),
    }).safeParse(request.params);
    const parsedBody = z.object({ context_id: z.string().min(1) }).strict().safeParse(request.body ?? {});
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        error: "attachment_ingress_request_invalid",
        message: "The attachment transfer request is invalid.",
      });
    }
    const verified = resolveWorkspaceSemanticAuthority(request, reply, parsedParams.data.workspace_id);
    if (!verified) return reply;
    try {
      return {
        revoked: store.attachmentIngressStore.revoke({
          ingress_session_id: parsedParams.data.ingress_session_id,
          workspace_id: parsedParams.data.workspace_id,
          context_id: parsedBody.data.context_id,
          principal_id: verified.authority.principal_id,
        }),
      };
    } catch (error) {
      return sendAttachmentIngressError(error, reply);
    }
  });

  app.get("/v1/bridge/workspace-bindings", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    return {
      bridge_id: bridgeAuthority.bridge_id,
      host_id: bridgeAuthority.host_id,
      workspaces: store.workspaceIdentityStore
        .listLocalProjections(bridgeAuthority.host_id)
        .filter((workspace) => workspace.binding !== null),
    };
  });

  app.get("/v1/bridge/workspaces/:workspace_id/runtime-endpoints", async (request, reply) => {
    const authority = requireBridgeService(request, reply);
    if (!authority) return reply;
    const { workspace_id } = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const { binding_id } = z.object({ binding_id: z.string().min(1) }).parse(request.query);
    const binding = store.workspaceIdentityStore.getCurrentBinding(workspace_id, authority.host_id);
    if (!binding || binding.binding_id !== binding_id) {
      return reply.code(409).send({ error: "workspace_binding_mismatch", retryable: false });
    }
    if (!binding.init_authorized) return sendTransportForbidden(reply);
    return { endpoints: store.listRuntimeEndpoints(workspace_id) };
  });

  app.post("/v1/local/workspaces/:workspace_id/operation-sessions", async (request, reply) => {
    const hostAuthority = requireLocalControl(request, reply);
    if (!hostAuthority) return reply;
    const parsedParams = z.object({ workspace_id: z.string().min(1) }).safeParse(request.params);
    const parsedBody = z.object({
      interaction_session_id: z.string().min(1).optional(),
      expires_in_seconds: z.number().int().min(60).max(86_400).optional(),
    }).strict().safeParse(request.body ?? {});
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        error: "workspace_operation_session_request_invalid",
        message: "The Workspace session request is invalid.",
      });
    }
    const params = parsedParams.data;
    const body = parsedBody.data;
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({
        error: "workspace_not_found",
        workspace_id: params.workspace_id,
      });
    }

    return reply.code(201).send(issueWorkspaceOperationSession(hostAuthority, params.workspace_id, body));
  });

  // Both native and browser transports use the same durable grants and session issuer.
  function issueWorkspaceOperationSession(
    hostAuthority: HostControlAuthority,
    workspaceId: string,
    body: { expires_in_seconds?: number; interaction_session_id?: string },
    brokerId = WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
  ) {
    const expiresAt = new Date(Date.now() + (body.expires_in_seconds ?? 3_600) * 1_000).toISOString();
    const principalId = store.localOperatorPrincipalId;
    const operationIds = store.operationRegistry
      .listCurrentOperationIds({ interaction_mode: "interactive", boundary_kind: "workspace" });
    if (operationIds.length === 0) {
      throw new Error("No interactive semantic operations are currently registered.");
    }
    const ordinaryOperationIds = operationIds.filter((operationId) =>
      !OPERATOR_CREDENTIAL_OPERATION_IDS.includes(operationId as typeof OPERATOR_CREDENTIAL_OPERATION_IDS[number]));
    const grantIds: string[] = [];
    if (ordinaryOperationIds.length > 0) {
      grantIds.push(store.capabilityGrantStore.issueGrant({
        principal_id: principalId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
        operation_ids: ordinaryOperationIds,
        expires_at: expiresAt,
        issuer_id: `transport:${hostAuthority.credential_id}`,
        evidence: [{
          kind: "authenticated_host_control",
          ref: hostAuthority.credential_id,
        }],
      }).grant_id);
    }
    const workspaceBoundary = { kind: "workspace" as const, workspace_id: workspaceId };
    for (const ref of store.secretRefStore.listSecretRefs().filter((candidate) =>
      candidate.owner.kind === "host"
      || (candidate.owner.kind === "workspace" && candidate.owner.workspace_id === workspaceId))) {
      const grant = store.capabilityGrantStore.issueGrant({
        principal_id: principalId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
        operation_ids: OPERATOR_CREDENTIAL_OPERATION_IDS,
        targets: [
          { kind: "secret_ref", id: ref.secret_ref_id },
          { kind: ref.resource.kind, id: ref.resource.id },
        ],
        expires_at: expiresAt,
        issuer_id: `transport:${hostAuthority.credential_id}`,
        evidence: [{
          kind: "authenticated_host_control",
          ref: hostAuthority.credential_id,
        }],
      });
      store.secretRefStore.attachGrantConstraint({
        grant_id: grant.grant_id,
        authority_boundary: workspaceBoundary,
        secret_ref_id: ref.secret_ref_id,
        purposes: [ACCOUNT_CONNECTION_PURPOSE, CREDENTIAL_MAINTENANCE_PURPOSE],
      }, store.capabilityGrantStore);
      grantIds.push(grant.grant_id);
    }
    const issued = store.operationAuthoritySessions.issueSession({
      principal_id: principalId,
      workspace_id: workspaceId,
      grant_ids: grantIds,
      interaction: {
        mode: "interactive",
        session_id: body.interaction_session_id ?? `interaction_${randomUUID()}`,
        broker_id: brokerId,
      },
      provenance: emptyOperationProvenance,
      expires_at: expiresAt,
    });
    return {
      bearer_token: issued.bearer_token,
      authority_session_id: issued.session.authority_session_id,
      principal_id: issued.session.principal_id,
      workspace_id: issued.session.workspace_id,
      expires_at: issued.session.expires_at,
    };
  }

  async function invokeConfirmedOperatorOperation(input: Readonly<{
    host_authority: HostControlAuthority;
    boundary: OperationAuthorityBoundary;
    interaction_session_id: string;
    invocation: OperationInvocationRequest;
  }>): Promise<Readonly<{ status: number; body: unknown }>> {
    const currentOperationIds = store.operationRegistry.listCurrentOperationIds({
      interaction_mode: "interactive",
      boundary_kind: input.boundary.kind,
    });
    if (!currentOperationIds.includes(input.invocation.operation_id)) {
      return {
        status: 404,
        body: {
          error: "confirmed_operation_not_found",
          message: "The requested interactive operation is not currently registered.",
        },
      };
    }

    const target = input.invocation.target
      ? store.resolveOperationResource(input.invocation.target, input.boundary)
      : null;
    if (input.invocation.target && !target) {
      return { status: 404, body: { error: "operation_target_not_found", target: input.invocation.target } };
    }
    const discoveryAuthority = createOperationAuthorityContext({
      principal_id: store.localOperatorPrincipalId,
      boundary: input.boundary,
      grants: new Set([input.invocation.operation_id]),
      interaction: {
        mode: "interactive",
        session_id: input.interaction_session_id,
        broker_id: WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
        confirmed_prompts: new Set(),
        approval_refs: new Set(),
      },
    });
    const descriptor = (await store.operationRegistry.project({
      authority: discoveryAuthority,
      target,
      query: input.invocation.operation_id,
    })).find((candidate) =>
      candidate.operation_id === input.invocation.operation_id
      && candidate.operation_version === input.invocation.operation_version);
    const confirmation = descriptor?.interaction_constraints.confirmation;
    if (!descriptor || !confirmation?.required) {
      return {
        status: 400,
        body: {
          error: "operation_confirmation_not_required",
          message: "The requested operation does not declare this trusted confirmation step.",
        },
      };
    }

    const credentialRef = OPERATOR_CREDENTIAL_OPERATION_IDS.includes(
      descriptor.operation_id as typeof OPERATOR_CREDENTIAL_OPERATION_IDS[number],
    ) && input.invocation.target?.kind === "secret_ref"
      ? store.secretRefStore.getSecretRef(input.invocation.target.id)
      : null;
    const credentialVisible = !credentialRef
      || (credentialRef.owner.kind === "host"
        ? credentialRef.owner.host_id === store.localHostId
        : input.boundary.kind === "workspace"
          && credentialRef.owner.workspace_id === input.boundary.workspace_id);
    if (!credentialVisible) {
      return { status: 404, body: { error: "operation_target_not_found", target: input.invocation.target } };
    }

    const grant = store.capabilityGrantStore.issueGrant({
      principal_id: store.localOperatorPrincipalId,
      boundary: input.boundary,
      operation_ids: [descriptor.operation_id],
      ...(credentialRef
        ? {
            targets: [
              { kind: "secret_ref", id: credentialRef.secret_ref_id },
              { kind: credentialRef.resource.kind, id: credentialRef.resource.id },
            ],
          }
        : {}),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      issuer_id: `transport:${input.host_authority.credential_id}`,
      evidence: [{
        kind: "native_operator_confirmation",
        ref: `${input.host_authority.credential_id}:${confirmation.prompt_id}`,
      }],
    });
    try {
      if (credentialRef) {
        store.secretRefStore.attachGrantConstraint({
          grant_id: grant.grant_id,
          authority_boundary: input.boundary,
          secret_ref_id: credentialRef.secret_ref_id,
          purposes: [CREDENTIAL_MAINTENANCE_PURPOSE],
        }, store.capabilityGrantStore);
      }
      const resolved = store.capabilityGrantStore.resolveSessionAuthority({
        principal_id: store.localOperatorPrincipalId,
        boundary: input.boundary,
        grant_ids: [grant.grant_id],
        interaction: {
          mode: "interactive",
          session_id: input.interaction_session_id,
          broker_id: WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
          confirmed_prompts: [confirmation.prompt_id],
          approval_refs: [],
        },
      }, input.invocation.target ?? null);
      return {
        status: 200,
        body: await store.operationRegistry.invoke({
          authority: resolved.authority,
          provenance: emptyOperationProvenance,
          resolve_resource: (resource) => store.resolveOperationResource(resource, input.boundary),
        }, input.invocation),
      };
    } finally {
      store.capabilityGrantStore.revokeGrant(grant.grant_id);
    }
  }

  app.post("/v1/local/operations/confirm-and-invoke", async (request, reply) => {
    const hostAuthority = requireLocalControl(request, reply);
    if (!hostAuthority) return reply;
    const parsedBody = ConfirmedOperationInvocationSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: "confirmed_operation_request_invalid",
        message: "The confirmed operation request is invalid.",
      });
    }
    const outcome = await invokeConfirmedOperatorOperation({
      host_authority: hostAuthority,
      boundary: { kind: "host", host_id: store.localHostId },
      interaction_session_id: parsedBody.data.interaction_session_id,
      invocation: parsedBody.data.invocation as OperationInvocationRequest,
    });
    return reply.code(outcome.status).send(outcome.body);
  });

  /**
   * Atomic trusted confirmation boundary for native operator clients.
   *
   * The caller names only the unchanged semantic invocation. The Bus derives
   * confirmation, principal, grants, and target authority from its registered
   * operation contract and the authenticated host. No reusable elevated
   * bearer is issued.
   */
  app.post("/v1/local/workspaces/:workspace_id/operations/confirm-and-invoke", async (request, reply) => {
    const hostAuthority = requireLocalControl(request, reply);
    if (!hostAuthority) return reply;
    const parsedParams = z.object({ workspace_id: z.string().min(1) }).safeParse(request.params);
    const parsedBody = ConfirmedOperationInvocationSchema.safeParse(request.body ?? {});
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        error: "confirmed_operation_request_invalid",
        message: "The confirmed operation request is invalid.",
      });
    }
    const { workspace_id: workspaceId } = parsedParams.data;
    if (!store.getWorkspace(workspaceId)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: workspaceId });
    }

    const boundary = { kind: "workspace" as const, workspace_id: workspaceId };
    const { interaction_session_id: interactionSessionId, invocation } = parsedBody.data;
    const target = invocation.target
      ? store.resolveOperationResource(invocation.target, boundary)
      : null;
    if (invocation.target && !target) {
      return reply.code(404).send({ error: "operation_target_not_found", target: invocation.target });
    }
    const discoveryAuthority = createOperationAuthorityContext({
      principal_id: store.localOperatorPrincipalId,
      boundary,
      grants: new Set([invocation.operation_id]),
      interaction: {
        mode: "interactive",
        session_id: interactionSessionId,
        broker_id: WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
        confirmed_prompts: new Set(),
        approval_refs: new Set(),
      },
    });
    const descriptor = (await store.operationRegistry.project({
      authority: discoveryAuthority,
      target,
      query: invocation.operation_id,
    })).find((candidate) =>
      candidate.operation_id === invocation.operation_id
      && candidate.operation_version === invocation.operation_version);
    const confirmation = descriptor?.interaction_constraints.confirmation;
    if (!descriptor || !confirmation?.required) {
      return reply.code(400).send({
        error: "operation_confirmation_not_required",
        message: "The requested operation does not declare this trusted confirmation step.",
      });
    }
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const credentialRef = OPERATOR_CREDENTIAL_OPERATION_IDS.includes(
      descriptor.operation_id as typeof OPERATOR_CREDENTIAL_OPERATION_IDS[number],
    ) && invocation.target?.kind === "secret_ref"
      ? store.secretRefStore.getSecretRef(invocation.target.id)
      : null;
    if (credentialRef && credentialRef.owner.kind === "workspace"
      && credentialRef.owner.workspace_id !== workspaceId) {
      return reply.code(404).send({ error: "operation_target_not_found", target: invocation.target });
    }
    const grant = store.capabilityGrantStore.issueGrant({
      principal_id: store.localOperatorPrincipalId,
      boundary,
      operation_ids: [descriptor.operation_id],
      ...(credentialRef
        ? {
            targets: [
              { kind: "secret_ref", id: credentialRef.secret_ref_id },
              { kind: credentialRef.resource.kind, id: credentialRef.resource.id },
            ],
          }
        : {}),
      expires_at: expiresAt,
      issuer_id: `transport:${hostAuthority.credential_id}`,
      evidence: [{
        kind: "native_operator_confirmation",
        ref: `${hostAuthority.credential_id}:${confirmation.prompt_id}`,
      }],
    });
    try {
      if (credentialRef) {
        store.secretRefStore.attachGrantConstraint({
          grant_id: grant.grant_id,
          authority_boundary: boundary,
          secret_ref_id: credentialRef.secret_ref_id,
          purposes: [CREDENTIAL_MAINTENANCE_PURPOSE],
        }, store.capabilityGrantStore);
      }
      const resolved = store.capabilityGrantStore.resolveSessionAuthority({
        principal_id: store.localOperatorPrincipalId,
        boundary,
        grant_ids: [grant.grant_id],
        interaction: {
          mode: "interactive",
          session_id: interactionSessionId,
          broker_id: WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
          confirmed_prompts: [confirmation.prompt_id],
          approval_refs: [],
        },
      }, invocation.target ?? null);
      return await store.operationRegistry.invoke({
        authority: resolved.authority,
        provenance: emptyOperationProvenance,
        resolve_resource: (resource) => store.resolveOperationResource(resource, boundary),
      }, invocation as OperationInvocationRequest);
    } finally {
      store.capabilityGrantStore.revokeGrant(grant.grant_id);
    }
  });

  registerContextDiagnosticRoutes(app, store, getRuntimeStatus);

  app.get("/v1/workspaces/:workspace_id/scopes", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { scopes: store.listScopes(params.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/projection", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    return { projection: buildScopeProjection(store, params.workspace_id, params.scope_id) };
  });

  function encodeScopeExecutionCursor(row: { created_at: string; execution_id: string }): string {
    return Buffer.from(JSON.stringify({ created_at: row.created_at, execution_id: row.execution_id }), "utf8")
      .toString("base64url");
  }

  function decodeScopeExecutionCursor(
    value: string | undefined,
  ): { created_at: string; execution_id: string } | undefined {
    if (!value) return undefined;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return z.object({
      created_at: z.string().datetime(),
      execution_id: z.string().min(1),
    }).parse(parsed);
  }

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/executions", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      scope_id: z.string().min(1),
    }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().positive().max(200).optional().default(50),
      before: z.string().min(1).optional(),
    }).parse(request.query);
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({ error: "scope_not_found", ...params });
    }
    let before: { created_at: string; execution_id: string } | undefined;
    try {
      before = decodeScopeExecutionCursor(query.before);
    } catch {
      return reply.code(400).send({ error: "invalid_scope_execution_cursor" });
    }
    const rows = store.listScopeExecutionsPage({
      workspace_id: params.workspace_id,
      scope_id: params.scope_id,
      limit: query.limit + 1,
      before,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      executions: page,
      next_cursor: hasMore && page.length > 0 ? encodeScopeExecutionCursor(page.at(-1)!) : null,
    };
  });

  app.get("/v1/workspaces/:workspace_id/scope-executions/:execution_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      execution_id: z.string().min(1),
    }).parse(request.params);
    const projection = store.getScopeExecutionProjection(params.execution_id);
    if (!projection || projection.execution.workspace_id !== params.workspace_id) {
      return reply.code(404).send({ error: "scope_execution_not_found", ...params });
    }
    return { projection };
  });

  app.get("/v1/workspaces/:workspace_id/contexts/:context_id/scope-executions", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      context_id: z.string().min(1),
    }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().positive().max(200).optional().default(50),
      before: z.string().min(1).optional(),
    }).parse(request.query);
    const context = store.contextStore.getContext(params.context_id);
    if (!context || context.workspace_id !== params.workspace_id) {
      return reply.code(404).send({ error: "context_not_found", ...params });
    }
    let before: { created_at: string; execution_id: string } | undefined;
    try {
      before = decodeScopeExecutionCursor(query.before);
    } catch {
      return reply.code(400).send({ error: "invalid_scope_execution_cursor" });
    }
    const rows = store.listScopeExecutionsPage({
      workspace_id: params.workspace_id,
      caused_by_context_id: params.context_id,
      limit: query.limit + 1,
      before,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      executions: page,
      next_cursor: hasMore && page.length > 0 ? encodeScopeExecutionCursor(page.at(-1)!) : null,
    };
  });

  const ScopeGraphNodeSchema = z.union([
    z.object({
      node_id: z.string().min(1),
      kind: z.literal("trigger"),
      label: z.string().optional(),
      event_type: z.string().min(1),
      source: z.object({
        kind: z.literal("folder"),
        path: z.string().min(1),
        extensions: z.array(z.string().min(1)).optional(),
        settle_ms: z.number().int().min(0).max(60_000).optional()
      }).optional()
    }),
    z.object({
      node_id: z.string().min(1),
      kind: z.literal("actor"),
      label: z.string().optional(),
      endpoint_id: z.string().min(1),
      event_types: z.array(z.string().min(1)).optional(),
      bindings: z.array(z.object({
        kind: z.literal("instructions"),
        text: z.string().min(1)
      })).optional()
    }),
    z.object({
      node_id: z.string().min(1),
      kind: z.literal("command"),
      label: z.string().optional(),
      endpoint_id: z.string().min(1),
      event_types: z.array(z.string().min(1)).optional(),
      result_event_type: z.string().min(1).optional(),
      command: z.string().min(1),
      inputs: z.array(z.object({
        name: z.string().min(1),
        content_key: z.string().min(1),
        required: z.boolean().optional()
      })).optional(),
      outputs: z.array(z.object({
        name: z.string().min(1),
        from: z.enum(["exit_code", "passed", "stdout", "stderr"])
      })).optional()
    })
  ]);

  const ScopeNodePlacementSchema = z.object({
    node_id: z.string().min(1),
    kind: z.enum(["event", "actor", "command", "context", "scope", "capability", "connector"]),
    label: z.string().optional(),
    resource_id: z.string().min(1).nullable().optional(),
    config: z.record(z.unknown()).optional(),
    bindings: z.array(z.object({
      kind: z.literal("instructions"),
      text: z.string().min(1),
    })).optional(),
    activation: z.record(z.unknown()).optional(),
    context_policy: z.record(z.unknown()).optional(),
  });
  const ScopePortSchema = z.object({
    port_id: z.string().min(1),
    node_id: z.string().min(1),
    name: z.string().min(1),
    direction: z.enum(["input", "output"]),
    event_types: z.array(z.string().min(1)).optional(),
    artefact_types: z.array(z.string().min(1)).optional(),
    schema_ref: z.string().min(1).nullable().optional(),
    min_count: z.number().int().min(0).optional(),
    max_count: z.number().int().min(0).nullable().optional(),
  });
  const ScopeEdgeSchema = z.object({
    edge_id: z.string().min(1),
    source_port_id: z.string().min(1),
    target_port_id: z.string().min(1),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    policy: z.record(z.unknown()).optional(),
  });
  const ScopeCompositionContentSchema = z.object({
    nodes: z.array(ScopeNodePlacementSchema).min(1),
    ports: z.array(ScopePortSchema),
    edges: z.array(ScopeEdgeSchema),
  });

  function sendCompositionError(reply: any, error: unknown) {
    if (error instanceof ScopeCompositionNotFoundError) {
      return reply.code(404).send({ error: "scope_composition_not_found", revision_id: error.revision_id });
    }
    if (error instanceof ScopeCompositionInvalidError) {
      return reply.code(400).send({ error: "scope_composition_invalid", reason: error.reason });
    }
    if (error instanceof ScopeCompositionImmutableError) {
      return reply.code(409).send({ error: "scope_composition_immutable", revision_id: error.revision_id });
    }
    if (error instanceof ScopeCompositionConflictError) {
      return reply.code(409).send({
        error: "scope_composition_conflict",
        scope_id: error.scope_id,
        expected_revision_id: error.expected_revision_id,
        actual_revision_id: error.actual_revision_id,
      });
    }
    throw error;
  }

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/compositions", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), scope_id: z.string().min(1) }).parse(request.params);
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({ error: "scope_not_found", ...params });
    }
    return {
      published_revision_id: store.getScope(params.workspace_id, params.scope_id)?.published_revision_id ?? null,
      revisions: store.listScopeCompositionRevisions(params.workspace_id, params.scope_id),
    };
  });

  app.post("/v1/workspaces/:workspace_id/scopes/:scope_id/compositions", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), scope_id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      content: ScopeCompositionContentSchema,
      based_on_revision_id: z.string().min(1).nullable().optional(),
      created_by_endpoint_id: z.string().min(1).nullable().optional(),
    }).parse(request.body);
    try {
      const revision = store.createScopeCompositionDraft({
        workspace_id: params.workspace_id,
        scope_id: params.scope_id,
        based_on_revision_id: body.based_on_revision_id ?? null,
        created_by_endpoint_id: body.created_by_endpoint_id ?? null,
        content: body.content as ScopeCompositionContent,
      }, broadcast);
      return reply.code(201).send({ revision });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        return reply.code(404).send({ error: "scope_not_found", ...params });
      }
      return sendCompositionError(reply, error);
    }
  });

  app.patch("/v1/workspaces/:workspace_id/scopes/:scope_id/compositions/:revision_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1),
      revision_id: z.string().min(1),
    }).parse(request.params);
    const body = z.object({
      content: ScopeCompositionContentSchema,
      expected_digest: z.string().min(1).optional(),
    }).parse(request.body);
    const existing = store.getScopeCompositionRevision(params.revision_id);
    if (existing && (existing.workspace_id !== params.workspace_id || existing.scope_id !== params.scope_id)) {
      return reply.code(404).send({ error: "scope_composition_not_found", revision_id: params.revision_id });
    }
    try {
      const revision = store.replaceScopeCompositionDraft(
        params.revision_id,
        body.content as ScopeCompositionContent,
        broadcast,
        body.expected_digest,
      );
      return { revision };
    } catch (error) {
      return sendCompositionError(reply, error);
    }
  });

  app.post("/v1/workspaces/:workspace_id/scopes/:scope_id/compositions/:revision_id/publish", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1),
      revision_id: z.string().min(1),
    }).parse(request.params);
    const body = z.object({
      expected_published_revision_id: z.string().min(1).nullable().optional(),
    }).parse(request.body ?? {});
    const existing = store.getScopeCompositionRevision(params.revision_id);
    if (!existing || existing.workspace_id !== params.workspace_id || existing.scope_id !== params.scope_id) {
      return reply.code(404).send({ error: "scope_composition_not_found", revision_id: params.revision_id });
    }
    try {
      const revision = store.publishScopeComposition({
        revision_id: params.revision_id,
        ...(body.expected_published_revision_id !== undefined
          ? { expected_published_revision_id: body.expected_published_revision_id }
          : {}),
      }, broadcast);
      return { revision };
    } catch (error) {
      return sendCompositionError(reply, error);
    }
  });

  app.get("/v1/workspaces/:workspace_id/compositions/:revision_id", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), revision_id: z.string().min(1) }).parse(request.params);
    const revision = store.getScopeCompositionRevision(params.revision_id);
    if (!revision || revision.workspace_id !== params.workspace_id) {
      return reply.code(404).send({ error: "scope_composition_not_found", revision_id: params.revision_id });
    }
    return { revision };
  });

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/graphs", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    return { graphs: store.listScopeGraphs(params.workspace_id, params.scope_id) };
  });

  app.post("/v1/workspaces/:workspace_id/scopes/:scope_id/graphs", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({
      nodes: z.array(ScopeGraphNodeSchema).min(1),
      created_by_endpoint_id: z.string().min(1).nullable().optional()
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    try {
      const graph = store.createScopeGraph({
        workspace_id: params.workspace_id,
        scope_id: params.scope_id,
        created_by_endpoint_id: body.created_by_endpoint_id ?? null,
        nodes: body.nodes as ScopeGraphNode[]
      }, broadcast);
      return reply.code(201).send({ graph });
    } catch (err) {
      if (err instanceof ScopeGraphInvalidError) {
        return reply.code(400).send({ error: "scope_graph_invalid", reason: err.reason });
      }
      throw err;
    }
  });

  app.get("/v1/workspaces/:workspace_id/graphs", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string()
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { graphs: store.listScopeGraphsForWorkspace(params.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/graphs/:graph_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      graph_id: z.string().min(1)
    }).parse(request.params);
    const graph = store.getScopeGraph(params.workspace_id, params.graph_id);
    if (!graph) {
      return reply.code(404).send({
        error: "scope_graph_not_found",
        workspace_id: params.workspace_id,
        graph_id: params.graph_id
      });
    }
    return { graph };
  });

  app.post("/v1/workspaces/:workspace_id/graphs/:graph_id/nodes/:node_id/fire", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      graph_id: z.string().min(1),
      node_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({
      content: z.record(z.unknown()).default({}),
      correlation_id: z.string().nullable().optional(),
      idempotency_key: z.string().min(1).nullable().optional()
    }).parse(request.body ?? {});
    try {
      const events = store.fireScopeGraphTrigger({
        workspace_id: params.workspace_id,
        graph_id: params.graph_id,
        node_id: params.node_id,
        content: body.content,
        correlation_id: body.correlation_id ?? null,
        idempotency_key: body.idempotency_key ?? null
      }, broadcast);
      return reply.code(201).send({ events });
    } catch (err) {
      if (err instanceof ScopeGraphNotFoundError) {
        return reply.code(404).send({
          error: "scope_graph_not_found",
          workspace_id: err.workspace_id,
          graph_id: err.graph_id
        });
      }
      if (err instanceof ScopeGraphNodeNotFoundError) {
        return reply.code(404).send({
          error: "scope_graph_node_not_found",
          graph_id: err.graph_id,
          node_id: err.node_id
        });
      }
      if (err instanceof ScopeGraphNodeNotATriggerError) {
        return reply.code(400).send({
          error: "scope_graph_node_not_a_trigger",
          graph_id: err.graph_id,
          node_id: err.node_id
        });
      }
      if (err instanceof ScopeRetiredError) {
        return reply.code(409).send({
          error: "scope_retired",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      throw err;
    }
  });

  app.post("/v1/workspaces/:workspace_id/scopes", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      scope_id: z.string().min(1).optional(),
      title: z.string().min(1),
      description: z.string().nullable().optional()
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    const receipt = await invokeWorkspaceCompatibility(request, reply, {
      workspace_id: params.workspace_id, operation_id: "scope.create", value: body,
    });
    if (!receipt) return reply;
    return reply.code(201).send({ ...(receipt.result as { scope: unknown }), receipt_id: receipt.receipt_id });
  });
  app.patch("/v1/workspaces/:workspace_id/scopes/:scope_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional()
    }).refine((value) => "title" in value || "description" in value, {
      message: "At least one Scope metadata field is required"
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    const scope = store.updateScope({
      workspace_id: params.workspace_id,
      scope_id: params.scope_id,
      title: body.title,
      description: body.description
    }, broadcast);
    if (!scope) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    return { scope };
  });

  app.post("/v1/workspaces/:workspace_id/scopes/:scope_id/retire", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id,
      });
    }
    return store.retireScope(params.workspace_id, params.scope_id, broadcast);
  });

  app.delete("/v1/workspaces/:workspace_id/scopes/:scope_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      store.deleteScope(params.workspace_id, params.scope_id, broadcast);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ScopeReservedIdError) {
        return reply.code(400).send({
          error: "scope_id_reserved",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ScopeNotEmptyError) {
        return reply.code(409).send({
          error: "scope_not_empty",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id,
          context_count: err.context_count,
          pulse_count: err.pulse_count
        });
      }
      throw err;
    }
  });

  function resolveWorkspaceLocator(workspaceId: string, reply: any): string | null {
    const locator = store.getWorkspaceLocator(workspaceId);
    if (!locator) {
      reply.code(404);
      reply.send({ error: "workspace_local_binding_not_found" });
      return null;
    }
    return locator;
  }

  function mapScopeProjectionLayoutError(err: unknown, reply: any): { error: string; message: string } | null {
    if (!(err instanceof Error)) return null;
    switch (err.name) {
      case "ScopeProjectionLayoutValidationError":
        reply.code(400);
        return { error: "scope_projection_layout_validation_error", message: err.message };
      case "ScopeProjectionLayoutIdMismatchError":
        reply.code(400);
        return { error: "scope_projection_layout_id_mismatch", message: err.message };
      case "ScopeProjectionLayoutRendererInvalidError":
        reply.code(400);
        return { error: "scope_projection_layout_renderer_invalid", message: err.message };
      default:
        return null;
    }
  }

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string(),
      renderer: z.string()
    }).parse(request.params);
    if (!isValidRenderer(params.renderer)) {
      reply.code(400);
      return { error: "scope_projection_layout_renderer_invalid", message: `renderer '${params.renderer}' is not a valid renderer identity` };
    }
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const layout = loadScopeProjectionLayout(locator, params.scope_id, params.renderer);
      if (!layout) {
        reply.code(404);
        return { error: "scope_projection_layout_not_found" };
      }
      return { layout };
    } catch (err) {
      const mapped = mapScopeProjectionLayoutError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.put("/v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string(),
      renderer: z.string()
    }).parse(request.params);
    if (!isValidRenderer(params.renderer)) {
      reply.code(400);
      return { error: "scope_projection_layout_renderer_invalid", message: `renderer '${params.renderer}' is not a valid renderer identity` };
    }
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const layout = upsertScopeProjectionLayout(locator, params.scope_id, params.renderer, request.body);
      broadcast("scope_projection.layout.upserted", {
        workspace_id: params.workspace_id,
        scope_id: params.scope_id,
        source: "api",
        renderer: params.renderer
      });
      return { layout };
    } catch (err) {
      const mapped = mapScopeProjectionLayoutError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post("/v1/workspaces/register", async (request, reply) => {
    const input = z.object({
      locator: z.string().min(1),
      name: z.string().optional(),
      init_authorized: z.boolean().optional(),
      create_directory: z.boolean().optional()
    }).parse(request.body);
    return invokeHostWorkspaceCompatibility(
      request,
      reply,
      REGISTER_WORKSPACE_OPERATION_ID,
      null,
      input,
      201,
    );
  });

  const WorkspaceIdentitySnapshotSchema = z.object({
    workspace_id: z.string().min(1),
    name: z.string().min(1),
    creation_kind: z.enum(["created", "legacy_retained", "copied", "forked"]),
    source_workspace_id: z.string().min(1).nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  });

  app.post("/v1/local/workspaces/:workspace_id/rebind", async (request, reply) => {
    const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const input = z.object({
      locator: z.string().min(1),
      expected_binding_id: z.string().min(1),
      init_authorized: z.boolean().optional(),
    }).parse(request.body);
    return invokeHostWorkspaceCompatibility(
      request,
      reply,
      REBIND_WORKSPACE_OPERATION_ID,
      { kind: "workspace", id: params.workspace_id },
      input,
      200,
    );
  });

  app.post("/v1/local/workspaces/restore", async (request, reply) => {
    const input = z.object({
      snapshot: WorkspaceIdentitySnapshotSchema,
      locator: z.string().min(1),
      init_authorized: z.boolean().optional(),
    }).parse(request.body);
    return invokeHostWorkspaceCompatibility(
      request,
      reply,
      RESTORE_WORKSPACE_OPERATION_ID,
      null,
      input,
      201,
    );
  });

  for (const kind of ["copied", "forked"] as const) {
    const route = kind === "copied" ? "copy-identity" : "fork-identity";
    app.post(`/v1/local/workspaces/:workspace_id/${route}`, async (request, reply) => {
      const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
      const input = z.object({
        name: z.string().min(1),
        locator: z.string().min(1),
        init_authorized: z.boolean().optional(),
      }).parse(request.body);
      return invokeHostWorkspaceCompatibility(
        request,
        reply,
        kind === "copied" ? COPY_WORKSPACE_OPERATION_ID : FORK_WORKSPACE_OPERATION_ID,
        { kind: "workspace", id: params.workspace_id },
        input,
        201,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace filesystem surface
  // ---------------------------------------------------------------------------
  // Plain HTTP direct disk I/O on the box that runs the bus — the same shape
  // as /v1/workspaces/register above. Exists because the console (floe-app)
  // is usually NOT co-located with workspace files (e.g. a Windows console
  // tunneled into a Linux substrate), so a Tauri/browser-local FS read can't
  // see `.floe/agents/`. Gated on workspace_access.local_paths; everything
  // here is additive and does not change any existing route's behavior.

  function fsAccessEnabled(): boolean {
    return config.bridge.workspace_access.local_paths === true;
  }

  function sendFsDisabled(reply: any) {
    return reply.code(403).send({ error: "fs_disabled", message: "workspace_access.local_paths is disabled" });
  }

  function mapFsError(err: unknown, reply: any): { error: string; message: string } {
    if (err instanceof PathEscapesRootError) {
      reply.code(400);
      return { error: "path_escapes_root", message: err.message };
    }
    if (err instanceof RootNotFoundError) {
      reply.code(404);
      return { error: "workspace_root_not_found", message: err.message };
    }
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      reply.code(404);
      return { error: "file_not_found", message: err instanceof Error ? err.message : "Not found" };
    }
    reply.code(500);
    // Do not surface the raw filesystem error (it can carry absolute paths and
    // OS detail) to the caller. Log it for the operator; return a generic error.
    console.error("floe-bus: filesystem operation failed:", err instanceof Error ? err.stack ?? err.message : String(err));
    return { error: "fs_error", message: "The bus could not complete the filesystem operation." };
  }

  /** GET /v1/fs/capability — cheap probe so floe-app can decide whether to show file-editing UI. */
  app.get("/v1/fs/capability", async () => ({
    local_paths: fsAccessEnabled()
  }));

  /** GET /v1/fs/browse?path=<abs> — directory browser for the register-workspace folder picker. */
  app.get("/v1/fs/browse", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    return browseDir(query.path);
  });

  app.get("/v1/workspaces/:workspace_id/fs/agents", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    return { files: listAgentFiles(locator) };
  });

  app.get("/v1/workspaces/:workspace_id/fs/file", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const resolved = resolveWithinRoot(locator, query.path);
      const contents = readFileSync(resolved, "utf8");
      return { contents };
    } catch (err) {
      return reply.send(mapFsError(err, reply));
    }
  });

  app.get("/v1/workspaces/:workspace_id/fs/media", async (request, reply) => {
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    const mediaType = workspaceMediaType(query.path);
    if (!mediaType) {
      return reply.code(415).send({ error: "unsupported_media", message: "Only raster image previews are supported." });
    }
    try {
      const resolved = resolveWithinRoot(locator, query.path);
      if (statSync(resolved).size > MAX_WORKSPACE_MEDIA_BYTES) {
        return reply.code(413).send({ error: "media_too_large", message: "The image exceeds the 20MB preview limit." });
      }
      reply.header("cache-control", "no-store");
      return reply.type(mediaType).send(readFileSync(resolved));
    } catch (err) {
      return reply.send(mapFsError(err, reply));
    }
  });

  /**
   * Exact canonical ArtefactVersion content. The stored path never reaches the
   * client through this transport, and mutable bytes are refused unless they
   * still match the immutable version digest.
   */
  app.get("/v1/workspaces/:workspace_id/artefact-versions/:artefact_version_id/content", async (request, reply) => {
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({
      workspace_id: z.string().min(1),
      artefact_version_id: z.string().min(1),
    }).parse(request.params);
    const transport = requireWorkspaceOperation(request, reply, params.workspace_id);
    if (!transport && !testBypassedRequests.has(request)) return reply;
    if (transport && !transport.verification.authority.grants.has(INSPECT_ARTEFACT_OPERATION_ID)) {
      return reply.code(403).send({
        error: "operation_grant_required",
        message: "The current principal is not authorised to inspect Artefact content.",
      });
    }
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const content = resolveArtefactVersionContent({
        store: store.artefactStore,
        workspace_id: params.workspace_id,
        workspace_locator: locator,
        artefact_version_id: params.artefact_version_id,
      });
      reply.header("cache-control", "no-store");
      reply.header("etag", `"sha256:${content.digest.value}"`);
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-floe-artefact-version-id", content.artefact_version_id);
      if (content.media_type === "text/html") {
        // Reading HTML does not grant it execution in the authenticated origin.
        reply.header("content-disposition", "attachment");
        reply.header("content-security-policy", "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'");
      }
      return reply.type(content.media_type).send(content.bytes);
    } catch (error) {
      if (error instanceof ArtefactContentNotFoundError) {
        return reply.code(404).send({ error: error.code, message: error.message });
      }
      if (error instanceof ArtefactContentUnresolvedError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
          resolver_id: error.resolver_id,
        });
      }
      if (error instanceof ArtefactContentMismatchError) {
        return reply.code(409).send({ error: error.code, message: error.message, reason: error.reason });
      }
      if (error instanceof ArtefactContentTooLargeError) {
        return reply.code(413).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({
        error: "artefact_content_resolution_failed",
        message: "Floe could not resolve the exact ArtefactVersion content.",
      });
    }
  });

  app.put("/v1/workspaces/:workspace_id/fs/file", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      path: z.string().min(1),
      contents: z.string()
    }).parse(request.body);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const resolved = resolveWithinRoot(locator, body.path);
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, body.contents, "utf8");
      return { ok: true };
    } catch (err) {
      return reply.send(mapFsError(err, reply));
    }
  });

  app.post("/v1/workspaces/:workspace_id/select", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const workspace = store.selectWorkspace(params.workspace_id, broadcast);
    return { workspace };
  });

  app.post("/v1/workspaces/:workspace_id/delete", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      delete_locator: z.boolean().optional()
    }).parse(request.body ?? {});
    return store.deleteWorkspace(params.workspace_id, { delete_locator: body.delete_locator ?? false }, broadcast);
  });

  app.post("/v1/workspaces/:workspace_id/attachment-result", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      bridge_id: z.string().optional(),
      binding_id: z.string().min(1),
      status: z.string(),
      config_hash: z.string().nullable().optional(),
      error_code: z.string().nullable().optional(),
      validation: z.unknown().optional()
    }).parse(request.body);
    if (body.bridge_id && body.bridge_id !== bridgeAuthority.bridge_id) {
      return sendTransportForbidden(reply);
    }
    try {
      return {
        workspace: store.reportAttachment({
          workspace_id: params.workspace_id,
          binding_id: body.binding_id,
          bridge_id: bridgeAuthority.bridge_id,
          status: body.status,
          config_hash: body.config_hash ?? null,
          error_code: body.error_code ?? null,
          validation: body.validation
        }, broadcast)
      };
    } catch (error) {
      return sendWorkspaceOperationError(error, reply);
    }
  });

  app.get("/v1/workspaces/:workspace_id/config-status", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return { workspace: store.getRemoteWorkspace(params.workspace_id) };
  });

  app.post("/v1/workspaces/:workspace_id/config-snapshot", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return store.requestConfigSnapshot(params.workspace_id, broadcast);
  });

  app.post("/v1/workspaces/:workspace_id/import-config", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({ binding_id: z.string().min(1) }).passthrough().parse(request.body);
    try {
      return store.importWorkspaceConfiguration(params.workspace_id, body.binding_id, body, broadcast);
    } catch (error) {
      return sendWorkspaceOperationError(error, reply);
    }
  });

  app.post("/v1/workspaces/:workspace_id/apply-config", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return reply;
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({ config_id: z.string().nullable().optional() }).parse(request.body ?? {});
    return store.requestApplyConfig(params.workspace_id, body.config_id ?? null, broadcast);
  });

  app.get("/v1/runtime/bindings", async (request) => {
    const query = z.object({ workspace_id: z.string().optional() }).parse(request.query);
    return { bindings: store.listRuntimeBindings(query.workspace_id) };
  });

  app.post("/v1/runtime/bindings", async (request, reply) => {
    const body = RuntimeBindingUpsertSchema.parse(request.body);
    const binding = store.upsertRuntimeBinding({
      scope: body.scope,
      workspace_id: body.workspace_id ?? null,
      endpoint_id: body.endpoint_id ?? null,
      auth_profile: body.auth_profile,
      provider: body.provider,
      model: body.model ?? null,
      thinking_level: body.thinking_level ?? null
    }, broadcast);
    if (body.scope === "agent" && body.endpoint_id && body.workspace_id) {
      const endpoint = store.getEndpoint(body.endpoint_id) as any;
      if (endpoint && String(endpoint.status) === "runtime_unconfigured") {
        const resolution = store.getRuntimeBindingResolution(body.workspace_id, body.endpoint_id);
        const hasModel = resolution.endpoint_model || resolution.workspace_model || resolution.global_model;
        if (hasModel) store.updateEndpointStatus(body.endpoint_id, "idle", broadcast);
      }
    }
    if (body.scope === "workspace_default" && body.workspace_id) {
      const endpoints = store.listEndpoints(body.workspace_id) as any[];
      for (const endpoint of endpoints) {
        if (endpoint.bridge_id && String(endpoint.status) === "runtime_unconfigured") {
          const resolution = store.getRuntimeBindingResolution(body.workspace_id, String(endpoint.endpoint_id));
          const hasModel = resolution.endpoint_model || resolution.workspace_model || resolution.global_model;
          if (hasModel) store.updateEndpointStatus(String(endpoint.endpoint_id), "idle", broadcast);
        }
      }
    }
    return reply.code(201).send({ binding });
  });

  app.post("/v1/runtime/bindings/clear", async (request) => {
    const body = RuntimeBindingClearSchema.parse(request.body);
    const result = store.clearRuntimeBinding({
      scope: body.scope,
      workspace_id: body.workspace_id ?? null,
      endpoint_id: body.endpoint_id ?? null
    }, broadcast);
    if (body.scope === "agent" && body.endpoint_id) {
      store.updateEndpointStatus(body.endpoint_id, "runtime_unconfigured", broadcast);
    }
    if (body.scope === "workspace_default" && body.workspace_id) {
      const endpoints = store.listEndpoints(body.workspace_id) as any[];
      for (const endpoint of endpoints) {
        if (endpoint.bridge_id) {
          store.updateEndpointStatus(String(endpoint.endpoint_id), "runtime_unconfigured", broadcast);
        }
      }
    }
    return result;
  });

  app.get("/v1/runtime/bindings/resolve", async (request) => {
    const query = z.object({
      workspace_id: z.string().min(1),
      endpoint_id: z.string().min(1)
    }).parse(request.query);
    return store.getRuntimeBindingResolution(query.workspace_id, query.endpoint_id);
  });

  app.get("/v1/auth/profiles", async () => {
    const profiles = listAuthProfiles(configPath, config);
    return {
      profiles,
      default_auth_profile: typeof config.runtime?.default_auth_profile === "string"
        ? config.runtime.default_auth_profile
        : null
    };
  });

  app.get("/v1/auth/models", async (request) => {
    const query = z.object({ provider: z.string().optional() }).parse(request.query);
    return { models: await listAuthModels(configPath, config, query.provider) };
  });

  // Provision the ephemeral bridge-service credential one Bridge process start
  // needs. This is a host-control bootstrap route (the pre-handler enforces
  // host_control), reached only through the native broker that owns the
  // host-control credential — never an unauthenticated loopback call. Each call
  // revokes prior credentials for the same Bridge/host, so a restart cannot
  // leave a second live authority behind.
  app.post("/v1/bridges/service-credential", async (request, reply) => {
    const body = z.object({ bridge_id: z.string().min(1) }).parse(request.body);
    const issued = store.transportCredentialStore.replaceBridgeServiceCredential({
      bridge_id: body.bridge_id,
      host_id: store.localHostId,
      expires_at: oneDayFromNow(),
    });
    return reply.code(201).send({
      bridge_id: issued.credential.bridge_id,
      bearer_token: issued.bearer_token,
      expires_at: issued.credential.expires_at,
    });
  });

  app.post("/v1/bridges/register", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const body = z.object({
      bridge_id: z.string().min(1).optional(),
      capabilities: z.record(z.unknown()).optional()
    }).parse(request.body);
    if (body.bridge_id && body.bridge_id !== bridgeAuthority.bridge_id) {
      return sendTransportForbidden(reply);
    }
    return reply.code(201).send({
      bridge: store.registerBridge({
        bridge_id: bridgeAuthority.bridge_id,
        capabilities: body.capabilities,
      }, broadcast),
    });
  });

  app.post("/v1/bridges/:bridge_id/liveness", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ bridge_id: z.string() }).parse(request.params);
    if (params.bridge_id !== bridgeAuthority.bridge_id) return sendTransportForbidden(reply);
    store.reportBridgeLiveness(bridgeAuthority.bridge_id);
    return { ok: true };
  });

  app.post("/v1/bridges/liveness", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    store.reportBridgeLiveness(bridgeAuthority.bridge_id);
    return { ok: true };
  });

  app.post("/v1/delivery/:delivery_id/status", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ delivery_id: z.string() }).parse(request.params);
    const body = z.object({
      bridge_id: z.string().optional(),
      state: z.enum(["injected_to_runtime", "acknowledged", "failed", "dead_lettered", "deferred"]),
      error: z.string().nullable().optional()
    }).parse(request.body);
    if (body.bridge_id && body.bridge_id !== bridgeAuthority.bridge_id) {
      return sendTransportForbidden(reply);
    }
    if (
      !testBypassedRequests.has(request)
      && !bridgeOwnsDelivery(store, bridgeAuthority.bridge_id, params.delivery_id)
    ) {
      return sendTransportForbidden(reply);
    }
    return {
      delivery: store.reportDeliveryStatus({
        delivery_id: params.delivery_id,
        bridge_id: bridgeAuthority.bridge_id,
        state: body.state,
        error: body.error ?? null
      }, broadcast)
    };
  });

  app.post("/v1/delivery/:delivery_id/runtime-prepare", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ delivery_id: z.string().min(1) }).parse(request.params);
    if (
      !testBypassedRequests.has(request)
      && !bridgeOwnsDelivery(store, bridgeAuthority.bridge_id, params.delivery_id)
    ) {
      return sendTransportForbidden(reply);
    }
    try {
      return store.prepareRuntimeDelivery({
        delivery_id: params.delivery_id,
        bridge_id: bridgeAuthority.bridge_id,
      }, broadcast);
    } catch (error) {
      return reply.code(409).send({
        error: "runtime_processing_contract_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/v1/delivery/:delivery_id/runtime-credentials/:secret_ref_id", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({
      delivery_id: z.string().min(1),
      secret_ref_id: z.string().min(1),
    }).parse(request.params);
    try {
      const payload = await store.withRuntimeCredential({
        bridge_id: bridgeAuthority.bridge_id,
        delivery_id: params.delivery_id,
        secret_ref_id: params.secret_ref_id,
        operation_id: "credential.use",
        operation: (material) => Buffer.from(material),
      });
      const clear = () => payload.fill(0);
      reply.raw.once("finish", clear);
      reply.raw.once("close", clear);
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "application/octet-stream")
        .send(payload);
    } catch {
      return reply.code(409).send({
        error: "runtime_credential_unavailable",
        message: "The pinned runtime credential is unavailable for this Delivery.",
      });
    }
  });

  app.put("/v1/delivery/:delivery_id/runtime-credentials/:secret_ref_id", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({
      delivery_id: z.string().min(1),
      secret_ref_id: z.string().min(1),
    }).parse(request.params);
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      return reply.code(400).send({
        error: "runtime_credential_refresh_invalid",
        message: "The refreshed runtime credential is invalid.",
      });
    }
    const material = request.body;
    try {
      await store.withRuntimeCredential({
        bridge_id: bridgeAuthority.bridge_id,
        delivery_id: params.delivery_id,
        secret_ref_id: params.secret_ref_id,
        operation_id: "credential.refresh",
        refresh: () => Uint8Array.from(material),
      });
      return reply.code(204).send();
    } catch {
      return reply.code(409).send({
        error: "runtime_credential_refresh_failed",
        message: "The protected runtime credential could not be refreshed.",
      });
    } finally {
      material.fill(0);
    }
  });

  app.get("/v1/endpoints", async (request) => {
    const query = z.object({ workspace_id: z.string().optional() }).parse(request.query);
    return { endpoints: store.listEndpoints(query.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/endpoints", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return { endpoints: store.listEndpoints(params.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/resolve-endpoint", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({ ref: z.string().min(1) }).parse(request.query);
    const endpointId = store.resolveSubscriberEndpointId(params.workspace_id, query.ref);
    const endpoint = store.getEndpoint(endpointId);
    return { endpoint_id: endpointId, found: !!endpoint };
  });

  app.post("/v1/endpoints/register", async (request, reply) => {
    const body = z.object({
      endpoint_id: z.string().min(1),
      workspace_id: z.string().min(1),
      name: z.string().min(1),
      agent_id: z.string().nullable().optional(),
      bridge_id: z.string().nullable().optional(),
      status: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(request.body);
    const authority = requestAuthorities.get(request);
    // The native host owner seeds actors that belong to the substrate itself,
    // not to any Bridge. This is the authenticated path `floe register` uses to
    // create the default operator actor. A host-owned registration may only
    // create a bridgeless endpoint; anything Bridge-owned must be registered by
    // the Bridge that owns it.
    if (authority?.audience === "host_control") {
      if (body.bridge_id) return sendTransportForbidden(reply);
      return reply.code(201).send({
        endpoint: store.registerEndpoint({ ...body, bridge_id: null }, broadcast),
      });
    }
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    if (body.bridge_id && body.bridge_id !== bridgeAuthority.bridge_id) {
      return sendTransportForbidden(reply);
    }
    if (
      !testBypassedRequests.has(request)
      && !bridgeMayUseWorkspace(store, bridgeAuthority, body.workspace_id)
    ) {
      return sendTransportForbidden(reply);
    }
    return reply.code(201).send({
      endpoint: store.registerEndpoint({ ...body, bridge_id: bridgeAuthority.bridge_id }, broadcast),
    });
  });

  // --- Client identity: unprivileged keypair authentication (ADR-0015) ---
  // Admission is the trust anchor: only host_control may add a public key to the
  // roster. This is the same authority class as seeding the operator actor.
  const identityRelay = (config.bus.http_base_url ?? "").replace(/\/+$/, "");

  app.post("/v1/identities", async (request, reply) => {
    const authority = requestAuthorities.get(request);
    if (authority?.audience !== "host_control") return sendTransportForbidden(reply);
    const body = z.object({
      display_name: z.string().min(1).max(200),
      pubkey: z.string().min(1),
      workspace_id: z.string().min(1),
    }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "identity_request_invalid" });
    if (!store.getWorkspace(body.data.workspace_id)) return reply.code(404).send({ error: "workspace_not_found" });
    const pubkeyHex = normalizePubkeyToHex(body.data.pubkey);
    if (!pubkeyHex) return reply.code(400).send({ error: "identity_pubkey_invalid" });
    const identity = store.clientIdentityStore.admitIdentity({
      pubkey_hex: pubkeyHex,
      display_name: body.data.display_name,
      principal_id: store.localOperatorPrincipalId,
      admitted_by: authority.credential_id,
    });
    // Admission binds the identity to the workspace it may act in (ADR-0015 F3).
    store.clientIdentityStore.addWorkspaceMembership({
      identity_id: identity.identity_id,
      workspace_id: body.data.workspace_id,
      admitted_by: authority.credential_id,
    });
    return reply.code(201).send({
      identity: publicIdentity(identity),
      workspaces: identityWorkspaces(store, identity.identity_id),
    });
  });

  // Challenge issuance is public and workspace-independent: possessing an
  // admitted key is proven at the authenticate step, and the workspace a bearer
  // is scoped to is chosen there, not here. The Bus is authoritative for the
  // exact relay string the client must echo, sidestepping URL normalization.
  app.get("/v1/identity/challenge", async (_request, reply) => {
    if (!identityRelay) return reply.code(503).send({ error: "identity_relay_unconfigured" });
    const issued = store.clientIdentityStore.issueChallenge({ relay: identityRelay });
    reply.header("cache-control", "no-store");
    return { challenge: issued.challenge, relay: issued.relay, expires_at: issued.expires_at };
  });

  // Authentication is unprivileged: a valid NIP-42 signature over a live
  // challenge by an admitted, non-revoked key resolves the identity's admitted
  // workspaces and, for a chosen (or single) workspace, mints the same scoped
  // workspace_operation bearer the local desktop path already issues. The
  // client learns its workspaces here rather than being told one out of band.
  app.post("/v1/identity/authenticate", async (request, reply) => {
    const body = z.object({
      auth_event: z.record(z.unknown()),
      workspace_id: z.string().min(1).optional(),
    }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "identity_auth_request_invalid" });

    const challenge = challengeTagOf(body.data.auth_event);
    const consumed = challenge ? store.clientIdentityStore.consumeChallenge(challenge) : null;
    if (!consumed) return sendIdentityAuthFailed(reply);

    const verification = verifyAuthEvent(body.data.auth_event, {
      relay: consumed.relay,
      challenge,
      now_ms: Date.now(),
    });
    if (!verification.ok) return sendIdentityAuthFailed(reply);

    const identity = store.clientIdentityStore.getIdentityByPubkey(verification.pubkey_hex);
    if (!identity || identity.revoked_at !== null) return sendIdentityAuthFailed(reply);

    const workspaces = identityWorkspaces(store, identity.identity_id);
    // Choose the workspace to scope the bearer to. An explicit request must be
    // one this identity was admitted to; otherwise a lone membership is minted
    // for convenience, and multiple memberships require the client to choose.
    let targetWorkspaceId: string | null = null;
    if (body.data.workspace_id) {
      if (!store.clientIdentityStore.isMemberOfWorkspace(identity.identity_id, body.data.workspace_id)) {
        return reply.code(403).send({ error: "identity_not_admitted_to_workspace", workspaces });
      }
      targetWorkspaceId = body.data.workspace_id;
    } else if (workspaces.length === 1) {
      targetWorkspaceId = workspaces[0].workspace_id;
    }

    reply.header("cache-control", "no-store");
    if (!targetWorkspaceId) {
      // Admitted but no single workspace resolved: report the set so the client
      // can re-authenticate naming one. No bearer is minted.
      return {
        bearer_token: null,
        workspace_id: null,
        workspace_selection_required: workspaces.length > 1,
        identity: publicIdentity(identity),
        workspaces,
      };
    }

    const host = transportAuthenticator.authenticateHostControl(localControlToken);
    if (!host.verified || host.authority.audience !== "host_control") {
      return reply.code(503).send({ error: "identity_mint_unavailable" });
    }
    const session = issueWorkspaceOperationSession(
      host.authority,
      targetWorkspaceId,
      { interaction_session_id: `client-identity:${identity.identity_id}:${randomUUID()}`, expires_in_seconds: 3_600 },
      `floe-client-identity:${identity.identity_id}`,
    );
    store.clientIdentityStore.recordSession({
      authority_session_id: session.authority_session_id,
      identity_id: identity.identity_id,
      workspace_id: targetWorkspaceId,
      issued_at: new Date().toISOString(),
      expires_at: session.expires_at,
    });
    return {
      bearer_token: session.bearer_token,
      workspace_id: session.workspace_id,
      expires_at: session.expires_at,
      identity: publicIdentity(identity),
      workspaces,
    };
  });

  // Legibility and revocation are host_control. The operator sees exactly who
  // holds a bearer and can revoke a named identity's live sessions immediately.
  app.get("/v1/clients", async (request, reply) => {
    const authority = requestAuthorities.get(request);
    if (authority?.audience !== "host_control") return sendTransportForbidden(reply);
    const nowMs = Date.now();
    const clients = store.clientIdentityStore.listIdentities().map((identity) => ({
      ...publicIdentity(identity),
      workspaces: identityWorkspaces(store, identity.identity_id),
      sessions: store.clientIdentityStore.listSessionsForIdentity(identity.identity_id)
        .filter((session) => Date.parse(session.expires_at) > nowMs)
        .map((session) => ({
          authority_session_id: session.authority_session_id,
          workspace_id: session.workspace_id,
          issued_at: session.issued_at,
          expires_at: session.expires_at,
        })),
    }));
    return { clients };
  });

  app.delete("/v1/clients/:identity_id", async (request, reply) => {
    const authority = requestAuthorities.get(request);
    if (authority?.audience !== "host_control") return sendTransportForbidden(reply);
    const params = z.object({ identity_id: z.string().min(1) }).parse(request.params);
    const identity = store.clientIdentityStore.getIdentity(params.identity_id);
    if (!identity) return reply.code(404).send({ error: "identity_not_found" });
    store.clientIdentityStore.revokeIdentity(identity.identity_id);
    for (const session of store.clientIdentityStore.listSessionsForIdentity(identity.identity_id)) {
      store.operationAuthoritySessions.revokeSession(session.authority_session_id);
    }
    return { revoked: true, identity_id: identity.identity_id };
  });

  app.delete("/v1/endpoints/:endpoint_id", async (request, reply) => {
    const params = z.object({ endpoint_id: z.string() }).parse(request.params);
    try {
      const result = store.deleteEndpoint(params.endpoint_id, broadcast);
      return reply.send(result);
    } catch (err) {
      return reply.code(404).send({ ok: false, error: err instanceof Error ? err.message : "Not found" });
    }
  });

  app.post("/v1/endpoints/:endpoint_id/retire", async (request, reply) => {
    const params = z.object({ endpoint_id: z.string().min(1) }).parse(request.params);
    try {
      return store.retireEndpoint(params.endpoint_id, broadcast);
    } catch (err) {
      if (err instanceof EndpointRetirementBlockedError) {
        return reply.code(409).send({
          ok: false,
          error: "endpoint_busy",
          endpoint_id: err.endpoint_id,
          status: err.status,
          message: err.message,
        });
      }
      return reply.code(404).send({ ok: false, error: err instanceof Error ? err.message : "Not found" });
    }
  });

  app.post("/v1/endpoints/:endpoint_id/status", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ endpoint_id: z.string() }).parse(request.params);
    const body = z.object({ status: z.string().min(1) }).parse(request.body);
    if (
      !testBypassedRequests.has(request)
      && !bridgeOwnsEndpoint(store, bridgeAuthority.bridge_id, params.endpoint_id)
    ) {
      return sendTransportForbidden(reply);
    }
    return { endpoint: store.updateEndpointStatus(params.endpoint_id, body.status, broadcast) };
  });

  app.post("/v1/events/emit", async (request, reply) => {
    const parsed = EventCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "invalid_event_command",
          message: "Invalid event command",
          issues: parsed.error.issues
        }
      });
    }
    const command = parsed.data as EventCommand;
    const transportAuthority = requestAuthorities.get(request);
    if (
      transportAuthority?.audience === "bridge_service"
      && !bridgeOwnsWorkspaceEndpoint(
        store,
        transportAuthority.bridge_id,
        command.workspace_id,
        command.source_endpoint_id,
      )
    ) {
      return sendTransportForbidden(reply);
    }
    try {
      const result = store.submitEvent(command, broadcast, EVENT_INGRESS_CAPABILITY);
      return reply.code(202).send({
        ok: true,
        event_id: result.event.event_id,
        accepted_at: result.event.created_at,
        deliveries_created: result.deliveries_created,
        event: result.event
      });
    } catch (err) {
      if (err instanceof ContextParticipantError) {
        return reply.code(409).send({ ok: false, error: err.payload });
      }
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      throw err;
    }
  });

  app.get("/v1/events", async (request, reply) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      thread_id: z.string().optional(),
      context_id: z.string().optional(),
      scope_id: z.string().optional(),
      type: z.string().min(1).optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      direction: z.enum(["forward", "backward"]).optional().default("forward"),
      limit: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    if (
      (query.since && query.before)
      || (query.direction === "backward" && query.since)
      || (query.direction === "forward" && query.before)
    ) {
      return reply.code(400).send({
        error: "invalid_event_pagination",
        message: "Forward Event reads use since; backward Event reads use before."
      });
    }
    let events;
    try {
      events = store.listEvents(query);
    } catch (err) {
      if (err instanceof InvalidEventCursorError) {
        return reply.code(400).send({ error: "invalid_event_cursor", since: err.value });
      }
      throw err;
    }
    // Forward reads retain the cursor contract used by runtimes and endpoint
    // watermarks. Backward reads expose the oldest returned Event as the cursor
    // for the next earlier page; clients may receive one final empty page when
    // the total happens to be an exact multiple of the requested page size.
    const last = events[events.length - 1];
    const first = events[0];
    const next_cursor = query.direction === "forward" && last
      ? encodeEventCursor({ created_at: last.created_at, event_id: last.event_id })
      : null;
    const previous_cursor = query.direction === "backward" && first && events.length === (query.limit ?? 100)
      ? encodeEventCursor({ created_at: first.created_at, event_id: first.event_id })
      : null;
    return query.direction === "backward"
      ? { events, next_cursor, previous_cursor }
      : { events, next_cursor };
  });

  app.get("/v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      endpoint_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { watermark: store.getEndpointWatermark(params.workspace_id, params.endpoint_id) };
  });

  app.put("/v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      endpoint_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({ cursor: z.string().min(1) }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      const watermark = store.setEndpointWatermark(params.workspace_id, params.endpoint_id, body.cursor);
      return { watermark };
    } catch (err) {
      if (err instanceof InvalidEventCursorError) {
        return reply.code(400).send({ error: "invalid_event_cursor", cursor: err.value });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Context API (Slice 2) — thin wrappers over ContextStore
  // ---------------------------------------------------------------------------

  function encodeContextCursor(row: { activity_at: string; context_id: string }): string {
    return Buffer.from(JSON.stringify({ activity_at: row.activity_at, context_id: row.context_id }), "utf8")
      .toString("base64url");
  }

  function decodeContextCursor(value: string | undefined): { activity_at: string; context_id: string } | undefined {
    if (!value) return undefined;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return z.object({
      activity_at: z.string().datetime(),
      context_id: z.string().min(1),
    }).parse(parsed);
  }

  function serializeContextListRow(r: {
    context_id: string;
    workspace_id: string;
    scope_id: string | null;
    parent_context_id: string | null;
    created_by_endpoint_id: string | null;
    created_by_principal_id?: string | null;
    created_at: string;
    last_event_at: string | null;
    activity_at: string;
    participants: string[];
    title?: string | null;
    updated_at?: string;
    state_revision?: number;
    lifecycle_state?: string;
    content_state?: string;
  }, deliverySummary?: { active_count: number; latest_state: string | null }) {
    const latestMessageRow = store.db.prepare(
      "SELECT event_id FROM events WHERE context_id = ? AND type = 'message' ORDER BY created_at DESC LIMIT 1"
    ).get(r.context_id) as { event_id: string } | undefined;
    return {
      context_id: r.context_id,
      workspace_id: r.workspace_id,
      scope_id: r.scope_id,
      parent_context_id: r.parent_context_id,
      created_by_endpoint_id: r.created_by_endpoint_id,
      created_by_principal_id: r.created_by_principal_id ?? null,
      created_at: r.created_at,
      last_event_at: r.last_event_at,
      activity_at: r.activity_at,
      participants: r.participants,
      title: (r.title as string | null | undefined) ?? null,
      updated_at: r.updated_at ?? r.created_at,
      state_revision: r.state_revision ?? 1,
      lifecycle_state: r.lifecycle_state ?? "active",
      content_state: r.content_state ?? "available",
      first_message_preview: store.contextStore.getFirstMessagePreview(r.context_id),
      latest_message_preview: store.contextStore.getLatestMessagePreview(r.context_id),
      latest_message: latestMessageRow ? store.getEvent(latestMessageRow.event_id) : null,
      delivery_summary: deliverySummary ?? { active_count: 0, latest_state: null },
    };
  }

  function serializeContextListRows(rows: Array<Parameters<typeof serializeContextListRow>[0]>) {
    const summaries = store.getContextDeliverySummaries(rows.map(row => row.context_id));
    return rows.map(row => serializeContextListRow(row, summaries.get(row.context_id)));
  }

  app.get("/v1/workspaces/:workspace_id/contexts", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({
      scope: z.enum(["all", "scoped", "unscoped"]).optional().default("all"),
      scope_id: z.string().min(1).optional(),
      limit: z.coerce.number().int().positive().max(200).optional().default(50),
      before: z.string().min(1).optional()
    }).parse(request.query);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    // Scope-filtered query uses the indexed listContextsForScope path
    if (query.scope_id) {
      const rows = store.contextStore.listContextsForScope(params.workspace_id, query.scope_id);
      return { contexts: serializeContextListRows(rows) };
    }
    let before: { activity_at: string; context_id: string } | undefined;
    try {
      before = decodeContextCursor(query.before);
    } catch {
      return reply.code(400).send({ error: "invalid_context_cursor" });
    }
    const rows = store.contextStore.listContextsForWorkspace(params.workspace_id, {
      scope: query.scope,
      limit: query.limit + 1,
      before,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      contexts: serializeContextListRows(page),
      next_cursor: hasMore && page.length > 0 ? encodeContextCursor(page.at(-1)!) : null,
    };
  });

  app.get("/v1/contexts", async (request, reply) => {
    const query = z.object({
      participant: z.string().min(1),
      workspace_id: z.string().optional(),
      scope_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().default(20),
      before: z.string().min(1).optional(),
    }).parse(request.query);
    let before: { activity_at: string; context_id: string } | undefined;
    try {
      before = decodeContextCursor(query.before);
    } catch {
      return reply.code(400).send({ error: "invalid_context_cursor" });
    }
    const rows = store.contextStore.listContextsForParticipant(query.participant, {
      workspace_id: query.workspace_id,
      scope_id: query.scope_id,
      limit: query.limit + 1,
      before,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      contexts: serializeContextListRows(page),
      next_cursor: hasMore && page.length > 0 ? encodeContextCursor(page.at(-1)!) : null,
    };
  });

  app.get("/v1/contexts/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return {
      ...ctx,
      participants: store.contextStore.getContextParticipants(ctx.context_id),
      first_message_preview: store.contextStore.getFirstMessagePreview(ctx.context_id)
    };
  });

  app.get("/v1/contexts/:id/tree", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().positive().max(500).optional().default(200),
    }).parse(request.query);
    const context = store.contextStore.getContext(params.id);
    if (!context) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const rows = store.contextStore.listContextTree(params.id, query.limit + 1);
    return {
      contexts: serializeContextListRows(rows.slice(0, query.limit)),
      truncated: rows.length > query.limit,
    };
  });

  app.get("/v1/contexts/:id/events", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    if (!store.contextStore.getContext(params.id)) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return { events: store.listEvents({ context_id: params.id, limit: query.limit }) };
  });

  app.post("/v1/workspaces/:workspace_id/contexts", async (request, reply) => {
    const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const bodySchema = z.object({
      participants: z.array(z.string().min(1)).optional().default([]),
      scope_id: z.string().min(1).nullable().optional(),
      context_id: z.string().min(1).optional(),
      created_by_endpoint_id: z.string().min(1).nullable().optional(),
      title: z.string().min(1).nullable().optional(),
      // Slice 1 Track B — parent context linking
      parent_context_id: z.string().min(1).nullable().optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_request", issues: parsed.error.issues });
    }
    const body = parsed.data;
    // Require at least participants OR scope_id
    if (body.participants.length === 0 && !body.scope_id) {
      return reply.code(400).send({ ok: false, error: "invalid_request", issues: [{ message: "participants must be non-empty when scope_id is absent" }] });
    }
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    const receipt = await invokeWorkspaceCompatibility(request, reply, {
      workspace_id: params.workspace_id,
      operation_id: CREATE_CONTEXT_OPERATION_ID,
      value: {
        participants: body.participants.map((participant_id) => ({ participant_id })),
        scope_id: body.scope_id ?? null,
        ...(body.context_id ? { context_id: body.context_id } : {}),
        title: body.title ?? null,
        parent_context_id: body.parent_context_id ?? null,
      },
    });
    if (!receipt) return reply;
    const ctx = (receipt.result as { context: import("./contexts/store.js").CanonicalContextRecord }).context;
    const contextId = ctx.context_id;
    const participants = store.contextStore.getContextParticipants(contextId);
    const serialized = serializeContextListRow({
      ...ctx,
      last_event_at: null,
      activity_at: ctx.created_at,
      participants,
    });
    return reply.code(201).send({ context: serialized, receipt_id: receipt.receipt_id });
  });

  app.post("/v1/workspaces/:workspace_id/contexts/:context_id/assign-scope", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      context_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({
      scope_id: z.string().min(1),
      assigned_by: z.string().min(1).nullable().optional(),
      reason: z.string().min(1).nullable().optional()
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ ok: false, error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      return store.assignContextScope({
        workspace_id: params.workspace_id,
        context_id: params.context_id,
        scope_id: body.scope_id,
        assigned_by: body.assigned_by ?? null,
        reason: body.reason ?? null
      }, broadcast);
    } catch (err) {
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      if (err instanceof ContextScopeAssignmentError) {
        return reply.code(409).send({
          ok: false,
          error: "context_scope_assignment_invalid",
          workspace_id: err.workspace_id,
          context_id: err.context_id,
          reason: err.reason
        });
      }
      throw err;
    }
  });

  app.delete("/v1/contexts/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const context = store.contextStore.getContext(params.id);
    if (!context) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const receipt = await invokeWorkspaceCompatibility(request, reply, {
      workspace_id: context.workspace_id,
      operation_id: ARCHIVE_CONTEXT_OPERATION_ID,
      target: { kind: "context", id: params.id },
      expected_revision: String(context.state_revision),
      value: { reason: "Removed from active conversation navigation" },
    });
    if (!receipt) return reply;
    return {
      ok: true,
      context_id: params.id,
      workspace_id: context.workspace_id,
      archived: true,
      events_deleted: 0,
      delivery_bundles_deleted: 0,
      pulse_subscribers_deleted: 0,
      receipt_id: receipt.receipt_id,
    };
  });

  // Slice 1 Track A — dynamic participants
  app.post("/v1/contexts/:id/participants", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ endpoint_id: z.string().min(1) }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const receipt = await invokeWorkspaceCompatibility(request, reply, {
      workspace_id: ctx.workspace_id,
      operation_id: SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
      target: { kind: "context", id: params.id },
      expected_revision: String(ctx.state_revision),
      value: { participant_id: body.endpoint_id, role: "participant", access: "contribute" },
    });
    if (!receipt) return reply;
    const result = receipt.result as { changed: boolean };
    return { ok: true, context_id: params.id, endpoint_id: body.endpoint_id, added: result.changed, receipt_id: receipt.receipt_id };
  });

  app.delete("/v1/contexts/:id/participants/:endpoint_id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), endpoint_id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const receipt = await invokeWorkspaceCompatibility(request, reply, {
      workspace_id: ctx.workspace_id,
      operation_id: REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID,
      target: { kind: "context", id: params.id },
      expected_revision: String(ctx.state_revision),
      value: { participant_id: params.endpoint_id },
    });
    if (!receipt) return reply;
    const result = receipt.result as { removed: boolean };
    return { ok: true, context_id: params.id, endpoint_id: params.endpoint_id, removed: result.removed, receipt_id: receipt.receipt_id };
  });

  // Slice 1 Track B — context linking (children query)
  app.get("/v1/contexts/:id/children", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!store.contextStore.getContext(params.id)) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const rows = store.contextStore.listContextsForParent(params.id);
    return { contexts: serializeContextListRows(rows) };
  });

  // Slice 2 — per-actor, per-context, per-event-type subscriptions
  app.post("/v1/contexts/:id/subscriptions", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      endpoint_id: z.string().min(1),
      event_types: z.array(z.string().min(1)).optional().default(["*"]),
    }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    store.contextStore.subscribeToContext(params.id, body.endpoint_id, body.event_types);
    return { ok: true, context_id: params.id, endpoint_id: body.endpoint_id, event_types: body.event_types };
  });

  app.delete("/v1/contexts/:id/subscriptions/:endpoint_id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), endpoint_id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    store.contextStore.unsubscribeFromContext(params.id, params.endpoint_id);
    return { ok: true, context_id: params.id, endpoint_id: params.endpoint_id };
  });

  app.get("/v1/contexts/:id/subscriptions", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!store.contextStore.getContext(params.id)) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return { subscriptions: store.contextStore.getContextSubscriptions(params.id) };
  });

  // Batch apply — participants + subscriptions in one atomic operation
  app.post("/v1/contexts/:id/subscriptions:batch", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      entries: z.array(
        z.object({
          endpoint_id: z.string().min(1),
          event_types: z.array(z.string()),
        })
      ),
      participants_only: z.array(z.string().min(1)).optional().default([]),
    }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    store.contextStore.applyContextSubscriptions(params.id, body.entries, body.participants_only);
    return { ok: true, context_id: params.id };
  });

  // Slice 0 — context compaction + clear-history
  app.post("/v1/contexts/:id/compact", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      summary: z.string().min(1),
      before_event_id: z.string().min(1).optional(),
    }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const activeCheck = store.db
      .prepare("SELECT 1 AS x FROM delivery_bundles WHERE state = 'active' AND workspace_id = ? LIMIT 1")
      .get(ctx.workspace_id);
    if (activeCheck) {
      return reply.code(409).send({ error: "active_delivery_in_progress", message: "Cannot compact while a delivery is active" });
    }
    const summary_event_id = store.contextStore.compactContext(params.id, body.summary, body.before_event_id);
    broadcast("context_compacted", { context_id: params.id, summary_event_id });
    return { ok: true, context_id: params.id, summary_event_id };
  });

  app.post("/v1/contexts/:id/clear-history", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const activeCheck = store.db
      .prepare("SELECT 1 AS x FROM delivery_bundles WHERE state = 'active' AND workspace_id = ? LIMIT 1")
      .get(ctx.workspace_id);
    if (activeCheck) {
      return reply.code(409).send({ error: "active_delivery_in_progress", message: "Cannot clear history while a delivery is active" });
    }
    const result = store.contextStore.clearContextHistory(params.id);
    broadcast("context_history_cleared", { context_id: params.id, events_deleted: result.events_deleted });
    return { ok: true, context_id: params.id, events_deleted: result.events_deleted };
  });

  // ---------------------------------------------------------------------------
  app.get("/v1/delivery/claim", async (request, reply) => {
    // A client executes its Actor's turns out-of-process. It claims by naming
    // its own client-executed Endpoint; it can never claim a Bridge-owned one.
    const clientAuthority = requestAuthorities.get(request);
    if (clientAuthority?.audience === "workspace_operation") {
      const query = z.object({
        endpoint_id: z.string().min(1),
        limit: z.coerce.number().int().positive().max(100).optional()
      }).parse(request.query);
      const endpoint = store.getEndpoint(query.endpoint_id) as { workspace_id?: string } | null;
      if (!endpoint || endpoint.workspace_id !== clientAuthority.workspace_id
        || !store.isClientExecutedEndpoint(query.endpoint_id)) {
        return sendTransportForbidden(reply);
      }
      return {
        deliveries: store.claimClientDeliveries(
          clientAuthority.workspace_id,
          query.endpoint_id,
          query.limit ?? 10,
          broadcast,
        ),
      };
    }
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const query = z.object({
      bridge_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(100).optional()
    }).parse(request.query);
    if (query.bridge_id && query.bridge_id !== bridgeAuthority.bridge_id) {
      return sendTransportForbidden(reply);
    }
    return {
      deliveries: store.claimDeliveries(bridgeAuthority.bridge_id, query.limit ?? 10, broadcast),
    };
  });

  app.get("/v1/delivery", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      context_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { deliveries: store.listDeliveries(query) };
  });
  app.post("/v1/runtime/telemetry", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const body = z.object({
      workspace_id: z.string().min(1),
      endpoint_id: z.string().min(1),
      delivery_id: z.string().nullable().optional(),
      kind: z.string().min(1),
      payload: z.record(z.unknown())
    }).parse(request.body);
    if (
      !testBypassedRequests.has(request)
      && !bridgeOwnsWorkspaceEndpoint(
        store,
        bridgeAuthority.bridge_id,
        body.workspace_id,
        body.endpoint_id,
      )
    ) {
      return sendTransportForbidden(reply);
    }
    if (
      !testBypassedRequests.has(request)
      && body.delivery_id
      && !bridgeOwnsDelivery(store, bridgeAuthority.bridge_id, body.delivery_id)
    ) {
      return sendTransportForbidden(reply);
    }
    const telemetry = store.appendRuntimeTelemetry({
      workspace_id: body.workspace_id,
      endpoint_id: body.endpoint_id,
      delivery_id: body.delivery_id ?? null,
      kind: body.kind,
      payload: body.payload
    }, broadcast);
    return reply.code(202).send({ ok: true, telemetry });
  });

  app.post("/v1/runtime/turn-result", async (request, reply) => {
    // A client-executed turn ends the same way a model's does: report the
    // result by delivery_id. No context, no assembled event, no correlation id.
    const clientAuthority = requestAuthorities.get(request);
    if (clientAuthority?.audience === "workspace_operation") {
      const body = z.object({
        delivery_id: z.string().min(1),
        outcome: z.enum(["completed", "failed"]).optional(),
        text: z.string().min(1),
        metadata: z.record(z.unknown()).optional()
      }).parse(request.body);
      try {
        const result = store.recordClientTurnResult({
          workspace_id: clientAuthority.workspace_id,
          delivery_id: body.delivery_id,
          outcome: body.outcome ?? "completed",
          text: body.text,
          metadata: body.metadata
        }, broadcast);
        return reply.code(202).send({ ok: true, ...result });
      } catch {
        return sendTransportForbidden(reply);
      }
    }
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const body = z.object({
      delivery_id: z.string().min(1),
      outcome: z.enum(["completed", "failed"]),
      text: z.string().min(1),
      metadata: z.record(z.unknown()).optional()
    }).parse(request.body);
    if (
      !testBypassedRequests.has(request)
      && !bridgeOwnsDelivery(store, bridgeAuthority.bridge_id, body.delivery_id)
    ) {
      return sendTransportForbidden(reply);
    }
    const result = store.recordRuntimeTurnResult({
      delivery_id: body.delivery_id,
      outcome: body.outcome,
      text: body.text,
      metadata: body.metadata
    }, broadcast);
    return reply.code(202).send({ ok: true, ...result });
  });

  app.get("/v1/runtime/telemetry", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      delivery_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { records: store.listRuntimeTelemetry(query) };
  });

  app.get("/v1/events/:event_id/trace", async (request, reply) => {
    const params = z.object({ event_id: z.string().min(1) }).parse(request.params);
    const trace = store.getEventTrace(params.event_id);
    if (!trace) {
      return reply.code(404).send({ error: "event_not_found", event_id: params.event_id });
    }
    return trace;
  });

  app.post("/v1/endpoints/:endpoint_id/turn-end", async (request, reply) => {
    const bridgeAuthority = requireBridgeService(request, reply);
    if (!bridgeAuthority) return reply;
    const params = z.object({ endpoint_id: z.string().min(1) }).parse(request.params);
    if (
      !testBypassedRequests.has(request)
      && !bridgeOwnsEndpoint(store, bridgeAuthority.bridge_id, params.endpoint_id)
    ) {
      return sendTransportForbidden(reply);
    }
    return { endpoint: store.reportTurnEnd(params.endpoint_id, broadcast) };
  });

  app.get("/v1/pending-responses", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      destination_endpoint_id: z.string().optional(),
      waiting_endpoint_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { pending: store.listPendingResponses(query) };
  });

  app.get("/v1/configs", async () => ({ configs: store.listConfigs() }));

  app.post("/v1/configs", async (request, reply) => {
    const body = z.object({
      name: z.string().min(1),
      config: z.record(z.unknown())
    }).parse(request.body);
    return reply.code(201).send({ config: store.createConfig(body, broadcast) });
  });

  app.post("/v1/webhooks/:workspace_id/:route_id", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), route_id: z.string() }).parse(request.params);
    try {
      const event = store.ingestWebhook(params.workspace_id, params.route_id, request.body as Record<string, unknown>, broadcast);
      return reply.code(202).send({ ok: true, event });
    } catch (err) {
      if (err instanceof ScopeRequiredError) {
        return reply.code(400).send({
          ok: false,
          error: "scope_required",
          workspace_id: err.workspace_id,
          reason: err.reason
        });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Pulse API
  // ---------------------------------------------------------------------------

  const pulseScheduler = new PulseScheduler((pulseId) => {
    firePulse(pulseId, store, broadcast, pulseScheduler);
  });

  app.post("/v1/pulses", async (request, reply) => {
    const parsed = z.object({
      pulse_id: z.string().min(1),
      workspace_id: z.string().min(1),
      persistence: z.enum(["workspace", "local"]).optional(),
      scope_id: z.string().min(1).nullable().optional(),
      current_context_id: z.string().min(1).nullable().optional(),
      trigger: z.object({
        type: z.enum(["once", "cron"]),
        at: z.string().optional(),
        schedule: z.string().optional(),
          timezone: z.string().optional()
      }),
      event: z.object({
        type: z.literal("pulse.fired"),
        content: z.record(z.unknown()).optional()
      }).optional(),
      content: z.record(z.unknown()).optional(),
      subscribers: z.array(PulseSubscriberSchema),
      created_by: z.string().optional()
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "invalid_pulse_command",
          message: "Invalid pulse command",
          issues: parsed.error.issues
        }
      });
    }
    const body = parsed.data;
    let pulse: unknown;
    try {
      pulse = store.createPulse({
        ...body,
        persistence: body.persistence as PulsePersistence | undefined,
        content: body.event?.content ?? body.content ?? {},
        subscribers: body.subscribers as PulseSubscriber[]
      }, broadcast);
    } catch (err) {
      if (err instanceof WorkspacePortabilityError && err.code === "workspace_restore_held") {
        return reply.code(409).send({
          ok: false,
          error: err.code,
          reason: err.message,
          ...err.details,
        });
      }
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      if (err instanceof ContextAnchorError) {
        return reply.code(400).send({
          ok: false,
          error: "context_anchor_invalid",
          workspace_id: err.workspace_id,
          context_id: err.context_id,
          reason: err.reason
        });
      }
      if (err instanceof ScopeRequiredError) {
        return reply.code(400).send({
          ok: false,
          error: "scope_required",
          workspace_id: err.workspace_id,
          reason: err.reason
        });
      }
      throw err;
    }
    // Schedule in the priority queue
    const record = pulse as any;
    if (record.status === "active" && record.next_fire_at) {
      pulseScheduler.addPulse(record.pulse_id, new Date(record.next_fire_at));
    }
    return reply.code(201).send({ pulse });
  });

  app.get("/v1/pulses", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      status: z.string().optional(),
      scope_id: z.string().optional()
    }).parse(request.query);
    return { pulses: store.listPulses(query) };
  });

  app.post("/v1/pulses/:pulse_id/pause", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    pulseScheduler.removePulse(params.pulse_id);
    return { pulse: store.updatePulseStatus(params.pulse_id, "paused", broadcast) };
  });

  app.post("/v1/pulses/:pulse_id/resume", async (request, reply) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    let pulse: any;
    try {
      pulse = store.updatePulseStatus(params.pulse_id, "active", broadcast) as any;
    } catch (err) {
      if (err instanceof WorkspacePortabilityError && err.code === "workspace_restore_held") {
        return reply.code(409).send({
          ok: false,
          error: err.code,
          reason: err.message,
          ...err.details,
        });
      }
      throw err;
    }
    if (pulse) {
      const trigger = pulse.trigger as { type: string; schedule?: string; timezone?: string; at?: string };
      if (trigger.type === "cron") {
        // Recalculate next fire from now on resume
        const nextFireAt = store.calculateNextFireAt(trigger);
        if (nextFireAt) {
          store.db.prepare("UPDATE pulses SET next_fire_at = ? WHERE pulse_id = ?").run(nextFireAt, params.pulse_id);
          pulseScheduler.addPulse(params.pulse_id, new Date(nextFireAt));
        }
      } else if (pulse.next_fire_at) {
        pulseScheduler.addPulse(params.pulse_id, new Date(pulse.next_fire_at));
      }
    }
    return { pulse: store.getPulse(params.pulse_id) };
  });

  app.post("/v1/pulses/:pulse_id/cancel", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    pulseScheduler.removePulse(params.pulse_id);
    return { pulse: store.updatePulseStatus(params.pulse_id, "cancelled", broadcast) };
  });

  app.post("/v1/pulses/:pulse_id/subscribe", async (request, reply) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const body = PulseSubscriberSchema.parse(request.body) as PulseSubscriber;
    try {
      store.addPulseSubscriber(params.pulse_id, body);
    } catch (err) {
      if (err instanceof PulseNotFoundError) {
        return reply.code(404).send({ ok: false, error: "pulse_not_found", pulse_id: err.pulse_id });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      if (err instanceof ContextAnchorError) {
        return reply.code(400).send({
          ok: false,
          error: "context_anchor_invalid",
          workspace_id: err.workspace_id,
          context_id: err.context_id,
          reason: err.reason
        });
      }
      if (err instanceof ScopeRequiredError) {
        return reply.code(400).send({
          ok: false,
          error: "scope_required",
          workspace_id: err.workspace_id,
          reason: err.reason
        });
      }
      throw err;
    }
    const pulse = store.getPulse(params.pulse_id);
    broadcast("pulse_subscriber_changed", { pulse_id: params.pulse_id, subscriber: body, pulse });
    return { ok: true, pulse };
  });

  app.post("/v1/pulses/:pulse_id/unsubscribe", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const body = PulseSubscriberSchema.parse(request.body) as PulseSubscriber;
    store.removePulseSubscriber(params.pulse_id, body);
    const pulse = store.getPulse(params.pulse_id);
    broadcast("pulse_subscriber_changed", { pulse_id: params.pulse_id, subscriber: body, pulse });
    return { ok: true, pulse };
  });

  // Hydrate scheduler from persisted pulse state on startup
  const activePulses = store.getActivePulsesForScheduler();
  for (const pulse of activePulses) {
    if (pulse.next_fire_at) {
      pulseScheduler.addPulse(pulse.pulse_id, new Date(pulse.next_fire_at));
    }
  }
  pulseScheduler.start();

  app.addHook("onClose", async () => {
    pulseScheduler.stop();
  });

  return {
    app,
    store,
    routes: registeredRoutes,
    localControlToken,
    issueBridgeServiceCredential: (bridgeId, expiresAt = oneDayFromNow()) =>
      store.transportCredentialStore.issueBridgeServiceCredential({
        bridge_id: bridgeId,
        host_id: store.localHostId,
        expires_at: expiresAt,
      }),
    replaceBridgeServiceCredential: (bridgeId, expiresAt = oneDayFromNow()) =>
      store.transportCredentialStore.replaceBridgeServiceCredential({
        bridge_id: bridgeId,
        host_id: store.localHostId,
        expires_at: expiresAt,
      }),
    rotateBridgeServiceCredential: (
      credentialId,
      bridgeId,
      expiresAt = oneDayFromNow(),
    ) => store.transportCredentialStore.rotateBridgeServiceCredential({
      transport_credential_id: credentialId,
      bridge_id: bridgeId,
      expires_at: expiresAt,
    }),
    revokeBridgeServiceCredential: (credentialId, bridgeId) =>
      store.transportCredentialStore.revokeBridgeServiceCredential(credentialId, bridgeId),
    broadcast,
    listen: async () => {
      const { host, port } = parseListen(config.bus.listen);
      await app.listen({ host, port });
    }
  };
}

export type TransportRequirement =
  | Readonly<{ kind: "public" | "websocket" | "credential_ingress" | "attachment_ingress" | "host_control" | "bridge_or_host" }>
  | Readonly<{ kind: "bridge_service"; workspace_id: string | null }>
  | Readonly<{ kind: "workspace_operation"; workspace_id: string }>
  | Readonly<{ kind: "bridge_or_workspace"; workspace_id: string | null }>
  | Readonly<{ kind: "bridge_workspace_or_host"; workspace_id: string }>
  | Readonly<{ kind: "workspace_conflict"; workspace_ids: readonly string[] }>;

export function resolveTransportRequirement(request: any, store: BusStore): TransportRequirement {
  const route = String(request.routeOptions?.url ?? request.url?.split("?", 1)[0] ?? "");
  const method = String(request.method ?? "GET").toUpperCase();
  if (route === "/health") return { kind: "public" };
  if (route === HTML_PREVIEW_HOST_PATH) return { kind: "public" };
  // Each browser adapter route checks its origin-bound cookie itself. It never
  // accepts caller-authored principal, grant, Workspace, or host authority.
  if (route === "/v1/browser/connections" || route === "/v1/browser/connections/claim" || route === "/v1/browser/session" || route === "/v1/browser/session/local" || route === "/v1/browser/session/models") return { kind: "public" };
  if (["/v1/browser/providers", "/v1/browser/providers/:provider/connect", "/v1/browser/providers/:provider/runtime-access", "/v1/browser/provider-connections/:id/answer"].includes(route)) return { kind: "public" };
  if (["/v1/browser/host/operations", "/v1/browser/host/operations/invoke", "/v1/browser/host/operation-receipts/:receipt_id"].includes(route)) return { kind: "public" };
  if (route === "/v1/events/stream") return { kind: "websocket" };
  // Client identity challenge/authenticate are public: possession of an admitted
  // key is proven by the signature inside the handler, not by a bearer (ADR-0015).
  if (route === "/v1/identity/challenge" || route === "/v1/identity/authenticate") {
    return { kind: "public" };
  }
  // This transfer route authenticates its one-time, purpose-bound ingress
  // credential inside the handler. It must not be interpreted as a reusable
  // Bus transport credential by the generic pre-handler.
  if (route === "/v1/credential-ingress-sessions/:ingress_session_id/material") {
    return { kind: "credential_ingress" };
  }
  if (route === "/v1/attachment-ingress-sessions/:ingress_session_id/content") {
    return { kind: "attachment_ingress" };
  }
  const workspace = resolveRequestWorkspace(request, store);
  if (workspace.conflicted) {
    return { kind: "workspace_conflict", workspace_ids: workspace.workspace_ids };
  }

  // Endpoint registration has two legitimate registrants under distinct
  // authorities: a Bridge registering an agent endpoint it owns, or the native
  // host owner (broker/CLI) seeding a self-owned actor that belongs to no
  // Bridge — the substrate seeding itself with the default operator actor. The
  // handler enforces which endpoints each authority may create; a host-owned
  // registration may only create a bridgeless actor.
  if (route === "/v1/endpoints/register" && method === "POST") {
    return { kind: "bridge_or_host" };
  }

  // Claim and turn-result are the two acts a delivery's executor performs. An
  // in-process Bridge and an out-of-process client both perform them; the
  // handler scopes the client to its own client-executed Endpoint. Either
  // authority is accepted here; neither can reach the other's Endpoints.
  if (
    route === "/v1/delivery/claim"
    || route === "/v1/runtime/turn-result"
  ) {
    return { kind: "bridge_or_workspace", workspace_id: workspace.workspace_id };
  }

  if (
    route.startsWith("/v1/bridge/")
    || route === "/v1/bridges/register"
    || route === "/v1/bridges/liveness"
    || route === "/v1/bridges/:bridge_id/liveness"
    || route === "/v1/delivery/:delivery_id/status"
    || route === "/v1/delivery/:delivery_id/runtime-prepare"
    || route === "/v1/delivery/:delivery_id/runtime-credentials/:secret_ref_id"
    || (route === "/v1/runtime/telemetry" && method === "POST")
    || (route === "/v1/endpoints/:endpoint_id/status" && method === "POST")
    || route === "/v1/endpoints/:endpoint_id/turn-end"
    || route === "/v1/workspaces/:workspace_id/attachment-result"
    || route === "/v1/workspaces/:workspace_id/import-config"
  ) {
    return { kind: "bridge_service", workspace_id: workspace.workspace_id };
  }

  if (
    route.startsWith("/v1/local/")
    || route === "/v1/local-config/status"
    || route === "/v1/workspaces"
    || route === "/v1/workspaces/register"
    || route === "/v1/workspaces/:workspace_id/select"
    || route === "/v1/workspaces/:workspace_id/delete"
    || route === "/v1/workspaces/:workspace_id/config-snapshot"
    || route === "/v1/workspaces/:workspace_id/apply-config"
    || route === "/v1/bridges/service-credential"
    || route.startsWith("/v1/auth/")
    || route === "/v1/runtime/status"
    || route === "/v1/fs/capability"
    || route === "/v1/fs/browse"
    || route === "/v1/workspaces/:workspace_id/fs/agents"
    || route === "/v1/workspaces/:workspace_id/fs/file"
    || route.startsWith("/v1/webhooks/")
    || route === "/v1/identities"
    || route === "/v1/clients"
    || route === "/v1/clients/:identity_id"
    || (route === "/v1/configs" && method !== "GET")
  ) {
    return { kind: "host_control" };
  }

  if (route === "/v1/configs" && method === "GET") {
    return { kind: "bridge_or_host" };
  }

  const workspaceId = workspace.workspace_id;
  if (!workspaceId) return { kind: "host_control" };

  // A runtime binding scoped to "agent" or "workspace_default" always names a
  // Workspace and is Workspace data, not host-only data; only the unscoped
  // "global_default" mutation (no workspace_id resolvable above) still
  // requires host control, via the `!workspaceId` branch above.
  if (
    route === "/v1/runtime/bindings/resolve"
    || route === "/v1/runtime/bindings"
    || route === "/v1/runtime/bindings/clear"
  ) {
    return { kind: "bridge_workspace_or_host", workspace_id: workspaceId };
  }

  if (
    route.startsWith("/v1/contexts")
    || route === "/v1/events"
    || route === "/v1/events/emit"
    || route === "/v1/events/:event_id/trace"
    || route.startsWith("/v1/pulses")
    || route === "/v1/pending-responses"
    || route === "/v1/workspaces/:workspace_id/endpoints"
    || route === "/v1/workspaces/:workspace_id/resolve-endpoint"
    || (route.includes("/graphs") && method === "GET")
    || route === "/v1/workspaces/:workspace_id/config-status"
  ) {
    return { kind: "bridge_or_workspace", workspace_id: workspaceId };
  }
  return { kind: "workspace_operation", workspace_id: workspaceId };
}

function authenticateBridgeOrWorkspace(
  authenticator: BusTransportAuthenticator,
  bearer: string,
  workspaceId: string | null,
) {
  const bridge = authenticator.authenticateBridgeService(bearer);
  if (bridge.verified) return bridge;
  // A client authenticates as workspace_operation, which requires a resolved
  // workspace. If none resolved (e.g. no endpoint_id/delivery_id named the
  // workspace), it cannot be a client act; keep the bridge's failed result.
  if (!workspaceId) return bridge;
  return authenticator.authenticateWorkspaceOperation(bearer, workspaceId);
}

function authenticateBridgeOrHost(
  authenticator: BusTransportAuthenticator,
  bearer: string,
) {
  const bridge = authenticator.authenticateBridgeService(bearer);
  return bridge.verified ? bridge : authenticator.authenticateHostControl(bearer);
}

function authenticateBridgeWorkspaceOrHost(
  authenticator: BusTransportAuthenticator,
  bearer: string,
  workspaceId: string,
) {
  const bridge = authenticator.authenticateBridgeService(bearer);
  if (bridge.verified) return bridge;
  const workspace = authenticator.authenticateWorkspaceOperation(bearer, workspaceId);
  return workspace.verified ? workspace : authenticator.authenticateHostControl(bearer);
}

function authenticateConflictedWorkspaceRequest(
  authenticator: BusTransportAuthenticator,
  bearer: string,
  workspaceIds: readonly string[],
) {
  const process = authenticateBridgeOrHost(authenticator, bearer);
  if (process.verified) return process;
  for (const workspaceId of workspaceIds) {
    const workspace = authenticator.authenticateWorkspaceOperation(bearer, workspaceId);
    if (workspace.verified) return workspace;
  }
  return process;
}

function authenticatePrivilegedSocket(
  authenticator: BusTransportAuthenticator,
  bearer: string,
) {
  return authenticateBridgeOrHost(authenticator, bearer);
}

function sendTransportDenied(reply: any) {
  return reply.code(401).send({
    error: "transport_auth_required",
    message: "The transport credential was not accepted.",
  });
}

function sendTransportForbidden(reply: any) {
  return reply.code(403).send({
    error: "transport_authority_forbidden",
    message: "The authenticated connection cannot act on that resource.",
  });
}

function sendIdentityAuthFailed(reply: any) {
  return reply.code(401).send({
    error: "identity_auth_failed",
    message: "The identity authentication was not accepted.",
  });
}

/** Public projection of an admitted identity; never exposes internal-only fields. */
function publicIdentity(identity: {
  identity_id: string;
  pubkey_hex: string;
  display_name: string;
  admitted_at: string;
  revoked_at: string | null;
}) {
  return {
    identity_id: identity.identity_id,
    display_name: identity.display_name,
    pubkey_hex: identity.pubkey_hex,
    npub: encodeNpub(identity.pubkey_hex),
    admitted_at: identity.admitted_at,
    revoked_at: identity.revoked_at,
  };
}

/**
 * The workspaces an identity may act in, resolved against currently-registered
 * workspaces and reported as { workspace_id, name } so a client can present them
 * to a human and pick one without a host_control workspace listing (ADR-0015 F3).
 */
function identityWorkspaces(store: BusStore, identityId: string): Array<{ workspace_id: string; name: string }> {
  return store.clientIdentityStore.listWorkspaceIdsForIdentity(identityId)
    .map((workspaceId) => {
      const workspace = store.getWorkspace(workspaceId) as { name?: string } | null;
      return workspace ? { workspace_id: workspaceId, name: workspace.name ?? workspaceId } : null;
    })
    .filter((entry): entry is { workspace_id: string; name: string } => entry !== null);
}

/** Read the NIP-42 `challenge` tag value from a candidate event, defensively. */
function challengeTagOf(event: Record<string, unknown>): string {
  const tags = event.tags;
  if (!Array.isArray(tags)) return "";
  for (const tag of tags) {
    if (Array.isArray(tag) && tag.length >= 2 && tag[0] === "challenge" && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return "";
}

type RequestWorkspaceResolution =
  | Readonly<{ conflicted: false; workspace_id: string | null; workspace_ids: readonly string[] }>
  | Readonly<{ conflicted: true; workspace_id: null; workspace_ids: readonly string[] }>;

/**
 * Resolves every explicit and canonical Workspace fact carried by a request.
 * A caller-supplied Workspace is evidence, never precedence: if a referenced
 * Context, Endpoint, Event, Delivery, or Pulse belongs elsewhere, the request
 * is refused before its handler can observe or mutate anything.
 */
function resolveRequestWorkspace(request: any, store: BusStore): RequestWorkspaceResolution {
  const params = asRecord(request.params);
  const query = asRecord(request.query);
  const body = asRecord(request.body);
  const route = String(request.routeOptions?.url ?? request.url?.split("?", 1)[0] ?? "");
  const workspaceIds = new Set<string>();
  const addWorkspace = (candidate: unknown) => {
    if (typeof candidate === "string" && candidate) workspaceIds.add(candidate);
  };
  for (const candidate of [params.workspace_id, query.workspace_id, body.workspace_id]) {
    addWorkspace(candidate);
  }

  const addContext = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate) return;
    addWorkspace(store.contextStore.getContext(candidate)?.workspace_id);
  };
  if (route.startsWith("/v1/contexts") && typeof params.id === "string") addContext(params.id);
  for (const candidate of [
    query.context_id,
    body.context_id,
    body.current_delivery_context_id,
    asRecord(body.destination).context_id,
    asRecord(body.subscriber).context_id,
  ]) addContext(candidate);

  const addEndpoint = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate) return;
    const endpoint = store.getEndpoint(candidate) as { workspace_id?: string } | null;
    addWorkspace(endpoint?.workspace_id);
  };
  for (const candidate of [
    params.endpoint_id,
    query.endpoint_id,
    query.participant,
    body.endpoint_id,
    body.source_endpoint_id,
    asRecord(body.destination).endpoint_id,
    asRecord(body.subscriber).endpoint_id,
  ]) addEndpoint(candidate);
  for (const entry of Array.isArray(body.entries) ? body.entries : []) {
    addEndpoint(asRecord(entry).endpoint_id);
  }
  for (const candidate of Array.isArray(body.participants) ? body.participants : []) addEndpoint(candidate);
  for (const candidate of Array.isArray(body.participants_only) ? body.participants_only : []) addEndpoint(candidate);

  const queryWorkspace = (sql: string, candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate) return;
    const row = store.db.prepare(sql).get(candidate) as { workspace_id?: string } | undefined;
    addWorkspace(row?.workspace_id);
  };
  for (const candidate of [params.event_id, body.event_id, body.cause_event_id]) {
    queryWorkspace("SELECT workspace_id FROM events WHERE event_id = ?", candidate);
  }
  for (const candidate of [params.delivery_id, body.delivery_id]) {
    queryWorkspace(`
      SELECT e.workspace_id
      FROM delivery_bundles d
      JOIN endpoints e ON e.endpoint_id = d.endpoint_id
      WHERE d.delivery_id = ?
    `, candidate);
  }
  for (const candidate of [params.pulse_id, body.pulse_id]) {
    if (typeof candidate !== "string" || !candidate) continue;
    const pulse = store.getPulse(candidate) as { workspace_id?: string } | null;
    addWorkspace(pulse?.workspace_id);
  }

  const resolved = [...workspaceIds].sort((left, right) => left.localeCompare(right));
  return resolved.length > 1
    ? { conflicted: true, workspace_id: null, workspace_ids: resolved }
    : { conflicted: false, workspace_id: resolved[0] ?? null, workspace_ids: resolved };
}

function resolveBroadcastWorkspaceId(
  store: BusStore,
  payload: Record<string, unknown>,
): string | null {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) candidates.add(value);
  };
  add(payload.workspace_id);
  for (const key of [
    "workspace", "scope", "revision", "execution", "node_execution",
    "event", "delivery", "telemetry", "pulse", "context", "endpoint", "binding",
  ]) {
    add(asRecord(payload[key]).workspace_id);
  }

  const queryWorkspace = (sql: string, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const row = store.db.prepare(sql).get(id) as { workspace_id?: string } | undefined;
    add(row?.workspace_id);
  };
  queryWorkspace("SELECT workspace_id FROM events WHERE event_id = ?", payload.event_id);
  queryWorkspace("SELECT workspace_id FROM events WHERE event_id = ?", asRecord(payload.event).event_id);
  queryWorkspace("SELECT workspace_id FROM endpoints WHERE endpoint_id = ?", payload.endpoint_id);
  queryWorkspace("SELECT workspace_id FROM contexts WHERE context_id = ?", payload.context_id);
  queryWorkspace("SELECT workspace_id FROM pulses WHERE pulse_id = ?", payload.pulse_id);
  queryWorkspace("SELECT workspace_id FROM scope_executions WHERE execution_id = ?", payload.scope_execution_id);
  if (typeof payload.delivery_id === "string") {
    queryWorkspace(`
      SELECT e.workspace_id
      FROM delivery_bundles d JOIN endpoints e ON e.endpoint_id = d.endpoint_id
      WHERE d.delivery_id = ?
    `, payload.delivery_id);
  }
  return candidates.size === 1 ? [...candidates][0] ?? null : null;
}

function serializePushEntry(entry: TransportPushEntry): string {
  return JSON.stringify({
    type: entry.type,
    payload: entry.payload,
    at: entry.at,
    cursor: entry.cursor,
  });
}

function mayReceivePushEntry(
  authority: BusTransportAuthority,
  entry: TransportPushEntry,
  store: BusStore,
): boolean {
  if (authority.audience === "host_control") return true;
  if (authority.audience === "workspace_operation") {
    return entry.workspace_id === authority.workspace_id;
  }
  if (entry.workspace_id) return bridgeMayUseWorkspace(store, authority, entry.workspace_id);
  return asRecord(entry.payload).bridge_id === authority.bridge_id;
}

function socketAuthenticationProjection(authority: BusTransportAuthority): Record<string, unknown> {
  if (authority.audience === "host_control") {
    return { audience: authority.audience, host_id: authority.host_id };
  }
  if (authority.audience === "bridge_service") {
    return {
      audience: authority.audience,
      bridge_id: authority.bridge_id,
      host_id: authority.host_id,
    };
  }
  return { audience: authority.audience, workspace_id: authority.workspace_id };
}

function bridgeMayUseWorkspace(
  store: BusStore,
  authority: BridgeServiceAuthority,
  workspaceId: string,
): boolean {
  return store.workspaceIdentityStore.getCurrentBinding(workspaceId, authority.host_id) !== null;
}

function bridgeOwnsEndpoint(store: BusStore, bridgeId: string, endpointId: string): boolean {
  const endpoint = store.getEndpoint(endpointId) as { bridge_id?: string | null } | null;
  return endpoint?.bridge_id === bridgeId;
}

function bridgeOwnsWorkspaceEndpoint(
  store: BusStore,
  bridgeId: string,
  workspaceId: string,
  endpointId: string,
): boolean {
  const endpoint = store.getEndpoint(endpointId) as {
    bridge_id?: string | null;
    workspace_id?: string;
  } | null;
  return endpoint?.bridge_id === bridgeId && endpoint.workspace_id === workspaceId;
}

function bridgeOwnsDelivery(store: BusStore, bridgeId: string, deliveryId: string): boolean {
  const row = store.db.prepare(`
    SELECT e.bridge_id
    FROM delivery_bundles d
    JOIN endpoints e ON e.endpoint_id = d.endpoint_id
    WHERE d.delivery_id = ?
  `).get(deliveryId) as { bridge_id: string | null } | undefined;
  return row?.bridge_id === bridgeId;
}

function bridgeIdentityFromRequest(request: object): string | null {
  const candidate = request as { params?: unknown; query?: unknown; body?: unknown };
  for (const source of [candidate.params, candidate.query, candidate.body]) {
    const bridgeId = asRecord(source).bridge_id;
    if (typeof bridgeId === "string" && bridgeId) return bridgeId;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function oneDayFromNow(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
}

function oneYearFromNow(): string {
  return new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString();
}

function firePulse(pulseId: string, store: BusStore, broadcast: (type: string, payload: Record<string, unknown>) => void, pulseScheduler: PulseScheduler): void {
  const pulse = store.getPulse(pulseId) as any;
  if (!pulse || pulse.status !== "active") return;
  if (store.workspacePortabilityService.isRestoreHeld(String(pulse.workspace_id))) return;

  const subscribers = store.getPulseSubscribers(pulseId);
  if (subscribers.length === 0) return;

  const fireTimestamp = new Date().toISOString();
  const trigger = pulse.trigger as { type: string; schedule?: string; timezone?: string; at?: string };

  for (const subscriber of subscribers) {
    const content = {
      ...pulse.content,
      pulse_id: pulseId
    };
    const metadata = {
      trigger_kind: "pulse",
      pulse_id: pulseId,
      pulse_name: (pulse as any).name ?? pulseId,
      trigger_type: trigger.type,
      schedule: trigger.schedule ?? trigger.at ?? null,
      fire_number: (pulse.fire_count ?? 0) + 1
    };
    try {
      if (subscriber.kind === "context") {
        if (!subscriber.context_id) {
          console.error("[bus] pulse context subscriber missing context_id", { pulse_id: pulseId, subscriber });
          continue;
        }
        store.appendContextEvent({
          type: "pulse.fired",
          workspace_id: pulse.workspace_id,
          context_id: subscriber.context_id,
          correlation_id: null,
          content,
          metadata
        }, broadcast);
      } else {
        if (!subscriber.endpoint_ref) {
          console.error("[bus] pulse endpoint subscriber missing endpoint_ref", { pulse_id: pulseId, subscriber });
          continue;
        }
        const endpointId = store.resolveSubscriberEndpointId(pulse.workspace_id, subscriber.endpoint_ref);
        const contextId = subscriber.context_id ?? store.getOrCreatePulseDeliveryContext({
          pulse_id: pulseId,
          workspace_id: pulse.workspace_id,
          scope_id: (pulse as any).scope_id,
          subscriber,
          endpoint_id: endpointId
        });
        // Per design §3.1.6: pulse.fired is a non-actor trigger. Bus emits with
        // source_endpoint_id = null. No synthetic `system:*` source is created.
        store.emitTriggerEvent(
          {
            type: "pulse.fired",
            workspace_id: pulse.workspace_id,
            target_endpoint_id: endpointId,
            context_id: contextId,
            scope_id: null,
            correlation_id: null,
            content,
            metadata
          },
          broadcast
        );
      }
    } catch (error) {
      console.error("[bus] pulse event emission failed", { pulse_id: pulseId, subscriber, error });
    }
  }

  // For one-off pulses, mark as completed. For cron, calculate next fire time and re-schedule.
  let nextFireAt: string | null = null;
  if (trigger.type === "cron") {
    nextFireAt = store.calculateNextFireAt(trigger);
  }
  store.recordPulseFired(pulseId, nextFireAt);

  if (nextFireAt) {
    pulseScheduler.addPulse(pulseId, new Date(nextFireAt));
  }

  broadcast("pulse_fired", { pulse_id: pulseId, fired_at: fireTimestamp, subscriber_count: subscribers.length });
}
