import { describe, expect, it } from "vitest";

import { CredentialIngressError, CredentialIngressStore } from "./credential-ingress.js";

const boundary = { kind: "host" as const, host_id: "host:local" };
const material = () => new TextEncoder().encode("provider-secret-value");

function createStore() {
  let session = 0;
  return new CredentialIngressStore({
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    token_factory: () => "single-use-bearer",
    session_id_factory: () => `credential-ingress:${++session}`,
  });
}

function issue(store: CredentialIngressStore) {
  return store.issue({
    secret_ref_id: "secretref:provider:openai",
    authority_boundary: boundary,
    principal_id: "principal:operator",
    provider_id: "openai",
    audience: "provider-auth:openai",
    purpose: "account-connection",
  });
}

function use(ingress_session_id: string) {
  return {
    ingress_session_id,
    secret_ref_id: "secretref:provider:openai",
    authority_boundary: boundary,
    principal_id: "principal:operator",
    provider_id: "openai",
    audience: "provider-auth:openai" as const,
    purpose: "account-connection" as const,
  };
}

describe("CredentialIngressStore", () => {
  it("accepts one exact upload and atomically refuses replay", () => {
    const store = createStore();
    const issued = issue(store);
    const bytes = material();
    expect(store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      audience: "provider-auth:openai",
      purpose: "account-connection",
      material: bytes,
    }).state).toBe("ready");
    const consumed = store.consume(use(issued.session.ingress_session_id));
    expect(new TextDecoder().decode(consumed)).toBe("provider-secret-value");
    consumed.fill(0);
    expect(() => store.consume(use(issued.session.ingress_session_id)))
      .toThrowError(expect.objectContaining({ code: "credential_ingress_consumed" }));
  });

  it("refuses the wrong token, audience, boundary, provider, and purpose", () => {
    const cases: Array<() => void> = [];
    {
      const store = createStore();
      const issued = issue(store);
      cases.push(() => store.upload({
        ingress_session_id: issued.session.ingress_session_id,
        bearer_token: "wrong-token",
        audience: "provider-auth:openai",
        purpose: "account-connection",
        material: material(),
      }));
    }
    {
      const store = createStore();
      const issued = issue(store);
      cases.push(() => store.upload({
        ingress_session_id: issued.session.ingress_session_id,
        bearer_token: issued.bearer_token,
        audience: "provider-auth:anthropic",
        purpose: "account-connection",
        material: material(),
      }));
    }
    for (const invoke of cases) expect(invoke).toThrow(CredentialIngressError);

    const store = createStore();
    const issued = issue(store);
    store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      audience: "provider-auth:openai",
      purpose: "account-connection",
      material: material(),
    });
    expect(() => store.consume({ ...use(issued.session.ingress_session_id), authority_boundary: { kind: "host", host_id: "host:other" } }))
      .toThrowError(expect.objectContaining({ code: "credential_ingress_boundary_mismatch" }));
    expect(() => store.consume({ ...use(issued.session.ingress_session_id), provider_id: "anthropic" }))
      .toThrowError(expect.objectContaining({ code: "credential_ingress_provider_mismatch" }));
    expect(() => store.consume({ ...use(issued.session.ingress_session_id), audience: "provider-auth:anthropic" }))
      .toThrowError(expect.objectContaining({ code: "credential_ingress_audience_mismatch" }));
  });

  it("refuses revoked and restart-lost sessions without retaining material", () => {
    const store = createStore();
    const issued = issue(store);
    store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      audience: "provider-auth:openai",
      purpose: "account-connection",
      material: material(),
    });
    expect(store.revoke(issued.session.ingress_session_id)).toBe(true);
    expect(() => store.consume(use(issued.session.ingress_session_id)))
      .toThrowError(expect.objectContaining({ code: "credential_ingress_revoked" }));

    const restarted = createStore();
    expect(() => restarted.consume(use(issued.session.ingress_session_id)))
      .toThrowError(expect.objectContaining({ code: "credential_ingress_not_found" }));
  });
});
