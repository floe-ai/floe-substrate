# ADR-0013: Model authentication belongs to the vendor CLI; Floe brokers no model credentials

**Status:** accepted (2026-09-04)

## Context

### What Floe was actually doing

Floe reached frontier models through a vendored dependency, `@earendil-works/pi-ai`
(and `@earendil-works/pi-agent-core`). The concrete mechanism, in
`floe-bus/src/live-model-probe.ts`, presented Floe to GitHub **as if it were the
VS Code Copilot Chat extension**. It sent, against an endpoint its own source
comment described as undocumented:

- `User-Agent: GitHubCopilotChat`
- `Editor-Version: vscode/...`
- `Copilot-Integration-Id: vscode-chat`

Those headers were copied from `pi-ai`. This was impersonation: Floe used a
subscription credential to call a private, undocumented model endpoint while
claiming to be a different, first-party editor integration. It is stated here in
plain terms because a euphemism ("simplified provider handling") would hide the
single largest liability this substrate has carried, and the reason the
credential decision below has to narrow.

To make that impersonation usable, Floe had grown a matching credential surface:
a provider registry and login/OAuth flow, browser provider routes, CLI
`login`/`auth`/`logout` commands, per-provider account SecretRefs, and a
workspace-import path that brokered a model-provider credential onto each Actor's
runtime. All of it existed to answer one question — *"which model credential do we
send, and how do we make the request look legitimate?"* — that Floe should never
have been answering.

### What replaced it, and why the liability is now removable

Floe already spawns the official vendor CLIs. `floe-runtime` (via
`FloeRuntimeAdapter`) drives a live `copilot --acp` session as a child process.
The vendor CLI performs its own authentication with its own vendor; **Floe never
sees a model token and sends no invented headers**. Substrate writes the actor
needs (`emit`, `request`) are exposed to that CLI over MCP-over-HTTP and have been
proven landing live, not merely compiling. That made the impersonation path pure
liability with no remaining product justification, and this ADR removes it.

## Decision

### Floe does not broker model credentials

Model authentication is the vendor CLI's responsibility. Floe spawns the vendor
CLI and does not hold, request, store, refresh, inject, or reason about the
credential that authenticates a model call. Floe sends no model-provider headers
and impersonates no client.

ADR-0012 decided that Floe brokers credentials across explicit trust boundaries.
**That decision is narrowed here: the credential broker exists for connectors and
external secrets, not for model-provider authentication.** Concretely, this ADR
supersedes the ADR-0012 provisions that made model access a brokered concern:

- "Account existence does not authorize a model" and the
  `credential.runtime-access.grant` / `credential.runtime-access.revoke`
  host operations as a *model*-authorization mechanism;
- interactive provider sign-in through account `prepare` / `bind` / `list`
  (desktop, CLI, and the local browser adapter);
- the workspace-import path that attached a provider-account SecretRef and a
  credential CapabilityGrant to an Actor's runtime so a model could be called.

The generic broker mechanism ADR-0012 describes — SecretRef metadata,
single-use credential ingress, purpose-constrained use, rotation/refresh, KMS
adapter — remains for connectors and other external secrets. It is no longer a
model-authentication path.

### Model listing is not reintroduced through the back door

Removing pi removed Floe's model catalog. It is **not** reimplemented by calling
the undocumented endpoint with invented headers — that would recreate the exact
liability this ADR deletes. The bus multi-provider catalog is gone; it existed to
feed the removed `floe-app` provider picker and has no consumer. `/v1/auth/models`
returns only workspace-declared entries. If a client later needs a live model
list, it asks the vendor CLI through `floe-runtime`'s supported `models(cwd)`
surface — the vendor's own supported interface — and nothing wires the old
endpoint back in.

### The generic credential broker is kept, on incomplete evidence

The generic broker operations `credential.use`, `credential.refresh`, and
`credential.runtime-access` were **kept**. This boundary was drawn on incomplete
evidence: static analysis could not prove whether `credential.use` /
`credential.refresh` / `credential.runtime-access` is model-provider-only (in
which case it has no caller after this change and should be deleted) or is the
intended connector / external-secret path (in which case it must stay). Faced
with that uncertainty, the conservative cut keeps the generic broker rather than
delete a mechanism a connector may legitimately need.

This is recorded so it is not an invisible assumption. If a later session
confirms these operations were only ever the model-credential path, they are dead
code with no consumer and should be removed — removal, not a "legacy" retention,
is the control this project has found actually works.

### Removing pi temporarily removed some actor capabilities — this is sequencing

The pi-era tool layer (`floe-bridge/src/tools/*`) was deleted with pi because
every file imported pi and its only consumer chain
(`createRuntimeTools` → `PiAgentCoreAdapter`) was gone. That layer included
generic file/shell tools (correctly dropped — the vendor CLI brings its own) but
**also** substrate-write tools: capability invocation (`discover_capabilities` /
`use_capability`), pulse lifecycle, and artefact reads.

Removing pi therefore **temporarily removed the actor's access to capability
invocation, pulses, and artefact reads.** This is a known, transient gap. It is
sequencing, not a decision to shed those capabilities: they are being restored
immediately by porting the non-redundant substrate-write tools onto the same
`SubstrateToolBridge` MCP surface that already carries `emit` and `request`,
gated by its own live delivery. The substrate did not deliberately drop capability
invocation, pulses, or artefact reads; do not read this removal as their
retirement.

## Consequences

- Floe holds no model credentials and impersonates no client. The undocumented
  endpoint and the `GitHubCopilotChat` / `vscode` / `vscode-chat` headers are
  gone from the codebase.
- `floe-bus` boots with no provider concept: no provider registry, no
  provider-login, no model catalog.
- The following are removed: `live-model-probe.ts`, `pi-provider-login.ts`, the
  provider registry in `floe-bus/src/auth.ts`, `browser-provider-routes.ts`, the
  CLI `login` / `auth` / `logout` commands, `PiAgentCoreAdapter`, `pi` from
  `chooseAdapter` (leaving `fake` and `floe-runtime`), the
  `credential.account.prepare` / `list` operations and their bridge config
  parsing, the workspace-import `credential_reference` → provider-account
  SecretRef → credential-grant chain, and the `@earendil-works/pi-ai` /
  `@earendil-works/pi-agent-core` dependencies from every manifest and the
  lockfile.
- Tests that only passed because pi existed were deleted or rewritten honestly
  rather than kept green by keeping dead code alive.
- The generic credential broker remains available to connectors and external
  secrets, with the model-only-vs-connector boundary explicitly flagged above as
  drawn on incomplete evidence and worth revisiting.
- Actor access to capability invocation, pulses, and artefact reads is
  temporarily unavailable and is being restored by the immediately following MCP
  tool port.
