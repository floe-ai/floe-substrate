# Event source

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (ADR-0008, 16 Aug; 8 Oct ruling)_
_Authored by: operator_

Where an [Event](../event.md) comes from: a schedule ([Pulse](pulse.md)), a
folder or file change, a webhook, or a person pressing go. A source is not a
primitive; it is a property of an Event node in a [Scope](../../scope/scope.md).

A source may reach an outside system through a
[Connector](../../workspace/connector.md). Watching an outside system that
cannot push is how that source receives Events; Floe itself never polls.

An Extension can add new kinds of Event source.
