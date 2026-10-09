# Edge

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (9 Oct ruling, Q22)_
_Authored by: agent_

A stored connection from one output [Port](port.md) to one input Port in one
[revision](revision.md). Edges are stored as their own list in the revision, not
inside the nodes they join. Enabled Edges are the only routes that advance a
canonical ScopeExecution. Publishing one output traverses every enabled outgoing
Edge exactly once logically.

Context membership, subscription and parentage, Event type matches, prompts,
observed history, direct Actor requests and Artefact lineage never imply an
Edge.

Origin: agent ADR-0010 (4 Sep).

## Many links

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (9 Oct ruling, Q22)_
_Authored by: agent_

One Edge is one link, but a Port can have many. No extra node kind is needed.

| Need | How |
|---|---|
| One result to several nodes | One output Port with several Edges; each target gets it. |
| Either/or branch | Several output Ports (for example `approved`, `rejected`); the node publishes on one. |
| Several sources into one node | One input Port with several incoming Edges. |

When a node with inputs starts is its [activation](activation.md). Reshaping data
on the way is a [Command](../command/command.md).
