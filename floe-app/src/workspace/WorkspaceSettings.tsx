/**
 * WorkspaceSettings — main-area view (Slice 3), reached via the gear/"Settings"
 * affordance next to the workspace switcher in the topbar.
 *
 * Replaces the old read-only workspace "bindings" popup. "Workspace model"
 * is the model choice for the workspace's declared `floe` Actor — the same
 * Actor definition, Runtime Profile and binding operations used everywhere
 * else a model is chosen (see FloeModelControl.tsx and ADR-0012). This view
 * no longer treats `profiles.yaml` or the legacy workspace_default/agent
 * runtime-binding projection as a source of truth.
 */
import React, { useState } from "react";
import type { EndpointRef, WorkspaceRef } from "../bus-client/types.ts";
import { findFloeEndpoint } from "../features/conversations/OperatorConversations.tsx";
import { FloeModelControl } from "./FloeModelControl.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas: "#08090a",
  surface: "#0f1011",
  border: "rgba(255,255,255,0.08)",
  border2: "rgba(255,255,255,0.05)",
  ink: "#f7f8f8",
  ink2: "#d0d6e0",
  ink3: "#8a8f98",
  ink4: "#62666d",
  accent: "#8aa89c",
  danger: "#b85a5a",
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3,
  r2: 5,
  r3: 8,
} as const;

export type WorkspaceSettingsProps = {
  workspace: WorkspaceRef;
  endpoints: EndpointRef[];
  onRemove: (deleteLocator?: boolean) => Promise<void>;
};

type PendingRemoval = "remove" | "delete" | null;

export function WorkspaceSettings({ workspace, endpoints, onRemove }: WorkspaceSettingsProps): React.ReactElement {
  const [, setModelReady] = useState(false);
  const floeEndpoint = findFloeEndpoint(endpoints);
  const [pending, setPending] = useState<PendingRemoval>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function confirmRemoval() {
    if (!pending) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemove(pending === "delete");
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Floe could not complete this action.");
    } finally {
      setRemoving(false);
      setPending(null);
    }
  }

  return (
    <div style={{ padding: "24px 32px 40px", overflow: "auto", flex: 1, fontFamily: tk.fontUi }} data-testid="workspace-settings">
      <section style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 8 }}>
          Floe
        </div>
        <h1 style={{ fontWeight: 510, fontSize: 30, lineHeight: 1.1, letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 6px" }}>
          Settings
        </h1>
        <p style={{ color: tk.ink3, fontSize: 13.5, margin: 0 }}>
          Defaults for {workspace.name || workspace.workspace_id}.
        </p>
      </section>

      <section style={{
        background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3,
        padding: 20, maxWidth: 620,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 510, color: tk.ink, margin: "0 0 4px" }}>
          Workspace model
        </h2>
        <p style={{ fontSize: 12.5, color: tk.ink3, lineHeight: 1.5, margin: "0 0 16px" }}>
          Choose what Floe normally uses in {workspace.name || "this workspace"}. More specialised actors can still use a different model when needed.
        </p>

        {floeEndpoint ? (
          <FloeModelControl
            workspaceId={workspace.workspace_id}
            endpointId={floeEndpoint.endpoint_id}
            onReadyChange={setModelReady}
          />
        ) : (
          <span style={{ fontSize: 12, color: tk.ink4 }}>Floe has not finished setting up this workspace's collaborator yet.</span>
        )}
      </section>

      {/* ---- Danger zone ---- */}
      <section style={{
        marginTop: 32, maxWidth: 480,
        background: tk.surface, border: `1px solid rgba(184,90,90,0.25)`, borderRadius: tk.r3,
        padding: 20,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 510, color: tk.danger, margin: "0 0 4px" }}>
          Danger zone
        </h2>
        <p style={{ fontSize: 12.5, color: tk.ink3, lineHeight: 1.5, margin: "0 0 16px" }}>
          Remove this workspace from Floe, or permanently delete all project files.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={() => { setRemoveError(null); setPending("remove"); }}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", borderRadius: tk.r2,
              background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
              color: tk.ink, fontSize: 13, fontFamily: tk.fontUi, cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.07)"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"}
          >
            <span style={{ flex: "0 0 auto", fontSize: 15 }}>🗂</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 510 }}>Remove from Floe</span>
              <span style={{ display: "block", fontSize: 11, color: tk.ink3, marginTop: 2 }}>
                Deregister this workspace. Project files remain on disk.
              </span>
            </span>
          </button>
          <button
            onClick={() => { setRemoveError(null); setPending("delete"); }}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", borderRadius: tk.r2,
              background: "rgba(184,90,90,0.08)", border: `1px solid rgba(184,90,90,0.25)`,
              color: tk.danger, fontSize: 13, fontFamily: tk.fontUi, cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(184,90,90,0.15)"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(184,90,90,0.08)"}
          >
            <span style={{ flex: "0 0 auto", fontSize: 15 }}>🗑</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 510 }}>Delete workspace and files</span>
              <span style={{ display: "block", fontSize: 11, color: tk.ink3, marginTop: 2 }}>
                Permanently remove this workspace and delete all project files from disk.
              </span>
            </span>
          </button>
        </div>

        {pending && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid rgba(184,90,90,0.25)` }}>
            <p style={{ fontSize: 12.5, color: tk.ink2, margin: "0 0 10px" }} role="alert">
              {pending === "delete"
                ? `Permanently delete "${workspace.name || workspace.workspace_id}" and all its project files from disk? This cannot be undone.`
                : `Remove "${workspace.name || workspace.workspace_id}" from Floe? The files will remain on disk.`}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={removing}
                onClick={() => void confirmRemoval()}
                style={{
                  padding: "7px 14px", borderRadius: tk.r2,
                  background: "rgba(184,90,90,0.16)", border: `1px solid rgba(184,90,90,0.4)`,
                  color: tk.danger, fontSize: 12.5, fontFamily: tk.fontUi, cursor: "pointer",
                }}
              >
                {removing ? "Working…" : pending === "delete" ? "Delete permanently" : "Remove workspace"}
              </button>
              <button
                disabled={removing}
                onClick={() => setPending(null)}
                style={{
                  padding: "7px 14px", borderRadius: tk.r2,
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
                  color: tk.ink2, fontSize: 12.5, fontFamily: tk.fontUi, cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {removeError && <p role="alert" style={{ marginTop: 10, fontSize: 12, color: tk.danger }}>{removeError}</p>}
      </section>
    </div>
  );
}

