import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { File, FileJson2, FileText, Image as ImageIcon } from "lucide-react";
import { invokeOperation, listOperations } from "../../bus-client/client.ts";
import { readArtefactVersionContent } from "../../bus-client/transport.ts";
import type {
  ArtefactContentRef,
  ArtefactLineage,
  ArtefactVersion,
  InspectArtefactOperationResult,
} from "../../bus-client/types.ts";
import { tk } from "../../theme.ts";
import { MiniMarkdown } from "../../actors/markdown.tsx";
import { HtmlArtefactPreview } from "./HtmlArtefactPreview.tsx";

const INSPECT_ARTEFACT_OPERATION_ID = "artefact.inspect";
const ModelArtefactPreview = lazy(() => import("./ModelArtefactPreview.tsx"));
const SAFE_RASTER_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function clientIdempotencyKey(versionId: string, includeHistory: boolean): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `app-artefact-inspect:${versionId}:${includeHistory ? "history" : "exact"}:${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactInspectResult(value: unknown, requestedVersionId: string): InspectArtefactOperationResult {
  if (!isRecord(value)
    || !isRecord(value.artefact)
    || !Array.isArray(value.heads)
    || typeof value.history_complete !== "boolean"
    || !Array.isArray(value.versions)
    || !isRecord(value.selected)
    || !isRecord(value.selected.version)
    || value.selected.version.artefact_version_id !== requestedVersionId) {
    throw new Error("Floe returned incomplete evidence for this exact ArtefactVersion.");
  }
  return value as InspectArtefactOperationResult;
}

export async function inspectCanonicalArtefactVersion(
  workspaceId: string,
  artefactVersionId: string,
  includeHistory: boolean,
): Promise<InspectArtefactOperationResult> {
  const target = { kind: "artefact_version", id: artefactVersionId };
  const operations = await listOperations(workspaceId, target);
  const operation = operations.find((candidate) => candidate.operation_id === INSPECT_ARTEFACT_OPERATION_ID);
  if (!operation) throw new Error("This Workspace does not expose canonical Artefact inspection.");
  if (!operation.availability.available) throw new Error(operation.availability.refusal.message);
  const receipt = await invokeOperation(workspaceId, {
    operation_id: operation.operation_id,
    operation_version: operation.operation_version,
    input_schema_version: operation.input.version,
    target,
    idempotency_key: clientIdempotencyKey(artefactVersionId, includeHistory),
    input: { artefact_version_id: artefactVersionId, include_history: includeHistory },
  });
  if (receipt.state === "refused") {
    throw new Error(receipt.refusal?.message ?? "Floe refused to inspect this ArtefactVersion.");
  }
  if (receipt.state !== "completed") {
    throw new Error("Floe has not completed this Artefact inspection yet.");
  }
  return exactInspectResult(receipt.result, artefactVersionId);
}

function compactId(value: string): string {
  return value.length > 32 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value;
}

function resolverHint(contentRef: ArtefactContentRef): string | null {
  if (contentRef.kind !== "workspace-relative") return null;
  return contentRef.path.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

function digestValue(contentRef: ArtefactContentRef): string | null {
  return "digest" in contentRef ? contentRef.digest?.value ?? null : null;
}

function relationLabel(relation: ArtefactLineage, direction: "from" | "to"): string {
  const raw = relation.relation_type.replace(/^core:/, "").replace(/^extension:/, "");
  const phrase = raw.replaceAll("-", " ").replaceAll("/", " · ");
  if (direction === "from") return phrase;
  switch (relation.relation_type) {
    case "core:derived-from": return "derived from this version";
    case "core:supersedes": return "supersedes this version";
    case "core:test-of": return "tests this version";
    case "core:decision-about": return "decides about this version";
    case "core:deployment-of": return "deploys this version";
    default: return `${phrase} this version`;
  }
}

function VersionButton({ versionId, children, onSelect }: {
  versionId: string;
  children?: React.ReactNode;
  onSelect: (versionId: string) => void;
}): React.ReactElement {
  return <button
    type="button"
    onClick={() => onSelect(versionId)}
    style={{
      padding: 0,
      color: tk.accentHov,
      background: "transparent",
      border: "none",
      cursor: "pointer",
      font: "inherit",
      textAlign: "left",
      overflowWrap: "anywhere",
    }}
  >{children ?? compactId(versionId)}</button>;
}

function CanonicalArtefactPreview({ workspaceId, version }: {
  workspaceId: string;
  version: ArtefactVersion;
}): React.ReactElement {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "image"; source: string }
    | { kind: "html"; html: string }
    | { kind: "model"; bytes: ArrayBuffer }
    | { kind: "text"; text: string; mediaType: string }
    | { kind: "unsupported"; mediaType: string }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void readArtefactVersionContent(workspaceId, version.artefact_version_id)
      .then(async (content) => {
        if (cancelled) return;
        if (SAFE_RASTER_MEDIA_TYPES.has(content.mediaType)) {
          objectUrl = URL.createObjectURL(content.data);
          setState({ kind: "image", source: objectUrl });
          return;
        }
        if (content.mediaType === "text/html") {
          const html = await content.data.text();
          if (!cancelled) setState({ kind: "html", html });
          return;
        }
        if (content.mediaType === "model/gltf-binary") {
          const bytes = await content.data.arrayBuffer();
          if (!cancelled) setState({ kind: "model", bytes });
          return;
        }
        if (content.mediaType.startsWith("text/") || content.mediaType === "application/json") {
          const text = (await content.data.text()).slice(0, 20_000);
          if (!cancelled) setState({ kind: "text", text, mediaType: content.mediaType });
          return;
        }
        setState({ kind: "unsupported", mediaType: content.mediaType });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ kind: "failed", message: error instanceof Error ? error.message : "Preview unavailable" });
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [version.artefact_version_id, workspaceId]);

  const frame: React.CSSProperties = {
    minHeight: 174,
    maxHeight: 320,
    display: "grid",
    placeItems: "center",
    overflow: "auto",
    border: `1px solid ${tk.border2}`,
    borderRadius: tk.r3,
    background: "#0a0b0c",
  };
  if (state.kind === "image") {
    return <div style={frame}><img src={state.source} alt="Exact ArtefactVersion preview" style={{ width: "100%", maxHeight: 318, objectFit: "contain" }} /></div>;
  }
  if (state.kind === "html") {
    return <HtmlArtefactPreview key={version.artefact_version_id} html={state.html} />;
  }
  if (state.kind === "model") {
    return <Suspense fallback={<p>Loading 3D viewer…</p>}>
      <ModelArtefactPreview key={version.artefact_version_id} bytes={state.bytes} />
    </Suspense>;
  }
  if (state.kind === "text") {
    return <article aria-label="Exact ArtefactVersion text preview" style={{
      padding: "18px 8px", minWidth: 0, overflowWrap: "anywhere", color: tk.ink2,
    }}>
      {state.mediaType === "text/markdown"
        ? <MiniMarkdown source={state.text} fontSize={15} />
        : <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.65 }}>{state.text}</pre>}
    </article>;
  }
  const declaredMediaType = version.content_ref.media_type ?? "application/octet-stream";
  const icon = declaredMediaType === "application/json"
    ? <FileJson2 size={28} strokeWidth={1.4} />
    : declaredMediaType.startsWith("text/")
      ? <FileText size={28} strokeWidth={1.4} />
      : declaredMediaType.startsWith("image/")
        ? <ImageIcon size={28} strokeWidth={1.4} />
        : <File size={28} strokeWidth={1.4} />;
  return <div style={{ ...frame, color: state.kind === "failed" ? tk.danger : tk.ink3 }}>
    <span style={{ display: "grid", placeItems: "center", gap: 8, padding: 18, textAlign: "center" }}>
      {icon}
      <span style={{ fontSize: 11.5 }}>
        {state.kind === "loading" && "Loading exact content…"}
        {state.kind === "unsupported" && `No inline preview for ${state.mediaType}`}
        {state.kind === "failed" && state.message}
      </span>
    </span>
  </div>;
}

export function CanonicalArtefactDetail({ workspaceId, artefactVersionId, onOpenContext }: {
  workspaceId: string;
  artefactVersionId: string;
  onOpenContext?: (contextId: string) => void;
}): React.ReactElement {
  const [selectedVersionId, setSelectedVersionId] = useState(artefactVersionId);
  const [result, setResult] = useState<InspectArtefactOperationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelectedVersionId(artefactVersionId), [artefactVersionId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setError(null);
    setHistoryLoading(false);
    void inspectCanonicalArtefactVersion(workspaceId, selectedVersionId, false)
      .then((next) => { if (!cancelled) setResult(next); })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not inspect this ArtefactVersion"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedVersionId, workspaceId]);

  const selected = result?.selected ?? null;
  const selectedIsHead = useMemo(() => result?.heads.some((head) => head.artefact_version_id === selectedVersionId) ?? false, [result?.heads, selectedVersionId]);

  async function showHistory() {
    if (historyLoading || result?.history_complete) return;
    setHistoryLoading(true);
    setError(null);
    try {
      setResult(await inspectCanonicalArtefactVersion(workspaceId, selectedVersionId, true));
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : "Could not load retained versions");
    } finally {
      setHistoryLoading(false);
    }
  }

  if (loading) return <section aria-label="Artefact detail" style={{ marginTop: 12, padding: 16, color: tk.ink3, border: `1px solid ${tk.border}`, borderRadius: tk.r3 }}>Loading exact ArtefactVersion…</section>;
  if (error && !result) return <section aria-label="Artefact detail" role="alert" style={{ marginTop: 12, padding: 16, color: tk.danger, border: `1px solid ${tk.border}`, borderRadius: tk.r3 }}>{error}</section>;
  if (!result || !selected) return <section aria-label="Artefact detail" role="alert" style={{ marginTop: 12, padding: 16, color: tk.danger, border: `1px solid ${tk.border}`, borderRadius: tk.r3 }}>This exact ArtefactVersion is unavailable.</section>;

  const hint = resolverHint(selected.version.content_ref);
  const digest = digestValue(selected.version.content_ref);
  return <section aria-label="Artefact detail" style={{ marginTop: 12, padding: 14, display: "grid", gap: 13, color: tk.ink, background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3 }}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
      <strong style={{ fontSize: 13, fontWeight: 560 }}>Saved version {selected.version.ordinal}</strong>
    </header>

    <CanonicalArtefactPreview workspaceId={workspaceId} version={selected.version} />

    <details>
    <summary style={{ color: tk.ink3, cursor: "pointer", fontSize: 12 }}>Version details</summary>
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 8 }}>
      <Fact label="Type" value={result.artefact.type_ref} />
      <Fact label="Exact version" value={selected.version.artefact_version_id} />
      <Fact label="Branch status" value={selectedIsHead ? "Branch head" : "Retained version"} />
      {hint && <Fact label="Resolver hint" value={hint} />}
      <Fact label="Media type" value={selected.version.content_ref.media_type ?? "Not declared"} />
      <Fact label="Size" value={selected.version.content_ref.size_bytes == null ? "Not declared" : `${selected.version.content_ref.size_bytes.toLocaleString()} bytes`} />
      {digest && <Fact label="SHA-256" value={compactId(digest)} />}
    </div>

    {(selected.lineage_from.length > 0 || selected.lineage_to.length > 0) && <RelationshipSection title="Lineage">
      {selected.lineage_from.map((relation) => <RelationshipRow key={relation.lineage_id} label={relationLabel(relation, "from")}><VersionButton versionId={relation.object_version_id} onSelect={setSelectedVersionId} /></RelationshipRow>)}
      {selected.lineage_to.map((relation) => <RelationshipRow key={relation.lineage_id} label={relationLabel(relation, "to")}><VersionButton versionId={relation.subject_version_id} onSelect={setSelectedVersionId} /></RelationshipRow>)}
    </RelationshipSection>}

    {selected.associations.length > 0 && <RelationshipSection title="Related records">
      {selected.associations.map((association) => <RelationshipRow key={association.association_id} label={`${association.role} · ${association.target_kind.replaceAll("_", " ")}`}>
        {association.target_kind === "context" && onOpenContext
          ? <button type="button" onClick={() => onOpenContext(association.target_id)} style={{ padding: 0, color: tk.accentHov, background: "transparent", border: "none", cursor: "pointer", font: "inherit" }}>Open Context</button>
          : <code style={{ color: tk.ink3, fontSize: 10 }}>{compactId(association.target_id)}</code>}
      </RelationshipRow>)}
    </RelationshipSection>}

    </div>
    </details>

    {selected.members.length > 0 && <RelationshipSection title={`Collection members (${selected.members.length})`}>
      {selected.members.map((member) => <RelationshipRow key={`${member.member_key}:${member.member_version_id}`} label={member.member_key}><VersionButton versionId={member.member_version_id} onSelect={setSelectedVersionId} /></RelationshipRow>)}
    </RelationshipSection>}

    <details>
      <summary style={{ color: tk.ink3, cursor: "pointer", fontSize: 11.5 }}>Branches and retained versions</summary>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        <RelationshipSection title={`Branch heads (${result.heads.length})`}>
          {result.heads.map((head) => <RelationshipRow key={head.artefact_version_id} label={`Version ${head.ordinal}`}><VersionButton versionId={head.artefact_version_id} onSelect={setSelectedVersionId}>{head.artefact_version_id === selectedVersionId ? "Selected" : compactId(head.artefact_version_id)}</VersionButton></RelationshipRow>)}
        </RelationshipSection>
        {!result.history_complete
          ? <button type="button" onClick={() => void showHistory()} disabled={historyLoading} style={{ justifySelf: "start", padding: "6px 9px", color: tk.accentHov, background: "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: historyLoading ? "default" : "pointer", fontSize: 11 }}>{historyLoading ? "Loading retained versions…" : "Show version history"}</button>
          : <RelationshipSection title={`Version history (${result.versions.length})`}>
            {result.versions.slice().reverse().map((version) => <RelationshipRow key={version.artefact_version_id} label={`Version ${version.ordinal}`}><VersionButton versionId={version.artefact_version_id} onSelect={setSelectedVersionId}>{version.artefact_version_id === selectedVersionId ? "Selected" : compactId(version.artefact_version_id)}</VersionButton></RelationshipRow>)}
          </RelationshipSection>}
      </div>
    </details>

    {selected.annotations.length > 0 && <details>
      <summary style={{ color: tk.ink3, cursor: "pointer", fontSize: 11.5 }}>Extension annotations ({selected.annotations.length})</summary>
      <div style={{ display: "grid", gap: 7, marginTop: 9 }}>
        {selected.annotations.map((annotation) => <RelationshipRow key={annotation.annotation_id} label={`${annotation.namespace} · ${annotation.key}`}><code style={{ color: tk.ink3, fontSize: 10 }}>{annotation.schema_ref ?? "Unschemed value"}</code></RelationshipRow>)}
      </div>
    </details>}

    {error && <div role="alert" style={{ color: tk.danger, fontSize: 11.5 }}>{error}</div>}
  </section>;
}

function Fact({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div style={{ padding: 9, background: tk.canvas, border: `1px solid ${tk.border2}`, borderRadius: tk.r2, minWidth: 0 }}>
    <span style={{ display: "block", color: tk.ink4, fontSize: 9, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</span>
    <span style={{ display: "block", marginTop: 4, color: tk.ink2, fontSize: 10.5, overflowWrap: "anywhere" }}>{value}</span>
  </div>;
}

function RelationshipSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <section style={{ display: "grid", gap: 6 }}>
    <h4 style={{ margin: 0, color: tk.ink4, fontSize: 9.5, fontWeight: 520, letterSpacing: "0.08em", textTransform: "uppercase" }}>{title}</h4>
    {children}
  </section>;
}

function RelationshipRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, padding: "7px 9px", background: tk.canvas, border: `1px solid ${tk.border2}`, borderRadius: tk.r2, fontSize: 10.5 }}>
    <span style={{ color: tk.ink3 }}>{label}</span>
    <span style={{ minWidth: 0, textAlign: "right" }}>{children}</span>
  </div>;
}
