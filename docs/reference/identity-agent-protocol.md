# Identity agent protocol

How a surface acts as the person without holding their key. The decision is
[ADR-0016](../adr/0016-floe-owns-the-identity.md). The bus side, which the agent
speaks for you, is the [client identity protocol](client-identity-protocol.md).

A surface never sees a private key, a challenge or a signature. It asks Floe's
identity agent to act, and the agent pushes back state and bearers.

## Node surfaces: use `floe/identity`

Depend on Floe and import its one library entry:

```json
"dependencies": { "floe": "github:floe-ai/floe#semver:^0.3.0" }
```

```ts
import { connectIdentity, IdentityError } from "floe/identity";

const identity = await connectIdentity({ surface: "star-map" }); // starts Floe if needed
render(identity.state);                        // { kind: "none" | "locked" | "unlocked", ... }
identity.onState((state) => render(state));    // pushed on every change

await identity.unlock(passphrase);             // or create / restore / replace / importLegacy
const session = await identity.session({}, (event) => {
  if (event.status === "ready") useBearer(event.bearer_token);  // again before each expiry
  if (event.status === "selection_required") session.select(pick(event.workspaces));
  if (event.status === "needs_workspace") askForFolder();        // then identity.joinFolder(...)
  if (event.status === "ended") signedOut(event.reason);         // locked | revoked | ended_by_surface
});
```

- `connectIdentity({ surface, configPath?, start? })`
  - `surface`: the name the person sees in `floe identity sessions`. It is a
    label, not proof of which program you are.
  - `configPath`: defaults to `FLOE_CONFIG`, then `~/.floe/config.yaml`.
  - `start`: default `true`. If the agent is not running, Floe (bus, bridge and
    agent) is started, when the machine's `services.start_on_demand` allows it.
    Otherwise it rejects with `AgentUnavailableError` (`reason: "not_running"`).
- Every method returns a promise. A refusal rejects with `IdentityError`, whose
  `code` is one of the codes in the table below.
- `identity.agentVersion` is the Floe version serving the machine. If it differs
  from the copy of Floe your surface depends on, `identity.versionNote` says so
  in words you can show. The running agent is used as is and never restarted.
- `identity.onClose(listener)` fires if the agent goes away (for example
  `floe stop`). Reconnect with `connectIdentity`.
- Types ship with the package (`floe/identity` has `.d.ts`).

### What the surface draws

The surface draws five flows. The agent does the work behind each one.

1. **Create.** The person chooses a name and a passphrase. An empty passphrase
   means the identity is protected by this device instead. Say plainly what
   that means: "anyone who can use this computer as you can act as you, and the
   recovery phrase is the only copy that survives this machine".
   Show the returned phrase once for backup.
2. **Unlock.** Only for `protection: "passphrase"`. A device-protected identity
   unlocks by itself when a session needs it, so never draw an unlock screen for
   it. The unlock screen must always offer "Forgot passphrase" (flow 5).
3. **Restore.** Take the phrase, then a new passphrase (or empty). The npub is
   the same as before.
4. **Reveal.** Passphrase identities: ask for the passphrase. Device-protected
   identities: ask for an explicit confirmation, then call with `confirm: true`.
   If `secret_kind` is `"nsec"`, the identity has no words. Show the `nsec1…`
   key as its backup, never a blank or made-up phrase.
5. **Forgot passphrase.** Two choices:
   - "I have my recovery phrase": Restore (flow 3). The identity is kept.
   - "I don't": `replace`. Say: "Your old identity cannot be recovered. Floe will
     create a new one and give it the same workspaces on this machine. Work done
     before stays credited to the old identity."

`create`, `restore`, `replace` and `reveal` hand a phrase or key to the surface
only so it can be shown. Display it, then discard it. Never store it, log it or
send it anywhere.

The terminal offers the same flows without any surface:
`floe identity status|create|unlock|lock|reveal|restore|replace|join|sessions`.

## Migrating an identity file from an earlier surface

Floe never looks inside a surface's folders. A surface that stored its own
identity before this design offers the import itself, the first time it runs:

- **Floe has no identity yet** (`state.kind === "none"`): offer "Bring it into
  Floe, or start fresh".
  - Bring it in: `importLegacy({ file: <parsed JSON of your file>, passphrase })`.
    The agent decrypts; the surface never does. A file you protected with an
    empty passphrase ("device") is opened with any passphrase value.
  - Start fresh: set your file aside under a dated name. Do not delete it.
- **Floe already has a different identity:** `importLegacy` rejects with
  `identity_exists` carrying `npub` (Floe's) and `importing_npub` (yours). Ask:
  "Floe already has identity A. This file has B. Keep A, or replace it with B."
  To replace, call again with `replace_existing: true`. Floe sets its own file
  aside; nothing is deleted.
- **The same identity is already in Floe:** the result has `already_present: true`.
- **"I don't know this passphrase":** set your file aside and carry on. The
  import must never be a trap.
- **An old key-only file:** the result has `secret_kind: "nsec"`. Tell the person:
  "This identity was made before Floe used recovery phrases, so it has no
  phrase. Its backup is its secret key (nsec), which you can reveal. You can
  keep it, or start a new identity with a phrase that keeps the same workspaces
  on this machine." The second choice is `replace`.
- If the agent needs a display name and none is known, it rejects with
  `display_name_required`; ask and call again with `display_name`.
- After a successful import, delete your own file and your key storage,
  key derivation and signing code.

The file format Floe imports is the console's version 1 file: `version: 1`,
`npub`, `created_at`, optional `protection`, `kdf: {name: "scrypt", N, r, p, salt}`,
`cipher: {name: "aes-256-gcm", iv, ciphertext, tag}` (base64). The sealed
plaintext is either the UTF-8 recovery phrase or the raw 32-byte key.

## The wire protocol (any language)

### Finding the agent

- The agent serves one Floe home. The home is the directory holding
  `config.yaml` by default, `~/.floe`.
- Its run file is `<home>/run/identity-agent.json`, readable only by this user:
  `{ protocol, pid, version, address, secret, started_at }`. It is rewritten on
  every start with a fresh `secret`. If the file is missing, or the address does
  not answer, the agent is not running.
- `address` is fixed by the home:
  - Windows: `\\.\pipe\floe-identity-<first 24 hex of sha256(home)>`, where
    `home` is the absolute path, lower-cased.
  - macOS and Linux: `<home>/run/identity.sock`.
- To start Floe, run `floe start` (or `floe up`). Both start the agent.

### Framing

One JSON object per line (UTF-8, `\n`-terminated), at most 1 MB per line.

### Handshake: both sides prove they run as this OS user

`proof(role, nonce)` = lower-case hex HMAC-SHA256, keyed with the run file's
`secret` decoded from hex, over the ASCII string `floe-identity:<role>:<nonce>`.

1. Client → `{"type":"hello","protocol":1,"client_nonce":"<random hex>","surface":"<name>"}`
2. Agent → `{"type":"challenge","protocol":1,"server_nonce":"…","server_proof":"<proof(agent, client_nonce)>","agent_version":"0.3.0"}`
3. The client checks `server_proof`. If it does not match, close the connection
   and send nothing more: something else holds the address (a Windows pipe name
   is visible machine-wide).
4. Client → `{"type":"prove","client_proof":"<proof(client, server_nonce)>"}`
5. Agent → `{"type":"welcome","state":{…},"agent_version":"0.3.0"}`

A wrong proof, a bad message or 5 seconds without finishing gets
`{"type":"error","error":{"code":"handshake_failed",…}}` and the connection
closes.

### Requests and responses

```json
{"type":"request","id":1,"op":"unlock","args":{"passphrase":"…"}}
{"type":"response","id":1,"ok":true,"result":{…}}
{"type":"response","id":1,"ok":false,"error":{"code":"wrong_passphrase","message":"…"}}
```

`id` is yours; the response echoes it. Error objects may carry extra fields
(for example `npub`).

### Pushed messages

- `{"type":"state","state":S}` whenever the identity changes. `S` is
  `{"kind":"none"}` or
  `{"kind":"locked"|"unlocked","npub","pubkey_hex","display_name","protection":"passphrase"|"device","secret_kind":"phrase"|"nsec"}`.
- `{"type":"session","session_id":"…","status":…}` for each session you opened:

| `status` | Fields | Meaning |
|---|---|---|
| `ready` | `bearer_token`, `workspace {workspace_id, name}`, `workspaces`, `expires_at` | Use this bearer on the bus. Another `ready` arrives about a minute before `expires_at`, with a fresh bearer. |
| `selection_required` | `workspaces`, `message?` | The identity is in several workspaces (or not in the one you named). Answer with `select_workspace`. |
| `needs_workspace` | `message` | The identity is in no workspace. After a successful `join_folder`, a `ready` follows by itself. |
| `error` | `code`, `message` | For example `locked` (unlock first, then open a new session) or `bus_unreachable`. |
| `ended` | `reason`: `locked`, `revoked`, `ended_by_surface` | The session is over and its bearer is revoked. |

A session ends, and its bearer is revoked at the bus, when you end it, when your
connection closes, when the identity is locked, or when the person revokes it
with `floe identity sessions --revoke`.

### Operations

| `op` | `args` | `result` | Refusal codes |
|---|---|---|---|
| `state` | – | state `S` | – |
| `create` | `display_name`, `passphrase` (empty = device) | `{npub, phrase}`; now unlocked | `identity_exists`, `device_key_unavailable`, `invalid_request` |
| `unlock` | `passphrase` (ignored for device) | state `S` | `no_identity`, `wrong_passphrase`, `device_key_unavailable` |
| `lock` | – | state `S` | – |
| `restore` | `phrase`, `passphrase`, `display_name?`, `replace_existing?` | `{npub, set_aside_as}`; now unlocked | `invalid_phrase`, `identity_exists` (+`npub`, `restoring_npub`), `display_name_required` |
| `reveal` | `passphrase` or `confirm: true` | `{secret_kind, secret}` | `passphrase_required`, `confirmation_required`, `wrong_passphrase`, `device_key_unavailable` |
| `replace` | `passphrase`, `display_name?` | `{npub, phrase, previous_npub, previous_revoked, workspaces, set_aside_as}` | `no_identity`, `bus_unreachable` (nothing changed) |
| `import_legacy` | `file`, `passphrase`, `display_name?`, `replace_existing?` | `{npub, secret_kind, protection, set_aside_as}` or `{npub, secret_kind, already_present: true}` | `legacy_file_unrecognised`, `legacy_file_inconsistent`, `wrong_passphrase`, `identity_exists` (+`npub`, `importing_npub`), `display_name_required` |
| `join_folder` | `locator` (absolute path), `create_directory?`, `name?` | `{kind: "ready"|"pending", workspace_id}`, `{kind: "failed", workspace_id, reason}`, `{kind: "invalid", error, message}` or `{kind: "refused", message}` | `no_identity`, `locked`, `bus_unreachable` |
| `session` | `workspace_id?` | `{session_id}`; events follow as `session` pushes | `no_identity` |
| `select_workspace` | `session_id`, `workspace_id` | `{session_id}` | `session_not_found` |
| `end_session` | `session_id` | `{ended: true}` | `session_not_found` |
| `sessions` | – | `{sessions: [{session_id, surface, status, workspace, started_at, expires_at}]}` | – |
| `revoke_session` | `session_id` (any surface's) | `{revoked: true}` | `session_not_found` |

Any operation can also fail with `unknown_op`, `invalid_request` or `failed`.

### Locking

- `lock` forgets the key at once and ends every session.
- The agent also forgets the key once no surface has been connected for
  `identity.lock_after_idle_minutes` (config, default 15). The timer starts when
  the last connection closes; any new connection cancels it.
- A device-protected identity unlocks by itself the next time it is needed.

## What this protects, and what it cannot

- Another OS user cannot use the agent: they cannot read the run-file secret,
  so they cannot prove themselves. A process holding the pipe name cannot pose
  as the agent, for the same reason.
- A surface that leaks, logs too much or has a bad dependency leaks at most a
  one-hour bearer, never the identity.
- A copied Floe home (a backup, a synced folder, another path, another user)
  cannot unlock a device-protected identity: its key is in this user's OS
  credential vault, held for this home's path. It restores from the phrase.
- A malicious program running as the same OS user can get a bearer while the
  identity is unlocked, read the identity file and watch keystrokes. The OS
  account is the boundary, as it is for SSH agents and password managers.
- The surface draws the unlock screen, so it sees the passphrase as it is typed.
  An honest surface never needs to keep it.
- On this machine the passphrase does not guard workspace access: anyone signed
  in as this user can already register a folder. It guards the portable key.
