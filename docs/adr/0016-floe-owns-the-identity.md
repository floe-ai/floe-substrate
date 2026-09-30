# ADR-0016: Floe owns the person's identity; surfaces ask its agent to act

**Status:** accepted (2026-09-28)

Amends [ADR-0015](0015-client-identity-and-unprivileged-workspace-credential.md).
The bus side of ADR-0015 (admission, challenge, authenticate) is unchanged.
What changes is who holds the key.

## Context

ADR-0015 made a client-held key the way an outside client proves who it is.
Operation then showed what "client-held" costs:

- **Each surface kept its own key.** The console stored the person's identity
  inside its own folder, with its own cryptography. A second surface (Star Map
  is next) would have made a second identity for the same person, or copied the
  console's files and code.
- **The console's unlock screen had no way out.** A forgotten passphrase left
  the person stuck, with nothing that could re-admit them.
- **Removing a surface removed the identity.** Uninstalling or resetting the
  console deleted the only key.
- **Every surface author had to write key storage, key derivation, signing and
  the challenge handshake.** Any of them could leak the key.

The person is one self across every surface. The identity belongs with Floe,
which every surface already depends on.

## Decision

### D1. One identity per Floe home, held by a fourth Floe service

- The identity lives at `<home>/identity/identity.json`. There is one per Floe
  home, which means one per OS user.
- A new service, the **identity agent**, is the only process that ever holds the
  unlocked key. It runs next to the bus and the bridge, and is started, stopped,
  reported and guarded with them: `floe start`, `floe stop`, `floe status`,
  start on demand, start at login and the release guard all include it.
- Surfaces ask the agent to act. The agent does the bus challenge itself and
  hands back only bearers. A surface never sees a private key, a challenge or a
  signature. The one exception is that `create`, `restore`, `replace` and
  `reveal` return a phrase or `nsec` so the surface can show it for backup.
  The surface must display it and discard it.

### D2. The local channel, and what proves a caller

- Windows uses a named pipe; macOS and Linux use a Unix socket in the Floe
  home. The address is fixed by the home, so nothing has to be looked up. It is
  not TCP loopback, because other OS users and browser pages can reach loopback.
- On every start the agent writes a fresh secret to
  `<home>/run/identity-agent.json`, readable only by this user. **Both sides**
  prove they know it, each with an HMAC over the other's nonce. The secret never
  crosses the channel.
  - The client proves itself, so another OS user cannot use the agent. Node
    cannot restrict who opens a Windows pipe.
  - The agent proves itself, so a process holding the pipe name cannot pose as
    the agent and collect passphrases. A Windows pipe name is visible machine
    wide.
- ADR-0015 rejected a shared file for proving *who* someone is. Here it proves
  only "runs as this OS user", which is exactly what a file can prove.
- The agent pushes state and bearers. It renews a bearer about a minute before
  it expires. Nothing polls.
- Each bearer is recorded with the name its surface declared. `floe identity
  sessions` lists them, and any one can be revoked. The name is a label, not
  proof of which program asked.

The wire format and every operation are in the
[identity agent protocol](../reference/identity-agent-protocol.md).

### D3. Storage and protection

- Version 2 of the file records `secret_kind: "phrase" | "nsec"`. The format of
  the key is never again guessed by decrypting.
- Passphrase protection: scrypt, then AES-256-GCM.
- **Device protection** (no passphrase): the wrapping key is random and kept in
  the OS credential vault (DPAPI on Windows), held by the native broker under an
  account named for this home's path. A copy of the Floe home (a backup, a
  synced folder, a `.floe.old` folder) cannot unlock the identity. It restores
  from the phrase. The person still sees the same warning as before: anyone who
  can use this computer as them can act as them.

### D4. The five flows every surface draws

Create, unlock, restore, reveal, and "I forgot my passphrase".

- The unlock screen always has a way out: restore from the phrase, or replace.
- **Replace is re-admission, not recovery.** Floe makes a new identity, admits
  it to every workspace the old one was in, revokes the old one on this Floe,
  and sets the old file aside under a date. It deletes nothing.
- The same flows exist in the terminal as `floe identity
  status|create|unlock|lock|reveal|restore|replace|join|sessions`. This gives
  the person a way out even when a surface is broken.
- `floe identity generate` is removed. It printed a key for a surface to store,
  which is what this decision ends.

### D5. Rulings

- **Idle lock.** The agent forgets the key 15 minutes after the last surface
  disconnects. `identity.lock_after_idle_minutes` in `config.yaml` changes the
  time. A device-protected identity unlocks again by itself when it is next
  needed.
- **Reset.** `floe reset` keeps the identity and says so. `floe reset
  --include-identity` removes it and forgets its device key, and its
  confirmation names the recovery phrase as the only way back. The bus's list of
  admitted keys is wiped by any reset, as before, so the first launch afterwards
  joins folders again.
- **Two copies of Floe** (the v0.2.1 rule). Both copies share the
  home, and so they share the agent's address. Connect-first applies: whichever
  agent is running serves, and it is never restarted by a different copy
  (amended 2026-09-30: see below). A
  client that reaches an agent of another version says so. The agent does
  nothing that the machine owns, so the direct-install rule for start at login
  is unchanged.

### D6. Migration belongs to the surface

Floe never names a surface, so it does not look inside a surface's folders.
The console offers to import its own file with `import_legacy`, passing the
file and the typed passphrase; only the agent decrypts. An old key-only file is
imported as `secret_kind: "nsec"` and the person is told it has no phrase. Two
different identities are never merged or replaced silently.

## What differs from the approved design, and why

- **The broker gained two commands, not three.** It stores and reads the device
  key, and forgets it. The design also gave it "admit a key" and "revoke an
  identity". The broker already gives `host_control` to any process running as
  this user, so those two commands would add a name, not a boundary. `replace`
  uses `host_control` through the existing routes instead.
- **The bus gained two small additions.** The design said bus routes were
  unchanged. The authenticate response now carries `authority_session_id`, and a
  new `host_control` route,
  `DELETE /v1/clients/:identity_id/sessions/:authority_session_id`, revokes one
  bearer. Without them the agent could only revoke every session an identity
  holds, so ending one surface's session would sign out every other surface.
- **Recovery phrases are 12 words**, the same as the console's existing ones.
- **A status check is not a connection.** `floe status` and start-on-demand
  probe the agent with `probe: true`. A probe gets the handshake and nothing
  else, so checking status does not keep an identity unlocked.
- **The client API is `onState` and `session(options, listener)`**, not
  `subscribe` and `session(listener)`. The listener also receives
  `selection_required`, `needs_workspace` and `ended`, which the sketch did not
  show.

## Consequences

### What improves

- One identity for the person across every surface, and it outlives any one of
  them.
- A surface author writes screens, not cryptography. Star Map needs one import.
- A forgotten passphrase always has a way out.
- A leaky or compromised surface leaks at most a one-hour bearer.
- Every live bearer is visible to the person and revocable.

### What this cannot defend against, stated plainly

- A malicious program running as the same OS user can get a bearer while the
  identity is unlocked, read the identity file and watch keystrokes. The OS
  account is the boundary, as it is for SSH agents and password managers.
- The surface draws the unlock screen, so the surface sees the passphrase as it
  is typed. An honest surface never needs to keep it.
- On this machine the passphrase does not guard workspace access. Anyone signed
  in as this user can already register a folder and join it. The passphrase
  guards the portable key, the one that means "you" on another Floe.

## Implementation

- `floe-cli/src/identity/` — the agent (`agent.ts`, `agent-server.ts`,
  `agent-main.ts`), the channel (`protocol.ts`, `connection.ts`), storage
  (`identity-file.ts`, `keys.ts`), the bus calls (`bus-identity.ts`), the public
  client (`client.ts`, exported as `floe/identity`) and the terminal flows
  (`terminal-commands.ts`).
- `floe-cli/src/startup.ts`, `process-manager.ts`, `cli.ts`, `reset.ts`,
  `config.ts` — the agent as the fourth service, reset, idle-lock config.
- `floe-native-authority/src/lib.rs`, `main.rs` — `identity_device_key` and
  `forget_identity_device_key`.
- `floe-bus/src/server.ts` — `authority_session_id` and single-session revoke.
- `scripts/release.mjs` — exports `floe/identity`. The guard installs a real
  surface against the artifact and proves create, lock, a refused wrong
  passphrase, unlock, join and a bearer the bus accepts.

## Amendment, 2026-09-30: a surface may switch Floe to its newer copy

Ruling (operator, relayed for v0.4.8): a surface may ask Floe to switch to the
newest installed version without the person typing `floe restart`. It has the
same safety as `floe restart`, it never interrupts running work without saying
so, and only a directly installed or newer copy may ask.

This narrows D5's "never restarted by a different copy". What changes:

- `switchToThisVersion()` on the `floe/identity` and `floe/engines` clients
  restarts Floe from the surface's own copy, through `restartAll`, the same
  path and start lock `floe restart` uses. The running Floe cannot do it: it is
  the older code, and a 0.4.7 or older Floe has no such request.
- Only a newer copy switches. The same version answers `already_serving`; an
  older copy is refused (`would_downgrade`); a Bus this Floe home did not start
  is refused (`not_this_floe`), as `floe restart` would.
- Just before anything stops, and while the start lock is held, it lists every
  Actor that is mid-turn. If there is one, it does not switch and returns
  `work_running` with the turns, unless the surface passed
  `interrupt_running_work`; then it names the turns it interrupted. Queued and
  waiting work is durable and carries over.
- A copy cannot find another copy on disk, so "directly installed" reduces to
  "newer": a direct copy at the same version has nothing newer to switch to.
