import React, { useState } from "react";
import type { OperationResourceRef } from "../../bus-client/types.ts";
import { ActionPanel } from "./ActionPanel.tsx";
import { tk } from "../../theme.ts";
import type { FieldChoices } from "./SchemaFields.tsx";

export function ActionsButton({ workspaceId, target, label, caption = "Actions for this work", fieldChoices }: { workspaceId: string; target: OperationResourceRef; label: string; caption?: string; fieldChoices?: Record<string, FieldChoices> }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)} style={{ padding: "7px 10px", color: tk.ink2, background: "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, fontSize: 12 }}>{caption}</button>
    {open && <ActionPanel key={`${workspaceId}:${target.kind}:${target.id}`} workspaceId={workspaceId} workspaceName="Workspace" initialTarget={{ ref: target, label }} fieldChoices={fieldChoices} onClose={() => setOpen(false)} />}</>;
}
