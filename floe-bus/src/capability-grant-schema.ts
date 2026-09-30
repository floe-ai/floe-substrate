/** The public shape of one capability grant, shared by every operation that returns grants. */
const text = { type: "string", minLength: 1 } as const;

export const grantTargetsSchema = { type: "array", items: { type: "object", additionalProperties: false,
  required: ["kind", "id"], properties: { kind: text, id: { oneOf: [text, { type: "null" }] } } } };

export const capabilityGrantSchema = { type: "object", additionalProperties: false,
  required: ["grant_id", "principal_id", "boundary", "operation_ids", "targets", "issued_at", "expires_at", "revoked_at", "issuer_id", "evidence", "delegation_only"],
  properties: { grant_id: text, principal_id: text,
    boundary: { type: "object", additionalProperties: false, required: ["kind", "workspace_id"],
      properties: { kind: { const: "workspace" }, workspace_id: text } },
    operation_ids: { type: "array", minItems: 1, uniqueItems: true, items: text }, targets: grantTargetsSchema,
    issued_at: text, expires_at: { oneOf: [text, { type: "null" }], description: "Null means until revoked." }, revoked_at: { oneOf: [text, { type: "null" }] }, issuer_id: text,
    evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "ref"],
      properties: { kind: text, ref: text } } },
    delegation_only: { type: "boolean" },
  } };

export const unavailableGrantSchema = { type: "object", additionalProperties: false,
  required: ["grant_id", "code"], properties: { grant_id: text, code: text } };
