import type { Command } from "commander";
import { isAbsolute, relative, resolve } from "node:path";

import { ensureConfig, type LocalConfig } from "./config.js";
import { fetchHostControlToken } from "./operation-client.js";
import { registerPersonIdentityCommands } from "./identity/terminal-commands.js";

/**
 * `floe identity` — the person's identity, and the host's roster of admitted
 * identities.
 *
 * The person-facing commands (status, create, unlock, lock, reveal, restore,
 * replace, join, sessions) talk to Floe's identity agent (docs/reference/identity-agent-protocol.md), which holds
 * the key; see identity/terminal-commands.ts. The roster commands below (add,
 * list, revoke) are host-control actions on the Bus (docs/reference/client-identity-protocol.md).
 */

export type IdentityCommandDependencies = Readonly<{
  output?: (message: string) => void;
  resolve_config?: () => { config: LocalConfig };
  fetch_host_control_token?: (busHttpBase: string) => Promise<string>;
  fetch?: typeof fetch;
  cwd?: () => string;
}>;

export function registerIdentityCommand(
  program: Command,
  dependencies: IdentityCommandDependencies = {},
): void {
  const write = dependencies.output ?? ((message: string) => console.log(message));
  const resolveConfig = dependencies.resolve_config
    ?? (() => ensureConfig(program.opts().config));
  const hostControlToken = dependencies.fetch_host_control_token ?? fetchHostControlToken;
  const httpFetch = dependencies.fetch ?? globalThis.fetch;
  const currentDir = dependencies.cwd ?? (() => process.cwd());

  const identity = program
    .command("identity")
    .description("Your identity on this machine, and the identities admitted to its workspaces");

  registerPersonIdentityCommands(identity, () => program.opts().config);

  identity
    .command("add")
    .description("Admit a public key to a workspace under a display name (requires host control)")
    .requiredOption("--name <name>", "the human display name for this identity")
    .requiredOption("--pubkey <npub|hex>", "the identity public key, as npub or 64-char hex")
    .option("--workspace <workspace_id>", "the workspace this identity may act in; defaults to the workspace for the current directory")
    .option("--expires-at <iso_time>", "when this identity's authority in the workspace ends; without it, it lasts until revoked")
    .action(async (options: { name: string; pubkey: string; workspace?: string; expiresAt?: string }) => {
      const { config } = resolveConfig();
      const token = await hostControlToken(busBase(config));
      const workspaceId = options.workspace
        ?? await resolveWorkspaceForCwd(busBase(config), token, httpFetch, currentDir(), write);
      const response = await httpFetch(`${busBase(config)}/v1/identities`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          display_name: options.name, pubkey: options.pubkey, workspace_id: workspaceId,
          ...(options.expiresAt ? { expires_at: options.expiresAt } : { until_revoked: true }),
        }),
      });
      if (!response.ok) {
        throw new Error(`Admission failed (${response.status}): ${await safeBody(response)}`);
      }
      const body = await response.json() as {
        identity: { identity_id: string; display_name: string; npub: string };
        workspaces: Array<{ workspace_id: string; name: string }>;
      };
      write(`Admitted "${body.identity.display_name}" as ${body.identity.identity_id}`);
      write(`  ${body.identity.npub}`);
      write(`  workspaces: ${body.workspaces.map((w) => `${w.name} (${w.workspace_id})`).join(", ") || "none"}`);
      write(`  authority: ${options.expiresAt ? `until ${options.expiresAt}` : "until revoked"}`);
      write("");
      write("Re-admitting a lost key is re-admission, not recovery: a lost recovery phrase is unrecoverable.");
    });

  identity
    .command("list")
    .description("List admitted identities and their live sessions (requires host control)")
    .option("--json", "print the raw Bus response")
    .action(async (options: { json?: boolean }) => {
      const { config } = resolveConfig();
      const token = await hostControlToken(busBase(config));
      const response = await httpFetch(`${busBase(config)}/v1/clients`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`List failed (${response.status}): ${await safeBody(response)}`);
      }
      const body = await response.json() as {
        clients: Array<{
          identity_id: string;
          display_name: string;
          npub: string;
          revoked_at: string | null;
          workspaces: Array<{ workspace_id: string; name: string }>;
          sessions: Array<{ workspace_id: string; expires_at: string }>;
        }>;
      };
      if (options.json) {
        write(JSON.stringify(body, null, 2));
        return;
      }
      if (body.clients.length === 0) {
        write("No identities admitted.");
        return;
      }
      for (const client of body.clients) {
        const state = client.revoked_at ? "revoked" : `${client.sessions.length} live session(s)`;
        write(`${client.identity_id}  ${client.display_name}  [${state}]`);
        write(`  ${client.npub}`);
        write(`  workspaces: ${client.workspaces.map((w) => `${w.name} (${w.workspace_id})`).join(", ") || "none"}`);
      }
    });

  identity
    .command("revoke")
    .description("Revoke an identity: kills its live bearers and blocks re-authentication (requires host control)")
    .argument("<identity_id>", "the identity_id to revoke (from `floe identity list`)")
    .action(async (identityId: string) => {
      const { config } = resolveConfig();
      const token = await hostControlToken(busBase(config));
      const response = await httpFetch(`${busBase(config)}/v1/clients/${encodeURIComponent(identityId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Revoke failed (${response.status}): ${await safeBody(response)}`);
      }
      write(`Revoked ${identityId}. Its live bearers are dead and it can no longer authenticate.`);
    });
}

function busBase(config: LocalConfig): string {
  return config.bus.http_base_url.replace(/\/+$/, "");
}

type LocalWorkspaceRow = { workspace_id: string; name: string; locator: string | null; status: string };

/**
 * Resolve which workspace `identity add` should admit into when the operator
 * did not pass --workspace, by matching the current directory against the
 * locators of the workspaces registered on this host. A human never has to know
 * or type a workspace id: if the directory sits inside a registered workspace we
 * use it, and if it does not we print the registered workspaces (name, id and
 * path) right here so they can pick one — we never send them elsewhere to look.
 */
async function resolveWorkspaceForCwd(
  base: string,
  token: string,
  httpFetch: typeof fetch,
  cwd: string,
  write: (message: string) => void,
): Promise<string> {
  const response = await httpFetch(`${base}/v1/local/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Could not list workspaces (${response.status}): ${await safeBody(response)}`);
  }
  const rows = ((await response.json()) as { workspaces?: LocalWorkspaceRow[] }).workspaces ?? [];
  const bound = rows.filter((row) => typeof row.locator === "string" && row.locator);
  const resolvedCwd = resolve(cwd);
  const matches = bound
    .filter((row) => {
      const rel = relative(resolve(row.locator as string), resolvedCwd);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
    // Most specific (deepest locator) wins when nested workspaces both match.
    .sort((left, right) => (right.locator as string).length - (left.locator as string).length);

  if (matches.length > 0) {
    const chosen = matches[0]!;
    write(`Admitting into workspace "${chosen.name}" (${chosen.workspace_id}) for ${resolvedCwd}`);
    return chosen.workspace_id;
  }

  // No workspace contains the current directory. Show what exists, inline, with
  // the exact ids the operator would pass to --workspace.
  const lines = ["The current directory is not inside a registered workspace."];
  if (rows.length === 0) {
    lines.push("No workspaces are registered on this host yet. Run `floe setup` inside the workspace first.");
  } else {
    lines.push("Registered workspaces:");
    for (const row of rows) {
      lines.push(`  ${row.name} — ${row.workspace_id}${row.locator ? ` (${row.locator})` : " (unbound)"}`);
    }
    lines.push("Re-run from inside one of these directories, or pass --workspace <workspace_id>.");
  }
  throw new Error(lines.join("\n"));
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
