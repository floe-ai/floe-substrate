/**
 * App — v6 shell: topbar + 240px left nav + resizable right inspector.
 *
 * App.tsx acts as a thin orchestrator layer connecting views, layout, and state.
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WorkspaceRef, ScopeRef, EndpointRef, AuthProfileRecord } from "./bus-client/types.ts";
import {
  listWorkspaces,
  listScopes,
  createScope,
  listEndpoints,
  subscribeEvents,
  registerWorkspace,
  deleteWorkspace,
  getAuthProfiles,
  getRuntimeStatus,
  upsertRuntimeBinding,
  DirectoryNotFoundError,
} from "./bus-client/client.ts";
import { ScopeDetail } from "./scope/ScopeDetail.tsx";
import { ContextConversation } from "./scope/ContextConversation.tsx";
import { ContextInspector } from "./scope/ContextInspector.tsx";
import { NewActorForm } from "./actors/NewActorForm.tsx";
import { canonicalActorEndpoints } from "./actors/actorDefinitionOperations.ts";
import { WorkspaceSettings } from "./workspace/WorkspaceSettings.tsx";
import { Activity } from "./activity/Activity.tsx";

import { LeftNav } from "./app/layout/LeftNav.tsx";
import { HomeView } from "./features/home/HomeView.tsx";
import { OperatorConversations } from "./features/conversations/OperatorConversations.tsx";
import { OnboardingFlow } from "./features/onboarding/OnboardingFlow.tsx";
import { ActorView } from "./features/actor/ActorView.tsx";
import { SubstrateSettingsView } from "./features/substrate/SubstrateSettingsView.tsx";
import { useNavigation } from "./hooks/useNavigation.ts";
import { WorkspaceSwitcher } from "./workspace/WorkspaceSwitcher.tsx";
import { ScopeInspectorEmpty, DefaultInspector, useInspectorResize, readRinspWidth } from "./scope/ScopeInspector.tsx";
import { tk } from "./theme.ts";
import { getModelProviders, type ModelProviderStatus } from "./providers/modelProviders.ts";
import { isTauri } from "./fs/workspaceFs.ts";
import { startupFailure, waitForFloe } from "./runtime/startup.ts";
import { BrowserConnection } from "./features/onboarding/BrowserConnection.tsx";
import { BrowserAccess } from "./features/onboarding/BrowserAccess.tsx";
import { ActionPanel } from "./features/actions/ActionPanel.tsx";
import { connectLocalBrowser, disconnectBrowser } from "./bus-client/browser.ts";
import {
  STARTING_RUNTIME_HEALTH,
  type RuntimeHealth,
  type SubstrateHealthEvent,
} from "./runtime/health.ts";

// ---------------------------------------------------------------------------
// Global style injection (scrollbars, html/body reset, focus ring)
// ---------------------------------------------------------------------------

const connectionButtonStyle: React.CSSProperties = {
  padding: "5px 9px", border: `1px solid ${tk.border}`, borderRadius: tk.r2,
  background: "transparent", color: tk.ink3, fontSize: 12,
};

function GlobalStyles(): React.ReactElement {
  useEffect(() => {
    const id = "floe-global";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body, #root {
        height: 100%; background: ${tk.canvas}; color: ${tk.ink};
        font-family: ${tk.fontUi}; font-size: 13px; line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        color-scheme: dark;
      }
      * { scrollbar-color: rgba(255,255,255,0.10) transparent; scrollbar-width: thin; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
      button { font-family: inherit; cursor: pointer; }
      input, select {
        font-family: inherit;
        color-scheme: dark;
        background-color: ${tk.surfaceHov};
        color: ${tk.ink};
      }
      select option {
        background-color: ${tk.surfaceHov};
        color: ${tk.ink};
      }
    `;
    document.head.appendChild(style);
  }, []);
  return <></>;
}

function FullPageCenter({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", background: tk.canvas, color: tk.ink3,
      fontFamily: tk.fontUi, fontSize: 13,
    }}>
      {children}
    </div>
  );
}

async function listEndpointsForNewWorkspace(workspaceId: string): Promise<EndpointRef[]> {
  return listAppActors(workspaceId);
}

async function listAppActors(workspaceId: string): Promise<EndpointRef[]> {
  const endpoints = await listEndpoints(workspaceId).catch(() => [] as EndpointRef[]);
  return canonicalActorEndpoints(workspaceId, endpoints).catch(() => endpoints);
}

// ---------------------------------------------------------------------------
// Main App Component
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<"loading" | "onboarding" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<ReturnType<typeof startupFailure> | null>(null);
  const [showBrowserAccess, setShowBrowserAccess] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [localBrowser, setLocalBrowser] = useState(false);

  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRef | null>(null);
  const [scopes, setScopes] = useState<ScopeRef[]>([]);
  const [actors, setActors] = useState<EndpointRef[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfileRecord[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderStatus[] | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth>(STARTING_RUNTIME_HEALTH);

  const nav = useNavigation();
  const [inspWidth, setInspWidth] = useState<number>(readRinspWidth);
  const [addWsErr, setAddWsErr] = useState<string | null>(null);

  // Notification cleanup ref
  const notifUnsubRef = useRef<(() => void) | null>(null);
  const runtimeOfflineTimerRef = useRef<number | null>(null);
  const runtimeWasConnectedRef = useRef(false);
  const nativeRuntimeFailureRef = useRef(false);

  const clearRuntimeOfflineTimer = useCallback(() => {
    if (runtimeOfflineTimerRef.current !== null) {
      window.clearTimeout(runtimeOfflineTimerRef.current);
      runtimeOfflineTimerRef.current = null;
    }
  }, []);

  const refreshRuntimeHealth = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const runtime = await getRuntimeStatus();
      if (nativeRuntimeFailureRef.current) return;
      if (runtime.bridge.online) {
        setRuntimeHealth({
          state: "healthy",
          label: "Floe is running",
          detail: runtime.bridge.runtime_adapter
            ? `Local services and the ${runtime.bridge.runtime_adapter} model runtime are connected.`
            : "Local services and the model runtime are connected.",
        });
      } else {
        setRuntimeHealth({
          state: "degraded",
          label: "Model runtime connecting",
          detail: "The local Bus is available, but the model runtime is not connected yet.",
        });
      }
    } catch (error) {
      if (nativeRuntimeFailureRef.current) return;
      setRuntimeHealth({
        state: "degraded",
        label: "Floe is reconnecting",
        detail: "The local services stopped responding. Floe is trying to reconnect.",
        technicalDetail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [activeWorkspace?.workspace_id]);

  const handleRuntimeStreamState = useCallback((state: "connecting" | "open" | "closed") => {
    if (state === "open") {
      nativeRuntimeFailureRef.current = false;
      runtimeWasConnectedRef.current = true;
      clearRuntimeOfflineTimer();
      void refreshRuntimeHealth();
      return;
    }

    if (state === "connecting") {
      if (nativeRuntimeFailureRef.current) return;
      setRuntimeHealth(previous => previous.state === "healthy" || runtimeWasConnectedRef.current
        ? {
            state: "degraded",
            label: "Floe is reconnecting",
            detail: "The connection to Floe's local services was interrupted.",
          }
        : STARTING_RUNTIME_HEALTH);
      return;
    }

    if (nativeRuntimeFailureRef.current) return;
    setRuntimeHealth({
      state: "degraded",
      label: "Floe is reconnecting",
      detail: "The connection to Floe's local services was interrupted.",
    });
    clearRuntimeOfflineTimer();
    runtimeOfflineTimerRef.current = window.setTimeout(() => {
      setRuntimeHealth(previous => previous.state === "healthy"
        ? previous
        : {
            state: "offline",
            label: "Floe needs attention",
            detail: "The local services are not responding. Active work cannot continue until they restart.",
          });
    }, 2_500);
  }, [clearRuntimeOfflineTimer, refreshRuntimeHealth]);

  const handleRestartRuntime = useCallback(async () => {
    clearRuntimeOfflineTimer();
    nativeRuntimeFailureRef.current = false;
    setRuntimeHealth(STARTING_RUNTIME_HEALTH);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_packaged_substrate");
    } catch (error) {
      setRuntimeHealth({
        state: "offline",
        label: "Floe could not restart",
        detail: "The local services could not be restarted from the app.",
        technicalDetail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [clearRuntimeOfflineTimer]);

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function waitForSubstrate(): Promise<{ workspaces: WorkspaceRef[]; profiles: AuthProfileRecord[] }> {
      return waitForFloe(async signal => {
        if (!isTauri()) {
          const local = await connectLocalBrowser(signal);
          if (!cancelled) setLocalBrowser(local);
        }
        const [wss, auth] = await Promise.all([listWorkspaces(signal), getAuthProfiles(signal)]);
        return { workspaces: wss, profiles: auth.profiles };
      });
    }

    async function boot() {
      try {
        const providersPromise = isTauri()
          ? getModelProviders().catch(() => null)
          : Promise.resolve(null);
        const substrate = await waitForSubstrate();
        const wss = substrate.workspaces;
        const usableProfiles = substrate.profiles.filter(profile => profile.provider !== "openai-codex-app-server");
        if (cancelled) return;
        setWorkspaces(wss);
        setAuthProfiles(usableProfiles);
        void providersPromise.then(providers => { if (!cancelled) setModelProviders(providers); });
        if (wss.length === 0 || (isTauri() && usableProfiles.length === 0)) {
          if (wss.length > 0) setActiveWorkspace(wss.find(w => w.selected_at !== null) ?? wss[0]!);
          setAppState("onboarding");
          return;
        }
        const active = wss.find(w => w.selected_at !== null) ?? wss[0]!;
        const [scs, eps] = await Promise.all([
          listScopes(active.workspace_id),
          listAppActors(active.workspace_id),
        ]);
        if (cancelled) return;
        setActiveWorkspace(active);
        setScopes(scs);
        setActors(eps);
        setAppState("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadError(startupFailure(err));
        setAppState("error");
      }
    }
    void boot();
    return () => { cancelled = true; };
  }, []);

  // One existing source of truth drives the operator health read: the Bus
  // stream tells us whether the local service is reachable, while
  // /v1/runtime/status tells us whether its model Bridge is attached.
  useEffect(() => {
    if (!activeWorkspace) return;
    const unsubscribe = subscribeEvents((msg) => {
      if (msg.type === "bridge_registered" || msg.type === "bridge_connected" || msg.type === "bridge_disconnected") {
        void refreshRuntimeHealth();
      }
    }, {
      workspaceId: activeWorkspace.workspace_id,
      startAtCurrent: true,
      onStateChange: handleRuntimeStreamState,
      onUnavailable: detail => {
        setRuntimeHealth({
          state: "offline",
          label: "Floe needs attention",
          detail,
        });
      },
    });
    return () => {
      clearRuntimeOfflineTimer();
      unsubscribe();
    };
  }, [activeWorkspace?.workspace_id, clearRuntimeOfflineTimer, handleRuntimeStreamState, refreshRuntimeHealth]);

  // The packaged shell can name a process exit more precisely than a lost WebSocket.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<SubstrateHealthEvent>("substrate-health", event => {
        if (cancelled) return;
        clearRuntimeOfflineTimer();
        if (event.payload.state === "starting") {
          nativeRuntimeFailureRef.current = false;
          setRuntimeHealth(STARTING_RUNTIME_HEALTH);
          return;
        }
        nativeRuntimeFailureRef.current = true;
        setRuntimeHealth({
          state: "offline",
          label: "Floe needs attention",
          detail: event.payload.detail,
          technicalDetail: event.payload.technicalDetail,
        });
      }))
      .then(stop => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Browser/dev builds do not have the native process event channel.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [clearRuntimeOfflineTimer]);

  // Notification subscription
  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.workspace_id;
    let cleanup: (() => void) | null = null;
    import("./shell/notifications.ts")
      .then(({ requestNotificationPermission, startDecisionNotifications }) => {
        void requestNotificationPermission();
        cleanup = startDecisionNotifications({ workspaceId });
        notifUnsubRef.current = cleanup;
      })
      .catch(() => { /* degrade silently */ });
      
    return () => {
      if (cleanup) cleanup();
      if (notifUnsubRef.current) { notifUnsubRef.current(); notifUnsubRef.current = null; }
    };
  }, [activeWorkspace?.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const switchWorkspace = useCallback(async (wsId: string) => {
    const ws = workspaces.find(w => w.workspace_id === wsId);
    if (!ws || ws.workspace_id === activeWorkspace?.workspace_id) return;
    nav.navigateToConversations();
    setScopes([]);
    setActors([]);
    setActiveWorkspace(ws);
    try {
      const [scs, eps] = await Promise.all([
        listScopes(ws.workspace_id),
        listAppActors(ws.workspace_id),
      ]);
      setScopes(scs);
      setActors(eps);
    } catch { /* best-effort */ }
  }, [workspaces, activeWorkspace, nav]);

  const addWorkspace = useCallback(async (locator: string, name: string, create_directory?: boolean) => {
    setAddWsErr(null);
    try {
      const ws = await registerWorkspace({ locator, name: name || undefined, init_authorized: true, create_directory });
      const refreshed = await listWorkspaces();
      setWorkspaces(refreshed);
      const [scs, eps] = await Promise.all([
        listScopes(ws.workspace_id),
        listEndpointsForNewWorkspace(ws.workspace_id),
      ]);
      setActiveWorkspace(ws);
      setScopes(scs);
      setActors(eps);
      nav.navigateToConversations();
      setAppState("ready");
    } catch (err) {
      if (err instanceof DirectoryNotFoundError && !create_directory) {
        if (window.confirm(`Directory does not exist: ${locator}\nWould you like to create it?`)) {
          return addWorkspace(locator, name, true);
        } else {
          setAddWsErr(err.message);
          throw err;
        }
      }
      const msg = err instanceof Error ? err.message : "Failed to register workspace";
      setAddWsErr(msg);
      throw new Error(msg);
    }
  }, [nav]);

  const removeWorkspace = useCallback(async (deleteLocator?: boolean) => {
    if (!activeWorkspace) return;
    await deleteWorkspace(activeWorkspace.workspace_id, { delete_locator: !!deleteLocator });
    const refreshed = await listWorkspaces();
    setWorkspaces(refreshed);
    if (refreshed.length === 0) {
      setAppState("onboarding");
      setActiveWorkspace(null);
    } else {
      const next = refreshed[0]!;
      setActiveWorkspace(next);
      setScopes([]);
      setActors([]);
      nav.navigateToConversations();
      const [scs, eps] = await Promise.all([
        listScopes(next.workspace_id),
        listAppActors(next.workspace_id),
      ]);
      setScopes(scs);
      setActors(eps);
    }
  }, [activeWorkspace, nav]);

  const refreshScopes = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const scs = await listScopes(activeWorkspace.workspace_id);
      setScopes(scs);
    } catch { /* best-effort */ }
  }, [activeWorkspace]);

  const refreshActors = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const eps = await listAppActors(activeWorkspace.workspace_id);
      setActors(eps);
    } catch { /* best-effort */ }
  }, [activeWorkspace]);

  const handleScopeCreated = useCallback(async (title: string, description: string) => {
    if (!activeWorkspace) return;
    const scope = await createScope(activeWorkspace.workspace_id, { title, description: description || null });
    await refreshScopes();
    nav.navigateToScope(scope.scope_id);
  }, [activeWorkspace, refreshScopes, nav]);

  const handleSelectScope = useCallback((id: string) => {
    if (id) {
      nav.navigateToScope(id);
    } else {
      // Clear selections but DO NOT reset general navigation view (like activity) to home!
      nav.clearScopeSelection();
      nav.clearContextSelection();
    }
  }, [nav]);

  const handleSelectContext = useCallback((id: string | null) => {
    nav.navigateToContext(id, nav.selectedScopeId);
  }, [nav]);

  const handleContextDeleted = useCallback(() => {
    nav.navigateToContext(null, nav.selectedScopeId);
  }, [nav]);

  const handleOpenContext = useCallback((id: string) => {
    nav.navigateToContext(id, null);
  }, [nav]);

  const handleSelectActor = useCallback((id: string) => {
    nav.navigateToActor(id);
  }, [nav]);

  const handleOpenWorkspaceSettings = useCallback(() => {
    nav.navigateToWorkspaceSettings();
  }, [nav]);

  const handleOpenNewActor = useCallback(() => {
    nav.navigateToNewActor();
  }, [nav]);

  const handleActorCreated = useCallback(() => {
    nav.clearNewActor();
    void refreshActors();
  }, [refreshActors, nav]);

  const handleActorSaved = useCallback((updated: EndpointRef) => {
    setActors(prev => prev.map(a => a.endpoint_id === updated.endpoint_id ? updated : a));
    void refreshActors();
  }, [refreshActors]);

  const inspResizeRef = useInspectorResize(setInspWidth);

  // Keep the developer observatory aligned with actor and Scope lifecycle
  // changes made through Floe as well as changes made in this client.
  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.workspace_id;
    const unsub = subscribeEvents((msg) => {
      if (
        msg.type === "endpoint_registered"
        || msg.type === "endpoint_updated"
        || msg.type === "endpoint_retired"
        || msg.type === "endpoint_deleted"
      ) {
        const epWsId = (msg.payload?.endpoint as any)?.workspace_id;
        if (msg.payload?.workspace_id === workspaceId || epWsId === workspaceId) {
          void refreshActors();
        }
      }
      if (msg.type === "scope_created" || msg.type === "scope_updated" || msg.type === "scope_deleted" || msg.type === "scope_retired") {
        const scopeWsId = (msg.payload?.scope as any)?.workspace_id;
        if (msg.payload?.workspace_id === workspaceId || scopeWsId === workspaceId) {
          void refreshScopes();
        }
      }
    }, {
      workspaceId,
      // Subscribe first, then take a fresh snapshot. This closes the startup
      // race where the bridge registered Floe between the onboarding snapshot
      // and the live stream becoming ready.
      onOpen: () => {
        void refreshActors();
        void refreshScopes();
      },
      startAtCurrent: true,
    });
    return unsub;
  }, [activeWorkspace?.workspace_id, refreshActors, refreshScopes]);

  // ---------------------------------------------------------------------------
  // Guard states
  // ---------------------------------------------------------------------------
  if (appState === "loading") {
    return (
      <>
        <GlobalStyles />
        <FullPageCenter>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
            <span style={{ color: tk.ink2 }}>Starting Floe…</span>
            <span style={{ color: tk.ink3, fontSize: 12 }}>Starting the local substrate and checking its health.</span>
          </div>
        </FullPageCenter>
      </>
    );
  }

  if (appState === "error") {
    return (
      <>
        <GlobalStyles />
        <FullPageCenter>
          {loadError?.needsConnection && !isTauri() ? <BrowserConnection /> :
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, maxWidth: 420, textAlign: "center" }}>
            <span style={{ color: tk.ink, fontSize: 16 }}>{loadError?.title}</span>
            <span style={{ color: tk.ink3 }}>{loadError?.detail}</span>
            <button onClick={() => window.location.reload()} style={{ background: tk.accent, color: "#0c1714", border: "none", borderRadius: tk.r2, padding: "7px 14px" }}>Try connecting again</button>
          </div>}
        </FullPageCenter>
      </>
    );
  }

  if (appState === "onboarding") {
    const existingProfile = authProfiles[0];
    return (
      <>
        <GlobalStyles />
        <OnboardingFlow
          workspaces={workspaces}
          hasProvider={authProfiles.length > 0}
          existingProfileId={existingProfile?.id}
          existingModel={existingProfile?.model}
          modelProviders={modelProviders}
          onReady={async ({ workspace, profileId, model }) => {
            const selectedProfile = authProfiles.find(profile => profile.id === profileId);
            if (!selectedProfile) throw new Error("Choose a connected provider before continuing.");
            await upsertRuntimeBinding({
              scope: "workspace_default",
              workspace_id: workspace.workspace_id,
              auth_profile: profileId,
              provider: selectedProfile.provider,
              model: model || null,
              thinking_level: model ? "high" : null,
            });
            const [refreshed, scs, eps, auth] = await Promise.all([
              listWorkspaces(),
              listScopes(workspace.workspace_id),
              listEndpointsForNewWorkspace(workspace.workspace_id),
              getAuthProfiles(),
            ]);
            setWorkspaces(refreshed);
            setAuthProfiles(auth.profiles.filter(profile => profile.provider !== "openai-codex-app-server"));
            setActiveWorkspace(refreshed.find(item => item.workspace_id === workspace.workspace_id) ?? workspace);
            setScopes(scs);
            setActors(eps);
            nav.navigateToConversations();
            setAppState("ready");
          }}
        />
      </>
    );
  }

  if (!activeWorkspace) return <></>;

  const selectedScope = scopes.find(s => s.scope_id === nav.selectedScopeId) ?? null;

  // ---------------------------------------------------------------------------
  // Render shell
  // ---------------------------------------------------------------------------
  return (
    <>
      <GlobalStyles />
      {showBrowserAccess && activeWorkspace && <BrowserAccess workspaceId={activeWorkspace.workspace_id} workspaceName={activeWorkspace.name} onClose={() => setShowBrowserAccess(false)} />}
      <div
        data-testid="app"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          background: tk.canvas,
          color: tk.ink,
          fontFamily: tk.fontUi,
          overflow: "hidden",
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Topbar                                                           */}
        {/* ---------------------------------------------------------------- */}
        <header style={{
          flex: "0 0 auto",
          display: "flex", alignItems: "center", gap: 10,
          padding: "0 16px",
          height: 52,
          background: "rgba(15,16,17,0.9)",
          backdropFilter: "saturate(160%) blur(10px)",
          borderBottom: `1px solid ${tk.border}`,
          zIndex: 10,
        }}>
          {/* Brand */}
          <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none", color: tk.ink2 }}
            onClick={e => { e.preventDefault(); nav.navigateToConversations(); }}
          >
            <span style={{
              width: 22, height: 22, borderRadius: 6,
              background: tk.accent, color: "#0c1714",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 590,
            }}>F</span>
            <span style={{ fontWeight: 510, fontSize: 13 }}>Floe</span>
          </a>

          {/* Sep + workspace switcher */}
          <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
          <WorkspaceSwitcher
            workspaces={workspaces}
            active={activeWorkspace}
            onSwitch={id => void switchWorkspace(id)}
            onAdd={addWorkspace}
            addErr={addWsErr}
          />

          {/* Settings affordance */}
          <button style={connectionButtonStyle} onClick={() => setShowActions(true)}>Actions</button>
          {isTauri() ? <button style={connectionButtonStyle} onClick={() => setShowBrowserAccess(true)}>Remote access</button>
            : !localBrowser && <button style={connectionButtonStyle} onClick={() => void disconnectBrowser().then(() => window.location.reload())}>Disconnect browser</button>}
          <button
            onClick={handleOpenWorkspaceSettings}
            title="Settings"
            aria-label="Settings"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, borderRadius: tk.r2,
              background: nav.showWorkspaceSettings ? "rgba(255,255,255,0.06)" : "transparent",
              border: `1px solid ${nav.showWorkspaceSettings ? tk.border : "transparent"}`,
              color: nav.showWorkspaceSettings ? tk.accent : tk.ink3,
              fontSize: 14, cursor: "pointer",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={e => { if (!nav.showWorkspaceSettings) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            ⚙
          </button>

          {/* Breadcrumb for selected scope */}
          {selectedScope && (
            <>
              <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
              <span style={{ color: tk.ink, fontSize: 13, fontWeight: 510, padding: "3px 6px", borderRadius: 4 }}>
                {selectedScope.title || selectedScope.scope_id}
              </span>
            </>
          )}

          {/* Breadcrumb for selected context (within a scope) */}
          {selectedScope && nav.selectedContextId && nav.selectedContextLabel && (
            <>
              <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
              <span style={{
                color: tk.ink2, fontSize: 13, fontWeight: 510, padding: "3px 6px", borderRadius: 4,
                maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {nav.selectedContextLabel}
              </span>
            </>
          )}
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* Body: left nav + main + inspector                                */}
        {/* ---------------------------------------------------------------- */}
        <div className="floe-workspace-body" style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
          overflow: "hidden",
        }}>
          {/* Left nav */}
          <LeftNav
            view={nav.view}
            scopes={scopes}
            selectedScopeId={nav.selectedScopeId}
            actors={actors}
            selectedActorId={nav.selectedActorId}
            onView={(v) => {
              if (v === "conversations") nav.navigateToConversations();
              if (v === "home") nav.navigateToHome();
              if (v === "activity") nav.navigateToActivity();
            }}
            onSelectScope={handleSelectScope}
            onSelectActor={handleSelectActor}
            onNewScope={() => {
              nav.navigateToHome();
            }}
            onNewActor={handleOpenNewActor}
            showNewActor={nav.showNewActor}
            appMode={nav.appMode}
            onViewSystem={nav.navigateToSystem}
            runtimeHealth={runtimeHealth}
            onRestartRuntime={() => void handleRestartRuntime()}
          />

          {/* Main column */}
          <main style={{
            flex: "1 1 auto",
            minWidth: 0,
            height: "100%",
            overflow: "auto",
            background: tk.canvas,
            display: "flex",
            flexDirection: "column",
          }}>
            {nav.appMode === "system" ? (
              <SubstrateSettingsView />
            ) : nav.showWorkspaceSettings ? (
              <WorkspaceSettings workspace={activeWorkspace} endpoints={actors} onRemove={removeWorkspace} />
            ) : nav.showNewActor ? (
              <NewActorForm
                workspaceId={activeWorkspace.workspace_id}
                workspace={activeWorkspace}
                existingAgentIds={actors.map(a => a.agent_id).filter((id): id is string => !!id)}
                onCreated={handleActorCreated}
              />
            ) : nav.view === "conversations" ? (
              <OperatorConversations
                workspaceId={activeWorkspace.workspace_id}
                workspaceLocator={activeWorkspace.locator}
                endpoints={actors}
                scopes={scopes}
                selectedContextId={nav.selectedContextId}
                onOpenContext={nav.navigateToOperatorContext}
                onCloseContext={nav.navigateToConversations}
                onOpenSettings={handleOpenWorkspaceSettings}
                runtimeHealth={runtimeHealth}
              />
            ) : nav.selectedContextId ? (
              // Developer tools can open any Context independently of Scope.
              // Normal operator conversations are owned by the branch above.
              <ContextConversation
                key={nav.selectedContextId}
                contextId={nav.selectedContextId}
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                onLabelResolved={nav.setContextLabel}
                runtimeHealth={runtimeHealth}
              />
            ) : nav.selectedActorId ? (
              <ActorView
                actor={actors.find(a => a.endpoint_id === nav.selectedActorId)!}
                workspaceId={activeWorkspace.workspace_id}
                workspace={activeWorkspace}
                onSaved={handleActorSaved}
                onOpenContext={(id) => nav.navigateToContext(id, null, nav.selectedActorId)}
                endpoints={actors}
              />
            ) : nav.view === "home" && selectedScope ? (
              <ScopeDetail
                scope={selectedScope}
                workspaceId={activeWorkspace.workspace_id}
                selectedContextId={nav.selectedContextId}
                onSelectContext={handleSelectContext}
              />
            ) : nav.view === "home" && !nav.selectedActorId ? (
              <HomeView
                workspaceId={activeWorkspace.workspace_id}
                scopes={scopes}
                selectedScopeId={nav.selectedScopeId}
                onSelectScope={id => handleSelectScope(id || "")}
                onScopeCreated={handleScopeCreated}
              />
            ) : nav.view === "activity" ? (
              <Activity
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                scopes={scopes}
              />
            ) : null}
          </main>

          {/* Right inspector */}
          {nav.appMode !== "system" && nav.view !== "conversations" && (!nav.selectedActorId || nav.selectedContextId) && (
            <aside style={{
              flex: `0 0 ${inspWidth}px`,
              width: inspWidth,
              height: "100%",
              position: "relative",
              background: tk.surface,
              borderLeft: `1px solid ${tk.border}`,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}>
              {/* Resize handle */}
              <div
                ref={inspResizeRef}
                style={{
                  position: "absolute", left: -3, top: 0, bottom: 0, width: 6,
                  cursor: "col-resize", zIndex: 10, background: "transparent",
                }}
                title="Drag to resize"
              />
              {/* Inspector body */}
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: (nav.selectedContextId || nav.selectedActorId) ? 0 : "18px 16px 24px" }}>
                {nav.selectedContextId ? (
                  <ContextInspector
                    contextId={nav.selectedContextId}
                    scope={selectedScope}
                    workspaceId={activeWorkspace.workspace_id}
                    onDeleted={handleContextDeleted}
                  />
                ) : selectedScope ? (
                  <ScopeInspectorEmpty scope={selectedScope} />
                ) : (
                  <DefaultInspector workspace={activeWorkspace} />
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
      {showActions && activeWorkspace && <ActionPanel key={activeWorkspace.workspace_id} workspaceId={activeWorkspace.workspace_id} workspaceName={activeWorkspace.name} onClose={() => setShowActions(false)} initialTarget={
        nav.selectedContextId ? { ref: { kind: "context", id: nav.selectedContextId }, label: nav.selectedContextLabel ?? "Conversation" }
          : nav.selectedActorId ? { ref: { kind: "actor", id: nav.selectedActorId }, label: actors.find(actor => actor.endpoint_id === nav.selectedActorId)?.name ?? "Actor" }
            : selectedScope ? { ref: { kind: "scope", id: selectedScope.scope_id }, label: selectedScope.title ?? "Scope" } : undefined
      } />}
    </>
  );
}
