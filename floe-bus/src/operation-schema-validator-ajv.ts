import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type {
  JsonSchema,
  OperationSchemaIssue,
  OperationSchemaValidation,
  OperationSchemaValidator,
} from "./operations.js";

/** One production JSON-Schema validator for discovery and invocation. */
export class AjvOperationSchemaValidator implements OperationSchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly compiled = new WeakMap<JsonSchema, ValidateFunction>();

  validate(schema: JsonSchema, value: unknown): OperationSchemaValidation {
    const validator = this.compiled.get(schema) ?? this.compile(schema);
    if (validator(value)) return { valid: true };
    return {
      valid: false,
      issues: (validator.errors ?? []).map(toIssue),
    };
  }

  private compile(schema: JsonSchema): ValidateFunction {
    const validator = this.ajv.compile(schema);
    this.compiled.set(schema, validator);
    return validator;
  }
}

function toIssue(error: ErrorObject): OperationSchemaIssue {
  return {
    instance_path: error.instancePath,
    schema_path: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "does not match the operation schema",
    params: error.params as Record<string, unknown>,
  };
}
