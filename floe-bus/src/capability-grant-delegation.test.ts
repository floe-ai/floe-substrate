import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyCapabilityGrantSchema, SqliteCapabilityGrantStore } from "./capability-grants.js";

const workspace = { kind: "workspace" as const, workspace_id: "workspace:delegation" };
const recipient = { kind: "actor", id: "actor:reviewer" };
const start = "2026-09-05T05:00:00.000Z";
const expiry = "2026-09-05T06:00:00.000Z";
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function setup() {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec("PRAGMA foreign_keys = ON"); applyCapabilityGrantSchema(db);
  let time = start;
  const store = new SqliteCapabilityGrantStore(db, { now: () => time });
  const base = { principal_id: "actor:organiser", boundary: workspace,
    expires_at: expiry, issuer_id: "policy:workspace", evidence: [{ kind: "policy", ref: "policy:1" }] };
  const source = store.issueGrant({ ...base, operation_ids: ["artefact.inspect", "artefact.version.publish"],
    targets: [{ kind: "artefact", id: null }] });
  const permission = store.issueGrant({ ...base, operation_ids: ["capability.grant.delegate"], targets: [recipient] });
  const session = (ids = [source.grant_id, permission.grant_id]) => ({ principal_id: base.principal_id,
    boundary: workspace, grant_ids: ids, interaction: { mode: "unattended" as const, session_id: "session:organiser",
      confirmed_prompts: [], approval_refs: [] } });
  const authority = () => store.resolveSessionAuthority(session(), recipient).authority;
  const input = () => ({ authority: authority(), source_grant_id: source.grant_id,
    principal_id: recipient.id, recipient, operation_ids: ["artefact.inspect"],
    targets: [{ kind: "artefact", id: "artefact:game" }], invocation_id: "invocation:delegate" });
  return { db, store, source, permission, session, authority, input, setTime: (value: string) => { time = value; } };
}

describe("bounded CapabilityGrant delegation", () => {
  it("gives the recipient its own narrower authority while retaining parent evidence", () => {
    const f = setup(); const grant = f.store.delegateGrant(f.input());
    expect(grant).toMatchObject({ principal_id: recipient.id, operation_ids: ["artefact.inspect"],
      targets: [{ kind: "artefact", id: "artefact:game" }], expires_at: expiry, issuer_id: "actor:organiser" });
    expect(f.store.getDelegation(grant.grant_id)).toEqual({ source_grant_id: f.source.grant_id,
      authority_grant_id: f.permission.grant_id });
    const session = { ...f.session(), principal_id: recipient.id, grant_ids: [grant.grant_id] };
    expect([...f.store.resolveSessionAuthority(session, { kind: "artefact", id: "artefact:game" }).authority.grants])
      .toEqual(["artefact.inspect"]);
    expect([...f.store.resolveSessionAuthority(session, { kind: "artefact", id: "artefact:other" }).authority.grants]).toEqual([]);
    expect(f.store.getGrant(f.source.grant_id)).toEqual(f.source);
  });

  it("does not turn possession of an operation into permission to delegate it", () => {
    const f = setup();
    const authority = f.store.resolveSessionAuthority(f.session([f.source.grant_id]), recipient).authority;
    expect(() => f.store.delegateGrant({ ...f.input(), authority })).toThrow("delegation grant");
    expect(f.store.listActiveGrantsForPrincipalBoundary(recipient.id, workspace)).toEqual([]);
  });

  it("cannot use an unpinned grant even when the same principal owns it", () => {
    const f = setup();
    const authority = f.store.resolveSessionAuthority(f.session([f.permission.grant_id]), recipient).authority;
    expect(() => f.store.delegateGrant({ ...f.input(), authority })).toThrow("not part of this authenticated session");
  });

  it.each([
    { operation_ids: ["credential.use"] },
    { targets: [] },
    { targets: [{ kind: "secret_ref", id: "account:1" }] },
    { expires_at: "2026-09-05T07:00:00.000Z" },
  ])("refuses expansion beyond the source or permission: %j", override => {
    const f = setup();
    expect(() => f.store.delegateGrant({ ...f.input(), ...override })).toThrow();
    expect(f.store.listActiveGrantsForPrincipalBoundary(recipient.id, workspace)).toEqual([]);
  });

  it("refuses another recipient outside the delegation permission target", () => {
    const f = setup();
    expect(() => f.store.delegateGrant({ ...f.input(), principal_id: "actor:other",
      recipient: { kind: "actor", id: "actor:other" } })).toThrow("delegation grant");
  });

  it.each(["source", "permission"] as const)("withdraws existing child authority when its %s is revoked", kind => {
    const f = setup(); const grant = f.store.delegateGrant(f.input());
    f.store.revokeGrant(f[kind].grant_id);
    const session = { ...f.session(), principal_id: recipient.id, grant_ids: [grant.grant_id] };
    expect(f.store.inspectSessionGrantIds(session).unavailable_grants).toEqual([
      { grant_id: grant.grant_id, code: "grant_dependency_unavailable" },
    ]);
    expect([...f.store.resolveSessionAuthority(session, { kind: "artefact", id: "artefact:game" }).authority.grants]).toEqual([]);
    expect(f.store.listActiveGrantsForPrincipalBoundary(recipient.id, workspace)).toEqual([]);
    expect(f.store.getGrant(grant.grant_id)?.revoked_at).toBeNull(); // retained history, current dependency refusal
  });

  it("uses the shorter expiry and checks the source again after discovery", () => {
    const f = setup();
    f.db.prepare("UPDATE capability_grants SET expires_at = ? WHERE grant_id = ?")
      .run("2026-09-05T05:30:00.000Z", f.permission.grant_id);
    expect(f.store.delegateGrant(f.input()).expires_at).toBe("2026-09-05T05:30:00.000Z");
    const input = f.input(); f.setTime("2026-09-05T06:10:00.000Z");
    expect(() => f.store.delegateGrant(input)).toThrow("grant_expired");
  });

  it("retains delegation dependency checks after reopening the store", () => {
    const f = setup(); const grant = f.store.delegateGrant(f.input());
    const reopened = new SqliteCapabilityGrantStore(f.db, { now: () => start });
    reopened.revokeGrant(f.permission.grant_id);
    expect(reopened.inspectSessionGrantIds({ principal_id: recipient.id, boundary: workspace,
      grant_ids: [grant.grant_id] }).unavailable_grants[0]?.code).toBe("grant_dependency_unavailable");
  });

  it("keeps revocation effective through repeated delegation without broadening child operations", () => {
    const f = setup();
    const root = f.store.issueGrant({ principal_id: "actor:root", boundary: workspace,
      operation_ids: ["context.inspect", "capability.grant.delegate"], expires_at: expiry,
      issuer_id: "policy:workspace", evidence: [{ kind: "policy", ref: "chain" }] });
    let parent = root;
    for (let index = 0; index < 30; index++) {
      const next = { kind: "actor", id: `actor:child:${index}` };
      const session = { ...f.session(), principal_id: parent.principal_id, grant_ids: [parent.grant_id] };
      parent = f.store.delegateGrant({ authority: f.store.resolveSessionAuthority(session, next).authority,
        source_grant_id: parent.grant_id, principal_id: next.id, recipient: next,
        operation_ids: parent.operation_ids, invocation_id: `delegate:${index}` });
    }
    f.store.revokeGrant(root.grant_id);
    expect(f.store.inspectSessionGrantIds({ principal_id: parent.principal_id, boundary: workspace,
      grant_ids: [parent.grant_id] }).unavailable_grants[0]?.code).toBe("grant_dependency_unavailable");
  });
});
