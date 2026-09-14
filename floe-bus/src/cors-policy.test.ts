import { describe, expect, it, vi } from "vitest";
import { createCorsOriginPolicy, trustedBrowserOrigins } from "./cors-policy.js";

describe("local Bus browser-origin policy", () => {
  it("allows native clients and the packaged or development app origins", () => {
    const policy = createCorsOriginPolicy(trustedBrowserOrigins("https://floe.example"));
    for (const origin of [
      undefined,
      "http://tauri.localhost",
      "tauri://localhost",
      "http://localhost:5379",
      "https://floe.example",
    ]) {
      const callback = vi.fn();
      policy(origin, callback);
      expect(callback).toHaveBeenCalledWith(null, true);
    }
  });

  it("does not allow an arbitrary website to call a loopback Bus", () => {
    const policy = createCorsOriginPolicy(new Set(["http://tauri.localhost"]));
    const callback = vi.fn();
    policy("https://attacker.example", callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });
});
