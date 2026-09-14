import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modelPreviewPlugin } from "./scripts/model-preview-plugin.ts";

const appRoot = dirname(fileURLToPath(import.meta.url));
const appPackage = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as { version: string };
let buildSha: string | null = null;
try {
  buildSha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: appRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim() || null;
} catch {
  buildSha = null;
}

export default defineConfig({
  define: {
    __FLOE_RELEASE_VERSION__: JSON.stringify(appPackage.version),
    __FLOE_BUILD_SHA__: JSON.stringify(buildSha),
  },
  plugins: [
    react(),
    modelPreviewPlugin(),
    {
      name: "floe-health",
      configureServer(server) {
        server.middlewares.use("/health", (_req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            ok: true,
            service: "floe-app",
            time: new Date().toISOString()
          }));
        });
      }
    }
  ],
  server: {
    host: "127.0.0.1",
    port: 5379,
    strictPort: true,
    proxy: {
      "/v1": { target: process.env.VITE_FLOE_BUS_BASE ?? "http://127.0.0.1:5377", ws: true },
    },
  }
});
