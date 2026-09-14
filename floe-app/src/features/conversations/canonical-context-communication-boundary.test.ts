import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const operatorConversation = readFileSync(
  resolve(import.meta.dirname, "OperatorConversations.tsx"),
  "utf8",
);
const contextConversation = readFileSync(
  resolve(import.meta.dirname, "../../scope/ContextConversation.tsx"),
  "utf8",
);
const communication = readFileSync(
  resolve(import.meta.dirname, "contextCommunication.ts"),
  "utf8",
);

describe("operator Context communication boundary", () => {
  it("routes both active chat surfaces through the shared operation contract", () => {
    expect(operatorConversation).toContain("createConversationSubmission");
    expect(contextConversation).toContain("createConversationSubmission");
    expect(operatorConversation).not.toMatch(/\bemit\s*\(/);
    expect(operatorConversation).not.toContain("createDirectContext");
    expect(contextConversation).not.toMatch(/\bemit\s*\(/);
    expect(communication).toContain('"context.communication.emit"');
    expect(communication).toContain('"context.create"');
    expect(communication).toContain("listOperations");
    expect(communication).toContain("invokeOperation");
    expect(communication).not.toContain("/v1/events/emit");
  });

  it("does not offer endpoint impersonation or mutate Context membership from chat", () => {
    expect(contextConversation).not.toContain("speakingAs");
    expect(contextConversation).not.toContain("Speaking as");
    expect(contextConversation).not.toContain("addContextParticipant");
    expect(contextConversation).not.toContain("Join context");
    expect(contextConversation).toContain("authenticated operator");
  });
});
