const BUS_BASE = import.meta.env.VITE_FLOE_BUS_BASE ?? "http://127.0.0.1:5377";

type NativeBusResponse = {
  status: number;
  contentType?: string | null;
  body: string;
};

type NativeMediaResponse = {
  mediaType: string;
  dataBase64: string;
};

type NativeArtefactContentResponse = NativeMediaResponse & {
  etag: string;
  artefactVersionId: string;
};

export type ArtefactVersionContent = {
  mediaType: string;
  data: Blob;
  etag: string;
  artefactVersionId: string;
};

type NativeConfirmedOperationResponse = {
  confirmed: boolean;
  response?: NativeBusResponse | null;
};

export type TrustedOperationResult = {
  confirmed: boolean;
  response?: Response;
};

export function isNativeFloeApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Static, unauthenticated sandbox host; exact content uses the normal broker. */
export function htmlPreviewHostUrl(): string {
  return `${isNativeFloeApp() ? BUS_BASE : ""}/v1/previews/html`;
}

/**
 * Workspace-authenticated Bus transport. The native host injects credentials;
 * neither the request nor the response contains bearer material.
 */
export async function busFetch(
  path: string,
  init: RequestInit = {},
  workspaceId?: string,
): Promise<Response> {
  if (!isNativeFloeApp()) {
    return fetch(path, { ...init, credentials: "same-origin" });
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const body = parseJsonBody(init.body);
  const response = await invoke<NativeBusResponse>("bus_request", {
    request: {
      path,
      method: init.method ?? "GET",
      body,
      workspaceId: workspaceId ?? workspaceFromPath(path) ?? workspaceFromBody(body),
    },
  });
  return responseFromNative(response);
}

/** One fixed projection needed before the operator can select a Workspace. */
export async function localWorkspaceBindingsFetch(
  browserFallback: { path: string; init?: RequestInit } = { path: "/v1/local/workspaces" },
): Promise<Response> {
  if (!isNativeFloeApp()) {
    return busFetch("/v1/browser/session", browserFallback.init);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<NativeBusResponse>("list_local_workspace_bindings");
  return responseFromNative(response);
}

/** Fixed host health projection. The webview cannot choose a host route. */
export async function localRuntimeStatusFetch(): Promise<Response> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<NativeBusResponse>("get_local_runtime_status");
  return responseFromNative(response);
}

/** Discover Bus-owned host operations without copying their definitions into Tauri. */
export async function discoverHostOperations(
  query?: string,
  target?: { kind: string; id: string },
): Promise<Response> {
  if (!isNativeFloeApp()) {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (target) {
      params.set("target_kind", target.kind);
      params.set("target_id", target.id);
    }
    const encoded = params.toString();
    const suffix = encoded ? `?${encoded}` : "";
    return busFetch(`/v1/browser/host/operations${suffix}`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<NativeBusResponse>("discover_host_operations", {
    query,
    targetKind: target?.kind,
    targetId: target?.id,
  });
  return responseFromNative(response);
}

/** Invoke one descriptor obtained from discoverHostOperations. */
export async function invokeHostOperation(request: unknown): Promise<Response> {
  if (!isNativeFloeApp()) {
    return busFetch("/v1/browser/host/operations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<NativeBusResponse>("invoke_host_operation", { request });
  return responseFromNative(response);
}

/** Use the native prompt described by a host-bound operation, then invoke it unchanged. */
export async function confirmAndInvokeHostOperation(
  request: unknown,
): Promise<TrustedOperationResult> {
  if (!isNativeFloeApp()) {
    throw new Error("Trusted confirmation is available only in the installed Floe app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeConfirmedOperationResponse>(
    "confirm_and_invoke_host_operation",
    { request },
  );
  return {
    confirmed: result.confirmed,
    response: result.response ? responseFromNative(result.response) : undefined,
  };
}

/**
 * Ask the trusted desktop shell to show the Bus-owned prompt and, only after
 * native operator acceptance, atomically invoke the unchanged operation.
 */
export async function confirmAndInvokeOperation(
  workspaceId: string,
  request: unknown,
): Promise<TrustedOperationResult> {
  if (!isNativeFloeApp()) {
    throw new Error("Trusted confirmation is available only in the installed Floe app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeConfirmedOperationResponse>("confirm_and_invoke_operation", {
    workspaceId,
    request,
  });
  return {
    confirmed: result.confirmed,
    response: result.response ? responseFromNative(result.response) : undefined,
  };
}

/** Fetch authenticated image bytes and expose only a revocable object URL. */
export async function workspaceMediaObjectUrl(workspaceId: string, relPath: string): Promise<string> {
  let blob: Blob;
  if (isNativeFloeApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const media = await invoke<NativeMediaResponse>("read_bus_media", { workspaceId, relPath });
    blob = new Blob([decodeBase64(media.dataBase64).buffer as ArrayBuffer], { type: media.mediaType });
  } else {
    const response = await busFetch(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/media?path=${encodeURIComponent(relPath)}`,
      {},
      workspaceId,
    );
    if (!response.ok) throw new Error(`Bus GET workspace media → ${response.status}`);
    blob = await response.blob();
  }
  return URL.createObjectURL(blob);
}

/**
 * Fetch content by immutable ArtefactVersion identity. The native broker owns
 * the Workspace session and the Bus refuses mutable bytes that no longer match
 * the recorded digest. No filesystem path or bearer reaches the component.
 */
export async function readArtefactVersionContent(
  workspaceId: string,
  artefactVersionId: string,
): Promise<ArtefactVersionContent> {
  let mediaType: string;
  let data: Blob;
  let etag: string;
  let returnedVersionId: string;
  if (isNativeFloeApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const content = await invoke<NativeArtefactContentResponse>("read_artefact_version_content", {
      workspaceId,
      artefactVersionId,
    });
    mediaType = content.mediaType;
    data = new Blob([decodeBase64(content.dataBase64).buffer as ArrayBuffer], { type: mediaType });
    etag = content.etag;
    returnedVersionId = content.artefactVersionId;
  } else {
    const response = await busFetch(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artefact-versions/${encodeURIComponent(artefactVersionId)}/content`,
      {},
      workspaceId,
    );
    if (!response.ok) {
      const reason = await safeErrorMessage(response);
      throw new Error(reason ?? `Bus GET exact ArtefactVersion content → ${response.status}`);
    }
    mediaType = response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream";
    data = await response.blob();
    etag = response.headers.get("etag") ?? "";
    returnedVersionId = response.headers.get("x-floe-artefact-version-id") ?? "";
  }
  if (returnedVersionId !== artefactVersionId || !/^"sha256:[a-f0-9]{64}"$/i.test(etag)) {
    throw new Error("Floe returned content without exact ArtefactVersion evidence.");
  }
  return { mediaType, data, etag, artefactVersionId: returnedVersionId };
}

function responseFromNative(response: NativeBusResponse): Response {
  const headers = new Headers();
  if (response.contentType) headers.set("content-type", response.contentType);
  return new Response(response.body, { status: response.status, headers });
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body !== "string") {
    throw new Error("The native Floe Bus accepts JSON request bodies only.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("The native Floe Bus received an invalid JSON request body.");
  }
}

function workspaceFromPath(path: string): string | undefined {
  const match = /^\/v1\/workspaces\/([^/?]+)/.exec(path);
  if (match && match[1] !== "register") {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      return undefined;
    }
  }
  try {
    return new URL(path, BUS_BASE).searchParams.get("workspace_id") ?? undefined;
  } catch {
    return undefined;
  }
}

function workspaceFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const workspaceId = (body as Record<string, unknown>)["workspace_id"];
  return typeof workspaceId === "string" && workspaceId ? workspaceId : undefined;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function safeErrorMessage(response: Response): Promise<string | null> {
  try {
    const value = await response.clone().json() as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const message = (value as Record<string, unknown>)["message"];
      return typeof message === "string" && message ? message : null;
    }
  } catch {
    // Non-JSON error bodies use the status-only fallback.
  }
  return null;
}
