import React, { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../fs/workspaceFs.ts";
import { tk } from "../theme.ts";
import {
  connectModelProvider,
  answerProviderPrompt,
  disconnectModelProvider,
  getModelProviders,
  preferredModel,
  type ModelProviderAuthEvent,
  type ModelProviderStatus,
} from "./modelProviders.ts";

type ProviderAccessProps = {
  compact?: boolean;
  initialProviders?: ModelProviderStatus[] | null;
  onReady?: (status: ModelProviderStatus, model: string) => void;
  purpose?: "choose" | "add";
};

export function ProviderAccess({ compact = false, initialProviders = null, onReady, purpose = "choose" }: ProviderAccessProps): React.ReactElement {
  const [providers, setProviders] = useState<ModelProviderStatus[]>(initialProviders ?? []);
  const [providerId, setProviderId] = useState(initialProviderId(initialProviders ?? [], purpose));
  const [model, setModel] = useState(initialModel(initialProviders ?? [], purpose));
  const [loading, setLoading] = useState(initialProviders === null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [authEvent, setAuthEvent] = useState<ModelProviderAuthEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authLink, setAuthLink] = useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = useState<Extract<ModelProviderAuthEvent, { type: "prompt" }> | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [promptAnswer, setPromptAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const login = useRef<AbortController | null>(null);
  useEffect(() => () => login.current?.abort(), []);

  useEffect(() => {
    if (initialProviders !== null) return;
    let cancelled = false;
    getModelProviders()
      .then(next => {
        if (cancelled) return;
        setProviders(next);
        const nextProviderId = initialProviderId(next, purpose);
        setProviderId(nextProviderId);
        setModel(preferredModel(next.find(item => item.provider === nextProviderId) ?? next[0]!));
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialProviders, purpose]);

  const status = useMemo(
    () => providers.find(item => item.provider === providerId) ?? providers[0] ?? null,
    [providers, providerId],
  );

  function selectProvider(nextProviderId: string) {
    const next = providers.find(item => item.provider === nextProviderId);
    setProviderId(nextProviderId);
    setModel(next ? preferredModel(next) : "");
    setAuthEvent(null);
    setAuthLink(null);
    setAuthPrompt(null);
    setDeviceCode(null);
    setError(null);
  }

  async function connect() {
    if (!status || (purpose === "choose" && !model)) return;
    if (status.connected) {
      if (purpose === "choose") onReady?.(status, model);
      return;
    }

    setConnecting(true);
    setAuthEvent(null);
    setAuthLink(null);
    setAuthPrompt(null);
    setDeviceCode(null);
    setPromptAnswer("");
    setError(null);
    const controller = new AbortController();
    login.current = controller;
    try {
      const next = await connectModelProvider(status.provider, event => {
        setAuthEvent(event);
        if (event.type === "prompt") { setAuthPrompt(event); setPromptAnswer(""); }
        if (event.type === "device_code") setDeviceCode(event.userCode);
        const link = event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : null;
        if (link && /^https?:\/\//i.test(link)) setAuthLink(link);
      }, controller.signal);
      setProviders(current => current.map(item => item.provider === next.provider ? next : item));
      const selected = next.models.some(item => item.id === model) ? model : preferredModel(next);
      setModel(selected);
      onReady?.(next, selected);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (login.current === controller) login.current = null;
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (!status?.connected) return;
    setDisconnecting(true);
    setError(null);
    try {
      const result = await disconnectModelProvider(status);
      if (!result.confirmed) return;
      setProviders(current => current.map(item => (
        item.provider === result.status.provider ? result.status : item
      )));
      setAuthEvent({ type: "info", message: `${status.name} was disconnected.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return <div style={{ color: tk.ink3, padding: compact ? 8 : 20 }}>Checking available subscriptions…</div>;
  }

  if (!status) {
    return <div role="alert" style={{ color: tk.danger, padding: compact ? 8 : 20 }}>{error ?? "No subscription providers are available"}</div>;
  }

  return (
    <section style={{
      background: tk.surface,
      border: `1px solid ${status.connected ? "rgba(138,168,156,0.45)" : tk.border}`,
      borderRadius: tk.r3,
      padding: compact ? 16 : 20,
      maxWidth: 620,
    }} data-testid="provider-access-card">
      <label style={{ display: "flex", flexDirection: "column", gap: 5, color: tk.ink3, fontSize: 11.5 }}>
        Provider
        <select
          aria-label="Subscription provider"
          value={status.provider}
          onChange={event => selectProvider(event.target.value)}
          disabled={connecting || disconnecting}
          style={selectStyle}
        >
          {providers.map(item => (
            <option key={item.provider} value={item.provider}>
              {item.name}{item.connected ? " · connected" : ""}
            </option>
          ))}
        </select>
      </label>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 16 }}>
        <div style={{
          width: 38, height: 38, flex: "0 0 38px", borderRadius: 10,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(138,168,156,0.12)", color: tk.accent, fontWeight: 650,
        }}>{status.name.slice(0, 1)}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, color: tk.ink, fontSize: 15, fontWeight: 560 }}>{status.name}</h3>
            {status.connected && (
              <span style={{ color: tk.accent, fontSize: 11, padding: "2px 7px", borderRadius: 999, background: "rgba(138,168,156,0.12)" }}>
                Connected
              </span>
            )}
          </div>
          <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.5 }}>
            Use your {status.auth_name.replace(/^.*?\((.*)\)$/, "$1")} subscription. Sign-in opens in your browser and credentials stay on this device.
          </p>
        </div>
      </div>

      {purpose === "choose" && (
        <label style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 16, color: tk.ink3, fontSize: 11.5 }}>
          Default model
          <select
            aria-label="Provider default model"
            value={model}
            onChange={event => setModel(event.target.value)}
            disabled={connecting || disconnecting || status.models.length === 0}
            style={selectStyle}
          >
            {status.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}

      {connecting && deviceCode && (
        <div role="status" style={{ marginTop: 14, padding: 12, borderRadius: tk.r2, background: "rgba(255,255,255,0.04)", color: tk.ink2 }}>
          Enter this code in the provider page: <strong style={{ letterSpacing: "0.12em", color: tk.ink }}>{deviceCode}</strong>
        </div>
      )}
      {(authEvent?.type === "progress" || authEvent?.type === "info") && (
        <p role="status" style={{ margin: "12px 0 0", color: tk.ink3, fontSize: 12.5 }}>{authEvent.message}</p>
      )}
      {authEvent?.type === "auth_url" && (
        <p role="status" style={{ margin: "12px 0 0", color: tk.ink3, fontSize: 12.5 }}>
          {authEvent.instructions ?? "Complete sign-in in the browser window."}
        </p>
      )}
      {connecting && authLink && <p><a href={authLink} target="_blank" rel="noopener noreferrer" style={{ color: tk.accent }}>Open {status.name} sign-in</a></p>}
      {connecting && authPrompt && <form onSubmit={event => {
        event.preventDefault();
        if (answering) return;
        const submitted = authPrompt;
        setAnswering(true);
        setError(null);
        void answerProviderPrompt(submitted, promptAnswer).then(() => {
          setAuthPrompt(current => current?.prompt_id === submitted.prompt_id ? null : current);
        }).catch(err => setError(err instanceof Error ? err.message : "Floe could not send this sign-in answer.")).finally(() => setAnswering(false));
      }} style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <label>{authPrompt.message}
          {authPrompt.kind === "select" ? <select aria-label="Sign-in answer" disabled={answering} value={promptAnswer} onChange={event => setPromptAnswer(event.target.value)} style={selectStyle}>
            <option value="">Choose…</option>{authPrompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select> : <input aria-label="Sign-in answer" disabled={answering} autoComplete="off" placeholder={authPrompt.placeholder} value={promptAnswer} onChange={event => setPromptAnswer(event.target.value)} style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }} />}
        </label>
        <button type="submit" disabled={!promptAnswer || answering}>{answering ? "Sending…" : "Continue sign-in"}</button>
      </form>}
      {error && <p role="alert" style={{ margin: "14px 0 0", color: tk.danger, fontSize: 12.5 }}>{error}</p>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting || disconnecting || (purpose === "choose" && !model) || (purpose === "add" && status.connected)}
          style={{
            border: "none", borderRadius: tk.r2, padding: "8px 14px",
            background: tk.accent, color: "#0c1714", fontWeight: 590, fontSize: 12.5,
            opacity: connecting || disconnecting || (purpose === "choose" && !model) || (purpose === "add" && status.connected) ? 0.55 : 1,
          }}
        >
          {connecting
            ? `Waiting for ${status.name}…`
            : status.connected
              ? purpose === "add" ? "Connected" : "Use this account"
              : `Continue with ${status.name}`}
        </button>
        {status.connected && isTauri() && (
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={connecting || disconnecting}
            style={{
              border: `1px solid ${tk.border}`,
              borderRadius: tk.r2,
              padding: "8px 14px",
              background: "transparent",
              color: tk.ink2,
              fontWeight: 540,
              fontSize: 12.5,
              opacity: connecting || disconnecting ? 0.55 : 1,
            }}
          >
            {disconnecting ? `Disconnecting ${status.name}…` : "Disconnect"}
          </button>
        )}
        {connecting && <span style={{ color: tk.ink3, fontSize: 12 }}>Complete the sign-in in your browser.</span>}
        {connecting && !isTauri() && <button type="button" onClick={() => { login.current?.abort(); setAuthEvent(null); setAuthLink(null); }}>Cancel sign-in</button>}
      </div>
    </section>
  );
}

function initialProviderId(providers: ModelProviderStatus[], purpose: "choose" | "add"): string {
  const preferred = purpose === "add"
    ? providers.find(item => !item.connected)
    : providers.find(item => item.connected);
  return preferred?.provider ?? providers[0]?.provider ?? "";
}

function initialModel(providers: ModelProviderStatus[], purpose: "choose" | "add"): string {
  const providerId = initialProviderId(providers, purpose);
  const status = providers.find(item => item.provider === providerId) ?? providers[0];
  return status ? preferredModel(status) : "";
}

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
  borderRadius: tk.r2, padding: "8px 10px", color: tk.ink, fontSize: 13,
};
