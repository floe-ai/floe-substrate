import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  ArtefactIdempotencyConflictError,
  ArtefactStore,
  ArtefactValidationError,
  ArtefactWorkspaceMismatchError,
  applyArtefactSchema,
  normalizeContentRef,
  type ContentRef,
} from "./artefacts.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function workspaceFile(path: string, digest = DIGEST_A): ContentRef {
  return {
    kind: "workspace-relative",
    path,
    digest: { algorithm: "sha256", value: digest },
    media_type: "image/png",
  };
}

describe("canonical Artefact storage", () => {
  let db: DatabaseSync;
  let store: ArtefactStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyArtefactSchema(db);
    store = new ArtefactStore(db);
  });

  afterEach(() => db.close());

  it("creates a stable Artefact idempotently and rejects key reuse for a different fact", () => {
    const first = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "media:image",
      idempotency_key: "source-image",
    });
    const retry = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "media:image",
      idempotency_key: "source-image",
    });

    expect(retry).toEqual(first);
    expect(store.listArtefacts("workspace:test")).toEqual([first]);
    expect(() => store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "media:video",
      idempotency_key: "source-image",
    })).toThrow(ArtefactIdempotencyConflictError);
  });

  it("pins workspace, content-addressed, and external content without absolute file identity", () => {
    expect(normalizeContentRef(workspaceFile("concepts\\courtyard.png"))).toEqual({
      kind: "workspace-relative",
      path: "concepts/courtyard.png",
      digest: { algorithm: "sha256", value: DIGEST_A },
      media_type: "image/png",
    });
    expect(normalizeContentRef({
      kind: "content-addressed",
      resolver_id: "workspace-cas",
      digest: { algorithm: "sha256", value: DIGEST_B.toUpperCase() },
      size_bytes: 42,
    })).toEqual({
      kind: "content-addressed",
      resolver_id: "workspace-cas",
      digest: { algorithm: "sha256", value: DIGEST_B },
      size_bytes: 42,
    });
    expect(normalizeContentRef({
      kind: "external-revision",
      resolver_id: "github",
      external_id: "earendil-works/floe",
      revision: "commit:0123456789abcdef",
    })).toEqual({
      kind: "external-revision",
      resolver_id: "github",
      external_id: "earendil-works/floe",
      revision: "commit:0123456789abcdef",
    });

    for (const path of ["C:\\Users\\person\\image.png", "C:", "../outside.png", "/tmp/image.png", "\\\\server\\share\\image.png"]) {
      expect(() => normalizeContentRef(workspaceFile(path))).toThrow(ArtefactValidationError);
    }
    expect(() => normalizeContentRef({
      kind: "workspace-relative",
      path: "concepts/image.png",
      digest: { algorithm: "sha256", value: "not-a-digest" },
    })).toThrow(/SHA-256/);
    expect(() => normalizeContentRef({
      kind: "external-revision",
      resolver_id: "filesystem",
      external_id: "C:\\mutable\\image.png",
      revision: "mtime:123",
    })).toThrow(/absolute file path/);
    expect(() => normalizeContentRef({
      kind: "external-revision",
      resolver_id: "filesystem",
      external_id: "/mutable/image.png",
      revision: "mtime:123",
    })).toThrow(/absolute file path/);
  });

  it("publishes exact lineage, keyed collections, typed execution associations, and extension annotations atomically", () => {
    const source = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "concept:image",
      idempotency_key: "source",
    });
    const sourceVersion = store.publishVersion({
      artefact_id: source.artefact_id,
      idempotency_key: "source-v1",
      content_ref: workspaceFile("concepts/courtyard.png"),
    });
    const prop = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "prop:reference",
      idempotency_key: "prop",
    });
    const propVersion = store.publishVersion({
      artefact_id: prop.artefact_id,
      idempotency_key: "prop-v1",
      content_ref: workspaceFile("outputs/crate.png", DIGEST_B),
      lineage: [{ relation_type: "core:derived-from", object_version_id: sourceVersion.artefact_version_id }],
      associations: [{
        target_kind: "node_execution",
        target_id: "node-execution:generator:1",
        role: "output",
      }],
      annotations: [{
        namespace: "extension:concept-exploder",
        key: "review-status",
        extension_package_version_ref: "concept-exploder@2.1.0",
        schema_ref: "extension:concept-exploder/review-status/v1",
        value: { status: "accepted", confidence: 0.98 },
      }],
    });
    const collection = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "core:collection",
      idempotency_key: "contact-sheet-collection",
    });
    const collectionVersion = store.publishVersion({
      artefact_id: collection.artefact_id,
      idempotency_key: "contact-sheet-collection-v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "workspace-cas",
        digest: { algorithm: "sha256", value: DIGEST_C },
      },
      members: [
        { member_key: "source", member_version_id: sourceVersion.artefact_version_id, position: 0 },
        { member_key: "crate", member_version_id: propVersion.artefact_version_id, position: 1 },
      ],
    });

    expect(store.listLineageFrom(propVersion.artefact_version_id)).toEqual([
      expect.objectContaining({
        subject_version_id: propVersion.artefact_version_id,
        relation_type: "core:derived-from",
        object_version_id: sourceVersion.artefact_version_id,
      }),
    ]);
    expect(store.listCollectionMembers(collectionVersion.artefact_version_id)).toEqual([
      expect.objectContaining({ member_key: "source", member_version_id: sourceVersion.artefact_version_id }),
      expect.objectContaining({ member_key: "crate", member_version_id: propVersion.artefact_version_id }),
    ]);
    expect(store.listAssociations(propVersion.artefact_version_id)).toEqual([
      expect.objectContaining({
        target_kind: "node_execution",
        target_id: "node-execution:generator:1",
        role: "output",
      }),
    ]);
    expect(store.listAnnotations(propVersion.artefact_version_id)).toEqual([
      expect.objectContaining({
        namespace: "extension:concept-exploder",
        extension_package_version_ref: "concept-exploder@2.1.0",
        value: { status: "accepted", confidence: 0.98 },
      }),
    ]);
  });

  it("keeps ArtefactVersion, exact lineage, and collection membership immutable", () => {
    const source = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "document",
      idempotency_key: "document",
    });
    const first = store.publishVersion({
      artefact_id: source.artefact_id,
      idempotency_key: "document-v1",
      content_ref: workspaceFile("document.md"),
    });
    const second = store.publishVersion({
      artefact_id: source.artefact_id,
      idempotency_key: "document-v2",
      content_ref: workspaceFile("document.md", DIGEST_B),
      lineage: [{ relation_type: "core:supersedes", object_version_id: first.artefact_version_id }],
    });

    expect(store.listHeads(source.artefact_id).map((value) => value.artefact_version_id)).toEqual([
      second.artefact_version_id,
    ]);
    expect(() => db.prepare(`
      UPDATE artefact_versions SET content_ref_json = '{}' WHERE artefact_version_id = ?
    `).run(first.artefact_version_id)).toThrow(/immutable/);
    expect(() => db.prepare(`
      DELETE FROM artefact_lineage WHERE subject_version_id = ?
    `).run(second.artefact_version_id)).toThrow(/immutable/);
  });

  it("allows explicit branches instead of inventing a mutable current version", () => {
    const artefact = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "source:tree",
      idempotency_key: "tree",
    });
    const root = store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "tree-root",
      content_ref: workspaceFile("tree.json"),
    });
    const left = store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "tree-left",
      content_ref: workspaceFile("tree.json", DIGEST_B),
      lineage: [{ relation_type: "core:supersedes", object_version_id: root.artefact_version_id }],
    });
    const right = store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "tree-right",
      content_ref: workspaceFile("tree.json", DIGEST_C),
      lineage: [{ relation_type: "core:supersedes", object_version_id: root.artefact_version_id }],
    });

    expect(store.listHeads(artefact.artefact_id).map((value) => value.artefact_version_id)).toEqual([
      left.artefact_version_id,
      right.artefact_version_id,
    ]);
  });

  it("rejects cross-workspace relationships and direct Actor producer duplication", () => {
    const first = store.createArtefact({
      workspace_id: "workspace:first",
      type_ref: "document",
      idempotency_key: "first",
    });
    const firstVersion = store.publishVersion({
      artefact_id: first.artefact_id,
      idempotency_key: "first-v1",
      content_ref: workspaceFile("first.md"),
    });
    const second = store.createArtefact({
      workspace_id: "workspace:second",
      type_ref: "document",
      idempotency_key: "second",
    });

    expect(() => store.publishVersion({
      artefact_id: second.artefact_id,
      idempotency_key: "second-v1",
      content_ref: workspaceFile("second.md", DIGEST_B),
      lineage: [{ relation_type: "core:derived-from", object_version_id: firstVersion.artefact_version_id }],
    })).toThrow(ArtefactWorkspaceMismatchError);
    expect(() => store.publishVersion({
      artefact_id: first.artefact_id,
      idempotency_key: "invalid-producer",
      content_ref: workspaceFile("third.md", DIGEST_C),
      associations: [{ target_kind: "actor", target_id: "actor:builder", role: "output" } as any],
    })).toThrow(/target_kind 'actor'/);

    const columns = db.prepare("PRAGMA table_info(artefact_versions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("actor_id");
    expect(columns.map((column) => column.name)).not.toContain("command_id");
    expect(columns.map((column) => column.name)).not.toContain("producer_id");
  });

  it("validates extension namespaces and keeps appended evidence idempotent", () => {
    const artefact = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "report",
      idempotency_key: "report",
    });
    const version = store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "report-v1",
      content_ref: workspaceFile("report.json"),
    });

    const firstAssociation = store.associateVersion({
      artefact_version_id: version.artefact_version_id,
      target_kind: "event",
      target_id: "event:1",
      role: "evidence",
      idempotency_key: "event-evidence",
    });
    expect(store.associateVersion({
      artefact_version_id: version.artefact_version_id,
      target_kind: "event",
      target_id: "event:1",
      role: "evidence",
      idempotency_key: "event-evidence",
    })).toEqual(firstAssociation);
    expect(() => store.associateVersion({
      artefact_version_id: version.artefact_version_id,
      target_kind: "context",
      target_id: "context:1",
      role: "evidence",
      idempotency_key: "event-evidence",
    })).toThrow(ArtefactIdempotencyConflictError);

    expect(() => store.annotateVersion({
      artefact_version_id: version.artefact_version_id,
      namespace: "core" as any,
      key: "status",
      extension_package_version_ref: "bad@1",
      value: "accepted",
      idempotency_key: "bad-annotation",
    })).toThrow(/must identify an extension/);
  });

  it("retains unresolved legacy evidence and imports the same source only once", () => {
    const unresolvedInput = {
      workspace_id: "workspace:test",
      source_document: ".floe/extensions/concept-exploder/artifact-graph.json",
      legacy_external_id: "legacy-node:crate",
      source_revision: "legacy-r3",
      content_identity: `sha256:${DIGEST_A}`,
      evidence: { path_present: false, event_ids: ["event:lineage-updated:1"] },
      outcome: { status: "unresolved" as const, reason: "The referenced file is missing." },
    };
    const first = store.recordLegacyImportEvidence(unresolvedInput);
    const retry = store.recordLegacyImportEvidence(unresolvedInput);

    expect(retry).toEqual(first);
    expect(first).toEqual(expect.objectContaining({
      status: "unresolved",
      artefact_id: null,
      artefact_version_id: null,
      reason: "The referenced file is missing.",
    }));
    expect(store.listLegacyImports("workspace:test")).toHaveLength(1);

    expect(() => store.recordLegacyImportEvidence({
      ...unresolvedInput,
      outcome: { status: "unresolved", reason: "A different interpretation." },
    })).toThrow(ArtefactIdempotencyConflictError);
    expect(() => store.recordLegacyImportEvidence({
      ...unresolvedInput,
      source_document: "C:\\workspace\\artifact-graph.json",
    })).toThrow(/cannot be absolute/);
  });

  it("records a resolved legacy import only when the exact canonical target matches", () => {
    const artefact = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "legacy:image",
      idempotency_key: "legacy-image",
    });
    const version = store.publishVersion({
      artefact_id: artefact.artefact_id,
      idempotency_key: "legacy-image-v1",
      content_ref: workspaceFile("legacy/image.png"),
    });
    const imported = store.recordLegacyImportEvidence({
      workspace_id: "workspace:test",
      source_document: "artifact-graph.json",
      legacy_external_id: "node:legacy-image",
      content_identity: `sha256:${DIGEST_A}`,
      outcome: {
        status: "imported",
        artefact_id: artefact.artefact_id,
        artefact_version_id: version.artefact_version_id,
      },
    });

    expect(imported).toEqual(expect.objectContaining({
      status: "imported",
      artefact_id: artefact.artefact_id,
      artefact_version_id: version.artefact_version_id,
    }));
  });

  it("publishes a retry once and rejects changed version content under the same key", () => {
    const artefact = store.createArtefact({
      workspace_id: "workspace:test",
      type_ref: "document",
      idempotency_key: "document",
    });
    const input = {
      artefact_id: artefact.artefact_id,
      idempotency_key: "version-attempt-1",
      content_ref: workspaceFile("document.md"),
    };
    const first = store.publishVersion(input);
    expect(store.publishVersion(input)).toEqual(first);
    expect(store.listVersions(artefact.artefact_id)).toHaveLength(1);
    expect(() => store.publishVersion({
      ...input,
      content_ref: workspaceFile("document.md", DIGEST_B),
    })).toThrow(ArtefactIdempotencyConflictError);
  });
});
