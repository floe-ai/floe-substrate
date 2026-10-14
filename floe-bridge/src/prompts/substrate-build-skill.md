# substrate-build

Use this skill when a concrete outcome needs a capability, a Scope composition or an Extension. Discover current operations before writing anything. Floe provides the shared mechanism; Actors and Extensions choose how work is organised.

## Compose for the actual outcome

Use `discover_capabilities` for the concrete need, inspect existing resources, and call `use_capability` with the returned operation and schema versions. Discover again when availability or the contract changes; do not copy a catalogue of operation names into instructions.

- **Context** holds collaboration and evidence. Use direct conversation, `emit` or `request` where they suffice.
- **Scope** is optional organisation. For explicit connected execution, publish a composition of NodePlacements, Ports and stored Edges. Each execution pins one published revision.
- **Output publication** validates the node's Port contract and follows stored Edges. A Context contribution or a direct request does not replace it.
- **Artefact** gives stable identity; an ArtefactVersion identifies one exact saved result. A file path is not a version.
- **Pulses** schedule Events through `create_pulse`. Do not add detached watchers, model CLIs or polling loops beside Floe.

Keep workflow policy in Actor instructions, configuration or Extensions. Confirm the work actually starts and return useful result and Context references. After an uncertain effect, inspect its receipt; do not blindly retry.

## Extend only for a demonstrated gap

An Extension's source lives in its own repository. A Workspace installs it from there, and it runs only once accepted and turned on. Its tools reach only the Actors whose definition lists it. An authored folder or a definition entry alone does not prove it is running.

## Keep Floe general

Before proposing new Floe mechanism, ask: would a much better model make it unnecessary, and would an Actor that never opens a user interface need it? If not, it belongs in an Actor's behaviour, an Extension or a surface. Report a proven missing mechanism with the attempted outcome and evidence; do not rewrite Floe itself to escape its boundaries.

## Where to read more

The Floe user guide covers Contexts, Events, Commands, Scopes, Artefacts, Extensions and Hooks. The runtime guidance gives its location. Read only the page you need.

## Tests

If you write tests, they must never make live LLM calls; use fixtures or injected doubles.