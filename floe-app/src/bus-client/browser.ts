import type { AuthProfileRecord, RuntimeBindingRecord, RuntimeStatus, WorkspaceRef } from "./types.ts";
import { busFetch } from "./transport.ts";
import { FloeHttpError } from "../runtime/startup.ts";

export type BrowserConnection = { code: string; origin: string; expires_at: string };
export type BrowserSession = {
  mode: "local" | "remote";
  workspaces: WorkspaceRef[];
  profiles: AuthProfileRecord[];
  bindings: RuntimeBindingRecord[];
  runtime: RuntimeStatus;
  expires_at: string | null;
};

export async function browserRequest<T>(path: string, method = "GET", signal?: AbortSignal): Promise<T> {
  const response = await busFetch(path, { method, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    const error = new FloeHttpError(response.status, path);
    if (body?.message) error.message = body.message;
    throw error;
  }
  return response.json() as Promise<T>;
}

export const getBrowserSession = (signal?: AbortSignal, workspaceId?: string) => browserRequest<BrowserSession>(`/v1/browser/session${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`, "GET", signal);
let localConnection = false;
export const isLocalBrowserConnection = () => localConnection;
export async function connectLocalBrowser(signal?: AbortSignal): Promise<boolean> {
  try {
    await browserRequest("/v1/browser/session/local", "POST", signal);
    localConnection = true;
    return true;
  } catch (error) {
    if (error instanceof FloeHttpError && error.status === 403) { localConnection = false; return false; }
    throw error;
  }
}
export const startBrowserConnection = () => browserRequest<BrowserConnection>("/v1/browser/connections", "POST");
export const claimBrowserConnection = () => browserRequest("/v1/browser/connections/claim", "POST");
export const disconnectBrowser = () => browserRequest("/v1/browser/session", "DELETE");

export async function listBrowserConnections(): Promise<BrowserConnection[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<{ status: number; body: string }>("list_browser_connections");
  if (response.status !== 200) throw new FloeHttpError(response.status, "/v1/local/browser-connections");
  return (JSON.parse(response.body) as { connections: BrowserConnection[] }).connections;
}

export async function approveBrowserConnection(code: string, workspaceId: string): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<{ confirmed: boolean; response?: { status: number; body: string } }>("approve_browser_connection", { code, workspaceId });
  if (response.response && response.response.status !== 200) throw new Error("The connection could not be approved. Refresh Browser access and try again.");
  return response.confirmed;
}
