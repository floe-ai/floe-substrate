# ADR-0014: MCP is an internal transport, not a product surface

**Status:** accepted (2026-09-14)

## Context

Floe's substrate-write tools (`emit`, `request`, `discover_capabilities`,
`use_capability`, pulse lifecycle, `read_artefact`) reach the actor because
`floe-runtime` drives a live `copilot --acp` child process and hands it those
tools. The only mechanism that vendor CLI accepts for external tools is MCP.
Concretely, `copilot --acp` advertised `mcpCapabilities: { http: true, sse: true }`
and no stdio — it violates the ACP specification's stdio-transport `MUST`, so the
Bridge serves the tools over **MCP-over-HTTP** from inside its own authenticated
process (`floe-bridge/src/adapters/floe-mcp-server.ts`). This was found live, not
read from a spec; the ACP spec is not evidence of what this vendor build does.

That surface is now complete: capability invocation (ADR-0013 sequencing, restored
in commit `03fb6d3`) plus pulses and artefact reads (commit `fa8d752`). All of it
is live-proven — a real `gpt-5.6-luna` `copilot --acp` actor created a Pulse that
landed in the Bus and read an exact ArtefactVersion whose in-file codeword it
reported back.

With the surface working, one design question was serious enough to evaluate
properly rather than assume: **should the actor keep calling the substrate through
MCP tools at all, or should it call the Bus directly in code** ("code mode")? The
vendor actor already has its own shell, file, and network access, so a
direct-to-Bus code path was not a strawman — it was a credible alternative.

### The actor's own capabilities are real (live evidence)

The credibility of the code-path alternative rests on the actor genuinely being
able to run code. It can. In a live `copilot --acp` turn
(`rt_8e953bdc`, outcome `completed`) the actor was asked to use only its **own**
built-in tools and demonstrated all three, recorded in its work log's tool
activity:

- **Shell** — ran a shell command that printed a required marker string
  ("Run the exact shell probe").
- **File** — read `README.md` from the workspace and quoted its first line
  ("Viewing …\\README.md", returning `# Floe`).
- **Network** — performed an HTTP GET to `https://api.github.com/zen`
  ("Fetching https://api.github.com/zen"), returning the live body
  `Design for failure.`

So the actor can already reach a shell, the filesystem, and the network without
Floe. A direct code path to the Bus would not be giving it a *new* kind of power;
it would be giving it a **Floe authority bearer**.

## Decision

### MCP is an internal transport detail, never a product surface

MCP exists in Floe for exactly one reason: it is the only way `copilot --acp`
accepts tools. It is a wire between the Bridge and the vendor CLI. It is not a
Floe feature, an extension mechanism, or anything an operator ever sees.

Therefore:

- **Floe does not ship an MCP plugin system.** There is no registry, discovery,
  or lifecycle for MCP servers as a Floe concept.
- **Floe does not support user-installed MCP servers.** Operators do not add
  capabilities to Floe by pointing it at an MCP server.
- **MCP must never appear in any product surface or UI.** No settings screen,
  inventory, picker, status panel, or operator-facing document presents "MCP" as
  a thing the operator configures, inspects, or reasons about. If an operator can
  see the letters "MCP", that is a bug.
- **External integrations are code in the repository, not installed MCP
  servers.** Extensions build against the substrate contract as code
  (ADR-0002, ADR-0006). "Add an MCP server" is not the integration story;
  authoring a substrate extension is.

The name `SubstrateToolBridge` and the MCP server module are implementation
detail of the Bridge↔vendor-CLI boundary and stay confined there.

### The authority bearer does not leave the Bridge

A runtime turn's substrate writes execute under a per-Delivery **operation
authority** bearer that `substrate-authority.ts` acquires and caches inside the
Bridge process (ADR-0013 sequencing; `requireOperationAuthority` via
`prepareRuntimeDelivery`). The MCP tools are pure `(bus, turn, params) → result`
bodies that run **in the Bridge**, under that authority, and return only a result
to the vendor CLI. The vendor process never holds the bearer.

This is the line the code-path alternative would have crossed, and the reason it
was rejected.

## Why the direct code path was rejected

A direct-to-Bus code path — letting the model-controlled vendor process call the
Bus itself in code instead of through Bridge-hosted tools — was seriously
evaluated and rejected on three concrete grounds:

1. **It would hand a live Floe authority bearer to the vendor process.** For the
   actor's code to call the Bus directly, a valid substrate credential would have
   to live *inside* the model-controlled process. Today the operation-authority
   bearer never leaves the Bridge. Moving it into the vendor process is a
   materially larger trust grant than the shell/file/network the actor already
   has, because it is *Floe's* authority over the substrate, not the actor's own
   ambient reach. This is the same class of invariant ADR-0013 protects when it
   refuses to put a model credential in Floe's hands: authority stays with the
   party that should own it. Here, substrate authority stays in the Bridge.

2. **It would collapse the structured work log into an opaque shell invocation.**
   Each tool call is normalised into the work log as discrete, inspectable tool
   activity — the probe turn above shows exactly which tools ran and what they
   returned, and the gate turn shows `floe-create_pulse` / `floe-read_artefact`
   as named activity with visible output. A code path that reaches the Bus inside
   an arbitrary shell/script step would record "the actor ran some code", not
   "the actor created this Pulse and read this ArtefactVersion". The legible,
   per-operation history that makes runs reviewable would be lost.

3. **It would lose the cancellation boundary.** Tool calls cross the Bridge, which
   owns the Delivery lease and can refuse, cancel, or tear down substrate work at
   a well-defined boundary. Substrate writes buried inside a vendor-side code step
   have no such boundary; cancelling the turn would not cleanly bound the
   substrate effects it had already set in motion.

The question was never "MCP versus code" in the abstract. It was "does the
authority bearer leave the Bridge?" — and the answer is no.

## Consequences

- The MCP-over-HTTP surface in `floe-bridge/src/adapters/floe-mcp-server.ts`
  stays, understood explicitly as an internal transport, not a product direction.
- No MCP plugin system, MCP server registry, or user-facing MCP configuration is
  built or exposed. Reviewers should treat any operator-visible "MCP" concept as a
  regression against this ADR.
- Substrate-write tools remain pure `(bus, turn, params) → result` bodies that
  execute in the Bridge under per-Delivery operation authority; the vendor process
  receives results, never bearers. Keeping the tool bodies free of MCP types is a
  deliberate constraint that kept this evaluation cheap and keeps the transport
  swappable.
- If a future vendor build accepts tools another way (for example a conforming
  stdio transport, or a non-MCP mechanism), the transport can change without any
  product-level consequence, precisely because MCP was never a surface.
- External capability growth is authored as substrate extensions in code, not by
  installing MCP servers.
