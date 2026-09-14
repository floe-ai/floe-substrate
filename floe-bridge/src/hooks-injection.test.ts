import { describe, it, expect } from "vitest";
import { renderHookInjections } from "./runtime-core/index.js";

describe("renderHookInjections", () => {
  it("returns empty string when no results have inject", () => {
    expect(renderHookInjections([])).toBe("");
    expect(renderHookInjections([{}])).toBe("");
  });

  it("renders a single injection with source label", () => {
    const result = renderHookInjections([{
      inject: { source: "memory", content: "User prefers TypeScript" }
    }]);
    expect(result).toContain("[Injected Context");
    expect(result).toContain("from: memory");
    expect(result).toContain("User prefers TypeScript");
    expect(result).toContain("[End Injected Context]");
  });

  it("renders multiple injections in deterministic order", () => {
    const result = renderHookInjections([
      { inject: { source: "memory", content: "Memory context A" } },
      { inject: { source: "todo", content: "Open tasks: 3" } }
    ]);
    const memIdx = result.indexOf("from: memory");
    const todoIdx = result.indexOf("from: todo");
    expect(memIdx).toBeLessThan(todoIdx);
    expect(result).toContain("Memory context A");
    expect(result).toContain("Open tasks: 3");
  });

  it("truncates individual injection exceeding per-source limit", () => {
    const longContent = "x".repeat(5000);
    const result = renderHookInjections([{
      inject: { source: "big-ext", content: longContent }
    }]);
    expect(result).toContain("truncated from 5000 chars");
    expect(result.length).toBeLessThan(5500);
  });

  it("truncates total injection exceeding total limit", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      inject: { source: `ext-${i}`, content: "y".repeat(3000) }
    }));
    const result = renderHookInjections(results);
    expect(result).toContain("total limit reached");
    expect(result.length).toBeLessThan(20000);
  });

  it("uses 'extension' as default source when not specified", () => {
    const result = renderHookInjections([{
      inject: { content: "some context" }
    }]);
    expect(result).toContain("from: extension");
  });

  it("renders non-string inject as JSON", () => {
    const result = renderHookInjections([{
      inject: { source: "policy", rules: ["no-secrets", "max-tokens-1000"] }
    }]);
    expect(result).toContain("no-secrets");
    expect(result).toContain("max-tokens-1000");
  });

  it("marks injection as not a message", () => {
    const result = renderHookInjections([{
      inject: { source: "test", content: "hello" }
    }]);
    expect(result).toContain("not a message");
  });

  it("skips results without inject field", () => {
    const result = renderHookInjections([
      {},
      { inject: { source: "mem", content: "relevant" } },
      {}
    ]);
    expect(result).toContain("relevant");
    const fromCount = (result.match(/from:/g) || []).length;
    expect(fromCount).toBe(1);
  });
});
