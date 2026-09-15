import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const output = execSync("npm pack --dry-run --json --ignore-scripts", {
  cwd: packageRoot,
  encoding: "utf8",
});
const reports = JSON.parse(output);
const files = reports.flatMap(report => report.files ?? []).map(file => file.path);
const forbidden = files.filter(file => /(?:^|[\\/])floe-mcp-server(?:[.\\/]|$)|(?:^|[\\/])acp(?:[.\\/]|$)/i.test(file));

if (forbidden.length > 0) {
  throw new Error(`Forbidden ACP/MCP artifacts would be packed:\n${forbidden.join("\n")}`);
}

console.log(`Package content check passed: ${files.length} files, no ACP/MCP artifacts.`);
