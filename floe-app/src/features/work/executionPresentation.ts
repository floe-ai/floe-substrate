import type { ScopeExecutionRecord } from "../../bus-client/types.ts";
import { tk } from "../../theme.ts";

export function executionLabel(execution: ScopeExecutionRecord): string {
  const date = new Date(execution.created_at);
  const when = Number.isNaN(date.getTime()) ? execution.created_at : date.toLocaleString();
  return `${executionPresentation(execution.status).label} · ${when}`;
}

export function executionPresentation(status: ScopeExecutionRecord["status"] | null) {
  switch (status) {
    case "active": return { label: "Active", color: tk.accentHov, background: tk.accentSoft2 };
    case "waiting_external": return { label: "Waiting for a response", color: "#c9a14a", background: "rgba(201,161,74,0.10)" };
    case "waiting_human": return { label: "Needs your input", color: "#c9a14a", background: "rgba(201,161,74,0.10)" };
    case "paused": return { label: "Paused", color: tk.ink4, background: tk.surfaceHov };
    case "blocked": return { label: "Blocked", color: tk.danger, background: "rgba(184,90,90,0.12)" };
    case "superseded": return { label: "Replaced", color: tk.ink4, background: tk.surfaceHov };
    case "failed": return { label: "Needs attention", color: tk.danger, background: "rgba(184,90,90,0.12)" };
    case "cancelled": return { label: "Stopped", color: tk.ink4, background: tk.surfaceHov };
    case "completed": return { label: "Complete", color: tk.ink3, background: tk.surfaceHov };
    default: return { label: status ? "Queued" : "Plan only", color: tk.ink3, background: tk.surfaceHov };
  }
}

