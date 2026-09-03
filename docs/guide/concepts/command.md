# Command

**A Command is a deterministic executable operation with declared inputs, outputs, side effects, authority, timeout, idempotency, and implementation.**

An Actor can interpret, choose, converse, and delegate. A Command executes one
defined operation. Deterministic does not mean effect-free; declared effects
and ExternalEffectReceipts still govern safe retry.

## Placement and execution

A NodePlacement may reference a Command. Its input and output Ports define the
exact Event and ArtefactVersion contracts for that placement.

When activated, one NodeExecution owns the logical work and one
ExecutionAttempt records the concrete process, inputs, implementation version,
result, error, resource use, and evidence. Retry adds an ExecutionAttempt to the
same NodeExecution. Concurrent activations remain separate because their
NodeExecution and Port-bound inputs are separate.

Command output advances a ScopeExecution only when it is published to a named
output Port. Raw stdout, stderr, process telemetry, or natural runtime
completion does not imply an Edge traversal.

## Implementation

- `floe-bridge/src/command-runner.ts` — current local command adapter
- `floe-bus/src/scope-compositions.ts` — Command placements and Port contracts
- `floe-bus/src/scope-executions.ts` — NodeExecution and ExecutionAttempt
  evidence
- `floe-bus/src/scope-operations.ts` — output publication through canonical
  Edges

See [[Glossary]].
