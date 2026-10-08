# Definition

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **ActorDefinitionRevision.** An immutable revision of an
[Actor](actor.md)'s charter, responsibilities, knowledge, budgets, trust policy,
instructions, capability grants and escalation rules. Each ExecutionAttempt
records the revision and runtime binding it actually used.

## Files and revisions

`.floe/agents/*.md` holds editable Actor source and configuration; the Bridge
sends it to the Bus as an inventory. The canonical revision decides what runs.
Editing a file never changes a live Actor until it is imported and published,
and published revisions and existing pins are never rewritten to spread prose.

A new Workspace gets `.floe/agents/floe.md` from the Floe Actor template when
the file is missing. Existing files are never overwritten, so changing the
template affects only new Workspaces.
