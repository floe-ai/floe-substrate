import React, { useEffect, useState } from "react";
import { File, FileJson2, FileText, FolderOpen, Image as ImageIcon } from "lucide-react";
import { readWorkspaceFile, workspaceMediaSource, type WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { tk } from "../../theme.ts";
import type { ArtifactLineageNode } from "./ArtifactLineageView.tsx";

export type ArtifactFileKind = "image" | "json" | "markdown" | "folder" | "file";

export function artifactFileKind(path: string | null): ArtifactFileKind {
  if (!path) return "file";
  const fileName = path.split(/[\\/]/).at(-1) ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : null;
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension ?? "")) return "image";
  if (extension === "json") return "json";
  if (["md", "markdown"].includes(extension ?? "")) return "markdown";
  if (!extension || path.endsWith("/") || path.endsWith("\\")) return "folder";
  return "file";
}

function iconFor(kind: ArtifactFileKind, size: number): React.ReactElement {
  const props = { size, strokeWidth: 1.4, color: tk.ink3 };
  if (kind === "image") return <ImageIcon {...props} />;
  if (kind === "json") return <FileJson2 {...props} />;
  if (kind === "markdown") return <FileText {...props} />;
  if (kind === "folder") return <FolderOpen {...props} />;
  return <File {...props} />;
}

function textPreview(kind: ArtifactFileKind, raw: string): string {
  if (kind !== "json") return raw.trim().slice(0, 1800);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2).slice(0, 1800);
  } catch {
    return raw.trim().slice(0, 1800);
  }
}

export function ArtifactPreview({
  workspace,
  node,
  variant = "thumbnail",
  showText = false,
}: {
  workspace: WorkspaceFsRef;
  node: ArtifactLineageNode;
  variant?: "thumbnail" | "hero" | "graph";
  showText?: boolean;
}): React.ReactElement {
  const kind = artifactFileKind(node.path);
  const [imageSource, setImageSource] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageSource(null);
    setText(null);
    setFailed(false);
    if (!node.path) return () => { cancelled = true; };
    if (kind === "image") {
      void workspaceMediaSource(workspace, node.path)
        .then((source) => {
          if (!cancelled) {
            objectUrl = source;
            setImageSource(source);
          } else if (source.startsWith("blob:")) {
            URL.revokeObjectURL(source);
          }
        })
        .catch(() => { if (!cancelled) setFailed(true); });
    } else if (showText && (kind === "json" || kind === "markdown")) {
      void readWorkspaceFile(workspace, node.path)
        .then((contents) => { if (!cancelled) setText(textPreview(kind, contents)); })
        .catch(() => { if (!cancelled) setFailed(true); });
    }
    return () => {
      cancelled = true;
      if (objectUrl?.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, node.path, showText, workspace.locator, workspace.workspace_id]);

  const height = variant === "hero" ? 260 : variant === "graph" ? 74 : 62;
  const iconSize = variant === "hero" ? 34 : 22;
  const frameStyle: React.CSSProperties = {
    width: "100%",
    height,
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    borderRadius: variant === "hero" ? tk.r3 : tk.r2,
    border: `1px solid ${tk.border2}`,
    background: "#0a0b0c",
  };

  if (kind === "image" && imageSource && !failed) {
    return (
      <div style={frameStyle}>
        <img
          src={imageSource}
          alt={node.path?.split(/[\\/]/).at(-1) ?? "Artifact preview"}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
        />
      </div>
    );
  }

  if (showText && text) {
    return (
      <pre style={{
        ...frameStyle, display: "block", margin: 0, padding: 12, boxSizing: "border-box",
        overflow: "auto", whiteSpace: "pre-wrap", color: tk.ink2, fontSize: 10.5, lineHeight: 1.45,
      }}>
        {text}
      </pre>
    );
  }

  return (
    <div style={frameStyle} aria-label={`${kind} artifact`}>
      <div style={{ display: "grid", placeItems: "center", gap: 5 }}>
        {iconFor(kind, iconSize)}
        {variant === "hero" && (
          <span style={{ color: failed ? tk.danger : tk.ink4, fontSize: 10.5 }}>
            {failed ? "Preview unavailable" : kind === "image" ? "Loading image…" : kind.toUpperCase()}
          </span>
        )}
      </div>
    </div>
  );
}
