//! Trusted desktop transport for the local Floe Bus.
//!
//! The webview supplies intent (a relative Bus path and an optional Workspace),
//! never bearer material. The host-control credential stays in the operating
//! system credential vault and short-lived Workspace sessions stay in memory.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use floe_native_authority::{
    ContextAttachmentIngress, NativeAuthorityBroker, ProviderAccountProjection,
    ProviderCredentialIngress,
};
use futures_util::{SinkExt, StreamExt};
use rand::{rngs::OsRng, RngCore};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio_tungstenite::tungstenite::{protocol::CloseFrame, Message};

const BUS_WS_URL: &str = "ws://127.0.0.1:5377/v1/events/stream";
const MAX_MEDIA_BYTES: usize = 25 * 1024 * 1024;

#[derive(Clone)]
pub struct DesktopBusBroker {
    inner: Arc<BrokerInner>,
}

struct BrokerInner {
    authority: NativeAuthorityBroker,
    streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusRequest {
    path: String,
    #[serde(default = "default_method")]
    method: String,
    body: Option<Value>,
    workspace_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusResponse {
    status: u16,
    content_type: Option<String>,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusMediaResponse {
    media_type: String,
    data_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusArtefactContentResponse {
    media_type: String,
    data_base64: String,
    etag: String,
    artefact_version_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedOperationResponse {
    confirmed: bool,
    response: Option<BusResponse>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRelayEvent {
    kind: &'static str,
    state: Option<&'static str>,
    message: Option<Value>,
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OperationDiscoveryResponse {
    operations: Vec<TrustedOperationDescriptor>,
}

#[derive(Debug, Deserialize)]
struct TrustedOperationDescriptor {
    operation_id: String,
    operation_version: String,
    interaction_constraints: TrustedInteractionConstraints,
    availability: TrustedOperationAvailability,
}

#[derive(Debug, Deserialize)]
struct TrustedInteractionConstraints {
    confirmation: Option<TrustedConfirmation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct TrustedConfirmation {
    required: bool,
    prompt_id: String,
    title: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct TrustedOperationAvailability {
    available: bool,
    refusal: Option<TrustedOperationRefusal>,
}

#[derive(Debug, Deserialize)]
struct TrustedOperationRefusal {
    message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InvocationIdentity {
    operation_id: String,
    operation_version: String,
    target_kind: Option<String>,
    target_id: Option<String>,
}

impl DesktopBusBroker {
    pub fn from_os_vault() -> Self {
        Self {
            inner: Arc::new(BrokerInner {
                authority: NativeAuthorityBroker::from_os_vault(),
                streams: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn launch_packaged_substrate(&self) -> Result<std::process::Child, String> {
        self.inner.authority.launch_packaged_substrate()
    }

    pub async fn provider_accounts(&self) -> Result<Vec<ProviderAccountProjection>, String> {
        self.inner.authority.list_provider_accounts().await
    }

    pub async fn begin_provider_account_connection(
        &self,
        provider_id: &str,
        label: &str,
    ) -> Result<ProviderCredentialIngress, String> {
        self.inner
            .authority
            .begin_provider_account_connection(provider_id, label)
            .await
    }

    pub async fn finish_provider_account_connection(
        &self,
        ingress: &ProviderCredentialIngress,
    ) -> Result<ProviderAccountProjection, String> {
        self.inner
            .authority
            .finish_provider_account_connection(ingress)
            .await
    }

    pub async fn cancel_provider_account_connection(&self, ingress: &ProviderCredentialIngress) {
        let _ = self
            .inner
            .authority
            .cancel_provider_account_connection(ingress)
            .await;
    }

    async fn request(&self, request: BusRequest) -> Result<BusResponse, String> {
        let path = validated_bus_path(&request.path)?;
        if path == "/health" {
            let response = self.inner.authority.health().await?;
            return Ok(BusResponse {
                status: response.status,
                content_type: response.content_type,
                body: response.body,
            });
        }
        if is_host_control_path(&path) {
            return Err("This Bus route is not available through a Workspace session.".into());
        }
        let method = validated_method(&request.method)?;
        let inferred_workspace = workspace_from_path(&path);
        if let (Some(expected), Some(actual)) = (
            request.workspace_id.as_deref(),
            inferred_workspace.as_deref(),
        ) {
            if expected != actual {
                return Err("The Bus request does not belong to the selected Workspace.".into());
            }
        }
        let workspace_id = request
            .workspace_id
            .or(inferred_workspace)
            .ok_or_else(|| "The app must name the Workspace for this Bus request.".to_string())?;

        let response = self
            .send_workspace_request(method.clone(), &path, request.body.clone(), &workspace_id)
            .await?;
        let response = if response.status() == StatusCode::UNAUTHORIZED {
            self.invalidate_workspace_session(&workspace_id).await;
            self.send_workspace_request(method, &path, request.body, &workspace_id)
                .await?
        } else {
            response
        };
        response_to_bus_response(response).await
    }

    async fn local_workspace_projection(&self) -> Result<BusResponse, String> {
        self.send_host_request(Method::GET, "/v1/local/workspaces", None)
            .await
    }

    async fn local_runtime_status(&self) -> Result<BusResponse, String> {
        let response = self.inner.authority.local_runtime_status().await?;
        Ok(BusResponse {
            status: response.status,
            content_type: response.content_type,
            body: response.body,
        })
    }

    async fn host_operation_discovery(
        &self,
        query: Option<String>,
        target_kind: Option<String>,
        target_id: Option<String>,
    ) -> Result<BusResponse, String> {
        let suffix = operation_discovery_suffix(query, target_kind, target_id)?;
        self.send_host_request(Method::GET, &format!("/v1/local/operations{suffix}"), None)
            .await
    }

    async fn host_operation_invocation(&self, request: Value) -> Result<BusResponse, String> {
        self.send_host_request(Method::POST, "/v1/local/operations/invoke", Some(request))
            .await
    }

    async fn confirmation_for_invocation(
        &self,
        workspace_id: &str,
        invocation: &Value,
    ) -> Result<TrustedConfirmation, String> {
        validate_identifier("Workspace", workspace_id)?;
        let identity = invocation_identity(invocation)?;
        let suffix = operation_discovery_suffix(
            Some(identity.operation_id.clone()),
            identity.target_kind.clone(),
            identity.target_id.clone(),
        )?;
        let path = format!(
            "/v1/workspaces/{}/operations{suffix}",
            urlencoding::encode(workspace_id),
        );
        let mut response = self
            .send_workspace_request(Method::GET, &path, None, workspace_id)
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.invalidate_workspace_session(workspace_id).await;
            response = self
                .send_workspace_request(Method::GET, &path, None, workspace_id)
                .await?;
        }
        if !response.status().is_success() {
            return Err(operator_http_error(response.status()));
        }
        let projection = response
            .json::<OperationDiscoveryResponse>()
            .await
            .map_err(|_| "Floe received an invalid operation description.".to_string())?;
        confirmation_from_projection(projection, &identity)
    }

    async fn confirmed_operation_invocation(
        &self,
        workspace_id: &str,
        invocation: Value,
    ) -> Result<BusResponse, String> {
        validate_identifier("Workspace", workspace_id)?;
        self.send_host_request(
            Method::POST,
            &format!(
                "/v1/local/workspaces/{}/operations/confirm-and-invoke",
                urlencoding::encode(workspace_id),
            ),
            Some(json!({
                "interaction_session_id": self.inner.authority.interaction_session_id(),
                "invocation": invocation,
            })),
        )
        .await
    }

    async fn confirmation_for_host_invocation(
        &self,
        invocation: &Value,
    ) -> Result<TrustedConfirmation, String> {
        let identity = invocation_identity(invocation)?;
        let suffix = operation_discovery_suffix(
            Some(identity.operation_id.clone()),
            identity.target_kind.clone(),
            identity.target_id.clone(),
        )?;
        let response = self
            .send_host_request(Method::GET, &format!("/v1/local/operations{suffix}"), None)
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(operator_status_error(response.status));
        }
        let projection = serde_json::from_str::<OperationDiscoveryResponse>(&response.body)
            .map_err(|_| "Floe received an invalid operation description.".to_string())?;
        confirmation_from_projection(projection, &identity)
    }

    async fn confirmed_host_operation_invocation(
        &self,
        invocation: Value,
    ) -> Result<BusResponse, String> {
        self.send_host_request(
            Method::POST,
            "/v1/local/operations/confirm-and-invoke",
            Some(json!({
                "interaction_session_id": self.inner.authority.interaction_session_id(),
                "invocation": invocation,
            })),
        )
        .await
    }

    async fn send_host_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<BusResponse, String> {
        let response = self
            .inner
            .authority
            .send_host_request(method, path, body)
            .await?;
        Ok(BusResponse {
            status: response.status,
            content_type: response.content_type,
            body: response.body,
        })
    }

    async fn media(&self, workspace_id: &str, path: &str) -> Result<BusMediaResponse, String> {
        validate_identifier("Workspace", workspace_id)?;
        if path.trim().is_empty() || path.contains('\0') {
            return Err("The media path is invalid.".into());
        }
        let route = format!(
            "/v1/workspaces/{}/fs/media?path={}",
            urlencoding::encode(workspace_id),
            urlencoding::encode(path),
        );
        let mut response = self
            .send_workspace_request(Method::GET, &route, None, workspace_id)
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.invalidate_workspace_session(workspace_id).await;
            response = self
                .send_workspace_request(Method::GET, &route, None, workspace_id)
                .await?;
        }
        if !response.status().is_success() {
            return Err(operator_http_error(response.status()));
        }
        let media_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .to_string();
        if !media_type.starts_with("image/") {
            return Err("The selected file is not a supported image preview.".into());
        }
        let bytes = response.bytes().await.map_err(|_| unavailable_message())?;
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err("The image is too large to preview safely.".into());
        }
        Ok(BusMediaResponse {
            media_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    async fn artefact_version_content(
        &self,
        workspace_id: &str,
        artefact_version_id: &str,
    ) -> Result<BusArtefactContentResponse, String> {
        validate_identifier("Workspace", workspace_id)?;
        validate_identifier("ArtefactVersion", artefact_version_id)?;
        let route = format!(
            "/v1/workspaces/{}/artefact-versions/{}/content",
            urlencoding::encode(workspace_id),
            urlencoding::encode(artefact_version_id),
        );
        let mut response = self
            .send_workspace_request(Method::GET, &route, None, workspace_id)
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.invalidate_workspace_session(workspace_id).await;
            response = self
                .send_workspace_request(Method::GET, &route, None, workspace_id)
                .await?;
        }
        if !response.status().is_success() {
            let status = response.status();
            let message = response.json::<Value>().await.ok().and_then(|value| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            return Err(message.unwrap_or_else(|| operator_http_error(status)));
        }
        let media_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .to_string();
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let returned_version_id = response
            .headers()
            .get("x-floe-artefact-version-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if returned_version_id != artefact_version_id
            || !etag.starts_with("\"sha256:")
            || !etag.ends_with('"')
        {
            return Err("Floe returned content without exact ArtefactVersion evidence.".into());
        }
        let bytes = response.bytes().await.map_err(|_| unavailable_message())?;
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err("The exact ArtefactVersion is too large to preview safely.".into());
        }
        Ok(BusArtefactContentResponse {
            media_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            etag,
            artefact_version_id: returned_version_id,
        })
    }

    async fn send_workspace_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        workspace_id: &str,
    ) -> Result<reqwest::Response, String> {
        self.inner
            .authority
            .send_workspace_request(method, path, body, workspace_id)
            .await
    }

    async fn workspace_session(&self, workspace_id: &str) -> Result<String, String> {
        self.inner
            .authority
            .workspace_session_bearer(workspace_id)
            .await
    }

    async fn invalidate_workspace_session(&self, workspace_id: &str) {
        self.inner
            .authority
            .invalidate_workspace_session(workspace_id)
            .await;
    }

    fn open_workspace_stream(
        &self,
        workspace_id: String,
        on_event: Channel<StreamRelayEvent>,
        start_at_current: bool,
    ) -> Result<String, String> {
        validate_identifier("Workspace", &workspace_id)?;
        let stream_id = format!("stream_{}", random_secret(18));
        let cancelled = Arc::new(AtomicBool::new(false));
        self.inner
            .streams
            .lock()
            .map_err(|_| "Floe could not open live updates.".to_string())?
            .insert(stream_id.clone(), cancelled.clone());

        let broker = self.clone();
        let task_stream_id = stream_id.clone();
        tauri::async_runtime::spawn(async move {
            broker
                .run_workspace_stream(workspace_id, on_event, cancelled, start_at_current)
                .await;
            if let Ok(mut streams) = broker.inner.streams.lock() {
                streams.remove(&task_stream_id);
            }
        });
        Ok(stream_id)
    }

    fn close_workspace_stream(&self, stream_id: &str) {
        if let Ok(mut streams) = self.inner.streams.lock() {
            if let Some(cancelled) = streams.remove(stream_id) {
                cancelled.store(true, Ordering::Release);
            }
        }
    }

    async fn run_workspace_stream(
        &self,
        workspace_id: String,
        on_event: Channel<StreamRelayEvent>,
        cancelled: Arc<AtomicBool>,
        start_at_current: bool,
    ) {
        let mut backoff = Duration::from_millis(250);
        // Each consumer owns its checkpoint. Another view cannot advance it.
        let mut cursor: Option<String> = None;
        let mut fresh_connection = true;
        while !cancelled.load(Ordering::Acquire) {
            if on_event
                .send(StreamRelayEvent::state("connecting", None))
                .is_err()
            {
                return;
            }
            let session = match self.workspace_session(&workspace_id).await {
                Ok(session) => session,
                Err(detail) => {
                    let _ = on_event.send(StreamRelayEvent::state("unavailable", Some(detail)));
                    return;
                }
            };
            let connection = tokio::time::timeout(
                Duration::from_secs(5),
                tokio_tungstenite::connect_async(BUS_WS_URL),
            )
            .await;
            let Ok(Ok((mut socket, _))) = connection else {
                let _ = on_event.send(StreamRelayEvent::state("closed", None));
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(16));
                continue;
            };
            let mut authenticate = json!({
                "type": "authenticate",
                "bearer_token": session,
                "workspace_id": workspace_id,
            });
            if start_at_current && fresh_connection {
                authenticate["start_at"] = json!("current");
            } else {
                authenticate["after_cursor"] = json!(cursor);
            }
            if socket
                .send(Message::Text(authenticate.to_string().into()))
                .await
                .is_err()
            {
                continue;
            }

            let mut authenticated = false;
            let mut authentication_denied = false;
            loop {
                if cancelled.load(Ordering::Acquire) {
                    let _ = socket.close(None).await;
                    return;
                }
                let next = tokio::time::timeout(Duration::from_secs(1), socket.next()).await;
                let Ok(Some(frame)) = next else {
                    if next.is_err() {
                        continue;
                    }
                    break;
                };
                match frame {
                    Ok(Message::Text(text)) => {
                        let Ok(message) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        let message_type = message.get("type").and_then(Value::as_str);
                        if !authenticated {
                            if message_type != Some("authenticated") {
                                break;
                            }
                            authenticated = true;
                            fresh_connection = false;
                            if let Some(accepted) = stream_cursor(&message) {
                                cursor = Some(accepted.to_string());
                            }
                            backoff = Duration::from_millis(250);
                            if on_event
                                .send(StreamRelayEvent::state("open", None))
                                .is_err()
                            {
                                return;
                            }
                            continue;
                        }
                        if let Some(accepted) = stream_cursor(&message) {
                            cursor = Some(accepted.to_string());
                        }
                        if message_type == Some("caught_up") {
                            continue;
                        }
                        if on_event.send(StreamRelayEvent::message(message)).is_err() {
                            return;
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        authentication_denied = is_authentication_close(frame.as_ref());
                        break;
                    }
                    Ok(Message::Ping(payload)) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            if authentication_denied {
                self.invalidate_workspace_session(&workspace_id).await;
            }
            let _ = on_event.send(StreamRelayEvent::state("closed", None));
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(16));
        }
    }
}

impl StreamRelayEvent {
    fn state(state: &'static str, detail: Option<String>) -> Self {
        Self {
            kind: "state",
            state: Some(state),
            message: None,
            detail,
        }
    }

    fn message(message: Value) -> Self {
        Self {
            kind: "message",
            state: None,
            message: Some(message),
            detail: None,
        }
    }
}

#[tauri::command]
pub async fn bus_request(
    broker: tauri::State<'_, DesktopBusBroker>,
    request: BusRequest,
) -> Result<BusResponse, String> {
    broker.request(request).await
}

#[tauri::command]
pub async fn list_local_workspace_bindings(
    broker: tauri::State<'_, DesktopBusBroker>,
) -> Result<BusResponse, String> {
    broker.local_workspace_projection().await
}

#[tauri::command]
pub async fn get_local_runtime_status(
    broker: tauri::State<'_, DesktopBusBroker>,
) -> Result<BusResponse, String> {
    broker.local_runtime_status().await
}

#[tauri::command]
pub async fn list_browser_connections(
    broker: tauri::State<'_, DesktopBusBroker>,
) -> Result<BusResponse, String> {
    broker.send_host_request(Method::GET, "/v1/local/browser-connections", None).await
}

/// GET /v1/auth/models is host-control (see is_host_control_path), so the
/// webview cannot reach it through the Workspace-authenticated bus_request
/// channel. This mirrors list_browser_connections above.
#[tauri::command]
pub async fn get_auth_models(
    broker: tauri::State<'_, DesktopBusBroker>,
    provider: Option<String>,
) -> Result<BusResponse, String> {
    let path = match provider {
        Some(provider) => format!("/v1/auth/models?provider={}", urlencoding::encode(&provider)),
        None => "/v1/auth/models".to_string(),
    };
    broker.send_host_request(Method::GET, &path, None).await
}

/// POST /v1/workspaces/:id/select is host-control (see is_host_control_path),
/// so the webview cannot reach it through the Workspace-authenticated
/// bus_request channel. This mirrors list_browser_connections above.
#[tauri::command]
pub async fn select_workspace(
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
) -> Result<BusResponse, String> {
    validate_identifier("Workspace", &workspace_id)?;
    broker
        .send_host_request(
            Method::POST,
            &format!("/v1/workspaces/{}/select", urlencoding::encode(&workspace_id)),
            Some(json!({})),
        )
        .await
}

/// POST /v1/workspaces/:id/delete is host-control (see is_host_control_path),
/// so the webview cannot reach it through the Workspace-authenticated
/// bus_request channel. This mirrors list_browser_connections above.
#[tauri::command]
pub async fn delete_workspace(
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
    delete_locator: Option<bool>,
) -> Result<BusResponse, String> {
    validate_identifier("Workspace", &workspace_id)?;
    broker
        .send_host_request(
            Method::POST,
            &format!("/v1/workspaces/{}/delete", urlencoding::encode(&workspace_id)),
            Some(json!({ "delete_locator": delete_locator.unwrap_or(false) })),
        )
        .await
}

#[tauri::command]
pub async fn approve_browser_connection(
    app: tauri::AppHandle,
    broker: tauri::State<'_, DesktopBusBroker>,
    code: String,
    workspace_id: String,
) -> Result<ConfirmedOperationResponse, String> {
    if code.len() != 8 || !code.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_lowercase()) {
        return Err("Invalid browser connection code".into());
    }
    // Confirmation text comes from authenticated host projections, not the webview.
    let pending = broker.send_host_request(Method::GET, "/v1/local/browser-connections", None).await?;
    let pending: Value = serde_json::from_str(&pending.body).map_err(|_| "Could not read browser connections")?;
    let connection = pending["connections"].as_array().and_then(|items| items.iter().find(|item| item["code"].as_str() == Some(&code)))
        .ok_or("This browser connection expired. Start again in the browser.")?;
    let workspaces = broker.local_workspace_projection().await?;
    let workspaces: Value = serde_json::from_str(&workspaces.body).map_err(|_| "Could not read workspaces")?;
    let workspace = workspaces["workspaces"].as_array().and_then(|items| items.iter().find(|item| item["workspace_id"].as_str() == Some(&workspace_id)))
        .ok_or("The selected workspace is unavailable")?;
    let description = format!("Allow browser {} at {} to work in {} for one hour?\n\nCheck that the code matches the browser you opened.",
        code, connection["origin"].as_str().unwrap_or("unknown origin"), workspace["name"].as_str().unwrap_or(&workspace_id));
    let confirmed = app.dialog().message(description).title("Connect a browser to Floe")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow access".into(), "Cancel".into()))
        .blocking_show();
    if !confirmed { return Ok(ConfirmedOperationResponse { confirmed: false, response: None }); }
    let response = broker.send_host_request(Method::POST, &format!("/v1/local/browser-connections/{code}/approve"), Some(json!({ "workspace_id": workspace_id }))).await?;
    Ok(ConfirmedOperationResponse { confirmed: true, response: Some(response) })
}

#[tauri::command]
pub async fn discover_host_operations(
    broker: tauri::State<'_, DesktopBusBroker>,
    query: Option<String>,
    target_kind: Option<String>,
    target_id: Option<String>,
) -> Result<BusResponse, String> {
    broker
        .host_operation_discovery(query, target_kind, target_id)
        .await
}

#[tauri::command]
pub async fn invoke_host_operation(
    broker: tauri::State<'_, DesktopBusBroker>,
    request: Value,
) -> Result<BusResponse, String> {
    broker.host_operation_invocation(request).await
}

#[tauri::command]
pub async fn confirm_and_invoke_operation(
    app: tauri::AppHandle,
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
    request: Value,
) -> Result<ConfirmedOperationResponse, String> {
    let confirmation = broker
        .confirmation_for_invocation(&workspace_id, &request)
        .await?;
    let confirmed = app
        .dialog()
        .message(confirmation.description)
        .title(confirmation.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Confirm".into(),
            "Cancel".into(),
        ))
        .blocking_show();
    if !confirmed {
        return Ok(ConfirmedOperationResponse {
            confirmed: false,
            response: None,
        });
    }
    let response = broker
        .confirmed_operation_invocation(&workspace_id, request)
        .await?;
    Ok(ConfirmedOperationResponse {
        confirmed: true,
        response: Some(response),
    })
}

#[tauri::command]
pub async fn confirm_and_invoke_host_operation(
    app: tauri::AppHandle,
    broker: tauri::State<'_, DesktopBusBroker>,
    request: Value,
) -> Result<ConfirmedOperationResponse, String> {
    let confirmation = broker.confirmation_for_host_invocation(&request).await?;
    let confirmed = app
        .dialog()
        .message(confirmation.description)
        .title(confirmation.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Confirm".into(),
            "Cancel".into(),
        ))
        .blocking_show();
    if !confirmed {
        return Ok(ConfirmedOperationResponse {
            confirmed: false,
            response: None,
        });
    }
    let response = broker.confirmed_host_operation_invocation(request).await?;
    Ok(ConfirmedOperationResponse {
        confirmed: true,
        response: Some(response),
    })
}

#[tauri::command]
pub async fn read_bus_media(
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
    rel_path: String,
) -> Result<BusMediaResponse, String> {
    broker.media(&workspace_id, &rel_path).await
}

#[tauri::command]
pub async fn read_artefact_version_content(
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
    artefact_version_id: String,
) -> Result<BusArtefactContentResponse, String> {
    broker
        .artefact_version_content(&workspace_id, &artefact_version_id)
        .await
}

#[tauri::command]
pub async fn upload_context_attachment(
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
    context_id: String,
    file_name: String,
    media_type: String,
    bytes: Vec<u8>,
) -> Result<ContextAttachmentIngress, String> {
    broker
        .inner
        .authority
        .upload_context_attachment(&workspace_id, &context_id, &file_name, &media_type, bytes)
        .await
}

#[tauri::command]
pub fn open_workspace_stream(
    broker: tauri::State<'_, DesktopBusBroker>,
    workspace_id: String,
    on_event: Channel<StreamRelayEvent>,
    start_at_current: Option<bool>,
) -> Result<String, String> {
    broker.open_workspace_stream(workspace_id, on_event, start_at_current.unwrap_or(false))
}

#[tauri::command]
pub fn close_workspace_stream(broker: tauri::State<'_, DesktopBusBroker>, stream_id: String) {
    broker.close_workspace_stream(&stream_id);
}

fn random_secret(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

fn validated_bus_path(path: &str) -> Result<String, String> {
    let path_only = path.split('?').next().unwrap_or(path);
    let decoded = urlencoding::decode(path_only)
        .map_err(|_| "The app attempted an invalid local Bus request.".to_string())?;
    let has_dot_segment = decoded
        .split('/')
        .any(|segment| segment == "." || segment == "..");
    if !path.starts_with('/')
        || !(path == "/health" || path.starts_with("/v1/"))
        || path.starts_with("//")
        || path.contains("\\")
        || path.contains('#')
        || decoded.contains('\\')
        || has_dot_segment
        || path.chars().any(|character| character.is_control())
    {
        return Err("The app attempted an invalid local Bus request.".into());
    }
    Ok(path.to_string())
}

fn validated_method(method: &str) -> Result<Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err("The app attempted an unsupported local Bus request.".into()),
    }
}

fn workspace_from_path(path: &str) -> Option<String> {
    let path_only = path.split('?').next()?;
    let rest = path_only.strip_prefix("/v1/workspaces/")?;
    let segment = rest.split('/').next()?;
    if segment.is_empty() || segment == "register" {
        return None;
    }
    urlencoding::decode(segment)
        .ok()
        .map(|value| value.into_owned())
}

fn invocation_identity(value: &Value) -> Result<InvocationIdentity, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "The selected action is invalid. Refresh and try again.".to_string())?;
    let required_string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| "The selected action is invalid. Refresh and try again.".to_string())
    };
    let (target_kind, target_id) = match object.get("target") {
        None | Some(Value::Null) => (None, None),
        Some(Value::Object(target)) => {
            let kind = target
                .get("kind")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty());
            let id = target
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty());
            match (kind, id) {
                (Some(kind), Some(id)) => (Some(kind.to_string()), Some(id.to_string())),
                _ => {
                    return Err(
                        "The selected action target is invalid. Refresh and try again.".into(),
                    )
                }
            }
        }
        Some(_) => {
            return Err("The selected action target is invalid. Refresh and try again.".into())
        }
    };
    Ok(InvocationIdentity {
        operation_id: required_string("operation_id")?,
        operation_version: required_string("operation_version")?,
        target_kind,
        target_id,
    })
}

fn operation_discovery_suffix(
    query: Option<String>,
    target_kind: Option<String>,
    target_id: Option<String>,
) -> Result<String, String> {
    if target_kind.is_some() != target_id.is_some() {
        return Err("The selected action target is invalid. Refresh and try again.".into());
    }
    let mut params = Vec::new();
    if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
        params.push(format!("query={}", urlencoding::encode(&query)));
    }
    if let (Some(kind), Some(id)) = (target_kind, target_id) {
        validate_identifier("operation target kind", &kind)?;
        validate_identifier("operation target", &id)?;
        params.push(format!("target_kind={}", urlencoding::encode(&kind)));
        params.push(format!("target_id={}", urlencoding::encode(&id)));
    }
    Ok(if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    })
}

fn confirmation_from_projection(
    projection: OperationDiscoveryResponse,
    identity: &InvocationIdentity,
) -> Result<TrustedConfirmation, String> {
    let descriptor = projection
        .operations
        .into_iter()
        .find(|descriptor| {
            descriptor.operation_id == identity.operation_id
                && descriptor.operation_version == identity.operation_version
        })
        .ok_or_else(|| "This action is no longer available. Refresh and try again.".to_string())?;
    if !descriptor.availability.available {
        return Err(descriptor
            .availability
            .refusal
            .map(|refusal| refusal.message)
            .unwrap_or_else(|| "This action is not available for the selected item.".into()));
    }
    let confirmation = descriptor
        .interaction_constraints
        .confirmation
        .filter(|confirmation| confirmation.required)
        .ok_or_else(|| "This action does not require trusted operator confirmation.".to_string())?;
    if confirmation.prompt_id.trim().is_empty()
        || confirmation.title.trim().is_empty()
        || confirmation.description.trim().is_empty()
    {
        return Err("Floe received an invalid confirmation description.".into());
    }
    Ok(confirmation)
}

fn is_host_control_path(path: &str) -> bool {
    // "/v1/runtime/bindings*" is deliberately excluded here: an "agent" or
    // "workspace_default" binding always names a Workspace and is Workspace
    // data (see floe-bus/src/server.ts::resolveTransportRequirement), so it
    // must reach the Bus through the normal Workspace-authenticated request
    // below, not be refused before it gets there.
    if path.starts_with("/v1/local/")
        || path == "/v1/workspaces/register"
        || path.starts_with("/v1/auth/")
        || path == "/v1/local-config/status"
    {
        return true;
    }
    let Some(rest) = path
        .split('?')
        .next()
        .and_then(|value| value.strip_prefix("/v1/workspaces/"))
    else {
        return false;
    };
    let mut segments = rest.split('/');
    let _workspace = segments.next();
    matches!(
        segments.next(),
        Some("select" | "delete" | "config-snapshot" | "apply-config")
    )
}

fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 512
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("The {label} reference is invalid."));
    }
    Ok(())
}

async fn response_to_bus_response(response: reqwest::Response) -> Result<BusResponse, String> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.map_err(|_| unavailable_message())?;
    Ok(BusResponse {
        status,
        content_type,
        body,
    })
}

fn stream_cursor(message: &Value) -> Option<&str> {
    message
        .get("cursor")
        .and_then(Value::as_str)
        .or_else(|| message.get("payload")?.get("cursor")?.as_str())
}

fn is_authentication_close(frame: Option<&CloseFrame>) -> bool {
    frame
        .map(|frame| u16::from(frame.code) == 4401)
        .unwrap_or(false)
}

fn default_method() -> String {
    "GET".into()
}

fn operator_http_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => recovery_required_message(),
        StatusCode::NOT_FOUND => "The requested Floe resource is no longer available.".into(),
        _ => format!("Floe's local service returned status {}.", status.as_u16()),
    }
}

fn operator_status_error(status: u16) -> String {
    match status {
        401 | 403 => recovery_required_message(),
        404 => "The requested Floe resource is no longer available.".into(),
        value => format!("Floe's local service returned status {value}."),
    }
}

fn unavailable_message() -> String {
    "Floe's local service is unavailable. Close and reopen Floe, then try again.".into()
}

fn recovery_required_message() -> String {
    "Floe cannot verify this installation with the local substrate. Credential recovery is required.".into()
}

#[cfg(test)]
mod tests {
    #[test]
    fn retains_the_accepted_position_even_without_a_live_update() {
        assert_eq!(super::stream_cursor(&serde_json::json!({"type":"authenticated","payload":{"cursor":"accepted"}})), Some("accepted"));
        assert_eq!(super::stream_cursor(&serde_json::json!({"type":"caught_up","payload":{"cursor":"caught-up"}})), Some("caught-up"));
        assert_eq!(super::stream_cursor(&serde_json::json!({"type":"event_submitted","cursor":"live"})), Some("live"));
        assert_eq!(super::stream_cursor(&serde_json::json!({"payload":{"cursor":null}})), None);
    }
    use serde_json::json;

    use super::{
        confirmation_from_projection, invocation_identity, is_host_control_path,
        operation_discovery_suffix, validated_bus_path, validated_method, workspace_from_path,
        OperationDiscoveryResponse,
    };

    /// Live desktop relay acceptance, including the native Channel used by the
    /// webview. Read-only: no Events, conversations or model turns are created.
    #[tokio::test]
    #[ignore = "Requires the installed Floe service and the operator's local account"]
    async fn installed_workspace_streams_stay_connected() {
        let broker = super::DesktopBusBroker::from_os_vault();
        let projection = broker.local_workspace_projection().await.unwrap();
        assert_eq!(projection.status, 200);
        let projection: serde_json::Value = serde_json::from_str(&projection.body).unwrap();
        let workspaces = projection["workspaces"].as_array().unwrap();
        assert!(!workspaces.is_empty());
        for workspace in workspaces {
            let workspace = workspace["workspace_id"].as_str().unwrap().to_string();
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let channel = tauri::ipc::Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                    let event: serde_json::Value = serde_json::from_str(&body).unwrap();
                    if event["kind"] == "state" { let _ = sender.send(event); }
                }
                Ok(())
            });
            let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let task = {
                let broker = broker.clone();
                let cancelled = cancelled.clone();
                let workspace = workspace.clone();
                tokio::spawn(async move { broker.run_workspace_stream(workspace, channel, cancelled, true).await; })
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(8), async {
                while let Some(state) = receiver.recv().await {
                    println!("Desktop live connection {workspace}: {state}");
                    if state["state"] == "open" { return true; }
                    if state["state"] == "unavailable" { return false; }
                }
                false
            }).await;
            let stable = if matches!(result, Ok(true)) {
                tokio::time::timeout(std::time::Duration::from_secs(3), receiver.recv()).await.is_err()
            } else { false };
            cancelled.store(true, std::sync::atomic::Ordering::Release);
            task.abort();
            assert!(matches!(result, Ok(true)), "Desktop live updates did not authenticate in {workspace}");
            assert!(stable, "Desktop live updates disconnected in {workspace}");
        }
        println!("Desktop live updates authenticated and stayed connected in {} Workspaces.", workspaces.len());
    }

    #[tokio::test]
    #[ignore = "Requires the installed Floe service and the operator's local account"]
    async fn installed_runtime_health_is_available() {
        let broker = super::DesktopBusBroker::from_os_vault();
        let projection = broker.local_workspace_projection().await.unwrap();
        let projection: serde_json::Value = serde_json::from_str(&projection.body).unwrap();
        let workspace = projection["workspaces"][0]["workspace_id"].as_str().unwrap();
        let refused = broker.request(super::BusRequest {
            path: "/v1/runtime/status".into(), method: "GET".into(), body: None,
            workspace_id: Some(workspace.into()),
        }).await;
        assert!(refused.is_err(), "A Workspace request must not acquire host authority");
        assert!(broker.send_host_request(reqwest::Method::GET, "/v1/runtime/status", None).await.is_err(),
            "Generic host transport must remain confined to semantic routes");
        let health = broker.local_runtime_status().await.expect("Desktop runtime health request failed");
        assert_eq!(health.status, 200);
        let health: serde_json::Value = serde_json::from_str(&health.body).unwrap();
        assert_eq!(health["bridge"]["online"], true, "Installed model runtime is offline");
        println!("Desktop health is available: local service and model runtime are connected.");
    }

    /// Explicit local acceptance check: uses the same desktop request path as
    /// the webview and prints counts only, never messages or credentials.
    #[tokio::test]
    #[ignore = "Requires the installed Floe service and the operator's local account"]
    async fn installed_conversation_reads_cross_the_desktop_broker() {
        let broker = super::DesktopBusBroker::from_os_vault();
        async fn read(broker: &super::DesktopBusBroker, workspace: &str, path: String) -> serde_json::Value {
            let response = broker.request(super::BusRequest {
                path, method: "GET".into(), body: None, workspace_id: Some(workspace.into()),
            }).await.expect("Desktop conversation request failed");
            assert_eq!(response.status, 200, "Desktop conversation read failed in {workspace}");
            serde_json::from_str(&response.body).expect("Invalid conversation projection")
        }
        let projection = broker.local_workspace_projection().await.expect("Local Workspace list failed");
        assert_eq!(projection.status, 200);
        let projection: serde_json::Value = serde_json::from_str(&projection.body).unwrap();
        let workspaces = projection["workspaces"].as_array().expect("Missing Workspace list");
        let mut checked = 0;
        let mut retained_contexts = Vec::new();
        for workspace in workspaces {
            let workspace = workspace["workspace_id"].as_str().unwrap();
            let encoded = urlencoding::encode(workspace);
            let page = read(&broker, workspace, format!("/v1/workspaces/{encoded}/contexts?limit=1")).await;
            let Some(context) = page["contexts"].as_array().unwrap().first() else { continue };
            let context_id = context["context_id"].as_str().unwrap();
            let participant = context["participants"].as_array().and_then(|items| items.first()).and_then(|item| item.as_str());
            if let Some(participant) = participant {
                let page = read(&broker, workspace, format!("/v1/contexts?workspace_id={encoded}&participant={}&limit=20", urlencoding::encode(participant))).await;
                assert!(page["contexts"].is_array());
            }
            let detail = read(&broker, workspace, format!("/v1/contexts/{}", urlencoding::encode(context_id))).await;
            assert_eq!(detail["workspace_id"], workspace);
            let history = read(&broker, workspace, format!("/v1/events?workspace_id={encoded}&context_id={}&direction=backward&limit=50", urlencoding::encode(context_id))).await;
            assert!(history["events"].is_array());
            let deliveries = read(&broker, workspace, format!("/v1/delivery?workspace_id={encoded}&context_id={}&limit=500", urlencoding::encode(context_id))).await;
            assert!(deliveries["deliveries"].is_array());
            let telemetry = read(&broker, workspace, format!("/v1/runtime/telemetry?workspace_id={encoded}&limit=1")).await;
            assert!(telemetry["records"].is_array());
            retained_contexts.push((workspace.to_string(), context_id.to_string()));
            checked += 1;
            println!("Conversation reads passed: {workspace}");
        }
        assert!(checked >= 2, "This check requires existing conversations in two Workspaces");
        let response = broker.request(super::BusRequest {
            path: format!("/v1/contexts/{}", urlencoding::encode(&retained_contexts[1].1)),
            method: "GET".into(), body: None, workspace_id: Some(retained_contexts[0].0.clone()),
        }).await.expect("Cross-Workspace check did not reach the Bus");
        assert_eq!(response.status, 401, "The session cannot authenticate as a different Workspace");
        let response = broker.request(super::BusRequest {
            path: format!("/v1/contexts/{}?workspace_id={}", urlencoding::encode(&retained_contexts[1].1), urlencoding::encode(&retained_contexts[0].0)),
            method: "GET".into(), body: None, workspace_id: Some(retained_contexts[0].0.clone()),
        }).await.expect("Conflicting Workspace evidence did not reach the Bus");
        assert_eq!(response.status, 403, "Conflicting Workspace and Context evidence must remain refused");
        println!("Checked {checked} Workspaces with retained conversations; cross-Workspace access refused.");
    }

    #[test]
    fn confines_requests_to_relative_bus_routes() {
        assert!(validated_bus_path("/v1/workspaces/workspace%3Aone/scopes").is_ok());
        assert!(validated_bus_path("/health").is_ok());
        assert!(validated_bus_path("http://malicious.example/v1/workspaces").is_err());
        assert!(validated_bus_path("//malicious.example/v1/workspaces").is_err());
        assert!(validated_bus_path("/v1/../secrets\\file").is_err());
        assert!(validated_bus_path("/v1/%2e%2e/secrets").is_err());
        assert!(validated_bus_path("/v1/workspaces/%2e/scopes").is_err());
        assert!(validated_bus_path("/v1/workspaces/%2E%2E/scopes").is_err());
        assert!(validated_bus_path("/v1/workspaces#fragment").is_err());
    }

    #[test]
    fn only_allows_the_bus_methods_used_by_the_client() {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            assert!(validated_method(method).is_ok());
        }
        assert!(validated_method("CONNECT").is_err());
    }

    #[test]
    fn infers_workspace_identity_without_confusing_registration() {
        assert_eq!(
            workspace_from_path("/v1/workspaces/workspace%3Aone/scopes?limit=1").as_deref(),
            Some("workspace:one"),
        );
        assert_eq!(workspace_from_path("/v1/workspaces/register"), None);
        assert_eq!(workspace_from_path("/v1/contexts/context-one"), None);
    }

    #[test]
    fn generic_workspace_transport_cannot_reach_host_control_routes() {
        assert!(is_host_control_path(
            "/v1/local/workspaces/workspace%3Aone/operation-sessions",
        ));
        assert!(is_host_control_path(
            "/v1/local/workspaces/workspace%3Aone/operations/confirm-and-invoke",
        ));
        assert!(is_host_control_path("/v1/workspaces/register"));
        assert!(is_host_control_path("/v1/auth/profiles"));
        assert!(is_host_control_path(
            "/v1/workspaces/workspace%3Aone/delete"
        ));
        assert!(!is_host_control_path(
            "/v1/workspaces/workspace%3Aone/operations",
        ));
    }

    #[test]
    fn confirmation_discovery_uses_only_operation_and_target_identity() {
        let identity = invocation_identity(&json!({
            "operation_id": "context.destroy_permanently",
            "operation_version": "1",
            "input_schema_version": "1",
            "target": { "kind": "context", "id": "context:one" },
            "expected_resource_revision": "2",
            "idempotency_key": "destruction:one",
            "input": { "reason": "Confirmed by the operator" },
            "confirmed_prompts": ["browser-content-is-not-authority"],
        }))
        .expect("identity should be read without trusting browser confirmation fields");
        assert_eq!(identity.operation_id, "context.destroy_permanently");
        assert_eq!(identity.operation_version, "1");
        assert_eq!(identity.target_kind.as_deref(), Some("context"));
        assert_eq!(identity.target_id.as_deref(), Some("context:one"));
    }

    #[test]
    fn rejects_an_incomplete_operation_or_target_before_showing_a_prompt() {
        assert!(invocation_identity(&json!({
            "operation_id": "context.destroy_permanently",
            "target": { "kind": "context" },
        }))
        .is_err());
        assert!(invocation_identity(&json!([])).is_err());
    }

    #[test]
    fn discovers_one_host_operation_for_one_exact_target() {
        assert_eq!(
            operation_discovery_suffix(
                Some("disconnect credential".into()),
                Some("secret_ref".into()),
                Some("secret ref:one".into()),
            )
            .unwrap(),
            "?query=disconnect%20credential&target_kind=secret_ref&target_id=secret%20ref%3Aone",
        );
        assert!(operation_discovery_suffix(None, Some("secret_ref".into()), None,).is_err());
    }

    #[test]
    fn trusts_the_bus_owned_confirmation_description() {
        let identity = invocation_identity(&json!({
            "operation_id": "credential.revoke",
            "operation_version": "1",
            "input_schema_version": "1",
            "target": { "kind": "secret_ref", "id": "secretref:one" },
            "expected_resource_revision": "generation:2:resolved",
            "idempotency_key": "disconnect:one",
            "input": {},
        }))
        .unwrap();
        let projection: OperationDiscoveryResponse = serde_json::from_value(json!({
            "operations": [{
                "operation_id": "credential.revoke",
                "operation_version": "1",
                "interaction_constraints": {
                    "confirmation": {
                        "required": true,
                        "prompt_id": "credential.revoke.confirm",
                        "title": "Disconnect this credential?",
                        "description": "Work using this credential will remain blocked."
                    }
                },
                "availability": { "available": true, "refusal": null }
            }]
        }))
        .unwrap();
        let confirmation = confirmation_from_projection(projection, &identity).unwrap();
        assert_eq!(confirmation.prompt_id, "credential.revoke.confirm");
        assert_eq!(confirmation.title, "Disconnect this credential?");
    }
}
