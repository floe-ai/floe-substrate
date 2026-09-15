import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { join } from "node:path";
import { registerIdentityCommand, type IdentityCommandDependencies } from "./identity-command.js";
import { defaultConfig } from "./config.js";

function harness(overrides: Partial<IdentityCommandDependencies> = {}) {
  const output: string[] = [];
  const calls: Array<{ url: string; body?: unknown }> = [];
  const program = new Command();
  program.exitOverride();
  const config = defaultConfig("/tmp/home");
  const deps: IdentityCommandDependencies = {
    output: (message) => output.push(message),
    resolve_config: () => ({ config }),
    fetch_host_control_token: async () => "host-token",
    fetch: (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/v1/local/workspaces")) {
        return new Response(JSON.stringify({
          workspaces: [
            { workspace_id: "workspace:alpha", name: "Alpha", locator: join("/repos", "alpha"), status: "bound" },
            { workspace_id: "workspace:beta", name: "Beta", locator: join("/repos", "beta"), status: "bound" },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        identity: { identity_id: "identity:1", display_name: "Dev", npub: "npub1dev" },
        workspaces: [{ workspace_id: "workspace:alpha", name: "Alpha" }],
      }), { status: 200 });
    }) as unknown as typeof fetch,
    ...overrides,
  };
  registerIdentityCommand(program, deps);
  return { program, output, calls };
}

describe("identity add resolves the workspace so a human never types an id", () => {
  it("admits into the workspace that contains the current directory", async () => {
    const { program, calls } = harness({ cwd: () => join("/repos", "alpha", "src") });
    await program.parseAsync(["identity", "add", "--name", "Dev", "--pubkey", "npub1dev"], { from: "user" });

    const admit = calls.find((c) => c.url.endsWith("/v1/identities"));
    expect(admit?.body).toMatchObject({ workspace_id: "workspace:alpha" });
  });

  it("prints the registered workspaces inline when the directory is outside all of them", async () => {
    const { program } = harness({ cwd: () => join("/elsewhere", "nope") });
    await expect(
      program.parseAsync(["identity", "add", "--name", "Dev", "--pubkey", "npub1dev"], { from: "user" }),
    ).rejects.toThrow(/workspace:alpha[\s\S]*workspace:beta/);
  });

  it("uses an explicit --workspace without resolving from the directory", async () => {
    const { program, calls } = harness({ cwd: () => join("/elsewhere", "nope") });
    await program.parseAsync(
      ["identity", "add", "--name", "Dev", "--pubkey", "npub1dev", "--workspace", "workspace:beta"],
      { from: "user" },
    );
    expect(calls.some((c) => c.url.endsWith("/v1/local/workspaces"))).toBe(false);
    const admit = calls.find((c) => c.url.endsWith("/v1/identities"));
    expect(admit?.body).toMatchObject({ workspace_id: "workspace:beta" });
  });
});
