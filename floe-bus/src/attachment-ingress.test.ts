import { describe, expect, it } from "vitest";

import {
  AttachmentIngressError,
  AttachmentIngressStore,
} from "./attachment-ingress.js";

function createStore() {
  let sequence = 0;
  return new AttachmentIngressStore({
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    token_factory: () => "one-use-attachment-bearer",
    session_id_factory: () => `attachment-ingress:${++sequence}`,
  });
}

function issue(store: AttachmentIngressStore, name = "concept.png") {
  return store.issue({
    workspace_id: "workspace:test",
    context_id: "context:test",
    principal_id: "principal:operator",
    name,
    media_type: "image/png",
    size_bytes: 4,
  });
}

function exactUse(ingress_session_ids: string[]) {
  return {
    ingress_session_ids,
    workspace_id: "workspace:test",
    context_id: "context:test",
    principal_id: "principal:operator",
  };
}

describe("AttachmentIngressStore", () => {
  it("reclaims expired uploads when new work arrives and enforces aggregate byte capacity", () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const store = new AttachmentIngressStore({ now: () => now, maximum_pending_bytes: 4 });
    const first = issue(store);
    store.upload({ ingress_session_id: first.session.ingress_session_id, bearer_token: first.bearer_token, bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(() => issue(store)).toThrowError(expect.objectContaining({ code: "attachment_ingress_capacity_exceeded" }));
    now = new Date("2026-09-05T00:00:00.000Z");
    const second = issue(store);
    expect(second.session.ingress_session_id).not.toBe(first.session.ingress_session_id);
    expect(() => store.consumeMany(exactUse([first.session.ingress_session_id])))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_expired" }));
  });

  it("bounds pending metadata and terminal history while keeping old tokens unusable", () => {
    const store = new AttachmentIngressStore({ maximum_pending_sessions: 1, maximum_terminal_sessions: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = issue(store);
      ids.push(next.session.ingress_session_id);
      expect(() => issue(store)).toThrowError(expect.objectContaining({ code: "attachment_ingress_capacity_exceeded" }));
      expect(store.revoke({
        ingress_session_id: next.session.ingress_session_id,
        workspace_id: "workspace:test", context_id: "context:test", principal_id: "principal:operator",
      })).toBe(true);
    }
    expect(() => store.consumeMany(exactUse([ids[0]!]))).toThrowError(expect.objectContaining({ code: "attachment_ingress_not_found" }));
    expect(() => store.consumeMany(exactUse([ids[2]!]))).toThrowError(expect.objectContaining({ code: "attachment_ingress_revoked" }));
  });

  it("accepts exact bytes and consumes them once for one Context message", () => {
    const store = createStore();
    const issued = issue(store, "../concept.png");
    const status = store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(status).toMatchObject({ state: "ready", name: "concept.png", size_bytes: 4 });
    expect(status.digest?.value).toHaveLength(64);

    const [consumed] = store.consumeMany(exactUse([issued.session.ingress_session_id]));
    expect([...consumed!.bytes]).toEqual([1, 2, 3, 4]);
    expect(() => store.consumeMany(exactUse([issued.session.ingress_session_id])))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_consumed" }));
  });

  it("preflights every item so a bad group consumes none of the valid items", () => {
    const store = createStore();
    const ready = issue(store, "ready.png");
    const missing = issue(store, "missing.png");
    store.upload({
      ingress_session_id: ready.session.ingress_session_id,
      bearer_token: ready.bearer_token,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(() => store.consumeMany(exactUse([
      ready.session.ingress_session_id,
      missing.session.ingress_session_id,
    ]))).toThrowError(expect.objectContaining({ code: "attachment_ingress_content_missing" }));
    expect(store.consumeMany(exactUse([ready.session.ingress_session_id]))).toHaveLength(1);
  });

  it("keeps an exact upload ready when the owning commit fails", () => {
    const store = createStore();
    const issued = issue(store);
    store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(() => store.commitMany(
      exactUse([issued.session.ingress_session_id]),
      () => { throw new Error("database commit failed"); },
    )).toThrow("database commit failed");
    expect(store.commitMany(
      exactUse([issued.session.ingress_session_id]),
      ([ingress]) => [...ingress!.bytes],
    )).toEqual([1, 2, 3, 4]);
    expect(() => store.consumeMany(exactUse([issued.session.ingress_session_id])))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_consumed" }));
  });

  it("refuses wrong tokens, sizes, Workspace, Context, and principal", () => {
    const store = createStore();
    const issued = issue(store);
    expect(() => store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: "wrong-token",
      bytes: new Uint8Array([1, 2, 3, 4]),
    })).toThrow(AttachmentIngressError);
    expect(() => store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      bytes: new Uint8Array([1, 2]),
    })).toThrowError(expect.objectContaining({ code: "attachment_ingress_content_invalid" }));
    store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(() => store.consumeMany({ ...exactUse([issued.session.ingress_session_id]), workspace_id: "workspace:other" }))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_workspace_mismatch" }));
    expect(() => store.consumeMany({ ...exactUse([issued.session.ingress_session_id]), context_id: "context:other" }))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_context_mismatch" }));
    expect(() => store.consumeMany({ ...exactUse([issued.session.ingress_session_id]), principal_id: "principal:other" }))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_principal_mismatch" }));
  });

  it("zeroes and refuses a revoked transfer", () => {
    const store = createStore();
    const issued = issue(store);
    store.upload({
      ingress_session_id: issued.session.ingress_session_id,
      bearer_token: issued.bearer_token,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(store.revoke({
      ingress_session_id: issued.session.ingress_session_id,
      workspace_id: "workspace:test",
      context_id: "context:test",
      principal_id: "principal:operator",
    })).toBe(true);
    expect(() => store.consumeMany(exactUse([issued.session.ingress_session_id])))
      .toThrowError(expect.objectContaining({ code: "attachment_ingress_revoked" }));
  });
});
