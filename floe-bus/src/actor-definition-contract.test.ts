import { describe, expect, it } from "vitest";

import {
  ActorDefinitionValidationError,
  validateActorDefinition,
  type ActorDefinitionContent,
} from "./actor-definition-contract.js";

const definition: ActorDefinitionContent = {
  label: "Builder",
  charter: "Build accepted work.",
  responsibilities: [{
    responsibility_id: "build",
    title: "Build",
    description: "Build and verify the requested outcome.",
  }],
  instructions: "Use exact evidence.",
  knowledge_refs: [],
  capability_grant_ids: [],
  policy_refs: { budget: null, trust: null, approval: null },
  escalation_rules: [],
};

describe("public Actor definition contract", () => {
  it("validates the canonical definition without Bus storage or transport", () => {
    expect(() => validateActorDefinition(definition)).not.toThrow();
    expect(() => validateActorDefinition({ ...definition, label: "" }))
      .toThrow(ActorDefinitionValidationError);
  });
});
