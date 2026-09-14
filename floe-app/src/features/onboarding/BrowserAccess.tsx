import React, { useEffect, useRef, useState } from "react";
import { approveBrowserConnection, listBrowserConnections, type BrowserConnection } from "../../bus-client/browser.ts";
import { tk } from "../../theme.ts";

export function BrowserAccess({ workspaceId, workspaceName, onClose }: { workspaceId: string; workspaceName: string; onClose: () => void }): React.ReactElement {
  const dialog = useRef<HTMLElement>(null);
  const [connections, setConnections] = useState<BrowserConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function refresh() {
    setBusy(true);
    setError(null);
    try { setConnections(await listBrowserConnections()); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not read browser connections."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  async function approve(code: string) {
    setBusy(true);
    setError(null);
    try {
      if (await approveBrowserConnection(code, workspaceId)) {
        setNotice("Access allowed. Select Continue in your browser.");
        setConnections(current => current.filter(item => item.code !== code));
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not allow access."); }
    finally { setBusy(false); }
  }
  return <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.65)", display: "grid", placeItems: "center" }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Remote access" onKeyDown={event => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const first = buttons[0]; const last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} style={{ background: tk.surface, padding: 24, borderRadius: 12, maxWidth: 460, width: "90%", display: "grid", gap: 16 }}>
      <h2 style={{ fontSize: 18 }}>Remote access</h2>
      <p>Allow a browser to work in <strong>{workspaceName}</strong> for one hour. Check that its code matches.</p>
      {connections.map(connection => <div key={connection.code} style={{ display: "grid", gap: 6, borderTop: `1px solid ${tk.border}`, paddingTop: 12 }}>
        <strong style={{ letterSpacing: 2 }}>{connection.code}</strong>
        <span style={{ color: tk.ink3 }}>{connection.origin}</span>
        <button style={{ ...buttonStyle, background: tk.accent, color: "#0c1714" }} disabled={busy} onClick={() => void approve(connection.code)}>Allow workspace access</button>
      </div>)}
      {!busy && !connections.length && <p>{notice ?? "No browser is waiting. Open Floe in your browser and select Connect this browser."}</p>}
      {error && <p role="alert" style={{ color: tk.danger }}>{error}</p>}
      <div style={{ display: "flex", gap: 12 }}><button style={buttonStyle} disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Refresh"}</button><button style={buttonStyle} onClick={onClose}>Close</button></div>
    </section>
  </div>;
}

const buttonStyle: React.CSSProperties = { border: `1px solid ${tk.border}`, borderRadius: tk.r2, padding: "8px 12px", background: "transparent", color: tk.ink, fontSize: 13 };
