import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FloeModelControl } from "./FloeModelControl.tsx";
import { loadActorModel, saveActorModel, type ActorModel } from "./actorModel.ts";
import { getModelProviders, type ModelProviderStatus } from "../providers/modelProviders.ts";
vi.mock("./actorModel.ts", () => ({ loadActorModel: vi.fn(), saveActorModel: vi.fn() }));
vi.mock("../bus-client/browser.ts", () => ({ isLocalBrowserConnection: () => true }));
vi.mock("../providers/modelProviders.ts", async original => ({ ...await original<typeof import("../providers/modelProviders.ts")>(), getModelProviders: vi.fn() }));
const account: ModelProviderStatus = {
  type: "provider_status", provider: "proof", name: "Proof", auth_name: "Proof", connected: true,
  profile_id: "proof", secret_ref_id: "secret:proof", credential_revision: "generation:1:resolved",
  models: [{ id: "reasoning", name: "Reasoning", is_default: true, reasoning_efforts: ["high", "xhigh"] }, { id: "basic", name: "Basic", is_default: false, reasoning_efforts: [] }],
};
const current = { actor: { actor: { actor_id: "actor:one" } }, binding: { status: "resolved", unresolved_reasons: [] }, profile: { content: { configuration: { provider: "proof", model: "reasoning", thinking_level: "high" } } } } as unknown as ActorModel;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModelProviders).mockResolvedValue([account]);
  vi.mocked(loadActorModel).mockResolvedValue(structuredClone(current));
  vi.mocked(saveActorModel).mockImplementation(async (_workspace, saved, _provider, model, effort) => ({
    ...saved, profile: { ...saved.profile, content: { ...saved.profile.content, configuration: { provider: "proof", model, thinking_level: effort } } },
  }));
});
afterEach(cleanup);
describe("Floe model selection", () => {
  it("allows local browser selection and stays unready until the exact choice is saved", async () => {
    const ready = vi.fn();
    render(<FloeModelControl workspaceId="workspace:one" endpointId="endpoint:one" readOnly onReadyChange={ready} />);
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
    const effort = screen.getByRole("combobox", { name: "Floe effort" });
    fireEvent.change(effort, { target: { value: "xhigh" } });
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false));
    expect(saveActorModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use model" }));
    await waitFor(() => expect(saveActorModel).toHaveBeenCalledWith("workspace:one", current, account, "reasoning", "xhigh"));
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
    expect(loadActorModel).toHaveBeenCalledWith("workspace:one", "endpoint:one");
  });
  it("uses only supported effort choices and resets effort for a basic model", async () => {
    render(<FloeModelControl workspaceId="workspace:one" endpointId="endpoint:one" onReadyChange={vi.fn()} />);
    const model = await screen.findByRole("combobox", { name: "Floe model" });
    fireEvent.change(model, { target: { value: "basic" } });
    const effort = screen.getByRole("combobox", { name: "Floe effort" }) as HTMLSelectElement;
    expect(effort.value).toBe("off"); expect(effort.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use model" }));
    await waitFor(() => expect(saveActorModel).toHaveBeenCalledWith("workspace:one", current, account, "basic", "off"));
  });
  it("does not report a collaborator ready when workspace permissions are unresolved", async () => {
    vi.mocked(loadActorModel).mockResolvedValue({ ...current, binding: { ...current.binding, status: "unresolved", unresolved_reasons: ["operation_authority_unmapped"] } });
    const ready = vi.fn();
    render(<FloeModelControl workspaceId="workspace:one" endpointId="endpoint:one" onReadyChange={ready} />);
    expect(await screen.findByText(/needs workspace permissions/)).toBeTruthy();
    expect(ready).not.toHaveBeenCalledWith(true);
  });
});

