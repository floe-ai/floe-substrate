# Command

**A Command is a deterministic executable operation with declared inputs, outputs, side effects, authority, timeout, idempotency, and implementation.**

An Actor can interpret, choose, converse, and delegate. A Command executes one
defined operation. Deterministic does not mean effect-free; declared effects
and ExternalEffectReceipts still govern safe retry.

## Placement and execution

A NodePlacement may reference a Command. Its input and output Ports define the
exact Event and ArtefactVersion contracts for that placement.

The NodePlacement references the stable Command identity. Publishing the Scope
plan validates that Command's active published CommandDefinitionRevision, exact
input and output schemas, declared effects, permissions, and an available
authenticated worker at the Workspace boundary.

When activated, one NodeExecution owns the logical work and one
ExecutionAttempt records the concrete process, inputs, implementation version,
result, error, resource use, and evidence. Retry adds an ExecutionAttempt to the
same NodeExecution. Concurrent activations remain separate because their
NodeExecution and Port-bound inputs are separate.

The NodeExecution pins one immutable CommandDefinitionRevision and one worker
binding. Every ExecutionAttempt copies those pins. Retrying keeps the original
meaning even if the Command's current revision later changes or the Command is
retired.

Command output advances a ScopeExecution only when it is published to a named
output Port. Raw stdout, stderr, process telemetry, or natural runtime
completion does not imply an Edge traversal.

## Implementation

- `floe-bus/src/command-definitions.ts` — stable Command identity and immutable
  definition revisions
- `floe-bus/src/command-runtime.ts` — authenticated worker binding and persisted
  attempt processing contract
- `floe-bus/src/isolated-command-host.ts` — isolated, version-pinned execution
  boundary
- `floe-bus/src/scope-compositions.ts` — Command placements and Port contracts
- `floe-bus/src/scope-executions.ts` — NodeExecution and ExecutionAttempt
  evidence
- `floe-bus/src/scope-operations.ts` — output publication through canonical
  Edges

The Bridge does not discover or execute shell text from graphs. Legacy graph
Command records are retained only as non-executable migration evidence.

See [[Glossary]].
