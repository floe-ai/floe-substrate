import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  busFetch,
  confirmAndInvokeHostOperation,
  confirmAndInvokeOperation,
  discoverHostOperations,
  invokeHostOperation,
  localWorkspaceBindingsFetch,
  readArtefactVersionContent,
  workspaceMediaObjectUrl,
} from "./transport.ts";

describe("trusted desktop Bus transport", () => {
  afterEach(() => {
    invoke.mockReset();
    vi.unstubAllGlobals();
  });

  it("gives the native broker Workspace intent but no credential", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });

    const response = await busFetch("/v1/workspaces/workspace%3Aone/scopes", {
      method: "POST",
      headers: { authorization: "Bearer must-not-cross" },
      body: JSON.stringify({ title: "Work" }),
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("bus_request", {
      request: {
        path: "/v1/workspaces/workspace%3Aone/scopes",
        method: "POST",
        body: { title: "Work" },
        workspaceId: "workspace:one",
      },
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("must-not-cross");
  });

  it("uses a fixed pre-selection projection instead of forwarding a host path", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ status: 200, contentType: "application/json", body: "{\"workspaces\":[]}" });

    await localWorkspaceBindingsFetch({ path: "/v1/local/workspaces" });

    expect(invoke).toHaveBeenCalledWith("list_local_workspace_bindings");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("/v1/local/workspaces");
  });

  it("discovers a host operation for one opaque target without exposing authority", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ status: 200, contentType: "application/json", body: "{\"operations\":[]}" });

    await discoverHostOperations("disconnect credential", {
      kind: "secret_ref",
      id: "secretref:one",
    });

    expect(invoke).toHaveBeenCalledWith("discover_host_operations", {
      query: "disconnect credential",
      targetKind: "secret_ref",
      targetId: "secretref:one",
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("bearer");
  });

  it("uses the origin-bound browser adapter to discover and invoke host operations", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await discoverHostOperations("register workspace");
    expect(fetchMock).toHaveBeenLastCalledWith("/v1/browser/host/operations?query=register+workspace", { credentials: "same-origin" });
    const request = { operation_id: "workspace.register", input: { locator: "C:/Work" } };
    await invokeHostOperation(request);
    expect(fetchMock).toHaveBeenLastCalledWith("/v1/browser/host/operations/invoke", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(request), credentials: "same-origin",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("turns authenticated media bytes into a revocable object URL", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:floe-preview") });
    invoke.mockResolvedValue({ mediaType: "image/png", dataBase64: "cG5n" });

    await expect(workspaceMediaObjectUrl("workspace:one", "preview.png"))
      .resolves.toBe("blob:floe-preview");
    expect(invoke).toHaveBeenCalledWith("read_bus_media", {
      workspaceId: "workspace:one",
      relPath: "preview.png",
    });
  });

  it("reads content by exact ArtefactVersion without forwarding a path or credential", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({
      mediaType: "text/markdown",
      dataBase64: "IyBFeGFjdAo=",
      etag: `"sha256:${"a".repeat(64)}"`,
      artefactVersionId: "artefact-version:one",
    });

    const content = await readArtefactVersionContent("workspace:one", "artefact-version:one");

    expect(content.mediaType).toBe("text/markdown");
    expect(await content.data.text()).toBe("# Exact\n");
    expect(invoke).toHaveBeenCalledWith("read_artefact_version_content", {
      workspaceId: "workspace:one",
      artefactVersionId: "artefact-version:one",
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("path");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("Bearer");
  });

  it("refuses content when the broker does not prove the requested exact version", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({
      mediaType: "image/png",
      dataBase64: "cG5n",
      etag: `"sha256:${"a".repeat(64)}"`,
      artefactVersionId: "artefact-version:different",
    });

    await expect(readArtefactVersionContent("workspace:one", "artefact-version:one"))
      .rejects.toThrow("exact ArtefactVersion evidence");
  });

  it("uses a native prompt and never forwards confirmation authority from browser content", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({
      confirmed: true,
      response: { status: 200, contentType: "application/json", body: "{\"kind\":\"receipt\"}" },
    });
    const request = {
      operation_id: "context.destroy_permanently",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: "context:one" },
      expected_resource_revision: "2",
      idempotency_key: "destroy:one",
      input: { reason: "The operator requested permanent destruction." },
    };

    const result = await confirmAndInvokeOperation("workspace:one", request);

    expect(result.confirmed).toBe(true);
    expect(invoke).toHaveBeenCalledWith("confirm_and_invoke_operation", {
      workspaceId: "workspace:one",
      request,
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("confirmed_prompts");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("grant_ids");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("principal_id");
  });

  it("has no browser fallback that can mint trusted confirmation", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmAndInvokeOperation("workspace:one", {}))
      .rejects.toThrow("only in the installed Floe app");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the native prompt for host confirmation without accepting browser authority", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({
      confirmed: true,
      response: { status: 200, contentType: "application/json", body: "{\"kind\":\"receipt\"}" },
    });
    const request = {
      operation_id: "credential.revoke",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "secret_ref", id: "secretref:one" },
      expected_resource_revision: "generation:1:resolved",
      idempotency_key: "disconnect:one",
      input: {},
    };

    const result = await confirmAndInvokeHostOperation(request);

    expect(result.confirmed).toBe(true);
    expect(invoke).toHaveBeenCalledWith("confirm_and_invoke_host_operation", { request });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("confirmed_prompts");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("grant_ids");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("principal_id");
  });
});
