import React, { useState } from "react";
import type { OperationResourceRef } from "../../bus-client/types.ts";
import { CanonicalArtefactDetail } from "../work/CanonicalArtefactDetail.tsx";
import { ActionResult } from "./ActionResult.tsx";
import { approvalDecisionLabel } from "./approvalPresentation.ts";
import { record, words, type Schema } from "./SchemaFields.tsx";

/** Rich presentation of approval evidence; actions and decisions stay discovered. */
export function ApprovalResult({ workspaceId, result, schema, onSelectResource, artefactLabels }: {
  workspaceId: string; result: unknown; schema: Schema; onSelectResource: (ref: OperationResourceRef, label: string) => void;
  artefactLabels?: ReadonlyMap<string, string>;
}): React.ReactElement {
  const [version, setVersion] = useState<string | null>(null);
  if (!record(result)) return <ActionResult value={result} schema={schema} onSelectResource={onSelectResource} />;
  const requests = Array.isArray(result.requests) ? result.requests : record(result.request) ? [result.request] : null;
  if (!requests) return <ActionResult value={result} schema={schema} onSelectResource={onSelectResource} />;
  return <section aria-label="Approval requests"><h3>Approval requests</h3>
    {requests.length === 0 && <p>No approval requests match this view. A message saying work is ready for approval does not itself create a request.</p>}
    {requests.filter(record).map((request, index) => {
      const action = record(request.action) ? request.action : {};
      const effect = record(action.expected_effect) ? action.expected_effect : {};
      const title = typeof effect.summary === "string" ? effect.summary : typeof request.reason === "string" ? request.reason : `Approval request ${index + 1}`;
      const ref = record(request.resource_ref) && request.resource_ref.kind === "approval_request" && typeof request.resource_ref.id === "string" ? request.resource_ref as OperationResourceRef : null;
      const progress = record(request.progress) ? request.progress : null;
      const versions = Array.isArray(action.artefact_version_ids) ? action.artefact_version_ids.filter((item): item is string => typeof item === "string") : [];
      const decision = request.status === "approved" || request.status === "rejected" ? approvalDecisionLabel(request.decision) : null;
      return <article className="action-result-object" key={String(request.approval_request_id ?? index)}><h3>{title}</h3>
        <p><strong>{decision ?? words(String(request.status ?? "Unknown"))}</strong></p>
        {typeof request.decision_reason === "string" && request.decision_reason && <p>{request.decision_reason}</p>}
        {typeof request.reason === "string" && request.reason !== title && <p>{request.reason}</p>}
        {progress && <p>{String(progress.approvals_received)} of {String(progress.approvals_required)} required approvals received</p>}
        {typeof request.expires_at === "string" && <p>Expires {new Date(request.expires_at).toLocaleString()}</p>}
        {versions.length > 0 && <div><h4>Exact evidence</h4>{versions.map((id, position) => <button key={id} type="button" onClick={() => setVersion(version === id ? null : id)}>{version === id ? "Close" : "Open"} {artefactLabels?.get(id) ?? `evidence ${position + 1}`}</button>)}</div>}
        {ref ? <button type="button" onClick={() => onSelectResource(ref, title)}>Review available actions</button> : <p>Refresh this request to obtain its current action reference.</p>}
        <details><summary>Full request and decision history</summary><ActionResult value={request} onSelectResource={onSelectResource} /></details>
      </article>;
    })}
    {version && <CanonicalArtefactDetail workspaceId={workspaceId} artefactVersionId={version} />}
  </section>;
}
