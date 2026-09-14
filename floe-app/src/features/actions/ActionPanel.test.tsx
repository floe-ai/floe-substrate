import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as client from "../../bus-client/client.ts";
import type { OperationInvocationReceipt, SemanticOperationDescriptor } from "../../bus-client/types.ts";
import { ActionPanel } from "./ActionPanel.tsx";

vi.mock("../../bus-client/client.ts", () => ({
  listOperations: vi.fn(), invokeOperation: vi.fn(), confirmAndInvokeOperation: vi.fn(), getOperationReceipt: vi.fn(), getContext:vi.fn(), listEndpoints:vi.fn(),
  SemanticOperationError: class extends Error {},
}));
vi.mock("../work/CanonicalArtefactDetail.tsx", () => ({ CanonicalArtefactDetail: () => <div>Exact saved evidence</div> }));

const read: SemanticOperationDescriptor = {
  operation_id: "approval.list", operation_version: "2", authority_boundary_kinds: ["workspace"], category: "approvals", title: "List approvals", description: "Read current requests.",
  effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" }, required_grants: ["approval.list"], interaction_constraints: {},
  target: { resource_kinds: [], expected_revision: "not_applicable" }, input: { version: "3", schema: { type: "object", additionalProperties: false, properties: { attention_only: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 500 } } } },
  result: { version: "1", schema: { type: "object" } }, availability: { available: true },
};
const write: SemanticOperationDescriptor = {
  ...read, operation_id: "extension.example.revise", category: "example", title: "Revise example", description: "Change an example using a newly discovered extension action.",
  effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" }, target: { resource_kinds: ["example"], expected_revision: "required" },
  input: { version: "7", schema: { type: "object", additionalProperties: false, required: ["decision", "reason", "count"], properties: { decision: { enum: ["changes_requested", "approved"] }, reason: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1 } } } },
};
const target = { ref: { kind: "example", id: "example-1", revision: "opaque:current" }, label: "Reviewed example" };
function receipt(overrides: Partial<OperationInvocationReceipt> = {}): OperationInvocationReceipt {
  return { receipt_id: "receipt-1", invocation_id: "receipt-1", operation_id: read.operation_id, operation_version: "2", principal_id: "principal-me", authority_boundary: { kind: "workspace", workspace_id: "ws" }, workspace_id: "ws", target: null, expected_resource_revision: null, idempotency_key: "key", request_digest: "digest", state: "completed", result_schema_version: "1", result: { requests: [] }, refusal: null, changed_refs: [], progress_ref: null, cancel_ref: null, audit_ref: null, started_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z", completed_at: "2026-09-05T00:00:00Z", ...overrides };
}
function open(initialTarget = target) { return render(<ActionPanel workspaceId="ws" workspaceName="Campaign" initialTarget={initialTarget} onClose={vi.fn()} />); }
async function prepareWrite() {
  fireEvent.click(await screen.findByRole("button", { name: /Revise example/ }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "The evidence needs correction." } });
  fireEvent.change(screen.getByLabelText("Count"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Review action" }));
  expect(client.invokeOperation).not.toHaveBeenCalled();
}
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); vi.mocked(client.listOperations).mockResolvedValue([read, write]); vi.mocked(client.invokeOperation).mockResolvedValue(receipt()); });
afterEach(cleanup);

describe("shared app actions", () => {
  it("opens a referenced approval with its discovered read and current recorded state", async () => {
    const inspect = {...read, operation_id:"approval.inspect",title:"Inspect approval", target:{resource_kinds:["approval_request"],expected_revision:"not_applicable" as const},input:{version:"2",schema:{type:"object",properties:{},additionalProperties:false}}};
    vi.mocked(client.listOperations).mockResolvedValue([inspect]);
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt({operation_id:inspect.operation_id,result:{request:{
      approval_request_id:"approval-1",status:"approved",decision:"approved",decision_reason:"Local test only",
      action:{expected_effect:{summary:"Export the reviewed gallery"}},resource_ref:{kind:"approval_request",id:"approval-1",revision:"7"},
    }}}));
    render(<ActionPanel workspaceId="ws" workspaceName="Preview" initialTarget={{ref:{kind:"approval_request",id:"approval-1",revision:"2"},label:"Preview approval"}} initialReadOperationId="approval.inspect" onClose={vi.fn()} />);
    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(screen.getAllByText("Local test only").length).toBeGreaterThan(0);
    expect(client.invokeOperation).toHaveBeenCalledExactlyOnceWith("ws",expect.objectContaining({operation_id:"approval.inspect",operation_version:"2",input_schema_version:"2",target:{kind:"approval_request",id:"approval-1"},input:{}}));
  });
  it("does not automatically run a reference's action if discovery reports a write", async () => {
    vi.mocked(client.listOperations).mockResolvedValue([{...write,operation_id:"approval.inspect",title:"Changed operation"}]);
    render(<ActionPanel workspaceId="ws" workspaceName="Preview" initialTarget={target} initialReadOperationId="approval.inspect" onClose={vi.fn()} />);
    await screen.findByRole("button",{name:/Changed operation/});
    expect(client.invokeOperation).not.toHaveBeenCalled();
  });
  it("chooses a responding collaborator by name and submits the current exact request", async () => {
    const inspect = {...read, operation_id:"approval.inspect",title:"Inspect approval", target:{resource_kinds:["approval_request"],expected_revision:"not_applicable" as const},input:{version:"1",schema:{type:"object",properties:{},additionalProperties:false}}};
    const configure = {...write,operation_id:"approval.response.configure",title:"Choose decision response",category:"approvals",
      target:{resource_kinds:["approval_request"],expected_revision:"required" as const}, input:{version:"1",schema:{type:"object",required:["response_participant_id"],additionalProperties:false,
        properties:{response_participant_id:{oneOf:[{type:"string",minLength:1},{type:"null"}]}}}}};
    vi.mocked(client.listOperations).mockResolvedValue([inspect,configure]);
    vi.mocked(client.getContext).mockResolvedValue({context_id:"ctx",participants:["actor:floe","actor:retired"]} as Awaited<ReturnType<typeof client.getContext>>);
    vi.mocked(client.listEndpoints).mockResolvedValue([
      {endpoint_id:"actor:floe",name:"Floe",status:"idle"}, {endpoint_id:"actor:other",name:"Unrelated collaborator",status:"idle"},
      {endpoint_id:"actor:retired",name:"Retired collaborator",status:"retired"},
    ] as Awaited<ReturnType<typeof client.listEndpoints>>);
    vi.mocked(client.invokeOperation).mockResolvedValueOnce(receipt({operation_id:"approval.inspect",result:{request:{context_id:"ctx",response_participant_id:null,
      resource_ref:{kind:"approval_request",id:"approval:exact",revision:"7"}}}}));
    open({ref:{kind:"approval_request",id:"approval:exact",revision:"6"},label:"Local preview approval"});
    fireEvent.click(await screen.findByRole("button",{name:/Choose decision response/}));
    const chooser = await screen.findByLabelText("Responding collaborator");
    expect(screen.queryByRole("option",{name:"Unrelated collaborator"})).toBeNull();
    expect(screen.queryByRole("option",{name:"Retired collaborator"})).toBeNull();
    expect(screen.queryByText("Choose response participant id type")).toBeNull();
    fireEvent.change(chooser,{target:{value:"actor:floe"}});
    fireEvent.click(screen.getByRole("button",{name:"Review action"}));
    expect(screen.getByText("Responding collaborator: Floe")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Confirm action"}));
    await waitFor(()=>expect(client.invokeOperation).toHaveBeenLastCalledWith("ws",expect.objectContaining({operation_id:"approval.response.configure",
      expected_resource_revision:"7",input:{response_participant_id:"actor:floe"}})));
  });
  it("uses a saved output name while submitting its exact reference under the current descriptor", async () => {
    const publish = { ...write, operation_id: "scope.node-output.publish", title: "Publish output",
      input: { version: "1", schema: { type: "object", required: ["port_id"], additionalProperties: false,
        properties: { port_id: { type: "string", minLength: 1 } } } } };
    vi.mocked(client.listOperations).mockResolvedValue([publish]);
    render(<ActionPanel workspaceId="ws" workspaceName="Review" initialTarget={target} onClose={vi.fn()}
      fieldChoices={{ "scope.node-output.publish": { port_id: { label: "Output", options: [{ label: "Reviewed result", value: "port:retained-output" }] } } }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Publish output/ }));
    fireEvent.change(screen.getByLabelText("Output"), { target: { value: "port:retained-output" } });
    expect(screen.queryByLabelText("Port id")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review action" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(client.invokeOperation).toHaveBeenCalledWith("ws", expect.objectContaining({
      operation_id: "scope.node-output.publish", expected_resource_revision: "opaque:current", input: { port_id: "port:retained-output" },
    })));
  });
  it("runs discovered reads with typed optional values and displays honest empty approval state", async () => {
    render(<ActionPanel workspaceId="ws" workspaceName="Campaign" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /List approvals/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add attention only" }));
    fireEvent.click(screen.getByLabelText("Attention only"));
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    expect(await screen.findByText(/No approval requests match this view/)).toBeTruthy();
    expect(client.invokeOperation).toHaveBeenCalledWith("ws", expect.objectContaining({ operation_id: "approval.list", operation_version: "2", input_schema_version: "3", target: null, input: { attention_only: true, limit: 20 } }));
  });
  it("uses a newly discovered action without a bespoke handler and preserves its exact target revision", async () => {
    open(); await prepareWrite(); fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await screen.findByText("Completed");
    expect(client.invokeOperation).toHaveBeenCalledWith("ws", expect.objectContaining({ operation_id: write.operation_id, input_schema_version: "7", expected_resource_revision: "opaque:current", target: { kind: "example", id: "example-1" }, input: { decision: "changes_requested", reason: "The evidence needs correction.", count: 2 } }));
  });
  it("does not submit when permission is revoked between discovery and confirmation", async () => {
    open(); await prepareWrite();
    vi.mocked(client.listOperations).mockResolvedValue([{ ...write, availability: { available: false, refusal: { code: "grant_missing", message: "Your permission was revoked.", retryable: false, required_action: null, details: {} } } }]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your permission was revoked.");
    expect(client.invokeOperation).not.toHaveBeenCalled();
  });
  it("reuses the original request after a lost response and a remount", async () => {
    vi.mocked(client.invokeOperation).mockRejectedValueOnce(new Error("Response lost"));
    const view = open(); await prepareWrite(); fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await screen.findByText(/The result is unknown/);
    const original = vi.mocked(client.invokeOperation).mock.calls[0][1]; view.unmount();
    open(); fireEvent.click(await screen.findByRole("button", { name: "Retrieve result / retry same action" }));
    await screen.findByText("Completed");
    expect(vi.mocked(client.invokeOperation).mock.calls[1][1]).toEqual(original);
    expect(sessionStorage.getItem("floe:pending-action:ws")).toBeNull();
  });
  it("passes required confirmation through the trusted transport and honours cancellation", async () => {
    vi.mocked(client.listOperations).mockResolvedValue([{ ...write, interaction_constraints: { confirmation: { required: true, title: "Confirm", description: "Review this exact change." } } }]);
    vi.mocked(client.confirmAndInvokeOperation).mockResolvedValue({ confirmed: false });
    open(); await prepareWrite(); fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(client.confirmAndInvokeOperation).toHaveBeenCalled());
    expect(client.invokeOperation).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Review action" })).toBeTruthy();
  });
  it("retains an unknown earlier outcome when later retrieval is refused", async () => {
    vi.mocked(client.invokeOperation).mockRejectedValueOnce(new Error("Response lost")).mockRejectedValueOnce(new client.SemanticOperationError("Access revoked", "forbidden"));
    open(); await prepareWrite(); fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retrieve result / retry same action" }));
    await screen.findByText("Access revoked");
    expect(screen.getByText(/The result is unknown/)).toBeTruthy();
    expect(sessionStorage.getItem("floe:pending-action:ws")).not.toBeNull();
  });
  it("requires a new review when the discovered effect or confirmation changes", async () => {
    open(); await prepareWrite();
    vi.mocked(client.listOperations).mockResolvedValue([{ ...write, effects: { ...write.effects, external: true } }]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await screen.findByText(/This action changed/); expect(client.invokeOperation).not.toHaveBeenCalled();
  });
  it("uses the canonical approval reference without asking for an ID", async () => {
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt({ result: { requests: [{ approval_request_id: "request-1", resource_ref: { kind: "approval_request", id: "request-1", revision: "8" }, status: "pending", reason: "Review the retained gallery", action: { expected_effect: { summary: "Publish reviewed gallery" }, artefact_version_ids: [] }, progress: { approvals_received: 0, approvals_required: 1 } }] } }));
    render(<ActionPanel workspaceId="ws" workspaceName="Campaign" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /List approvals/ })); fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review available actions" }));
    await waitFor(() => expect(client.listOperations).toHaveBeenLastCalledWith("ws", { kind: "approval_request", id: "request-1", revision: "8" }));
    expect(screen.getByText("Publish reviewed gallery")).toBeTruthy();
  });
  it("keeps asynchronous acceptance distinct from completion and explicitly refreshes the receipt", async () => {
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt({ state: "accepted", completed_at: null, result: null }));
    vi.mocked(client.getOperationReceipt).mockResolvedValue(receipt());
    open(); fireEvent.click(await screen.findByRole("button", { name: /List approvals/ })); fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    await screen.findByText("Work accepted — completion pending");
    fireEvent.click(screen.getByRole("button", { name: "Check action result" })); await screen.findByText("Completed");
    expect(client.getOperationReceipt).toHaveBeenCalledWith("ws", "receipt-1");
    expect(client.invokeOperation).toHaveBeenCalledWith("ws", expect.objectContaining({ target: null }));
  });
});
