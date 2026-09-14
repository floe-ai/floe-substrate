import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyTransportCredentialSchema,
  SqliteTransportCredentialStore,
  TransportCredentialLifecycleError,
  type TransportCredentialAudience,
} from "./transport-credentials.js";

const issuedAt = "2026-09-03T12:00:00.000Z";
const expiresAt = "2026-09-03T13:00:00.000Z";
const genericDenial = {
  verified: false,
  code: "transport_credential_denied",
  message: "The transport credential was not accepted.",
} as const;

describe("transport credentials", () => {
  const openDatabases: DatabaseSync[] = [];
  const cleanupDirectories: string[] = [];

  afterEach(() => {
    for (const db of openDatabases.splice(0)) db.close();
    for (const directory of cleanupDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createStore(input: Readonly<{
    db?: DatabaseSync;
    now?: () => string;
    token_factory?: (audience: TransportCredentialAudience) => string;
    credential_id_factory?: (audience: TransportCredentialAudience) => string;
  }> = {}) {
    const db = input.db ?? new DatabaseSync(":memory:");
    openDatabases.push(db);
    applyTransportCredentialSchema(db);
    const store = new SqliteTransportCredentialStore(db, {
      now: input.now ?? (() => issuedAt),
      token_factory: input.token_factory,
      credential_id_factory: input.credential_id_factory,
    });
    return { db, store };
  }

  it("binds each privileged audience to its own process identity", () => {
    let sequence = 0;
    const { store } = createStore({
      token_factory: (audience) => `token-${audience}-${"x".repeat(40)}-${++sequence}`,
      credential_id_factory: (audience) => `credential:${audience}:${sequence}`,
    });
    const host = store.issueHostControlCredential({
      host_id: "host:local",
      expires_at: expiresAt,
    });
    const bridge = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });

    expect(store.verifyHostControlCredential(host.bearer_token, "host:local"))
      .toMatchObject({ verified: true, credential: { audience: "host_control", host_id: "host:local" } });
    expect(store.verifyBridgeServiceCredential(bridge.bearer_token, "bridge:desktop"))
      .toMatchObject({ verified: true, credential: { audience: "bridge_service", bridge_id: "bridge:desktop" } });

    expect(store.verifyBridgeServiceCredential(host.bearer_token, "bridge:desktop")).toEqual(genericDenial);
    expect(store.verifyHostControlCredential(bridge.bearer_token, "host:local")).toEqual(genericDenial);
    expect(store.verifyHostControlCredential(host.bearer_token, "host:other")).toEqual(genericDenial);
    expect(store.verifyBridgeServiceCredential(bridge.bearer_token, "bridge:other")).toEqual(genericDenial);
    expect(store.verifyHostControlBearerToken(host.bearer_token))
      .toMatchObject({ verified: true, credential: { audience: "host_control", host_id: "host:local" } });
    expect(store.verifyBridgeServiceBearerToken(bridge.bearer_token))
      .toMatchObject({ verified: true, credential: { audience: "bridge_service", bridge_id: "bridge:desktop" } });
    expect(store.verifyBridgeServiceBearerToken(host.bearer_token)).toEqual(genericDenial);
  });

  it("installs one native host credential idempotently and refuses a silent restart replacement", () => {
    let sequence = 0;
    const { store } = createStore({
      credential_id_factory: () => `credential:host:${++sequence}`,
    });
    const bearer = `native-host-${"n".repeat(48)}`;

    const installed = store.installHostControlCredential({
      host_id: "host:local",
      bearer_token: bearer,
      expires_at: expiresAt,
    });
    const restarted = store.installHostControlCredential({
      host_id: "host:local",
      bearer_token: bearer,
      expires_at: expiresAt,
    });

    expect(restarted).toEqual(installed);
    expect(store.verifyHostControlBearerToken(bearer))
      .toMatchObject({ verified: true, credential: { host_id: "host:local" } });
    expect(() => store.installHostControlCredential({
      host_id: "host:local",
      bearer_token: `different-${"x".repeat(48)}`,
      expires_at: expiresAt,
    })).toThrowError("does not match the installed credential");
    expect(sequence).toBe(1);
  });

  it("returns one generic denial for invalid, cross-audience, bound, expired, and revoked credentials", () => {
    let now = issuedAt;
    let sequence = 0;
    const { store } = createStore({
      now: () => now,
      token_factory: (audience) => `private-${audience}-${"z".repeat(40)}-${++sequence}`,
      credential_id_factory: (audience) => `credential:${audience}:${sequence}`,
    });
    const host = store.issueHostControlCredential({
      host_id: "host:local",
      expires_at: "2026-09-03T12:15:00.000Z",
    });
    const bridge = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });

    const denials = [
      store.verifyHostControlCredential("", "host:local"),
      store.verifyHostControlCredential("http://127.0.0.1", "host:local"),
      store.verifyHostControlCredential(bridge.bearer_token, "host:local"),
      store.verifyHostControlCredential(host.bearer_token, "host:other"),
    ];
    now = "2026-09-03T12:15:00.000Z";
    denials.push(store.verifyHostControlCredential(host.bearer_token, "host:local"));
    expect(store.revokeBridgeServiceCredential(
      bridge.credential.transport_credential_id,
      "bridge:desktop",
      "2026-09-03T12:10:00.000Z",
    )).toBe(true);
    denials.push(store.verifyBridgeServiceCredential(bridge.bearer_token, "bridge:desktop"));

    expect(denials).toEqual(Array.from({ length: denials.length }, () => genericDenial));
  });

  it("rotates atomically and immediately invalidates the replaced credential", () => {
    let now = issuedAt;
    let sequence = 0;
    const { store } = createStore({
      now: () => now,
      token_factory: (audience) => `rotation-${audience}-${"r".repeat(40)}-${++sequence}`,
      credential_id_factory: (audience) => `credential:${audience}:${sequence}`,
    });
    const original = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });
    now = "2026-09-03T12:10:00.000Z";
    const replacement = store.rotateBridgeServiceCredential({
      transport_credential_id: original.credential.transport_credential_id,
      bridge_id: "bridge:desktop",
      expires_at: "2026-09-03T14:00:00.000Z",
    });

    expect(replacement.credential).toMatchObject({
      audience: "bridge_service",
      bridge_id: "bridge:desktop",
      replaces_credential_id: original.credential.transport_credential_id,
      issued_at: "2026-09-03T12:10:00.000Z",
      revoked_at: null,
    });
    expect(store.verifyBridgeServiceCredential(original.bearer_token, "bridge:desktop"))
      .toEqual(genericDenial);
    expect(store.verifyBridgeServiceCredential(replacement.bearer_token, "bridge:desktop"))
      .toMatchObject({ verified: true, credential: { transport_credential_id: replacement.credential.transport_credential_id } });
    expect(() => store.rotateHostControlCredential({
      transport_credential_id: replacement.credential.transport_credential_id,
      host_id: "host:local",
      expires_at: "2026-09-03T15:00:00.000Z",
    })).toThrowError(new TransportCredentialLifecycleError("Transport credential rotation was not accepted."));
  });

  it("replaces every active credential for one exact Bridge and host binding", () => {
    let now = issuedAt;
    let tokenSequence = 0;
    let idSequence = 0;
    const { db, store } = createStore({
      now: () => now,
      token_factory: () => `bridge-process-${"b".repeat(40)}-${++tokenSequence}`,
      credential_id_factory: () => `credential:bridge:${++idSequence}`,
    });
    const first = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });
    now = "2026-09-03T12:01:00.000Z";
    const second = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });
    now = "2026-09-03T12:02:00.000Z";
    const otherHost = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:remote",
      expires_at: expiresAt,
    });

    now = "2026-09-03T12:10:00.000Z";
    const replacement = store.replaceBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: "2026-09-03T14:00:00.000Z",
    });

    expect(replacement.credential).toMatchObject({
      audience: "bridge_service",
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      replaces_credential_id: second.credential.transport_credential_id,
      revoked_at: null,
    });
    expect(store.verifyBridgeServiceBearerToken(first.bearer_token)).toEqual(genericDenial);
    expect(store.verifyBridgeServiceBearerToken(second.bearer_token)).toEqual(genericDenial);
    expect(store.verifyBridgeServiceBearerToken(replacement.bearer_token))
      .toMatchObject({ verified: true, credential: { host_id: "host:local" } });
    expect(store.verifyBridgeServiceBearerToken(otherHost.bearer_token))
      .toMatchObject({ verified: true, credential: { host_id: "host:remote" } });

    const history = db.prepare(`
      SELECT transport_credential_id, authorized_host_id, revoked_at
      FROM transport_credentials
      WHERE audience = 'bridge_service' AND bridge_id = 'bridge:desktop'
      ORDER BY issued_at, transport_credential_id
    `).all() as Array<Record<string, unknown>>;
    expect(history).toHaveLength(4);
    expect(history.filter((row) => row.authorized_host_id === "host:local"))
      .toEqual([
        expect.objectContaining({
          transport_credential_id: first.credential.transport_credential_id,
          revoked_at: now,
        }),
        expect.objectContaining({
          transport_credential_id: second.credential.transport_credential_id,
          revoked_at: now,
        }),
        expect.objectContaining({
          transport_credential_id: replacement.credential.transport_credential_id,
          revoked_at: null,
        }),
      ]);
  });

  it("rolls back Bridge credential revocation when replacement issuance fails", () => {
    let now = issuedAt;
    let tokenSequence = 0;
    const { store } = createStore({
      now: () => now,
      token_factory: () => `bridge-atomic-${"a".repeat(40)}-${++tokenSequence}`,
      credential_id_factory: () => "credential:bridge:fixed",
    });
    const original = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });

    now = "2026-09-03T12:10:00.000Z";
    expect(() => store.replaceBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: "2026-09-03T14:00:00.000Z",
    })).toThrowError("Transport credential issuance could not be completed.");
    expect(store.verifyBridgeServiceBearerToken(original.bearer_token))
      .toMatchObject({ verified: true, credential: { revoked_at: null } });
  });

  it("persists audience-separated hashes and never persists or reports bearer material", () => {
    const directory = mkdtempSync(join(tmpdir(), "floe-transport-credentials-"));
    cleanupDirectories.push(directory);
    const path = join(directory, "bus.sqlite");
    const rawToken = `shared-private-material-${"s".repeat(40)}`;
    let sequence = 0;
    const { db, store } = createStore({
      db: new DatabaseSync(path),
      token_factory: () => rawToken,
      credential_id_factory: (audience) => `credential:${audience}:${++sequence}`,
    });

    const host = store.issueHostControlCredential({ host_id: "host:local", expires_at: expiresAt });
    const bridge = store.issueBridgeServiceCredential({
      bridge_id: "bridge:desktop",
      host_id: "host:local",
      expires_at: expiresAt,
    });
    const rows = db.prepare(`
      SELECT transport_credential_id, audience, host_id, bridge_id, token_hash,
             issued_at, expires_at, revoked_at, replaces_credential_id
      FROM transport_credentials
      ORDER BY audience
    `).all() as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.token_hash).not.toBe(rows[1]?.token_hash);
    expect(JSON.stringify(rows)).not.toContain(rawToken);
    expect(JSON.stringify(host.credential)).not.toContain(rawToken);
    expect(JSON.stringify(bridge.credential)).not.toContain(rawToken);
    expect(Object.keys(rows[0] ?? {})).not.toContain("bearer_token");

    expect(() => store.issueHostControlCredential({ host_id: "host:other", expires_at: expiresAt }))
      .toThrowError("Transport credential issuance could not be completed.");
    try {
      store.issueHostControlCredential({ host_id: "host:other", expires_at: expiresAt });
    } catch (error) {
      expect(String(error)).not.toContain(rawToken);
    }

    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);

    const reopenedDb = new DatabaseSync(path);
    openDatabases.push(reopenedDb);
    const reopened = new SqliteTransportCredentialStore(reopenedDb, {
      now: () => "2026-09-03T12:30:00.000Z",
    });
    expect(reopened.verifyHostControlCredential(rawToken, "host:local"))
      .toMatchObject({ verified: true, credential: { audience: "host_control" } });
    expect(reopened.verifyBridgeServiceCredential(rawToken, "bridge:desktop"))
      .toMatchObject({ verified: true, credential: { audience: "bridge_service" } });
    reopenedDb.close();
    openDatabases.splice(openDatabases.indexOf(reopenedDb), 1);

    expect(readFileSync(path).includes(Buffer.from(rawToken, "utf8"))).toBe(false);
  });

  it("supports deterministic trusted-boundary injection without accepting a third audience", () => {
    const observedAudiences: TransportCredentialAudience[] = [];
    let sequence = 0;
    const { db, store } = createStore({
      now: () => "2026-09-03T12:00:00+00:00",
      token_factory: (audience) => {
        observedAudiences.push(audience);
        return `deterministic-${audience}-${"d".repeat(40)}-${sequence + 1}`;
      },
      credential_id_factory: (audience) => `fixed:${audience}:${++sequence}`,
    });

    const host = store.issueHostControlCredential({ host_id: "host:A", expires_at: expiresAt });
    const bridge = store.issueBridgeServiceCredential({
      bridge_id: "bridge:B",
      host_id: "host:A",
      expires_at: expiresAt,
    });

    expect(observedAudiences).toEqual(["host_control", "bridge_service"]);
    expect(host).toMatchObject({
      bearer_token: `deterministic-host_control-${"d".repeat(40)}-1`,
      credential: {
        transport_credential_id: "fixed:host_control:1",
        audience: "host_control",
        issued_at: issuedAt,
      },
    });
    expect(bridge).toMatchObject({
      bearer_token: `deterministic-bridge_service-${"d".repeat(40)}-2`,
      credential: {
        transport_credential_id: "fixed:bridge_service:2",
        audience: "bridge_service",
        issued_at: issuedAt,
      },
    });

    expect(() => db.prepare(`
      INSERT INTO transport_credentials (
        transport_credential_id, audience, host_id, bridge_id, token_hash,
        issued_at, expires_at, revoked_at, replaces_credential_id
      ) VALUES ('operation-session', 'operation_authority', 'host:A', NULL,
                'not-a-real-hash', ?, ?, NULL, NULL)
    `).run(issuedAt, expiresAt)).toThrow();
  });
});
