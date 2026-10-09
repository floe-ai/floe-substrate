# Building a surface on Floe

A **surface** is a product that people use, built on Floe in its own repository.
Floe supplies the shared mechanism (identity, workspaces, Actors, Contexts,
events, AI engines); the surface supplies the domain, rules, screens and state.

floe-console is the reference surface.

## Rules

1. **One fenced job.** State what the surface is for, and what it is not for,
   before writing code.
2. **No privileged access.** A surface is an ordinary Floe client. It never
   reads Floe's files or database, and never keeps its own copy of Floe's state.
3. **Build from published docs, not Floe's source.** Use `docs/reference/` and
   `docs/guide/`. If they are not enough, that is a Floe gap: report it.
4. **Never work around a gap silently.** Record it ([gaps](gaps.md)). If a
   stand-in is unavoidable, mark it in code with `FALLBACK(Gn)`.
5. **Never edit Floe.** Floe changes go through the operator.
6. **Prove it live.** Run against a real Floe on a test profile
   (ports 5480–5489, throwaway Floe home). Never touch the operator's Floe
   (5377, `~/.floe`) or destroy real state.
7. **Developer access is not product access.** While testing, the developer
   may act as the operator to set things up. The surface itself never holds
   that access.
8. **Finish with a handoff.** What works, what was proved, open gaps, and what
   made you stop. Then propose [lessons](lessons.md).

## Floe's responsibilities vs yours

| Floe owns | The surface owns |
|---|---|
| Sign-in and identity logic, workspaces, Actors, Contexts, events, AI engines | Screens and style (web, terminal, anything), domain data, rules, formats |

Floe provides the sign-in steps; the surface draws them in its own style.

## Next

- [Install and launch](install.md)
- [Gaps](gaps.md)
- [Lessons](lessons.md)
