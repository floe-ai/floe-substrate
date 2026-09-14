import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig, type LocalConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { HTML_PREVIEW_CSP, HTML_PREVIEW_HOST_DOCUMENT, HTML_PREVIEW_HOST_PATH } from "./html-preview-host.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
const HOST_TOKEN = `floe-artefact-host-${"h".repeat(48)}`;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("exact ArtefactVersion content transport", () => {
  let handle: ServerHandle;
  let temporaryRoot: string;
  let workspaceDir: string;
  let workspaceId: string;
  let workspaceBearer: string;

  beforeEach(async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "floe-artefact-content-server-"));
    workspaceDir = join(temporaryRoot, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const configPath = join(temporaryRoot, "config.yaml");
    const config: LocalConfig = defaultConfig(temporaryRoot);
    config.bridge.workspace_access.local_paths = true;
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, {
      host_control_token: HOST_TOKEN,
      host_control_expires_at: "2099-01-01T00:00:00.000Z",
    });
    await handle.app.ready();

    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { locator: workspaceDir, name: "Artefact content test" },
    });
    expect(registered.statusCode).toBe(201);
    workspaceId = registered.json().workspace.workspace_id as string;
    const session = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: {},
    });
    expect(session.statusCode).toBe(201);
    workspaceBearer = session.json().bearer_token as string;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function publish(path: string, bytes: Buffer, mediaType: string) {
    writeFileSync(join(workspaceDir, path), bytes);
    const artefact = handle.store.artefactStore.createArtefact({
      workspace_id: workspaceId,
      type_ref: mediaType.startsWith("image/") ? "media:image" : "document:text",
      idempotency_key: `create:${path}`,
    });
    return handle.store.artefactStore.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: `publish:${path}`,
      content_ref: {
        kind: "workspace-relative",
        path,
        digest: { algorithm: "sha256", value: sha256(bytes) },
        media_type: mediaType,
        size_bytes: bytes.length,
      },
    });
  }

  function contentUrl(versionId: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/artefact-versions/${encodeURIComponent(versionId)}/content`;
  }

  it("serves only a static sandbox bootstrap without authority or a browser session", async () => {
    const response = await handle.app.inject({
      method: "GET", url: HTML_PREVIEW_HOST_PATH,
      headers: { origin: "null", cookie: "floe_browser_session=untrusted" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(HTML_PREVIEW_HOST_DOCUMENT);
    expect(response.headers["content-security-policy"]).toBe(HTML_PREVIEW_CSP);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("retains HTML MIME identity but forbids execution on the content origin", async () => {
    const html = Buffer.from("<!doctype html><script>window.test = true</script>");
    const version = publish("game.html", html, "text/html");
    const denied = await handle.app.inject({ method: "GET", url: contentUrl(version.artefact_version_id) });
    expect(denied.statusCode).toBe(401);
    const response = await handle.app.inject({
      method: "GET", url: contentUrl(version.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-disposition"]).toBe("attachment");
    expect(response.headers["content-security-policy"]).toBe("default-src 'none'; sandbox; base-uri 'none'; form-action 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(html);
  });

  it("preserves GLB MIME identity only after authority and exact digest checks", async () => {
    const bytes = Buffer.from("glTF exact model bytes");
    const version = publish("model.glb", bytes, "model/gltf-binary");
    const denied = await handle.app.inject({ method: "GET", url: contentUrl(version.artefact_version_id) });
    expect(denied.statusCode).toBe(401);
    const request = { method: "GET" as const, url: contentUrl(version.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` } };
    const response = await handle.app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("model/gltf-binary");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(bytes);
    writeFileSync(join(workspaceDir, "model.glb"), "changed");
    const changed = await handle.app.inject(request);
    expect(changed.statusCode).not.toBe(200);
  });

  it("verifies publication bytes and retains them after the source file changes", async () => {
    const bytes = Buffer.from("# Original brief\n", "utf8");
    writeFileSync(join(workspaceDir, "brief.md"), bytes);
    const artefact = handle.store.artefactStore.createArtefact({
      workspace_id: workspaceId, type_ref: "core:markdown", idempotency_key: "brief",
    });
    const invoke = (digest: string, key: string) => handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: { authorization: `Bearer ${workspaceBearer}` },
      payload: {
        operation_id: "artefact.version.publish", operation_version: "1", input_schema_version: "1",
        target: { kind: "artefact", id: artefact.artefact_id }, idempotency_key: key,
        input: { content_ref: {
          kind: "workspace-relative", path: "brief.md", digest: { algorithm: "sha256", value: digest },
          media_type: "text/markdown", size_bytes: bytes.length,
        } },
      },
    });
    const invalid = await invoke("0".repeat(64), "invalid-hash");
    expect(invalid.json().receipt, invalid.body).toMatchObject({
      state: "refused", refusal: { code: "artefact_content_mismatch" },
    });
    expect(handle.store.db.prepare("SELECT count(*) AS count FROM artefact_versions WHERE artefact_id = ?")
      .get(artefact.artefact_id)).toMatchObject({ count: 0 });

    // A deferred database failure happens after bytes have been persisted.
    handle.store.db.exec(`
      CREATE TABLE publication_failure_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE publication_failure_child (
        id INTEGER REFERENCES publication_failure_parent(id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TEMP TRIGGER fail_publication AFTER INSERT ON artefact_versions BEGIN
        INSERT INTO publication_failure_child VALUES (1);
      END;
    `);
    const failedCommit = await invoke(sha256(bytes), "failed-commit");
    expect(failedCommit.json().receipt, failedCommit.body).toMatchObject({ state: "refused" });
    expect(existsSync(join(workspaceDir, `.floe/content/sha256/${sha256(bytes)}`))).toBe(false);
    expect(handle.store.db.prepare("SELECT count(*) AS count FROM artefact_versions WHERE artefact_id = ?")
      .get(artefact.artefact_id)).toMatchObject({ count: 0 });
    handle.store.db.exec("DROP TRIGGER fail_publication");

    const published = await invoke(sha256(bytes), "verified-brief");
    expect(published.json().receipt, published.body).toMatchObject({ state: "completed" });
    const version = published.json().receipt.result.version;
    expect(version.content_ref.path).toBe(`.floe/content/sha256/${sha256(bytes)}`);
    writeFileSync(join(workspaceDir, "brief.md"), "A later edit");
    const opened = await handle.app.inject({
      method: "GET", url: contentUrl(version.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.rawPayload).toEqual(bytes);
    const replayed = await invoke(sha256(bytes), "verified-brief");
    expect(replayed.json()).toMatchObject({ replayed: true, receipt: {
      state: "completed", result: { version: { artefact_version_id: version.artefact_version_id } },
    } });
  });

  it("serves exact image and text bytes through Workspace authority", async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const textBytes = Buffer.from("# Trusted text\n", "utf8");
    const image = publish("preview.png", imageBytes, "image/png");
    const text = publish("notes.md", textBytes, "text/markdown");

    const unauthorised = await handle.app.inject({ method: "GET", url: contentUrl(image.artefact_version_id) });
    expect(unauthorised.statusCode).toBe(401);

    const unrelatedGrant = handle.store.capabilityGrantStore.issueGrant({
      principal_id: "principal:unrelated-reader",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: ["context.inspect"],
      expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: "principal:test-host",
      evidence: [{ kind: "test_fixture", ref: "unrelated-operation-only" }],
    });
    const unrelatedToken = handle.store.operationAuthoritySessions.issueSession({
      principal_id: "principal:unrelated-reader",
      workspace_id: workspaceId,
      grant_ids: [unrelatedGrant.grant_id],
      interaction: { mode: "interactive", session_id: "unrelated-reader" },
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
      expires_at: "2099-01-01T00:00:00.000Z",
    }).bearer_token;
    const forbidden = await handle.app.inject({
      method: "GET",
      url: contentUrl(image.artefact_version_id),
      headers: { authorization: `Bearer ${unrelatedToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: "operation_grant_required" });

    const imageResponse = await handle.app.inject({
      method: "GET",
      url: contentUrl(image.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` },
    });
    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.headers["content-type"]).toContain("image/png");
    expect(imageResponse.headers.etag).toBe(`"sha256:${sha256(imageBytes)}"`);
    expect(imageResponse.headers["x-floe-artefact-version-id"]).toBe(image.artefact_version_id);
    expect(imageResponse.rawPayload).toEqual(imageBytes);

    const textResponse = await handle.app.inject({
      method: "GET",
      url: contentUrl(text.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` },
    });
    expect(textResponse.statusCode).toBe(200);
    expect(textResponse.headers["content-type"]).toContain("text/markdown");
    expect(textResponse.body).toBe("# Trusted text\n");
  });

  it("refuses a mutable file instead of presenting it as the recorded version", async () => {
    const version = publish("mutable.txt", Buffer.from("original", "utf8"), "text/plain");
    writeFileSync(join(workspaceDir, "mutable.txt"), Buffer.from("mutated!", "utf8"));

    const response = await handle.app.inject({
      method: "GET",
      url: contentUrl(version.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "artefact_content_mismatch" });
    expect(response.body).not.toContain(workspaceDir);
  });

  it("reports external content as unresolved without leaking the Workspace locator", async () => {
    const artefact = handle.store.artefactStore.createArtefact({
      workspace_id: workspaceId,
      type_ref: "external:reference",
      idempotency_key: "external",
    });
    const version = handle.store.artefactStore.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "external-v1",
      content_ref: {
        kind: "external-revision",
        resolver_id: "github",
        external_id: "earendil-works/floe",
        revision: "commit:0123456789abcdef",
      },
    });

    const response = await handle.app.inject({
      method: "GET",
      url: contentUrl(version.artefact_version_id),
      headers: { authorization: `Bearer ${workspaceBearer}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "artefact_content_unresolved",
      resolver_id: "github",
    });
    expect(response.body).not.toContain(workspaceDir);
  });
});
