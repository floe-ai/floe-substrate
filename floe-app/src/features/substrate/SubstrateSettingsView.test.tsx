import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { SubstrateSettingsView } from "./SubstrateSettingsView.tsx";
import * as workspaceFs from "../../fs/workspaceFs.ts";
import * as client from "../../bus-client/client.ts";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../fs/workspaceFs.ts", () => ({
  isTauri: vi.fn(),
}));

vi.mock("../../bus-client/client.ts", () => ({
  getAuthModels: vi.fn(),
  getAuthProfiles: vi.fn(),
  getRuntimeStatus: vi.fn(),
}));

// Tauri API is not present in jsdom; mock the dynamic import path so the
// desktop branch never actually tries to invoke it during tests.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockProfiles = [
  { id: "openai-personal", provider: "openai", model: "gpt-4o" },
  { id: "anthropic-work", provider: "anthropic" },
];

describe("SubstrateSettingsView — browser mode (isTauri = false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceFs.isTauri).mockReturnValue(false);
    vi.mocked(client.getAuthProfiles).mockResolvedValue({
      profiles: mockProfiles,
      default_auth_profile: null,
    });
    vi.mocked(client.getRuntimeStatus).mockResolvedValue({
      bridge: { online: true, runtime_adapter: "pi" },
    });
    vi.mocked(client.getAuthModels).mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("renders 'Browser — read-only' in the header", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Browser — read-only/i)).toBeTruthy();
    });
  });

  it("shows profiles fetched from the bus", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText("openai-personal")).toBeTruthy();
      expect(screen.getByText("anthropic-work")).toBeTruthy();
    });
  });

  it("shows a read-only badge (no Add Profile button)", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.queryByText("+ Add Profile")).toBeNull();
      expect(screen.getByText("Read-only")).toBeTruthy();
    });
  });

  it("shows note directing user to CLI or desktop app", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      // The current native credential-broker decision is named in browser mode.
      expect(screen.getByText(/ADR-0012/)).toBeTruthy();
    });
  });

  it("fetches via bus client, never calls Tauri invoke", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(vi.mocked(client.getAuthProfiles)).toHaveBeenCalledOnce();
    });
    // Give the component time to settle, then confirm invoke was never called
    const tauriCore = await import("@tauri-apps/api/core");
    expect(vi.mocked(tauriCore.invoke)).not.toHaveBeenCalled();
  });

  it("shows empty-state message when no profiles configured", async () => {
    vi.mocked(client.getAuthProfiles).mockResolvedValue({
      profiles: [],
      default_auth_profile: null,
    });
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/No auth profiles configured/i)).toBeTruthy();
      // Multiple 'floe login' code elements are expected (empty-state + note)
      expect(screen.getAllByText(/floe login/i).length).toBeGreaterThan(0);
    });
  });

  it("shows error alert when bus fetch fails", async () => {
    vi.mocked(client.getAuthProfiles).mockRejectedValue(new Error("bus unreachable"));
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/bus unreachable/i)).toBeTruthy();
    });
  });
});

describe("SubstrateSettingsView — desktop mode (isTauri = true)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(workspaceFs.isTauri).mockReturnValue(true);
    vi.mocked(client.getRuntimeStatus).mockResolvedValue({
      bridge: { online: true, runtime_adapter: "pi" },
    });
    vi.mocked(client.getAuthModels).mockResolvedValue([
      { id: "gpt-current", name: "GPT Current", provider: "openai-codex", api: "openai-codex-responses", reasoning: true },
    ]);
    // Desktop path: Tauri invoke returns the profiles by default;
    // individual tests may override with mockImplementation.
    const tauriCore = await import("@tauri-apps/api/core");
    vi.mocked(tauriCore.invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_substrate_auth_profiles") {
        return Promise.resolve({ profiles: mockProfiles, default_auth_profile: null });
      }
      if (cmd === "get_runtime_adapter") {
        return Promise.resolve({ configured_adapter: null });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => cleanup());

  it("renders 'Desktop' in the header", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Desktop/)).toBeTruthy();
    });
  });

  it("keeps credential mutation out of the developer observatory", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText("Read-only diagnostics")).toBeTruthy();
    });
    expect(screen.queryByText("+ Add Profile")).toBeNull();
    expect(screen.queryByText(/Delete/)).toBeNull();
  });

  it("keeps normal provider sign-in outside the developer observatory", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Connect or disconnect an account from the normal Provider settings flow/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).toBeNull();
  });

  it("does NOT call the bus getAuthProfiles", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(vi.mocked(client.getAuthProfiles)).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Runtime Adapter Pillar tests
// ---------------------------------------------------------------------------

describe("SubstrateSettingsView — Runtime tab, browser mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceFs.isTauri).mockReturnValue(false);
    vi.mocked(client.getAuthProfiles).mockResolvedValue({
      profiles: [],
      default_auth_profile: null,
    });
    vi.mocked(client.getRuntimeStatus).mockResolvedValue({
      bridge: { online: true, runtime_adapter: "pi" },
    });
  });

  afterEach(() => cleanup());

  it("shows the Runtime tab in the sidebar", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      // Tab button text contains ⚙️ Runtime
      expect(screen.getByText(/⚙️ Runtime/)).toBeTruthy();
    });
  });

  it("shows Read-only badge and adapter card after clicking Runtime tab", async () => {
    render(<SubstrateSettingsView />);
    const runtimeTabBtn = screen.getByText(/⚙️ Runtime/).closest("button")!;
    fireEvent.click(runtimeTabBtn);
    await waitFor(() => {
      expect(screen.getByText("Read-only")).toBeTruthy();
    });
  });

  it("shows effective adapter badge from GET /v1/runtime/status", async () => {
    vi.mocked(client.getRuntimeStatus).mockResolvedValue({
      bridge: { online: true, runtime_adapter: "fake" },
    });
    render(<SubstrateSettingsView />);
    const runtimeTabBtn = screen.getByText(/⚙️ Runtime/).closest("button")!;
    fireEvent.click(runtimeTabBtn);
    await waitFor(() => {
      expect(screen.getByText(/Test \(fake\)/)).toBeTruthy();
    });
  });

  it("shows error alert when runtime status fetch fails", async () => {
    vi.mocked(client.getRuntimeStatus).mockRejectedValue(new Error("bus down"));
    render(<SubstrateSettingsView />);
    const runtimeTabBtn = screen.getByText(/⚙️ Runtime/).closest("button")!;
    fireEvent.click(runtimeTabBtn);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });
});

describe("SubstrateSettingsView — Runtime tab, desktop mode", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(workspaceFs.isTauri).mockReturnValue(true);
    vi.mocked(client.getRuntimeStatus).mockResolvedValue({
      bridge: { online: true, runtime_adapter: "pi" },
    });
    const tauriCore = await import("@tauri-apps/api/core");
    vi.mocked(tauriCore.invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_substrate_auth_profiles") {
        return Promise.resolve({ profiles: [], default_auth_profile: null });
      }
      if (cmd === "get_runtime_adapter") {
        return Promise.resolve({ configured_adapter: "floe-runtime" });
      }
      if (cmd === "set_runtime_adapter") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => cleanup());

  it("shows both adapter buttons in desktop mode", async () => {
    render(<SubstrateSettingsView />);
    const runtimeTabBtn = screen.getByText(/⚙️ Runtime/).closest("button")!;
    fireEvent.click(runtimeTabBtn);
    await waitFor(() => {
      // Both Test and Live buttons should appear
      expect(screen.getAllByText(/Test/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Live/).length).toBeGreaterThan(0);
    });
  });

  it("uses Pi for live operation", async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    render(<SubstrateSettingsView />);
    fireEvent.click(screen.getByText(/⚙️ Runtime/).closest("button")!);
    const liveBtn = await screen.findByRole("button", { name: /Live/ });
    fireEvent.click(liveBtn);
    await waitFor(() => {
      expect(vi.mocked(tauriCore.invoke)).toHaveBeenCalledWith("set_runtime_adapter", { adapter: "pi-agent-core" });
    });
  });

  it("calls set_runtime_adapter when user clicks Test button", async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    render(<SubstrateSettingsView />);
    const runtimeTabBtn = screen.getByText(/⚙️ Runtime/).closest("button")!;
    fireEvent.click(runtimeTabBtn);
    // Wait for the adapter buttons to render (configured_adapter loads asynchronously)
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const testBtn = buttons.find(b => b.textContent?.includes("🧪 Test"));
      if (!testBtn) throw new Error("Test button not found");
    });
    const testBtn = screen.getAllByRole("button").find(b => b.textContent?.includes("🧪 Test"))!;
    fireEvent.click(testBtn);
    await waitFor(() => {
      expect(vi.mocked(tauriCore.invoke)).toHaveBeenCalledWith("set_runtime_adapter", { adapter: "fake" });
    });
  });

  it("shows no Read-only badge in desktop mode", async () => {
    render(<SubstrateSettingsView />);
    const runtimeTabBtn = screen.getByText(/⚙️ Runtime/).closest("button")!;
    fireEvent.click(runtimeTabBtn);
    await waitFor(() => {
      expect(screen.queryByText("Read-only")).toBeNull();
    });
  });
});
