import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ensureConfig } from "./config.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "floe-cli-cfg-"));
}

// An old config carrying the retired `web` / `start_web` keys. There is deliberately
// no migration; this must be rejected fast with an actionable reset instruction.
const OLD_CONFIG_WEB = {
  schema: "floe.local.v1",
  version: 1,
  home: "/tmp/floe",
  services: { start_on_demand: true, manager: "auto", start_web: true },
  bus: {
    listen: "127.0.0.1:5377",
    http_base_url: "http://127.0.0.1:5377",
    ws_base_url: "ws://127.0.0.1:5377",
    data_dir: "./bus",
    log_dir: "./logs/bus"
  },
  bridge: {
    data_dir: "./bridge",
    log_dir: "./logs/bridge",
    bus_url: "ws://127.0.0.1:5377",
    workspace_access: { local_paths: true }
  },
  web: {
    listen: "127.0.0.1:5378",
    bus_http_url: "http://127.0.0.1:5377",
    bus_ws_url: "ws://127.0.0.1:5377",
    data_dir: "./web",
    log_dir: "./logs/web"
  },
  library: {
    configs_dir: "./configs",
    skills_dir: "./skills",
    extensions_dir: "./extensions",
    mcp_dir: "./mcp",
    templates_dir: "./templates"
  }
};

// An old config carrying the retired `app` / `start_app` keys. floe-app left the
// repo; the substrate no longer knows an app exists, so a lingering app block is
// rejected fast with the same actionable reset instruction as any other retired key.
const OLD_CONFIG_APP = {
  schema: "floe.local.v1",
  version: 1,
  home: "/tmp/floe",
  services: { start_on_demand: true, manager: "auto", start_app: true },
  bus: {
    listen: "127.0.0.1:5377",
    http_base_url: "http://127.0.0.1:5377",
    ws_base_url: "ws://127.0.0.1:5377",
    data_dir: "./bus",
    log_dir: "./logs/bus"
  },
  bridge: {
    data_dir: "./bridge",
    log_dir: "./logs/bridge",
    bus_url: "ws://127.0.0.1:5377",
    workspace_access: { local_paths: true }
  },
  app: {
    listen: "127.0.0.1:5379",
    bus_http_url: "http://127.0.0.1:5377",
    bus_ws_url: "ws://127.0.0.1:5377",
    data_dir: "./app",
    log_dir: "./logs/app"
  },
  library: {
    configs_dir: "./configs",
    skills_dir: "./skills",
    extensions_dir: "./extensions",
    mcp_dir: "./mcp",
    templates_dir: "./templates"
  }
};

describe("incompatible config rejection (no migration)", () => {
  it("fails fast with an actionable reset instruction for an old web-keyed config", () => {
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      writeFileSync(cfgPath, YAML.stringify(OLD_CONFIG_WEB), "utf8");

      let thrown: Error | undefined;
      try {
        ensureConfig(cfgPath);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown, "expected ensureConfig to reject an incompatible config").toBeDefined();
      const message = thrown!.message;
      expect(message).toContain("incompatible with this version of Floe");
      expect(message).toContain("early development");
      expect(message).toContain("floe setup");
      expect(message).toContain(cfgPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not rewrite or migrate the incompatible config on disk", () => {
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      const original = YAML.stringify(OLD_CONFIG_WEB);
      writeFileSync(cfgPath, original, "utf8");

      expect(() => ensureConfig(cfgPath)).toThrow();

      expect(readFileSync(cfgPath, "utf8")).toBe(original);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails fast for an app-keyed config now that floe-app has left the repo", () => {
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      writeFileSync(cfgPath, YAML.stringify(OLD_CONFIG_APP), "utf8");

      let thrown: Error | undefined;
      try {
        ensureConfig(cfgPath);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown, "expected ensureConfig to reject an app-keyed config").toBeDefined();
      const message = thrown!.message;
      expect(message).toContain("incompatible with this version of Floe");
      expect(message).toContain("floe setup");
      expect(message).toContain(cfgPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("names the retired services.autostart split instead of guessing which meaning was intended", () => {
    // The operator's real case: a config written long ago when autostart meant
    // "install a login item". Its meaning must not be silently reinterpreted as
    // the start-on-demand policy — the error must name both replacements so the
    // person knows exactly what changed.
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      const legacy = {
        schema: "floe.local.v1",
        version: 1,
        home: "/tmp/floe",
        services: { autostart: false, manager: "auto" },
        bus: {
          listen: "127.0.0.1:5377",
          http_base_url: "http://127.0.0.1:5377",
          ws_base_url: "ws://127.0.0.1:5377",
          data_dir: "./bus",
          log_dir: "./logs/bus"
        },
        bridge: {
          data_dir: "./bridge",
          log_dir: "./logs/bridge",
          bus_url: "ws://127.0.0.1:5377",
          workspace_access: { local_paths: true }
        },
        library: {
          configs_dir: "./configs",
          skills_dir: "./skills",
          extensions_dir: "./extensions",
          mcp_dir: "./mcp",
          templates_dir: "./templates"
        }
      };
      writeFileSync(cfgPath, YAML.stringify(legacy), "utf8");

      let thrown: Error | undefined;
      try {
        ensureConfig(cfgPath);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown, "expected ensureConfig to reject a services.autostart config").toBeDefined();
      const message = thrown!.message;
      expect(message).toContain("services.autostart");
      expect(message).toContain("has been removed");
      expect(message).toContain("services.start_on_demand");
      expect(message).toContain("floe service");
      expect(message).toContain("floe setup");
      expect(message).toContain(cfgPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
