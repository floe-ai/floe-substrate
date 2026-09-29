/**
 * @invariant Every engine built-in call is decided by the Bus before it runs.
 * The Bridge only normalizes what the engine reported (it owns the filesystem,
 * so it resolves paths) and waits for a pushed approval answer. Nothing here
 * grants authority, remembers an approval, or polls.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  CopilotPermissionRequest,
  PermissionPolicyDecision,
} from "floe-runtime/adapters/copilot";
import type {
  BusClient,
  RuntimeToolCallRequest,
  RuntimeToolRefusal,
  RuntimeToolResolution,
} from "../bus-client.js";
import { powershellEvidence } from "./powershell-evidence.js";

/** The only shell tool in the pinned manifest reports complete PowerShell text. */
const SHELL_OPERATION = "engine.tool.process.execute";

type Abandon = "cancelled" | "unavailable";

type ApprovalWaiter = {
  bus: BusClient;
  deliveryId: string;
  evaluationId: string;
  requestIds: readonly string[];
  settle: (resolution: RuntimeToolResolution | null) => void;
  chain: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
};

/** The existing path, resolved through symlinks, plus any not-yet-created tail. */
function realpathAllowingMissing(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Cannot resolve '${target}'.`);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Canonical workspace-relative path, or null when unresolved or outside the Workspace. */
export function workspaceRelativePath(workspaceLocator: string | null, reported: string): string | null {
  if (!workspaceLocator || !reported.trim()) return null;
  try {
    const root = realpathSync.native(workspaceLocator);
    const resolved = realpathAllowingMissing(path.resolve(root, reported));
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative ? relative.split(path.sep).join("/") : ".";
  } catch {
    return null;
  }
}

export function toolCallFacts(request: CopilotPermissionRequest, workspaceLocator: string | null): RuntimeToolCallRequest {
  const facts = request.facts;
  const shell = request.operationId === SHELL_OPERATION && typeof facts.fullCommandText === "string"
    ? powershellEvidence(facts.fullCommandText)
    : null;
  return {
    operation_id: request.operationId ?? "",
    tool_call_id: request.id,
    engine: request.runtime,
    manifest_version: request.manifestVersion,
    native_tools: [...request.nativeToolCandidates],
    paths: facts.paths.map((reported) => workspaceRelativePath(workspaceLocator, reported)),
    executables: shell?.executables ?? [],
    urls: [...new Set([...facts.urls, ...(shell?.urls ?? [])])],
    write_redirection: shell?.write_redirection ?? false,
    sandbox_bypass: facts.requestSandboxBypass === true,
    argument_digest: facts.argumentDigest,
  };
}

function refused(
  refusal: RuntimeToolRefusal | null,
  fallback: string,
  decision: "reject_once" | "cancel" = "reject_once",
): PermissionPolicyDecision {
  return {
    decision,
    refusal: {
      code: decision === "cancel" ? "tool_policy_cancelled" : "tool_policy_denied",
      rule_id: refusal?.rule_id ?? null,
      reason: refusal?.reason ?? fallback,
    },
  };
}

/**
 * Decides engine tool calls against the Bus and holds calls waiting for an
 * approval answer until one is pushed, the Delivery stops, or authority expires.
 */
export class EngineToolGate {
  private readonly waiters = new Set<ApprovalWaiter>();

  async decide(input: {
    bus: BusClient;
    deliveryId: string;
    workspaceLocator: string | null;
    request: CopilotPermissionRequest;
  }): Promise<PermissionPolicyDecision> {
    if (!input.request.operationId) return refused(null, "This tool is not governed by Floe.");
    const decision = await input.bus.evaluateRuntimeToolCall(
      input.deliveryId,
      toolCallFacts(input.request, input.workspaceLocator),
    );
    if (decision.decision === "allow" && !decision.refusal) return "allow_once";
    if (decision.decision !== "require_approval" || decision.approval_request_ids.length === 0) {
      return refused(decision.refusal, "Floe refused this tool call.");
    }
    const resolution = await this.waitForAnswer(input.bus, input.deliveryId, decision);
    if (resolution?.outcome === "allowed") return "allow_once";
    if (resolution?.outcome === "cancelled") return refused(resolution.refusal, "The Floe turn stopped.", "cancel");
    return refused(resolution?.refusal ?? null, "The approval for this tool call is no longer available.");
  }

  /** A pushed approval answer or invalidation for one of the waiting requests. */
  approvalChanged(approvalRequestId: string): void {
    for (const waiter of this.waiters) {
      if (waiter.requestIds.includes(approvalRequestId)) this.check(waiter, null);
    }
  }

  /** The Delivery stopped: its waiting calls are answered as cancelled. */
  abandonDelivery(deliveryId: string, reason: Abandon = "cancelled"): void {
    for (const waiter of this.waiters) {
      if (waiter.deliveryId === deliveryId) this.check(waiter, reason);
    }
  }

  private waitForAnswer(
    bus: BusClient,
    deliveryId: string,
    decision: { evaluation_id: string; approval_request_ids: string[]; approval_expires_at: string | null },
  ): Promise<RuntimeToolResolution | null> {
    return new Promise((resolve) => {
      const waiter: ApprovalWaiter = {
        bus,
        deliveryId,
        evaluationId: decision.evaluation_id,
        requestIds: decision.approval_request_ids,
        settle: resolve,
        chain: Promise.resolve(),
        timer: null,
        done: false,
      };
      this.waiters.add(waiter);
      const expiresIn = decision.approval_expires_at ? Date.parse(decision.approval_expires_at) - Date.now() : 0;
      waiter.timer = setTimeout(() => this.check(waiter, "unavailable"), Math.max(0, Math.min(expiresIn, 2 ** 31 - 1)));
      // Read the current answer once in case it arrived before this waiter existed.
      this.check(waiter, null);
    });
  }

  private check(waiter: ApprovalWaiter, abandon: Abandon | null): void {
    waiter.chain = waiter.chain.then(async () => {
      if (waiter.done) return;
      let resolution: RuntimeToolResolution | null;
      try {
        resolution = await waiter.bus.resolveRuntimeToolApproval(waiter.deliveryId, waiter.evaluationId, abandon);
      } catch (error) {
        console.error("[bridge] tool approval resolution failed", {
          delivery_id: waiter.deliveryId,
          evaluation_id: waiter.evaluationId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!abandon) return;
        resolution = null;
      }
      if (resolution?.outcome === "pending") return;
      waiter.done = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.settle(resolution);
    });
  }
}
