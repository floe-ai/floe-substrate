import { defineConfig } from "vitest/config";
import { modelPreviewPlugin } from "./scripts/model-preview-plugin.ts";

export default defineConfig({
  plugins: [modelPreviewPlugin()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false
  }
});
