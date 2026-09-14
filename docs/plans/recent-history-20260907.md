# Recent Context history — F82

## Observed need

The F81 handoff required six forward Context-history pages to reach recent
approval evidence. It used 266,729 reported tokens over eleven model responses.
The smallest need is to retrieve recent contributions without first retrieving
older contributions. This belongs in the model-facing client: the Bus already
offers backward Event pagination, and the app already uses it.

## Bounded correction

`context_history` now starts with recent contributions by default. It returns
chronological Events within a page, the direction, and the unchanged Bus cursor
for continuing in that direction. Explicit forward reads remain available.
The tool remains scoped to the turn's origin Context. Earlier history is not
automatically injected into a model turn.

The existing 16,000-character bound narrows backward reads from the recent end
and obtains the matching cursor from the Bus. It never skips an unreturned Event
to meet the bound. Large fields remain explicitly marked when omitted; saved
history and exact references are unchanged. No storage, schema, authority or
substrate lifecycle is added.

The Bridge typecheck also exposed an outdated receipt type: it omitted the Bus's
existing awaiting-approval and unknown-outcome states and approval evidence.
The transport type now matches those existing fields. This is erased TypeScript
metadata; approval runtime behaviour is unchanged.

## Verification

- 47 focused history, transport and Context-isolation checks pass. They cover
  both directions, opaque cursor continuation, bounded pages, oversized Events,
  no skipped/duplicated Events, exact saved references and deliberately loaded
  history.
- 82 adapter checks, 47 Bus server checks (including backward history) and ten
  capability checks pass.
- The Bridge typecheck and 0.1.80 package build pass. Rebundling after the
  receipt-type correction produces exactly the same service bytes as the
  package. Version 0.1.80 is installed; the desktop, broker and service match the
  completed package. Recovery is retained at
  `C:/Users/jfenech/.floe/recovery/before-0.1.80-20260907-recent-history`.
- All 1,588 earlier Events, 31 versions, 11 executions, both approval requests,
  the receipt and its single use survive unchanged. All 36 Actor heads,
  accounts, configuration, grants and runtime bindings are preserved. The
  completed local export has the same hash.
- Installed desktop checks pass: health, all nine live Workspace connections,
  and reads in all eight Workspaces with conversations. The browser reconnects
  after restart. Native desktop window interaction remains unproven.

## Actual handoff

The same request was sent through the actual browser at 06:20:27.263 UTC:
`evt_51606659-b338-4d64-9c3d-eaf225673fdd`, Delivery
`del_2223e0f4-3a3e-4944-add3-f296af650ce3`. The Workspace and model remain the
original campaign proof and ChatGPT / GPT-5.6 Sol / high. The delivery is
acknowledged, with complete usage coverage and no tool failures.

Floe made one backward history call requesting 20 Events. The bounded tool
returned the 12 most recent Events in 15,026 characters, using two Bus reads to
meet the size limit without omitting fields. Floe reused the exact saved approval
reference and three attachments, then emitted
`evt_594f3639-b1b9-4c1e-8f44-9da5ed6ef044`. It made no semantic operation call,
image read, review, export or follow-up request. All campaign records and the
exported file remain unchanged after the attempt and browser checks.

| Measured handoff | F81 | F82 |
| --- | ---: | ---: |
| Seconds to handoff | 64.166 | 17.518 |
| Seconds to final message | 68.473 | 21.983 |
| Reported tokens | 266,729 | 26,014 |
| Model responses | 11 | 3 |
| History tool calls | 6 | 1 |

The F82 total includes 25,591 input and 423 output tokens, zero cache tokens;
reasoning separately reports 105. The observed token reduction is 90.25%.

The new handoff's approval control opens the original approved request directly,
showing its recorded decision and exact Gallery evidence. The Gallery runs in
the isolated preview; both reports open and identify the same Gallery hash.
Screenshots and DOM captures retain the actual browser results. The app is left
on the completed handoff, with previews closed.

This is not a controlled attribution of savings to the history change:
the Context now contains the F81 handoff. This proves that the installed model
tool reaches recent work directly and completes this handoff with less observed
cost. It does not establish general task efficiency. No full product gate closes
from this bounded proof. Continue the accepted end-to-end journey rather than
repeating this successful handoff.

Evidence: `C:/Development/_temp/floe-recent-history-evidence-20260907/`.
