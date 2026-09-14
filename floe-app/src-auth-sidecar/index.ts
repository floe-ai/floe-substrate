import { spawn } from "node:child_process";
import { request } from "node:http";
import {
  getSupportedThinkingLevels,
  type AuthEvent,
  type AuthPrompt,
  type Model,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { EphemeralCredentialStore } from "../../floe-bus/src/pi-provider-login.ts";
export { EphemeralCredentialStore } from "../../floe-bus/src/pi-provider-login.ts";

const BUS_HOST = "127.0.0.1";
const BUS_PORT = 5377;
const MAX_INGRESS_TOKEN_BYTES = 4096;

type ProviderModel = {
  id: string;
  name: string;
  is_default: boolean;
  reasoning_efforts: string[];
};

export type ProviderStatus = {
  type: "provider_status";
  provider: string;
  name: string;
  auth_name: string;
  connected: boolean;
  profile_id: string;
  models: ProviderModel[];
};

type HelperEvent = AuthEvent | { type: "provider_statuses"; providers: ProviderStatus[] } | ProviderStatus;

function emit(message: HelperEvent): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function displayName(providerId: string, fallback: string): string {
  if (providerId === "openai-codex") return "ChatGPT";
  if (providerId === "anthropic") return "Claude";
  if (providerId === "kimi-coding") return "Kimi";
  if (providerId === "xai") return "Grok";
  return fallback;
}

async function statuses(): Promise<ProviderStatus[]> {
  const storage = new EphemeralCredentialStore();
  const models = builtinModels({ credentials: storage });
  try {
    return models.getProviders()
      .filter(provider => provider.auth.oauth?.isSubscription === true)
      .map(provider => ({
        type: "provider_status" as const,
        provider: provider.id,
        name: displayName(provider.id, provider.name),
        auth_name: provider.auth.oauth?.name ?? provider.name,
        connected: false,
        profile_id: `${provider.id}-subscription`,
        models: provider.getModels().map((model, index) => modelStatus(model, undefined, index)),
      }));
  } finally {
    storage.clear();
  }
}

function modelStatus(model: Model<any>, selected: string | undefined, index: number): ProviderModel {
  return {
    id: model.id,
    name: model.name,
    is_default: selected ? model.id === selected : index === 0,
    reasoning_efforts: getSupportedThinkingLevels(model).filter(level => level !== "off"),
  };
}

async function login(
  providerId: string,
  ingressSessionId: string,
  audience: string,
  purpose: string,
): Promise<ProviderStatus> {
  if (audience !== `provider-auth:${providerId}`) throw new Error("The provider sign-in audience is invalid");
  if (purpose !== "account-connection") throw new Error("The provider sign-in purpose is invalid");
  const ingressToken = await readIngressToken();
  const storage = new EphemeralCredentialStore();
  const models = builtinModels({ credentials: storage });
  const provider = models.getProviders()
    .find(item => item.id === providerId && item.auth.oauth?.isSubscription === true);
  if (!provider) throw new Error(`Unsupported subscription provider: ${providerId}`);

  try {
    await models.login(providerId, "oauth", {
      notify: event => {
        emit(event);
        if (event.type === "auth_url") openExternal(event.url);
        if (event.type === "device_code") openExternal(event.verificationUri);
      },
      prompt: prompt => answerDesktopPrompt(prompt),
    });

    const available = await models.getAvailable(providerId);
    const fallbackModels = available.length > 0 ? available : provider.getModels();
    const credential = await storage.read(providerId);
    if (!credential) throw new Error("Provider sign-in completed without a credential");
    const material = Buffer.from(JSON.stringify(credential), "utf8");
    try {
      await uploadCredential({
        ingressSessionId,
        ingressToken,
        audience,
        purpose,
        material,
      });
    } finally {
      material.fill(0);
    }
    return {
      type: "provider_status",
      provider: provider.id,
      name: displayName(provider.id, provider.name),
      auth_name: provider.auth.oauth?.name ?? provider.name,
      connected: true,
      profile_id: `${provider.id}-subscription`,
      models: fallbackModels.map((model, index) => modelStatus(model, undefined, index)),
    };
  } finally {
    storage.clear();
  }
}

async function readIngressToken(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INGRESS_TOKEN_BYTES) throw new Error("The provider sign-in session is invalid");
    chunks.push(buffer);
    if (buffer.includes(0x0a)) break;
  }
  const combined = Buffer.concat(chunks);
  try {
    const newline = combined.indexOf(0x0a);
    const token = combined.subarray(0, newline >= 0 ? newline : combined.byteLength).toString("utf8").trim();
    if (token.length < 32) throw new Error("The provider sign-in session is invalid");
    return token;
  } finally {
    combined.fill(0);
    chunks.forEach(chunk => chunk.fill(0));
  }
}

async function uploadCredential(input: Readonly<{
  ingressSessionId: string;
  ingressToken: string;
  audience: string;
  purpose: string;
  material: Buffer;
}>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upload = request({
      hostname: BUS_HOST,
      port: BUS_PORT,
      method: "PUT",
      path: `/v1/credential-ingress-sessions/${encodeURIComponent(input.ingressSessionId)}/material`,
      headers: {
        authorization: `Bearer ${input.ingressToken}`,
        "content-type": "application/octet-stream",
        "content-length": input.material.byteLength,
        "x-floe-credential-ingress-audience": input.audience,
        "x-floe-credential-ingress-purpose": input.purpose,
      },
    }, response => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error("Floe refused the protected provider credential transfer"));
      });
    });
    upload.setTimeout(15_000, () => upload.destroy(new Error("The protected provider credential transfer timed out")));
    upload.once("error", () => reject(new Error("Floe could not complete the protected provider credential transfer")));
    upload.end(input.material);
  });
}

async function answerDesktopPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") return prompt.options[0]?.id ?? "";
  if (prompt.type === "text") return "";
  if (prompt.type === "secret") throw new Error("This provider flow supports subscriptions only");
  return new Promise<string>((_resolve, reject) => {
    const signal = prompt.signal;
    const abort = () => reject(signal?.reason ?? new Error("Browser sign-in completed"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function openExternal(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function runAuthHelper(args: string[]): Promise<void> {
  const [command, providerId, ingressSessionId, audience, purpose] = args;
  if (command === "providers") {
    emit({ type: "provider_statuses", providers: await statuses() });
    return;
  }
  if (command === "login" && providerId && ingressSessionId && audience && purpose) {
    emit(await login(providerId, ingressSessionId, audience, purpose));
    return;
  }
  throw new Error("Usage: floe-desktop auth <providers|login PROVIDER INGRESS_SESSION AUDIENCE PURPOSE>");
}
