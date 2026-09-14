import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationAttachments,
  uploadConversationAttachments,
} from "./conversationAttachments.ts";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  vi.clearAllMocks();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("conversation attachments", () => {
  it("renders canonical Event versions without requiring display metadata, and ignores unbound version claims", () => {
    expect(conversationAttachments({ attachments: [
      { artefact_version_id: "version:unbound", name: "Do not show.md" },
      { artefact_version_id: "version:two", name: "brief.md" },
    ] }, ["version:one", "version:two", "version:one"])).toMatchObject([
      { artefact_version_id: "version:one", name: "Saved result 1" },
      { artefact_version_id: "version:two", name: "brief.md" },
    ]);
  });
  it("parses only usable attachment references", () => {
    expect(conversationAttachments({
      attachments: [
        { artefact_version_id: "artefact-version:new", name: "new.png", media_type: "image/png", bytes: 84 },
        { path: ".floe/state/attachments/c/a.png", name: "a.png", media_type: "image/png", bytes: 42 },
        { name: "missing-reference.png" },
      ],
    })).toEqual([
      {
        artefact_version_id: "artefact-version:new",
        path: null,
        name: "new.png",
        media_type: "image/png",
        bytes: 84,
      },
      {
        artefact_version_id: null,
        path: ".floe/state/attachments/c/a.png",
        name: "a.png",
        media_type: "image/png",
        bytes: 42,
      },
    ]);
  });

  it("stages only the selected bytes through the desktop IPC boundary", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const file = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });
    invoke.mockResolvedValue({
      ingress_session_id: "attachment-ingress:one",
      workspace_id: "workspace",
      context_id: "context",
      name: "screen.png",
      media_type: "image/png",
      size_bytes: 3,
      digest: { algorithm: "sha256", value: "a".repeat(64) },
    });

    const result = await uploadConversationAttachments(
      "workspace",
      "context",
      [file],
    );

    expect(invoke).toHaveBeenCalledWith("upload_context_attachment", {
      workspaceId: "workspace",
      contextId: "context",
      fileName: "screen.png",
      mediaType: "image/png",
      bytes: [1, 2, 3],
    });
    expect(result[0]?.ingress_session_id).toBe("attachment-ingress:one");
  });

  it("does not offer host-file ingress from the remote browser client", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    await expect(uploadConversationAttachments(
      "workspace",
      "context",
      [file],
    )).rejects.toThrow("desktop app");
    expect(invoke).not.toHaveBeenCalled();
  });
});
