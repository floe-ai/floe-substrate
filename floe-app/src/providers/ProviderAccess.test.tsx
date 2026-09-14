import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAccess } from "./ProviderAccess.tsx";
import type { ModelProviderStatus } from "./modelProviders.ts";
import * as provider from "./modelProviders.ts";

const platform = vi.hoisted(() => ({ isTauri: vi.fn(() => false) }));
vi.mock("../fs/workspaceFs.ts", () => platform);

vi.mock("./modelProviders.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./modelProviders.ts")>();
  return {
    ...actual,
    getModelProviders: vi.fn(),
    connectModelProvider: vi.fn(),
    disconnectModelProvider: vi.fn(),
    answerProviderPrompt: vi.fn(),
  };
});

const chatgpt: ModelProviderStatus = {
  type: "provider_status",
  provider: "openai-codex",
  name: "ChatGPT",
  auth_name: "OpenAI (ChatGPT Plus/Pro)",
  connected: false,
  profile_id: "openai-codex-subscription",
  models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", is_default: true, reasoning_efforts: ["high"] },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", is_default: false, reasoning_efforts: ["high"] },
  ],
};

const copilot: ModelProviderStatus = {
  type: "provider_status",
  provider: "github-copilot",
  name: "GitHub Copilot",
  auth_name: "GitHub Copilot",
  connected: true,
  profile_id: "github-copilot-subscription",
  secret_ref_id: "secretref:copilot",
  credential_revision: "generation:1:resolved",
  models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", is_default: true, reasoning_efforts: ["high"] }],
};

describe("ProviderAccess", () => {
  beforeEach(() => { vi.clearAllMocks(); platform.isTauri.mockReturnValue(false); });
  afterEach(cleanup);

  it("presents multiple subscription providers without profile ids or API keys", () => {
    render(<ProviderAccess initialProviders={[chatgpt, copilot]} />);
    const providerSelect = screen.getByRole("combobox", { name: "Subscription provider" });
    expect(providerSelect.textContent).toContain("ChatGPT");
    expect(providerSelect.textContent).toContain("GitHub Copilot · connected");
    expect(screen.queryByText(/profile id|api key|auth token/i)).toBeNull();
  });

  it("authenticates the selected provider through the account adapter", async () => {
    const connected = { ...chatgpt, connected: true };
    vi.mocked(provider.connectModelProvider).mockResolvedValue(connected);
    const onReady = vi.fn();
    render(<ProviderAccess initialProviders={[chatgpt]} onReady={onReady} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provider default model" }), {
      target: { value: "gpt-5.6-terra" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => {
      expect(provider.connectModelProvider).toHaveBeenCalledWith("openai-codex", expect.any(Function), expect.any(AbortSignal));
      expect(onReady).toHaveBeenCalledWith(connected, "gpt-5.6-terra");
    });
  });

  it("shows a provider device code while subscription login is pending", async () => {
    vi.mocked(provider.connectModelProvider).mockImplementation(async (_provider, onEvent) => {
      onEvent({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      return new Promise(() => {});
    });
    render(<ProviderAccess initialProviders={[chatgpt]} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(await screen.findByText(/ABCD-1234/)).toBeTruthy();
  });

  it("treats connected accounts as status when adding another provider", () => {
    render(<ProviderAccess initialProviders={[copilot, chatgpt]} purpose="add" />);

    const providerSelect = screen.getByRole("combobox", { name: "Subscription provider" }) as HTMLSelectElement;
    expect(providerSelect.value).toBe("openai-codex");
    expect(screen.queryByRole("combobox", { name: "Provider default model" })).toBeNull();

    fireEvent.change(providerSelect, { target: { value: "github-copilot" } });
    expect((screen.getByRole("button", { name: "Connected" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the provider link and pending question visible during progress and clears the answered question", async () => {
    const prompt = { type: "prompt" as const, kind: "manual_code" as const, connection_id: "login:one", prompt_id: "prompt:one", message: "Paste the sign-in code" };
    vi.mocked(provider.connectModelProvider).mockImplementation(async (_provider, onEvent) => {
      onEvent({ type: "auth_url", url: "https://example.com/authorize" });
      onEvent(prompt);
      onEvent({ type: "progress", message: "Waiting for sign-in" });
      return new Promise(() => {});
    });
    vi.mocked(provider.answerProviderPrompt).mockResolvedValue(undefined);
    render(<ProviderAccess initialProviders={[chatgpt]} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect((await screen.findByRole("link", { name: "Open ChatGPT sign-in" })).getAttribute("href")).toBe("https://example.com/authorize");
    fireEvent.change(screen.getByRole("textbox", { name: "Sign-in answer" }), { target: { value: "one-time-answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue sign-in" }));
    await waitFor(() => expect(provider.answerProviderPrompt).toHaveBeenCalledWith(prompt, "one-time-answer"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Sign-in answer" })).toBeNull());
  });

  it("cancels browser sign-in and permits another attempt without an error", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(provider.connectModelProvider).mockImplementation(async (_provider, _onEvent, suppliedSignal) => {
      signal = suppliedSignal;
      return new Promise((_resolve, reject) => suppliedSignal!.addEventListener("abort", () => reject(new Error("Cancelled"))));
    });
    render(<ProviderAccess initialProviders={[chatgpt]} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: "Continue with ChatGPT" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disconnects a connected account only after the native confirmation succeeds", async () => {
    platform.isTauri.mockReturnValue(true);
    vi.mocked(provider.disconnectModelProvider).mockResolvedValue({
      confirmed: true,
      status: {
        ...copilot,
        connected: false,
        credential_revision: "generation:2:unresolved",
      },
    });
    render(<ProviderAccess initialProviders={[copilot]} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(provider.disconnectModelProvider).toHaveBeenCalledWith(copilot);
      expect(screen.getByRole("button", { name: "Continue with GitHub Copilot" })).toBeTruthy();
      expect(screen.getByText("GitHub Copilot was disconnected.")).toBeTruthy();
    });
  });

  it("keeps the account connected when the operator cancels the native prompt", async () => {
    platform.isTauri.mockReturnValue(true);
    vi.mocked(provider.disconnectModelProvider).mockResolvedValue({ confirmed: false, status: copilot });
    render(<ProviderAccess initialProviders={[copilot]} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(provider.disconnectModelProvider).toHaveBeenCalledWith(copilot));
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});
