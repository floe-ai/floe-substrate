# substrate-build

Read this reference when a concrete outcome needs a capability, composition, or Extension contract.
Discover current operations before writing code. Floe provides the shared environment; actors and
Extensions choose how work is organised.

## Ownership

- **floe-bus** owns canonical identity, authority, Contexts, Events, Scope composition and execution,
  Artefact versions, Extension lifecycle, and semantic operations. It pushes changes to clients.
- **floe-bridge** adapts runtime execution using Bus-issued processing contracts and supplies compact
  actor guidance. It does not import Extension code or create a second capability catalogue.
- **floe-app** presents work and invokes the same operations as other authorised actors. Its layout
  and selection state cannot change execution or authority.

Use existing grants and brokers. Neither a client nor a generated script may create a parallel
source of authority or execution state.

## Compose for the actual outcome

Use `discover_capabilities` for the concrete need, inspect existing resources, and invoke
`use_capability` with the returned operation and schema versions. Discover again when availability
or the contract changes; do not copy a catalogue of operation names into instructions.

- **Context** holds bounded collaboration and evidence. Use direct conversation, `emit`, or `request`
  where they suffice. Context membership, subscriptions, and parentage do not wire a Scope execution.
- **Scope** provides optional durable organisation. For explicit connected execution, publish a
  composition of NodePlacements, typed Ports, and stored Edges. Each execution pins one published
  revision; subsequent design changes affect new executions. Read ADR-0010 when this boundary matters.
- **Output publication** validates the executing node's pinned Port contract and traverses stored
  Edges. A final Context contribution or direct actor request does not substitute for publication.
- **Artefact** provides stable identity; an immutable ArtefactVersion identifies the exact result,
  content reference, and provenance. Content stores own bytes. File paths, lineage, and pipeline
  Edges are different relationships. Extensions own domain meaning and presentation.
- **External ingress and actions** use discovered Connector contracts. A Pulse schedules an Event;
  a folder arrival is a source Event. Verify the available adapter before activation. Do not add
  detached watchers, model CLIs, or polling loops beside Floe.

Keep workflow policy in actor instructions, configuration, or Extensions using existing enforcement
mechanisms. Confirm the requested work actually starts and return useful result and Context references.
Do not make the operator design the composition.

After an uncertain effect, inspect its receipt; do not blindly retry. Preserve exact output versions
and unaffected work when applying a correction.

## Extend only for a demonstrated gap

Read accepted ADR-0002 and ADR-0006 together with current discovery and host contracts before authoring
an Extension. Source belongs in an independent repository or package. `.floe/extensions/NAME/` is the
workspace installation location; its descriptor identifies an exact canonical ExtensionPackageVersion.

Use the discovered package, installation, approval, activation, and invocation operations. The isolated
Extension host verifies package bytes and permissions; code receives no ambient filesystem, network,
secret, or Bridge access. A declared permission is insufficient when the corresponding broker is
unavailable. Secret values remain in trusted brokers.

The Bridge does not load package source, inject package tools, or serve an Extension HTTP relay.
An authored folder or actor frontmatter entry does not enable a package.

An Extension may declare a bounded preview, renderer, lens, or dashboard over canonical projection and
action operations. Verify that the client supports its presentation contract and can render the result.
A declaration alone is not a working interface. Do not invent an executable UI loader or universal
renderer to bypass a missing supported capability.

For MCP, inspect the current runtime's supported attachment and authority contract. A file under
`.floe/mcp/` alone does not prove that a tool server is connected or callable.

## Keep the substrate general

Apply the `MISSION.md` tests before proposing substrate machinery:

- **Redundancy test** — would a 10x better model make this unnecessary? If yes, prefer actor behaviour
  or an Extension.
- **Actor-generality test** — is it useful to an actor that never opens the UI (an agent, a webhook
  processor, a headless script)? If only the UI needs it, it is client code, not substrate.

Report a proven missing mechanism with the attempted outcome and evidence. Consumer actors must not
rewrite Floe core to escape its boundaries.

## Where the canonical knowledge lives

`MISSION.md` owns purpose, `PRODUCT.md` owns the operator experience, `CONTEXT.md` owns terminology,
and accepted ADRs explain lasting decisions. Current code, discovered contracts, and observed behaviour
establish what works now. Plans and historical notes are evidence. Surface contradictions and read
only the references needed for the current attempt.

## Tests

If you write tests, they must NEVER make live LLM calls — use fixtures or injected doubles only.
