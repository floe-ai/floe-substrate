import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    // Every test runs against a throwaway user profile; see the file for the guard.
    setupFiles: ["../test-support/isolated-home.ts", "../test-support/copilot-login.ts"]
  }
});
