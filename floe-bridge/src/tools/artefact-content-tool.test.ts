import { afterEach, describe, expect, it, vi } from "vitest";
import { BusClient } from "../bus-client.js";
import { createArtefactContentTool } from "./artefact-content-tool.js";

const turn = {
  delivery_id: "delivery:one", tool_activity: [],
  operation_authority_session: {
    authority_session_id: "session:one", bearer_token: "delivery-authority", expires_at: "2099-01-01T00:00:00.000Z",
  },
};
const client = new BusClient("http://127.0.0.1:5377");
const tool = createArtefactContentTool(client, "workspace:one", { getActiveTurn: () => turn });
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRk0AAAAASUVORK5CYII=", "base64");

afterEach(() => vi.unstubAllGlobals());

describe("exact ArtefactVersion model input", () => {
  it("reads all saved text in bounded pages without needing a mutable file", async () => {
    const saved = "a".repeat(15_999) + "🌱" + "b".repeat(10_000);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(saved, { headers: {
      "content-type": "text/html", "x-floe-artefact-version-id": "version:text",
    } })));
    vi.stubGlobal("fetch", fetchMock);
    const first = await tool.execute("first", { artefact_version_id: "version:text" });
    expect(first.details).toMatchObject({ ok: true, truncated: true, offset: 0, next_offset: 15_999 });
    const second = await tool.execute("rest", { artefact_version_id: "version:text", offset: first.details.next_offset });
    expect(second.details).toMatchObject({ ok: true, truncated: false, next_offset: null });
    expect(first.content[1]).toEqual({ type: "text", text: saved.slice(0, 15_999) });
    expect(second.content[1]).toEqual({ type: "text", text: saved.slice(15_999) });
    expect(JSON.stringify(second.content)).toContain("🌱");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options.headers.authorization === "Bearer delivery-authority")).toBe(true);
  });

  it("can inspect a narrow saved-text range and reports the next exact offset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("first line\nsecond line\nlast line", { headers: {
      "content-type": "text/plain", "x-floe-artefact-version-id": "version:text",
    } })));
    const result = await tool.execute("range", { artefact_version_id: "version:text", offset: 11, limit: 6 });
    expect(result.content[1]).toEqual({ type: "text", text: "second" });
    expect(result.details).toMatchObject({ ok: true, offset: 11, next_offset: 17, first_line: 2 });
  });

  it("rechecks authority for later pages and never returns cached saved bytes after refusal", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("x".repeat(20_000), { headers: {
      "content-type": "text/plain", "x-floe-artefact-version-id": "version:text",
    } })).mockResolvedValueOnce(new Response("access revoked", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await tool.execute("first", { artefact_version_id: "version:text" });
    const refused = await tool.execute("rest", { artefact_version_id: "version:text", offset: first.details.next_offset });
    expect(refused.details).toMatchObject({ ok: false });
    expect(JSON.stringify(refused.content)).not.toContain("xxxx");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("presents image bytes from authenticated content retrieval without a filename extension", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(imageBytes, { headers: {
      "content-type": "image/png", "x-floe-artefact-version-id": "version:image",
    } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await tool.execute("inspect", { artefact_version_id: "version:image" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5377/v1/workspaces/workspace%3Aone/artefact-versions/version%3Aimage/content",
      { headers: { authorization: "Bearer delivery-authority" }, redirect: "error" },
    );
    expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: imageBytes.toString("base64") });
    expect(JSON.stringify(result)).not.toContain("delivery-authority");
  });

  it("refuses content for a different version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(imageBytes, { headers: {
      "content-type": "image/png", "x-floe-artefact-version-id": "version:other",
    } })));
    const result = await tool.execute("inspect", { artefact_version_id: "version:image" });
    expect(result.details).toMatchObject({ ok: false });
    expect(result.content.some(item => item.type === "image")).toBe(false);
  });

  it("requires active Delivery authority before reading shared content", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const idleTool = createArtefactContentTool(client, "workspace:one", { getActiveTurn: () => undefined });
    expect((await idleTool.execute("inspect", { artefact_version_id: "version:image" })).details).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds text and refuses an oversized stream without relying on Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("x".repeat(20_000), { headers: {
      "content-type": "text/plain", "x-floe-artefact-version-id": "version:text",
    } })).mockResolvedValueOnce(new Response(new Uint8Array(20 * 1024 * 1024 + 1), { headers: {
      "content-type": "image/png", "x-floe-artefact-version-id": "version:large",
    } })));
    expect((await tool.execute("read", { artefact_version_id: "version:text" })).details)
      .toMatchObject({ ok: true, truncated: true });
    const oversized = await tool.execute("read", { artefact_version_id: "version:large" });
    expect(oversized.details).toMatchObject({ ok: false });
    expect(JSON.stringify(oversized.content)).toContain("20MB");
  });
});
