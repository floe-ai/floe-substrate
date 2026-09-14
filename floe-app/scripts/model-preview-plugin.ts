import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const entry = fileURLToPath(new URL("../src/previews/model-viewer.ts", import.meta.url));

export async function bundleModelViewer(): Promise<string> {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: "iife",
    platform: "browser", target: "es2022", minify: true, legalComments: "inline",
  });
  return result.outputFiles[0].text;
}

/** Ship the viewer as data for the opaque preview, never as parent-window code.
 * All dependencies are bundled locally; opening a model needs no CDN or module fetch. */
export function modelPreviewPlugin(): Plugin {
  const publicId = "virtual:floe-model-viewer";
  const resolvedId = `\0${publicId}`;
  return {
    name: "floe-model-preview",
    resolveId(id) { if (id === publicId) return resolvedId; },
    async load(id) {
      if (id !== resolvedId) return;
      this.addWatchFile(entry);
      return `export default ${JSON.stringify(await bundleModelViewer())};`;
    },
  };
}
