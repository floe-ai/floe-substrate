import { Channel } from "@tauri-apps/api/core";
import {
  confirmAndInvokeHostOperation,
  listHostOperations,
  invokeHostOperation,
} from "../bus-client/client.ts";
import { isTauri } from "../fs/workspaceFs.ts";
import { browserRequest } from "../bus-client/browser.ts";
import { busFetch } from "../bus-client/transport.ts";

export type ModelProviderModel = {
  id: string;
  name: string;
  is_default: boolean;
  reasoning_efforts: string[];
};

export type ModelProviderStatus = {
  type: "provider_status";
  provider: string;
  name: string;
  auth_name: string;
  connected: boolean;
  profile_id: string;
  models: ModelProviderModel[];
  secret_ref_id?: string;
  credential_revision?: string;
};

export type ModelProviderAuthEvent =
  | { type: "info" | "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "prompt"; connection_id: string; prompt_id: string; kind: "text" | "select" | "manual_code"; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> };

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("Provider setup is available in the Floe desktop app");
  const { invoke: invokeTauri } = await import("@tauri-apps/api/core");
  return invokeTauri<T>(command, args);
}

export function getModelProviders(): Promise<ModelProviderStatus[]> {
  return isTauri() ? invoke("get_model_providers") : browserRequest<{ providers: ModelProviderStatus[] }>("/v1/browser/providers").then(result => result.providers);
}

export async function grantProviderRuntimeAccess(status: ModelProviderStatus, workspaceId: string, actorId: string): Promise<string> {
  if (!status.connected || !status.secret_ref_id || !status.credential_revision) throw new Error("Connect this provider account first.");
  // Local product policy: ninety days, rounded to the day so repeated choices reuse valid access.
  const input = { workspace_id: workspaceId, actor_id: actorId, expires_at: new Date(Math.floor(Date.now() / 86400000) * 86400000 + 90 * 86400000).toISOString() };
  if (!isTauri()) {
    const response = await busFetch(`/v1/browser/providers/${encodeURIComponent(status.provider)}/runtime-access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json() as { grant_id: string; message?: string };
    if (!response.ok) throw new Error(result.message ?? "Floe could not authorize this model account.");
    return result.grant_id;
  }
  const target = { kind: "secret_ref", id: status.secret_ref_id };
  const descriptor = (await listHostOperations("credential.runtime-access.grant", target)).find(item => item.operation_id === "credential.runtime-access.grant");
  if (!descriptor) throw new Error("This Floe installation cannot authorize model access yet.");
  if (!descriptor.availability.available) throw new Error(descriptor.availability.refusal.message);
  const receipt = await invokeHostOperation({ operation_id: descriptor.operation_id, operation_version: descriptor.operation_version, input_schema_version: descriptor.input.version, target, expected_resource_revision: status.credential_revision, input, idempotency_key: `provider-access:${crypto.randomUUID()}` });
  if (receipt.refusal) throw new Error(receipt.refusal.message);
  if (receipt.state !== "completed" || !receipt.result) throw new Error("Floe could not confirm model account access.");
  return (receipt.result as { grant_id: string }).grant_id;
}

export function connectModelProvider(
  provider: string,
  onEvent: (event: ModelProviderAuthEvent) => void,
  signal?: AbortSignal,
): Promise<ModelProviderStatus> {
  if (!isTauri()) return connectBrowserProvider(provider, onEvent, signal);
  const channel = new Channel<ModelProviderAuthEvent>();
  channel.onmessage = onEvent;
  return invoke("connect_model_provider", { provider, onEvent: channel });
}

async function connectBrowserProvider(provider: string, onEvent: (event: ModelProviderAuthEvent) => void, signal?: AbortSignal): Promise<ModelProviderStatus> {
  const response = await busFetch(`/v1/browser/providers/${encodeURIComponent(provider)}/connect`, { method: "POST", signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? "Provider sign-in is unavailable.");
  }
  if (!response.headers.get("content-type")?.includes("ndjson")) return response.json() as Promise<ModelProviderStatus>;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Floe could not start provider sign-in.");
  const decoder = new TextDecoder();
  let pending = "";
  let status: ModelProviderStatus | null = null;
  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 1_048_576) throw new Error("Floe received an invalid sign-in response.");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "provider_status") status = event as ModelProviderStatus;
        else if (event.type === "error") throw new Error(event.message);
        else if (event.type !== "connection") onEvent(event as ModelProviderAuthEvent);
      }
      if (chunk.done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!status?.connected) throw new Error("Provider sign-in ended before the account was connected.");
  return status;
}

export async function answerProviderPrompt(prompt: Extract<ModelProviderAuthEvent, { type: "prompt" }>, value: string): Promise<void> {
  const response = await busFetch(`/v1/browser/provider-connections/${encodeURIComponent(prompt.connection_id)}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_id: prompt.prompt_id, value }),
  });
  if (!response.ok) throw new Error("This sign-in step has ended. Complete sign-in on the provider page or start again.");
}

export async function disconnectModelProvider(
  status: ModelProviderStatus,
): Promise<{ confirmed: boolean; status: ModelProviderStatus }> {
  if (!status.connected || !status.secret_ref_id || !status.credential_revision) {
    throw new Error("Refresh provider accounts before disconnecting this account.");
  }
  const target = { kind: "secret_ref", id: status.secret_ref_id };
  const operation = (await listHostOperations("disconnect credential", target))
    .find(candidate => candidate.operation_id === "credential.revoke");
  if (!operation) {
    throw new Error("This Floe installation cannot disconnect provider accounts yet.");
  }
  if (!operation.availability.available) {
    throw new Error(operation.availability.refusal.message);
  }
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const result = await confirmAndInvokeHostOperation({
    operation_id: operation.operation_id,
    operation_version: operation.operation_version,
    input_schema_version: operation.input.version,
    target,
    expected_resource_revision: status.credential_revision,
    idempotency_key: `provider-disconnect:${suffix}`,
    input: {},
  });
  if (!result.confirmed) return { confirmed: false, status };
  if (result.receipt.refusal) throw new Error(result.receipt.refusal.message);
  const credential = (result.receipt.result as {
    credential?: { generation?: unknown; resolution?: unknown };
  } | null)?.credential;
  if (
    typeof credential?.generation !== "number"
    || credential.resolution !== "unresolved"
  ) {
    throw new Error("Floe disconnected the account but did not return its current status.");
  }
  return {
    confirmed: true,
    status: {
      ...status,
      connected: false,
      credential_revision: `generation:${credential.generation}:unresolved`,
    },
  };
}

export function preferredModel(status: ModelProviderStatus): string {
  return status.models.find(model => model.is_default)?.id ?? status.models[0]?.id ?? "";
}
