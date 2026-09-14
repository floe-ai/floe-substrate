import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Exercise the shipped runtime and scripts without a checkout or npm tree. */
export async function verifyPackagedHosts({ nodePath, resourcePath }) {
  const root = mkdtempSync(join(tmpdir(), "floe-packaged-hosts-"));
  const names = ["isolated-command-host-process", "isolated-extension-host-process"];
  try {
    cpSync(join(resourcePath, "node_modules"), join(root, "node_modules"), { recursive: true });
    const imageEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[key]) imageEnv[key] = process.env[key];
    }
    execFileSync(nodePath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import sharp from 'sharp';
      assert(import.meta.resolve('sharp').startsWith(new URL('./', import.meta.url).href));
      for (const format of ['png', 'jpeg', 'gif', 'webp']) {
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4f8070' } }).toFormat(format).toBuffer();
        const preview = await sharp(source, { pages: 1, limitInputPixels: 64 * 1024 * 1024 }).rotate().resize({ width: 32, height: 32, fit: 'inside' }).png().toBuffer();
        const metadata = await sharp(preview).metadata();
        assert.equal(metadata.width, 32);
        assert.equal(metadata.height, 24);
      }
    `], { cwd: root, env: imageEnv, stdio: "pipe", windowsHide: true });
    console.log("Packaged image decoder passed PNG, JPEG, GIF and WebP checks without the checkout.");
    for (const name of names) copyFileSync(join(resourcePath, `${name}.js`), join(root, `${name}.js`));
    await withHost(nodePath, root, names[0], "command_host_protocol", async (request) => {
      const input = {
        type: "invoke",
        implementation_id: "core.command.echo",
        implementation_revision: "1",
        entry_point: "echo",
        contract: { arguments: { work: "packaged proof" }, outputs: { ports: [{ name: "done" }] } },
      };
      const result = await request(input);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.deepEqual(result.result.outputs.done[0].value, { work: "packaged proof" });
      const refused = await request({ ...input, implementation_revision: "unavailable" });
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, "command_implementation_unavailable");
    });

    await withHost(nodePath, root, names[1], "process_protocol", async (request) => {
      const entry = { entry_point_id: "proof.run", kind: "capability", package_path: "run.js" };
      const packageVersion = {
        extension_package_version_id: "extpkg:packaged-proof",
        extension_id: "extension:packaged-proof",
        workspace_id: "workspace:packaged-proof",
        content_digest: "sha256:packaged-proof",
        definition: {
          entry_points: [entry],
          permissions: { network: [], filesystem: [], secrets: [], data: [], actions: [] },
        },
      };
      const activated = await request({
        type: "activate",
        package_version: packageVersion,
        entry_points: [{
          entry_point: entry,
          source: "export default input => ({ value: input.value, process: typeof process, require: typeof require, fetch: typeof fetch });",
        }],
        limits: {
          variant: "release", memory_limit_bytes: 32 * 1024 * 1024,
          stack_limit_bytes: 512 * 1024, execution_timeout_ms: 5_000,
        },
      });
      assert.equal(activated.ok, true, JSON.stringify(activated.error));
      const invoked = await request({
        type: "invoke", entry_point_id: entry.entry_point_id, request: { value: "packaged proof" },
        context: {
          workspace_id: packageVersion.workspace_id,
          authorized_principal_id: "principal:packaged-proof",
          operation_invocation_id: "invocation:packaged-proof",
          extension_id: packageVersion.extension_id,
          extension_package_version_id: packageVersion.extension_package_version_id,
          entry_point_id: entry.entry_point_id,
          execution_attempt_id: null,
          capability_grant_ids: [],
        },
      });
      assert.equal(invoked.ok, true, JSON.stringify(invoked.error));
      assert.deepEqual(invoked.result, {
        value: "packaged proof", process: "undefined", require: "undefined", fetch: "undefined",
      });
      const stopped = await request({ type: "deactivate" });
      assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
      assert.equal(stopped.result.disabled, true);
    });
    console.log("Packaged Command and Extension hosts passed isolated runtime checks.");
  } finally {
    // root is created locally by mkdtempSync; never use a caller-supplied cleanup path.
    rmSync(root, { recursive: true, force: true });
  }
}

async function withHost(nodePath, root, name, protocol, run) {
  const env = {};
  for (const key of process.platform === "win32" ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] : ["PATH", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(nodePath, ["--permission", `--allow-fs-read=${root}`, join(root, `${name}.js`)], {
    cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  let sequence = 0;
  const waitFor = (matches) => new Promise((resolveMessage, reject) => {
    const clean = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (!matches(message)) return;
      clean();
      resolveMessage(message);
    };
    const onError = (error) => { clean(); reject(error); };
    const onExit = (code) => onError(new Error(`${name} exited (${code}): ${stderr}`));
    const timer = setTimeout(() => onError(new Error(`${name} timed out: ${stderr}`)), 20_000);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  try {
    await waitFor((message) => message?.type === "ready" && message[protocol] === 1);
    await run(async (input) => {
      const requestId = `packaged-proof-${++sequence}`;
      const response = waitFor((message) => message?.type === "response" && message.request_id === requestId);
      child.send({ ...input, request_id: requestId });
      return response;
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => { child.once("exit", done); child.kill(); });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [nodePath, resourcePath] = process.argv.slice(2);
  if (!nodePath || !resourcePath) throw new Error("Usage: verify-packaged-hosts.mjs <packaged-node> <resources-directory>");
  await verifyPackagedHosts({ nodePath: resolve(nodePath), resourcePath: resolve(resourcePath) });
}
