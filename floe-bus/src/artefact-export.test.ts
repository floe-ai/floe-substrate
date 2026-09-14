import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPORT_ARTEFACT_VERSION_OPERATION_ID as operationId } from "./artefact-export.js";
import { defaultConfig } from "./config.js";
import { createOperationAuthorityContext, type OperationInvocationRequest, type OperationInvocationResponse } from "./operations.js";
import { BusStore } from "./store.js";

function receipt(response: OperationInvocationResponse) {
  if (response.kind !== "receipt") throw new Error("Expected canonical receipt");
  return response.receipt;
}

describe("exact saved version export through the shared operation", () => {
  let temp: string; let root: string; let bus: BusStore; let workspace: string; let version: string; let grant: string;
  const principal = "principal:exporter";
  const bytes = Buffer.from("<h1>Exact retained gallery</h1>\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "floe-export-")); root = join(temp,"workspace"); mkdirSync(root);
    const config = defaultConfig(temp); const configPath = join(temp,"config.yaml");
    writeFileSync(configPath,YAML.stringify(config)); bus = new BusStore(configPath,config);
    workspace = bus.registerWorkspace({locator:root,name:"Export proof"},()=>{}).workspace_id;
    writeFileSync(join(root,"saved.html"),bytes);
    const artefact = bus.artefactStore.createArtefact({workspace_id:workspace,type_ref:"test:html",idempotency_key:"site"});
    version = bus.artefactStore.publishVersion({artefact_id:artefact.artefact_id,idempotency_key:"site-v1",content_ref:{
      kind:"workspace-relative",path:"saved.html",digest:{algorithm:"sha256",value:digest},size_bytes:bytes.length,media_type:"text/html",
    }}).artefact_version_id;
    grant = bus.capabilityGrantStore.issueGrant({principal_id:principal,boundary:{kind:"workspace",workspace_id:workspace},
      operation_ids:[operationId],expires_at:"2099-01-01T00:00:00.000Z",issuer_id:"test:owner",evidence:[{kind:"test",ref:"export"}],
    }).grant_id;
  });
  afterEach(() => { bus?.close(); rmSync(temp,{recursive:true,force:true}); });
  function environment(mode: "interactive"|"unattended" = "interactive", allowed = true, workspaceId = workspace) {
    const authority = createOperationAuthorityContext({principal_id:principal,boundary:{kind:"workspace",workspace_id:workspaceId},
      capability_grant_ids:allowed?[grant]:[],grants:new Set(allowed?[operationId]:[]),
      interaction:{mode,session_id:`test:${mode}`,confirmed_prompts:new Set(),approval_refs:new Set()},
    });
    return {authority,resolve_resource:(target:{kind:string;id:string})=>bus.resolveOperationResource(target,authority.boundary)};
  }
  function request(path = "published/gallery.html", key = "export"): OperationInvocationRequest {
    return {operation_id:operationId,operation_version:"1",input_schema_version:"1",target:{kind:"artefact_version",id:version},input:{destination_path:path},idempotency_key:key};
  }
  it.each(["interactive","unattended"] as const)("exports identical bytes and preserves canonical history for %s participation",async mode=>{
    const previous = bus.artefactStore.getVersion(version);
    const result = receipt(await bus.operationRegistry.invoke(environment(mode),request()));
    expect(result.state).toBe("completed");
    expect(result.result).toMatchObject({artefact_version_id:version,destination_path:"published/gallery.html",size_bytes:bytes.length,created:true,digest:{algorithm:"sha256",value:digest}});
    expect(readFileSync(join(root,"published/gallery.html"))).toEqual(bytes);
    expect(bus.artefactStore.getVersion(version)).toEqual(previous);
    expect(readdirSync(join(root,"published"))).toEqual(["gallery.html"]);
    expect(receipt(await bus.operationRegistry.invoke(environment(mode),request()))).toEqual(result);
    expect(receipt(await bus.operationRegistry.invoke(environment(mode),request("published/gallery.html","same-bytes"))).result).toMatchObject({created:false});
  });
  it("preserves existing different content and refuses an altered retained source before creating folders",async()=>{
    writeFileSync(join(root,"existing.html"),"existing work");
    expect(receipt(await bus.operationRegistry.invoke(environment(),request("existing.html"))).refusal?.code).toBe("artefact_export_destination_exists");
    expect(readFileSync(join(root,"existing.html"),"utf8")).toBe("existing work");
    writeFileSync(join(root,"saved.html"),Buffer.alloc(bytes.length,120));
    expect(receipt(await bus.operationRegistry.invoke(environment(),request("new/result.html","changed-source"))).refusal?.code).toBe("artefact_content_mismatch");
    expect(existsSync(join(root,"new"))).toBe(false);
  });
  it.each(["../outside.html","/outside.html","C:\\outside.html","nested/../../outside.html","out/file:stream","out/CON.txt","out/file. "])("refuses unsafe destination %s",async path=>{
    expect(receipt(await bus.operationRegistry.invoke(environment(),request(path))).state).toBe("refused");
    expect(existsSync(join(root,"out"))).toBe(false);
    expect(existsSync(join(temp,"outside.html"))).toBe(false);
  });
  it("refuses a symlinked parent escaping the Workspace",async()=>{
    const outside = join(temp,"outside"); mkdirSync(outside);
    symlinkSync(outside,join(root,"escape"),process.platform==="win32"?"junction":"dir");
    expect(receipt(await bus.operationRegistry.invoke(environment(),request("escape/result.html"))).state).toBe("refused");
    expect(readdirSync(outside)).toEqual([]);
  });
  it("refuses absent grants and another Workspace's version",async()=>{
    expect(receipt(await bus.operationRegistry.invoke(environment("interactive",false),request())).state).toBe("refused");
    const other = join(temp,"other"); mkdirSync(other);
    const otherId = bus.registerWorkspace({locator:other},()=>{}).workspace_id;
    expect(receipt(await bus.operationRegistry.invoke(environment("interactive",true,otherId),request())).state).toBe("refused");
    expect(existsSync(join(root,"published"))).toBe(false);
    expect(readdirSync(other)).toEqual([]);
  });
  it("creates an exact approval before any filesystem change, binds destination and version, and consumes approval once",async()=>{
    const policy = bus.policyStore.createPolicy({workspace_id:workspace,category:"operation",content:{label:"Export review",description:"Review exact exports",rules:[{
      rule_id:"approve-export",priority:1,match:{operation_ids:[operationId]},effect:{kind:"require_approval",reason:"Review the exact destination and saved version",approvers:{mode:"any",principal_ids:[bus.localOperatorPrincipalId],roles:[]}},
    }]},created_by_principal_id:bus.localOperatorPrincipalId});
    const published = bus.policyStore.publishRevision({workspace_id:workspace,policy_revision_id:policy.draft.policy_revision_id,expected_current_revision_id:null});
    bus.policyStore.bindRevision({workspace_id:workspace,policy_revision_id:published.revision.policy_revision_id,subject:{kind:"workspace",id:workspace},bound_by_principal_id:bus.localOperatorPrincipalId});
    bus.capabilityGrantStore.issueGrant({principal_id:bus.localOperatorPrincipalId,boundary:{kind:"workspace",workspace_id:workspace},operation_ids:["approval.decide"],expires_at:"2099-01-01T00:00:00.000Z",issuer_id:"test:owner",evidence:[{kind:"test",ref:"export-review"}]});
    const recipient = `actor:${workspace}:exporter`;
    bus.registerEndpoint({endpoint_id:recipient,workspace_id:workspace,name:"Exporter",bridge_id:null,status:"idle"},()=>{});
    const context = bus.contextStore.createContext({workspace_id:workspace,created_by_endpoint_id:null,participants:[recipient]});
    const cause = bus.appendContextEvent({workspace_id:workspace,context_id:context,type:"message",content:{text:"Prepare the exact local export"},metadata:{}},()=>{});
    const provenance = {cause_event_id:cause.event_id,delivery_ids:[],execution_attempt_id:null,node_execution_id:null,scope_execution_id:null};
    const pending = receipt(await bus.operationRegistry.invoke({...environment("unattended"),provenance},request()));
    expect(pending.state).toBe("awaiting_approval"); expect(existsSync(join(root,"published"))).toBe(false);
    const approval = bus.approvalStore.requireRequest(pending.governance.approval_request_ids[0]!);
    expect(approval.action.artefact_version_ids).toEqual([version]);
    expect(approval.action.target?.id).toBe(version);
    expect(approval.action.expected_effect.external).toBe(false);
    expect(approval.action.expected_effect.summary).toContain('"published/gallery.html"');
    expect(approval.action.expected_effect.summary).toContain(version);
    const configured = bus.configureApprovalResponse({workspace_id:workspace,approval_request_id:approval.approval_request_id,
      expected_state_revision:approval.state_revision,response_participant_id:recipient});
    expect(configured.action_digest).toBe(approval.action_digest);
    const decided = bus.decideApprovalRequest({workspace_id:workspace,approval_request_id:approval.approval_request_id,expected_state_revision:configured.state_revision,decision:"approved",decided_by_principal_id:bus.localOperatorPrincipalId,decision_reason:"Exact local export reviewed",operation_invocation_id:"test:decision"});
    const decisionEvent = bus.getEvent(decided.request.decision_event_id!)!;
    expect(decisionEvent.content.awaiting_operation).toMatchObject({invocation_id:pending.invocation_id,operation_id:operationId,idempotency_key:request().idempotency_key});
    expect(decisionEvent.content.awaiting_operation).not.toHaveProperty("input");
    expect(existsSync(join(root,"published/gallery.html"))).toBe(false);
    expect(bus.db.prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?").all(decisionEvent.event_id)).toEqual([{destination_endpoint_id:recipient}]);
    const changed = receipt(await bus.operationRegistry.invoke(environment(),request("elsewhere.html","changed-destination")));
    expect(changed.state).toBe("awaiting_approval"); expect(existsSync(join(root,"elsewhere.html"))).toBe(false);
    const changedApproval = bus.approvalStore.requireRequest(changed.governance.approval_request_ids[0]!);
    expect(changedApproval.action.input_digest).not.toBe(approval.action.input_digest);
    bus.decideApprovalRequest({workspace_id:workspace,approval_request_id:changedApproval.approval_request_id,expected_state_revision:changedApproval.state_revision,decision:"changes_requested",decided_by_principal_id:bus.localOperatorPrincipalId,decision_reason:"Keep the reviewed destination",operation_invocation_id:"test:changes"});
    expect(receipt(await bus.operationRegistry.invoke(environment(),request("elsewhere.html","changed-destination"))).state).toBe("refused");
    expect(existsSync(join(root,"elsewhere.html"))).toBe(false);
    const original = bus.artefactStore.getVersion(version)!;
    const next = bus.artefactStore.publishVersion({artefact_id:original.artefact_id,idempotency_key:"site-v2",content_ref:original.content_ref});
    const changedVersion = receipt(await bus.operationRegistry.invoke(environment(),{...request("version-two.html","changed-version"),target:{kind:"artefact_version",id:next.artefact_version_id}}));
    expect(changedVersion.state).toBe("awaiting_approval"); expect(existsSync(join(root,"version-two.html"))).toBe(false);
    const completed = receipt(await bus.operationRegistry.invoke({...environment("unattended"),provenance:{...provenance,cause_event_id:decisionEvent.event_id}},request()));
    expect(completed.state,JSON.stringify(completed.refusal)).toBe("completed"); expect(readFileSync(join(root,"published/gallery.html"))).toEqual(bytes);
    expect(receipt(await bus.operationRegistry.invoke(environment(),request()))).toEqual(completed);
    expect(bus.approvalStore.requireReceipt(completed.governance.approval_receipt_ids[0]!).use_count).toBe(1);
  });
});
