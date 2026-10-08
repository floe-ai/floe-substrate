# Install and launch

## Works today

- **Declare the surface** in its `package.json` with `floe.surface`
  (`name`, `label`, `bin`). A surface never ships a bin called `floe`; bare
  `floe` is Floe's boot menu. Details: [install and first run](../guide/install-and-first-run.md#make-a-package-a-surface).
- **Accept `--launched-by=floe`** as the final argument. With it, offer the
  person's workspaces; without it, the launch folder decides. Never silently
  open a different workspace.
- **Starting Floe:** connecting to Floe's identity agent starts Floe when the
  machine allows on-demand start.
- **Talking to Floe:** identity and engines use published wire protocols over
  a local connection (see `docs/reference/`). Node surfaces may use Floe's
  helpers instead: `floe/identity`, `floe/engines` and `floe/actors`. Today
  the helpers come from a Floe dependency
  (`"floe": "github:floe-ai/floe#semver:^x.y.z"`).
- Floe installs from GitHub: `npm install -g github:floe-ai/floe`.

## Decided, not built

The operator has decided how surfaces install. Floe does not support it yet,
so do not claim it in a surface's docs.

| Code | Decision | Status |
|---|---|---|
| I-1 | A surface uses the machine's installed Floe, like an app uses installed Node. | Not built |
| I-2 | A surface declares the Floe version range it needs. Missing Floe: offer to install it. Too old: offer to upgrade. | Not built |
| I-3 | A surface carries its own Floe only to test Floe or the surface in isolation. | Not built |

**Open gap (small):** Floe's identity and engines run inside the installed
Floe; a surface only talks to them. That conversation is a published wire
protocol any language can speak, with no Floe copy needed
([identity](../reference/identity-agent-protocol.md#the-wire-protocol-any-language),
[engines](../reference/engine-control-protocol.md#the-wire-protocol-any-language)).
Only the optional Node helpers (`floe/identity`, `floe/engines`) and their
"start Floe if needed" step come from a Floe copy today. Under I-1 those helpers
need a home that does not carry Floe. Until Floe ships one, a Node surface may
keep the dependency for the helpers alone; record it as a gap.
