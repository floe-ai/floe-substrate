import { describe, expect, it } from "vitest";

import { CliRequestError } from "./cli-error.js";
import { formatOperationList, invocationFailure, parseJsonIntent, parseTarget } from "./operations-command.js";
import type { CliOperationDescriptor } from "./operation-client.js";

const operation: CliOperationDescriptor = {
  operation_id: "scope.execution.stop",
  operation_version: "1",
  category: "scope",
  title: "Stop Scope execution",
  description: "Stop active work while preserving evidence.",
  effects: { mode: "write" },
  target: { resource_kinds: ["scope_execution"], expected_revision: "required" },
  input: { version: "1", schema: { type: "object" } },
  result: { version: "1", schema: { type: "object" } },
  interaction_constraints: { allowed_modes: ["interactive"] },
  availability: { available: true },
};

describe("operations command input", () => {
  it("accepts inline JSON and @file JSON without interpreting the operation schema", () => {
    expect(parseJsonIntent('{"reason":"operator request"}')).toEqual({ reason: "operator request" });
    expect(parseJsonIntent("@intent.json", (path) => {
      expect(path).toBe("intent.json");
      return '{"attempt":2}';
    })).toEqual({ attempt: 2 });
  });

  it("rejects malformed JSON before transport", () => {
    expect(() => parseJsonIntent("not-json")).toThrow("Operation input is not valid JSON");
    expect(() => parseJsonIntent("@empty.json", () => " ")).toThrow("must contain JSON intent");
    expect(() => parseJsonIntent("@missing.json", () => { throw new Error("ENOENT"); }))
      .toThrow("Operation input file 'missing.json' could not be read.");
    expect(() => parseJsonIntent("not-json")).toThrow(CliRequestError);
  });

  it("requires a complete target identity", () => {
    expect(parseTarget({ targetKind: "scope_execution", targetId: "execution:one" }))
      .toEqual({ kind: "scope_execution", id: "execution:one" });
    expect(parseTarget({})).toBeNull();
    expect(() => parseTarget({ targetKind: "scope_execution" }))
      .toThrow("must be supplied together");
  });

  it("fails the command for a refused or unsettled invocation, never for a completed one", () => {
    expect(invocationFailure({ kind: "receipt", receipt: { state: "completed" } })).toBeNull();
    expect(invocationFailure({ kind: "receipt", receipt: { state: "accepted" } })).toBeNull();
    expect(invocationFailure({ kind: "cancelled" })).toBeNull();
    expect(invocationFailure({ kind: "receipt", receipt: { state: "refused",
      refusal: { message: "The operation input does not match its discovered schema." } } }))
      .toBe("Floe refused the operation. The operation input does not match its discovered schema.");
    expect(invocationFailure({ kind: "rejected", refusal: { message: "A write needs a key." } }))
      .toBe("Floe refused the operation. A write needs a key.");
    expect(invocationFailure({ kind: "receipt", receipt: { state: "outcome_unknown" } }))
      .toBe("Floe could not confirm the operation's outcome.");
  });
});

describe("operations command display", () => {
  it("shows the canonical operation id, category, effect, availability, and title", () => {
    expect(formatOperationList([operation])).toBe(
      "scope.execution.stop | scope | write | available\n  Stop Scope execution",
    );
  });

  it("shows the Bus refusal instead of inventing a CLI availability state", () => {
    expect(formatOperationList([{
      ...operation,
      availability: {
        available: false,
        refusal: { message: "No active execution exists." },
      },
    }])).toContain("unavailable: No active execution exists.");
  });
});
