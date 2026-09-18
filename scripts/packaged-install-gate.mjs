import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCli = process.env.npm_execpath;
const runtimePin = "github:floe-ai/floe-runtime#4e21695972d29941f465f9edaf0f73a0a3c7acf0";
const root = mkdtempSync(join(tmpdir(), "floe-packaged-gate-"));
const stage = join(root, "packs");
const consumer = join(root, "consumer");
const home = join(root, "home");
const configPath = join(home, "config.json");
const artifactPath = resolve(
  process.env.FLOE_PACKAGED_GATE_ARTIFACT
    ?? join(tmpdir(), "floe-packaged-install-gate.json"),
);
const artifact = {
  schema: "floe.packaged-install-gate.v1",
  status: "failed",
  captured_at: new Date().toISOString(),
  temp_root: root,
  commands: [],
  package_resolution: {},
  services: {},
  readiness: {},
  operations: {},
  sdk_probe: {},
  error: null,
};
let cliEntry = null;
let environment = null;

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  artifact.commands.push({
    command: [command, ...args].join(" "),
    cwd: options.cwd ?? repoRoot,
    outcome: "passed",
  });
  return result ?? "";
}

function runNpm(args, options = {}) {
  if (!npmCli) throw new Error("npm_execpath is unavailable; run this gate through npm.");
  return run(process.execPath, [npmCli, ...args], options);
}

function inside(child, parent) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function packageManifestForEntry(entry, expectedName) {
  let directory = dirname(entry);
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === expectedName) return manifest;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`could not locate ${expectedName} package.json from ${entry}`);
    directory = parent;
  }
}

function sanitize(value, key = "") {
  if (/token|bearer|authorization|credential|secret/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  }
  return value;
}

async function availablePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolveClose => server.close(resolveClose));
  assert(port > 0, "could not allocate an isolated Bus port");
  return port;
}

function pack(packageName) {
  const output = runNpm(["pack", "--json", "--pack-destination", stage], {
    cwd: join(repoRoot, packageName),
    capture: true,
  });
  const parsed = JSON.parse(output);
  assert(Array.isArray(parsed) && parsed.length === 1 && parsed[0].filename, `${packageName} did not produce one tarball`);
  return join(stage, parsed[0].filename);
}

async function probeInstalledSdk(requireFromConsumer) {
  const bridgePackage = requireFromConsumer.resolve("floe-bridge/package.json");
  const runtimePackage = packageManifestForEntry(requireFromConsumer.resolve("floe-runtime"), "floe-runtime");
  const requireFromRuntime = createRequire(runtimePackage);
  const sdkEntry = requireFromRuntime.resolve("@github/copilot-sdk");
  const adapterEntry = join(dirname(bridgePackage), "dist", "adapters", "floe-runtime-adapter.js");
  const [{ FloeRuntimeAdapter }, { CopilotSession }] = await Promise.all([
    import(pathToFileURL(adapterEntry).href),
    import(pathToFileURL(sdkEntry).href),
  ]);

  const callbacks = [];
  let offered = [];
  class DeterministicRuntime extends EventEmitter {
    capabilities() { return { directTools: true }; }
    async setModel() {}
    async interrupt() {}
    async quiesce() {}
    async close() {}
    async run(_role, _input, _cwd, onSession, settings) {
      offered = settings.availableTools ?? [];
      await onSession("packaged-sdk-session");
      let resolveCallbacks;
      const callbacksComplete = new Promise(resolveDone => { resolveCallbacks = resolveDone; });
      const sdkSession = new CopilotSession("packaged-sdk-session", {});
      sdkSession._rpc = {
        tools: {
          handlePendingToolCall: async value => {
            callbacks.push(value);
            if (callbacks.length === 2) resolveCallbacks();
          },
        },
      };
      sdkSession.registerTools(settings.tools);
      sdkSession._dispatchEvent({
        type: "external_tool.requested",
        data: {
          requestId: "request-emit",
          toolCallId: "call-emit",
          toolName: "emit",
          arguments: { type: "message", destination: "operator", text: "packaged emit" },
        },
      });
      sdkSession._dispatchEvent({
        type: "external_tool.requested",
        data: {
          requestId: "request-request",
          toolCallId: "call-request",
          toolName: "request",
          arguments: { actor: "operator", work: "packaged request" },
        },
      });
      await Promise.race([
        callbacksComplete,
        new Promise((_, reject) => setTimeout(() => reject(new Error("installed SDK callbacks timed out")), 5_000)),
      ]);
      return {
        text: "packaged probe complete",
        sessionId: "packaged-sdk-session",
        stopReason: "idle",
        usage: null,
        elapsedMs: 1,
      };
    }
  }

  const emitted = [];
  const telemetry = [];
  const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => new DeterministicRuntime() });
  await adapter.handleBundle({
    bridge_id: "bridge:packaged-gate",
    bus: {
      async getContext() { return null; },
      async listEndpoints() {
        return [{ endpoint_id: "actor:workspace:gate:operator", name: "operator" }];
      },
      async emit(event) {
        emitted.push(event);
        return {
          event_id: `event-${emitted.length}`,
          accepted_at: "2026-01-01T00:00:00.000Z",
          event: { artefact_version_ids: [] },
        };
      },
      async recordRuntimeTurnResult() {
        return { request_resolved: false, result_event: { event_id: "event-result" }, return_event: null };
      },
      async appendRuntimeTelemetry(entry) { telemetry.push(entry); },
    },
  }, {
    delivery_id: "delivery-packaged-gate",
    endpoint_id: "actor:workspace:gate:floe",
    workspace_id: "workspace:gate",
    context_id: "context:gate",
    events: [{
      event_id: "event-trigger",
      type: "message",
      context_id: "context:gate",
      source_endpoint_id: "actor:workspace:gate:operator",
      content: { text: "deterministic packaged SDK probe" },
    }],
  });

  const callbackNames = callbacks.map(callback => callback.result?.resultType);
  const callbackRequests = callbacks.map(callback => callback.requestId);
  assert(offered.includes("emit") && offered.includes("request"), "installed adapter did not offer request and emit");
  assert(callbacks.length === 2 && callbackNames.every(name => name === "success"), "installed SDK did not dispatch both callbacks");
  assert(
    callbackRequests.includes("request-emit") && callbackRequests.includes("request-request"),
    "installed SDK callbacks did not match emit and request",
  );
  return {
    offered_tool_names: offered,
    callback_count: callbacks.length,
    callback_request_ids: callbackRequests,
    callback_result_types: callbackNames,
    emitted_event_count: emitted.length,
    tool_evidence_recorded: telemetry.some(entry => entry.kind === "sdk_tool_evidence"),
  };
}

try {
  mkdirSync(stage, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "floe-packaged-gate-consumer",
    version: "1.0.0",
    private: true,
  }, null, 2));

  runNpm(["run", "check:build", "--workspace", "floe-bridge"]);
  runNpm(["run", "check:pack", "--workspace", "floe-bridge"]);
  runNpm(["run", "build", "--workspace", "floe-cli"]);
  runNpm(["run", "build", "--workspace", "floe-bus"]);
  const tarballs = ["floe-cli", "floe-bus", "floe-bridge"].map(pack);
  runNpm(["install", "--save-exact", ...tarballs], { cwd: consumer });

  const requireFromConsumer = createRequire(join(consumer, "package.json"));
  const runtimePackage = packageManifestForEntry(requireFromConsumer.resolve("floe-runtime"), "floe-runtime");
  const requireFromRuntime = createRequire(runtimePackage);
  const sdkEntry = requireFromRuntime.resolve("@github/copilot-sdk");
  const resolutions = {
    cli: requireFromConsumer.resolve("floe-cli/package.json"),
    bus: requireFromConsumer.resolve("floe-bus/package.json"),
    bridge: requireFromConsumer.resolve("floe-bridge/package.json"),
    runtime: runtimePackage,
    copilot_sdk: packageManifestForEntry(sdkEntry, "@github/copilot-sdk"),
  };
  for (const [name, path] of Object.entries(resolutions)) {
    assert(inside(path, join(consumer, "node_modules")), `${name} resolved outside the clean consumer: ${path}`);
    assert(!inside(path, join(repoRoot, "node_modules")), `${name} leaked from the source checkout`);
  }
  const runtimeManifest = JSON.parse(readFileSync(resolutions.runtime, "utf8"));
  const sdkManifest = JSON.parse(readFileSync(resolutions.copilot_sdk, "utf8"));
  const bridgeManifest = JSON.parse(readFileSync(resolutions.bridge, "utf8"));
  const consumerLock = readFileSync(join(consumer, "package-lock.json"), "utf8");
  assert(bridgeManifest.dependencies?.["floe-runtime"] === runtimePin, "installed Bridge does not declare the exact runtime commit");
  assert(runtimeManifest.dependencies?.["@github/copilot-sdk"] === "1.0.13", "installed runtime does not declare Copilot SDK 1.0.13");
  assert(sdkManifest.version === "1.0.13", "installed Copilot SDK is not 1.0.13");
  assert(consumerLock.includes("4e21695972d29941f465f9edaf0f73a0a3c7acf0"), "consumer lock does not retain the exact runtime commit");
  const npmTree = JSON.parse(runNpm(["ls", "--all", "--json"], { cwd: consumer, capture: true }));
  assert(!JSON.stringify(npmTree).includes("\"extraneous\":true"), "clean consumer contains an extraneous dependency");
  artifact.package_resolution = {
    ...resolutions,
    bridge_runtime_pin: bridgeManifest.dependencies["floe-runtime"],
    runtime_dependency: runtimeManifest.dependencies["@github/copilot-sdk"],
    copilot_sdk_version: sdkManifest.version,
    runtime_commit_locked: true,
    extraneous_dependencies: false,
  };

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = {
    schema: "floe.local.v1",
    version: 1,
    home,
    services: { start_on_demand: true, manager: "auto" },
    bus: {
      listen: `127.0.0.1:${port}`,
      http_base_url: baseUrl,
      ws_base_url: `ws://127.0.0.1:${port}`,
      data_dir: "./bus",
      log_dir: "./logs/bus",
    },
    bridge: {
      data_dir: "./bridge",
      log_dir: "./logs/bridge",
      bus_url: `ws://127.0.0.1:${port}`,
      workspace_access: { local_paths: true },
      runtime_adapter: "fake",
    },
    library: {
      configs_dir: "./configs",
      skills_dir: "./skills",
      extensions_dir: "./extensions",
      mcp_dir: "./mcp",
      templates_dir: "./templates",
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  cliEntry = join(dirname(resolutions.cli), "dist", "index.js");
  environment = {
    ...process.env,
    NODE_PATH: "",
    HOME: home,
    USERPROFILE: home,
    FLOE_CONFIG: configPath,
    FLOE_BUS_HTTP_BASE: baseUrl,
  };
  run(process.execPath, [cliEntry, "--config", configPath, "start"], {
    cwd: consumer,
    env: environment,
    capture: true,
  });
  const health = await fetch(`${baseUrl}/health`).then(response => response.json());
  assert(health.ok === true && typeof health.instance_id === "string", "installed Bus readiness was not current");
  const status = run(process.execPath, [cliEntry, "--config", configPath, "status"], {
    cwd: consumer,
    env: environment,
    capture: true,
  });
  const records = JSON.parse(readFileSync(join(home, "services.json"), "utf8"));
  assert(records.bus?.pid > 0 && records.bridge?.pid > 0, "installed CLI did not record both service PIDs");
  process.kill(records.bus.pid, 0);
  process.kill(records.bridge.pid, 0);
  artifact.services = {
    bus_pid: records.bus.pid,
    bridge_pid: records.bridge.pid,
    bus_entry: records.bus.args?.[0],
    bridge_entry: records.bridge.args?.[0],
  };
  artifact.readiness = { health, status: status.trim() };

  const operationsText = run(process.execPath, [
    cliEntry,
    "--config",
    configPath,
    "operations",
    "list",
    "--host",
    "--json",
  ], { cwd: consumer, env: environment, capture: true });
  const operations = JSON.parse(operationsText);
  assert(Array.isArray(operations.operations) && operations.operations.length > 0, "installed operations list was empty");
  artifact.operations = {
    count: operations.operations.length,
    first_operation_id: operations.operations[0]?.operation_id ?? null,
  };
  artifact.sdk_probe = await probeInstalledSdk(requireFromConsumer);
  assert(artifact.sdk_probe.tool_evidence_recorded === true, "installed adapter omitted SDK tool evidence");
  artifact.status = "passed";
} catch (error) {
  artifact.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (cliEntry && environment && existsSync(cliEntry)) {
    try {
      run(process.execPath, [cliEntry, "--config", configPath, "stop"], {
        cwd: consumer,
        env: environment,
        capture: true,
      });
    } catch (error) {
      artifact.stop_error = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    const recordsPath = join(home, "services.json");
    if (existsSync(recordsPath)) {
      const records = JSON.parse(readFileSync(recordsPath, "utf8"));
      for (const service of ["bridge", "bus"]) {
        const pid = records[service]?.pid;
        if (typeof pid === "number" && pid > 0) {
          try { process.kill(pid); } catch {}
        }
      }
    }
  } finally {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(sanitize(artifact), null, 2));
    rmSync(root, { recursive: true, force: true });
  }
}

if (artifact.status === "passed") {
  console.log(`Packaged clean-install gate passed. Artifact: ${artifactPath}`);
} else {
  console.error(`Packaged clean-install gate failed. Artifact: ${artifactPath}`);
}
