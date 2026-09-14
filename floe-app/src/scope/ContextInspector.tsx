/**
 * ContextInspector — right-inspector content for a selected context in a scope.
 *
 * Shows: name (human label), participants, scope, created — all by name not IDs.
 * This developer observatory is read-only; operator lifecycle actions live in Conversations.
 */
import React, { useEffect, useState } from "react";
import type { ContextRef, EndpointRef, ScopeRef } from "../bus-client/types.ts";
import { getContext, listEndpoints } from "../bus-client/client.ts";
import { contextLabel } from "./ScopeDetail.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas:       "#08090a",
  surface:      "#0f1011",
  surfaceHov:   "#191a1b",
  border:       "rgba(255,255,255,0.08)",
  border2:      "rgba(255,255,255,0.05)",
  ink:          "#f7f8f8",
  ink2:         "#d0d6e0",
  ink3:         "#8a8f98",
  ink4:         "#62666d",
  accent:       "#8aa89c",
  danger:       "#b85a5a",
  fontUi:       '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "5px 0", fontSize: 13, borderBottom: `1px solid ${tk.border2}`,
      gap: 12, fontFamily: tk.fontUi,
    }}>
      <span style={{ color: tk.ink3, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tk.ink, fontWeight: 510, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ContextInspectorProps = {
  contextId: string;
  /** Owning scope, or null for a Direct (unscoped) context — v6 calls this "workspace context". */
  scope: ScopeRef | null;
  workspaceId: string;
  onDeleted: () => void;
};

/** Resolve an endpoint id to its human name, falling back to the raw id only if unresolved. */
function endpointLabel(endpointId: string, endpoints: EndpointRef[]): string {
  const ep = endpoints.find(e => e.endpoint_id === endpointId);
  return ep?.name?.trim() || endpointId;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContextInspector({
  contextId,
  scope,
  workspaceId,
  onDeleted,
}: ContextInspectorProps): React.ReactElement {
  const [ctx, setCtx] = useState<ContextRef | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setCtx(null);

    Promise.all([
      getContext(contextId, workspaceId),
      listEndpoints(workspaceId).catch(() => [] as EndpointRef[]),
    ])
      .then(([c, eps]) => {
        if (cancelled) return;
        setCtx(c);
        setEndpoints(eps);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // 404 → already gone, treat as deleted
        if (msg.includes("404")) {
          onDeleted();
        } else {
          setLoadError(msg);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [contextId, workspaceId, onDeleted]);

  if (loading) {
    return (
      <div style={{ padding: "14px 16px", color: tk.ink3, fontSize: 13, fontFamily: tk.fontUi }}>
        Loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" style={{ padding: "14px 16px", color: tk.danger, fontSize: 13, fontFamily: tk.fontUi }}>
        {loadError}
      </div>
    );
  }

  if (!ctx) return <></>;

  const label = contextLabel(ctx);
  const createdAt = formatDate(ctx.created_at);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto", fontFamily: tk.fontUi }}>
      {/* Head */}
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${tk.border}` }}>
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510,
        }}>
          Context
        </div>
        <div style={{
          fontSize: 16, fontWeight: 510, color: tk.ink, marginTop: 4,
          letterSpacing: "-0.01em", lineHeight: 1.3,
        }}>
          {label}
        </div>
      </div>

      {/* Details */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <StatRow
          label="Scope"
          value={scope ? (scope.title || scope.scope_id) : <span style={{ color: tk.ink4, fontStyle: "italic" }}>— direct, no scope —</span>}
        />
        <StatRow
          label="Participants"
          value={
            ctx.participants.length > 0
              ? ctx.participants.map(p => endpointLabel(p, endpoints)).join(", ")
              : <span style={{ color: tk.ink4, fontStyle: "italic" }}>none</span>
          }
        />
        <StatRow
          label="Created"
          value={createdAt}
        />
        <StatRow
          label="Messages"
          value={ctx.first_message_preview
            ? <span style={{ color: tk.ink3, fontSize: 11, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140, display: "inline-block" }}>{ctx.first_message_preview}</span>
            : <span style={{ color: tk.ink4, fontStyle: "italic" }}>none</span>
          }
        />
      </div>

    </div>
  );
}
