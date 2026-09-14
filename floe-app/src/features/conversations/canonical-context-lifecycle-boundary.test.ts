import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const conversationsDir = import.meta.dirname;
const operatorSource = readFileSync(resolve(conversationsDir, "OperatorConversations.tsx"), "utf8");
const lifecycleSource = readFileSync(resolve(conversationsDir, "contextLifecycle.ts"), "utf8");
const clientSource = readFileSync(resolve(conversationsDir, "../../bus-client/client.ts"), "utf8");
const conversationSource = readFileSync(resolve(conversationsDir, "../../scope/ContextConversation.tsx"), "utf8");
const contextInspectorSource = readFileSync(resolve(conversationsDir, "../../scope/ContextInspector.tsx"), "utf8");
const scopeDetailSource = readFileSync(resolve(conversationsDir, "../../scope/ScopeDetail.tsx"), "utf8");

describe("operator Context lifecycle boundary", () => {
  it("uses discovered semantic operations instead of the raw Context delete route", () => {
    expect(operatorSource).not.toContain("deleteContext");
    expect(lifecycleSource).toContain("listOperations");
    expect(lifecycleSource).toContain("invokeOperation");
    expect(lifecycleSource).toContain('"context.archive"');
    expect(lifecycleSource).toContain('"context.restore"');
    expect(lifecycleSource).toContain('"context.destroy_permanently"');
    expect(clientSource).not.toContain("export async function deleteContext");
  });

  it("names reversible archive accurately in the operator conversation", () => {
    expect(conversationSource).toContain("onArchiveConversation");
    expect(conversationSource).not.toContain("onDeleteConversation");
    expect(conversationSource).toContain("Archived conversations are retained");
  });

  it("keeps Context mutation controls out of the developer observatory", () => {
    expect(contextInspectorSource).not.toContain("deleteContext");
    expect(contextInspectorSource).not.toContain("Delete context");
    expect(scopeDetailSource).not.toContain("deleteContext");
    expect(scopeDetailSource).not.toContain("Delete context");
  });
});
