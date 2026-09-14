import React, { useState } from "react";
import type { OperationResourceRef } from "../../bus-client/types.ts";
import { ActionPanel } from "../actions/ActionPanel.tsx";
import { tk } from "../../theme.ts";

type NamedReference = { name: string; resource_ref: OperationResourceRef };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** A message reference is navigation, never proof of a record's state or authority. */
export function conversationReferences(content: Record<string, unknown>): NamedReference[] {
  if (!Array.isArray(content.references)) return [];
  const result: NamedReference[] = [];
  for (const item of content.references) {
    if (!object(item) || !nonempty(item.name) || !object(item.resource_ref)) continue;
    const ref = item.resource_ref;
    if (!nonempty(ref.kind) || !nonempty(ref.id) || !(ref.revision === null || nonempty(ref.revision))) continue;
    if (Object.keys(ref).some(key => !["kind", "id", "revision"].includes(key))) continue;
    if (result.some(existing => existing.resource_ref.kind === ref.kind && existing.resource_ref.id === ref.id && existing.resource_ref.revision === ref.revision)) continue;
    result.push({ name: item.name, resource_ref: { kind: ref.kind, id: ref.id, revision: ref.revision } });
  }
  return result;
}

export function ConversationReferences({ workspaceId, content, artefactLabels }: {
  workspaceId: string; content: Record<string, unknown>; artefactLabels?: ReadonlyMap<string, string>;
}): React.ReactElement | null {
  const [selected, setSelected] = useState<NamedReference | null>(null);
  const references = conversationReferences(content);
  if (!references.length) return null;
  return <div aria-label="Message references" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
    {references.map(reference => <button key={JSON.stringify(reference.resource_ref)} type="button"
      style={{ border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: tk.surface, color: tk.accent, padding: "6px 9px", cursor: "pointer" }}
      onClick={() => setSelected(reference)}>{/^open\s/i.test(reference.name) ? reference.name : `Open ${reference.name}`}</button>)}
    {selected && <ActionPanel key={`${workspaceId}:${JSON.stringify(selected.resource_ref)}`} workspaceId={workspaceId}
      workspaceName={selected.name} initialTarget={{ ref: selected.resource_ref, label: selected.name }}
      initialReadOperationId={selected.resource_ref.kind === "approval_request" ? "approval.inspect" : undefined}
      artefactLabels={artefactLabels} onClose={() => setSelected(null)} />}
  </div>;
}
