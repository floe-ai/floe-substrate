# Concepts

**Floe uses a small substrate vocabulary, with explicit design and execution records only where repeated work needs them.**

A [[Workspace]] contains [[Actor]]s, [[Context]]s, optional [[Scope]]s, Events,
Artefacts, authority, and history. Contexts hold collaboration. A Scope holds a
versioned design and the executions that follow it. Only stored Edges advance a
ScopeExecution.

## Stable substrate concepts

| Concept | One-line definition |
|---|---|
| [[Workspace]] | Where one body of work lives; Actors reach any folder unless System access is off. |
| [[Scope]] | Durable outcome, organisation, lifecycle, and governance boundary. |
| [[Actor]] | An entity permitted to perceive, decide, communicate, and act. |
| [[Context]] | The durable place where participants understand, discuss, and record work. |
| [[Event]] | An immutable fact, signal, communication, observation, or decision. |
| [[Command]] | A deterministic operation with declared inputs, outputs, effects, and authority. |
| [[Artefact]] | A stable logical input, output, collection, reference, or body of evidence. |
| [[Extension]] | A folder that adds tools and hooks to Floe: a small manifest and a code entry. |
| [[Runtime binding]] | The replaceable link between an Actor and the runtime configuration it uses. |

## Scope design and execution records

| Record | One-line definition |
|---|---|
| [[Node|NodePlacement]] | One resource's configured place in one ScopeCompositionRevision. |
| ScopeCompositionRevision | One exact semantic design of a Scope; publication makes it immutable. |
| Port | A stable typed input or output interface on a NodePlacement. |
| Edge | An explicit stored route from one output Port to one input Port. |
| ScopeExecution | One causally coherent activation pinned to one published revision. |
| NodeExecution | One logical activation of one NodePlacement with exact inputs, Context, and outputs. |
| ExecutionAttempt | One processing or infrastructure attempt within a NodeExecution. |
| [[Delivery and Turn|Delivery]] | The durable transport obligation for an Event and exact ArtefactVersion references. |

## Shared operation contract

A Capability is a discoverable semantic operation. Its Bus-owned definition is
the one contract used by surfaces, Actors, the CLI, SDKs and the API. An
authenticated principal invokes it through a CapabilityGrant and receives a
stable operation receipt. Clients do not restate validation, authority, or
lifecycle rules.

## Relationships that stay separate

- Context participation controls collaboration and access; it never creates an
  Edge.
- Context subscription is ordinary non-graph pub/sub or identified legacy
  routing; it never advances canonical Scope execution.
- Artefact lineage records exact version provenance; it is not pipeline
  topology.
- Presentation state may arrange canonical records; it cannot change topology
  or authority.

See [[Glossary]].
