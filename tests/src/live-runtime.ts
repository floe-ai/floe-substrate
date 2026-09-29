/**
 * Live runtime tier gating.
 *
 * The live tier drives the real FloeRuntimeAdapter through the official
 * Copilot SDK. The SDK uses vendor-managed Copilot authentication; Floe
 * brokers no model credential. A machine without an authenticated Copilot
 * SDK runtime therefore cannot run this tier.
 *
 * The project has learned that opt-in checks do not get run and that a test
 * which quietly skips is the same species of lie as a test that passes with
 * authority disabled. So the live tier is ON by default: if the vendor CLI is
 * not reachable and the operator has not *deliberately* disabled the tier, the
 * pre-flight fails loudly with an actionable message rather than skipping.
 *
 * Model choice — verified live, not assumed. The SDK exposes its current model
 * catalogue through `CopilotRuntime.models()`. Probed live
 * on 2026-09-15, `gpt-5-mini` is the cheapest genuinely-available model at a
 * `0x` usage multiplier (enabled, price category "low"), beating the next
 * cheapest `claude-haiku-4.5` / `gpt-5.4-mini` at `0.33x`. Copilot only reacts
 * to a model passed in the SDK session-creation config. Established sessions
 * may use the separate next-turn model-switch operation, but initial creation
 * must receive the requested model. If it ever stops advertising `gpt-5-mini` we do NOT
 * silently substitute a pricier model: the pre-flight fails loudly and asks for
 * a deliberate re-pick.
 */
import { createCopilotAccount, createCopilotRuntime } from "../../floe-bridge/src/engines/copilot.js";
import { pointAtMachineLogin } from "../../floe-bridge/src/test-support/machine-copilot-login.js";

/** The model the live tier pins. See the file header for how it was chosen. */
export const LIVE_TIER_MODEL = "gpt-5-mini";

/** Deliberate, visible opt-out for a machine that cannot run the vendor CLI. */
export const LIVE_TIER_DISABLED = process.env.FLOE_LIVE_RUNTIME_TIER === "off";

const OPT_OUT_HINT =
  "If this machine genuinely cannot run the vendor CLI, opt out deliberately with " +
  "FLOE_LIVE_RUNTIME_TIER=off — that is a visible, acknowledged choice, and the live " +
  "tier will announce that the real adapter was NOT proven. It will not silently skip.";

/** Printed once when the live tier is deliberately disabled, so the opt-out is never silent. */
export function announceLiveTierDisabled(): void {
  console.warn(
    "\n============================================================\n" +
    "  LIVE RUNTIME TIER DISABLED (FLOE_LIVE_RUNTIME_TIER=off)\n" +
    "  The real FloeRuntimeAdapter was NOT exercised this run.\n" +
    "  Only the fake adapter tier ran. The privileged live surface\n" +
    "  (attach + a real Copilot SDK turn) is UNPROVEN.\n" +
    "============================================================\n"
  );
}

/**
 * Prepare the Bridge's own Copilot folder for a live run and confirm, through
 * the same readiness and runtime construction the Bridge uses, that it is
 * signed in and advertises the pinned model. The folder gets this machine's
 * existing login pointer (never a sign-in). Throws a loud, actionable error
 * otherwise — never silently skips and never silently substitutes a model.
 */
export async function assertLiveRuntimeReady(copilotFolder: string): Promise<string> {
  let account: { label: string; host?: string };
  try {
    pointAtMachineLogin(copilotFolder);
    const readiness = await createCopilotAccount(copilotFolder).check();
    if (readiness.phase !== "ready" || !readiness.account) throw new Error(readiness.message);
    account = readiness.account;
  } catch (error) {
    throw new Error(
      "Live runtime tier could not find a signed-in, entitled Copilot account for Floe.\n" +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}\n` +
      "Sign in with the official Copilot CLI on this machine; Floe brokers no model credential.\n" +
      OPT_OUT_HINT
    );
  }

  const runtime = createCopilotRuntime(copilotFolder, { expectedAccount: account });
  let models: Array<{ modelId: string; _meta?: { copilotEnablement?: string; copilotUsage?: string } }>;
  try {
    models = await runtime.models(process.cwd()) as typeof models;
  } finally {
    await runtime.close().catch(() => {});
  }

  const chosen = models.find((model) => model.modelId === LIVE_TIER_MODEL);
  const enabled = chosen ? (chosen._meta?.copilotEnablement ?? "enabled") === "enabled" : false;
  if (!chosen || !enabled) {
    const catalogue = models
      .map((model) => `${model.modelId} (usage ${model._meta?.copilotUsage ?? "n/a"}, ${model._meta?.copilotEnablement ?? "enabled"})`)
      .join("\n  ");
    throw new Error(
      `Live runtime tier's pinned model "${LIVE_TIER_MODEL}" is not advertised/enabled by this account.\n` +
      "This tier does NOT silently substitute a different (possibly pricier) model. Re-pick the cheapest " +
      "genuinely-available model deliberately in tests/src/live-runtime.ts.\n" +
      `Currently advertised models:\n  ${catalogue}`
    );
  }
  return LIVE_TIER_MODEL;
}
