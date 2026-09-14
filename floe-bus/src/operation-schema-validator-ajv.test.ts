import { describe, expect, it } from "vitest";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";

describe("operation JSON-Schema validator", () => {
  it("uses the published schema without accepting undeclared input", () => {
    const validator = new AjvOperationSchemaValidator();
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    } as const;
    expect(validator.validate(schema, { name: "Floe" })).toEqual({ valid: true });
    expect(validator.validate(schema, { name: "Floe", caller_endpoint_id: "spoofed" })).toMatchObject({
      valid: false,
      issues: [{ keyword: "additionalProperties" }],
    });
  });
});
