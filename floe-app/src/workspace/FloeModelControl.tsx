import React, { useEffect, useState } from "react";
import { isLocalBrowserConnection } from "../bus-client/browser.ts";
import { ProviderAccess } from "../providers/ProviderAccess.tsx";
import { getModelProviders, preferredModel, type ModelProviderStatus } from "../providers/modelProviders.ts";
import { loadActorModel, saveActorModel, type ActorModel } from "./actorModel.ts";
import { tk } from "../theme.ts";

export function FloeModelControl({ workspaceId, endpointId, onReadyChange, readOnly = false }: {
  workspaceId: string; endpointId: string; onReadyChange: (ready: boolean) => void; onOpenSettings?: () => void; readOnly?: boolean;
}): React.ReactElement {
  const editable = !readOnly || isLocalBrowserConnection();
  const [current, setCurrent] = useState<ActorModel | null>(null);
  const [providers, setProviders] = useState<ModelProviderStatus[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("off");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setCurrent(null); onReadyChange(false);
    Promise.all([loadActorModel(workspaceId, endpointId), editable ? getModelProviders() : Promise.resolve([])])
      .then(([saved, accounts]) => {
        if (cancelled) return;
        setCurrent(saved); setProviders(accounts);
        setProviderId(String(saved.profile.content.configuration.provider ?? ""));
        setModelId(String(saved.profile.content.configuration.model ?? ""));
        setEffort(String(saved.profile.content.configuration.thinking_level ?? "off"));
      }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Floe could not read the saved model."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, endpointId, editable, onReadyChange, reload]);
  const provider = providers.find(item => item.provider === providerId);
  const selectedModel = provider?.models.find(item => item.id === modelId);
  const saved = current?.profile.content.configuration;
  const unchanged = saved?.provider === providerId && saved?.model === modelId && (saved?.thinking_level ?? "off") === effort;
  const ready = !loading && !saving && unchanged && current?.binding.status === "resolved" && Boolean(modelId) && (!editable || !!provider?.connected);
  useEffect(() => onReadyChange(ready), [ready, onReadyChange]);
  async function save(account = provider, model = modelId, thinking = effort, refreshAfterConnection = false) {
    if (!current || !account || saving) return;
    setSaving(true); setError(null);
    try {
      // Connecting an account can resolve a previous binding. Use that retained result.
      const selected = refreshAfterConnection ? await loadActorModel(workspaceId, endpointId) : current;
      setCurrent(await saveActorModel(workspaceId, selected, account, model, thinking));
    }
    catch (err) { setError(err instanceof Error ? err.message : "Floe could not save the model."); }
    finally { setSaving(false); }
  }
  if (loading) return <div role="status">Checking the saved model…</div>;
  if (!current) return <div role="alert">{error}<button onClick={() => setReload(value => value + 1)}>Retry</button></div>;
  const needsAccount = editable && (connecting || !providers.some(item => item.connected));
  return <div aria-label="Collaborator model selection" style={{ display: "grid", gap: 10 }}>
    {needsAccount ? <ProviderAccess compact initialProviders={providers} onReady={(account, model) => {
      setProviders(items => items.map(item => item.provider === account.provider ? account : item));
      const thinking = account.models.find(item => item.id === model)?.reasoning_efforts.includes("high") ? "high" : "off";
      setProviderId(account.provider); setModelId(model); setEffort(thinking); setConnecting(false);
      void save(account, model, thinking, true);
    }} /> : <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {editable ? <>
        <select aria-label="Floe provider" value={providerId} disabled={saving} style={selectStyle} onChange={event => {
          const next = providers.find(item => item.provider === event.target.value);
          setProviderId(event.target.value); setModelId(next ? preferredModel(next) : ""); setEffort("off"); setError(null);
        }}>
          <option value="">Provider</option>{providers.filter(item => item.connected).map(item => <option key={item.provider} value={item.provider}>{item.name}</option>)}
        </select>
        <select aria-label="Floe model" value={modelId} disabled={saving || !provider} style={selectStyle} onChange={event => {
          setModelId(event.target.value);
          if (!provider?.models.find(item => item.id === event.target.value)?.reasoning_efforts.includes(effort)) setEffort("off");
          setError(null);
        }}>
          <option value="">Model</option>{provider?.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select aria-label="Floe effort" value={effort} disabled={saving || !selectedModel?.reasoning_efforts.length} style={selectStyle} onChange={event => { setEffort(event.target.value); setError(null); }}>
          {["off", ...(selectedModel?.reasoning_efforts ?? [])].map(value => <option key={value} value={value}>{value === "off" ? "No effort" : `${value} effort`}</option>)}
        </select>
        <button
          type="button"
          disabled={saving || !modelId || !provider?.connected || (unchanged && ready)}
          onClick={() => void save()}
          style={{
            border: "none", borderRadius: tk.r2, padding: "6px 14px",
            background: tk.accent, color: "#0c1714", fontWeight: 590, fontSize: 12,
            cursor: saving || !modelId || !provider?.connected || (unchanged && ready) ? "default" : "pointer",
            opacity: saving || !modelId || !provider?.connected || (unchanged && ready) ? 0.55 : 1,
          }}
        >{saving ? "Saving…" : "Use model"}</button>
        <button type="button" disabled={saving} onClick={() => setConnecting(true)} style={linkStyle}>Connect account</button>
      </> : <span>{providerId} · {modelId || "No model selected"}</span>}
      <span role="status" style={{ color: ready ? tk.accent : tk.ink3 }}>{saving ? "Saving…" : ready ? "Ready" : "Choose an account and model"}</span>
    </div>}
    {current.binding.unresolved_reasons.includes("operation_authority_unmapped") && <span role="status">This collaborator needs workspace permissions before it can start.</span>}
    {error && <div role="alert" style={{ color: tk.danger }}>{error} <button onClick={() => setReload(value => value + 1)}>Refresh saved model</button></div>}
    {!editable && !ready && <span>Connect an account and choose a model in Floe on this computer.</span>}
  </div>;
}
const selectStyle: React.CSSProperties = { background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`, borderRadius: tk.r2, padding: "6px 9px", color: tk.ink, fontSize: 12, minWidth: 116 };
const linkStyle: React.CSSProperties = { border: "none", background: "transparent", color: tk.accent, fontSize: 12.5, padding: 0, textDecoration: "underline" };

