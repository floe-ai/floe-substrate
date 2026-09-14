import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { htmlPreviewHostUrl } from "../../bus-client/transport.ts";
import { tk } from "../../theme.ts";

/** Mount once per saved version. Only verified HTML bytes enter the sandbox;
 * its scripts receive no Floe API, native bridge, credentials or parent access. */
export function HtmlArtefactPreview({ html, actionLabel = "Run interactive result", description = "Runs this saved version in an isolated preview. It cannot access your Floe account or workspace, but it may connect to the internet." }: {
  html: string; actionLabel?: string; description?: string;
}) {
  const [running, setRunning] = useState(false);
  return <section aria-label="Interactive saved result">
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
      <button type="button" disabled={running} onClick={() => setRunning(true)} style={{
        border: `1px solid ${tk.border2}`, borderRadius: tk.r3, padding: "9px 14px",
        background: "transparent", color: tk.ink, cursor: "pointer", whiteSpace: "nowrap",
      }}>{actionLabel}</button>
      {!running && <span style={{ color: tk.ink3, fontSize: 12, lineHeight: 1.5 }}>
        {description}
      </span>}
    </div>
    {running && <RunningHtmlPreview html={html} onStop={() => setRunning(false)} />}
  </section>;
}

function RunningHtmlPreview({ html, onStop }: { html: string; onStop: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sent = useRef(false);
  const channel = useRef<MessageChannel | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      channel.current?.port1.close();
      channel.current?.port2.close();
      element.close();
    };
  }, []);

  return createPortal(<dialog ref={dialog} aria-label="Saved result preview" onCancel={onStop} style={{
    width: "min(1100px, calc(100vw - 32px))", height: "min(800px, calc(100dvh - 32px))",
    boxSizing: "border-box", margin: "auto", padding: 14, border: `1px solid ${tk.border}`, borderRadius: 12,
    background: tk.surface, color: tk.ink, display: "flex", flexDirection: "column", gap: 12,
  }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <span style={{ color: tk.ink3, fontSize: 13 }}>Saved result preview</span>
      <button type="button" onClick={onStop} style={{
        border: `1px solid ${tk.border}`, borderRadius: 6, padding: "8px 14px",
        background: tk.surfaceHov, color: tk.ink, cursor: "pointer",
      }}>Stop preview</button>
    </div>
    <iframe
    title="Interactive saved result"
    src={htmlPreviewHostUrl()}
    sandbox="allow-scripts"
    tabIndex={0}
    referrerPolicy="no-referrer"
    style={{ width: "100%", flex: 1, minHeight: 0, border: 0, borderRadius: 8, background: "#0a0b0c" }}
    onLoad={(event) => {
      event.currentTarget.focus();
      if (sent.current || !event.currentTarget.contentWindow) return;
      // Replacing the bootstrap document fires load again. Never reinitialise
      // a running result or transfer another port after navigation.
      sent.current = true;
      const transfer = new MessageChannel();
      channel.current = transfer;
      transfer.port1.onmessage = (message) => {
        if (message.data?.type === "floe.preview.close") onStop();
      };
      transfer.port1.start();
      event.currentTarget.contentWindow.postMessage(
        { type: "floe.preview.html", version: 1 }, "*", [transfer.port2],
      );
      transfer.port1.postMessage({ html });
    }}
  /></dialog>, document.body);
}
