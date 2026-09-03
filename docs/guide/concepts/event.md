# Event

**An Event is an immutable fact, signal, communication, observation, or decision that landed in Floe.**

It records source, time, Workspace, causation, correlation, schema, small
payload facts, and zero or more exact ArtefactVersion references.

## What an Event may do

An Event may:

- start a ScopeExecution at an explicit ingress Port;
- satisfy a Port on an existing NodeExecution;
- record an output or decision;
- carry direct Context communication; or
- remain an observed fact with no Delivery.

Arbitrary Event content is not automatically an Artefact. An Event type match or
Context subscription does not imply a Scope Edge.

## Sources

Human action, Actor communication, webhook, folder observation, schedule,
Connector, Command, and runtime output can all produce Events through their
authorised adapters. A source describes where a fact originated; it does not
create a separate routing system.

A Pulse is Bus-owned scheduled Event creation. In canonical Scope execution it
enters through a schedule Connector and explicit ingress Port.

## Emit

`emit` deliberately publishes non-graph communication or an explicitly
attached Port publication. A natural runtime completion is recorded in the
origin Context without automatically emitting or advancing work.

## Implementation

- `floe-bus/src/store.ts` — canonical Event and Delivery persistence
- `floe-bus/src/scope-executions.ts` — Event references pinned to execution
- `floe-bus/src/connectors.ts` — typed external sources and actions
- `floe-bus/src/pulse-scheduler.ts` — scheduled Event creation without polling

See [[Glossary]].
