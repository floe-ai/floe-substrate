import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ActorInspector, ActorContexts, ActorLifecycleNote, actorExtensionName, actorFileRelPath } from "./ActorInspector.tsx";
import * as client from "../bus-client/client.ts";
import * as modelsForProfileHelper from "./modelsForProfile.ts";

const actorOperations = vi.hoisted(() => ({
  inspect: vi.fn(),
  revise: vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock("../bus-client/client.ts", () => ({
  getAuthProfiles: vi.fn(),
  resolveRuntimeBinding: vi.fn(),
  upsertRuntimeBinding: vi.fn(),
  clearRuntimeBindings: vi.fn(),
  listContextsByParticipant: vi.fn(),
}));

vi.mock("./actorDefinitionOperations.ts", () => ({
  inspectActorDefinition: actorOperations.inspect,
  reviseActorDefinition: actorOperations.revise,
}));

vi.mock("../features/conversations/contextCommunication.ts", () => ({
  createDirectConversation: actorOperations.createConversation,
}));

vi.mock("./modelsForProfile.ts", () => ({
  modelsForProfile: vi.fn(),
  withSelectedModelOption: vi.fn(),
  providerForProfile: vi.fn(),
}));

const mockProfiles = [
  { id: "profile-1", provider: "openai" },
];

const mockModels = [
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", api: "openai", reasoning: false },
  { id: "o1", name: "o1", provider: "openai", api: "openai", reasoning: true },
];

const mockActor = {
  endpoint_id: "ep-1",
  workspace_id: "ws-1",
  name: "My Actor",
  agent_id: "agent-1",
  bridge_id: "bridge-1",
  status: "active",
  metadata_json: JSON.stringify({ file: "agents/ep-1.md" }),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("Actor lifecycle presentation", () => {
  afterEach(() => cleanup());

  it("keeps retired identity legible without exposing hard deletion", () => {
    render(<ActorLifecycleNote actor={{ ...mockActor, status: "retired", bridge_id: null }} />);

    expect(screen.getByText(/historical actor identity is retained/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /delete actor/i })).toBeNull();
  });
});

describe("ActorInspector - Effort reset behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actorOperations.inspect.mockRejectedValue(new Error("No canonical definition in this fixture"));
    actorOperations.revise.mockResolvedValue({
      actor: {
        actor_id: "ep-1", workspace_id: "ws-1", status: "active",
        current_definition_revision_id: "revision:2", created_at: "", updated_at: "2026-01-02T00:00:00Z", retired_at: null,
      },
      revision: { content: { label: "My Actor" } },
    });
    vi.mocked(client.getAuthProfiles).mockResolvedValue({ profiles: mockProfiles, default_auth_profile: null });
    vi.mocked(client.resolveRuntimeBinding).mockResolvedValue({
      endpoint_auth_profile: "profile-1",
      workspace_auth_profile: null,
      global_auth_profile: null,
      endpoint_provider: "anthropic",
      workspace_provider: null,
      global_provider: null,
      endpoint_model: "o1",
      workspace_model: null,
      global_model: null,
      endpoint_thinking_level: "medium",
      workspace_thinking_level: null,
      global_thinking_level: null,
    });
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
    vi.mocked(modelsForProfileHelper.modelsForProfile).mockResolvedValue(mockModels);
    vi.mocked(modelsForProfileHelper.providerForProfile).mockReturnValue("openai");
    vi.mocked(modelsForProfileHelper.withSelectedModelOption).mockReturnValue(mockModels);
  });
  afterEach(() => cleanup());

  it("resets Effort dropdown to 'off' when a non-reasoning model is selected", async () => {
    render(<ActorInspector actor={mockActor} workspaceId="ws-1" />);

    // Wait for elements to load
    await waitFor(() => {
      const modelSelect = screen.getByRole("combobox", { name: "Model" });
      expect(modelSelect).toBeDefined();
    });

    const modelSelect = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    const effortSelect = screen.getByRole("combobox", { name: "Effort" }) as HTMLSelectElement;

    // Verify initial values from resolved bindings
    expect(modelSelect.value).toBe("o1");
    expect(effortSelect.value).toBe("medium");

    // Change model to "gpt-4o" (which is a non-reasoning model)
    fireEvent.change(modelSelect, { target: { value: "gpt-4o" } });

    // Effort should reset to "off"
    expect(effortSelect.value).toBe("off");

    // Verify upsertRuntimeBinding is called with "off" as thinking_level
    expect(client.upsertRuntimeBinding).toHaveBeenCalledWith({
      scope: "agent",
      workspace_id: "ws-1",
      endpoint_id: "ep-1",
      auth_profile: "profile-1",
      provider: "openai",
      model: "gpt-4o",
      thinking_level: "off",
    });
  });

  it("publishes a new canonical Actor definition when its name changes", async () => {
    actorOperations.revise.mockImplementation(async (_workspaceId, _actorId, change) => {
      const content = change({
        label: "My Actor",
        charter: "Build",
        responsibilities: [],
        instructions: "Work carefully.",
        knowledge_refs: [],
        capability_grant_ids: [],
        policy_refs: { budget: null, trust: null, approval: null },
        escalation_rules: [],
      });
      return {
        actor: {
          actor_id: "ep-1", workspace_id: "ws-1", status: "active",
          current_definition_revision_id: "revision:2", created_at: "", updated_at: "2026-01-02T00:00:00Z", retired_at: null,
        },
        revision: { content },
      } as never;
    });
    render(<ActorInspector actor={mockActor} workspaceId="ws-1" />);

    const input = screen.getByRole("textbox", { name: "Actor name" });
    fireEvent.change(input, { target: { value: "Delivery Builder" } });
    fireEvent.blur(input);

    await waitFor(() => expect(actorOperations.revise).toHaveBeenCalledWith(
      "ws-1",
      "ep-1",
      expect.any(Function),
    ));
    const change = actorOperations.revise.mock.calls[0]?.[2] as (value: Record<string, unknown>) => Record<string, unknown>;
    expect(change({ label: "Old", instructions: "Keep me" })).toEqual({
      label: "Delivery Builder",
      instructions: "Keep me",
    });
  });
});

const mockEndpoints = [
  { endpoint_id: "ep-1", workspace_id: "ws-1", name: "Actor One", agent_id: null, bridge_id: null, status: "idle", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { endpoint_id: "ep-2", workspace_id: "ws-1", name: "Actor Two", agent_id: null, bridge_id: null, status: "idle", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { endpoint_id: "ep-3", workspace_id: "ws-1", name: "Actor Three", agent_id: null, bridge_id: null, status: "idle", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { endpoint_id: "ep-retired", workspace_id: "ws-1", name: "Old Actor", agent_id: null, bridge_id: null, status: "retired", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
];

describe("ActorContexts - New Context picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("renders '+ New' button", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "New context" })).toBeDefined());
  });

  it("opens participant picker when '+ New' is clicked", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));
    expect(screen.getByRole("combobox", { name: "Select participant" })).toBeDefined();
  });

  it("does not list self in the participant picker", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));
    const select = screen.getByRole("combobox", { name: "Select participant" }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).not.toContain("ep-1");
    expect(options).not.toContain("ep-retired");
    expect(options).toContain("ep-2");
    expect(options).toContain("ep-3");
  });

  it("does not offer new work from a retired actor history view", async () => {
    render(
      <ActorContexts
        endpointId="ep-retired"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
        canStartContext={false}
      />
    );

    await waitFor(() => expect(client.listContextsByParticipant).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "New context" })).toBeNull();
  });

  it("creates a Context through the shared operation contract and opens it", async () => {
    const newCtx = {
      context_id: "ctx-new",
      workspace_id: "ws-1",
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: "ep-1",
      created_at: "2026-01-01T00:00:00Z",
      last_event_at: null,
      participants: ["ep-1", "ep-2"],
      first_message_preview: null,
    };
    actorOperations.createConversation.mockResolvedValue(newCtx as any);
    const onOpenContext = vi.fn();

    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={onOpenContext}
        endpoints={mockEndpoints}
      />
    );

    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));

    const select = screen.getByRole("combobox", { name: "Select participant" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ep-2" } });

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(actorOperations.createConversation).toHaveBeenCalledWith("ws-1", ["ep-1", "ep-2"]);
    });
    expect(onOpenContext).toHaveBeenCalledWith("ctx-new");
  });

  it("dismisses picker on cancel without creating a Context", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));
    expect(screen.getByRole("combobox", { name: "Select participant" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("combobox", { name: "Select participant" })).toBeNull();
    expect(actorOperations.createConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// actorExtensionName + actorFileRelPath — extension sentinel handling
// ---------------------------------------------------------------------------

function makeActor(metadata_json: string) {
  return {
    endpoint_id: "ep-x",
    workspace_id: "ws-1",
    name: "Test Actor",
    agent_id: "agent-x",
    bridge_id: "bridge-1",
    status: "idle",
    metadata_json,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("actorExtensionName", () => {
  it("returns the extension name for a sentinel file value", () => {
    const actor = makeActor(JSON.stringify({ file: "[extension:acme]" }));
    expect(actorExtensionName(actor)).toBe("acme");
  });

  it("returns null for a normal file path", () => {
    const actor = makeActor(JSON.stringify({ file: "agents/my-agent.md" }));
    expect(actorExtensionName(actor)).toBeNull();
  });

  it("returns null when metadata_json is missing", () => {
    const actor = makeActor("");
    actor.metadata_json = "";
    expect(actorExtensionName({ ...actor, metadata_json: "" })).toBeNull();
  });

  it("returns null when file field is absent", () => {
    const actor = makeActor(JSON.stringify({ runtime: "pi" }));
    expect(actorExtensionName(actor)).toBeNull();
  });
});

describe("actorFileRelPath", () => {
  it("returns null for an extension sentinel", () => {
    const actor = makeActor(JSON.stringify({ file: "[extension:acme]" }));
    expect(actorFileRelPath(actor)).toBeNull();
  });

  it("returns the .floe/-prefixed path for a normal file-backed actor", () => {
    const actor = makeActor(JSON.stringify({ file: "agents/my-agent.md" }));
    expect(actorFileRelPath(actor)).toBe(".floe/agents/my-agent.md");
  });

  it("returns null when metadata_json is empty/missing", () => {
    const actor = makeActor("");
    expect(actorFileRelPath({ ...actor, metadata_json: "" })).toBeNull();
  });

  it("returns null when file field is absent", () => {
    const actor = makeActor(JSON.stringify({}));
    expect(actorFileRelPath(actor)).toBeNull();
  });
});
