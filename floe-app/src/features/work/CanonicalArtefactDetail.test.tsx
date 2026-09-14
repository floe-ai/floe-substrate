import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ArtefactVersion,
  InspectArtefactOperationResult,
  OperationInvocationReceipt,
  SemanticOperationDescriptor,
} from "../../bus-client/types.ts";

vi.mock("../../bus-client/client.ts", () => ({
  listOperations: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("../../bus-client/transport.ts", () => ({
  readArtefactVersionContent: vi.fn(),
  htmlPreviewHostUrl: () => "/v1/previews/html",
}));

import * as client from "../../bus-client/client.ts";
import * as transport from "../../bus-client/transport.ts";
import { CanonicalArtefactDetail } from "./CanonicalArtefactDetail.tsx";

const digest = "a".repeat(64);

function version(id: string, ordinal: number, path = `${id}.png`): ArtefactVersion {
  return {
    artefact_version_id: id,
    artefact_id: "artefact:concept",
    ordinal,
    schema_ref: null,
    content_ref: {
      kind: "workspace-relative",
      path,
      digest: { algorithm: "sha256", value: digest },
      media_type: "image/png",
      size_bytes: 3,
    },
    created_at: `2026-09-0${ordinal}T00:00:00Z`,
  };
}

const historical = version("version:historical", 1);
const earlier = version("version:earlier", 2);
const exact = version("version:exact", 3, "private/concepts/preview.png");
const otherHead = version("version:branch", 4);

function result(includeHistory: boolean): InspectArtefactOperationResult {
  return {
    artefact: { artefact_id: "artefact:concept", workspace_id: "workspace", type_ref: "concept-image", created_at: "2026-09-01T00:00:00Z" },
    heads: [exact, otherHead],
    history_complete: includeHistory,
    versions: includeHistory ? [historical, earlier, exact, otherHead] : [],
    selected: {
      version: exact,
      lineage_from: [{ lineage_id: "lineage:one", workspace_id: "workspace", subject_version_id: exact.artefact_version_id, relation_type: "core:derived-from", object_version_id: earlier.artefact_version_id, created_at: "2026-09-02T00:00:00Z" }],
      lineage_to: [],
      members: [{ collection_version_id: exact.artefact_version_id, member_key: "prop-1", member_version_id: "version:member", position: 0, created_at: "2026-09-02T00:00:00Z" }],
      associations: [{ association_id: "association:context", artefact_version_id: exact.artefact_version_id, target_kind: "context", target_id: "context:review", role: "evidence", created_at: "2026-09-02T00:00:00Z" }],
      annotations: [],
    },
  };
}

const descriptor: SemanticOperationDescriptor = {
  operation_id: "artefact.inspect",
  operation_version: "1",
  authority_boundary_kinds: ["workspace"],
  category: "artefacts",
  title: "Inspect Artefact versions",
  description: "Inspect exact canonical evidence.",
  effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
  required_grants: ["artefact.inspect"],
  interaction_constraints: { allowed_modes: ["interactive"] },
  target: { resource_kinds: ["artefact_version"], expected_revision: "not_applicable" },
  input: { version: "1", schema: {} },
  result: { version: "1", schema: {} },
  availability: { available: true },
};

function receipt(operationResult: InspectArtefactOperationResult): OperationInvocationReceipt {
  return {
    receipt_id: "receipt:inspect",
    invocation_id: "invocation:inspect",
    operation_id: "artefact.inspect",
    operation_version: "1",
    principal_id: "principal:operator",
    authority_boundary: { kind: "workspace", workspace_id: "workspace" },
    workspace_id: "workspace",
    target: { kind: "artefact_version", id: exact.artefact_version_id, revision: exact.artefact_version_id },
    expected_resource_revision: null,
    idempotency_key: "inspect:key",
    request_digest: digest,
    state: "completed",
    result_schema_version: "1",
    result: operationResult,
    refusal: null,
    changed_refs: [],
    progress_ref: null,
    cancel_ref: null,
    audit_ref: { kind: "operation_receipt", id: "receipt:inspect" },
    started_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    completed_at: "2026-09-03T00:00:00Z",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("canonical Artefact detail", () => {
  it("offers the locally bundled 3D viewer for verified GLB bytes without running it on inspection", async () => {
    vi.mocked(client.listOperations).mockResolvedValue([descriptor]);
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt(result(false)));
    vi.mocked(transport.readArtefactVersionContent).mockResolvedValue({
      mediaType: "model/gltf-binary", etag: `"sha256:${digest}"`,
      artefactVersionId: exact.artefact_version_id,
      data: { arrayBuffer: async () => new ArrayBuffer(24) } as Blob,
    });
    render(<CanonicalArtefactDetail workspaceId="workspace" artefactVersionId={exact.artefact_version_id} />);
    expect(await screen.findByRole("button", { name: "Open 3D view" })).toBeTruthy();
    expect(screen.queryByTitle("Interactive saved result")).toBeNull();
  });
  it("transfers complete verified HTML once into an opaque sandbox", async () => {
    // jsdom does not implement the browser's modal dialog methods.
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
      close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
    });
    vi.mocked(client.listOperations).mockResolvedValue([descriptor]);
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt(result(false)));
    const html = `<html>${" ".repeat(25_000)}<button>Play</button></html>`;
    vi.mocked(transport.readArtefactVersionContent).mockResolvedValue({
      mediaType: "text/html", etag: `"sha256:${digest}"`,
      artefactVersionId: exact.artefact_version_id,
      data: { text: async () => html } as Blob,
    });
    const port1 = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null };
    const port2 = { close: vi.fn() };
    vi.stubGlobal("MessageChannel", class { port1 = port1; port2 = port2; });
    const mounted = render(<CanonicalArtefactDetail workspaceId="workspace" artefactVersionId={exact.artefact_version_id} />);
    const run = await screen.findByRole("button", { name: "Run interactive result" });
    expect(screen.queryByTitle("Interactive saved result")).toBeNull();
    fireEvent.click(run);
    const frame = await screen.findByTitle("Interactive saved result") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/v1/previews/html");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    const transfer = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => undefined);
    fireEvent.load(frame);
    expect(document.activeElement).toBe(frame);
    fireEvent.load(frame);
    expect(transfer).toHaveBeenCalledExactlyOnceWith({ type: "floe.preview.html", version: 1 }, "*", [port2]);
    expect(port1.postMessage).toHaveBeenCalledExactlyOnceWith({ html });
    fireEvent.click(screen.getByRole("button", { name: "Stop preview" }));
    expect(screen.queryByTitle("Interactive saved result")).toBeNull();
    mounted.unmount();
    expect(port1.close).toHaveBeenCalled();
    expect(port2.close).toHaveBeenCalled();
  });
  it("uses the discovered operation and exact-version content transport", async () => {
    vi.mocked(client.listOperations).mockResolvedValue([descriptor]);
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt(result(false)));
    vi.mocked(transport.readArtefactVersionContent).mockResolvedValue({
      mediaType: "image/png",
      etag: `"sha256:${digest}"`,
      artefactVersionId: exact.artefact_version_id,
      data: new Blob(["png"], { type: "image/png" }),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:exact-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const openContext = vi.fn();

    render(<CanonicalArtefactDetail workspaceId="workspace" artefactVersionId={exact.artefact_version_id} onOpenContext={openContext} />);

    expect(await screen.findByText("concept-image")).toBeTruthy();
    expect((await screen.findByRole("img", { name: "Exact ArtefactVersion preview" })).getAttribute("src")).toBe("blob:exact-preview");
    expect(screen.getByText("preview.png")).toBeTruthy();
    expect(screen.queryByText("private/concepts/preview.png")).toBeNull();
    expect(screen.getByText("derived from")).toBeTruthy();
    expect(screen.getByText("prop-1")).toBeTruthy();

    fireEvent.click(screen.getByText("Version details"));
    fireEvent.click(screen.getByRole("button", { name: "Open Context" }));
    expect(openContext).toHaveBeenCalledWith("context:review");
    expect(client.listOperations).toHaveBeenCalledWith("workspace", { kind: "artefact_version", id: exact.artefact_version_id });
    expect(client.invokeOperation).toHaveBeenCalledWith("workspace", expect.objectContaining({
      operation_id: "artefact.inspect",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "artefact_version", id: exact.artefact_version_id },
      input: { artefact_version_id: exact.artefact_version_id, include_history: false },
    }));
    expect(transport.readArtefactVersionContent).toHaveBeenCalledWith("workspace", exact.artefact_version_id);
  });

  it("keeps retained versions secondary until the operator requests them", async () => {
    vi.mocked(client.listOperations).mockResolvedValue([descriptor]);
    vi.mocked(client.invokeOperation).mockImplementation(async (_workspaceId, request) => receipt(result((request.input as { include_history: boolean }).include_history)));
    vi.mocked(transport.readArtefactVersionContent).mockRejectedValue(new Error("Resolver unavailable"));

    render(<CanonicalArtefactDetail workspaceId="workspace" artefactVersionId={exact.artefact_version_id} />);

    await screen.findByText("concept-image");
    expect(screen.queryByText("version:historical")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show version history" }));

    await waitFor(() => expect(client.invokeOperation).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("version:historical")).toBeTruthy();
    expect(client.invokeOperation).toHaveBeenLastCalledWith("workspace", expect.objectContaining({
      input: { artefact_version_id: exact.artefact_version_id, include_history: true },
    }));
  });
});
