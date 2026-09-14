#!/usr/bin/env node
import { ensureConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { applyLocalFloeDelegationPolicy, applyLocalFloeExportPolicy, applyLocalFloeApprovalResponsePolicy, localProductWorkspacePolicy } from "./local-product-policy.js";

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "daemon";
  if (command !== "daemon") {
    console.error(`Unknown floe-bus command: ${command}`);
    process.exit(1);
  }
  const configPathArg = getArgValue("--config");
  const { configPath, config } = ensureConfig(configPathArg);
  // The trusted native owner supplies this secret out-of-band. Remove it from
  // the inherited environment before any child process can observe it.
  const hostControlToken = process.env.FLOE_HOST_CONTROL_TOKEN;
  delete process.env.FLOE_HOST_CONTROL_TOKEN;
  const server = await createBusServer(configPath, config, {
    host_control_token: hostControlToken,
    local_browser_access: true,
    workspace_configuration_policy: localProductWorkspacePolicy,
  });
  applyLocalFloeDelegationPolicy(server.store);
  applyLocalFloeExportPolicy(server.store);
  applyLocalFloeApprovalResponsePolicy(server.store);
  await server.listen();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
