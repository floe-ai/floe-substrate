import { describe, expect, it } from "vitest";
import { SUBSTRATE_GUIDANCE, buildSystemPrompt, renderDestinationContext } from "./guidance.js";

describe("SUBSTRATE_GUIDANCE", () => {
  it("makes natural completion local and separates emit from request", () => {
    expect(SUBSTRATE_GUIDANCE).toContain("records that final output as your local contribution");
    expect(SUBSTRATE_GUIDANCE).toContain("Use `emit` only when");
    expect(SUBSTRATE_GUIDANCE).toContain("Use `request(actor, work)`");
    expect(SUBSTRATE_GUIDANCE).toContain("durable wait and return path");
    expect(SUBSTRATE_GUIDANCE).not.toContain("correlation");
  });

  it("keeps history addressable instead of mandatory", () => {
    expect(SUBSTRATE_GUIDANCE).toContain("not automatically inserted");
    expect(SUBSTRATE_GUIDANCE).toContain("Use `context_history`");
    expect(SUBSTRATE_GUIDANCE).not.toContain("response_expected");
    expect(SUBSTRATE_GUIDANCE).not.toContain("current_context_participants");
  });

  it("does not confuse a generated command with persistent Floe operation", () => {
    expect(SUBSTRATE_GUIDANCE).toContain("Creating a script or command does not activate persistent Floe operation");
    expect(SUBSTRATE_GUIDANCE).toContain("report that concrete gap");
  });

  it("explains real Scope composition without inventing workflow enforcement", () => {
    expect(SUBSTRATE_GUIDANCE).toContain("search with `discover_capabilities`");
    expect(SUBSTRATE_GUIDANCE).toContain("selected `operation_id` to load its exact input contract");
    expect(SUBSTRATE_GUIDANCE).toContain("call `use_capability`");
    expect(SUBSTRATE_GUIDANCE).toContain("Bus-owned description, version, target rules, availability, and input schema");
    expect(SUBSTRATE_GUIDANCE).toContain("Current discovery overrides older recipes");
    expect(SUBSTRATE_GUIDANCE).not.toContain("`compose_scope`");
    expect(SUBSTRATE_GUIDANCE).toContain("Composition provides routing, not workflow policy");
  });
});

describe("buildSystemPrompt", () => {
  it("appends substrate guidance after actor instructions", () => {
    const result = buildSystemPrompt("You are a helpful agent.");
    expect(result).toContain(SUBSTRATE_GUIDANCE);
    expect(result.indexOf("You are a helpful agent.")).toBeLessThan(result.indexOf("## Floe runtime"));
  });

  it("returns substrate guidance when instructions are empty", () => {
    expect(buildSystemPrompt("")).toBe(SUBSTRATE_GUIDANCE);
    expect(buildSystemPrompt("   ")).toBe(SUBSTRATE_GUIDANCE);
  });
});

describe("renderDestinationContext", () => {
  it("renders only compact causal orientation and history access", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "actor:ws:alice",
      current_context_id: "ctx_abc",
      cause_event_id: "evt_123",
      cause_type: "request.result",
      cause_reference: "request evt_100"
    });
    expect(result).toContain("[Context Envelope]");
    expect(result).toContain("context: ctx_abc");
    expect(result).toContain("cause_actor: alice");
    expect(result).toContain("cause_type: request.result");
    expect(result).toContain("cause_event: evt_123");
    expect(result).toContain("reference: request evt_100");
    expect(result).toContain("history: available on demand with context_history");
  });

  it("does not expose routing protocol or participant inventory", () => {
    const result = renderDestinationContext({ source_endpoint_id: "actor:ws:alice" });
    expect(result).not.toContain("response_expected");
    expect(result).not.toContain("correlation_id");
    expect(result).not.toContain("participants");
    expect(result).not.toContain("reply_actor");
    expect(result).not.toContain("actor:ws:alice");
  });
});
