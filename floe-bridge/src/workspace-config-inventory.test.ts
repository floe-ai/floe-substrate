import { describe, expect, it } from "vitest";

import type { ProjectLoadResult } from "./project.js";
import {
  WorkspaceConfigurationInventoryError,
  buildWorkspaceConfigurationInventory,
} from "./workspace-config-inventory.js";

const CONFIG_HASH = `sha256:${"a".repeat(64)}`;

function project(overrides: Partial<ProjectLoadResult> = {}): ProjectLoadResult {
  return {
    config_hash: CONFIG_HASH,
    agents: [{
      agent_id: "floe",
      name: "Floe",
      file: "./agents/floe.md",
      frontmatter: {
        charter: "Help the operator achieve the requested outcome.",
        api_key: "must-never-cross-the-import-boundary",
        responsibilities: [{
          responsibility_id: "coordinate",
          title: "Coordinate work",
          description: "Form and steer the required organisation.",
        }],
      },
      body: "Work from the operator's outcome.",
      extensions: [],
    }],
    pulses: [],
    watchers: [],
    validation: { ok: true, warnings: [], errors: [] },
    ...overrides,
  };
}

describe("Workspace configuration inventory", () => {
  it("builds a deterministic canonical input without copying credential references or arbitrary frontmatter", () => {
    const first = buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project(),
      runtimes: [{
        agent_id: "floe",
        adapter_id: "fake",
        provider: "openai-codex",
        model: "gpt-5.6",
        thinking_level: "high",
      }],
    });
    const second = buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project(),
      runtimes: [{
        agent_id: "floe",
        adapter_id: "fake",
        provider: "openai-codex",
        model: "gpt-5.6",
        thinking_level: "high",
      }],
    });

    expect(first).toEqual(second);
    expect(first.actors[0]).toMatchObject({
      source_actor_id: "floe",
      source: { path: "agents/floe.md" },
      definition: {
        label: "Floe",
        charter: "Help the operator achieve the requested outcome.",
        instructions: "Work from the operator's outcome.",
      },
      runtime: {
        adapter_id: "fake",
        backing_kind: "model",
        configuration: {
          provider: "openai-codex",
          model: "gpt-5.6",
          thinking_level: "high",
        },
        credential_requirement: "required",
        required_configuration_keys: ["model"],
      },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("must-never-cross-the-import-boundary");
  });

  it("sorts Actors and set-like runtime fields so equivalent observations are stable", () => {
    const actors = [
      project().agents[0]!,
      {
        ...project().agents[0]!,
        agent_id: "builder",
        name: "Builder",
        file: "agents/builder.md",
        body: "Build the selected increment.",
      },
    ];
    const inventory = buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project({ agents: [...actors].reverse() }),
      runtimes: [
        {
          agent_id: "builder",
          adapter_id: "fake",
          model: "gpt-5.6",
          required_capability_ids: ["vision", "filesystem", "vision"],
        },
        {
          agent_id: "floe",
          adapter_id: "fake",
          model: "gpt-5.6",
        },
      ],
    });

    expect(inventory.actors.map((actor) => actor.source_actor_id)).toEqual(["builder", "floe"]);
    expect(inventory.actors[0]?.runtime.required_capability_ids).toEqual(["filesystem", "vision"]);
  });

  it("projects loader failures as bounded codes instead of transporting parser text", () => {
    const inventory = buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project({
        validation: {
          ok: false,
          warnings: [".floe/floe.yaml schema is not floe.workspace.v1"],
          errors: ["Unable to parse .floe/floe.yaml: token=secret-value"],
        },
      }),
      runtimes: [{ agent_id: "floe", adapter_id: "fake", model: "gpt-5.6" }],
    });

    expect(inventory.validation).toEqual({
      ok: false,
      issues: [
        { severity: "error", code: "workspace_manifest_invalid", source_ref: ".floe/floe.yaml" },
        { severity: "warning", code: "workspace_manifest_schema_legacy", source_ref: ".floe/floe.yaml" },
      ],
    });
    expect(JSON.stringify(inventory)).not.toContain("secret-value");
  });

  it("refuses missing runtime observations and paths outside the Workspace", () => {
    expect(() => buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project(),
      runtimes: [],
    })).toThrow(/runtime observation is missing/);

    expect(() => buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project({
        agents: [{ ...project().agents[0]!, file: "../outside.md" }],
      }),
      runtimes: [{ agent_id: "floe", adapter_id: "fake" }],
    })).toThrow(WorkspaceConfigurationInventoryError);
  });

  it.each([
    { resource_policy: { nested: { access_token: "do-not-copy" } } },
    { resource_policy: { openai_api_key: "do-not-copy" } },
    { resource_policy: { provider: { client_secret: "do-not-copy" } } },
    { resource_policy: { transport: { bearer_token: "do-not-copy" } } },
    { resource_policy: { authorization: "do-not-copy" } },
    { resource_policy: { signing: { private_key: "do-not-copy" } } },
  ])("rejects nested secret-shaped adapter data rather than serializing it: $resource_policy", (runtime) => {
    expect(() => buildWorkspaceConfigurationInventory({
      binding_id: "binding:one",
      project: project(),
      runtimes: [{
        agent_id: "floe",
        adapter_id: "fake",
        ...runtime,
      }],
    })).toThrow(/secret material/);
  });
});
