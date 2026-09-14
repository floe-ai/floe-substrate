import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BrowserConnectionError, type BrowserConnections } from "./browser-connections.js";
import type { ProviderLoginAdapter, ProviderStatus } from "./pi-provider-login.js";

type Account = { secret_ref_id: string; generation: number; resolution: string; resource: { id: string } };
export type BrowserProviderBackend = {
  list(): Promise<Account[]>;
  connect(provider: string, login: (consume: (material: Uint8Array) => Promise<void>) => Promise<void>): Promise<Account>;
  grant(provider: string, input: { workspace_id: string; actor_id: string; expires_at: string }): Promise<{ grant_id: string; expires_at: string; revoked: boolean }>;
};
type Prompt = { id: string; accept(value: string): void };
type Connection = { owner: string; provider: string; abort: AbortController; prompt?: Prompt };

/** Local product authentication adapter. It exposes progress, never authority or credential material. */
export function registerBrowserProviderRoutes(
  app: FastifyInstance, browser: BrowserConnections, adapter: ProviderLoginAdapter, backend: BrowserProviderBackend,
): void {
  const connections = new Map<string, Connection>();
  const own = (request: FastifyRequest) => browser.localOwner(request);
  const fail = (error: unknown, reply: any) => reply.code(error instanceof BrowserConnectionError ? error.status : 409)
    .send({ error: "provider_connection_refused", message: error instanceof BrowserConnectionError ? error.message : "Provider sign-in is unavailable. Try again." });

  async function providers(): Promise<ProviderStatus[]> {
    const [catalog, accounts] = await Promise.all([adapter.list(), backend.list()]);
    return catalog.map(provider => {
      const account = accounts.find(item => item.resource.id === provider.provider);
      return { ...provider, connected: account?.resolution === "resolved", ...(account ? {
        secret_ref_id: account.secret_ref_id, credential_revision: `generation:${account.generation}:${account.resolution}`,
      } : {}) };
    });
  }

  app.get("/v1/browser/providers", async (request, reply) => {
    try { own(request); return reply.header("cache-control", "no-store").send({ providers: await providers() }); }
    catch (error) { return fail(error, reply); }
  });

  app.post("/v1/browser/providers/:provider/runtime-access", async (request, reply) => {
    try {
      own(request);
      const { provider } = z.object({ provider: z.string().min(1).max(128) }).parse(request.params);
      const input = z.object({ workspace_id: z.string().min(1), actor_id: z.string().min(1), expires_at: z.string().datetime() }).strict().parse(request.body);
      return reply.header("cache-control", "no-store").send(await backend.grant(provider, input));
    } catch (error) { return fail(error, reply); }
  });

  app.post("/v1/browser/providers/:provider/connect", async (request, reply) => {
    let owner: string;
    let provider: ProviderStatus;
    try {
      owner = own(request);
      const params = z.object({ provider: z.string().min(1).max(128) }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      const found = (await providers()).find(item => item.provider === params.provider);
      if (!found) throw new BrowserConnectionError(404, "This subscription provider is unavailable.");
      provider = found;
      if (provider.connected) return reply.send(provider);
      if (connections.size >= 4 || [...connections.values()].some(item => item.provider === provider.provider)) {
        throw new BrowserConnectionError(409, "A provider sign-in is already in progress. Complete or cancel it first.");
      }
    } catch (error) { return fail(error, reply); }
    const id = randomUUID();
    const connection: Connection = { owner, provider: provider.provider, abort: new AbortController() };
    connections.set(id, connection);
    const timeout = setTimeout(() => connection.abort.abort(), 600_000);
    let messages = 0;
    const emit = (event: object) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      if (++messages > 128) { connection.abort.abort(); return; }
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    const cancel = () => connection.abort.abort();
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    reply.raw.on("close", cancel);
    emit({ type: "connection", connection_id: id });
    function prompt(value: AuthPrompt): Promise<string> {
      if (value.type === "secret") return Promise.reject(new Error("Enter credentials on the provider page."));
      return new Promise((resolve, reject) => {
        const promptId = randomUUID();
        const cleanup = () => {
          value.signal?.removeEventListener("abort", aborted);
          connection.abort.signal.removeEventListener("abort", aborted);
          if (connection.prompt?.id === promptId) delete connection.prompt;
        };
        const aborted = () => { cleanup(); reject(new Error("Provider prompt ended")); };
        connection.prompt = { id: promptId, accept: answer => {
          if (value.type === "select" && !value.options.some(option => option.id === answer)) throw new BrowserConnectionError(400, "Choose one of the listed options.");
          cleanup(); resolve(answer);
        } };
        if (value.signal?.aborted || connection.abort.signal.aborted) return aborted();
        value.signal?.addEventListener("abort", aborted, { once: true });
        connection.abort.signal.addEventListener("abort", aborted, { once: true });
        emit({ type: "prompt", connection_id: id, prompt_id: promptId, kind: value.type, message: value.message,
          ...(value.type === "select" ? { options: value.options } : { placeholder: value.placeholder }) });
      });
    }
    try {
      const account = await backend.connect(provider.provider, consume => adapter.login(provider.provider, {
        signal: connection.abort.signal, prompt,
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") emit({ type: event.type, url: event.url, instructions: event.instructions });
          else if (event.type === "device_code") emit({ type: event.type, userCode: event.userCode, verificationUri: event.verificationUri });
          else emit({ type: event.type, message: event.message });
        },
      }, async material => { connection.abort.signal.throwIfAborted(); await consume(material); }));
      emit({ ...provider, connected: true, secret_ref_id: account.secret_ref_id, credential_revision: `generation:${account.generation}:${account.resolution}` });
    } catch {
      // Provider exceptions may contain sensitive response data. Never forward them.
      emit({ type: "error", message: "Sign-in did not complete. Try again when you are ready." });
    } finally {
      clearTimeout(timeout);
      cancel();
      connections.delete(id);
      reply.raw.off("close", cancel);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.post("/v1/browser/provider-connections/:id/answer", async (request, reply) => {
    try {
      const owner = own(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ prompt_id: z.string().uuid(), value: z.string().max(16_384) }).strict().parse(request.body);
      const connection = connections.get(id);
      if (!connection || connection.owner !== owner || connection.prompt?.id !== body.prompt_id) throw new BrowserConnectionError(404, "This sign-in step has ended.");
      connection.prompt.accept(body.value);
      return { accepted: true };
    } catch (error) { return fail(error, reply); }
  });

  app.addHook("preClose", async () => { for (const item of connections.values()) item.abort.abort(); });
}
