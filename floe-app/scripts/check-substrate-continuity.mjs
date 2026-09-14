import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Close the desktop's output readers while the actual packaged service runs. */
export async function verifySubstrateContinuity({ nodePath, resourcePath }) {
  const root = await mkdtemp(join(tmpdir(), "floe-console-continuity-"));
  let child;
  try {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const httpUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}`;
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, JSON.stringify({
      schema: "floe.local.v1", version: 1, home: root,
      services: { autostart: true, manager: "auto", start_app: false },
      bus: { listen: `127.0.0.1:${port}`, http_base_url: httpUrl, ws_base_url: wsUrl, data_dir: "./bus", log_dir: "./logs/bus" },
      bridge: { data_dir: "./bridge", log_dir: "./logs/bridge", bus_url: wsUrl, workspace_access: { local_paths: true } },
      app: { listen: "127.0.0.1:0", bus_http_url: httpUrl, bus_ws_url: wsUrl, data_dir: "./app", log_dir: "./logs/app" },
      library: { configs_dir: "./configs", skills_dir: "./skills", extensions_dir: "./extensions", mcp_dir: "./mcp", templates_dir: "./templates" },
    }));
    const fixture = join(root, "console-lifetime.mjs");
    await writeFile(fixture, `
      process.on('uncaughtExceptionMonitor', error => process.send?.({ error: error.code ?? error.message }));
      process.argv = [process.execPath, 'fixture', 'substrate'];
      await import(${JSON.stringify(pathToFileURL(join(resourcePath, "floe-desktop.js")).href)});
      process.on('message', message => {
        if (message.fail) {
          process.stdout.emit('error', Object.assign(new Error('unrelated I/O failure'), { code: 'EIO' }));
          return;
        }
        // Bridge diagnostics use both console streams. A health read alone
        // does not reproduce their failure on a closed Windows pipe.
        console.log('[continuity] work started');
        console.error('[continuity] diagnostic recorded');
        process.send({ written: true });
      });
      process.send({ ready: true });
    `);
    const env = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    child = spawn(nodePath, [fixture], {
      cwd: resourcePath, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...env, FLOE_CONFIG: configPath, FLOE_HOST_CONTROL_TOKEN: randomBytes(32).toString("hex") },
    });
    let stderr = "";
    const errors = [];
    child.stdout.resume();
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    child.on("message", message => { if (message.error) errors.push(message.error); });
    const startup = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    assert.equal(startup[0].ready, true, stderr);
    assert.equal((await fetch(httpUrl + "/health")).status, 200);

    child.stdout.destroy();
    child.stderr.destroy();
    for (let index = 0; index < 3; index++) {
      assert.equal(child.exitCode, null, `Service exited after desktop output closed: ${errors.join(", ")}`);
      const written = once(child, "message", { signal: AbortSignal.timeout(2_000) });
      child.send({ write: true });
      assert.equal((await written)[0].written, true);
      await delay(200);
    }
    assert.deepEqual(errors, [], "Console disconnect must not crash the service");
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(httpUrl + "/health")).status, 200);
    console.log("Packaged substrate kept running after both desktop console pipes closed.");
    const exited = once(child, "exit", { signal: AbortSignal.timeout(2_000) });
    child.send({ fail: true });
    assert.equal((await exited)[0], 1, "Unrelated I/O failures must remain visible");
    assert.deepEqual(errors, ["EIO"]);
    console.log("Unrelated console I/O errors still fail visibly.");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    // Only remove the exact temporary directory created by this check.
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await verifySubstrateContinuity({
    nodePath: process.argv[2] ?? process.execPath,
    resourcePath: resolve(process.argv[3] ?? join(appRoot, "src-tauri/resources")),
  });
}
