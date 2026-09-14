import viewerScript from "virtual:floe-model-viewer";
import { useMemo } from "react";
import { modelPreviewDocument } from "../../previews/model-document.ts";
import { HtmlArtefactPreview } from "./HtmlArtefactPreview.tsx";

export default function ModelArtefactPreview({ bytes }: { bytes: ArrayBuffer }) {
  const html = useMemo(() => modelPreviewDocument(bytes, viewerScript), [bytes]);
  return <HtmlArtefactPreview html={html} actionLabel="Open 3D view"
    description="Rotate, zoom and inspect this saved model. Your view does not change the saved result." />;
}
