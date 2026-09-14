import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged desktop security policy", () => {
  it("ships the isolated workers required by the bundled substrate", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    expect(config.bundle.resources).toEqual(expect.arrayContaining([
      "resources/isolated-command-host-process.js",
      "resources/isolated-extension-host-process.js",
    ]));
  });

  it("uses a constrained CSP with authenticated media object URLs", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    const csp = String(config.app.security.csp);

    expect(csp).not.toBe("null");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' asset: http://asset.localhost blob: data:");
    expect(csp).not.toContain("connect-src *");
    expect(csp).toContain("frame-src http://127.0.0.1:5377/v1/previews/html;");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("script-src 'unsafe-eval'");
  });

  it("never kills substrate processes it cannot prove the desktop owns", () => {
    const launcher = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

    expect(launcher).not.toContain("taskkill");
    expect(launcher).not.toContain("/IM");
    expect(launcher).not.toContain("floe-node.exe");
    expect(launcher).toContain("left that process untouched");
  });
});
