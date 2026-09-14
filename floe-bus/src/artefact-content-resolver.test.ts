import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArtefactContentMismatchError,
  ArtefactContentUnresolvedError,
  resolveArtefactVersionContent,
} from "./artefact-content-resolver.js";
import { ArtefactStore, applyArtefactSchema } from "./artefacts.js";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("exact ArtefactVersion content resolution", () => {
  let db: DatabaseSync;
  let store: ArtefactStore;
  let workspaceDir: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyArtefactSchema(db);
    store = new ArtefactStore(db);
    workspaceDir = mkdtempSync(join(tmpdir(), "floe-artefact-content-"));
  });

  afterEach(() => {
    db.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function publish(path: string, bytes: Buffer, mediaType: string) {
    writeFileSync(join(workspaceDir, path), bytes);
    const artefact = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: mediaType.startsWith("image/") ? "media:image" : "document:text",
      idempotency_key: `create:${path}`,
    });
    return store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: `publish:${path}`,
      content_ref: {
        kind: "workspace-relative",
        path,
        digest: { algorithm: "sha256", value: digest(bytes) },
        media_type: mediaType,
        size_bytes: bytes.length,
      },
    });
  }

  it("returns exact image and text bytes without exposing their host location", () => {
    const image = publish("preview.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    const text = publish("notes.md", Buffer.from("# Exact notes\n", "utf8"), "text/markdown");

    for (const version of [image, text]) {
      const resolved = resolveArtefactVersionContent({
        store,
        workspace_id: "workspace:test",
        workspace_locator: workspaceDir,
        artefact_version_id: version.artefact_version_id,
      });
      expect(resolved.artefact_version_id).toBe(version.artefact_version_id);
      expect(resolved.digest.value).toBe(version.content_ref.kind === "workspace-relative"
        ? version.content_ref.digest.value
        : "never");
      expect(JSON.stringify({ ...resolved, bytes: undefined })).not.toContain(workspaceDir);
    }
    expect(resolveArtefactVersionContent({
      store,
      workspace_id: "workspace:test",
      workspace_locator: workspaceDir,
      artefact_version_id: image.artefact_version_id,
    }).media_type).toBe("image/png");
    expect(resolveArtefactVersionContent({
      store,
      workspace_id: "workspace:test",
      workspace_locator: workspaceDir,
      artefact_version_id: text.artefact_version_id,
    }).bytes.toString("utf8")).toBe("# Exact notes\n");
  });

  it("refuses mutable bytes after an exact version has been published", () => {
    const original = Buffer.from("original", "utf8");
    const version = publish("mutable.txt", original, "text/plain");
    writeFileSync(join(workspaceDir, "mutable.txt"), Buffer.from("mutated!", "utf8"));

    expect(() => resolveArtefactVersionContent({
      store,
      workspace_id: "workspace:test",
      workspace_locator: workspaceDir,
      artefact_version_id: version.artefact_version_id,
    })).toThrow(ArtefactContentMismatchError);
  });

  it("keeps external revisions unresolved without an exact registered resolver", () => {
    const artefact = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "external:reference",
      idempotency_key: "external",
    });
    const version = store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "external-v1",
      content_ref: {
        kind: "external-revision",
        resolver_id: "github",
        external_id: "earendil-works/floe",
        revision: "commit:0123456789abcdef",
      },
    });

    expect(() => resolveArtefactVersionContent({
      store,
      workspace_id: "workspace:test",
      workspace_locator: workspaceDir,
      artefact_version_id: version.artefact_version_id,
    })).toThrow(ArtefactContentUnresolvedError);
  });
});
