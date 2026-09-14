import React from "react";
import type { OperationResourceRef } from "../../bus-client/types.ts";
import { matches, record, words, type Schema } from "./SchemaFields.tsx";

export function ActionResult({ value, schema = {}, label = "Result", onSelectResource, depth = 0 }: {
  value: unknown; schema?: Schema; label?: string; onSelectResource: (ref: OperationResourceRef, label: string) => void; depth?: number;
}): React.ReactElement {
  if (depth > 16) return <p>{label}: further nested detail is unavailable in this view.</p>;
  const variants = Array.isArray(schema.oneOf ?? schema.anyOf) ? (schema.oneOf ?? schema.anyOf) as Schema[] : [];
  if (variants.length) schema = variants.find(item => matches(item, value)) ?? schema;
  if (value === null || value === undefined) return <p><span className="action-help">{label}:</span> None</p>;
  if (Array.isArray(value)) return <section className="action-result-list"><h3>{label} <span className="action-help">({value.length})</span></h3>
    {value.length === 0 ? <p>No items.</p> : value.map((item, index) => <ActionResult key={index} value={item} schema={record(schema.items) ? schema.items : {}} label={record(item) && typeof item.title === "string" ? item.title : `${label} ${index + 1}`} onSelectResource={onSelectResource} depth={depth + 1} />)}</section>;
  if (record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    // A returned canonical ResourceRef is directly selectable. Arbitrary ID
    // property names are never interpreted as a resource-kind convention.
    const ref = typeof value.kind === "string" && typeof value.id === "string" && Object.keys(value).every(key => ["kind", "id", "revision"].includes(key))
      ? { kind: value.kind, id: value.id, revision: typeof value.revision === "string" ? value.revision : null } : null;
    return <section className="action-result-object"><h3>{label}</h3>
      {ref ? <><p>{words(ref.kind)}</p><button type="button" onClick={() => onSelectResource(ref, label)}>Actions for {label.toLowerCase()}</button><details><summary>Reference details</summary><p>{ref.id}</p><p>{ref.revision}</p></details></>
        : Object.entries(value).map(([key, item]) => <ActionResult key={key} value={item} schema={record(properties[key]) ? properties[key] : {}} label={record(properties[key]) && typeof properties[key].title === "string" ? properties[key].title : words(key)} onSelectResource={onSelectResource} depth={depth + 1} />)}
    </section>;
  }
  return <p className="action-result-value"><span className="action-help">{label}:</span> {typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</p>;
}
