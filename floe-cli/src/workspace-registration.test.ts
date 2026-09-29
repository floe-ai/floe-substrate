import { describe, expect, it, vi } from "vitest";

import type { IdentityClient, IdentityState, JoinOutcome } from "./identity/client.js";
import { NO_PERSON_NOTE, registerFolder } from "./workspace-registration.js";

const person = (kind: "locked" | "unlocked", protection: "device" | "passphrase" = "passphrase"): IdentityState => ({
  kind, protection, display_name: "Ada", npub: "npub1ada", pubkey_hex: "ab", secret_kind: "phrase",
});

function harness(state: IdentityState | null, outcome: JoinOutcome = { kind: "ready", workspace_id: "ws:1" }) {
  const joinFolder = vi.fn(async () => outcome);
  const close = vi.fn();
  const broker = vi.fn(async () => ({}));
  const lines: string[] = [];
  const deps = {
    connect: async () => {
      if (!state) throw new Error("agent not answering");
      return { state, joinFolder, close } as unknown as IdentityClient;
    },
    register_via_broker: broker,
    log: (line: string) => lines.push(line),
  };
  return { deps, joinFolder, close, broker, lines };
}

describe("registering a folder (O2)", () => {
  it.each([
    ["unlocked", person("unlocked")],
    ["device-protected", person("locked", "device")],
  ])("opens the folder as the signed-in person when %s", async (_name, state) => {
    const h = harness(state);
    expect(await registerFolder("C:/work", h.deps)).toEqual({ as: "person", display_name: "Ada", workspace_id: "ws:1" });
    expect(h.joinFolder).toHaveBeenCalledWith({ locator: "C:/work" });
    expect(h.broker).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
  });

  it.each([
    ["no agent", null],
    ["no identity", { kind: "none" } as IdentityState],
    ["a passphrase-locked identity", person("locked")],
  ])("registers through the host and says plainly the Actor has no access with %s", async (_name, state) => {
    const h = harness(state);
    expect(await registerFolder("C:/work", h.deps)).toEqual({ as: "host" });
    expect(h.joinFolder).not.toHaveBeenCalled();
    expect(h.broker).toHaveBeenCalledWith("C:/work");
    expect(h.lines).toEqual([NO_PERSON_NOTE]);
    expect(NO_PERSON_NOTE).toContain("its Floe Actor has no access until someone does");
  });

  it("does not fall back to the host when the person's own join is refused", async () => {
    const h = harness(person("unlocked"), { kind: "failed", workspace_id: "ws:1", reason: "template_invalid" });
    await expect(registerFolder("C:/work", h.deps)).rejects.toThrow("could not be prepared (template_invalid)");
    expect(h.broker).not.toHaveBeenCalled();
  });
});
