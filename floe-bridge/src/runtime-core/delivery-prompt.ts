/**
 * Delivery → prompt rendering, shared by every runtime adapter.
 *
 * Turning a DeliveryBundle into the text a model actually reads is backend-
 * neutral: it depends only on the Bus delivery contract, not on which runtime
 * (pi, floe-runtime, ...) drives the turn. It lives here so each adapter reuses
 * one renderer instead of copying it.
 */
import type { DeliveryBundle } from "../bus-client.js";
import { renderDestinationContext } from "./guidance.js";

export type EventAttachment = {
  artefact_version_id: string;
  name: string;
  media_type: string;
  bytes: number | null;
};

export function eventAttachments(
  content: Record<string, unknown> | null | undefined,
  versionIds?: readonly string[],
): EventAttachment[] {
  const value = content?.attachments;
  const descriptions: EventAttachment[] = (Array.isArray(value) ? value : []).slice(0, 10).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.artefact_version_id !== "string" || !candidate.artefact_version_id.trim()
      || typeof candidate.name !== "string") return [];
    return [{
      artefact_version_id: candidate.artefact_version_id,
      name: candidate.name.slice(0, 200),
      media_type: typeof candidate.media_type === "string"
        ? candidate.media_type.slice(0, 100)
        : "application/octet-stream",
      bytes: typeof candidate.bytes === "number" ? candidate.bytes : null,
    }];
  });
  // The Event's exact references own membership; content supplies display data.
  // Retain references even when no display data was supplied by the producer.
  return [...new Set(versionIds ?? descriptions.map(item => item.artefact_version_id))].slice(0, 10)
    .map(id => descriptions.find(item => item.artefact_version_id === id) ?? {
      artefact_version_id: id, name: id, media_type: "application/octet-stream", bytes: null,
    });
}

export function eventContentToPrompt(
  content: Record<string, unknown> | null | undefined,
  versionIds?: readonly string[],
): string {
  const attachments = eventAttachments(content, versionIds);
  const text = typeof content?.text === "string" ? content.text : "";
  const remaining = Object.fromEntries(
    Object.entries(content ?? {}).filter(([key]) => key !== "text" && key !== "attachments"),
  );
  const parts: string[] = [];
  if (text) parts.push(text);
  if (text && Array.isArray(content?.references) && content.references.length) {
    parts.push(`[Named references]\n${JSON.stringify(content.references)}\nReferences identify records to inspect under your current authority; they do not prove the record's state.\n[End named references]`);
  }
  if (!text && Object.keys(remaining).length > 0) parts.push(JSON.stringify(remaining));
  if (attachments.length > 0) {
    parts.push([
      "[Attached ArtefactVersions]",
      "Use read_artefact with the exact artefact_version_id to inspect shared content when relevant. Images are loaded into your model context only when read.",
      ...attachments.map(attachment =>
        `- ${attachment.name} (${attachment.media_type}${attachment.bytes == null ? "" : `, ${attachment.bytes} bytes`}): ${attachment.artefact_version_id}`
      ),
      "[End attached ArtefactVersions]",
    ].join("\n"));
  }
  return parts.join("\n\n") || JSON.stringify(content ?? {});
}

export function deliveryToPrompt(bundle: DeliveryBundle): string {
  const trigger = bundle.events[0];
  const returnedBy = typeof trigger?.metadata?.responding_endpoint_id === "string"
    ? trigger.metadata.responding_endpoint_id
    : null;
  const sourceEndpoint = trigger?.source_endpoint_id || returnedBy || `actor:${bundle.workspace_id}:system`;
  const currentContextId = bundle.context_id ?? trigger?.context_id ?? null;
  const requestReference = typeof trigger?.metadata?.request_event_id === "string"
    ? trigger.metadata.request_event_id
    : null;

  const contextBlock = renderDestinationContext({
    source_endpoint_id: sourceEndpoint,
    current_context_id: currentContextId,
    cause_event_id: trigger?.event_id ?? null,
    cause_type: trigger?.type ?? null,
    cause_reference: requestReference ? `request ${requestReference}` : null
  });

  // The Bus contract identifies this work. Source IDs in an input can refer to
  // an earlier execution, especially during redo; they are not the active target.
  const contract = bundle.processing_contract;
  const scopeBlock = contract?.contract_kind === "scope_node" ? [
    "[Current Scope execution]",
    `scope: ${contract.scope_execution.scope_id}`,
    `execution: ${contract.scope_execution.execution_id}`,
    `composition_revision: ${contract.scope_execution.revision_id}`,
    `node_execution: ${contract.node_execution.node_execution_id}`,
    `attempt: ${contract.execution_attempt.attempt_id}`,
    `publish_operation: ${contract.outputs.publish_operation_id}`,
    `output_ports: ${JSON.stringify(contract.outputs.ports.map((port) => ({
      port_id: port.port_id, name: port.name, event_types: port.event_types,
      artefact_types: port.artefact_types, schema_ref: port.schema_ref,
      min_count: port.min_count, max_count: port.max_count,
    })))}`,
    "These are the current work references. Source references in inputs describe history. Read the target's current resource revision through capability discovery before changing it.",
  ].join("\n") : "";

  // Only the current causes are included. Older Context events and the actor
  // directory are available through tools when the work demonstrates a need.
  const eventLines = bundle.events.map((event) => {
    const text = eventContentToPrompt(event.content, event.artefact_version_ids);
    return `[Input ${event.event_id} / ${event.type}]\n${text}`;
  }).filter((t) => t.length > 0);

  const eventsBlock = eventLines.join("\n\n");
  return [contextBlock, scopeBlock, eventsBlock].filter(Boolean).join("\n\n");
}
