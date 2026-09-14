/**
 * ScopeDetail — main-area view shown when a scope is selected.
 *
 * Header: scope name + description.
 *
 * Body: read-only list of contexts in that scope, shown by human label (never raw id as
 * primary). Context lifecycle actions live in the operator Conversations surface.
 *
 * Empty state: "No contexts in this scope yet"
 */
import React, { useEffect, useState, useCallback } from "react";
import type { ScopeRef, ContextRef } from "../bus-client/types.ts";
import { listContextsForScope } from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { Ops } from "./Ops.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk object)
// ---------------------------------------------------------------------------

const tk = {
  canvas:       "#08090a",
  surface:      "#0f1011",
  surfaceHov:   "#191a1b",
  surfaceSunk:  "#0b0c0d",
  border:       "rgba(255,255,255,0.08)",
  border2:      "rgba(255,255,255,0.05)",
  ink:          "#f7f8f8",
  ink2:         "#d0d6e0",
  ink3:         "#8a8f98",
  ink4:         "#62666d",
  accent:       "#8aa89c",
  accentHov:    "#a1bcb1",
  accentSoft:   "#16201d",
  accentSoft2:  "#1f2c28",
  ok:           "#87b894",
  danger:       "#b85a5a",
  fontUi:       '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a human-readable label for a context.
 * Prefers `title` (extension-owned card title) over `first_message_preview`.
 */
export function contextLabel(ctx: ContextRef): string {
  const title = ctx.title?.trim();
  if (title) return title;
  const preview = ctx.first_message_preview?.trim();
  if (preview) return preview;
  if (ctx.participants.length > 0) {
    return `Conversation (${ctx.participants.length} participant${ctx.participants.length !== 1 ? "s" : ""})`;
  }
  return "Conversation";
}

export function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Context row
// ---------------------------------------------------------------------------

export function ContextRow({
  ctx,
  isSelected,
  onClick,
}: {
  ctx: ContextRef;
  isSelected: boolean;
  onClick: () => void;
}): React.ReactElement {
  const [hov, setHov] = useState(false);
  const label = contextLabel(ctx);
  const participantCount = ctx.participants.length;
  const lastActivity = relativeTime(ctx.last_event_at ?? ctx.created_at);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      aria-selected={isSelected}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderBottom: `1px solid ${tk.border2}`,
        background: isSelected ? tk.accentSoft : hov ? tk.surfaceHov : "transparent",
        borderLeft: `2px solid ${isSelected ? tk.accent : "transparent"}`,
        cursor: "pointer",
        transition: "background 100ms ease",
      }}
    >
      {/* Label + meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: tk.ink, fontWeight: 510,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontFamily: tk.fontUi,
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 11, color: tk.ink3, marginTop: 1,
          display: "flex", gap: 10, fontFamily: tk.fontUi,
        }}>
          <span>{participantCount} participant{participantCount !== 1 ? "s" : ""}</span>
          <span>{lastActivity}</span>
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// ScopeDetail props
// ---------------------------------------------------------------------------

export type ScopeDetailProps = {
  scope: ScopeRef;
  workspaceId: string;
  selectedContextId: string | null;
  onSelectContext: (id: string | null) => void;
};

// ---------------------------------------------------------------------------
// ScopeDetail
// ---------------------------------------------------------------------------

/** Built-in views (always present) */
const BUILTIN_VIEWS = [
  { id: "contexts", label: "Contexts" },
  { id: "ops",      label: "Ops" },
] as const;

type BuiltinViewId = (typeof BUILTIN_VIEWS)[number]["id"];
type ScopeDetailView = BuiltinViewId;

export function ScopeDetail({
  scope,
  workspaceId,
  selectedContextId,
  onSelectContext,
}: ScopeDetailProps): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ScopeDetailView>("contexts");

  const loadContexts = useCallback(() => {
    setLoading(true);
    setError(null);
    listContextsForScope(workspaceId, scope.scope_id)
      .then(rows => {
        // Sort newest first
        const sorted = [...rows].sort((a, b) => {
          const ta = a.last_event_at ?? a.created_at;
          const tb = b.last_event_at ?? b.created_at;
          return tb.localeCompare(ta);
        });
        setContexts(sorted);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load contexts");
        setLoading(false);
      });
  }, [workspaceId, scope.scope_id]);

  useEffect(() => {
    loadContexts();
  }, [loadContexts]);

  // Auto-refresh contexts list on push: context_created (new context in this scope)
  // or event_submitted (updates last_event_at on a context, changing sort order).
  useEffect(() => {
    const unsub = subscribeEvents((msg) => {
      if (msg.type === "context_created") {
        const ctx = (msg.payload as { context?: { scope_id?: string; workspace_id?: string } }).context;
        if (ctx?.workspace_id === workspaceId && ctx?.scope_id === scope.scope_id) {
          loadContexts();
        }
      } else if (msg.type === "event_submitted") {
        const event = (msg.payload as { event?: { scope_id?: string; workspace_id?: string } }).event;
        if (event?.workspace_id === workspaceId && event?.scope_id === scope.scope_id) {
          loadContexts();
        }
      }
    }, { workspaceId });
    return unsub;
  }, [workspaceId, scope.scope_id, loadContexts]);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      fontFamily: tk.fontUi,
    }}>
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        padding: "20px 28px 16px",
        borderBottom: `1px solid ${tk.border}`,
        background: tk.surface,
        flexShrink: 0,
      }}>
        {/* Eyebrow */}
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510, marginBottom: 4,
        }}>
          Scope
        </div>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{
              margin: "0 0 4px", fontSize: 22, fontWeight: 510, color: tk.ink,
              letterSpacing: "-0.015em", lineHeight: 1.1,
            }}>
              {scope.title || scope.scope_id}
            </h2>
            {scope.description ? (
              <p style={{ margin: 0, fontSize: 13, color: tk.ink3, lineHeight: 1.45 }}>
                {scope.description}
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
                No description
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* View toggle: Contexts / Ops                                           */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        display: "flex", gap: 4, padding: "10px 28px 0",
        borderBottom: `1px solid ${tk.border}`, background: tk.surface, flexShrink: 0,
      }}>
        {BUILTIN_VIEWS.map(v => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            aria-pressed={view === v.id}
            style={{
              background: "transparent", border: "none",
              borderBottom: `2px solid ${view === v.id ? tk.accent : "transparent"}`,
              color: view === v.id ? tk.ink : tk.ink3,
              padding: "6px 10px 8px",
              fontSize: 12.5, fontWeight: 510, cursor: "pointer",
              fontFamily: tk.fontUi, textTransform: "capitalize",
            }}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Body: Contexts list or Ops (events & pulses)                          */}
      {/* ------------------------------------------------------------------ */}
      {view === "ops" ? (
        <Ops workspaceId={workspaceId} scopeId={scope.scope_id} />
      ) : (
      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Section header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 28px 8px",
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510,
        }}>
          <span>Contexts</span>
          {!loading && (
            <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
              {contexts.length}
            </span>
          )}
        </div>

        {loading && (
          <div style={{ padding: "20px 28px", color: tk.ink3, fontSize: 13 }}>
            Loading contexts…
          </div>
        )}

        {error && (
          <div role="alert" style={{ padding: "16px 28px", color: tk.danger, fontSize: 13 }}>
            {error}
          </div>
        )}

        {!loading && !error && contexts.length === 0 && (
          <div style={{ padding: "32px 28px", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
            No contexts in this scope yet.
          </div>
        )}

        {!loading && !error && contexts.length > 0 && (
          <div role="list" aria-label="Contexts in scope">
            {contexts.map(ctx => (
              <ContextRow
                key={ctx.context_id}
                ctx={ctx}
                isSelected={selectedContextId === ctx.context_id}
                onClick={() => onSelectContext(ctx.context_id)}
              />
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
