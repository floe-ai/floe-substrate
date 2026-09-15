import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig } from "./config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function bus() {
  const home = mkdtempSync(join(tmpdir(), "floe-errboundary-"));
  roots.push(home);
  const config = defaultConfig(home);
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return createBusServer(configPath, config, { host_control_token: "test-host-control-token-abcdefghijklmnop" });
}

describe("the bus never leaks internal detail across the trust boundary", () => {
  it("masks an uncaught database error to an unprivileged caller and keeps the detail internal", async () => {
    // Reproduce a mis-migrated bus exactly as a client hit it: the challenge
    // table is missing, so issuing a challenge throws a raw SQLite error.
    const server = await bus();
    server.store.db.exec("DROP TABLE client_identity_challenges");

    const response = await server.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    await server.app.close();

    expect(response.statusCode).toBe(500);
    const body = response.json() as { error: string; message: string; request_id?: string };
    expect(body.error).toBe("internal_error");
    // The caller must receive nothing it cannot act on and no internal detail.
    expect(response.payload).not.toContain("no such table");
    expect(response.payload).not.toContain("client_identity_challenges");
    expect(response.payload).not.toContain("ERR_SQLITE");
    // A correlation id lets an operator find the real detail in the logs.
    expect(body.request_id).toBeTruthy();
  });
});
