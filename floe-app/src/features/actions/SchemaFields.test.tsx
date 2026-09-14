import React, { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialValue, SchemaFields, type Schema } from "./SchemaFields.tsx";
afterEach(cleanup);
function Editor({ schema }: { schema: Schema }) {
  const [value, setValue] = useState(initialValue(schema));
  return <><SchemaFields schema={schema} value={value} onChange={setValue} /><output aria-label="Submitted value">{JSON.stringify(value)}</output></>;
}
describe("descriptor fields", () => {
  it("changes discriminated alternatives without retaining fields from the old choice", () => {
    const schema = { oneOf: [{ type: "object", required: ["kind", "text"], additionalProperties: false, properties: { kind: { const: "message" }, text: { type: "string" } } }, { type: "object", required: ["kind", "count"], additionalProperties: false, properties: { kind: { const: "count" }, count: { type: "integer" } } }] };
    render(<Editor schema={schema} />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Old text" } });
    fireEvent.change(screen.getByLabelText("Choose details type"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "7" } });
    expect(screen.getByLabelText("Submitted value").textContent).toBe('{"kind":"count","count":7}');
    expect(screen.queryByLabelText("Text")).toBeNull();
  });
  it("keeps omitted, false and zero distinct and supports removing optional values", () => {
    render(<Editor schema={{ type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" }, amount: { type: "number" } } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Add amount" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0" } });
    expect(screen.getByLabelText("Submitted value").textContent).toBe('{"enabled":false,"amount":0}');
    fireEvent.click(screen.getByRole("button", { name: "Remove enabled" }));
    expect(screen.getByLabelText("Submitted value").textContent).toBe('{"amount":0}');
  });
  it("edits a typed open object without raw JSON or losing false values", () => {
    render(<Editor schema={{ type: "object", additionalProperties: { type: "boolean" } }} />);
    fireEvent.change(screen.getByLabelText("New field name"), { target: { value: "visible" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(screen.getByLabelText("Submitted value").textContent).toBe('{"visible":false}');
  });
});
