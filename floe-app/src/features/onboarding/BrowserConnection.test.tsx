import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserConnection } from "./BrowserConnection.tsx";
import { BrowserAccess } from "./BrowserAccess.tsx";
const api = vi.hoisted(() => ({ startBrowserConnection: vi.fn(), claimBrowserConnection: vi.fn(), listBrowserConnections: vi.fn(), approveBrowserConnection: vi.fn() }));
vi.mock("../../bus-client/browser.ts", () => api);
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const connection = { code: "ABCD1234", origin: "http://localhost:5379", expires_at: "2026-09-04T00:05:00Z" };

describe("browser connection experience", () => {
  it("shows the matching code and keeps an unapproved browser at the connection step", async () => {
    api.startBrowserConnection.mockResolvedValue(connection);
    api.claimBrowserConnection.mockRejectedValue(new Error("Allow this connection in the Floe app first."));
    render(<BrowserConnection />);
    fireEvent.click(screen.getByRole("button", { name: "Connect this browser" }));
    expect(await screen.findByLabelText("Connection code")).toHaveProperty("textContent", "ABCD1234");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Allow this connection in the Floe app first.");
    expect(api.startBrowserConnection).toHaveBeenCalledTimes(1);
  });
  it("approves the selected workspace and reports the browser's next step", async () => {
    api.listBrowserConnections.mockResolvedValue([connection]);
    api.approveBrowserConnection.mockResolvedValue(true);
    render(<BrowserAccess workspaceId="workspace:one" workspaceName="Garden" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow workspace access" }));
    await waitFor(() => expect(api.approveBrowserConnection).toHaveBeenCalledWith("ABCD1234", "workspace:one"));
    expect(await screen.findByText("Access allowed. Select Continue in your browser.")).toBeTruthy();
    expect(api.listBrowserConnections).toHaveBeenCalledTimes(1);
  });
});
