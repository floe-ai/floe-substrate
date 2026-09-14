# Conversation reference proving slice — 7 September 2026

The preceding goal turn made progress: installed 0.1.77 proved the local approval,
one authorised export and automatic result return without another message. The
full goal remains active.

## Observed need — F81

The operator must be able to open the decision and result mentioned in the
conversation without searching the Workspace. The previous real attempt required
Actions, Workspace actions, approval search, list, request selection and then
inspection. Floe named the request by its raw ID. Its final export reply contained
only text, although the exact saved Gallery was openable in earlier messages.

This is an Actor behaviour and client representation problem. Existing operations
already return exact resource references and the action surface already discovers
current permissions and validation. Named references carry those existing shapes
through Event content into that surface. They create no resource, alternate
approval record, inferred state, authority, operation or execution route.

## Change and verification

`content.references` contains named `resource_ref` values. The conversation offers
an Open button; clicking carries the exact kind, identity and revision into the
existing ActionPanel under the current Workspace. Unknown resource kinds use the
same mechanism. Malformed references and attempts to embed another Workspace
boundary are ignored. Arbitrary prose and IDs never become approval controls.
Current state still comes from inspection, not the message's label.

Context communication input schema 2 describes the optional named references.
The model emit tool exposes the same content shape, and model prompts retain it
alongside the message text. The default Floe instructions ask for named exact
attachments in result handoffs, including after approval/export, and returned
resource references for other records. Installed Actor definitions are preserved;
the next real prompt provides the immediate operator need explicitly.

Forty-six client, 25 communication and 82 model-runtime tests pass. The additional
four-test backend repeat retains a named reference through the actual canonical
communication path. The app build passes. Installed 0.1.78 matches its package;
1,585 earlier Events, 31 versions, 11 Scope executions, both approval requests,
the receipt and its one use survive unchanged. All 36 Actor heads, accounts,
configuration, grants and bindings remain unchanged. The completed export retains
its exact reviewed hash. All nine installed desktop live connections and all
eight saved conversation Workspaces pass.

## Actual handoff and final client correction

The browser requested one openable handoff at 05:43:29.272 UTC:
`evt_8921b6d4-9339-438c-8e5c-32f5d3989899`, delivered as
`del_e1cd243e-0932-4f8a-8218-67e9bb7e879c`. Floe inspected the original approval
through `approval.inspect`, then emitted the handoff
`evt_f6446a81-1627-49b6-ae5e-44bd94a5f840` at 05:44:33.438 UTC. The named
reference exactly matches the returned original request at revision 3. The
Gallery, Test report and Build report are canonical attachments with readable
names. The turn completed at 05:44:37.745 UTC and is acknowledged. No follow-up,
extra model request, export, approval change, review, version or Actor change
occurred. There were no model image reads.

The actual browser showed the controls and opened the original request's actions.
It also exposed a doubled Open prefix and an extra inspection step. The final
0.1.79 client preserves an already supplied Open label and opens approval
inspection directly from the current discovered read descriptor. A message cannot
select an operation or supply execution input. Writes never run automatically,
and an unresolved submitted action retains precedence. Seventeen focused client
checks pass, including current state from an older reference and refusal to
automatically execute a descriptor that reports a write. Four runtime affordance
checks also preserve named references through history previews and retain bounded
JSON/cursor behaviour. The first 0.1.79 package was not installed; a final rebuild
includes that history-retention correction. The completed package is installed
and its desktop, service and broker match the build.

The compiled browser opens the exact recorded approval in one click from the
actual Floe-authored handoff, with its decision, reason and named Gallery evidence.
The Gallery runs in its isolated preview. Both reports open their exact saved
content and matching Gallery hash. Screenshots and DOM captures retain the actual
controls and results. After the final install and browser reload, the same
reference still opens directly without another model message.

The final upgrade retains all 1,588 earlier Events (including the handoff), 31
versions, 11 Scope executions, both approval requests, the receipt and its single
use, all 36 Actor heads, accounts, configuration, grants and bindings. The exported
file remains unchanged. The campaign comparison still proves the eight reviews,
three versions, four Actor heads and original approval state unchanged from before
the handoff. Installed desktop health, nine live connections and saved reads in
all eight Workspaces with conversations pass. Native desktop window interaction
is still unproven.

## Measured obstacle — F82

This obstacle is addressed in the installed
[0.1.80 recent-history correction](recent-history-20260907.md). The diagnosis
below records the F81 checkpoint.

The actual handoff took 64.166 seconds (68.473 to final acknowledgement message)
and 266,729 reported tokens across eleven responses: 226,282 input, 1,151 output,
39,296 cache-read; reasoning separately reports 244. All responses are accounted
for. There were six history calls, two capability discoveries, one inspection
and one emit. This is measured cost, not an efficiency success.

The retained tool arguments show six forward pages of up to 25 Events, beginning
with 5 September history and advancing to the recent approval. At that checkpoint
the `context_history` tool offered only a forward cursor and limit. This is an observed
retrieval obstacle: finding recent relevant work requires reading older work.
The Bus already supports backward Event pagination, used by the app's
`listContextEventHistoryPage`; the Bridge's `listContextEvents` exposes only
`since` and `limit`. Existing mechanisms can therefore supply the missing read.
The next bounded attempt should expose an appropriate recent-history read from
existing Context mechanisms while preserving exact references, bounded output,
continuation and Context isolation, then measure the same useful handoff. No
speculative memory service or broader context injection is justified.

No full product gate is closed by these bounded results.

Evidence: `C:/Development/_temp/floe-conversation-references-evidence-20260907/`.
Final client packaging and installation evidence:
`C:/Development/_temp/floe-conversation-references-final-evidence-20260907/`.
