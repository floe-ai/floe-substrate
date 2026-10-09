# Surface gaps

How a need found while building a surface becomes Floe work.

## Route

1. The surface records the gap in its own repository (see
   [surfaces: gaps](../surfaces/gaps.md)).
2. The surface's agent applies the **delete test**: would this still make sense
   in Floe if the surface were deleted? If not, it stays in the surface.
3. The operator decides whether it becomes Floe work.
4. Only approved gaps become a GitHub issue on this repository, labelled
   `surface-gap`, quoting the surface's gap number.

## Triage, when picking one up

- Restate the need without the surface's words or domain.
- Check whether existing mechanisms already compose it. If they do, the fix is
  documentation in `docs/reference/` or `docs/guide/`, not code.
- A missing or unclear published contract is a real Floe defect: surfaces are
  only allowed to build from published docs.
- If the change would add a surface-specific rule, field or screen to Floe,
  stop and return it to the operator.

When the fix ships, tell the operator which gap numbers it closes so the surface
can remove its stand-ins.
