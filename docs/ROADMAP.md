# Historical Roadmap

**Status: retired as an active roadmap.**

This file path is retained because repository tooling currently accounts for it and because Git history preserves the project's earlier direction. It must not be treated as a queue of work.

Floe no longer advances by attempting to complete a speculative architecture roadmap.

Current development direction comes from:

1. `MISSION.md`;
2. `PRODUCT.md`;
3. an actual operator outcome being attempted;
4. observed blockers from that attempt.

The development loop is:

**Want → Attempt → Observe → Diagnose → Generalise → Change → Attempt again**

A future task is not justified because an old roadmap mentioned it.

Wayfinder maps, old issue trees, PRDs, and prior architecture plans are historical evidence. They may explain why code exists or help diagnose a current problem, but they do not create an obligation to finish the imagined system.

## Current proving direction

Before broad feature development resumes, the operator surface must stop biasing the experiment toward substrate management.

The abandoned floe-app experiment treated Scope, Actor, Activity, and
Substrate Settings as a developer observatory. It is historical evidence, not
a current product surface.

The operator should be able to open a workspace and give Floe a real outcome without manually designing the system Floe should create.

A useful proving case is the already-demonstrated documentation operation, transformed from:

**expert manually composes a pipeline → Floe runs it**

into:

**operator asks for accurate documentation → Floe discovers/forms what it needs → work continues → operator sees meaningful state and intervenes only when valuable**

Do not add a new primitive unless this or another real operation proves it necessary.

## Historical vocabulary note

Older roadmap versions contained concepts such as a Default Scope and proposed or rejected mechanisms such as `.floe/blocks`. Those references are historical only. Current `CONTEXT.md` and accepted ADRs govern.
