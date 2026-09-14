import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadImageTool } from "./read-image.js";
import type { ToolContext } from "./types.js";

describe("bounded model image input", () => {
  let workspace: string;
  beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "floe-model-image-")); });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });
  const inspect = (path: string) => createReadImageTool({ workspaceRoot: workspace } as ToolContext).execute("inspect", { path });

  it("provides a bounded preview of the failed campaign's image dimensions without changing the original", async () => {
    const path = join(workspace, "campaign.jpg");
    await sharp({ create: { width: 7952, height: 5304, channels: 3, background: "#4f8070" } }).jpeg().toFile(path);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const original = await readFile(path);
    const result = await inspect("campaign.jpg");
    const image = result.content.find(item => item.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type !== "image") throw new Error("Missing image preview");
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(metadata.width).toBe(1536);
    expect(metadata.height).toBeLessThanOrEqual(1536);
    expect(result.details).toMatchObject({ original_width: 7952, original_height: 5304, preview_width: 1536, original_sha256: digest(original) });
    expect(digest(await readFile(path))).toBe(digest(original));
    expect(await readdir(workspace)).toEqual(["campaign.jpg"]);
  });

  it("honours image orientation and avoids enlarging a small source", async () => {
    await sharp({ create: { width: 100, height: 200, channels: 3, background: "#4f8070" } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(join(workspace, "portrait.jpg"));
    const result = await inspect("portrait.jpg");
    expect(result.details).toMatchObject({ preview_width: 200, preview_height: 100 });
  });

  it("returns a recoverable tool result instead of sending corrupt image bytes to the model", async () => {
    await writeFile(join(workspace, "broken.jpg"), "not an image");
    const result = await inspect("broken.jpg");
    expect(result.details?.ok).toBe(false);
    expect(result.content.some(item => item.type === "image")).toBe(false);
  });
});
