/**
 * ActorInspector — right-inspector content for a selected actor (Slice 3).
 *
 * Inline-editable, v6 style (no modal):
 *  - Name and instructions: editable through immutable Actor-definition
 *    revisions; Endpoint rows remain an addressability projection.
 *  - Profile -> Model -> Effort (scope="agent"): selecting a profile constrains
 *    the Model dropdown to that profile's provider (see modelsForProfile.ts,
 *    using the shared profile/provider model helper).
 *    Clearing the profile removes the agent-level binding entirely
 *    (clearRuntimeBindings) so the actor falls back to workspace/global.
 *  - Effective resolved binding (resolveRuntimeBinding) shown with layer
 *    labels (actor / workspace / global) so inheritance is visible.
 */
import React, { useCallback, useEffect, useState } from "react";
import type {
  AuthModelRecord,
  AuthProfileRecord,
  ContextRef,
  EndpointRef,
  RuntimeBindingResolution,
} from "../bus-client/types.ts";
import {
  getAuthProfiles,
  resolveRuntimeBinding,
  upsertRuntimeBinding,
  clearRuntimeBindings,
  listContextsByParticipant,
} from "../bus-client/client.ts";
import { inspectActorDefinition, reviseActorDefinition } from "./actorDefinitionOperations.ts";
import { createDirectConversation } from "../features/conversations/contextCommunication.ts";
import { modelsForProfile, withSelectedModelOption, providerForProfile } from "./modelsForProfile.ts";
import { contextLabel } from "../scope/ScopeDetail.tsx";
import type { WorkspaceFsRef } from "../fs/workspaceFs.ts";
import { ActorBodyEditor } from "./ActorBodyEditor.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas: "#08090a",
  surface: "#0f1011",
  surfaceHov: "#191a1b",
  border: "rgba(255,255,255,0.08)",
  border2: "rgba(255,255,255,0.05)",
  ink: "#f7f8f8",
  ink2: "#d0d6e0",
  ink3: "#8a8f98",
  ink4: "#62666d",
  accent: "#8aa89c",
  accentHov: "#a1bcb1",
  danger: "#b85a5a",
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3,
  r2: 5,
  r3: 8,
} as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

// ---------------------------------------------------------------------------
// Shared field chrome
// ---------------------------------------------------------------------------

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3, fontFamily: tk.fontUi }}>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  padding: "6px 8px",
  fontSize: 13,
  color: tk.ink,
  fontFamily: tk.fontUi,
  outline: "none",
};

const selectStyle: React.CSSProperties = { ...inputStyle };

function StatRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "5px 0", fontSize: 12, borderBottom: `1px solid ${tk.border2}`,
      gap: 12, fontFamily: tk.fontUi,
    }}>
      <span style={{ color: tk.ink3, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tk.ink, fontWeight: 510, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
}

/** Layer-labeled resolved value: shows which layer (actor/workspace/global) supplied it. */
function ResolvedRow({
  label,
  endpointValue,
  workspaceValue,
  globalValue,
}: {
  label: string;
  endpointValue: string | null;
  workspaceValue: string | null;
  globalValue: string | null;
}): React.ReactElement {
  const value = endpointValue ?? workspaceValue ?? globalValue;
  const layer = endpointValue ? "actor" : workspaceValue ? "workspace" : globalValue ? "global" : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: "2px 8px", fontSize: 11, fontFamily: tk.fontUi }}>
      <span style={{ color: tk.ink3 }}>{label}</span>
      <span>
        <code style={{ fontSize: 11, color: tk.ink }}>{value ?? "(none)"}</code>
        {layer && (
          <span style={{ color: layer === "actor" ? tk.accent : tk.ink4, marginLeft: 6 }}>
            ({layer})
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save status chip
// ---------------------------------------------------------------------------

type SaveState = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

function SaveStatus({ state }: { state: SaveState }): React.ReactElement | null {
  if (state.phase === "idle") return null;
  if (state.phase === "saving") return <span style={{ fontSize: 11, color: tk.ink3 }}>Saving…</span>;
  if (state.phase === "saved") return <span style={{ fontSize: 11, color: tk.accent }}>Saved</span>;
  return <span role="alert" style={{ fontSize: 11, color: tk.danger }}>{state.message}</span>;
}

// ---------------------------------------------------------------------------
// Contexts the actor participates in (Gap A — v6 parity)
// ---------------------------------------------------------------------------
// v6 shows this in the inspector when an actor is selected ("Click an actor
// to see what they participate in" — Home hero copy). We mirror that: a
// list of contexts by human name, each clickable to open that context's
// conversation.

export function ActorContexts({
  endpointId,
  workspaceId,
  onOpenContext,
  endpoints = [],
  canStartContext = true,
}: {
  endpointId: string;
  workspaceId: string;
  onOpenContext: (contextId: string) => void;
  endpoints?: EndpointRef[];
  canStartContext?: boolean;
}): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Participant picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedParticipant, setSelectedParticipant] = useState("");
  const [createState, setCreateState] = useState<SaveState>({ phase: "idle" });

  const otherEndpoints = endpoints.filter((e) => e.endpoint_id !== endpointId && e.status !== "retired");

  function fetchContexts() {
    setLoading(true);
    setError(null);
    listContextsByParticipant({ participant: endpointId, workspace_id: workspaceId })
      .then(rows => {
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
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listContextsByParticipant({ participant: endpointId, workspace_id: workspaceId })
      .then(rows => {
        if (cancelled) return;
        const sorted = [...rows].sort((a, b) => {
          const ta = a.last_event_at ?? a.created_at;
          const tb = b.last_event_at ?? b.created_at;
          return tb.localeCompare(ta);
        });
        setContexts(sorted);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load contexts");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [endpointId, workspaceId]);

  async function handleCreate() {
    if (!selectedParticipant) return;
    setCreateState({ phase: "saving" });
    try {
      const newCtx = await createDirectConversation(workspaceId, [endpointId, selectedParticipant]);
      setCreateState({ phase: "saved" });
      setPickerOpen(false);
      setSelectedParticipant("");
      onOpenContext(newCtx.context_id);
      fetchContexts();
    } catch (err) {
      setCreateState({ phase: "error", message: err instanceof Error ? err.message : "Failed to create context" });
    }
  }

  return (
    <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
        color: tk.ink3, fontWeight: 510,
      }}>
        <span>Conversations</span>
        {!loading && (
          <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
            {contexts.length}
          </span>
        )}
        {canStartContext && (
          <button
            onClick={() => { setPickerOpen(true); setCreateState({ phase: "idle" }); setSelectedParticipant(otherEndpoints[0]?.endpoint_id ?? ""); }}
            aria-label="New context"
            style={{
              marginLeft: "auto", background: "transparent",
              border: `1px solid ${tk.border}`, color: tk.ink3,
              borderRadius: tk.r1, padding: "2px 8px", fontSize: 10.5,
              cursor: "pointer", fontFamily: tk.fontUi, textTransform: "none", letterSpacing: 0,
            }}
          >
            + New
          </button>
        )}
      </div>

      {pickerOpen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px", background: "rgba(255,255,255,0.03)", borderRadius: tk.r2, border: `1px solid ${tk.border}` }}>
          {otherEndpoints.length === 0 ? (
            <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>No other actors in workspace.</span>
          ) : (
            <select
              aria-label="Select participant"
              value={selectedParticipant}
              onChange={(e) => setSelectedParticipant(e.target.value)}
              style={{ ...selectStyle, fontSize: 12 }}
            >
              {otherEndpoints.map((e) => (
                <option key={e.endpoint_id} value={e.endpoint_id}>{e.name || e.endpoint_id}</option>
              ))}
            </select>
          )}
          {createState.phase === "error" && (
            <span role="alert" style={{ fontSize: 11, color: tk.danger }}>{createState.message}</span>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => void handleCreate()}
              disabled={createState.phase === "saving" || !selectedParticipant}
              style={{
                background: tk.accent, color: "#0c1714", border: "none",
                borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5, fontWeight: 510,
                cursor: createState.phase === "saving" || !selectedParticipant ? "not-allowed" : "pointer",
                fontFamily: tk.fontUi,
              }}
            >
              {createState.phase === "saving" ? "Creating…" : "Confirm"}
            </button>
            <button
              onClick={() => { setPickerOpen(false); setSelectedParticipant(""); setCreateState({ phase: "idle" }); }}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5,
                fontFamily: tk.fontUi, cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && <span style={{ fontSize: 12, color: tk.ink3 }}>Loading…</span>}

      {error && <span role="alert" style={{ fontSize: 12, color: tk.danger }}>{error}</span>}

      {!loading && !error && contexts.length === 0 && (
        <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
          Not participating in any contexts.
        </span>
      )}

      {!loading && !error && contexts.length > 0 && (
        <div role="list" aria-label="Contexts this actor participates in" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {contexts.map(ctx => (
            <button
              key={ctx.context_id}
              role="listitem"
              onClick={() => onOpenContext(ctx.context_id)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
                width: "100%", textAlign: "left",
                background: "transparent", border: `1px solid ${tk.border}`,
                borderRadius: tk.r2, padding: "7px 10px", cursor: "pointer",
                fontFamily: tk.fontUi,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = tk.surfaceHov; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{
                fontSize: 12.5, color: tk.ink, fontWeight: 510,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%",
              }}>
                {contextLabel(ctx)}
              </span>
              <span style={{ fontSize: 10.5, color: tk.ink4 }}>
                {ctx.scope_id ? "in scope" : "direct · no scope"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle note
// ---------------------------------------------------------------------------

export function ActorLifecycleNote({ actor }: { actor: EndpointRef }): React.ReactElement {
  return (
    <div style={{ padding: "12px 16px" }}>
      <p style={{ margin: 0, fontSize: 12, color: tk.ink3, lineHeight: 1.5 }}>
        {actor.status === "retired"
          ? "This historical actor identity is retained so earlier conversations and Events remain attributable. It cannot receive new work."
          : "Ask Floe to remove an unused actor so its workspace definition and durable identity are handled together."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canonical definition for bridge-addressable actors
// ---------------------------------------------------------------------------
// Existing `.floe/agents/<id>.md` files remain preserved import sources. The
// app edits the published Actor definition through the shared operation
// contract instead of creating a second direct-write authority.

type DefinitionLoadState =
  | { phase: "loading" }
  | { phase: "loaded"; revisionId: string; body: string }
  | { phase: "error"; message: string };

/** Returns the extension name if this actor is supplied by an extension (sentinel file). */
export function actorExtensionName(actor: EndpointRef): string | null {
  if (!actor.metadata_json) return null;
  try {
    const meta = JSON.parse(actor.metadata_json) as { file?: unknown };
    if (typeof meta.file !== "string") return null;
    const m = meta.file.match(/^\[extension:(.+)]$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function actorFileRelPath(actor: EndpointRef): string | null {
  if (!actor.metadata_json) return null;
  // Extension-provided actors use a sentinel (e.g. "[extension:acme]") — no on-disk file.
  if (actorExtensionName(actor) !== null) return null;
  try {
    const meta = JSON.parse(actor.metadata_json) as { file?: unknown };
    if (typeof meta.file !== "string" || !meta.file) return null;
    return `.floe/${meta.file}`;
  } catch {
    return null;
  }
}

export function ActorFileSection({
  actor,
}: {
  actor: EndpointRef;
  workspace: WorkspaceFsRef | null;
}): React.ReactElement | null {
  const [state, setState] = useState<DefinitionLoadState>({ phase: "loading" });
  const [body, setBody] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });
  const relPath = actorFileRelPath(actor);

  useEffect(() => {
    let cancelled = false;
    setSaveState({ phase: "idle" });
    setState({ phase: "loading" });
    inspectActorDefinition(actor.workspace_id, actor.endpoint_id)
      .then((inspection) => {
        if (cancelled) return;
        const current = inspection.current_definition;
        if (!current) throw new Error("This Actor has no published definition.");
        setBody(current.content.instructions);
        setState({
          phase: "loaded",
          revisionId: current.actor_definition_revision_id,
          body: current.content.instructions,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to read actor file" });
      });
    return () => { cancelled = true; };
  }, [actor.endpoint_id, actor.workspace_id]);

  // Extension-provided actors have no on-disk config file — show a read-only note
  // regardless of FS availability (their definition lives in the extension, not on disk).
  const extensionName = actorExtensionName(actor);
  if (extensionName !== null) {
    let frontmatterInfo: React.ReactNode = null;
    try {
      if (actor.metadata_json) {
        const meta = JSON.parse(actor.metadata_json) as { frontmatter?: { runtime?: { engine?: string }; extensions?: string[]; pulse?: unknown } };
        if (meta.frontmatter) {
          const fm = meta.frontmatter;
          const engine = fm.runtime?.engine ?? "pi";
          const exts = (fm.extensions ?? []).join(", ");
          frontmatterInfo = (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {engine && <span style={{ fontSize: 11, color: tk.ink3 }}><span style={{ color: tk.ink4 }}>Engine: </span>{engine}</span>}
              {exts && <span style={{ fontSize: 11, color: tk.ink3 }}><span style={{ color: tk.ink4 }}>Extensions: </span>{exts}</span>}
            </div>
          );
        }
      }
    } catch { /* ignore */ }
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <p style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic", margin: 0 }}>
          This actor is provided by the <strong style={{ color: tk.ink3, fontStyle: "normal" }}>{extensionName}</strong> extension.
          Its definition is managed by the extension and is not editable on disk.
        </p>
        {frontmatterInfo}
      </div>
    );
  }

  if (state.phase === "loading") {
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <span style={{ fontSize: 12, color: tk.ink3 }}>Loading definition…</span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <p role="alert" style={{ fontSize: 12, color: tk.danger, margin: 0 }}>{state.message}</p>
      </div>
    );
  }

  if (state.phase !== "loaded") return null;

  async function handleSave() {
    setSaveState({ phase: "saving" });
    try {
      const published = await reviseActorDefinition(
        actor.workspace_id,
        actor.endpoint_id,
        definition => ({ ...definition, instructions: body }),
      );
      setState({
        phase: "loaded",
        revisionId: published.revision.actor_definition_revision_id,
        body: published.revision.content.instructions,
      });
      setSaveState({ phase: "saved" });
    } catch (err) {
      setSaveState({ phase: "error", message: err instanceof Error ? err.message : "Failed to save actor file" });
    }
  }

  return (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}`, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
        Definition
      </div>
      <StatRow label="Revision" value={<code style={{ fontSize: 11 }}>{state.revisionId}</code>} />
      {relPath && (
        <p style={{ fontSize: 11, color: tk.ink4, lineHeight: 1.5, margin: 0 }}>
          The existing <code>{relPath}</code> file is preserved as imported configuration. Changes here create a new canonical Actor definition revision.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, color: tk.ink3 }}>Instructions (markdown body)</span>
        <ActorBodyEditor value={body} onChange={setBody} minHeight={160} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => void handleSave()}
          disabled={saveState.phase === "saving"}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "6px 14px", fontSize: 12.5, fontWeight: 510,
            cursor: saveState.phase === "saving" ? "not-allowed" : "pointer",
            fontFamily: tk.fontUi,
          }}
        >
          {saveState.phase === "saving" ? "Saving…" : "Save instructions"}
        </button>
        <SaveStatus state={saveState} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ActorInspectorProps = {
  actor: EndpointRef;
  workspaceId: string;
  /** Selected workspace's identity (workspace_id + locator) — required for file-backed actor editing. */
  workspace?: WorkspaceFsRef | null;
  onSaved?: (updated: EndpointRef) => void;
  /** Open this context's conversation (sets selected context + switches main view). */
  onOpenContext?: (contextId: string) => void;
  hideContexts?: boolean;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActorInspector({
  actor,
  workspaceId,
  workspace,
  onSaved,
  onOpenContext,
  hideContexts,
}: ActorInspectorProps): React.ReactElement {
  // Name editing
  const [name, setName] = useState(actor.name);
  const [nameSave, setNameSave] = useState<SaveState>({ phase: "idle" });

  // Auth profiles + models
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [models, setModels] = useState<AuthModelRecord[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Binding form state (uncommitted draft mirrors current agent binding)
  const [profileId, setProfileId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [effort, setEffort] = useState<string>("off");
  const [bindingSave, setBindingSave] = useState<SaveState>({ phase: "idle" });

  // Resolved (effective) binding for inheritance display
  const [resolution, setResolution] = useState<RuntimeBindingResolution | null>(null);
  const [resolutionLoading, setResolutionLoading] = useState(true);

  const loadResolution = useCallback(() => {
    setResolutionLoading(true);
    resolveRuntimeBinding(workspaceId, actor.endpoint_id)
      .then((res) => {
        setResolution(res);
        setResolutionLoading(false);
        // Seed the editable binding form from the actor-level (not inherited) values.
        setProfileId(res.endpoint_auth_profile ?? "");
        setModelId(res.endpoint_model ?? "");
        setEffort(res.endpoint_thinking_level ?? "off");
      })
      .catch(() => setResolutionLoading(false));
  }, [workspaceId, actor.endpoint_id]);

  // Reset all local state when the selected actor changes.
  useEffect(() => {
    setName(actor.name);
    setNameSave({ phase: "idle" });
    setBindingSave({ phase: "idle" });
    loadResolution();
  }, [actor.endpoint_id, actor.name, loadResolution]);

  // Load auth profiles once.
  useEffect(() => {
    let cancelled = false;
    getAuthProfiles()
      .then((res) => { if (!cancelled) setProfiles(res.profiles); })
      .catch(() => { if (!cancelled) setProfiles([]); });
    return () => { cancelled = true; };
  }, []);

  // Constrain models to the selected profile's provider whenever profileId changes.
  useEffect(() => {
    if (!profileId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    modelsForProfile(profiles, profileId)
      .then((list) => { if (!cancelled) { setModels(list); setModelsLoading(false); } })
      .catch(() => { if (!cancelled) { setModels([]); setModelsLoading(false); } });
    return () => { cancelled = true; };
  }, [profiles, profileId]);

  const provider = providerForProfile(profiles, profileId || null);
  const modelOptions = withSelectedModelOption(models, modelId, provider);
  const selectedModel = modelOptions.find((m) => m.id === modelId);
  const reasoningSupported = !!selectedModel?.reasoning;

  async function handleNameSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === actor.name) return;
    setNameSave({ phase: "saving" });
    try {
      const published = await reviseActorDefinition(
        workspaceId,
        actor.endpoint_id,
        definition => ({ ...definition, label: trimmed }),
      );
      const updated: EndpointRef = {
        ...actor,
        name: published.revision.content.label,
        status: published.actor.status,
        updated_at: published.actor.updated_at,
      };
      setNameSave({ phase: "saved" });
      onSaved?.(updated);
    } catch (err) {
      setNameSave({ phase: "error", message: err instanceof Error ? err.message : "Failed to save name" });
    }
  }

  async function saveBinding(next: { profileId: string; modelId: string; effort: string }) {
    setBindingSave({ phase: "saving" });
    try {
      if (!next.profileId) {
        await clearRuntimeBindings({ scope: "agent", workspace_id: workspaceId, endpoint_id: actor.endpoint_id });
      } else {
        const selectedProvider = providerForProfile(profiles, next.profileId);
        if (!selectedProvider) throw new Error("The selected provider account is no longer connected.");
        await upsertRuntimeBinding({
          scope: "agent",
          workspace_id: workspaceId,
          endpoint_id: actor.endpoint_id,
          auth_profile: next.profileId,
          provider: selectedProvider,
          model: next.modelId || null,
          thinking_level: next.modelId ? next.effort || null : null,
        });
      }
      setBindingSave({ phase: "saved" });
      loadResolution();
    } catch (err) {
      setBindingSave({ phase: "error", message: err instanceof Error ? err.message : "Failed to save binding" });
    }
  }

  function handleProfileChange(value: string) {
    setProfileId(value);
    setModelId("");
    setEffort("off");
    void saveBinding({ profileId: value, modelId: "", effort: "off" });
  }

  function handleModelChange(value: string) {
    const nextModel = modelOptions.find((m) => m.id === value);
    const nextReasoningSupported = !!nextModel?.reasoning;
    const nextEffort = nextReasoningSupported ? effort : "off";
    setModelId(value);
    setEffort(nextEffort);
    void saveBinding({ profileId, modelId: value, effort: nextEffort });
  }

  function handleEffortChange(value: string) {
    setEffort(value);
    void saveBinding({ profileId, modelId, effort: value });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto", fontFamily: tk.fontUi }}>
      {/* Head */}
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${tk.border}` }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Actor
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <input
            aria-label="Actor name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void handleNameSave()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleNameSave();
              if (e.key === "Escape") setName(actor.name);
            }}
            style={{ ...inputStyle, flex: 1, fontSize: 15, fontWeight: 510 }}
          />
        </div>
        <div style={{ marginTop: 6 }}>
          <SaveStatus state={nameSave} />
        </div>
      </div>

      {/* Identity */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <StatRow label="Endpoint ID" value={<code style={{ fontSize: 11 }}>{actor.endpoint_id}</code>} />
        <StatRow label="Status" value={actor.status} />
        {actor.agent_id && <StatRow label="Agent" value={<code style={{ fontSize: 11 }}>{actor.agent_id}</code>} />}
        {actor.bridge_id && <StatRow label="Bridge" value={<code style={{ fontSize: 11 }}>{actor.bridge_id}</code>} />}
        <StatRow label="Created" value={new Date(actor.created_at).toLocaleString()} />
      </div>

      {/* Profile -> Model -> Effort */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}`, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Model binding
        </div>

        {profiles.length === 0 ? (
          <p style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic", margin: 0 }}>
            No auth profiles found. Run <code>npm run floe -- login</code>.
          </p>
        ) : (
          <>
            <FieldLabel>
              Profile
              <select
                aria-label="Profile"
                value={profileId}
                onChange={(e) => handleProfileChange(e.target.value)}
                style={selectStyle}
              >
                <option value="">Inherit (no actor override)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.id} ({p.provider})</option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel>
              Model
              <select
                aria-label="Model"
                value={modelId}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={!profileId || modelsLoading}
                style={selectStyle}
              >
                <option value="">{modelsLoading ? "Loading models…" : "Select model"}</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.reasoning ? " · reasoning" : ""}</option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel>
              Effort
              <select
                aria-label="Effort"
                value={effort}
                onChange={(e) => handleEffortChange(e.target.value)}
                disabled={!profileId || !modelId || !reasoningSupported}
                style={selectStyle}
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </FieldLabel>
            {profileId && modelId && !reasoningSupported && (
              <p style={{ fontSize: 11, color: tk.ink4, margin: 0, fontStyle: "italic" }}>
                Selected model doesn't support reasoning effort.
              </p>
            )}
          </>
        )}

        <SaveStatus state={bindingSave} />
      </div>

      {/* Effective resolved binding */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}`, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 4 }}>
          Effective binding (resolved)
        </div>
        {resolutionLoading ? (
          <span style={{ fontSize: 12, color: tk.ink3 }}>Loading…</span>
        ) : resolution ? (
          <>
            <ResolvedRow
              label="Profile"
              endpointValue={resolution.endpoint_auth_profile}
              workspaceValue={resolution.workspace_auth_profile}
              globalValue={resolution.global_auth_profile}
            />
            <ResolvedRow
              label="Model"
              endpointValue={resolution.endpoint_model}
              workspaceValue={resolution.workspace_model}
              globalValue={resolution.global_model}
            />
            <ResolvedRow
              label="Effort"
              endpointValue={resolution.endpoint_thinking_level}
              workspaceValue={resolution.workspace_thinking_level}
              globalValue={resolution.global_thinking_level}
            />
          </>
        ) : (
          <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>Unavailable</span>
        )}
      </div>

      {/* Contexts this actor participates in (Gap A — v6 parity) */}
      {!hideContexts && (
        <div style={{ borderBottom: `1px solid ${tk.border2}` }}>
          <ActorContexts
            endpointId={actor.endpoint_id}
            workspaceId={workspaceId}
            onOpenContext={(contextId) => onOpenContext?.(contextId)}
            canStartContext={actor.status !== "retired"}
          />
        </div>
      )}

      {/* File-backed definition (frontmatter + body) — Tauri only */}
      <ActorFileSection actor={actor} workspace={workspace ?? null} />

      {/* Lifecycle is changed through Floe so configuration and durable identity stay coherent. */}
      <div style={{ borderTop: `1px solid ${tk.border2}` }}>
        <ActorLifecycleNote actor={actor} />
      </div>
    </div>
  );
}
