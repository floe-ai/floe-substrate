# Approved pipeline focus presentation

Status: approved visual reference; presentation restored in revision 0.1.65. Browser evidence and the remaining installed native visual check are recorded in [the revision proof](../../plans/pipeline-visual-revision-20260906.md). The selected-branch conversation now passes; see [app participation proof](../../plans/actor-participation-revision-20260906.md). P6 remains partial.

The next Floe revision must match this prototype visually as well as preserve
its progressive navigation. This is a correction to an existing product surface,
not a new graph primitive or a mandate to make every outcome a pipeline.

## Reference and approval

Open [the preserved original prototype](prototype.html) in a browser. It is
self-contained, includes saved example images, and does not operate the live
substrate. Its conversation and branch examples are illustrative.

- Original task: **Simplify floe-app operator entry**,
  `01a01f16-1077-79c0-94d0-3acbeab0ebf9`.
- Operator approval, 2026-09-02: “YES, this is the one. seeing the pipeline this
  way is great. now implement this officially unless you feel this is not able
  to handle a first principles perspective or a substrate native criteria.”
- Reaffirmed in **Review Floe substrate progress**, 2026-09-06: “please make
  sure we match this approved prototype as part of the next revision - visually!”
- Preserved file: original `pipeline-focus-prototype.html`, unchanged.
- SHA-256: `ae3e8c2f4761fb55b3eb99799225db35677436b4afbde2d8beaaa2fbca451527`.

## Visual success criteria

| Check | Pass condition |
|---|---|
| V1 — Overall appearance | The actual app preserves the prototype's dark dotted background, card hierarchy, readable contrast, typography, spacing and emphasis. Compare equivalent states at the same viewport and available content width. |
| V2 — Work cards | Inputs, current outputs, image previews, actor identity and meaningful status appear together in the step card. Ordinary use does not require reading internal IDs or Port counts. |
| V3 — Connected branches | Visible connections reach the actual downstream cards. Selecting an output with recorded downstream work reveals its corresponding branches with previews and names. A generic arrow between columns is insufficient. |
| V4 — Progressive focus | Selecting a step reveals its next layer while preserving the previous layer and a usable return path. Branches stay manageable; old versions and execution history remain secondary. |
| V5 — Inspection and conversation | The operator opens the exact output and its associated conversation from the selected work without losing their place in the pipeline. |
| V6 — Responsive layout | Wide layouts retain the surrounding pipeline and branch view; narrow layouts retain readable previews, relationships and controls. The prototype changes to a single column at 800px; account explicitly for app navigation consuming content width rather than blindly copying viewport breakpoints. |
| V7 — Real records | Names, images, connections, branches, status and conversations come from canonical records. Show missing execution or output honestly. Never manufacture the prototype's proposed Contexts or infer routes from subscriptions or filenames. |

## Next-revision acceptance

Reproduce F61–F63 in `docs/plans/astra-operator-proof.md`, implement the
presentation against current canonical contracts, and compare actual app
screenshots with this reference. Exercise source, focused step, branching output,
selected child and conversation states at desktop and narrow widths. Use a real
executed pipeline with retained outputs as well as a plan with no recorded run.

Record the installed version, viewport sizes, screenshots, interactions and any
remaining differences. Verify that selecting a branch opens the correct exact
output and conversation and that history remains reachable. Relevant behaviour
checks and a successful build are required, but cannot replace visual proof.
Keep P6 pending until this evidence exists. This check does not replace the
remaining product gates or the full 18-step acceptance journey.
