# Engine control protocol

How a surface learns whether an engine can run work, and signs the person in
without asking them to type a command. The Bridge owns this because it owns
engine execution: it is the only process that runs a turn.

Credentials never cross this channel. A surface sees readiness, an account
label, messages it can show, and sign-in progress. The vendor's own sign-in
writes the credential to the vendor's own store; Floe never reads, copies or
refreshes it.

## Node surfaces: use `floe/engines`

```json
"dependencies": { "floe": "github:floe-ai/floe#semver:^0.3.5" }
```

```ts
import { connectEngines, EnginesError } from "floe/engines";

const engines = await connectEngines({ surface: "star-map" }); // starts Floe if needed
render(engines.state);                          // { copilot: EngineState }
engines.onState((all, changed) => render(all)); // pushed on every change
engines.onSignIn((event) => renderSignIn(event));

const { operation_id } = await engines.signIn("copilot");  // the vendor opens its own sign-in
await engines.cancelSignIn(operation_id);                   // if the person gives up
await engines.refresh("copilot");                           // "Try again"
const { models } = await engines.models("copilot");         // the engine's own model list
```

- `connectEngines({ surface, configPath?, start? })` behaves exactly like
  `connectIdentity` (see [identity agent protocol](identity-agent-protocol.md)):
  it connects to the Floe already serving this home, or starts Floe when the
  machine's `services.start_on_demand` allows it, and otherwise rejects with
  `EnginesUnavailableError` (`reason: "not_running"`). If the bus is up but the
  bridge is down, the same setting lets it start the bridge.
- `engines.agentVersion` and `engines.versionNote` report a version mismatch
  with the copy of Floe your surface depends on. Connecting uses the running Floe
  as it is and never restarts it.
  `switchToThisVersion({ interrupt_running_work? })` asks Floe to run your
  copy instead, when it is newer. It resolves to `switched` (with any turns it
  interrupted), `already_serving`, `work_running` (the turns in progress; nothing
  was stopped) or `refused` (`not_running`, `would_downgrade`, `not_this_floe`,
  `unknown_version`). After `switched` this connection has closed; connect again.
  To wait until no turn is running, follow `followSwitchReadiness` on the
  `floe/identity` connection (see the identity agent protocol).
- `engines.onClose(listener)` fires if the Bridge goes away. Reconnect with
  `connectEngines`.
- A refusal rejects with `EnginesError`, whose `code` is in the table below.

### Engine state

```ts
type EngineState = {
  engine: string;              // "copilot"
  phase: "checking" | "ready" | "action_required" | "unavailable";
  authentication: "unknown" | "signed_out" | "signed_in" | "not_required";
  access: "unknown" | "entitled" | "not_entitled" | "policy_blocked";
  reachability: "unknown" | "reachable" | "unreachable";
  account?: { label: string; host?: string };
  action?: "sign_in" | "check_subscription" | "contact_admin" | "retry";
  message: string;             // safe to show to a person
  checked_at: string;
  revision: number;            // increases with every change
};
```

Draw the button from `action`, and show `message`:

| `action` | Button |
|---|---|
| `sign_in` | **Sign in** → `signIn(engine)` |
| `check_subscription` | **Check subscription** (the account has no usable plan; signing in again will not help) |
| `contact_admin` | **Contact administrator** (an organisation policy blocks it) |
| `retry` | **Try again** → `refresh(engine)` |

The Bridge checks each engine when it starts, after a sign-in finishes, after a
turn on that engine fails, and when a surface calls `refresh`. It never polls.

### Models

`models(engine)` asks the engine, at that moment, which models it offers the
signed-in account. Any surface may ask; it changes nothing. Use it to let a
person choose an Actor's model; the chosen `id` is what an Actor's runtime
binding or runtime profile names as its `model`.

```ts
type EngineModels = { engine: string; models: EngineModel[] };
type EngineModel = {
  id: string;                  // what a binding or profile names as `model`
  name: string;                // the engine's display name, or the id
  enabled: boolean | null;     // false when the account's policy disables it; null when the engine does not say
  cost_multiplier?: number;    // relative to the engine's base rate
  context_window_tokens?: number;
  vision?: boolean;
  reasoning_efforts?: string[];
  default_reasoning_effort?: string;
};
```

For Copilot this is the same list a turn's model is checked against, read
from Floe's own Copilot folder. It fails with the engine's own code (for
Copilot, `copilot_models_unavailable`) when the engine cannot list them, for
example before sign-in. A turn naming a model not on the list is refused
before any model call, naming the requested and the available models.

### Which engine an Actor uses

Each Actor's endpoint carries `metadata.engine` (parsed `metadata` on
`GET /v1/endpoints`; inside `metadata_json` on the `endpoint_registered` push):
the `engine` id whose state gates that Actor's work,
or `null` when its runtime needs no engine. The Bridge that runs the Actor sets
it, so it is absent until a Bridge has attached the Actor. Match it against
`EngineState.engine` to warn about the right engine before sending work.

### Work sent while an engine is not ready

Nothing is lost or failed. The Bridge hands the work back to the Bus before the
turn starts, and the Actor waits. A message sent to it meanwhile records a
`runtime_unconfigured` telemetry signal saying it is waiting and why. Once the
engine becomes ready the waiting work runs by itself, in order. Waiting work
survives a Floe restart, and waiting never uses up a delivery's retries.

### Sign-in

`signIn(engine)` starts the vendor's browser flow: the vendor opens the
person's browser. `mode: "browser"` is the only mode. Device-code sign-in is
not offered, because the vendor CLI prints its one-time code to Floe's
background log, where the person cannot see it.

The surface says something like "Finish signing in in the GitHub
window" and waits for `onSignIn` events:

| `status` | Meaning |
|---|---|
| `starting` | The vendor flow is launching. |
| `waiting_for_person` | The vendor window is open. |
| `succeeded` | Signed in. A fresh readiness check follows and arrives through `onState`. |
| `failed` | The vendor flow ended without signing in. `message` says what to do. |
| `cancelled` | `cancelSignIn` stopped it. |

One sign-in per engine runs at a time. For Copilot, Floe runs the official
GitHub Copilot CLI (`copilot login`), shipped with Floe as a pinned dependency,
so the person needs no separate install.

## The wire protocol (any language)

The channel is the identity agent's channel with a different name. Framing,
handshake and request/response are identical; only these differ:

| | Identity agent | Engine control |
|---|---|---|
| Served by | the identity agent | the Bridge |
| Run file | `<home>/run/identity-agent.json` | `<home>/run/engines.json` |
| Windows address | `\\.\pipe\floe-identity-<hash>` | `\\.\pipe\floe-engines-<hash>` |
| Unix address | `<home>/run/identity.sock` | `<home>/run/engines.sock` |
| Proof string | `floe-identity:<role>:<nonce>` | `floe-engines:<role>:<nonce>` |
| Welcome `state` | identity state | `{"engines": {"copilot": EngineState}}` |

`<hash>` is the first 24 hex characters of sha256 of the absolute Floe home
path, lower-cased on Windows. The Bridge serves this channel as soon as it
starts, before it has reached the Bus.

### Operations

| `op` | `args` | `result` | Refusal codes |
|---|---|---|---|
| `state` | – | `{engines}` | – |
| `refresh` | `engine` | `EngineState` after one check | `unknown_engine` |
| `models` | `engine` | `{engine, models: EngineModel[]}` | `unknown_engine`, `models_unsupported`, the engine's own code (`copilot_models_unavailable`) |
| `sign_in` | `engine`, `mode?` (`"browser"`) | `{operation_id}` | `unknown_engine`, `invalid_sign_in_mode`, `sign_in_unsupported`, `sign_in_in_progress`, `copilot_cli_unavailable` |
| `cancel_sign_in` | `operation_id` | `{cancelled: true}` | `sign_in_not_found` |

Any operation can also fail with `unknown_op`, `invalid_request` or `failed`.

### Pushed messages

- `{"type":"state","engine":"copilot","state":EngineState}` on every change.
- `{"type":"sign_in","operation_id","engine","status","message"}` for every
  sign-in, whichever surface started it.

## What this protects, and what it cannot

- The engine never sees a credential from Floe's environment:
  `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` are removed from the
  environment of every Copilot process Floe starts, so a token in the person's
  shell cannot silently replace their own sign-in.
- Another OS user cannot use the channel, and a process squatting the pipe name
  cannot pose as the Bridge (the same mutual proof as the identity agent).
- A malicious program running as the same OS user can start the vendor sign-in,
  or use the engine, just as the person can. The OS account is the boundary.
