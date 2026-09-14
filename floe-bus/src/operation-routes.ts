import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { BusStore } from "./store.js";
import type {
  OperationAuthorityBoundary,
  OperationAuthorityContext,
  OperationInvocationProvenance,
  OperationInvocationRequest,
  OperationResourceIdentity,
  ResolvedOperationResource,
} from "./operations.js";

type OperationRouteStore = Pick<
  BusStore,
  "operationAuthorityVerifier" | "operationInvocationLedger" | "operationRegistry"
> & {
  resolveOperationResource(
    target: OperationResourceIdentity,
    boundary: OperationAuthorityBoundary,
  ): ResolvedOperationResource | null;
};

export type HostOperationAuthorityResolver = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: OperationResourceIdentity | null,
) => { authority: OperationAuthorityContext; provenance: OperationInvocationProvenance } | null;

const ResourceIdentitySchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});

export const OperationInvocationSchema = z.object({
  operation_id: z.string().min(1),
  operation_version: z.string().min(1),
  input_schema_version: z.string().min(1),
  target: ResourceIdentitySchema.nullable().optional(),
  expected_resource_revision: z.string().nullable().optional(),
  idempotency_key: z.string().min(1),
  input: z.unknown(),
});

const emptyProvenance: OperationInvocationProvenance = {
  cause_event_id: null,
  delivery_ids: [],
  execution_attempt_id: null,
  node_execution_id: null,
  scope_execution_id: null,
};

/**
 * Public semantic-operation transport.
 *
 * The request contains intent only. Principal, authority boundary, grants,
 * interaction constraints, and causal provenance come from the authenticated
 * bearer session. Raw caller identity fields are never accepted here.
 */
export function registerOperationRoutes(
  app: FastifyInstance,
  store: OperationRouteStore,
  resolveHostAuthority: HostOperationAuthorityResolver,
): void {
  app.get("/v1/workspaces/:workspace_id/operations", async (request, reply) => {
    const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const query = z.object({
      query: z.string().optional(),
      category: z.string().optional(),
      target_kind: z.string().min(1).optional(),
      target_id: z.string().min(1).optional(),
    }).refine(
      (value) => Boolean(value.target_kind) === Boolean(value.target_id),
      { message: "target_kind and target_id must be supplied together" },
    ).parse(request.query);
    const requestedTarget = query.target_kind && query.target_id
      ? { kind: query.target_kind, id: query.target_id }
      : null;
    const verified = verifyOperationSession(request, reply, store, params.workspace_id, requestedTarget);
    if (!verified) return reply;
    const target = requestedTarget
      ? store.resolveOperationResource(requestedTarget, verified.authority.boundary)
      : null;
    if (query.target_kind && !target) {
      return reply.code(404).send({
        error: "operation_target_not_found",
        target: { kind: query.target_kind, id: query.target_id },
      });
    }
    return {
      operations: await store.operationRegistry.project({
        authority: verified.authority,
        target,
        query: query.query,
        category: query.category,
      }),
    };
  });

  app.post("/v1/workspaces/:workspace_id/operations/invoke", async (request, reply) => {
    const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const body = OperationInvocationSchema.parse(request.body) as OperationInvocationRequest;
    const verified = verifyOperationSession(
      request,
      reply,
      store,
      params.workspace_id,
      body.target ?? null,
    );
    if (!verified) return reply;
    return store.operationRegistry.invoke({
      authority: verified.authority,
      provenance: verified.provenance,
      resolve_resource: (target) => store.resolveOperationResource(target, verified.authority.boundary),
    }, body);
  });

  app.get("/v1/workspaces/:workspace_id/operation-receipts/:receipt_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      receipt_id: z.string().min(1),
    }).parse(request.params);
    const verified = verifyOperationSession(request, reply, store, params.workspace_id, null);
    if (!verified) return reply;
    const receipt = store.operationInvocationLedger.getByReceiptId(params.receipt_id);
    if (
      !receipt
      || receipt.authority_boundary.kind !== "workspace"
      || receipt.authority_boundary.workspace_id !== params.workspace_id
    ) {
      return reply.code(404).send({ error: "operation_receipt_not_found", receipt_id: params.receipt_id });
    }
    if (
      receipt.principal_id !== verified.authority.principal_id
      && !verified.authority.grants.has("operation.receipt.read.all")
    ) {
      return reply.code(403).send({ error: "operation_receipt_forbidden", receipt_id: params.receipt_id });
    }
    return { receipt };
  });

  registerHostOperationRoutes(app, store, resolveHostAuthority, "/v1/local");
}

/** Both local clients use the same definitions, validation, handlers and receipts. */
export function registerHostOperationRoutes(
  app: FastifyInstance,
  store: OperationRouteStore,
  resolveHostAuthority: HostOperationAuthorityResolver,
  prefix: "/v1/local" | "/v1/browser/host",
) {
  app.get(`${prefix}/operations`, async (request, reply) => {
    const query = z.object({
      query: z.string().optional(),
      category: z.string().optional(),
      target_kind: z.string().min(1).optional(),
      target_id: z.string().min(1).optional(),
    }).refine(
      (value) => Boolean(value.target_kind) === Boolean(value.target_id),
      { message: "target_kind and target_id must be supplied together" },
    ).parse(request.query);
    const requestedTarget = query.target_kind && query.target_id
      ? { kind: query.target_kind, id: query.target_id }
      : null;
    const verified = resolveHostAuthority(request, reply, requestedTarget);
    if (!verified) return reply;
    const target = requestedTarget
      ? store.resolveOperationResource(requestedTarget, verified.authority.boundary)
      : null;
    if (requestedTarget && !target) {
      return reply.code(404).send({ error: "operation_target_not_found", target: requestedTarget });
    }
    return {
      operations: await store.operationRegistry.project({
        authority: verified.authority,
        target,
        query: query.query,
        category: query.category,
      }),
    };
  });

  app.post(`${prefix}/operations/invoke`, async (request, reply) => {
    const body = OperationInvocationSchema.parse(request.body) as OperationInvocationRequest;
    const verified = resolveHostAuthority(request, reply, body.target ?? null);
    if (!verified) return reply;
    return store.operationRegistry.invoke({
      authority: verified.authority,
      provenance: verified.provenance,
      resolve_resource: (target) => store.resolveOperationResource(target, verified.authority.boundary),
    }, body);
  });

  app.get(`${prefix}/operation-receipts/:receipt_id`, async (request, reply) => {
    const params = z.object({ receipt_id: z.string().min(1) }).parse(request.params);
    const verified = resolveHostAuthority(request, reply, null);
    if (!verified) return reply;
    if (verified.authority.boundary.kind !== "host") {
      return reply.code(401).send({ error: "transport_auth_required" });
    }
    const hostId = verified.authority.boundary.host_id;
    const receipt = store.operationInvocationLedger.getByReceiptId(params.receipt_id);
    if (
      !receipt
      || receipt.authority_boundary.kind !== "host"
      || receipt.authority_boundary.host_id !== hostId
    ) {
      return reply.code(404).send({ error: "operation_receipt_not_found", receipt_id: params.receipt_id });
    }
    if (
      receipt.principal_id !== verified.authority.principal_id
      && !verified.authority.grants.has("operation.receipt.read.all")
    ) {
      return reply.code(403).send({ error: "operation_receipt_forbidden", receipt_id: params.receipt_id });
    }
    return { receipt };
  });
}

function verifyOperationSession(
  request: FastifyRequest,
  reply: FastifyReply,
  store: OperationRouteStore,
  workspaceId: string,
  target: OperationResourceIdentity | null,
): { authority: OperationAuthorityContext; provenance: OperationInvocationProvenance } | null {
  const authorization = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const verified = store.operationAuthorityVerifier.verifyBearerToken(match?.[1] ?? "", {
    boundary: { kind: "workspace", workspace_id: workspaceId },
    target,
  });
  if (!verified.verified) {
    reply.code(401).send({ error: verified.code, message: verified.message });
    return null;
  }
  const withProvenance = verified as typeof verified & { provenance?: OperationInvocationProvenance };
  return {
    authority: verified.authority,
    provenance: withProvenance.provenance ?? emptyProvenance,
  };
}
