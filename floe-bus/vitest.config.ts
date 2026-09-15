import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    // testTimeout/hookTimeout are wall-clock, not CPU time. Vitest forks one
    // worker per core, and the heavier suites here do real synchronous SQLite
    // and filesystem work; when every worker runs at once (CI, or any loaded
    // machine) a test that needs well under a second of CPU can stretch far past
    // the 5s default in wall-clock terms and time out. That is CPU contention,
    // not a hung test or shared product state, so the ceiling is set to reflect
    // the real cost model. A genuine hang still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
