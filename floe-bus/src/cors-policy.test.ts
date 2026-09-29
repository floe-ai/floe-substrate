import { describe, expect, it, vi } from "vitest";
import { createCorsDelegator, trustedBrowserOrigins } from "./cors-policy.js";

describe("local Bus browser-origin policy", () => {
  it("allows native clients and the packaged or development app origins", () => {
    const trusted = trustedBrowserOrigins("https://floe.example");
    const policy = createCorsDelegator((origin) => trusted.has(origin));
    for (const origin of [undefined, "http://tauri.localhost", "tauri://localhost", "http://localhost:5379", "https://floe.example"]) {
      const callback = vi.fn();
      policy({ headers: { origin }, url: "/v1/anything" }, callback);
      expect(callback).toHaveBeenCalledWith(null, { origin: true, credentials: origin !== undefined });
    }
  });

  it("does not allow an arbitrary website to call a loopback Bus", () => {
    const policy = createCorsDelegator((origin) => origin === "http://tauri.localhost");
    const callback = vi.fn();
    policy({ headers: { origin: "https://attacker.example" }, url: "/v1/anything" }, callback);
    expect(callback).toHaveBeenCalledWith(null, { origin: false, credentials: false });
  });

  it("decides on the path without its query", () => {
    const seen: string[] = [];
    const policy = createCorsDelegator((_origin, path) => { seen.push(path); return true; });
    policy({ headers: { origin: "http://127.0.0.1:43127" }, url: "/v1/browser/connections?x=1" }, vi.fn());
    expect(seen).toEqual(["/v1/browser/connections"]);
  });
});
