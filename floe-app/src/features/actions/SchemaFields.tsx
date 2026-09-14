import React, { useId, useState } from "react";

export type Schema = Record<string, unknown>;
export type FieldChoices = Record<string, { label: string; options: readonly { label: string; value: string | null }[] }>;
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const words = (value: string): string => value.replace(/[_-]/g, " ").replace(/^./, letter => letter.toUpperCase());
const schemas = (value: unknown): Schema[] => Array.isArray(value) ? value.filter(record) : [];

function types(schema: Schema): string[] {
  return typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type as string[] : [];
}

export function initialValue(schema: Schema): unknown {
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  const variants = schemas(schema.oneOf ?? schema.anyOf);
  if (variants.length) return initialValue(variants.find(item => item.type !== "null") ?? variants[0]);
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = types(schema).find(item => item !== "null");
  if (type === "object" || schema.properties) {
    const properties = record(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.fromEntries(Object.entries(properties).filter(([key]) => required.includes(key)).map(([key, child]) => [key, initialValue(record(child) ? child : {})]));
  }
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return undefined;
  if (type === "string") return "";
  return null;
}

// Select a presentation branch; the Bus remains the schema validator.
export function matches(schema: Schema, value: unknown): boolean {
  if ("const" in schema) return schema.const === value;
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  if (value === null) return types(schema).includes("null");
  const variants = schemas(schema.oneOf ?? schema.anyOf);
  if (variants.length) return variants.some(item => matches(item, value));
  const type = types(schema).find(item => item !== "null");
  if (type === "object" || schema.properties) {
    if (!record(value)) return false;
    const properties = record(schema.properties) ? schema.properties : {};
    return Object.entries(properties).every(([key, child]) => !record(child) || !("const" in child) || value[key] === child.const);
  }
  return type === "array" ? Array.isArray(value) : type === "integer" ? typeof value === "number" && Number.isInteger(value) : type ? typeof value === type : true;
}

function branchLabel(schema: Schema, index: number): string {
  if (typeof schema.title === "string") return schema.title;
  if (record(schema.properties)) {
    const discriminator = Object.values(schema.properties).find(child => record(child) && typeof child.const === "string");
    if (record(discriminator)) return words(String(discriminator.const));
  }
  return words(types(schema).join(" or ") || `Option ${index + 1}`);
}

const freeTypes = ["string", "number", "boolean", "object", "array", "null"];

export function SchemaFields({ schema, value, onChange, label = "Details", required = true, depth = 0, fieldChoices, choices }: {
  schema: Schema; value: unknown; onChange: (value: unknown) => void; label?: string; required?: boolean; depth?: number;
  fieldChoices?: FieldChoices; choices?: FieldChoices[string];
}): React.ReactElement {
  const id = useId();
  const [newKey, setNewKey] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<number | null>(null);
  const [included, setIncluded] = useState(value !== undefined);
  const title = typeof schema.title === "string" ? schema.title : label;
  if (depth > 24) return <p role="alert">This nested value is too deep to edit here.</p>;
  if (schema.readOnly === true || "const" in schema) return <p>{title}: <strong>{String(schema.const ?? value ?? "")}</strong></p>;
  const choiceTypes = [...types(schema), ...schemas(schema.oneOf ?? schema.anyOf).flatMap(types)];
  const nullableChoice = choices?.options.some(option => option.value === null) && choiceTypes.includes("null");
  if (choices && choiceTypes.includes("string")) return <div className="action-field"><label htmlFor={id}>{choices.label}</label>
    <select id={id} value={typeof value === "string" ? value : ""} required={required && !nullableChoice} onChange={event => onChange(event.target.value === "" && nullableChoice ? null : event.target.value)}>
      {!nullableChoice && <option value="">Choose {choices.label.toLowerCase()}</option>}
      {choices.options.filter(option => !Array.isArray(schema.enum) || schema.enum.includes(option.value))
        .filter(option => option.value !== null || nullableChoice)
        .map(option => <option key={option.value ?? ""} value={option.value ?? ""}>{option.label}</option>)}
    </select></div>;
  if (!required && value === undefined && !included) return <button type="button" className="action-add" onClick={() => { setIncluded(true); onChange(initialValue(schema)); }}>Add {title.toLowerCase()}</button>;

  const variants = schemas(schema.oneOf ?? schema.anyOf);
  const typeVariants = types(schema);
  if (!variants.length && typeVariants.length > 1) variants.push(...typeVariants.map(type => ({ ...schema, type })));
  const description = typeof schema.description === "string" ? <p className="action-help">{schema.description}</p> : null;
  const remove = !required ? <button type="button" className="action-add" onClick={() => { setIncluded(false); onChange(undefined); }}>Remove {title.toLowerCase()}</button> : null;
  if (variants.length) {
    const selected = selectedBranch !== null && variants[selectedBranch] && matches(variants[selectedBranch], value)
      ? selectedBranch : Math.max(0, variants.findIndex(item => matches(item, value)));
    return <fieldset className="action-fields"><legend>{title}</legend>{description}<label htmlFor={id}>Choose {title.toLowerCase()} type</label>
      <select id={id} value={selected} onChange={event => { const index = Number(event.target.value); setSelectedBranch(index); onChange(initialValue(variants[index])); }}>
        {variants.map((variant, index) => <option key={index} value={index}>{branchLabel(variant, index)}</option>)}
      </select><SchemaFields key={selected} schema={variants[selected]} value={value} onChange={onChange} label={title} depth={depth + 1} />{remove}</fieldset>;
  }
  if (Array.isArray(schema.enum)) return <div className="action-field"><label htmlFor={id}>{title}</label>{description}
    <select id={id} value={JSON.stringify(value)} onChange={event => onChange(JSON.parse(event.target.value))} required={required}>
      {schema.enum.map((item, index) => <option key={index} value={JSON.stringify(item)}>{typeof item === "string" ? words(item) : String(item)}</option>)}
    </select>{remove}</div>;

  const type = typeVariants[0] ?? (schema.properties ? "object" : undefined);
  if (type === "object") {
    const current = record(value) ? value : {};
    const properties = record(schema.properties) ? schema.properties : {};
    const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
    const keys = [...new Set([...Object.keys(properties), ...Object.keys(current)])];
    const extra = record(schema.additionalProperties) ? schema.additionalProperties : {};
    const replace = (key: string, next: unknown) => onChange(Object.fromEntries([...Object.entries(current).filter(([name]) => name !== key), ...(next === undefined ? [] : [[key, next]])]));
    return <fieldset className="action-fields"><legend>{title}</legend>{description}
      {keys.map(key => <SchemaFields key={key} schema={record(properties[key]) ? properties[key] : extra} label={words(key)} value={current[key]} onChange={next => replace(key, next)} required={requiredKeys.includes(key)} depth={depth + 1} choices={fieldChoices?.[key]} />)}
      {schema.additionalProperties !== false && <div className="action-field"><label htmlFor={id}>New field name</label><div className="action-row"><input id={id} value={newKey} onChange={event => setNewKey(event.target.value)} />
        <button type="button" disabled={!newKey.trim() || keys.includes(newKey.trim())} onClick={() => { replace(newKey.trim(), initialValue(extra)); setNewKey(""); }}>Add field</button></div></div>}
      {!keys.length && schema.additionalProperties === false && <p>No additional details needed.</p>}{remove}</fieldset>;
  }
  if (type === "array") {
    const current = Array.isArray(value) ? value : [];
    const itemSchema = record(schema.items) ? schema.items : {};
    return <fieldset className="action-fields"><legend>{title}</legend>{description}
      {current.map((item, index) => <div key={index} className="action-item"><SchemaFields schema={itemSchema} value={item} label={`Item ${index + 1}`} onChange={next => onChange(current.map((old, position) => position === index ? next : old))} depth={depth + 1} />
        <button type="button" onClick={() => onChange(current.filter((_, position) => position !== index))}>Remove item {index + 1}</button></div>)}
      <button type="button" disabled={typeof schema.maxItems === "number" && current.length >= schema.maxItems} onClick={() => onChange([...current, initialValue(itemSchema)])}>Add item to {title.toLowerCase()}</button>{remove}</fieldset>;
  }
  if (type === "boolean") return <div className="action-field"><label><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} /> {title}</label>{description}{remove}</div>;
  if (type === "null") return <p>{title}: empty {remove}</p>;
  if (type === "string" || type === "number" || type === "integer") return <div className="action-field"><label htmlFor={id}>{title}</label>{description}
    {type === "string" ? <textarea id={id} rows={2} required={required} value={typeof value === "string" ? value : ""} minLength={typeof schema.minLength === "number" ? schema.minLength : undefined} maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined} onChange={event => onChange(event.target.value)} />
      : <input id={id} type="number" required={required} step={type === "integer" ? 1 : "any"} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} value={typeof value === "number" ? value : ""} onChange={event => onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)} />}{remove}</div>;

  // Unconstrained JSON values stay editable without a raw JSON text editor.
  const freeType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return <fieldset className="action-fields"><legend>{title}</legend>{description}<label htmlFor={id}>Value type</label>
    <select id={id} value={freeTypes.includes(freeType) ? freeType : "null"} onChange={event => onChange(initialValue({ type: event.target.value }))}>
      {freeTypes.map(item => <option key={item} value={item}>{words(item)}</option>)}
    </select>{freeType !== "null" && freeTypes.includes(freeType) && <SchemaFields schema={{ type: freeType }} value={value} onChange={onChange} label={title} depth={depth + 1} />}{remove}</fieldset>;
}
