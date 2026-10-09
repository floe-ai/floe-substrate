# Edge

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A stored connection from one output [Port](port.md) to one input Port in one
[revision](revision.md). Enabled Edges are the only routes that advance a
canonical ScopeExecution. Publishing one output traverses every enabled outgoing
Edge exactly once logically.

Context membership, subscription and parentage, Event type matches, prompts,
observed history, direct Actor requests and Artefact lineage never imply an
Edge.

Origin: agent ADR-0010 (4 Sep).
