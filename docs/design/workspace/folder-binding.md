# Folder binding

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **Workspace locator binding.** A replaceable association between
one [Workspace](workspace.md) and one absolute folder path on one host. It owns
local attachment, selection, configuration and compare-and-swap revision state.

Each host owns its own bindings. Superseded bindings remain evidence. A callback
must name the exact binding it began under; a late callback cannot update a
replacement binding.
