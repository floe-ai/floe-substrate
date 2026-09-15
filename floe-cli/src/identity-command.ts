import type { Command } from "commander";
import { generateSeedWords, privateKeyFromSeedWords } from "nostr-tools/nip06";
import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

import { ensureConfig, type LocalConfig } from "./config.js";
import { fetchHostControlToken } from "./operation-client.js";

/**
 * `floe identity` — admit and manage client keypair identities (ADR-0015).
 *
 * Admission is a host-control action: the operator adds a public key and a
 * display name to the Bus roster so a client can then authenticate with a
 * signed challenge and never holds host_control. The CLI can also generate a
 * seed for convenience, but a client may generate its own key instead. The Bus
 * never receives a seed or private key.
 */

const SEED_LOSS_WARNING =
  "IMPORTANT: this seed phrase is the ONLY way to authenticate as this identity.\n"
  + "It is shown once and stored nowhere. If it is lost the identity is gone for good:\n"
  + "there is no recovery. The operator can admit a NEW key under the same name, but\n"
  + "that is re-admission, not recovery — it does not restore this identity or its history.";

export type IdentityCommandDependencies = Readonly<{
  output?: (message: string) => void;
  resolve_config?: () => { config: LocalConfig };
  fetch_host_control_token?: (busHttpBase?: string) => Promise<string>;
  fetch?: typeof fetch;
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

  const identity = program
    .command("identity")
    .description("Admit and manage client keypair identities");

  identity
    .command("generate")
    .description("Generate a new BIP-39 seed phrase and derive its npub (stores nothing)")
    .option("--name <name>", "a label printed alongside the derived npub for your own reference")
    .action((options: { name?: string }) => {
      const mnemonic = generateSeedWords();
      const secretKey = privateKeyFromSeedWords(mnemonic);
      const pubkeyHex = getPublicKey(secretKey);
      const npub = nip19.npubEncode(pubkeyHex);
      const nsec = nip19.nsecEncode(secretKey);
      write("");
      if (options.name) write(`Identity label: ${options.name}`);
      write(`Seed phrase (BIP-39): ${mnemonic}`);
      write(`Private key (nsec):   ${nsec}`);
      write(`Public key (npub):    ${npub}`);
      write(`Public key (hex):     ${pubkeyHex}`);
      write("");
      write(SEED_LOSS_WARNING);
      write("");
      write("To admit this identity, an operator runs:");
      write(`  floe identity add --name "<display name>" --workspace <workspace_id> --pubkey ${npub}`);
    });

  identity
    .command("add")
    .description("Admit a public key to a workspace under a display name (requires host control)")
    .requiredOption("--name <name>", "the human display name for this identity")
    .requiredOption("--pubkey <npub|hex>", "the identity public key, as npub or 64-char hex")
    .requiredOption("--workspace <workspace_id>", "the workspace this identity may act in (repeat `add` to admit to more)")
    .action(async (options: { name: string; pubkey: string; workspace: string }) => {
      const { config } = resolveConfig();
      const token = await hostControlToken(busBase(config));
      const response = await httpFetch(`${busBase(config)}/v1/identities`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ display_name: options.name, pubkey: options.pubkey, workspace_id: options.workspace }),
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
      write("");
      write("Re-admitting a lost key is re-admission, not recovery: a lost seed is unrecoverable.");
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

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
