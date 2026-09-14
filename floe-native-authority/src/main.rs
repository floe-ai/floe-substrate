//! One-shot native semantic-operation broker for non-desktop clients.
//!
//! One bounded JSON command enters through stdin and one safe JSON result exits
//! through stdout. The reusable host credential and Workspace bearer never
//! leave `NativeAuthorityBroker`.

use floe_native_authority::{
    ConfirmHostOperationRequest, ConfirmWorkspaceOperationRequest, DiscoverOperationsRequest,
    InvokeOperationRequest, NativeAuthorityBroker, RegisterWorkspaceRequest,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};

const MAX_COMMAND_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
enum AuthorityCommand {
    ListLocalWorkspaces,
    ListProviderAccounts,
    ProvideHostControlToken,
    RegisterWorkspace(RegisterWorkspaceRequest),
    ConnectProviderAccount { provider_id: String },
    DiscoverOperations(DiscoverOperationsRequest),
    InvokeOperation(InvokeOperationRequest),
    ConfirmAndInvokeHostOperation(ConfirmHostOperationRequest),
    ConfirmAndInvokeWorkspaceOperation(ConfirmWorkspaceOperationRequest),
}

#[tokio::main]
async fn main() {
    let output = run().await.unwrap_or_else(|message| {
        json!({
            "ok": false,
            "error": {
                "code": "native_authority_broker_refused",
                "message": message,
            },
        })
    });
    let mut stdout = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, &output);
    let _ = stdout.write_all(b"\n");
}

async fn run() -> Result<Value, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_COMMAND_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Floe could not read the native authority request.".to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_COMMAND_BYTES {
        return Err("The native authority request is invalid.".into());
    }
    let command = parse_command(&bytes)?;
    bytes.fill(0);

    let broker = NativeAuthorityBroker::from_os_vault();
    let result = match command {
        AuthorityCommand::ListLocalWorkspaces => broker.list_local_workspaces().await,
        AuthorityCommand::ProvideHostControlToken => broker
            .host_control_token_for_local_boot()
            .map(|token| json!({ "token": token })),
        AuthorityCommand::RegisterWorkspace(input) => broker.register_workspace(input).await,
        AuthorityCommand::ListProviderAccounts => {
            broker.list_provider_accounts().await.and_then(|accounts| {
                serde_json::to_value(accounts)
                    .map_err(|_| "Floe could not encode the provider account list.".to_string())
            })
        }
        AuthorityCommand::ConnectProviderAccount { provider_id } => broker
            .connect_provider_account(&provider_id)
            .await
            .and_then(|account| {
                serde_json::to_value(account)
                    .map_err(|_| "Floe could not encode the provider account status.".to_string())
            }),
        AuthorityCommand::DiscoverOperations(input) => broker.discover_operations(input).await,
        AuthorityCommand::InvokeOperation(input) => broker.invoke_operation(input).await,
        AuthorityCommand::ConfirmAndInvokeHostOperation(input) => {
            broker.confirm_and_invoke_host_operation(input).await
        }
        AuthorityCommand::ConfirmAndInvokeWorkspaceOperation(input) => {
            broker.confirm_and_invoke_workspace_operation(input).await
        }
    }?;
    Ok(json!({ "ok": true, "result": result }))
}

fn parse_command(bytes: &[u8]) -> Result<AuthorityCommand, String> {
    let value = serde_json::from_slice::<Value>(bytes)
        .map_err(|_| "The native authority request is invalid.".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "The native authority request is invalid.".to_string())?;
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "The native authority request is invalid.".to_string())?;
    let allowed: &[&str] = match command {
        "list_local_workspaces" => &["command"],
        "list_provider_accounts" => &["command"],
        "provide_host_control_token" => &["command"],
        "register_workspace" => &["command", "locator", "init_authorized"],
        "connect_provider_account" => &["command", "provider_id"],
        "discover_operations" => &["command", "boundary", "query", "category", "target"],
        "invoke_operation" => &["command", "boundary", "invocation"],
        "confirm_and_invoke_host_operation" => &["command", "interaction_session_id", "invocation"],
        "confirm_and_invoke_workspace_operation" => &[
            "command",
            "workspace_id",
            "interaction_session_id",
            "invocation",
        ],
        _ => return Err("The native authority request is invalid.".into()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("The native authority request is invalid.".into());
    }
    serde_json::from_value::<AuthorityCommand>(value)
        .map_err(|_| "The native authority request is invalid.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_typed_commands_and_refuses_raw_transport_or_credentials() {
        assert!(parse_command(br#"{"command":"list_local_workspaces"}"#).is_ok());
        assert!(parse_command(br#"{"command":"list_provider_accounts"}"#).is_ok());
        assert!(parse_command(br#"{"command":"provide_host_control_token"}"#).is_ok());
        assert!(parse_command(
            br#"{"command":"register_workspace","locator":"C:/work/demo","init_authorized":true}"#
        )
        .is_ok());
        assert!(parse_command(
            br#"{"command":"provide_host_control_token","bearer_token":"x"}"#
        )
        .is_err());
        assert!(parse_command(
            br#"{"command":"connect_provider_account","provider_id":"openai-codex"}"#
        )
        .is_ok());
        assert!(parse_command(br#"{"command":"connect_provider_account","provider_id":"openai-codex","url":"http://example.invalid"}"#).is_err());
        assert!(parse_command(
            br#"{"command":"discover_operations","boundary":{"kind":"host"},"query":"credential"}"#
        )
        .is_ok());
        assert!(parse_command(br#"{"command":"confirm_and_invoke_host_operation","interaction_session_id":"cli:one","invocation":{"operation_id":"credential.revoke","operation_version":"1","input_schema_version":"1","target":{"kind":"secret_ref","id":"ref:one"},"expected_resource_revision":"generation:1:resolved","idempotency_key":"revoke:one","input":{}}}"#).is_ok());
        assert!(parse_command(
            br#"{"command":"list_local_workspaces","url":"http://example.invalid"}"#
        )
        .is_err());
        assert!(parse_command(
            br#"{"command":"list_local_workspaces","bearer_token":"not-allowed"}"#
        )
        .is_err());
        assert!(parse_command(br#"{"command":"run_process","program":"cmd.exe"}"#).is_err());
    }
}
