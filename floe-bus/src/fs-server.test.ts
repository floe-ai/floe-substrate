/**
 * HTTP-level tests for the workspace filesystem surface added to server.ts
 * (/v1/fs/capability, /v1/fs/browse, /v1/workspaces/:id/fs/agents,
 * /v1/workspaces/:id/fs/file, /v1/workspaces/:id/fs/media). These are additive routes consumed by
 * floe-app when the console is remote from the box running the bus.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

function localHeaders(handle: ServerHandle) {
  return { authorization: `Bearer ${handle.localControlToken}` };
}

async function makeServer(opts?: { localPaths?: boolean }): Promise<{
  handle: ServerHandle;
  cleanup: () => Promise<void>;
  workspaceDir: string;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-fs-srv-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  cfg.bridge.workspace_access.local_paths = opts?.localPaths ?? true;
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { allow_unauthenticated_test_requests: true });
  await handle.app.ready();

  const workspaceDir = join(tmp, "my-workspace");
  mkdirSync(workspaceDir, { recursive: true });

  return {
    handle,
    workspaceDir,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

async function registerWorkspace(handle: ServerHandle, locator: string): Promise<string> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator, name: "fs-test-ws" }
  });
  expect(res.statusCode).toBe(201);
  return res.json().workspace.workspace_id as string;
}

describe("GET /v1/fs/capability", () => {
  it("reports local_paths enabled", async () => {
    const { handle, cleanup } = await makeServer({ localPaths: true });
    try {
      const res = await handle.app.inject({ method: "GET", url: "/v1/fs/capability" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ local_paths: true });
    } finally {
      await cleanup();
    }
  });

  it("reports local_paths disabled", async () => {
    const { handle, cleanup } = await makeServer({ localPaths: false });
    try {
      const res = await handle.app.inject({ method: "GET", url: "/v1/fs/capability" });
      expect(res.json()).toEqual({ local_paths: false });
    } finally {
      await cleanup();
    }
  });
});

describe("GET /v1/fs/browse", () => {
  it("lists subdirectories of a given path", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      mkdirSync(join(workspaceDir, "alpha"));
      mkdirSync(join(workspaceDir, "beta"));
      writeFileSync(join(workspaceDir, "not-a-dir.txt"), "hi");

      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/fs/browse?path=${encodeURIComponent(workspaceDir)}`,
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe(workspaceDir);
      expect(body.parent).toBe(join(workspaceDir, ".."));
      const names = body.entries.map((e: { name: string }) => e.name);
      expect(names).toContain("alpha");
      expect(names).toContain("beta");
      expect(names).not.toContain("not-a-dir.txt");
    } finally {
      await cleanup();
    }
  });

  it("defaults to home dir when path is omitted", async () => {
    const { handle, cleanup } = await makeServer();
    try {
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/fs/browse",
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().path).toBe("string");
    } finally {
      await cleanup();
    }
  });

  it("is gated off when local_paths is disabled", async () => {
    const { handle, cleanup } = await makeServer({ localPaths: false });
    try {
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/fs/browse",
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fs_disabled");
    } finally {
      await cleanup();
    }
  });
});

describe("GET /v1/workspaces/:workspace_id/fs/agents", () => {
  it("lists .floe/agents/*.md files relative to the workspace root", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);
      mkdirSync(join(workspaceDir, ".floe/agents/floe/worklogs"), { recursive: true });
      writeFileSync(join(workspaceDir, ".floe/agents/floe.md"), "# floe");
      writeFileSync(join(workspaceDir, ".floe/agents/floe/worklogs/2026-06-16.md"), "# log");
      writeFileSync(join(workspaceDir, ".floe/agents/notes.txt"), "not markdown");

      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/agents`,
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(200);
      const files = res.json().files as string[];
      expect(files).toContain(".floe/agents/floe.md");
      expect(files).toContain(".floe/agents/floe/worklogs/2026-06-16.md");
      expect(files).not.toContain(".floe/agents/notes.txt");
    } finally {
      await cleanup();
    }
  });

  it("returns 404 for an unknown workspace", async () => {
    const { handle, cleanup } = await makeServer();
    try {
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/workspaces/workspace:does-not-exist/fs/agents",
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it("is gated off when local_paths is disabled", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer({ localPaths: false });
    try {
      // Even with fs disabled, register would also be additive elsewhere; the
      // gate must reject before resolving anything workspace-specific.
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/workspaces/workspace:whatever/fs/agents",
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fs_disabled");
      void workspaceDir;
    } finally {
      await cleanup();
    }
  });
});

describe("GET/PUT /v1/workspaces/:workspace_id/fs/file", () => {
  it("round-trips a write then a read", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);

      const putRes = await handle.app.inject({
        method: "PUT",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file`,
        headers: localHeaders(handle),
        payload: { path: ".floe/agents/new-agent.md", contents: "---\nagent_id: new-agent\n---\nHello" }
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json()).toEqual({ ok: true });

      const getRes = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file?path=${encodeURIComponent(".floe/agents/new-agent.md")}`,
        headers: localHeaders(handle),
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().contents).toBe("---\nagent_id: new-agent\n---\nHello");
    } finally {
      await cleanup();
    }
  });

  it("returns 404 reading a file that doesn't exist", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file?path=${encodeURIComponent(".floe/agents/nope.md")}`,
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it("rejects path traversal escaping the workspace root with 400 path_escapes_root", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);

      const getRes = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file?path=${encodeURIComponent("../../etc/passwd")}`,
        headers: localHeaders(handle),
      });
      expect(getRes.statusCode).toBe(400);
      expect(getRes.json().error).toBe("path_escapes_root");

      const putRes = await handle.app.inject({
        method: "PUT",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file`,
        headers: localHeaders(handle),
        payload: { path: "../../etc/passwd", contents: "pwned" }
      });
      expect(putRes.statusCode).toBe(400);
      expect(putRes.json().error).toBe("path_escapes_root");
    } finally {
      await cleanup();
    }
  });

  it("rejects an absolute path", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file?path=${encodeURIComponent("/etc/passwd")}`,
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("path_escapes_root");
    } finally {
      await cleanup();
    }
  });

  it("is gated off when local_paths is disabled", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer({ localPaths: false });
    try {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/workspace:whatever/fs/file?path=${encodeURIComponent("a.md")}`,
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("fs_disabled");
      void workspaceDir;
    } finally {
      await cleanup();
    }
  });

  it("creates parent directories as needed on write", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);
      const putRes = await handle.app.inject({
        method: "PUT",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file`,
        headers: localHeaders(handle),
        payload: { path: ".floe/agents/deeply/nested/agent.md", contents: "nested" }
      });
      expect(putRes.statusCode).toBe(200);

      const getRes = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/file?path=${encodeURIComponent(".floe/agents/deeply/nested/agent.md")}`,
        headers: localHeaders(handle),
      });
      expect(getRes.json().contents).toBe("nested");
    } finally {
      await cleanup();
    }
  });
});

describe("GET /v1/workspaces/:workspace_id/fs/media", () => {
  it("serves a workspace-contained raster image without caching stale bytes", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      writeFileSync(join(workspaceDir, "preview.png"), bytes);
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/media?path=${encodeURIComponent("preview.png")}`,
        headers: localHeaders(handle),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.rawPayload).toEqual(bytes);
    } finally {
      await cleanup();
    }
  }, 15_000);

  it("rejects non-image files and paths outside the workspace", async () => {
    const { handle, cleanup, workspaceDir } = await makeServer();
    try {
      const wsId = await registerWorkspace(handle, workspaceDir);
      writeFileSync(join(workspaceDir, "notes.md"), "notes");
      const unsupported = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/media?path=${encodeURIComponent("notes.md")}`,
        headers: localHeaders(handle),
      });
      expect(unsupported.statusCode).toBe(415);

      const escaped = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(wsId)}/fs/media?path=${encodeURIComponent("../outside.png")}`,
        headers: localHeaders(handle),
      });
      expect(escaped.statusCode).toBe(400);
      expect(escaped.json().error).toBe("path_escapes_root");
    } finally {
      await cleanup();
    }
  });
});
