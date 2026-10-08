# Engine

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

An engine is the AI runtime that performs an Actor's [Turn](../event/delivery/turn.md).
Floe has one runtime, floe-runtime, built on the GitHub Copilot SDK.

## Sign-in belongs to the vendor

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed ([ADR-0013](../../adr/0013-model-authentication-belongs-to-the-vendor-cli.md))_
_Authored by: unknown_

The vendor's own sign-in writes the credential to the vendor's store. Floe never
reads, copies or refreshes model credentials. A surface sees readiness, an
account label and sign-in progress, never credentials
(`docs/reference/engine-control-protocol.md`).

## Use the Copilot SDK, not a bundled CLI

_Resolution: direction_
_Built: partly_
_Authority: operator-confirmed (8 Oct: Floe should use the Copilot SDK, not bundle the CLI directly)_
_Authored by: operator_

Turns already run through the Copilot SDK, which brings its own runtime. Floe
also bundles the full Copilot CLI, used only to run engine sign-in.

## What would settle it

Official Copilot SDK documentation showing whether the SDK can perform sign-in.
If it can, the bundled CLI goes.

## Engine tools are gated

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (D13 ruling)_
_Authored by: operator_

Every engine built-in tool call is decided by the Bus before it runs, failing
closed. Floe is unrestricted by default; restrictions are opt-in
([Policy](../capability/policy/policy.md)). The vendor's own agent-spawning tools
are off.

## Open

- The ruling named the SDK's `onPreToolUse` hook as the gate. The built gate
  (`floe-bridge` engine tool gate) decides engine permission requests instead.
  Confirm which mechanism is intended.
