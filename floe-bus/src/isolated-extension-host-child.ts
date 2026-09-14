import process from "node:process";

import type { ExtensionPackageVersion } from "./extensions.js";
import {
  QuickJsExtensionSandbox,
  type ExtensionBrokerContext,
  type ExtensionHostBroker,
  type ExtensionHostCall,
  type JsonValue,
  type VerifiedExtensionPackage,
} from "./isolated-extension-runtime.js";

type ParentMessage =
  | Readonly<{
      type: "activate";
      request_id: string;
      package_version: ExtensionPackageVersion;
      entry_points: VerifiedExtensionPackage["entry_points"];
      limits: Readonly<{
        variant: "release" | "debug";
        memory_limit_bytes: number;
        stack_limit_bytes: number;
        execution_timeout_ms: number;
      }>;
    }>
  | Readonly<{
      type: "invoke";
      request_id: string;
      entry_point_id: string;
      request: JsonValue;
      context: ExtensionBrokerContext;
    }>
  | Readonly<{ type: "deactivate"; request_id: string }>
  | Readonly<{
      type: "broker_result";
      request_id: string;
      ok: boolean;
      result?: JsonValue;
      error?: Readonly<{ code: string; message: string }>;
    }>;

type ChildMessage =
  | Readonly<{ type: "ready"; process_protocol: 1 }>
  | Readonly<{
      type: "response";
      request_id: string;
      ok: boolean;
      result?: JsonValue;
      error?: Readonly<{ code: string; message: string }>;
    }>
  | Readonly<{
      type: "broker_call";
      request_id: string;
      call: ExtensionHostCall;
    }>;

type PendingBrokerCall = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

/** Run only inside the dedicated Extension host child process. */
export async function runIsolatedExtensionHostChild(): Promise<void> {
  if (!process.send) throw new Error("The isolated Extension host requires a private IPC channel.");
  let sandbox: QuickJsExtensionSandbox | null = null;
  const pendingBrokerCalls = new Map<string, PendingBrokerCall>();
  let sequence = 0;
  let work = Promise.resolve();

  const send = (message: ChildMessage): void => {
    process.send?.(message);
  };

  const parentCall = (call: ExtensionHostCall): Promise<JsonValue> => new Promise((resolve, reject) => {
    const requestId = `broker_${process.pid}_${++sequence}`;
    pendingBrokerCalls.set(requestId, { resolve, reject });
    send({ type: "broker_call", request_id: requestId, call });
  });

  const broker: ExtensionHostBroker = {
    invokeOperation: ({ context: _context, ...call }) => parentCall({ kind: "operation", ...call }),
    accessFilesystem: ({ context: _context, ...call }) => parentCall({ kind: "filesystem", ...call }),
    requestNetwork: ({ context: _context, ...call }) => parentCall({ kind: "network", ...call }),
  };

  const respond = (requestId: string, result: JsonValue): void => {
    send({ type: "response", request_id: requestId, ok: true, result });
  };
  const fail = (requestId: string, error: unknown): void => {
    const normalized = normalizeError(error);
    send({ type: "response", request_id: requestId, ok: false, error: normalized });
  };

  process.on("message", (raw) => {
    const message = raw as ParentMessage;
    if (message?.type === "broker_result") {
      const pending = pendingBrokerCalls.get(message.request_id);
      if (!pending) return;
      pendingBrokerCalls.delete(message.request_id);
      if (message.ok) pending.resolve(message.result ?? null);
      else pending.reject(Object.assign(new Error(message.error?.message ?? "Extension broker call failed."), {
        code: message.error?.code ?? "extension_broker_failed",
      }));
      return;
    }

    work = work.then(async () => {
      if (message?.type === "activate") {
        if (sandbox) throw new Error("An Extension package is already active in this host.");
        sandbox = new QuickJsExtensionSandbox(message.package_version, broker, { record: () => undefined }, message.limits);
        await sandbox.activate(message.entry_points);
        respond(message.request_id, {
          extension_package_version_id: message.package_version.extension_package_version_id,
          content_digest: message.package_version.content_digest,
        });
        return;
      }
      if (message?.type === "invoke") {
        if (!sandbox) throw new Error("No Extension package is active in this host.");
        respond(message.request_id, await sandbox.invoke({
          entry_point_id: message.entry_point_id,
          request: message.request,
          context: message.context,
        }));
        return;
      }
      if (message?.type === "deactivate") {
        sandbox?.dispose();
        sandbox = null;
        respond(message.request_id, { disabled: true });
        setImmediate(() => process.exit(0));
        return;
      }
      throw new Error("Unsupported isolated Extension host message.");
    }).catch((error) => {
      const requestId = typeof (message as any)?.request_id === "string" ? (message as any).request_id : "unknown";
      fail(requestId, error);
    });
  });

  process.on("disconnect", () => {
    sandbox?.dispose();
    process.exit(0);
  });
  send({ type: "ready", process_protocol: 1 });
}

function normalizeError(error: unknown): { code: string; message: string } {
  return {
    code: typeof (error as any)?.code === "string" ? (error as any).code : "extension_host_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
