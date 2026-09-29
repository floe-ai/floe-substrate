/**
 * @invariant Cell: floe-cli.cli-process-manager
 * @invariant Module: floe-cli.cli-process-manager.main
 * @invariant Owns person-facing identity command registration, not terminal failure policy.
 * @invariant Identity failures escape to the shared CLI terminal boundary after cleanup.
 * @invariant The identity agent remains the only holder of unlocked identity keys.
 * @invariant Do not print or suppress unexpected command failures here.
 * @invariant Update this block in the same turn when the structural contract changes.
 *
 * `floe identity status|create|unlock|lock|reveal|restore|replace|join|sessions|held|delete`
 *
 * The person's identity from a terminal. Every command is a client of the
 * identity agent, exactly like any surface: the terminal never holds the key.
 * Passphrases and phrases are read with the echo hidden.
 */
import type { Command } from "commander";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import { connectIdentity, IdentityError, type IdentityClient, type IdentityState } from "./client.js";

const SURFACE = "floe terminal";

const PHRASE_WARNING =
  "Write these words down and keep them somewhere safe. They are the only way\n"
  + "to get this identity back if you forget the passphrase or lose this machine.\n"
  + "Floe will show them again with `floe identity reveal`.";

export function registerPersonIdentityCommands(identity: Command, configPath: () => string | undefined): void {
  const run = (action: (client: IdentityClient, prompt: Prompter) => Promise<void>) => async () => {
    const prompt = new Prompter();
    let client: IdentityClient | null = null;
    try {
      client = await connectIdentity({ surface: SURFACE, configPath: configPath() });
      if (client.versionNote) console.log(`Note: ${client.versionNote}`);
      await action(client, prompt);
    } finally {
      prompt.close();
      client?.close();
    }
  };

  identity
    .command("status")
    .description("Show your identity and whether it is unlocked")
    .action(run(async (client) => {
      printState(client.state);
      const { sessions } = await client.sessions();
      if (sessions.length) console.log(`${sessions.length} surface session(s) are using it (floe identity sessions).`);
    }));

  identity
    .command("create")
    .description("Create your identity on this machine")
    .requiredOption("--name <name>", "the name others see for you")
    .action((options: { name: string }) => run(async (client, prompt) => {
      if (client.state.kind !== "none") throw new Error("You already have an identity on this machine. See `floe identity status`.");
      const passphrase = await prompt.newPassphrase();
      const result = await client.create({ display_name: options.name, passphrase });
      console.log(`\nCreated ${options.name}  ${result.npub}`);
      console.log(passphrase ? "Protected by your passphrase." : "Protected by this device: it unlocks without a passphrase for this user on this machine.");
      showPhrase(result.phrase);
    })());

  identity
    .command("unlock")
    .description("Unlock your identity so surfaces can act as you")
    .action(run(async (client, prompt) => {
      const state = requireIdentity(client.state);
      const passphrase = state.protection === "passphrase" ? await prompt.hidden("Passphrase: ") : "";
      printState(await client.unlock(passphrase));
    }));

  identity
    .command("lock")
    .description("Lock your identity: Floe forgets the key and every surface session ends")
    .action(run(async (client) => {
      requireIdentity(client.state);
      printState(await client.lock());
    }));

  identity
    .command("reveal")
    .description("Show the backup of your identity (its recovery phrase)")
    .action(run(async (client, prompt) => {
      const state = requireIdentity(client.state);
      const result = state.protection === "passphrase"
        ? await client.reveal({ passphrase: await prompt.hidden("Passphrase: ") })
        : await (async () => {
          if (!(await prompt.yes("Anyone who sees what follows can become you. Show it now? [y/N] "))) throw new Error("Not shown.");
          return client.reveal({ confirm: true });
        })();
      if (result.secret_kind === "phrase") {
        showPhrase(result.secret);
      } else {
        console.log("\nThis identity was made before recovery phrases existed, so it has no words.");
        console.log("Its backup is this key. Keep it as safe as a phrase:");
        console.log(`\n  ${result.secret}\n`);
      }
    }));

  identity
    .command("restore")
    .description("Restore your identity from its recovery phrase (also: forgot passphrase, still have the words)")
    .option("--name <name>", "the name others see for you (defaults to the name Floe already knows)")
    .option("--replace", "replace a different identity already on this machine (it is set aside, not deleted)")
    .action((options: { name?: string; replace?: boolean }) => run(async (client, prompt) => {
      const phrase = await prompt.hidden("Recovery phrase: ");
      const passphrase = await prompt.newPassphrase();
      const result = await client.restore({
        phrase,
        passphrase,
        ...(options.name ? { display_name: options.name } : {}),
        ...(options.replace ? { replace_existing: true } : {}),
      });
      console.log(`\nRestored ${result.npub}`);
      if (result.set_aside_as) console.log(`The previous identity file was kept as ${result.set_aside_as}.`);
      printState(client.state);
    })());

  identity
    .command("replace")
    .description("Forgot the passphrase and have no recovery phrase: make a new identity that keeps your workspaces")
    .option("--name <name>", "the name others see for you (defaults to your current one)")
    .action((options: { name?: string }) => run(async (client, prompt) => {
      requireIdentity(client.state);
      console.log("This makes a NEW identity. Floe admits it to every workspace your current one is in,");
      console.log("then revokes the current one here. The current identity file is kept under a dated");
      console.log("name, in case the passphrase turns up. Other machines will not recognise the new one.");
      if (!(await prompt.yes("Continue? [y/N] "))) throw new Error("Nothing was changed.");
      const passphrase = await prompt.newPassphrase();
      const result = await client.replace({ passphrase, ...(options.name ? { display_name: options.name } : {}) });
      console.log(`\nNew identity ${result.npub} (was ${result.previous_npub}).`);
      console.log(result.workspaces.length
        ? `Carried into: ${result.workspaces.map((workspace) => workspace.name).join(", ")}.`
        : "Your previous identity was not in any workspace here.");
      if (result.set_aside_as) console.log(`The previous identity file was kept as ${result.set_aside_as}.`);
      showPhrase(result.phrase);
    })());

  identity
    .command("join")
    .argument("[folder]", "the folder to work in (defaults to the current directory)")
    .option("--create", "create the folder if it does not exist")
    .description("Create or join the workspace for a folder, as you")
    .action((folder: string | undefined, options: { create?: boolean }) => run(async (client) => {
      requireIdentity(client.state);
      const locator = resolve(folder ?? process.cwd());
      const outcome = await client.joinFolder({ locator, create_directory: options.create === true });
      if (outcome.kind === "ready") console.log(`You are in the workspace for ${locator} (${outcome.workspace_id}).`);
      else if (outcome.kind === "pending") console.log(`The workspace for ${locator} is being prepared (${outcome.workspace_id}).`);
      else if (outcome.kind === "failed") throw new Error(`The workspace for ${locator} could not be prepared (${outcome.reason}).`);
      else throw new Error("message" in outcome ? outcome.message : "The folder could not be joined.");
    })());

  identity
    .command("sessions")
    .description("Show which surfaces are acting as you")
    .option("--revoke <session_id>", "end one surface's session and revoke its bearer")
    .action((options: { revoke?: string }) => run(async (client) => {
      if (options.revoke) {
        await client.revokeSession(options.revoke);
        console.log(`Ended session ${options.revoke}; its bearer no longer works.`);
        return;
      }
      const { sessions } = await client.sessions();
      if (!sessions.length) {
        console.log("No surface is acting as you right now.");
        return;
      }
      for (const session of sessions) {
        const where = session.workspace ? ` in ${session.workspace.name}` : "";
        const until = session.expires_at ? `, bearer until ${session.expires_at}` : "";
        console.log(`${session.session_id}  ${session.surface}  ${session.status}${where}${until}`);
      }
    })());

  identity
    .command("held")
    .description("Show every identity Floe holds on this machine: your current one and any set aside")
    .option("--show-npub", "also show each identity's public key (npub)")
    .action((options: { showNpub?: boolean }) => run(async (client) => {
      const { identities } = await client.listIdentities({ include_npub: options.showNpub === true });
      if (!identities.length) {
        console.log(NO_IDENTITY);
        return;
      }
      for (const entry of identities) {
        if (!entry.readable) {
          console.log(`${entry.id}  (unreadable file; it can only be deleted)`);
          continue;
        }
        const when = entry.current ? "current" : `set aside ${entry.set_aside_at}`;
        const guard = entry.protection === "passphrase" ? "passphrase" : "this device";
        const backup = entry.has_recovery_phrase ? "has a recovery phrase" : "no recovery phrase";
        console.log(`${entry.id}  ${entry.display_name}  ${when}, protected by ${guard}, ${backup}${entry.npub ? `  ${entry.npub}` : ""}`);
      }
      console.log("\nDelete one with `floe identity delete <id>`.");
    })());

  identity
    .command("delete")
    .argument("<id>", "the identity to delete, as `floe identity held` shows it (`current` for your current one)")
    .option("--revoke-admissions", "also revoke its workspace admissions on this machine (current identity only)")
    .option("--keep-admissions", "leave its workspace admissions in place (current identity only)")
    .description("Delete an identity from this machine for good")
    .action((id: string, options: { revokeAdmissions?: boolean; keepAdmissions?: boolean }) => run(async (client, prompt) => {
      const { identities } = await client.listIdentities();
      const entry = identities.find((held) => held.id === id);
      if (!entry) throw new Error(`Floe holds no identity called ${id}. See \`floe identity held\`.`);
      if (options.revokeAdmissions && options.keepAdmissions) throw new Error("Choose one of --revoke-admissions and --keep-admissions.");
      const name = entry.display_name ?? "this identity";
      console.log(entry.current
        ? `This deletes ${name} from this machine for good. This machine stops being that identity.`
        : `This deletes the set-aside copy of ${name} (${entry.set_aside_at}) for good.`);
      console.log("Its key file is removed, and so is its device key once nothing else here needs it. Floe keeps no copy.");
      console.log(entry.has_recovery_phrase === false
        ? "It has no recovery phrase: it survives elsewhere only if you saved its key from `floe identity reveal`."
        : "It survives elsewhere only through its recovery phrase. Without those words it is gone forever.");
      if (!(await prompt.typed("Type delete to confirm: ", "delete"))) throw new Error("Nothing was deleted.");
      let input: Parameters<IdentityClient["deleteIdentity"]>[0] = { id, confirm: true };
      if (entry.current) {
        const revoke = options.revokeAdmissions ? true
          : options.keepAdmissions ? false
            : await prompt.yes("Also revoke its admissions to workspaces on this machine? [y/N] ");
        input = { ...input, revoke_admissions: revoke };
        if (entry.protection === "passphrase") input = { ...input, passphrase: await prompt.hidden("Passphrase: ") };
      }
      const result = await client.deleteIdentity(input);
      console.log(`\nDeleted ${result.deleted}.`);
      if (result.revoked_admissions) {
        const names = result.revoked_admissions.workspaces.map((workspace) => workspace.name);
        console.log(names.length ? `Revoked its admissions to: ${names.join(", ")}.` : "It was not admitted to any workspace here.");
      }
      if (result.device_key_removed) console.log("Its device key was removed from this machine's credential vault.");
      if (entry.current) console.log(NO_IDENTITY);
    })());
}

const NO_IDENTITY = "No identity on this machine yet. Create one with `floe identity create --name <name>`,\n"
  + "or bring one back from its recovery phrase with `floe identity restore`.";

function requireIdentity(state: IdentityState): Exclude<IdentityState, { kind: "none" }> {
  if (state.kind === "none") throw new Error(NO_IDENTITY);
  return state;
}

function printState(state: IdentityState): void {
  if (state.kind === "none") {
    console.log(NO_IDENTITY);
    return;
  }
  console.log(`${state.display_name}  ${state.npub}`);
  const guard = state.protection === "passphrase" ? "passphrase" : "this device";
  console.log(`${state.kind === "unlocked" ? "Unlocked" : "Locked"} (protected by ${guard}).`);
  if (state.secret_kind === "nsec") console.log("This identity has no recovery phrase; `floe identity reveal` shows its key instead.");
}

function showPhrase(phrase: string): void {
  const words = phrase.split(" ");
  console.log("\nRecovery phrase:\n");
  for (let row = 0; row < words.length; row += 6) {
    console.log("  " + words.slice(row, row + 6).map((word, index) => `${String(row + index + 1).padStart(2)}. ${word.padEnd(9)}`).join(" "));
  }
  console.log(`\n${PHRASE_WARNING}`);
}

/** Line prompts over one readline interface, with echo muted for secrets. */
class Prompter {
  private rl: Interface | null = null;
  private muted = false;
  private readonly queued: string[] = [];
  private readonly waiting: Array<(line: string) => void> = [];

  private open(): Interface {
    if (this.rl) return this.rl;
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    const write = (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!this.muted) write(text);
    };
    rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.queued.push(line);
    });
    rl.on("close", () => {
      for (const next of this.waiting.splice(0)) next("");
    });
    this.rl = rl;
    return rl;
  }

  private ask(question: string, muted: boolean): Promise<string> {
    const rl = this.open();
    process.stdout.write(question);
    this.muted = muted;
    return new Promise<string>((resolveLine) => {
      const take = (line: string) => {
        this.muted = false;
        if (muted) process.stdout.write("\n");
        resolveLine(line);
      };
      const queued = this.queued.shift();
      if (queued !== undefined) take(queued);
      else this.waiting.push(take);
      rl.resume();
    });
  }

  hidden(question: string): Promise<string> {
    return this.ask(question, true);
  }

  async yes(question: string): Promise<boolean> {
    return /^y(es)?$/i.test((await this.ask(question, false)).trim());
  }

  /** True only when the person types exactly `word`. */
  async typed(question: string, word: string): Promise<boolean> {
    return (await this.ask(question, false)).trim() === word;
  }

  /** Ask for a new passphrase twice. Blank means: protect with this device. */
  async newPassphrase(): Promise<string> {
    for (;;) {
      const first = await this.hidden("New passphrase (leave blank to protect with this device instead): ");
      if (!first) return "";
      const second = await this.hidden("Repeat the passphrase: ");
      if (first === second) return first;
      console.log("Those did not match. Try again.");
    }
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }
}

export { IdentityError };
