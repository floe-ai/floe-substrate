import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every test runs against a throwaway user profile; see the file for the guard.
    setupFiles: ["../test-support/isolated-home.ts"],
    globals: false
  }
});
