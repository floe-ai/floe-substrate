#!/usr/bin/env node
/**
 * Reproduction script for ticket #157 ("The documentation pipeline runs end to end").
 *
 * Wires up the proving-case Scope Graph — watched folder -> Writer/Reviewer
 * (argue directly) -> command node (runs docs-structure.test.ts) -> Approver
 * (writes the file) — against a REAL, already-running bus+bridge (`floe start`)
 * and a REAL auth profile. There is no mock LLM here: this exercises the actual
 * substrate primitives (scope graphs, node instruction bindings, folder
 * watching, command nodes, context fan-out) end to end, so it is a manual
 * reproduction/regression check, not a CI test.
 *
 * See docs/plans/documentation-pipeline-e2e-reproduction.md for prerequisites,
 * usage, and how to read the result.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const BUS = process.env.FLOE_BUS_URL ?? "http://127.0.0.1:5377";
const REPO_ROOT = process.env.FLOE_REPO_ROOT ?? process.cwd();
const AUTH_PROFILE = process.env.FLOE_AUTH_PROFILE ?? "atvi-copilot";
const MODEL = process.env.FLOE_MODEL ?? "gpt-5-mini";
const THINKING_LEVEL = process.env.FLOE_THINKING_LEVEL ?? "medium";
const TARGET_DOC = "docs/plans/build-tool-guide.md";
const NOTE_DIR = ".floe/inbox/docs-notes";
const NOTE_FILE = "build-picker-note.md";
const CHECK_COMMAND = "npx vitest run floe-bus/src/docs-structure.test.ts";

async function post(path, body) {
  const res = await fetch(`${BUS}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return json;
}

async function get(path) {
  const res = await fetch(`${BUS}${path}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(predicate, description, timeoutMs = 60_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function main() {
  const target = join(REPO_ROOT, TARGET_DOC);
  if (existsSync(target)) rmSync(target);

  const registered = await post("/v1/workspaces/register", { locator: REPO_ROOT, init_authorized: true });
  const workspaceId = registered.workspace.workspace_id;
  console.log("workspace_id", workspaceId);

  await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, {});

  const writerId = `actor:${workspaceId}:writer`;
  const reviewerId = `actor:${workspaceId}:reviewer`;
  const approverId = `actor:${workspaceId}:approver`;
  const checkerId = `actor:${workspaceId}:docs_check`;

  // These three agents are NOT part of the repo's committed .floe config —
  // they exist only for this reproduction run. Registering them here (rather
  // than requiring the operator to hand-edit .floe/floe.yaml) keeps the repo
  // clean between runs. See the doc for the manual .floe.yaml alternative if
  // you want to watch the pipeline through the CLI/app instead of this script.
  const agentsDir = join(REPO_ROOT, ".floe", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ["writer", "reviewer", "approver"]) {
    writeFileSync(join(agentsDir, `${name}.md`), `# ${name}\n\nFollow the instructions bound to whichever node you are acting as in the active Scope Graph.\n`, "utf8");
  }

  for (let i = 0; i < 60; i++) {
    const { endpoints } = await get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
    const ids = endpoints.map((e) => e.endpoint_id);
    if (ids.includes(writerId) && ids.includes(reviewerId) && ids.includes(approverId)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  await post("/v1/runtime/bindings", {
    scope: "workspace_default",
    workspace_id: workspaceId,
    auth_profile: AUTH_PROFILE,
    model: MODEL,
    thinking_level: THINKING_LEVEL
  });

  await waitFor(async () => {
    const { endpoints } = await get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
    const writer = endpoints.find((e) => e.endpoint_id === writerId);
    return writer?.status === "idle";
  }, "writer endpoint to become idle");

  await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`, { scope_id: "docs-repro", title: "Documentation pipeline (reproduction)" });

  const graphCreated = await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs-repro/graphs`, {
    nodes: [
      { node_id: "note_arrived", kind: "trigger", event_type: "docs.note.landed" },
      {
        node_id: "writer_node",
        kind: "actor",
        endpoint_id: writerId,
        event_types: ["docs.note.landed"],
        bindings: [{
          kind: "instructions",
          text: [
            "You are acting as the Writer node of the Documentation Pipeline graph.",
            "The trigger event's content has file_name and file_path — read that file with `read`.",
            "Draft the requested documentation change as a complete Markdown file body (not a diff) for a path under docs/plans/.",
            "Use `emit` with type \"message\" and destination \"reviewer\" to send your draft. State clearly: the target docs/plans/ file path, and the full proposed file content.",
            "Wait for the Reviewer's reply (it comes back to you directly). If it requests changes, revise and emit to \"reviewer\" again. Once the Reviewer confirms approval to you, your job in this graph is done — do not write any file yourself."
          ].join("\n")
        }]
      },
      {
        node_id: "reviewer_node",
        kind: "actor",
        endpoint_id: reviewerId,
        // Deliberately NOT subscribed to the trigger's fan-out (event_types: []) —
        // the Reviewer must only wake from the Writer's direct emit, never from
        // the folder-watcher's trigger fire. See docs/plans/documentation-pipeline-e2e-reproduction.md.
        event_types: [],
        bindings: [{
          kind: "instructions",
          text: [
            "You are acting as the Reviewer node of the Documentation Pipeline graph.",
            "The Writer emits its draft directly to you. Critique it for accuracy, clarity, and fit with this repository's documentation conventions (see docs/design/README.md).",
            "If it needs changes: emit type \"message\" to destination \"writer\" with specific, actionable feedback, and wait for the revision.",
            "If it is acceptable, do BOTH: (1) emit type \"message\" to destination \"writer\" confirming approval; (2) emit type \"review.approved\" to destination \"docs_check\" with the approved target path and full content in the text, to trigger the repo's existing check.",
            "Do not write any file yourself."
          ].join("\n")
        }]
      },
      {
        node_id: "check_node",
        kind: "command",
        endpoint_id: checkerId,
        event_types: ["review.approved"],
        result_event_type: "command.result",
        command: CHECK_COMMAND,
        outputs: [
          { name: "passed", from: "passed" },
          { name: "exit_code", from: "exit_code" },
          { name: "stdout", from: "stdout" },
          { name: "stderr", from: "stderr" }
        ]
      },
      {
        node_id: "approver_node",
        kind: "actor",
        endpoint_id: approverId,
        event_types: ["command.result"],
        bindings: [{
          kind: "instructions",
          text: [
            "You are acting as the Approver node of the Documentation Pipeline graph.",
            "You are woken when the Command node (\"docs_check\") posts its result. You can see this context's full history, including the Writer's approved draft and the Reviewer's approval message.",
            "If the Command result shows passed=true: write the Writer's exact approved content to the exact docs/plans/ path it stated, using the `write` tool. Then emit type \"message\" (reply to source) confirming the file was written, with the path.",
            "If passed=false: do NOT write anything. emit type \"message\" to destination \"writer\" summarizing the failure (stdout/stderr) so it can revise."
          ].join("\n")
        }]
      }
    ]
  });
  const graph = graphCreated.graph;
  console.log("graph_id", graph.graph_id);
  console.log("context_id", graph.context_id);

  const noteDirAbs = join(REPO_ROOT, NOTE_DIR);
  mkdirSync(noteDirAbs, { recursive: true });

  // Re-attach so the bridge picks up the scratch actor files and the folder
  // source stored on this run's graph. No parallel watcher config is needed.
  const floeYamlPath = join(REPO_ROOT, ".floe", "floe.yaml");
  const originalYaml = existsSync(floeYamlPath) ? await import("node:fs").then((fs) => fs.readFileSync(floeYamlPath, "utf8")) : null;
  const YAML = await import("yaml");
  const parsed = originalYaml ? YAML.parse(originalYaml) : { schema: "floe.workspace.v1", version: 1 };
  parsed.agents = parsed.agents ?? [{ id: "floe", path: "./agents/floe.md" }];
  for (const id of ["writer", "reviewer", "approver"]) {
    if (!parsed.agents.some((a) => a.id === id)) parsed.agents.push({ id, path: `./agents/${id}.md` });
  }
  writeFileSync(floeYamlPath, YAML.stringify(parsed), "utf8");

  await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/config-snapshot`, {});
  await post("/v1/runtime/bindings", {
    scope: "workspace_default",
    workspace_id: workspaceId,
    auth_profile: AUTH_PROFILE,
    model: MODEL,
    thinking_level: THINKING_LEVEL
  });

  writeFileSync(join(noteDirAbs, NOTE_FILE), [
    "# Note: document the build picker tool",
    "",
    `Please document the repo's \`npm run build\` picker tool (scripts/build.mjs) at ${TARGET_DOC}.`,
    "Cover: available targets, selecting specific targets, the --all flag, and non-TTY behaviour."
  ].join("\n"), "utf8");
  console.log(`Dropped note at ${join(noteDirAbs, NOTE_FILE)} — watching for ${target} ...`);

  await waitFor(() => existsSync(target), `${TARGET_DOC} to be written by the Approver`, 5 * 60_000, 3000);
  console.log(`${TARGET_DOC} exists.`);

  const check = spawnSync("npx", ["vitest", "run", "floe-bus/src/docs-structure.test.ts"], { cwd: REPO_ROOT, stdio: "inherit", shell: true });
  if (check.status !== 0) throw new Error("docs-structure.test.ts did not pass with the generated file present");
  console.log("docs-structure.test.ts passed with the generated file present. Pipeline proven end to end.");

  console.log("\nCleanup: this script does not remove the generated file, the scratch .floe/agents/*.md files, or the .floe/floe.yaml actor entries it added — see docs/plans/documentation-pipeline-e2e-reproduction.md for the manual cleanup steps, or re-run `git checkout -- .floe/floe.yaml` and delete the untracked files it lists.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
