/**
 * Ops — events & pulses management for a scope.
 *
 * REAL MODEL:
 *  - "Event" has no standalone managed/CRUD entity in the substrate. An Event is an
 *    immutable emitted message (EventEnvelope) — created by an actor emit, a pulse
 *    firing (`pulse.fired`), or a webhook ingest. There is no create/edit/delete for
 *    a raw event as a thing-in-itself. The Events section here is a READ-ONLY
 *    recent list, scoped via `GET /v1/events?scope_id=`.
 *  - "Pulse" is the real manageable/schedulable entity: a bus-owned trigger (once/cron)
 *    that fires `pulse.fired` to its subscribers (a context, or an endpoint+context).
 *    The bus supports create / list / pause / resume / cancel / subscribe / unsubscribe —
 *    there is no edit or hard-delete; "cancel" is the closest thing to delete (status
 *    becomes "cancelled", row persists for audit).
 *  - Linkage: a pulse has an optional `scope_id` (nullable) and subscribers reference
 *    contexts by `context_id`. Connecting a pulse "to a context" = adding/removing a
 *    `{ kind: "context", context_id }` subscriber via subscribe/unsubscribe.
 *  - Pulses have NO persisted human "name" column in the bus schema (confirmed: the
 *    bus's own `pulse_name` metadata fallback `(pulse as any).name ?? pulseId` is dead
 *    code — `name` is never set). Agents already use descriptive `pulse_id`s as the de
 *    facto name (e.g. "daily_check"). We follow that convention: `pulse_id` is the
 *    primary display name, with `content.text` shown as a subordinate detail line.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { ContextRef, EventEnvelope, PulseRef, PulseSubscriber } from "../bus-client/types.ts";
import {
  listContexts,
  listEvents,
  queryPulses,
  createPulse,
  pausePulse,
  resumePulse,
  cancelPulse,
  subscribePulse,
  unsubscribePulse,
} from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { contextLabel } from "./ScopeDetail.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx / ScopeDetail.tsx tk)
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

function relativeTime(dateStr: string | null): string {
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

function absoluteTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

/** Human label for a pulse: pulse_id is the de facto name (see file header). */
function pulseLabel(p: PulseRef): string {
  return p.pulse_id;
}

function triggerSummary(trigger: unknown): string {
  if (!trigger || typeof trigger !== "object") return "—";
  const t = trigger as { type?: string; at?: string; schedule?: string; timezone?: string };
  if (t.type === "cron" && t.schedule) {
    return `cron ${t.schedule}${t.timezone ? ` (${t.timezone})` : ""}`;
  }
  if (t.type === "once" && t.at) {
    return `once at ${absoluteTime(t.at)}`;
  }
  return t.type ?? "—";
}

function statusColor(status: string): string {
  if (status === "active") return tk.ok;
  if (status === "paused") return tk.ink3;
  if (status === "cancelled") return tk.danger;
  return tk.ink4;
}

function contextLabelById(contexts: ContextRef[], contextId: string | null | undefined): string {
  if (!contextId) return "—";
  const ctx = contexts.find(c => c.context_id === contextId);
  return ctx ? contextLabel(ctx) : contextId;
}

// ---------------------------------------------------------------------------
// Pulse subscriber row + connect-to-context control
// ---------------------------------------------------------------------------

function SubscriberRow({
  subscriber,
  contexts,
  onRemove,
  removing,
}: {
  subscriber: PulseSubscriber;
  contexts: ContextRef[];
  onRemove: () => void;
  removing: boolean;
}): React.ReactElement {
  const isContext = subscriber.kind === "context";
  const label = isContext
    ? contextLabelById(contexts, (subscriber as { context_id: string }).context_id)
    : (subscriber as { endpoint_ref: string }).endpoint_ref;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 0", fontSize: 12,
    }}>
      <span style={{
        fontSize: 9.5, padding: "1px 5px", borderRadius: tk.r1,
        background: tk.accentSoft2, color: tk.accentHov, fontWeight: 510,
        textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0,
      }}>
        {isContext ? "context" : "actor"}
      </span>
      <span style={{ color: tk.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {label}
      </span>
      <button
        onClick={onRemove}
        disabled={removing}
        title="Disconnect"
        style={{
          background: "transparent", border: `1px solid ${tk.danger}`,
          color: tk.danger, borderRadius: tk.r1, padding: "1px 7px",
          fontSize: 11, cursor: "pointer", flexShrink: 0, opacity: removing ? 0.5 : 1,
        }}
      >
        {removing ? "…" : "×"}
      </button>
    </div>
  );
}

function ConnectContextControl({
  contexts,
  onConnect,
}: {
  contexts: ContextRef[];
  onConnect: (contextId: string) => Promise<void>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          background: "transparent", border: `1px dashed ${tk.border}`,
          color: tk.accentHov, borderRadius: tk.r1, padding: "2px 8px",
          fontSize: 11.5, cursor: "pointer", marginTop: 4,
        }}
      >
        + Connect to context
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
      <select
        autoFocus
        value={picked}
        onChange={e => setPicked(e.target.value)}
        style={{
          background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
          borderRadius: tk.r2, padding: "3px 6px", fontSize: 12, color: tk.ink,
          flex: 1, minWidth: 0,
        }}
      >
        <option value="">Select a context…</option>
        {contexts.map(c => (
          <option key={c.context_id} value={c.context_id}>{contextLabel(c)}</option>
        ))}
      </select>
      <button
        disabled={!picked || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConnect(picked);
            setOpen(false);
            setPicked("");
          } finally {
            setBusy(false);
          }
        }}
        style={{
          background: tk.accent, color: "#0c1714", border: "none",
          borderRadius: tk.r2, padding: "3px 10px", fontSize: 12, cursor: "pointer", fontWeight: 510,
        }}
      >
        {busy ? "…" : "Connect"}
      </button>
      <button
        onClick={() => { setOpen(false); setPicked(""); }}
        style={{
          background: "transparent", border: `1px solid ${tk.border}`,
          color: tk.ink3, borderRadius: tk.r2, padding: "3px 8px", fontSize: 12,
        }}
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pulse row
// ---------------------------------------------------------------------------

function PulseRow({
  pulse,
  contexts,
  onChanged,
}: {
  pulse: PulseRef;
  contexts: ContextRef[];
  onChanged: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const subs = pulse.subscribers ?? [];

  return (
    <div style={{
      padding: "10px 16px",
      borderBottom: `1px solid ${tk.border2}`,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: "50%", marginTop: 5, flexShrink: 0,
          background: statusColor(pulse.status),
        }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded(v => !v)}
            style={{ cursor: "pointer", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: 13, fontWeight: 510, color: tk.ink, fontFamily: tk.fontUi }}>
              {pulseLabel(pulse)}
            </span>
            <span style={{ fontSize: 11, color: tk.ink4, fontFamily: "monospace" }}>
              {triggerSummary(pulse.trigger)}
            </span>
            <span style={{ fontSize: 10.5, color: statusColor(pulse.status), textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {pulse.status}
            </span>
          </div>
          <div style={{ fontSize: 11, color: tk.ink3, marginTop: 2, display: "flex", gap: 10 }}>
            <span>{subs.length} subscriber{subs.length !== 1 ? "s" : ""}</span>
            <span>fired {pulse.fire_count}×</span>
            {pulse.next_fire_at && <span>next {absoluteTime(pulse.next_fire_at)}</span>}
            {pulse.last_fired_at && <span>last fired {relativeTime(pulse.last_fired_at)}</span>}
          </div>

          {expanded && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${tk.border2}` }}>
              {subs.length === 0 && (
                <div style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic", marginBottom: 4 }}>
                  Not connected to any context or actor.
                </div>
              )}
              {subs.map((s, i) => (
                <SubscriberRow
                  key={i}
                  subscriber={s}
                  contexts={contexts}
                  removing={busy === `unsub-${i}`}
                  onRemove={() => void run(`unsub-${i}`, () => unsubscribePulse(pulse.pulse_id, s))}
                />
              ))}
              <ConnectContextControl
                contexts={contexts}
                onConnect={async (contextId) => {
                  await run("subscribe", () => subscribePulse(pulse.pulse_id, { kind: "context", context_id: contextId }));
                }}
              />
            </div>
          )}

          {err && <div role="alert" style={{ fontSize: 11.5, color: tk.danger, marginTop: 4 }}>{err}</div>}
        </div>

        {/* Lifecycle actions */}
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {pulse.status === "active" && (
            <button
              onClick={() => void run("pause", () => pausePulse(pulse.pulse_id))}
              disabled={busy !== null}
              style={actionBtnStyle(tk.ink3)}
            >
              {busy === "pause" ? "…" : "Pause"}
            </button>
          )}
          {pulse.status === "paused" && (
            <button
              onClick={() => void run("resume", () => resumePulse(pulse.pulse_id))}
              disabled={busy !== null}
              style={actionBtnStyle(tk.accentHov)}
            >
              {busy === "resume" ? "…" : "Resume"}
            </button>
          )}
          {(pulse.status === "active" || pulse.status === "paused") && (
            <button
              onClick={() => {
                if (window.confirm(`Cancel pulse "${pulseLabel(pulse)}"? This cannot be undone.`)) {
                  void run("cancel", () => cancelPulse(pulse.pulse_id));
                }
              }}
              disabled={busy !== null}
              style={actionBtnStyle(tk.danger)}
            >
              {busy === "cancel" ? "…" : "Cancel"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function actionBtnStyle(color: string): React.CSSProperties {
  return {
    background: "transparent", border: `1px solid ${color}`,
    color, borderRadius: tk.r1, padding: "3px 9px",
    fontSize: 11.5, cursor: "pointer", fontWeight: 510,
  };
}

// ---------------------------------------------------------------------------
// Create pulse form
// ---------------------------------------------------------------------------

function CreatePulseForm({
  workspaceId,
  scopeId,
  contexts,
  onCreated,
}: {
  workspaceId: string;
  scopeId: string;
  contexts: ContextRef[];
  onCreated: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<"once" | "cron">("once");
  const [at, setAt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [timezone, setTimezone] = useState("");
  const [text, setText] = useState("");
  const [contextId, setContextId] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setName(""); setAt(""); setSchedule(""); setTimezone(""); setText(""); setContextId("");
    setTriggerType("once"); setErr(null);
  }

  async function handleCreate() {
    const pulseId = name.trim();
    if (!pulseId) { setErr("Name is required."); return; }
    if (triggerType === "once" && !at.trim()) { setErr("Pick a date/time for a one-off pulse."); return; }
    if (triggerType === "cron" && !schedule.trim()) { setErr("Enter a cron expression for a recurring pulse."); return; }

    setCreating(true);
    setErr(null);
    try {
      const trigger = triggerType === "once"
        ? { type: "once" as const, at: new Date(at).toISOString() }
        : { type: "cron" as const, schedule: schedule.trim(), timezone: timezone.trim() || undefined };

      const subscribers: PulseSubscriber[] = contextId
        ? [{ kind: "context", context_id: contextId }]
        : [];

      await createPulse({
        pulse_id: pulseId,
        workspace_id: workspaceId,
        scope_id: scopeId,
        persistence: "local",
        trigger,
        content: text.trim() ? { text: text.trim() } : {},
        subscribers,
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create pulse");
    } finally {
      setCreating(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "transparent", border: `1px dashed ${tk.border}`,
          color: tk.accentHov, borderRadius: tk.r2, padding: "6px 12px",
          fontSize: 12.5, cursor: "pointer", margin: "8px 28px",
        }}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
        <span>New pulse</span>
      </button>
    );
  }

  return (
    <div
      role="form"
      aria-label="Create pulse"
      style={{
        margin: "8px 28px", padding: 14,
        border: `1px solid ${tk.accent}`, borderRadius: tk.r3,
        background: tk.surfaceHov,
        display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <input
        autoFocus
        placeholder="Pulse name (e.g. daily_standup_reminder)"
        value={name}
        onChange={e => setName(e.target.value)}
        style={inputStyle}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <select value={triggerType} onChange={e => setTriggerType(e.target.value as "once" | "cron")} style={{ ...inputStyle, flex: "0 0 140px" }}>
          <option value="once">Once</option>
          <option value="cron">Recurring (cron)</option>
        </select>
        {triggerType === "once" ? (
          <input
            type="datetime-local"
            value={at}
            onChange={e => setAt(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
        ) : (
          <>
            <input
              placeholder="Cron expression, e.g. 0 9 * * *"
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              style={{ ...inputStyle, flex: 1, fontFamily: "monospace" }}
            />
            <input
              placeholder="Timezone (optional)"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              style={{ ...inputStyle, flex: "0 0 140px" }}
            />
          </>
        )}
      </div>

      <input
        placeholder="Message text (optional)"
        value={text}
        onChange={e => setText(e.target.value)}
        style={inputStyle}
      />

      <select value={contextId} onChange={e => setContextId(e.target.value)} style={inputStyle}>
        <option value="">No context connection (connect later)</option>
        {contexts.map(c => (
          <option key={c.context_id} value={c.context_id}>Connect to: {contextLabel(c)}</option>
        ))}
      </select>

      {err && <p role="alert" style={{ color: tk.danger, fontSize: 12, margin: 0 }}>{err}</p>}

      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim()}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "5px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 510,
          }}
        >
          {creating ? "Creating…" : "Create pulse"}
        </button>
        <button
          onClick={() => { setOpen(false); reset(); }}
          style={{
            background: "transparent", border: `1px solid ${tk.border}`,
            color: tk.ink3, borderRadius: tk.r2, padding: "5px 14px", fontSize: 12.5,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
  borderRadius: tk.r2, padding: "6px 8px", fontSize: 12.5, color: tk.ink,
  outline: "none", fontFamily: "inherit",
};

// ---------------------------------------------------------------------------
// Events list (read-only — see file header: no managed event entity exists)
// ---------------------------------------------------------------------------

function EventRow({ event, contexts }: { event: EventEnvelope; contexts: ContextRef[] }): React.ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 16px", borderBottom: `1px solid ${tk.border2}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: tk.ink, fontWeight: 510, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {event.type}
        </div>
        <div style={{ fontSize: 11, color: tk.ink3, marginTop: 1 }}>
          in {contextLabelById(contexts, event.context_id)}
        </div>
      </div>
      <span style={{ fontSize: 11, color: tk.ink4, flexShrink: 0 }}>{relativeTime(event.created_at)}</span>
    </div>
  );
}

function EventsSection({
  workspaceId,
  scopeId,
  contexts,
}: {
  workspaceId: string;
  scopeId: string;
  contexts: ContextRef[];
}): React.ReactElement {
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listEvents({ workspace_id: workspaceId, scope_id: scopeId, limit: 50 })
      .then(res => {
        setEvents(res.events);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load events");
        setLoading(false);
      });
  }, [workspaceId, scopeId]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh on push: reload when any event is submitted to this scope.
  useEffect(() => {
    const unsub = subscribeEvents((msg) => {
      if (msg.type === "event_submitted") {
        const event = (msg.payload as { event?: { scope_id?: string; workspace_id?: string } }).event;
        if (event?.workspace_id === workspaceId && event?.scope_id === scopeId) {
          load();
        }
      }
    }, { workspaceId });
    return unsub;
  }, [workspaceId, scopeId, load]);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "12px 28px 8px",
        fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
        color: tk.ink3, fontWeight: 510,
      }}>
        <span>Events</span>
        {!loading && (
          <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
            {events.length}
          </span>
        )}
      </div>
      <p style={{ margin: "0 28px 8px", fontSize: 11.5, color: tk.ink4, lineHeight: 1.4 }}>
        Events are emitted messages — read-only here. Pulses below create the recurring/scheduled ones.
      </p>

      {loading && <div style={{ padding: "12px 28px", color: tk.ink3, fontSize: 13 }}>Loading events…</div>}
      {error && <div role="alert" style={{ padding: "12px 28px", color: tk.danger, fontSize: 13 }}>{error}</div>}
      {!loading && !error && events.length === 0 && (
        <div style={{ padding: "16px 28px", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
          No events in this scope yet.
        </div>
      )}
      {!loading && !error && events.length > 0 && (
        <div role="list" aria-label="Events in scope">
          {events.map(ev => <EventRow key={ev.event_id} event={ev} contexts={contexts} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pulses section
// ---------------------------------------------------------------------------

function PulsesSection({
  workspaceId,
  scopeId,
  contexts,
}: {
  workspaceId: string;
  scopeId: string;
  contexts: ContextRef[];
}): React.ReactElement {
  const [pulses, setPulses] = useState<PulseRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    queryPulses({ workspace_id: workspaceId, scope_id: scopeId })
      .then(rows => {
        setPulses(rows);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load pulses");
        setLoading(false);
      });
  }, [workspaceId, scopeId]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh on push: reload on any pulse lifecycle broadcast for this scope.
  useEffect(() => {
    const PULSE_EVENTS = new Set([
      "pulse_created",
      "pulse_paused",
      "pulse_resumed",
      "pulse_cancelled",
      "pulse_fired",
      "pulse_subscriber_changed",
    ]);
    const unsub = subscribeEvents((msg) => {
      if (!PULSE_EVENTS.has(msg.type)) return;
      // Most pulse broadcasts include a `pulse` object with workspace_id + scope_id.
      // pulse_fired only has pulse_id; in that case reload unconditionally (cheap).
      const pulse = (msg.payload as { pulse?: { workspace_id?: string; scope_id?: string } }).pulse;
      if (pulse) {
        if (pulse.workspace_id === workspaceId && pulse.scope_id === scopeId) {
          load();
        }
      } else {
        load();
      }
    }, { workspaceId });
    return unsub;
  }, [workspaceId, scopeId, load]);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "12px 28px 8px",
        fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
        color: tk.ink3, fontWeight: 510,
      }}>
        <span>Pulses</span>
        {!loading && (
          <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
            {pulses.length}
          </span>
        )}
      </div>

      <CreatePulseForm
        workspaceId={workspaceId}
        scopeId={scopeId}
        contexts={contexts}
        onCreated={load}
      />

      {loading && <div style={{ padding: "12px 28px", color: tk.ink3, fontSize: 13 }}>Loading pulses…</div>}
      {error && <div role="alert" style={{ padding: "12px 28px", color: tk.danger, fontSize: 13 }}>{error}</div>}
      {!loading && !error && pulses.length === 0 && (
        <div style={{ padding: "16px 28px", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
          No pulses in this scope yet.
        </div>
      )}
      {!loading && !error && pulses.length > 0 && (
        <div role="list" aria-label="Pulses in scope">
          {pulses.map(p => (
            <PulseRow key={p.pulse_id} pulse={p} contexts={contexts} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ops — top-level export
// ---------------------------------------------------------------------------

export type OpsProps = {
  workspaceId: string;
  scopeId: string;
};

export function Ops({ workspaceId, scopeId }: OpsProps): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);

  useEffect(() => {
    listContexts(workspaceId, { scope: "scoped" })
      .then(rows => setContexts(rows.filter(c => c.scope_id === scopeId)))
      .catch(() => setContexts([]));
  }, [workspaceId, scopeId]);

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <PulsesSection workspaceId={workspaceId} scopeId={scopeId} contexts={contexts} />
      <div style={{ height: 1, background: tk.border, margin: "12px 28px" }} />
      <EventsSection workspaceId={workspaceId} scopeId={scopeId} contexts={contexts} />
    </div>
  );
}
