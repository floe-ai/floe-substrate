import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextRef, EndpointRef, EventEnvelope, OperationInvocationRequest, OperationRefusal, ScopeRef } from "../../bus-client/types.ts";
import {
  listContextsByParticipantPage,
  subscribeEvents,
} from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { FloeModelControl } from "../../workspace/FloeModelControl.tsx";
import { isNativeFloeApp } from "../../bus-client/transport.ts";
import { tk } from "../../theme.ts";
import { ContextWorkView } from "../work/ContextWorkView.tsx";
import { ScopeWorkView } from "../work/ScopeWorkView.tsx";
import type { RuntimeHealth } from "../../runtime/health.ts";
import { conversationAttachments } from "../../fs/conversationAttachments.ts";
import { appendAttachmentFiles, AttachmentPicker, pastedFiles } from "./AttachmentPicker.tsx";
import { ProblemReportDialog } from "../feedback/ProblemReportDialog.tsx";
import {
  developerHandoffText,
  listProblemReports,
  type ProblemReportDraft,
  type ProblemReportReceipt,
} from "../feedback/problemReport.ts";
import {
  CONTEXT_ARCHIVE_OPERATION_ID,
  CONTEXT_RESTORE_OPERATION_ID,
  confirmContextDestruction,
  invokeContextLifecycle,
  listArchivedContexts,
  prepareContextDestruction,
} from "./contextLifecycle.ts";
import { ContextCommunicationPendingError, createConversationSubmission } from "./contextCommunication.ts";
import { ensureInteractiveActor } from "../../actors/interactiveActor.ts";

const RECENT_LIMIT = 6;

export type OperatorConversation = {
  context: ContextRef;
  collaborators: string;
  preview: string;
  needsOperator: boolean;
  activityAt: string;
  responseStatus: "Working" | "Stopped" | "Needs attention" | null;
};

export function findFloeEndpoint(endpoints: EndpointRef[]): EndpointRef | null {
  return endpoints.find(endpoint => endpoint.agent_id === "floe")
    ?? endpoints.find(endpoint => endpoint.endpoint_id.endsWith(":floe"))
    ?? null;
}

function endpointName(endpointId: string, endpoints: EndpointRef[]): string {
  const endpoint = endpoints.find(candidate => candidate.endpoint_id === endpointId);
  return endpoint?.name || endpoint?.agent_id || endpointId.split(":").at(-1) || "Collaborator";
}

function latestMessage(events: EventEnvelope[]): EventEnvelope | null {
  return [...events].reverse().find(event => event.type === "message") ?? null;
}

export function summarizeOperatorConversation(
  context: ContextRef,
  events: EventEnvelope[],
  operatorEndpointId: string,
  endpoints: EndpointRef[],
): OperatorConversation {
  const message = latestMessage(events);
  const destination = message?.destination_json;
  const needsOperator = !!message
    && message.source_endpoint_id !== operatorEndpointId
    && destination?.kind === "endpoint"
    && destination.endpoint_id === operatorEndpointId
    && message.response.expected;
  const collaborators = context.participants
    .filter(participant => participant !== operatorEndpointId)
    .map(participant => endpointName(participant, endpoints))
    .join(", ") || "Workspace conversation";
  const attachmentPreview = conversationAttachments(message?.content)
    .map(attachment => `Attached ${attachment.name}`)
    .join(", ");
  const previewText = (typeof message?.content?.["text"] === "string" && message.content["text"].trim()
    ? message.content["text"]
    : null)
    ?? (attachmentPreview || null)
    ?? context.first_message_preview
    ?? "No messages yet";

  return {
    context,
    collaborators,
    preview: previewText.replace(/\s+/g, " ").trim(),
    needsOperator,
    activityAt: context.last_event_at ?? context.created_at,
    responseStatus: (context.delivery_summary?.active_count ?? 0) > 0 ? "Working"
      : context.delivery_summary?.latest_state === "cancelled" ? "Stopped"
      : ["failed", "dead_lettered", "deferred"].includes(context.delivery_summary?.latest_state ?? "") ? "Needs attention" : null,
  };
}

export function latestConversationWith(
  conversations: OperatorConversation[],
  endpointId: string,
): OperatorConversation | null {
  return conversations.find(conversation => conversation.context.participants.includes(endpointId)) ?? null;
}

export type OperatorConversationsProps = {
  workspaceId: string;
  workspaceLocator?: string;
  endpoints: EndpointRef[];
  scopes: ScopeRef[];
  selectedContextId: string | null;
  onOpenContext: (contextId: string) => void;
  onCloseContext: () => void;
  onOpenSettings?: () => void;
  runtimeHealth?: RuntimeHealth;
};

export function OperatorConversations(props: OperatorConversationsProps): React.ReactElement {
  // Participant authority, drafts and pending requests belong to one Workspace.
  // Reset them together before rendering or requesting anything in another one.
  return <WorkspaceConversations key={props.workspaceId} {...props} />;
}

function WorkspaceConversations({
  workspaceId,
  workspaceLocator,
  endpoints,
  scopes,
  selectedContextId,
  onOpenContext,
  onCloseContext,
  onOpenSettings,
  runtimeHealth,
}: OperatorConversationsProps): React.ReactElement {
  const [operator, setOperator] = useState<string | null>(null);
  const [preparingParticipant, setPreparingParticipant] = useState(true);
  const floe = useMemo(() => findFloeEndpoint(endpoints), [endpoints]);
  const [conversations, setConversations] = useState<OperatorConversation[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<OperatorConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setOperator(null);
    setError(null);
    setPreparingParticipant(true);
    void ensureInteractiveActor(workspaceId).then(actor => {
      if (!cancelled) setOperator(actor.actor_id);
    }).catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : "Floe could not prepare your workspace participant.");
    }).finally(() => { if (!cancelled) setPreparingParticipant(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);
  const [showAll, setShowAll] = useState(false);
  const [draftTargetId, setDraftTargetId] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [awaitingReceipt, setAwaitingReceipt] = useState(false);
  const pendingOutcome = useRef<(() => Promise<string>) | null>(null);
  const draftContext = useRef<ContextRef | undefined>(undefined);
  const [conversationActionPending, setConversationActionPending] = useState(false);
  const [conversationActionRefusal, setConversationActionRefusal] = useState<OperationRefusal | null>(null);
  const [conversationDestructionConfirmation, setConversationDestructionConfirmation] = useState<{
    confirmation: { title: string; description: string };
    request: OperationInvocationRequest;
  } | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<"conversation" | "work">("conversation");
  const [selectedScopeWorkId, setSelectedScopeWorkId] = useState<string | null>(null);
  const [reportingContextId, setReportingContextId] = useState<string | null>(null);
  const [reportDraft, setReportDraft] = useState<Partial<ProblemReportDraft> | undefined>();
  const [problemReports, setProblemReports] = useState<ProblemReportReceipt[]>([]);
  const [reportCopyNotice, setReportCopyNotice] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const initialWorkspace = useRef<string | null>(null);

  useEffect(() => {
    setReportingContextId(null);
    setReportDraft(undefined);
    setConversationActionRefusal(null);
    setConversationDestructionConfirmation(null);
  }, [selectedContextId, workspaceId]);
  const initialConversationChosen = useRef(false);

  const load = useCallback(async () => {
    if (!operator) {
      setConversations([]);
      setLoading(false);
      return;
    }
    const sequence = ++loadSequence.current;
    setError(null);
    try {
      const page = await listContextsByParticipantPage({
        participant: operator,
        workspace_id: workspaceId,
        limit: 20,
      });
      const summaries = page.contexts.map(context => summarizeOperatorConversation(
        context,
        context.latest_message ? [context.latest_message] : [],
        operator,
        endpoints,
      ));
      if (sequence !== loadSequence.current) return;
      const sorted = summaries.sort((left, right) => right.activityAt.localeCompare(left.activityAt));
      setConversations(sorted);
      setNextCursor(page.next_cursor);

      if (!initialConversationChosen.current) {
        initialConversationChosen.current = true;
        if (sorted.length === 0 && floe) {
          pendingOutcome.current = null;
          draftContext.current = undefined;
          setAwaitingReceipt(false);
          setDraftTargetId(floe.endpoint_id);
        }
      }
    } catch (loadError) {
      if (sequence !== loadSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load conversations");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [endpoints, floe, onOpenContext, operator, workspaceId]);

  const loadArchived = useCallback(async () => {
    if (!operator) {
      setArchivedConversations([]);
      return;
    }
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const contexts = await listArchivedContexts(workspaceId, operator);
      const summaries = contexts.map(context => ({
        ...summarizeOperatorConversation(context, [], operator, endpoints),
        preview: context.title?.trim() || "Conversation history retained.",
      }));
      setArchivedConversations(
        summaries.sort((left, right) => right.activityAt.localeCompare(left.activityAt)),
      );
    } catch (loadError) {
      setArchivedError(loadError instanceof Error ? loadError.message : "Failed to load archived conversations");
    } finally {
      setArchivedLoading(false);
    }
  }, [endpoints, operator, workspaceId]);

  const loadOlder = useCallback(async () => {
    if (!operator || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await listContextsByParticipantPage({
        participant: operator,
        workspace_id: workspaceId,
        limit: 20,
        before: nextCursor,
      });
      const older = page.contexts.map(context => summarizeOperatorConversation(
        context,
        context.latest_message ? [context.latest_message] : [],
        operator,
        endpoints,
      ));
      setConversations(current => {
        const byId = new Map(current.map(item => [item.context.context_id, item]));
        for (const item of older) byId.set(item.context.context_id, item);
        return [...byId.values()].sort((left, right) => right.activityAt.localeCompare(left.activityAt));
      });
      setNextCursor(page.next_cursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load older conversations");
    } finally {
      setLoadingOlder(false);
    }
  }, [endpoints, loadingOlder, nextCursor, operator, workspaceId]);

  useEffect(() => {
    if (initialWorkspace.current !== workspaceId) {
      initialWorkspace.current = workspaceId;
      initialConversationChosen.current = false;
      pendingOutcome.current = null;
      draftContext.current = undefined;
      setAwaitingReceipt(false);
      setDraftTargetId(null);
      setShowAll(false);
      setShowArchived(false);
      setArchivedConversations([]);
      setArchivedError(null);
      setConversationDestructionConfirmation(null);
      setNextCursor(null);
      setSelectedSurface("conversation");
      setSelectedScopeWorkId(null);
    }
    setLoading(true);
    void load();
  }, [load, workspaceId]);

  useEffect(() => {
    if (!workspaceLocator) {
      setProblemReports([]);
      return;
    }
    let cancelled = false;
    void listProblemReports({ workspace_id: workspaceId, locator: workspaceLocator })
      .then((reports) => { if (!cancelled) setProblemReports(reports); });
    return () => { cancelled = true; };
  }, [workspaceId, workspaceLocator]);

  useEffect(() => {
    const unsubscribe = subscribeEvents(message => {
      if (["delivery_created", "delivery_reserved", "delivery_acknowledged", "delivery_cancelled",
        "delivery_failed", "delivery_dead_lettered", "delivery_deferred"].includes(message.type)) void load();
      if (message.type === "event_submitted") {
        const event = (message.payload as { event?: { workspace_id?: string; type?: string } }).event;
        if (event?.workspace_id === workspaceId) {
          void load();
        }
      }
      if (
        message.type === "context_created"
        || message.type === "context_archived"
        || message.type === "context_restored"
        || message.type === "context_tombstoned"
      ) {
        const context = (message.payload as { context?: { workspace_id?: string }; workspace_id?: string }).context;
        const messageWorkspaceId = context?.workspace_id
          ?? (message.payload as { workspace_id?: string }).workspace_id;
        if (messageWorkspaceId === workspaceId) {
          void load();
          if (showArchived) void loadArchived();
        }
      }
    }, { workspaceId, startAtCurrent: true, onOpen: () => { void load(); if (showArchived) void loadArchived(); } });
    return unsubscribe;
  }, [load, loadArchived, showArchived, workspaceId]);

  function openConversation(contextId: string) {
    pendingOutcome.current = null;
    draftContext.current = undefined;
    setAwaitingReceipt(false);
    setSelectedScopeWorkId(null);
    setDraftTargetId(null);
    setError(null);
    setConversationActionRefusal(null);
    setConversationDestructionConfirmation(null);
    setSelectedSurface("conversation");
    onOpenContext(contextId);
  }

  function startNewWith(targetEndpointId: string) {
    pendingOutcome.current = null;
    draftContext.current = undefined;
    setAwaitingReceipt(false);
    setSelectedScopeWorkId(null);
    setDraftTargetId(targetEndpointId);
    setError(null);
    setConversationActionRefusal(null);
    setConversationDestructionConfirmation(null);
    setSelectedSurface("conversation");
    onCloseContext();
  }

  async function startOutcome(text: string, files: File[]) {
    if (!operator || !draftTargetId || sending || !modelReady) return;
    setSending(true);
    setError(null);
    try {
      pendingOutcome.current ??= createConversationSubmission(workspaceId, {
        context: draftContext.current,
        onContextCreated: context => { draftContext.current = context; },
        participantIds: [operator, draftTargetId],
        recipientParticipantId: draftTargetId,
        text, files,
      });
      const submission = pendingOutcome.current;
      const contextId = await submission();
      if (pendingOutcome.current !== submission) return;
      pendingOutcome.current = null;
      draftContext.current = undefined;
      setAwaitingReceipt(false);
      setDraftTargetId(null);
      onOpenContext(contextId);
      void load();
    } catch (sendError) {
      const pending = sendError instanceof ContextCommunicationPendingError;
      setAwaitingReceipt(pending);
      if (!pending) pendingOutcome.current = null;
      setError(sendError instanceof Error ? sendError.message : "Failed to start conversation");
    } finally {
      setSending(false);
    }
  }

  async function changeCurrentConversation(
    operationId:
      | typeof CONTEXT_ARCHIVE_OPERATION_ID
      | typeof CONTEXT_RESTORE_OPERATION_ID,
  ) {
    if (!selectedConversation || conversationActionPending) return;
    setConversationActionPending(true);
    setError(null);
    setConversationActionRefusal(null);
    setConversationDestructionConfirmation(null);
    try {
      const result = await invokeContextLifecycle(workspaceId, selectedConversation.context, operationId);
      if (result.state === "refused") {
        setConversationActionRefusal(result.refusal);
        return;
      }
      onCloseContext();
      await load();
      if (showArchived) await loadArchived();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to change conversation");
    } finally {
      setConversationActionPending(false);
    }
  }

  async function requestCurrentConversationDestruction() {
    if (!selectedConversation || conversationActionPending) return;
    setConversationActionPending(true);
    setError(null);
    setConversationActionRefusal(null);
    setConversationDestructionConfirmation(null);
    try {
      const result = await prepareContextDestruction(workspaceId, selectedConversation.context);
      if (result.state === "refused") {
        setConversationActionRefusal(result.refusal);
        return;
      }
      setConversationDestructionConfirmation({
        confirmation: result.confirmation,
        request: result.request,
      });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to prepare permanent destruction");
    } finally {
      setConversationActionPending(false);
    }
  }

  async function confirmCurrentConversationDestruction() {
    if (!conversationDestructionConfirmation || conversationActionPending) return;
    setConversationActionPending(true);
    setError(null);
    setConversationActionRefusal(null);
    try {
      const result = await confirmContextDestruction(
        workspaceId,
        conversationDestructionConfirmation.request,
      );
      if (result.state === "cancelled") return;
      setConversationDestructionConfirmation(null);
      if (result.state === "refused") {
        setConversationActionRefusal(result.refusal);
        return;
      }
      onCloseContext();
      await load();
      if (showArchived) await loadArchived();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to permanently destroy conversation");
    } finally {
      setConversationActionPending(false);
    }
  }

  const selectedConversation = conversations.find(
    conversation => conversation.context.context_id === selectedContextId,
  ) ?? archivedConversations.find(
    conversation => conversation.context.context_id === selectedContextId,
  ) ?? null;
  const selectedConversationArchived = selectedConversation?.context.lifecycle_state === "archived";
  const selectedTargetId = selectedConversation?.context.participants.find(
    participant => participant !== operator,
  ) ?? null;

  const selectedScopeWork = scopes.find((scope) => scope.scope_id === selectedScopeWorkId) ?? null;

  useEffect(() => {
    if (selectedScopeWork?.status === "retired") setSelectedScopeWorkId(null);
  }, [selectedScopeWork]);

  if (selectedScopeWork?.status !== "retired" && selectedScopeWork && operator) {
    return (
      <ScopeWorkView
        workspaceId={workspaceId}
        workspace={workspaceLocator ? { workspace_id: workspaceId, locator: workspaceLocator } : undefined}
        scope={selectedScopeWork}
        endpoints={endpoints}
        operatorEndpointId={operator}
        onBack={() => setSelectedScopeWorkId(null)}
      />
    );
  }

  if (draftTargetId && operator) {
    return (
      <NewConversation
        workspaceId={workspaceId}
        endpointId={draftTargetId}
        attachmentsEnabled={!!workspaceLocator}
        collaboratorName={endpointName(draftTargetId, endpoints)}
        onOpenSettings={onOpenSettings}
        onReadyChange={setModelReady}
        onCancel={() => {
          pendingOutcome.current = null;
          draftContext.current = undefined;
          setAwaitingReceipt(false);
          setDraftTargetId(null);
          setError(null);
        }}
        onStart={startOutcome}
        sending={sending}
        awaitingReceipt={awaitingReceipt}
        modelReady={modelReady}
        error={error}
      />
    );
  }

  if (selectedContextId && operator) {
    if (selectedSurface === "work") {
      return (
        <ContextWorkView
          workspaceId={workspaceId}
          rootContextId={selectedContextId}
          scopes={scopes}
          endpoints={endpoints}
          operatorEndpointId={operator}
          onBackToConversation={() => setSelectedSurface("conversation")}
        />
      );
    }
    return (
      <>
        <ContextConversation
          key={selectedContextId}
          contextId={selectedContextId}
          workspaceId={workspaceId}
          workspaceLocator={workspaceLocator}
          endpoints={endpoints}
          readOnly={selectedConversationArchived}
          runtimeHealth={runtimeHealth}
          operatorEntry={{
            operatorEndpointId: operator,
            showContextIdentity: true,
            onOpenSettings,
            onBackToConversations: onCloseContext,
            onOpenWork: () => setSelectedSurface("work"),
            onReportProblem: workspaceLocator ? () => {
              setReportDraft(undefined);
              setReportingContextId(selectedContextId);
            } : undefined,
            onReviewProblemReport: workspaceLocator ? (draft) => {
              setReportDraft(draft);
              setReportingContextId(selectedContextId);
            } : undefined,
            onNewConversation: !selectedConversationArchived && selectedTargetId
              ? () => startNewWith(selectedTargetId)
              : undefined,
            onArchiveConversation: !selectedConversationArchived
              ? () => void changeCurrentConversation(CONTEXT_ARCHIVE_OPERATION_ID)
              : undefined,
            onRestoreConversation: selectedConversationArchived
              ? () => void changeCurrentConversation(CONTEXT_RESTORE_OPERATION_ID)
              : undefined,
            onDestroyConversation: selectedConversationArchived
              ? () => void requestCurrentConversationDestruction()
              : undefined,
            onConfirmDestroyConversation: conversationDestructionConfirmation
              ? () => void confirmCurrentConversationDestruction()
              : undefined,
            conversationLifecycleState: selectedConversation?.context.lifecycle_state ?? "active",
            conversationActionsDisabled: conversationActionPending,
            conversationActionError: error,
            conversationActionRefusal,
            conversationActionConfirmation: conversationDestructionConfirmation?.confirmation ?? null,
          }}
        />
        {reportingContextId && workspaceLocator && (
          <ProblemReportDialog
            workspace={{ workspace_id: workspaceId, locator: workspaceLocator }}
            contextId={reportingContextId}
            operatorEndpointId={operator}
            runtimeHealth={runtimeHealth ?? {
              state: "degraded",
              label: "Runtime status unavailable",
              detail: "The app did not have a current runtime health snapshot.",
            }}
            initialDraft={reportDraft}
            onSaved={(receipt) => setProblemReports((current) => [
              receipt,
              ...current.filter((candidate) => candidate.report_id !== receipt.report_id),
            ])}
            onClose={() => setReportingContextId(null)}
          />
        )}
      </>
    );
  }

  const needsYou = conversations.filter(conversation => conversation.needsOperator);
  const recent = conversations.filter(conversation => !conversation.needsOperator);
  const visibleRecent = showAll ? recent : recent.slice(0, RECENT_LIMIT);
  const activeScopes = scopes.filter((scope) => scope.status !== "retired");

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "34px 32px 48px", fontFamily: tk.fontUi }}>
      <section style={{ width: "min(780px, 100%)", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 28 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 8 }}>Workspace</div>
            <h1 style={{
              margin: "0 0 8px", color: tk.ink, fontSize: 28, fontWeight: 510,
              letterSpacing: "-0.025em", lineHeight: 1.15,
            }}>
              Conversations
            </h1>
            <p style={{ margin: 0, color: tk.ink3, fontSize: 14, lineHeight: 1.5 }}>
              Resume work with Floe and the collaborators who need your input or judgement.
            </p>
          </div>
          {floe && (
            <button
              type="button"
              onClick={() => startNewWith(floe.endpoint_id)}
              style={{
                marginTop: 20, background: tk.accent, color: "#0c1714", border: "none",
                borderRadius: tk.r2, padding: "9px 13px", fontSize: 12.5,
                fontWeight: 590, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              New with Floe
            </button>
          )}
        </div>

        {loading && <StatusText>Loading conversations…</StatusText>}
        {error && <div role="alert" style={{ color: tk.danger, fontSize: 13 }}>{error}</div>}

        {!loading && !error && !operator && (
          <StatusText>{preparingParticipant ? "Preparing your conversation…" : "Your workspace participant is unavailable."}</StatusText>
        )}
        {!loading && !error && operator && conversations.length === 0 && (
          <StatusText>No conversations yet. Start with Floe and describe an outcome.</StatusText>
        )}

        {!loading && !error && operator && activeScopes.length > 0 && (
          <ScopeSection scopes={activeScopes} onOpen={setSelectedScopeWorkId} />
        )}

        {!loading && !error && workspaceLocator && problemReports.length > 0 && (
          <ProblemReportsSection
            reports={problemReports}
            copyNotice={reportCopyNotice}
            onCopy={async (receipt) => {
              try {
                await navigator.clipboard.writeText(developerHandoffText(
                  { workspace_id: workspaceId, locator: workspaceLocator },
                  receipt,
                ));
                setReportCopyNotice("Developer handoff copied.");
              } catch {
                setReportCopyNotice("Could not copy the developer handoff.");
              }
            }}
          />
        )}

        {!loading && !error && needsYou.length > 0 && (
          <ConversationSection
            label="Needs you"
            conversations={needsYou}
            onOpenContext={openConversation}
            attention
          />
        )}

        {!loading && !error && visibleRecent.length > 0 && (
          <ConversationSection
            label="Recent"
            conversations={visibleRecent}
            onOpenContext={openConversation}
          />
        )}

        {!loading && !error && !showAll && (recent.length > RECENT_LIMIT || nextCursor) && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{
              marginTop: 12, background: "transparent", border: "none", color: tk.ink3,
              fontSize: 12.5, cursor: "pointer", padding: "6px 0",
            }}
          >
            Show more conversations
          </button>
        )}

        {!loading && !error && showAll && nextCursor && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            style={{
              marginTop: 12, background: "transparent", border: "none", color: tk.ink3,
              fontSize: 12.5, cursor: loadingOlder ? "default" : "pointer", padding: "6px 0",
              opacity: loadingOlder ? 0.6 : 1,
            }}
          >
            {loadingOlder ? "Loading older conversations…" : "Load older conversations"}
          </button>
        )}

        {!loading && !error && showAll && !nextCursor && recent.length > RECENT_LIMIT && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            style={{
              marginTop: 12, background: "transparent", border: "none", color: tk.ink3,
              fontSize: 12.5, cursor: "pointer", padding: "6px 0",
            }}
          >
            Show fewer
          </button>
        )}

        {!loading && !error && operator && (
          <section style={{ marginTop: 22 }}>
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={() => {
                const next = !showArchived;
                setShowArchived(next);
                if (next) void loadArchived();
              }}
              style={{
                background: "transparent", border: "none", color: tk.ink3,
                fontSize: 12.5, cursor: "pointer", padding: "6px 0",
              }}
            >
              {showArchived ? "Hide archived conversations" : "Archived conversations"}
            </button>
            {showArchived && archivedLoading && <StatusText>Loading archived conversations…</StatusText>}
            {showArchived && archivedError && (
              <div role="alert" style={{ color: tk.danger, fontSize: 13 }}>{archivedError}</div>
            )}
            {showArchived && !archivedLoading && !archivedError && archivedConversations.length === 0 && (
              <StatusText>No archived conversations.</StatusText>
            )}
            {showArchived && !archivedLoading && !archivedError && archivedConversations.length > 0 && (
              <ConversationSection
                label="Archived"
                conversations={archivedConversations}
                onOpenContext={openConversation}
              />
            )}
          </section>
        )}
      </section>
    </div>
  );
}

function ProblemReportsSection({
  reports,
  copyNotice,
  onCopy,
}: {
  reports: ProblemReportReceipt[];
  copyNotice: string | null;
  onCopy: (receipt: ProblemReportReceipt) => Promise<void>;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8, color: tk.ink3, fontSize: 10.5, fontWeight: 590, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        Floe reports
      </div>
      <div role="list" aria-label="Floe reports" style={{ border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden", background: tk.surface }}>
        {reports.slice(0, 3).map((report, index) => (
          <div key={report.report_id} role="listitem" style={{
            display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center",
            padding: "12px 16px", borderTop: index > 0 ? `1px solid ${tk.border2}` : "none",
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ color: tk.ink, fontSize: 13.5, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {report.expected}
                </span>
                <span style={{ color: "#c9a14a", background: "rgba(201,161,74,0.10)", borderRadius: 999, padding: "2px 7px", fontSize: 10.5, whiteSpace: "nowrap" }}>
                  Not shared
                </span>
              </div>
              <div style={{ color: tk.ink4, fontSize: 11.5 }}>Saved locally · {formatActivityTime(report.created_at)}</div>
            </div>
            <button type="button" onClick={() => void onCopy(report)} style={{
              border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: "transparent",
              color: tk.ink2, padding: "6px 9px", fontSize: 11.5, cursor: "pointer",
            }}>
              Copy handoff
            </button>
          </div>
        ))}
      </div>
      {copyNotice && <div role="status" style={{ marginTop: 7, color: tk.ink3, fontSize: 11.5 }}>{copyNotice}</div>}
    </section>
  );
}

function ScopeSection({
  scopes,
  onOpen,
}: {
  scopes: ScopeRef[];
  onOpen: (scopeId: string) => void;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8, color: tk.ink3, fontSize: 10.5, fontWeight: 590, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        Organised work
      </div>
      <div role="list" aria-label="Organised work" style={{ border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden", background: tk.surface }}>
        {scopes.map((scope, index) => (
          <div key={scope.scope_id} role="listitem">
            <button
              type="button"
              onClick={() => onOpen(scope.scope_id)}
              aria-label={`Open organised work ${scope.title || scope.scope_id}`}
              style={{
                width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 16,
                padding: "14px 16px", textAlign: "left", background: "transparent", border: "none",
                borderTop: index > 0 ? `1px solid ${tk.border2}` : "none", cursor: "pointer", color: tk.ink,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14, fontWeight: 550 }}>{scope.title || scope.scope_id}</span>
                <span style={{ display: "block", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {scope.description || "Connected actors and events in this workspace"}
                </span>
              </span>
              <span style={{ alignSelf: "center", color: tk.ink4, fontSize: 11.5, whiteSpace: "nowrap" }}>
                View organisation →
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function NewConversation({
  workspaceId,
  endpointId,
  attachmentsEnabled,
  collaboratorName,
  onOpenSettings,
  onReadyChange,
  onCancel,
  onStart,
  sending,
  awaitingReceipt,
  modelReady,
  error,
}: {
  workspaceId: string;
  endpointId: string;
  attachmentsEnabled: boolean;
  collaboratorName: string;
  onOpenSettings?: () => void;
  onReadyChange: (ready: boolean) => void;
  onCancel: () => void;
  onStart: (text: string, files: File[]) => Promise<void>;
  sending: boolean;
  awaitingReceipt: boolean;
  modelReady: boolean;
  error: string | null;
}): React.ReactElement {
  const [outcome, setOutcome] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const text = outcome.trim();
  const hasMessage = !!text || files.length > 0;

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 32, background: tk.canvas,
    }}>
      <section style={{ width: "min(720px, 100%)" }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            margin: "0 0 24px", padding: 0, border: "none", background: "transparent",
            color: tk.ink3, fontSize: 12.5, cursor: "pointer",
          }}
        >
          ← Conversations
        </button>
        <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 10 }}>
          New conversation with {collaboratorName}
        </div>
        <h1 style={{
          margin: "0 0 10px", color: tk.ink, fontSize: 34, fontWeight: 510,
          letterSpacing: "-0.025em", lineHeight: 1.15,
        }}>
          What do you want to make happen?
        </h1>
        <p style={{ margin: "0 0 22px", color: tk.ink3, fontSize: 14, lineHeight: 1.55 }}>
          Describe the outcome. {collaboratorName} will work out what is needed and involve you when your judgement matters.
        </p>
        <div style={{ marginBottom: 16 }}>
          <FloeModelControl
            readOnly={!isNativeFloeApp()}
            workspaceId={workspaceId}
            endpointId={endpointId}
            onReadyChange={onReadyChange}
            onOpenSettings={onOpenSettings}
          />
        </div>
        {!modelReady && (
          <div role="status" style={{ marginBottom: 10, color: tk.ink3, fontSize: 12.5 }}>
            Choose a provider and model before starting a conversation.
          </div>
        )}
        {error && <div role="alert" style={{ marginBottom: 10, color: tk.danger, fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1, display: "grid", gap: 8 }}>
            <textarea
              autoFocus
              aria-label="Outcome"
              value={outcome}
              onChange={event => setOutcome(event.target.value)}
              onPaste={event => {
                if (!attachmentsEnabled) return;
                const incoming = pastedFiles(event);
                if (incoming.length === 0) return;
                event.preventDefault();
                const result = appendAttachmentFiles(files, incoming);
                if (!result.error) setFiles(result.files);
              }}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (hasMessage && modelReady && !sending) void onStart(text, files);
                }
              }}
              placeholder={modelReady ? "Describe an outcome…" : "Choose a provider and model above"}
              disabled={sending || !modelReady || awaitingReceipt}
              rows={4}
              style={{
                width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 104,
                background: tk.surface, color: tk.ink,
                border: `1px solid ${tk.border}`, borderRadius: tk.r3,
                padding: "13px 14px", fontSize: 14, fontFamily: tk.fontUi,
                lineHeight: 1.5, outline: "none",
              }}
            />
            {attachmentsEnabled && (
              <AttachmentPicker files={files} onChange={setFiles} disabled={sending || !modelReady || awaitingReceipt} />
            )}
          </div>
          <button
            type="button"
            onClick={() => void onStart(text, files)}
            disabled={sending || !modelReady || !hasMessage}
            style={{
              background: tk.accent, color: "#0c1714", border: "none",
              borderRadius: tk.r2, padding: "10px 18px", fontSize: 13,
              fontWeight: 590, opacity: sending || !modelReady || !hasMessage ? 0.5 : 1,
            }}
          >
            {sending ? "Starting…" : awaitingReceipt ? "Retry start" : "Start"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConversationSection({
  label,
  conversations,
  onOpenContext,
  attention = false,
}: {
  label: string;
  conversations: OperatorConversation[];
  onOpenContext: (contextId: string) => void;
  attention?: boolean;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{
        marginBottom: 8, color: attention ? tk.accent : tk.ink3,
        fontSize: 10.5, fontWeight: 590, letterSpacing: "0.1em", textTransform: "uppercase",
      }}>
        {label}
      </div>
      <div role="list" aria-label={label} style={{
        border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden", background: tk.surface,
      }}>
        {conversations.map((conversation, index) => (
          <div key={conversation.context.context_id} role="listitem">
            <button
              type="button"
              onClick={() => onOpenContext(conversation.context.context_id)}
              aria-label={`Open conversation with ${conversation.collaborators}`}
              style={{
                width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 16,
                padding: "14px 16px", textAlign: "left", background: "transparent", border: "none",
                borderTop: index > 0 ? `1px solid ${tk.border2}` : "none", cursor: "pointer",
                color: tk.ink,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 550 }}>{conversation.context.title || conversation.collaborators}</span>
                  {conversation.responseStatus && (
                    <span style={{ color: tk.ink2, background: tk.surfaceHov, borderRadius: 999,
                      padding: "2px 7px", fontSize: 10.5, fontWeight: 590 }}>
                      {conversation.responseStatus}
                    </span>
                  )}
                  {conversation.needsOperator && (
                    <span style={{
                      color: tk.accent, background: "rgba(151,185,172,0.10)", borderRadius: 999,
                      padding: "2px 7px", fontSize: 10.5, fontWeight: 590,
                    }}>
                      Needs you
                    </span>
                  )}
                </span>
                <span style={{
                  display: "block", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {conversation.responseStatus ? "Last message: " : ""}{conversation.preview}
                </span>
              </span>
              <span style={{ color: tk.ink4, fontSize: 11.5, whiteSpace: "nowrap", paddingTop: 2 }}>
                {formatActivityTime(conversation.activityAt)}
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function StatusText({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: "24px 0", color: tk.ink3, fontSize: 13 }}>{children}</div>;
}
