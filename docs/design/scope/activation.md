# Activation

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (9 Oct ruling, O14)_
_Authored by: operator_

A [placement's](placement.md) rule for when it starts, given what has arrived on
its input [Ports](port.md) along [Edges](edge.md). Every processing node has
exactly one activation mode.

| Mode | When the node starts |
|---|---|
| each | Once for every arrival. |
| join | Once, when every required input Port has something. |
| gather | Once, when a whole batch has arrived, matched by a key (for example all ten images sent out by an earlier node). |

Join and gather are activation modes, not primitives or node kinds.

## Open

- Code uses older names: `per_delivery` (each), `all_required_ports` (join) and
  `keyed_gather` (gather) in `floe-bus/src/scope-compositions.ts`. Rename them to
  match.
