# Gaps

A gap is something the surface needs that Floe does not provide, or does not
document well enough to build from.

## Record it

Keep a `FLOE-GAPS.md` at the root of the surface's repository:

```markdown
## G3 — Short name

- Need: what the surface needed, in plain words.
- Tried: which published doc or client you used.
- Delete test: would this still make sense in Floe without this surface? Why?
- Stand-in: none | `FALLBACK(G3)` in src/path.ts
- Status: open | sent to operator | approved | closed in Floe x.y.z
```

Number gaps once (G1, G2, …) and never reuse a number.

## Send it

Bring open gaps to the operator together. Never ask Floe developers directly
and never edit Floe. If the operator approves, the gap becomes Floe work
([how Floe handles it](../contributing/surface-gaps.md)).

If the delete test fails, the need belongs in the surface: build it there.

## Close it

When Floe ships the fix, remove every `FALLBACK(Gn)` marker for that gap, prove
it live, and mark the gap closed with the Floe version.
