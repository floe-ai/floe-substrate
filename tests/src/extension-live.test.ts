import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkInstalledExtensions, INSTALL_RECORD_SCHEMA, MANIFEST_SCHEMA } from "../../floe-bridge/src/extensions/install-records.js";
import { SliceHarness, fileExists, waitFor, type SliceTier } from "./slice-harness.js";
import { LIVE_TIER_DISABLED, LIVE_TIER_MODEL, announceLiveTierDisabled } from "./live-runtime.js";

const LIVE_TIER: SliceTier = { id: "live-copilot", adapter: "floe-runtime", provider: "copilot", model: LIVE_TIER_MODEL, live: true };

// Every hook and tool call is written to a file by the Extension itself, so the
// proof rests on what ran, not on what the model says.
const PROBE = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default (ctx) => {
  const log = (entry) => appendFileSync(join(ctx.workspacePath, "probe-log.jsonl"), JSON.stringify(entry) + "\\n");
  ctx.hooks.on("BeforeTurn", (turn) => {
    log({ hook: "BeforeTurn", endpoint_id: turn.endpoint_id });
    return { inject: { source: "probe", content: "This project's mascot is a pelican named PELICAN." } };
  });
  ctx.hooks.on("BeforeToolUse", (call) => {
    log({ hook: "BeforeToolUse", tool_name: call.tool_name, source: call.source, args: call.args, endpoint_id: call.endpoint_id });
    if (call.tool_name !== "probe_stamp") return;
    if (call.args?.text === "forbidden") return { decision: "block", reason: "probe refuses forbidden" };
    return { decision: "change", args: { text: call.args.text + "-checked" } };
  });
  return [{
    name: "stamp",
    description: "Stamp a piece of text and return it.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_callId, params) {
      log({ tool: "probe_stamp", text: params.text });
      return { content: [{ type: "text", text: "stamped:" + params.text }] };
    },
  }];
};
`;

if (LIVE_TIER_DISABLED) announceLiveTierDisabled();
const declareLive = LIVE_TIER_DISABLED ? describe.skip : describe;

declareLive("Extensions on a real runtime [live-copilot]", () => {
  const h = new SliceHarness(LIVE_TIER);

  beforeEach(async () => {
    await h.start();
  }, 120_000);

  afterEach(async () => {
    h.captureEvidence("extension-live");
    await h.stop();
  });

  it("gives a listing Actor the Extension's tool, BeforeTurn text and BeforeToolUse checks", async () => {
    const floeDir = join(h.projectPath, ".floe");
    const extDir = join(floeDir, "extensions", "probe");
    mkdirSync(join(floeDir, "agents"), { recursive: true });
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(floeDir, "agents", "floe.md"), [
      "---",
      "schema: floe.agent.v1",
      "agent_id: floe",
      "label: Floe",
      "extensions:",
      "  - probe",
      "---",
      "# Floe",
      "You are Floe. Follow the operator's instructions exactly.",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ schema: MANIFEST_SCHEMA, name: "probe", entry: "./index.mjs" }));
    writeFileSync(join(extDir, "index.mjs"), PROBE, "utf8");
    const record = { schema: INSTALL_RECORD_SCHEMA, code: ".", enabled: true, accepted_version: null as string | null };
    writeFileSync(join(extDir, "installed.json"), JSON.stringify(record));
    // Accepting the version is an Actor's act: write the current version into the record.
    const [held] = await checkInstalledExtensions(floeDir);
    expect(held).toMatchObject({ name: "probe", state: "new_version" });
    record.accepted_version = (held as { current_version: string }).current_version;
    writeFileSync(join(extDir, "installed.json"), JSON.stringify(record));

    const workspaceId = await h.registerAndAuthorize(h.projectPath);
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(() => h.busMessages.some((message) =>
      message.type === "workspace_attachment_result"
      && message.payload?.validation?.extensions?.some((ext: any) => ext.name === "probe" && ext.status === "running")
    ), "probe Extension running");

    await h.post("/v1/endpoints/register", { endpoint_id: humanEndpointId, workspace_id: workspaceId, name: "Operator", status: "online" });
    await h.post("/v1/runtime/bindings", {
      scope: "workspace_default", workspace_id: workspaceId, auth_profile: "copilot-atvi",
      provider: LIVE_TIER.provider, model: LIVE_TIER.model,
    });
    await waitFor(async () => {
      const { endpoints } = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.some(endpoint => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "runtime configured status");

    await h.post("/v1/events/emit", {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: humanEndpointId,
      destination: { kind: "endpoint", endpoint_id: agentEndpointId },
      thread_id: "thread:extension-live",
      correlation_id: null,
      content: {
        text: [
          "Call the `probe_stamp` tool with {\"text\":\"hello\"}.",
          "Then call `probe_stamp` again with {\"text\":\"forbidden\"}.",
          "Do not call any other tool. Then reply with each tool's result and the name of this project's mascot from the provided project context.",
        ].join(" "),
        data: {},
      },
      response: { expected: false },
      metadata: {},
    });

    const results = await waitFor(async () => {
      const events = await h.runtimeResults(workspaceId, agentEndpointId);
      return events.length >= 1 ? events : false;
    }, "runtime result", 150_000);

    const logPath = join(h.projectPath, "probe-log.jsonl");
    expect(fileExists(logPath), "the probe Extension ran").toBe(true);
    const log = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const reply = String(results[0]?.content?.text ?? "");
    console.log("[extension-live] probe log", JSON.stringify(log));
    console.log("[extension-live] reply", reply);

    expect(log).toContainEqual({ hook: "BeforeTurn", endpoint_id: agentEndpointId });
    expect(log).toContainEqual({ hook: "BeforeToolUse", tool_name: "probe_stamp", source: "custom", args: { text: "hello" }, endpoint_id: agentEndpointId });
    expect(log).toContainEqual({ hook: "BeforeToolUse", tool_name: "probe_stamp", source: "custom", args: { text: "forbidden" }, endpoint_id: agentEndpointId });
    // The change reached the tool; the block stopped it.
    expect(log.filter(entry => entry.tool)).toEqual([{ tool: "probe_stamp", text: "hello-checked" }]);
    expect(reply).toContain("stamped:hello-checked");
    expect(reply.toUpperCase()).toContain("PELICAN");

    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 300_000);
});
