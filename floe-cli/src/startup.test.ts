import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { ForeignBusError, startAll, planSubstrateStart } from "./startup.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeBus(instanceId: string | null): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "floe-bus", instance_id: instanceId }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}` });
    });
  });
}

function environment(busUrl: string): { configPath: string; config: ReturnType<typeof defaultConfig> } {
  const home = mkdtempSync(join(tmpdir(), "floe-startup-"));
  roots.push(home);
  const config = defaultConfig(home);
  config.bus.http_base_url = busUrl;
  config.bus.ws_base_url = busUrl.replace("http", "ws");
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return { configPath, config };
}

describe("startAll refuses a bus it did not start", () => {
  it("fails loudly when a foreign process answers on the bus URL and we have no record", async () => {
    // The exact defect: a second install whose bus URL collides with a live bus
    // it never started. It must not register or seed into that bus.
    const bus = await fakeBus("someone-elses-instance");
    const { configPath, config } = environment(bus.url);

    await expect(startAll(configPath, config)).rejects.toBeInstanceOf(ForeignBusError);
  });

  it("fails loudly when the answering instance id does not match our record", async () => {
    // A stale predecessor answers on the URL; our recorded process is gone. The
    // instance id will not match, so restart must not report success.
    const bus = await fakeBus("stale-instance");
    const { configPath, config } = environment(bus.url);
    const servicesPath = join(config.home, "services.json");
    mkdirSync(config.home, { recursive: true });
    writeFileSync(servicesPath, JSON.stringify({
      bus: { pid: 999_999_999, started_at: new Date().toISOString(), command: "x", args: [], log_file: "x", instance_id: "our-newer-instance" },
    }), "utf8");

    await expect(startAll(configPath, config)).rejects.toBeInstanceOf(ForeignBusError);
    // The record is left untouched; we refused rather than adopting the foreign bus.
    expect(JSON.parse(readFileSync(servicesPath, "utf8")).bus.instance_id).toBe("our-newer-instance");
  });
});

describe("planSubstrateStart (connect-first policy)", () => {
  it("connects and spawns nothing when the bus is already reachable", () => {
    // Reachable always means connect, regardless of the start_on_demand policy — a
    // surface depends on the endpoint, not on a process being spawned for it.
    expect(planSubstrateStart(true, true)).toBe("connect");
    expect(planSubstrateStart(true, false)).toBe("connect");
  });

  it("starts the substrate when unreachable and the policy allows it (personal machine)", () => {
    expect(planSubstrateStart(false, true)).toBe("start");
  });

  it("blocks self-start when unreachable and the policy forbids it (managed service)", () => {
    expect(planSubstrateStart(false, false)).toBe("blocked");
  });
});
