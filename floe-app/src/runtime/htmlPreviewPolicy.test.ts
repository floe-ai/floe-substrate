import { afterEach, expect, it, vi } from "vitest";
import { installHtmlPreviewFramePolicy } from "./htmlPreviewPolicy.ts";
import { htmlPreviewHostUrl } from "../bus-client/transport.ts";

afterEach(() => {
  document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());
  vi.unstubAllGlobals();
});

it("allows only the exact same-origin preview host in a browser", () => {
  installHtmlPreviewFramePolicy();
  expect(document.head.querySelector("meta")?.content).toBe(`frame-src ${window.location.origin}/v1/previews/html`);
  expect(htmlPreviewHostUrl()).toBe("/v1/previews/html");
});

it("uses the static local preview host without native authority in its URL", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, location: { href: "http://tauri.localhost" } });
  installHtmlPreviewFramePolicy();
  expect(document.head.querySelector("meta")?.content).toBe("frame-src http://127.0.0.1:5377/v1/previews/html");
});
