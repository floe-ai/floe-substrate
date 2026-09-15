import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const output = execSync("npm pack --dry-run --json --ignore-scripts", {
  cwd: packageRoot,
  encoding: "utf8",
});
const reports = JSON.parse(output);
const files = reports.flatMap(report => report.files ?? []).map(file => file.path);
const required = [
  "dist/prompts/default-floe-agent.md",
  "dist/prompts/substrate-build-skill.md",
  "dist/prompts/substrate-guidance.md",
];
const forbidden = files.filter(file => /(?:^|[\\/])floe-mcp-server(?:[.\\/]|$)|(?:^|[\\/])acp(?:[.\\/]|$)/i.test(file));
const missing = required.filter(file => !files.includes(file));

if (forbidden.length > 0) {
  throw new Error(`Forbidden ACP/MCP artifacts would be packed:\n${forbidden.join("\n")}`);
}
if (missing.length > 0) {
  throw new Error(`Required prompt assets would not be packed:\n${missing.join("\n")}`);
}

console.log(`Package content check passed: ${files.length} files, required prompt assets present, no ACP/MCP artifacts.`);
