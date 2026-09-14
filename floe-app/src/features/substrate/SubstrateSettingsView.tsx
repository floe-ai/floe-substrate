import React, { useState, useEffect } from "react";
import type { AuthProfileRecord } from "../../bus-client/types.ts";
import { getAuthProfiles, getRuntimeStatus } from "../../bus-client/client.ts";
import { isTauri } from "../../fs/workspaceFs.ts";
import { tk } from "../../theme.ts";

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function SubstrateSettingsView(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ActiveTab>("auth");
  const desktop = isTauri();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: tk.canvas }}>
      {/* Spacious Hero Header */}
      <header style={{
        flex: "0 0 auto",
        padding: "24px 32px 16px",
        borderBottom: `1px solid ${tk.border}`,
        background: "rgba(15,16,17,0.3)",
      }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{
            fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
            color: tk.ink3, fontWeight: 510, marginBottom: 2,
          }}>
            Global System {desktop ? "(Desktop)" : "(Browser — read-only)"}
          </div>
          <h1 style={{
            fontWeight: 510, fontSize: 24, lineHeight: 1.1,
            letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 6px",
          }}>
            Substrate Settings
          </h1>
          <p style={{ color: tk.ink3, fontSize: 13, margin: 0 }}>
            {desktop
              ? "Configure global daemon services, model definitions, and API authentication credentials natively from your host."
              : "View configured credentials. To add or edit credentials, use the Floe CLI or the desktop app."}
          </p>
        </div>
      </header>

      {/* Main Container Split layout: Settings Nav + Inner Content */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
        {/* Left Settings Tabs */}
        <nav style={{
          width: 200,
          flexShrink: 0,
          borderRight: `1px solid ${tk.border}`,
          background: "rgba(15,16,17,0.15)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}>
          <TabButton id="auth" label="🔑 Authentication" active={activeTab === "auth"} onClick={() => setActiveTab("auth")} />
          <TabButton id="runtime" label="⚙️ Runtime" active={activeTab === "runtime"} onClick={() => setActiveTab("runtime")} />
          <TabButton id="models" label="🤖 Model Registry" active={activeTab === "models"} onClick={() => setActiveTab("models")} isStub />
          <TabButton id="mcp" label="🔌 MCP Manager" active={activeTab === "mcp"} onClick={() => setActiveTab("mcp")} isStub />
          <TabButton id="workspaces" label="📁 Workspace Catalog" active={activeTab === "workspaces"} onClick={() => setActiveTab("workspaces")} isStub />
          <TabButton id="diagnostics" label="⚡ Diagnostics" active={activeTab === "diagnostics"} onClick={() => setActiveTab("diagnostics")} isStub />
        </nav>

        {/* Right Settings Content */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 32px 48px" }}>
          {activeTab === "auth" ? (
            <AuthenticationPillar desktop={desktop} />
          ) : activeTab === "runtime" ? (
            <RuntimeAdapterPillar desktop={desktop} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyItems: "center", padding: 40, color: tk.ink3, textAlign: "center" }}>
              <span style={{ fontSize: 28, marginBottom: 12 }}>⚡</span>
              <h3 style={{ fontSize: 15, fontWeight: 510, color: tk.ink, margin: "0 0 4px" }}>Pillar Coming Soon</h3>
              <p style={{ fontSize: 12.5, color: tk.ink4, margin: 0, maxWidth: "36ch" }}>
                This Substrate settings module is scheduled for development in a subsequent phase.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar Tab Button Helper
// ---------------------------------------------------------------------------

type ActiveTab = "auth" | "runtime" | "models" | "mcp" | "workspaces" | "diagnostics";

type TabButtonProps = {
  id: ActiveTab;
  label: string;
  active: boolean;
  onClick: () => void;
  isStub?: boolean;
};

function TabButton({ id, label, active, onClick, isStub }: TabButtonProps): React.ReactElement {
  const [hov, setHov] = useState(false);

  return (
    <button
      onClick={isStub ? undefined : onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center",
        width: "100%", padding: "6px 10px", borderRadius: tk.r2,
        border: "none",
        background: active ? "rgba(255,255,255,0.05)" : hov && !isStub ? "rgba(255,255,255,0.02)" : "transparent",
        color: active ? tk.accent : isStub ? tk.ink4 : tk.ink2,
        fontSize: 12.5, cursor: isStub ? "not-allowed" : "pointer",
        fontWeight: active ? 510 : 400,
        textAlign: "left",
        opacity: isStub ? 0.5 : 1,
        transition: "background 100ms ease, color 100ms ease",
      }}
      title={isStub ? `${label} (Coming Soon)` : label}
    >
      <span>{label}</span>
      {isStub && (
        <span style={{ marginLeft: "auto", fontSize: 9, color: tk.ink4, background: "rgba(255,255,255,0.03)", padding: "1px 4px", borderRadius: 3 }}>
          Soon
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Runtime Adapter Pillar — Test (fake) / Live (pi) switch
// ---------------------------------------------------------------------------

function RuntimeAdapterPillar({ desktop }: { desktop: boolean }): React.ReactElement {
  return desktop ? <DesktopRuntimePillar /> : <BrowserRuntimePillar />;
}

/** Shared hook — fetches effective runtime_adapter from the bus GET /v1/runtime/status */
function useEffectiveRuntime(): { runtime: string | null; bridgeOnline: boolean; error: string | null; loading: boolean } {
  const [runtime, setRuntime] = useState<string | null>(null);
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRuntimeStatus()
      .then((status) => {
        setRuntime(status.bridge.runtime_adapter);
        setBridgeOnline(status.bridge.online);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  return { runtime, bridgeOnline, error, loading };
}

/** Maps raw adapter name to human-readable label */
function adapterLabel(adapter: string | null): string {
  if (!adapter) return "Unknown";
  if (adapter === "fake") return "Test (fake)";
  if (adapter === "floe-runtime") return "Live (Pi, legacy name)";
  if (adapter === "pi" || adapter === "pi-agent-core") return "Live (pi)";
  return adapter;
}

/** Browser read-only view */
function BrowserRuntimePillar(): React.ReactElement {
  const { runtime, bridgeOnline, error, loading } = useEffectiveRuntime();

  return (
    <div style={{ maxWidth: 800, display: "flex", flexDirection: "column", gap: 28 }}>
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 510, color: tk.ink, margin: "0 0 6px" }}>Runtime Adapter</h2>
        <p style={{ fontSize: 13, color: tk.ink3, margin: 0, lineHeight: 1.5 }}>
          Controls whether agents use the deterministic <strong>Test (fake)</strong> adapter or Floe's{" "}
          <strong>live Pi runtime</strong>. Provider profiles select the account and model Pi uses.
        </p>
      </section>

      <RuntimeStatusCard loading={loading} error={error} runtime={runtime} bridgeOnline={bridgeOnline} />

      <RuntimeSwitchCard
        desktop={false}
        configured={null}
        onSwitch={() => {}}
        saving={false}
        saveError={null}
      />

      <section style={{
        background: "rgba(255,200,80,0.05)", border: `1px solid rgba(255,200,80,0.2)`,
        borderRadius: tk.r3, padding: "14px 18px",
      }}>
        <p style={{ fontSize: 12.5, color: tk.ink3, margin: 0, lineHeight: 1.6 }}>
          <strong style={{ color: tk.ink2 }}>Note:</strong> The runtime adapter setting is desktop/CLI-only.
          Use the desktop app to change this setting.
        </p>
      </section>
    </div>
  );
}

/** Desktop read/write view */
function DesktopRuntimePillar(): React.ReactElement {
  const { runtime, bridgeOnline, error: statusError, loading: statusLoading } = useEffectiveRuntime();

  const [configured, setConfigured] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    invokeTauri<{ configured_adapter: string | null }>("get_runtime_adapter")
      .then((res) => {
        setConfigured(res.configured_adapter);
        setConfigLoading(false);
      })
      .catch(() => setConfigLoading(false));
  }, []);

  const handleSwitch = async (adapter: "fake" | "pi-agent-core") => {
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      await invokeTauri<void>("set_runtime_adapter", { adapter });
      setConfigured(adapter);
      setSaveOk(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 800, display: "flex", flexDirection: "column", gap: 28 }}>
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 510, color: tk.ink, margin: "0 0 6px" }}>Runtime Adapter</h2>
        <p style={{ fontSize: 13, color: tk.ink3, margin: 0, lineHeight: 1.5 }}>
          Controls whether agents use the deterministic <strong>Test (fake)</strong> adapter or Floe's{" "}
          <strong>live provider runtimes</strong>. Each provider profile is routed to its compatible runtime.
          The change takes effect on the next bridge start.
        </p>
      </section>

      <RuntimeStatusCard
        loading={statusLoading}
        error={statusError}
        runtime={runtime}
        bridgeOnline={bridgeOnline}
      />

      {configLoading ? (
        <div style={{ padding: 24, textAlign: "center", color: tk.ink3 }}>Loading setting…</div>
      ) : (
        <RuntimeSwitchCard
          desktop={true}
          configured={configured}
          onSwitch={(a) => void handleSwitch(a)}
          saving={saving}
          saveError={saveError}
        />
      )}

      {saveOk && (
        <section style={{
          background: "rgba(0,200,100,0.05)", border: `1px solid rgba(0,200,100,0.25)`,
          borderRadius: tk.r3, padding: "14px 18px",
        }}>
          <p style={{ fontSize: 12.5, color: tk.ink3, margin: 0, lineHeight: 1.6 }}>
            <strong style={{ color: "#6ee7b7" }}>Saved.</strong>{" "}
            The new adapter will be used when the bridge is next started or restarted.
            Current run reports: <strong>{bridgeOnline ? adapterLabel(runtime) : "bridge offline"}</strong>.
          </p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components for the Runtime pillar
// ---------------------------------------------------------------------------

type RuntimeStatusCardProps = {
  loading: boolean;
  error: string | null;
  runtime: string | null;
  bridgeOnline: boolean;
};

function RuntimeStatusCard({ loading, error, runtime, bridgeOnline }: RuntimeStatusCardProps): React.ReactElement {
  return (
    <section style={{
      background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden"
    }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tk.border2}`, display: "flex", alignItems: "center" }}>
        <h3 style={{ fontSize: 13, fontWeight: 510, margin: 0, color: tk.ink }}>Effective Runtime (current bridge)</h3>
      </div>
      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: tk.ink3 }}>Fetching status…</div>
      ) : error ? (
        <div role="alert" style={{ padding: 24, color: tk.danger }}>{error}</div>
      ) : (
        <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{
            display: "inline-flex", alignItems: "center",
            padding: "4px 10px",
            borderRadius: tk.r2,
            fontSize: 12.5, fontWeight: 510,
            background: runtime === "fake" ? "rgba(255,200,80,0.12)" : "rgba(0,200,100,0.10)",
            color: runtime === "fake" ? "#e0b84a" : "#6ee7b7",
            border: `1px solid ${runtime === "fake" ? "rgba(255,200,80,0.25)" : "rgba(0,200,100,0.25)"}`,
          }}>
            {runtime === "fake" ? "🧪" : "⚡"}{" "}{adapterLabel(runtime)}
          </span>
          {!bridgeOnline && (
            <span style={{ fontSize: 12, color: tk.ink4 }}>(bridge offline — showing last known)</span>
          )}
        </div>
      )}
    </section>
  );
}

type RuntimeSwitchCardProps = {
  desktop: boolean;
  configured: string | null;
  onSwitch: (adapter: "fake" | "pi-agent-core") => void;
  saving: boolean;
  saveError: string | null;
};

function RuntimeSwitchCard({ desktop, configured, onSwitch, saving, saveError }: RuntimeSwitchCardProps): React.ReactElement {
  const isTest = configured === "fake";
  const isLive = configured === "floe-runtime" || configured === "pi" || configured === "pi-agent-core";

  return (
    <section style={{
      background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden",
    }}>
      <div style={{
        padding: "16px 20px", borderBottom: `1px solid ${tk.border2}`,
        display: "flex", alignItems: "center",
      }}>
        <h3 style={{ fontSize: 13, fontWeight: 510, margin: 0, color: tk.ink }}>Adapter Setting</h3>
        {!desktop && (
          <span style={{
            marginLeft: "auto", fontSize: 11, color: tk.ink4,
            background: "rgba(255,255,255,0.03)", border: `1px solid ${tk.border}`,
            padding: "2px 8px", borderRadius: tk.r2,
          }}>Read-only</span>
        )}
      </div>

      <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ fontSize: 12.5, color: tk.ink3, margin: 0 }}>
          {desktop
            ? "Choose which adapter the bridge uses. Applies on next bridge start."
            : "Current setting (read-only). Use the desktop app to change."
          }
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <AdapterButton
            label="🧪 Test"
            sublabel="Deterministic fake adapter"
            active={isTest}
            disabled={!desktop || saving}
            onClick={() => onSwitch("fake")}
          />
          <AdapterButton
            label="⚡ Live"
            sublabel="Pi multi-provider runtime"
            active={isLive || (!isTest && !isLive)}
            disabled={!desktop || saving}
            onClick={() => onSwitch("pi-agent-core")}
          />
        </div>
        {configured === null && !desktop && (
          <p style={{ fontSize: 11, color: tk.ink4, margin: 0 }}>Auto-detect (Live when any real profile exists, else Test)</p>
        )}
        {configured === null && desktop && (
          <p style={{ fontSize: 11, color: tk.ink4, margin: 0 }}>Currently auto-detecting (no explicit setting). Select an option above to pin it.</p>
        )}
        {saveError && (
          <p role="alert" style={{ fontSize: 12, color: tk.danger, margin: 0 }}>{saveError}</p>
        )}
        {saving && (
          <p style={{ fontSize: 12, color: tk.ink3, margin: 0 }}>Saving…</p>
        )}
      </div>
    </section>
  );
}

type AdapterButtonProps = {
  label: string;
  sublabel: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
};

function AdapterButton({ label, sublabel, active, disabled, onClick }: AdapterButtonProps): React.ReactElement {
  const [hov, setHov] = useState(false);

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        flex: 1, padding: "14px 16px", borderRadius: tk.r3,
        border: active
          ? `2px solid ${tk.accent}`
          : `2px solid ${hov && !disabled ? tk.border : tk.border2}`,
        background: active ? "rgba(100,220,180,0.05)" : hov && !disabled ? "rgba(255,255,255,0.02)" : "transparent",
        color: active ? tk.accent : disabled ? tk.ink4 : tk.ink2,
        cursor: disabled ? (active ? "default" : "not-allowed") : "pointer",
        opacity: disabled && !active ? 0.5 : 1,
        transition: "border 120ms ease, background 120ms ease, color 120ms ease",
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 510, marginBottom: 4 }}>{label}</span>
      <span style={{ fontSize: 11, color: active ? tk.ink3 : tk.ink4 }}>{sublabel}</span>
      {active && (
        <span style={{
          marginTop: 8, fontSize: 10, padding: "2px 6px", borderRadius: tk.r1,
          background: "rgba(100,220,180,0.12)", color: tk.accent,
        }}>Selected</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Authentication & Credentials Pillar — branches on isTauri()
// ---------------------------------------------------------------------------

function AuthenticationPillar({ desktop }: { desktop: boolean }): React.ReactElement {
  return desktop ? <TauriAuthPillar /> : <BrowserAuthPillar />;
}

// ---------------------------------------------------------------------------
// Browser read-only auth pillar — fetches profiles via the bus
// ---------------------------------------------------------------------------

function BrowserAuthPillar(): React.ReactElement {
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuthProfiles()
      .then((res) => {
        setProfiles(res.profiles);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  return (
    <div style={{ maxWidth: 800, display: "flex", flexDirection: "column", gap: 28 }}>
      {/* Intro */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 510, color: tk.ink, margin: "0 0 6px" }}>Authentication Profiles</h2>
        <p style={{ fontSize: 13, color: tk.ink3, margin: 0, lineHeight: 1.5 }}>
          Credentials are managed by the Floe CLI or the desktop app and stored securely on the host machine.
          This browser view is read-only. To add or edit credentials, use the Floe CLI (<code>floe login</code>) or the desktop app.
        </p>
      </section>

      {/* Profiles list */}
      <section style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tk.border2}`, display: "flex", alignItems: "center" }}>
          <h3 style={{ fontSize: 13, fontWeight: 510, margin: 0, color: tk.ink }}>Registered Profiles</h3>
          <span style={{
            marginLeft: "auto", fontSize: 11, color: tk.ink4,
            background: "rgba(255,255,255,0.03)", border: `1px solid ${tk.border}`,
            padding: "2px 8px", borderRadius: tk.r2,
          }}>
            Read-only
          </span>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: tk.ink3 }}>Loading profiles…</div>
        ) : error ? (
          <div role="alert" style={{ padding: 24, color: tk.danger }}>{error}</div>
        ) : profiles.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: tk.ink4, fontStyle: "italic" }}>
            No auth profiles configured. Use <code>floe login</code> on the host or open the desktop app to add credentials.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {profiles.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex", alignItems: "center", padding: "14px 20px",
                  borderBottom: `1px solid ${tk.border2}`, gap: 16,
                }}
              >
                <div>
                  <code style={{ fontSize: 13, fontWeight: 550, color: tk.ink }}>{p.id}</code>
                  <span style={{ fontSize: 11, color: tk.ink4, marginLeft: 12 }}>Provider:</span>
                  <span style={{ fontSize: 12, color: tk.ink2, marginLeft: 4, textTransform: "capitalize" }}>{p.provider}</span>
                  {p.model && (
                    <>
                      <span style={{ fontSize: 11, color: tk.ink4, marginLeft: 12 }}>Default Model:</span>
                      <code style={{ fontSize: 11, color: tk.accentHov, marginLeft: 4 }}>{p.model}</code>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Browser note */}
      <section style={{
        background: "rgba(255,200,80,0.05)", border: `1px solid rgba(255,200,80,0.2)`,
        borderRadius: tk.r3, padding: "14px 18px",
      }}>
        <p style={{ fontSize: 12.5, color: tk.ink3, margin: 0, lineHeight: 1.6 }}>
          <strong style={{ color: tk.ink2 }}>Note:</strong> Provider connections use the protected native broker (ADR-0012).
          Use <code>floe login</code> to connect from the CLI, or open Provider settings in the Floe desktop app.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop provider-account observatory. Credential mutation belongs to the
// normal Provider settings flow so this diagnostic surface cannot create a
// second credential store or bypass canonical confirmation.
// ---------------------------------------------------------------------------

function TauriAuthPillar(): React.ReactElement {
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = () => {
    setLoading(true);
    invokeTauri<{ profiles: AuthProfileRecord[]; default_auth_profile: string | null }>("get_substrate_auth_profiles")
      .then((res) => {
        setProfiles(res.profiles);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  return (
    <div style={{ maxWidth: 800, display: "flex", flexDirection: "column", gap: 28 }}>
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 510, color: tk.ink, margin: "0 0 6px" }}>Provider accounts</h2>
        <p style={{ fontSize: 13, color: tk.ink3, margin: 0, lineHeight: 1.5 }}>
          Inspect the connected provider accounts available from this host's protected credential broker.
        </p>
      </section>

      <section style={{ background: "rgba(138,168,156,0.06)", border: `1px solid rgba(138,168,156,0.22)`, borderRadius: tk.r3, padding: 16 }}>
        <p style={{ margin: 0, color: tk.ink3, fontSize: 12.5, lineHeight: 1.55 }}>
          Connect or disconnect an account from the normal Provider settings flow. Legacy auth files remain available only as explicit migration sources and are never changed here.
        </p>
      </section>

      <section style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tk.border2}`, display: "flex", alignItems: "center" }}>
          <h3 style={{ fontSize: 13, fontWeight: 510, margin: 0, color: tk.ink }}>Connected accounts</h3>
          <span style={{ marginLeft: "auto", fontSize: 11, color: tk.ink4 }}>Read-only diagnostics</span>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: tk.ink3 }}>Loading profiles…</div>
        ) : error ? (
          <div role="alert" style={{ padding: 24, color: tk.danger }}>{error}</div>
        ) : profiles.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: tk.ink4, fontStyle: "italic" }}>
            No connected provider accounts.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {profiles.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex", alignItems: "center", padding: "14px 20px",
                  borderBottom: `1px solid ${tk.border2}`, gap: 16,
                }}
              >
                <div>
                  <span style={{ fontSize: 13, fontWeight: 550, color: tk.ink }}>{p.label ?? p.provider}</span>
                  <code style={{ fontSize: 11, color: tk.ink4, marginLeft: 12 }}>{p.provider}</code>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  padding: "7px 10px",
  fontSize: 13,
  color: tk.ink,
  outline: "none",
};

const selectStyle: React.CSSProperties = { ...inputStyle };
