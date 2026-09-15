import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  createBusServer,
  resolveTransportRequirement,
  type TransportRequirement,
} from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

/**
 * This is the substrate's single authority-boundary guard.
 *
 * It exists because the real defect that bit us was not "a backdoor exists" —
 * it was that nothing anywhere asserted which authority class each privileged
 * route belongs to, so a route could be misclassified (or a new route added
 * unclassified) and no test would notice. Each unit test only exercises its own
 * route, so none of them can catch a route silently escaping the boundary.
 *
 * The test enumerates every route from the router itself (`handle.routes`), not
 * from a hand-written list, so a newly added route cannot quietly escape it:
 *
 *  1. Completeness — the router's route set must exactly equal the declared
 *     authority inventory below. Add a route and you MUST classify it here.
 *  2. Classification — every route resolves to the authority class the
 *     inventory declares. Change a route's authority and this fails until the
 *     inventory is deliberately updated, making the decision visible in review.
 *  3. Rejection — with authentication genuinely ON (no bypass), every route
 *     with a privileged class rejects an unauthenticated request (401). This is
 *     an independent runtime proof, not a re-read of the classifier.
 *
 * `EXPECTED_AUTHORITY` is the declared authority class of each route. It is not
 * a hand-written route list (test 1 derives the route list from the router);
 * it is the reviewed record of what each route's authority is supposed to be.
 */

// Classes that are reachable without a transport credential: `public` routes
// carry no authority, the event stream authenticates its own socket frame, and
// the ingress routes authenticate a one-time, purpose-bound credential inside
// their handler. Every other class MUST reject an unauthenticated request.
const UNAUTHENTICATED_KINDS = new Set<TransportRequirement["kind"]>([
  "public",
  "websocket",
  "credential_ingress",
  "attachment_ingress",
]);

const EXPECTED_AUTHORITY: Record<string, TransportRequirement["kind"]> = {
  ["PUT /v1/attachment-ingress-sessions/:ingress_session_id/content"]: "attachment_ingress",
  ["GET /v1/configs"]: "bridge_or_host",
  ["POST /v1/endpoints/register"]: "bridge_or_host",
  ["DELETE /v1/contexts/:id"]: "bridge_or_workspace",
  ["DELETE /v1/contexts/:id/participants/:endpoint_id"]: "bridge_or_workspace",
  ["DELETE /v1/contexts/:id/subscriptions/:endpoint_id"]: "bridge_or_workspace",
  ["GET /v1/contexts"]: "bridge_or_workspace",
  ["GET /v1/contexts/:id"]: "bridge_or_workspace",
  ["GET /v1/contexts/:id/children"]: "bridge_or_workspace",
  ["GET /v1/contexts/:id/events"]: "bridge_or_workspace",
  ["GET /v1/contexts/:id/subscriptions"]: "bridge_or_workspace",
  ["GET /v1/contexts/:id/tree"]: "bridge_or_workspace",
  ["GET /v1/events"]: "bridge_or_workspace",
  ["GET /v1/events/:event_id"]: "bridge_or_workspace",
  ["GET /v1/events/:event_id/trace"]: "bridge_or_workspace",
  ["GET /v1/pending-responses"]: "bridge_or_workspace",
  ["GET /v1/pulses"]: "bridge_or_workspace",
  ["GET /v1/workspaces/:workspace_id/config-status"]: "bridge_or_workspace",
  ["GET /v1/workspaces/:workspace_id/endpoints"]: "bridge_or_workspace",
  ["GET /v1/workspaces/:workspace_id/graphs"]: "bridge_or_workspace",
  ["GET /v1/workspaces/:workspace_id/graphs/:graph_id"]: "bridge_or_workspace",
  ["GET /v1/workspaces/:workspace_id/resolve-endpoint"]: "bridge_or_workspace",
  ["GET /v1/workspaces/:workspace_id/scopes/:scope_id/graphs"]: "bridge_or_workspace",
  ["POST /v1/contexts/:id/clear-history"]: "bridge_or_workspace",
  ["POST /v1/contexts/:id/compact"]: "bridge_or_workspace",
  ["POST /v1/contexts/:id/participants"]: "bridge_or_workspace",
  ["POST /v1/contexts/:id/subscriptions"]: "bridge_or_workspace",
  ["POST /v1/contexts/:id/subscriptions:batch"]: "bridge_or_workspace",
  ["POST /v1/events/emit"]: "bridge_or_workspace",
  ["POST /v1/pulses"]: "bridge_or_workspace",
  ["POST /v1/pulses/:pulse_id/cancel"]: "bridge_or_workspace",
  ["POST /v1/pulses/:pulse_id/pause"]: "bridge_or_workspace",
  ["POST /v1/pulses/:pulse_id/resume"]: "bridge_or_workspace",
  ["POST /v1/pulses/:pulse_id/subscribe"]: "bridge_or_workspace",
  ["POST /v1/pulses/:pulse_id/unsubscribe"]: "bridge_or_workspace",
  ["GET /v1/bridge/workspace-bindings"]: "bridge_service",
  ["GET /v1/bridge/workspaces/:workspace_id/runtime-endpoints"]: "bridge_service",
  ["GET /v1/delivery/:delivery_id/runtime-credentials/:secret_ref_id"]: "bridge_service",
  ["GET /v1/delivery/claim"]: "bridge_or_workspace",
  ["POST /v1/bridges/:bridge_id/liveness"]: "bridge_service",
  ["POST /v1/bridges/liveness"]: "bridge_service",
  ["POST /v1/bridges/register"]: "bridge_service",
  ["POST /v1/delivery/:delivery_id/runtime-prepare"]: "bridge_service",
  ["POST /v1/delivery/:delivery_id/status"]: "bridge_service",
  ["POST /v1/endpoints/:endpoint_id/status"]: "bridge_service",
  ["POST /v1/endpoints/:endpoint_id/turn-end"]: "bridge_service",
  ["POST /v1/runtime/telemetry"]: "bridge_service",
  ["POST /v1/runtime/turn-result"]: "bridge_or_workspace",
  ["POST /v1/workspaces/:workspace_id/attachment-result"]: "bridge_service",
  ["POST /v1/workspaces/:workspace_id/import-config"]: "bridge_service",
  ["PUT /v1/delivery/:delivery_id/runtime-credentials/:secret_ref_id"]: "bridge_service",
  ["GET /v1/runtime/bindings"]: "bridge_workspace_or_host",
  ["GET /v1/runtime/bindings/resolve"]: "bridge_workspace_or_host",
  ["POST /v1/runtime/bindings"]: "bridge_workspace_or_host",
  ["POST /v1/runtime/bindings/clear"]: "bridge_workspace_or_host",
  ["PUT /v1/credential-ingress-sessions/:ingress_session_id/material"]: "credential_ingress",
  ["GET /v1/auth/models"]: "host_control",
  ["GET /v1/auth/profiles"]: "host_control",
  ["GET /v1/fs/browse"]: "host_control",
  ["GET /v1/fs/capability"]: "host_control",
  ["GET /v1/local-config/status"]: "host_control",
  ["GET /v1/local/browser-connections"]: "host_control",
  ["GET /v1/local/operation-receipts/:receipt_id"]: "host_control",
  ["GET /v1/local/operations"]: "host_control",
  ["GET /v1/local/workspaces"]: "host_control",
  ["GET /v1/runtime/status"]: "host_control",
  ["GET /v1/workspaces"]: "host_control",
  ["GET /v1/workspaces/:workspace_id/fs/agents"]: "host_control",
  ["GET /v1/workspaces/:workspace_id/fs/file"]: "host_control",
  ["POST /v1/bridges/service-credential"]: "host_control",
  ["POST /v1/configs"]: "host_control",
  ["POST /v1/identities"]: "host_control",
  ["GET /v1/clients"]: "host_control",
  ["DELETE /v1/clients/:identity_id"]: "host_control",
  ["POST /v1/local/browser-connections/:code/approve"]: "host_control",
  ["POST /v1/local/credential-ingress-sessions"]: "host_control",
  ["POST /v1/local/credential-ingress-sessions/:ingress_session_id/revoke"]: "host_control",
  ["POST /v1/local/operations/confirm-and-invoke"]: "host_control",
  ["POST /v1/local/operations/invoke"]: "host_control",
  ["POST /v1/local/workspaces/:workspace_id/copy-identity"]: "host_control",
  ["POST /v1/local/workspaces/:workspace_id/fork-identity"]: "host_control",
  ["POST /v1/local/workspaces/:workspace_id/operation-sessions"]: "host_control",
  ["POST /v1/local/workspaces/:workspace_id/operations/confirm-and-invoke"]: "host_control",
  ["POST /v1/local/workspaces/:workspace_id/rebind"]: "host_control",
  ["POST /v1/local/workspaces/restore"]: "host_control",
  // No per-webhook secret is verified in the handler, so the substrate locks
  // this ingest to the native host owner. Externally-triggered webhooks would
  // need their own purpose-bound credential before this could open up.
  ["POST /v1/webhooks/:workspace_id/:route_id"]: "host_control",
  ["POST /v1/workspaces/:workspace_id/apply-config"]: "host_control",
  ["POST /v1/workspaces/:workspace_id/config-snapshot"]: "host_control",
  ["POST /v1/workspaces/:workspace_id/delete"]: "host_control",
  ["POST /v1/workspaces/:workspace_id/select"]: "host_control",
  ["POST /v1/workspaces/register"]: "host_control",
  ["PUT /v1/workspaces/:workspace_id/fs/file"]: "host_control",
  ["DELETE /v1/browser/session"]: "public",
  ["GET /health"]: "public",
  ["GET /v1/browser/host/operation-receipts/:receipt_id"]: "public",
  ["GET /v1/browser/host/operations"]: "public",
  ["GET /v1/browser/session"]: "public",
  ["GET /v1/browser/session/models"]: "public",
  ["GET /v1/previews/html"]: "public",
  ["POST /v1/browser/connections"]: "public",
  ["POST /v1/browser/connections/claim"]: "public",
  ["POST /v1/browser/host/operations/invoke"]: "public",
  ["POST /v1/browser/session/local"]: "public",
  ["GET /v1/identity/challenge"]: "public",
  ["POST /v1/identity/authenticate"]: "public",
  ["GET /v1/events/stream"]: "websocket",
  ["DELETE /v1/endpoints/:endpoint_id"]: "workspace_operation",
  ["DELETE /v1/workspaces/:workspace_id/scopes/:scope_id"]: "workspace_operation",
  ["GET /v1/delivery"]: "workspace_operation",
  ["GET /v1/endpoints"]: "workspace_operation",
  ["GET /v1/runtime/telemetry"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/artefact-versions/:artefact_version_id/content"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/compositions/:revision_id"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/contexts"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/contexts/:context_id/scope-executions"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/diagnostics/contexts/:context_id"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/fs/media"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/operation-receipts/:receipt_id"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/operations"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/scope-executions/:execution_id"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/scopes"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/scopes/:scope_id/compositions"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/scopes/:scope_id/executions"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection"]: "workspace_operation",
  ["GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer"]: "workspace_operation",
  ["PATCH /v1/workspaces/:workspace_id/scopes/:scope_id"]: "workspace_operation",
  ["PATCH /v1/workspaces/:workspace_id/scopes/:scope_id/compositions/:revision_id"]: "workspace_operation",
  ["POST /v1/endpoints/:endpoint_id/retire"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/attachment-ingress-sessions"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/attachment-ingress-sessions/:ingress_session_id/revoke"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/contexts"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/contexts/:context_id/assign-scope"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/graphs/:graph_id/nodes/:node_id/fire"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/operations/invoke"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/scopes"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/scopes/:scope_id/compositions"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/scopes/:scope_id/compositions/:revision_id/publish"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/scopes/:scope_id/graphs"]: "workspace_operation",
  ["POST /v1/workspaces/:workspace_id/scopes/:scope_id/retire"]: "workspace_operation",
  ["PUT /v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark"]: "workspace_operation",
  ["PUT /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer"]: "workspace_operation",
};

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

/**
 * The canonical classification probe. It fills every path param and, for routes
 * that carry no `:workspace_id` segment, supplies a workspace via the query so
 * workspace-scoped routes resolve deterministically to their with-workspace
 * class rather than the no-workspace host-control fallback.
 */
function classify(method: string, url: string, store: ServerHandle["store"]): TransportRequirement {
  const params: Record<string, string> = {};
  let hasWorkspaceParam = false;
  for (const seg of url.split("/")) {
    if (seg.startsWith(":")) {
      const name = seg.slice(1);
      params[name] = name === "workspace_id" ? "ws_test" : `test_${name}`;
      if (name === "workspace_id") hasWorkspaceParam = true;
    }
  }
  const query = hasWorkspaceParam ? {} : { workspace_id: "ws_test" };
  const request = { method, url, routeOptions: { url }, params, query, body: {} };
  return resolveTransportRequirement(request, store);
}

/** A concrete URL that find-my-way routes to the handler (params filled). */
function concreteUrl(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "x");
}

function routeKeys(handle: ServerHandle): string[] {
  return handle.routes
    .filter(route => route.method !== "HEAD" && route.method !== "OPTIONS")
    .map(route => `${route.method} ${route.url}`);
}

describe("Bus transport authority boundary", () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-bus-authority-"));
    const cfgPath = join(tmp, "config.yaml");
    const cfg: LocalConfig = defaultConfig(tmp);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    // Authentication genuinely ON: no unsafe in-process bypass.
    handle = await createBusServer(cfgPath, cfg, { host_control_token: "x".repeat(48) });
    await handle.app.ready();
  });

  afterAll(async () => {
    try { await handle.app.close(); } catch { /* ignore */ }
  });

  it("classifies every registered route in the declared authority inventory", () => {
    const registered = new Set(routeKeys(handle));
    const declared = new Set(Object.keys(EXPECTED_AUTHORITY));

    const unclassified = [...registered].filter(key => !declared.has(key)).sort();
    const stale = [...declared].filter(key => !registered.has(key)).sort();

    expect(
      unclassified,
      `New route(s) must be given an authority class in EXPECTED_AUTHORITY:\n${unclassified.join("\n")}`,
    ).toEqual([]);
    expect(
      stale,
      `EXPECTED_AUTHORITY names route(s) the router no longer registers:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("resolves each route to the authority class it is declared to have", () => {
    const mismatches: string[] = [];
    for (const key of routeKeys(handle)) {
      const expected = EXPECTED_AUTHORITY[key];
      if (!expected) continue;
      const [method, url] = key.split(" ");
      const actual = classify(method, url, handle.store).kind;
      if (actual !== expected) mismatches.push(`${key}: declared ${expected}, resolved ${actual}`);
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("rejects unauthenticated requests to every privileged route", async () => {
    const reachable: string[] = [];
    for (const key of routeKeys(handle)) {
      const kind = EXPECTED_AUTHORITY[key];
      if (!kind || UNAUTHENTICATED_KINDS.has(kind)) continue;
      const [method, url] = key.split(" ");
      const response = await handle.app.inject({ method: method as any, url: concreteUrl(url) });
      if (response.statusCode !== 401) {
        reachable.push(`${key} -> ${response.statusCode} (expected 401)`);
      }
    }
    expect(reachable, `Privileged route(s) reachable without authentication:\n${reachable.join("\n")}`).toEqual([]);
  });
});
