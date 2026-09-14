import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDir = dirname(fileURLToPath(import.meta.url));

describe("canonical Command ownership boundary", () => {
  it("keeps raw shell discovery and execution out of the Bridge product path", () => {
    const daemon = readFileSync(join(sourceDir, "daemon.ts"), "utf8");
    expect(daemon).not.toContain("command-runner");
    expect(daemon).not.toContain("runCommandNode");
    expect(daemon).not.toContain("config.command");
    expect(daemon).not.toContain("child_process.exec");
  });
});
