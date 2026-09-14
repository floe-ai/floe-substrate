import React, { useState } from "react";
import { claimBrowserConnection, startBrowserConnection, type BrowserConnection as Connection } from "../../bus-client/browser.ts";
import { tk } from "../../theme.ts";

export function BrowserConnection(): React.ReactElement {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "start" | "continue") {
    setBusy(true);
    setError(null);
    try {
      if (action === "start") setConnection(await startBrowserConnection());
      else {
        await claimBrowserConnection();
        window.location.reload();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not connect to Floe.");
    } finally { setBusy(false); }
  }

  return <section aria-label="Connect this browser" style={{ maxWidth: 400, display: "grid", gap: 16, padding: 24, textAlign: "left" }}>
    <h1 style={{ fontSize: 24, fontWeight: 500, color: tk.ink }}>Connect to Floe</h1>
    {!connection ? <>
      <p>To access Floe remotely, allow this browser once in the Floe app on the computer running your workspace.</p>
      <button disabled={busy} style={buttonStyle} onClick={() => void act("start")}>{busy ? "Connecting…" : "Connect this browser"}</button>
    </> : <>
      <p>In the Floe app, open <strong>Remote access</strong> and allow the connection with this code:</p>
      <output aria-label="Connection code" style={{ fontSize: 28, letterSpacing: 4, color: tk.ink, fontVariantNumeric: "tabular-nums" }}>{connection.code}</output>
      <p style={{ fontSize: 12 }}>The code expires in five minutes. Access lasts one hour.</p>
      <button disabled={busy} style={buttonStyle} onClick={() => void act("continue")}>{busy ? "Connecting…" : "Continue"}</button>
      <button disabled={busy} style={{ ...buttonStyle, background: "transparent", color: tk.ink3 }} onClick={() => void act("start")}>Refresh connection</button>
    </>}
    {error && <p role="alert" style={{ color: tk.danger }}>{error}</p>}
  </section>;
}

const buttonStyle: React.CSSProperties = { padding: "10px 16px", background: tk.accent, color: "#0c1714", border: "none", borderRadius: tk.r2, fontSize: 13 };
