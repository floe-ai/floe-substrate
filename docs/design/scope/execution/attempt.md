# Attempt

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **ExecutionAttempt.** One processing or infrastructure attempt
within a [NodeExecution](node-execution.md). Retry creates another attempt, never
another NodeExecution. Runtime, model, instructions, tools, Extension versions,
resource use, result, error and evidence belong to the attempt. An attempt may
reference several joined Deliveries.
