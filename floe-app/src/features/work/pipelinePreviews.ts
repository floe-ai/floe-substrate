import { useEffect, useRef, useState } from "react";
import type { ActorDefinitionRevision, InspectArtefactOperationResult, NodeExecutionRecord } from "../../bus-client/types.ts";
import { invokeOperation, listOperations } from "../../bus-client/client.ts";
import { readArtefactVersionContent } from "../../bus-client/transport.ts";
import { inspectCanonicalArtefactVersion } from "./CanonicalArtefactDetail.tsx";

export type PipelineArtefact = { versionId: string; portId: string; memberKey: string };
export type PipelinePreview = { name: string; image?: string; mediaType: string; error?: string };
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export function pipelineInputs(execution: NodeExecutionRecord | null): PipelineArtefact[] {
  return unique((execution?.inputs ?? []).flatMap(input => input.artefact_version_id
    ? [{ versionId: input.artefact_version_id, portId: input.port_id, memberKey: input.member_key }] : []));
}

export function pipelineOutputs(execution: NodeExecutionRecord | null): PipelineArtefact[] {
  return unique((execution?.publications ?? []).flatMap(publication => [
    ...(publication.outputs ?? []).flatMap(output => output.artefact_version_id
      ? [{ versionId: output.artefact_version_id, portId: publication.port_id, memberKey: output.member_key }] : []),
    ...(publication.artefact_version_ids ?? []).map(versionId => ({ versionId, portId: publication.port_id, memberKey: "" })),
  ]));
}

function unique(refs: PipelineArtefact[]): PipelineArtefact[] {
  return [...new Map(refs.map(ref => [`${ref.portId}:${ref.versionId}:${ref.memberKey}`, ref])).values()]
    .filter((ref, index, all) => ref.memberKey || !all.some((other, otherIndex) => otherIndex !== index && other.versionId === ref.versionId && other.portId === ref.portId && other.memberKey));
}

export function pipelinePreviewName(result: InspectArtefactOperationResult): string {
  const version = result.selected!.version;
  const ref = version.content_ref;
  if (ref.kind === "workspace-relative") {
    const filename = ref.path.split(/[\\/]/).at(-1);
    if (filename && !/^[a-f0-9]{64}$/i.test(filename)) return filename;
  }
  const media = (ref.media_type ?? "").split(";")[0]!.trim().toLowerCase();
  const type = result.artefact.type_ref;
  const declaredName = !type.includes("/") ? type.replace(/[_.:-]+/g, " ").trim() : "";
  const name = declaredName ? declaredName[0]!.toUpperCase() + declaredName.slice(1)
    : media.startsWith("image/") ? "Image" : media === "text/html" ? "Website"
    : media === "model/gltf-binary" ? "3D model" : media === "text/markdown" ? "Document"
    : media === "application/json" ? "Data file" : type.split(/[:/]/).at(-1)?.replace(/[_.-]+/g, " ") || "Saved output";
  return `${name} · version ${version.ordinal}`;
}

/** Cache only this mounted view's exact-version previews, never authority or live heads. */
export function usePipelinePreviews(workspaceId: string, versionIds: string[]): Map<string, PipelinePreview> {
  const [previews, setPreviews] = useState(new Map<string, PipelinePreview>());
  const lifetime = useRef<{ disposed: boolean; urls: Set<string>; requested: Set<string>; queue: string[]; active: number }>({
    disposed: false, urls: new Set(), requested: new Set(), queue: [], active: 0,
  });
  const ids = JSON.stringify([...new Set(versionIds)].sort());
  useEffect(() => {
    const state = { disposed: false, urls: new Set<string>(), requested: new Set<string>(), queue: [] as string[], active: 0 };
    lifetime.current = state;
    setPreviews(new Map());
    return () => { state.disposed = true; state.urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [workspaceId]);
  useEffect(() => {
    const state = lifetime.current;
    for (const id of JSON.parse(ids) as string[]) {
      if (!state.requested.has(id)) { state.requested.add(id); state.queue.push(id); }
    }
    async function drain() {
      if (state.active >= 4 || state.disposed) return;
      const id = state.queue.shift();
      if (!id) return;
      state.active++;
      let preview: PipelinePreview;
      try {
        const result = await inspectCanonicalArtefactVersion(workspaceId, id, false);
        if (state.disposed) return;
        const version = result.selected!.version;
        preview = { name: pipelinePreviewName(result), mediaType: (version.content_ref.media_type ?? "").split(";")[0]!.trim().toLowerCase() };
        if (RASTER_TYPES.has(preview.mediaType)) {
          const content = await readArtefactVersionContent(workspaceId, id);
          if (state.disposed) return;
          if (!RASTER_TYPES.has(content.mediaType)) throw new Error("The saved content is not a supported image.");
          preview.image = URL.createObjectURL(content.data);
          state.urls.add(preview.image);
        }
      } catch (error) {
        preview = { name: "Saved output", mediaType: "", error: error instanceof Error ? error.message : "Preview unavailable" };
      } finally {
        state.active--;
        void drain();
      }
      if (!state.disposed) setPreviews(current => new Map(current).set(id, preview));
    }
    for (let worker = 0; worker < 4; worker++) void drain();
  }, [ids, workspaceId]);
  return previews;
}

/** Resolve the retained definition once, so historical work keeps its actor identity. */
export function usePipelineActorNames(workspaceId: string, executions: Array<NodeExecutionRecord | null>): Map<string, string> {
  const [names, setNames] = useState(new Map<string, string>());
  const requested = useRef(new Set<string>());
  const pins = JSON.stringify([...new Set(executions.flatMap(node => node?.actor_definition_revision_id ? [node.actor_definition_revision_id] : []))].sort());
  useEffect(() => { requested.current = new Set(); setNames(new Map()); }, [workspaceId]);
  useEffect(() => {
    const lifetime = requested.current;
    for (const id of JSON.parse(pins) as string[]) {
      if (lifetime.has(id)) continue;
      lifetime.add(id);
      void (async () => {
        const target = { kind: "actor_definition_revision", id };
        const operation = (await listOperations(workspaceId, target)).find(item => item.operation_id === "actor.definition.get");
        if (!operation?.availability.available) return;
        const receipt = await invokeOperation(workspaceId, {
          operation_id: operation.operation_id, operation_version: operation.operation_version,
          input_schema_version: operation.input.version, target, input: {}, idempotency_key: `pipeline-actor:${crypto.randomUUID()}`,
        });
        const revision = (receipt.result as { revision?: ActorDefinitionRevision } | null)?.revision;
        if (receipt.state === "completed" && revision?.actor_definition_revision_id === id && lifetime === requested.current) {
          setNames(current => new Map(current).set(id, revision.content.label));
        }
      })().catch(() => { /* The card retains its endpoint label when inspection is unavailable. */ });
    }
  }, [pins, workspaceId]);
  useEffect(() => () => { requested.current = new Set(); }, []);
  return names;
}
