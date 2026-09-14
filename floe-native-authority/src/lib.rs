//! Tauri-independent native authority broker.
//!
//! This module is the only application-side adapter that opens the host-control
//! credential from the operating-system vault. Desktop, CLI, and a future
//! headless host use typed semantic methods and do not receive reusable bearer
//! material, with one deliberate exception: the local owner that boots the Bus
//! may obtain the host-control credential (see `host_control_token_for_local_boot`)
//! solely to inject it into the Bus process environment. No client chooses an
//! arbitrary Bus URL.

use rand::{rngs::OsRng, RngCore};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
use zeroize::Zeroize;

const DEFAULT_BUS_HTTP_BASE: &str = "http://127.0.0.1:5377";

/// The Bus base URL this broker operates against. Defaults to the local product
/// port. An isolated harness or a non-default local install overrides it via
/// FLOE_BUS_HTTP_BASE so the broker talks to the same Bus the CLI actually
/// started rather than a hardcoded one; without this the product start path is
/// only reusable at the single default port.
fn bus_http_base() -> String {
    std::env::var("FLOE_BUS_HTTP_BASE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BUS_HTTP_BASE.to_string())
}
const VAULT_SERVICE: &str = "com.floe.console";
const VAULT_ACCOUNT: &str = "local-bus-host-control";
const WORKSPACE_SESSION_SECONDS: u64 = 15 * 60;
const MAX_CONTEXT_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone)]
pub struct NativeAuthorityBroker {
    inner: Arc<AuthorityInner>,
}

struct AuthorityInner {
    client: reqwest::Client,
    host_credential: HostCredential,
    interaction_session_id: String,
    workspace_sessions: AsyncMutex<HashMap<String, CachedWorkspaceSession>>,
}

#[derive(Clone)]
enum HostCredential {
    Available(String),
    Unavailable(String),
}

#[derive(Clone)]
struct CachedWorkspaceSession {
    bearer_token: String,
    usable_until: Instant,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum AuthorityBoundary {
    Host,
    Workspace { workspace_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationTarget {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoverOperationsRequest {
    pub boundary: AuthorityBoundary,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub target: Option<OperationTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeOperationRequest {
    pub boundary: AuthorityBoundary,
    pub invocation: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterWorkspaceRequest {
    pub locator: String,
    #[serde(default)]
    pub init_authorized: bool,
}

fn default_bridge_id() -> String {
    "bridge:local".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProvideBridgeServiceTokenRequest {
    #[serde(default = "default_bridge_id")]
    pub bridge_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmWorkspaceOperationRequest {
    pub workspace_id: String,
    pub interaction_session_id: String,
    pub invocation: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmHostOperationRequest {
    pub interaction_session_id: String,
    pub invocation: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextAttachmentIngress {
    pub ingress_session_id: String,
    pub workspace_id: String,
    pub context_id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: usize,
    pub digest: AttachmentDigest,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttachmentDigest {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
struct IssuedContextAttachmentIngress {
    session: PendingContextAttachmentIngress,
    bearer_token: String,
}

#[derive(Clone, Debug, Deserialize)]
struct PendingContextAttachmentIngress {
    ingress_session_id: String,
    workspace_id: String,
    context_id: String,
    principal_id: String,
    name: String,
    media_type: String,
    size_bytes: usize,
    digest: Option<AttachmentDigest>,
    state: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct UploadedContextAttachmentIngress {
    session: PendingContextAttachmentIngress,
}

#[derive(Debug)]
pub struct AuthorityHttpResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

impl NativeAuthorityBroker {
    pub fn from_os_vault() -> Self {
        let host_credential = match load_or_create_host_credential() {
            Ok(token) => HostCredential::Available(token),
            Err(detail) => HostCredential::Unavailable(detail),
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("the local Bus HTTP client should be constructible");
        Self {
            inner: Arc::new(AuthorityInner {
                client,
                host_credential,
                interaction_session_id: format!("native_{}", random_secret(18)),
                workspace_sessions: AsyncMutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn list_local_workspaces(&self) -> Result<Value, String> {
        self.host_json(Method::GET, "/v1/local/workspaces", None)
            .await
    }

    /// Register (or return the existing) local Workspace binding for a locator
    /// and select it, using the host-control credential. These are fixed
    /// host-control bootstrap routes, not discoverable operations, so a
    /// non-desktop client reaches them through the broker instead of an
    /// unauthenticated call. The route literals are fixed here, not
    /// caller-supplied, so no host-path allowlist entry is required.
    pub async fn register_workspace(
        &self,
        request: RegisterWorkspaceRequest,
    ) -> Result<Value, String> {
        let token = self.host_control_token()?;
        let registered = self
            .inner
            .client
            .post(format!("{}/v1/workspaces/register", bus_http_base()))
            .bearer_auth(&token)
            .json(&json!({
                "locator": request.locator,
                "init_authorized": request.init_authorized,
            }))
            .send()
            .await
            .map_err(|_| unavailable_message())?;
        let registered = response_to_json(registered).await?;
        let workspace_id = registered
            .pointer("/workspace/workspace_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Floe returned an invalid Workspace registration.".to_string())?;
        let select = self
            .inner
            .client
            .post(format!(
                "{}/v1/workspaces/{}/select",
                bus_http_base(),
                urlencoding::encode(workspace_id)
            ))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| unavailable_message())?;
        if !select.status().is_success() {
            return Err(operator_http_error(select.status()));
        }
        Ok(registered)
    }

    /// Provision the ephemeral bridge-service credential one Bridge process
    /// start requires, using the host-control credential this broker owns. The
    /// CLI cannot mint this itself: the Bus is the sole issuer and the mint
    /// route is host-control authenticated, so the credential is obtained here
    /// on the same trust path as the Bus host-control token and then injected
    /// into the Bridge process environment only. The route literal is fixed
    /// here, not caller-supplied, so no host-path allowlist entry is required.
    pub async fn provide_bridge_service_token(
        &self,
        request: ProvideBridgeServiceTokenRequest,
    ) -> Result<Value, String> {
        let response = self
            .inner
            .client
            .post(format!("{}/v1/bridges/service-credential", bus_http_base()))
            .bearer_auth(self.host_control_token()?)
            .json(&json!({ "bridge_id": request.bridge_id }))
            .send()
            .await
            .map_err(|_| unavailable_message())?;
        let issued = response_to_json(response).await?;
        let token = issued
            .pointer("/bearer_token")
            .and_then(Value::as_str)
            .ok_or_else(|| "Floe did not provide a Bridge service credential.".to_string())?;
        Ok(json!({ "token": token }))
    }

    /// Read the fixed installation health projection. This does not admit
    /// arbitrary host routes through Workspace or semantic-operation requests.
    pub async fn local_runtime_status(&self) -> Result<AuthorityHttpResponse, String> {
        let response = self.inner.client
            .get(format!("{}/v1/runtime/status", bus_http_base()))
            .bearer_auth(self.host_control_token()?)
            .send().await.map_err(|_| unavailable_message())?;
        response_to_http(response).await
    }

    pub async fn discover_operations(
        &self,
        input: DiscoverOperationsRequest,
    ) -> Result<Value, String> {
        let query = discovery_query(input.query, input.category, input.target.as_ref())?;
        match input.boundary {
            AuthorityBoundary::Host => {
                self.host_json(Method::GET, &format!("/v1/local/operations{query}"), None)
                    .await
            }
            AuthorityBoundary::Workspace { workspace_id } => {
                validate_identifier("Workspace", &workspace_id)?;
                self.workspace_json(
                    Method::GET,
                    &format!(
                        "/v1/workspaces/{}/operations{query}",
                        urlencoding::encode(&workspace_id),
                    ),
                    None,
                    &workspace_id,
                )
                .await
            }
        }
    }

    pub async fn invoke_operation(&self, input: InvokeOperationRequest) -> Result<Value, String> {
        validate_invocation(&input.invocation)?;
        match input.boundary {
            AuthorityBoundary::Host => {
                self.host_json(
                    Method::POST,
                    "/v1/local/operations/invoke",
                    Some(input.invocation),
                )
                .await
            }
            AuthorityBoundary::Workspace { workspace_id } => {
                validate_identifier("Workspace", &workspace_id)?;
                self.workspace_json(
                    Method::POST,
                    &format!(
                        "/v1/workspaces/{}/operations/invoke",
                        urlencoding::encode(&workspace_id),
                    ),
                    Some(input.invocation),
                    &workspace_id,
                )
                .await
            }
        }
    }

    pub async fn confirm_and_invoke_workspace_operation(
        &self,
        input: ConfirmWorkspaceOperationRequest,
    ) -> Result<Value, String> {
        validate_identifier("Workspace", &input.workspace_id)?;
        validate_identifier("interaction session", &input.interaction_session_id)?;
        validate_invocation(&input.invocation)?;
        self.host_json(
            Method::POST,
            &format!(
                "/v1/local/workspaces/{}/operations/confirm-and-invoke",
                urlencoding::encode(&input.workspace_id),
            ),
            Some(json!({
                "interaction_session_id": input.interaction_session_id,
                "invocation": input.invocation,
            })),
        )
        .await
    }

    pub async fn confirm_and_invoke_host_operation(
        &self,
        input: ConfirmHostOperationRequest,
    ) -> Result<Value, String> {
        validate_identifier("interaction session", &input.interaction_session_id)?;
        validate_invocation(&input.invocation)?;
        self.host_json(
            Method::POST,
            "/v1/local/operations/confirm-and-invoke",
            Some(json!({
                "interaction_session_id": input.interaction_session_id,
                "invocation": input.invocation,
            })),
        )
        .await
    }

    /// Transfer one operator-selected file through a one-use, Context-bound
    /// bearer. The returned value contains no reusable authority or host path.
    pub async fn upload_context_attachment(
        &self,
        workspace_id: &str,
        context_id: &str,
        name: &str,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<ContextAttachmentIngress, String> {
        validate_identifier("Workspace", workspace_id)?;
        validate_identifier("Context", context_id)?;
        validate_attachment_name(name)?;
        validate_media_type(media_type)?;
        if bytes.is_empty() || bytes.len() > MAX_CONTEXT_ATTACHMENT_BYTES {
            return Err("Attach a non-empty file no larger than 20 MB.".into());
        }
        let issue_path = format!(
            "/v1/workspaces/{}/attachment-ingress-sessions",
            urlencoding::encode(workspace_id),
        );
        let issued = self
            .workspace_json(
                Method::POST,
                &issue_path,
                Some(json!({
                    "context_id": context_id,
                    "name": name,
                    "media_type": media_type,
                    "size_bytes": bytes.len(),
                })),
                workspace_id,
            )
            .await?;
        let issued: IssuedContextAttachmentIngress = serde_json::from_value(issued)
            .map_err(|_| "Floe returned an invalid attachment transfer session.".to_string())?;
        validate_pending_attachment(
            &issued.session,
            workspace_id,
            context_id,
            name,
            media_type,
            bytes.len(),
            "awaiting_content",
        )?;
        if issued.bearer_token.len() < 32 {
            return Err("Floe returned an invalid attachment transfer session.".into());
        }
        let ingress_session_id = issued.session.ingress_session_id.clone();
        let mut bearer_token = issued.bearer_token;
        let upload = self
            .inner
            .client
            .put(format!(
                "{}/v1/attachment-ingress-sessions/{}/content",
                bus_http_base(),
                urlencoding::encode(&ingress_session_id),
            ))
            .bearer_auth(&bearer_token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|_| unavailable_message());
        bearer_token.zeroize();
        let upload = match upload {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                let _ = self
                    .revoke_context_attachment(workspace_id, context_id, &ingress_session_id)
                    .await;
                return Err(operator_http_error(response.status()));
            }
            Err(error) => {
                let _ = self
                    .revoke_context_attachment(workspace_id, context_id, &ingress_session_id)
                    .await;
                return Err(error);
            }
        };
        let uploaded = upload
            .json::<UploadedContextAttachmentIngress>()
            .await
            .map_err(|_| "Floe returned an invalid attachment transfer result.".to_string())?;
        validate_pending_attachment(
            &uploaded.session,
            workspace_id,
            context_id,
            name,
            media_type,
            uploaded.session.size_bytes,
            "ready",
        )?;
        let digest = uploaded
            .session
            .digest
            .filter(|digest| digest.algorithm == "sha256" && is_sha256(&digest.value))
            .ok_or_else(|| "Floe did not pin the selected file to exact content.".to_string())?;
        Ok(ContextAttachmentIngress {
            ingress_session_id: uploaded.session.ingress_session_id,
            workspace_id: uploaded.session.workspace_id,
            context_id: uploaded.session.context_id,
            name: uploaded.session.name,
            media_type: uploaded.session.media_type,
            size_bytes: uploaded.session.size_bytes,
            digest,
        })
    }

    async fn revoke_context_attachment(
        &self,
        workspace_id: &str,
        context_id: &str,
        ingress_session_id: &str,
    ) -> Result<(), String> {
        let path = format!(
            "/v1/workspaces/{}/attachment-ingress-sessions/{}/revoke",
            urlencoding::encode(workspace_id),
            urlencoding::encode(ingress_session_id),
        );
        self.workspace_json(
            Method::POST,
            &path,
            Some(json!({ "context_id": context_id })),
            workspace_id,
        )
        .await?;
        Ok(())
    }

    /// One-shot CLI/headless provider connection using only the fixed packaged
    /// Floe auth helper. Neither the reusable host credential nor the ingress
    /// bearer is returned to the caller.
    /// Start the fixed packaged Bus/Bridge host while keeping its reusable
    /// host-control credential inside this authority boundary.
    pub fn launch_packaged_substrate(&self) -> Result<Child, String> {
        let executable_directory = packaged_executable_directory()?;
        let node_name = if cfg!(windows) {
            "floe-node.exe"
        } else {
            "floe-node"
        };
        let node = executable_directory.join(node_name);
        let resources = executable_directory.join("resources");
        let script = resources.join("floe-desktop.js");
        if !node.is_file() || !script.is_file() {
            return Err("Floe could not locate its packaged local service.".into());
        }
        let mut command = Command::new(node);
        command
            .current_dir(resources)
            .arg("floe-desktop.js")
            .arg("substrate")
            .env("FLOE_HOST_CONTROL_TOKEN", self.host_control_token()?)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_windows_process(&mut command);
        command
            .spawn()
            .map_err(|_| "Floe could not start its packaged local service.".into())
    }

    pub fn interaction_session_id(&self) -> &str {
        &self.inner.interaction_session_id
    }

    pub async fn health(&self) -> Result<AuthorityHttpResponse, String> {
        let response = self
            .inner
            .client
            .get(format!("{}/health", bus_http_base()))
            .send()
            .await
            .map_err(|_| unavailable_message())?;
        response_to_http(response).await
    }

    pub async fn send_host_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<AuthorityHttpResponse, String> {
        let response = self.host_response(method, path, body).await?;
        response_to_http(response).await
    }

    pub async fn send_workspace_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        workspace_id: &str,
    ) -> Result<reqwest::Response, String> {
        validate_workspace_route(&method, path, workspace_id)?;
        let bearer = self.workspace_session_bearer(workspace_id).await?;
        let mut builder = self
            .inner
            .client
            .request(method, format!("{}{path}", bus_http_base()))
            .bearer_auth(bearer);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        builder.send().await.map_err(|_| unavailable_message())
    }

    /// Trusted WebSocket adapter seam. Callers must never serialize the value.
    pub async fn workspace_session_bearer(&self, workspace_id: &str) -> Result<String, String> {
        validate_identifier("Workspace", workspace_id)?;
        let mut sessions = self.inner.workspace_sessions.lock().await;
        if let Some(session) = sessions.get(workspace_id) {
            if session.usable_until > Instant::now() {
                return Ok(session.bearer_token.clone());
            }
        }
        let host_token = self.host_control_token()?;
        let response = self
            .inner
            .client
            .post(format!(
                "{}/v1/local/workspaces/{}/operation-sessions",
                bus_http_base(),
                urlencoding::encode(workspace_id),
            ))
            .bearer_auth(host_token)
            .json(&json!({
                "interaction_session_id": self.inner.interaction_session_id,
                "expires_in_seconds": WORKSPACE_SESSION_SECONDS,
            }))
            .send()
            .await
            .map_err(|_| unavailable_message())?;
        if !response.status().is_success() {
            return Err(match response.status() {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => recovery_required_message(),
                StatusCode::NOT_FOUND => "The selected Workspace is no longer available.".into(),
                _ => "Floe could not open an authenticated Workspace session.".into(),
            });
        }
        let issued = response
            .json::<IssuedWorkspaceSession>()
            .await
            .map_err(|_| "Floe received an invalid Workspace session response.".to_string())?;
        if issued.bearer_token.len() < 32 {
            return Err("Floe received an invalid Workspace session response.".into());
        }
        let session = CachedWorkspaceSession {
            bearer_token: issued.bearer_token,
            usable_until: Instant::now() + Duration::from_secs(WORKSPACE_SESSION_SECONDS - 30),
        };
        let bearer = session.bearer_token.clone();
        sessions.insert(workspace_id.to_string(), session);
        Ok(bearer)
    }

    pub async fn invalidate_workspace_session(&self, workspace_id: &str) {
        self.inner
            .workspace_sessions
            .lock()
            .await
            .remove(workspace_id);
    }

    async fn host_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        response_to_json(self.host_response(method, path, body).await?).await
    }

    async fn workspace_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        workspace_id: &str,
    ) -> Result<Value, String> {
        let mut response = self
            .send_workspace_request(method.clone(), path, body.clone(), workspace_id)
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.invalidate_workspace_session(workspace_id).await;
            response = self
                .send_workspace_request(method, path, body, workspace_id)
                .await?;
        }
        response_to_json(response).await
    }

    async fn host_response(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        if !is_permitted_host_control_path(path) {
            return Err("The native authority broker refused a non-semantic host route.".into());
        }
        let token = self.host_control_token()?;
        let mut builder = self
            .inner
            .client
            .request(method, format!("{}{path}", bus_http_base()))
            .bearer_auth(token);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        builder.send().await.map_err(|_| unavailable_message())
    }

    fn host_control_token(&self) -> Result<String, String> {
        match &self.inner.host_credential {
            HostCredential::Available(token) => Ok(token.clone()),
            HostCredential::Unavailable(detail) => Err(detail.clone()),
        }
    }

    /// Hand the host-control credential to the trusted local owner so it can
    /// boot the Bus as the "trusted native owner" the Bus requires at startup.
    ///
    /// This is the single, deliberate exception to "clients never receive
    /// reusable bearer material": with the desktop app gone, the CLI is the
    /// only process that starts the local Bus, and the Bus refuses to run
    /// without this credential. The broker remains the sole keyring owner; the
    /// CLI must inject the returned value into the Bus process environment only
    /// and must never log, echo, or persist it.
    pub fn host_control_token_for_local_boot(&self) -> Result<String, String> {
        self.host_control_token()
    }
}

#[derive(Debug, Deserialize)]
struct IssuedWorkspaceSession {
    bearer_token: String,
}

fn load_or_create_host_credential() -> Result<String, String> {
    let entry =
        keyring::Entry::new(VAULT_SERVICE, VAULT_ACCOUNT).map_err(|_| secure_storage_message())?;
    match entry.get_password() {
        Ok(token) if token.len() >= 32 => Ok(token),
        Ok(_) => Err(recovery_required_message()),
        Err(keyring::Error::NoEntry) => {
            let token = format!("floe_host_control_{}", random_secret(32));
            entry
                .set_password(&token)
                .map_err(|_| secure_storage_message())?;
            Ok(token)
        }
        Err(_) => Err(secure_storage_message()),
    }
}

fn random_secret(bytes: usize) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let mut buffer = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

fn packaged_executable_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .ok_or_else(|| "Floe could not locate its packaged executable directory.".to_string())
}

fn hide_windows_process(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn discovery_query(
    query: Option<String>,
    category: Option<String>,
    target: Option<&OperationTarget>,
) -> Result<String, String> {
    let mut values = Vec::new();
    if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
        values.push(format!("query={}", urlencoding::encode(query.trim())));
    }
    if let Some(category) = category.filter(|value| !value.trim().is_empty()) {
        values.push(format!("category={}", urlencoding::encode(category.trim())));
    }
    if let Some(target) = target {
        validate_identifier("operation target kind", &target.kind)?;
        validate_identifier("operation target", &target.id)?;
        values.push(format!("target_kind={}", urlencoding::encode(&target.kind)));
        values.push(format!("target_id={}", urlencoding::encode(&target.id)));
    }
    Ok(if values.is_empty() {
        String::new()
    } else {
        format!("?{}", values.join("&"))
    })
}

fn validate_invocation(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "The semantic operation request is invalid.".to_string())?;
    for field in [
        "operation_id",
        "operation_version",
        "input_schema_version",
        "idempotency_key",
    ] {
        let value = object.get(field).and_then(Value::as_str).unwrap_or("");
        validate_identifier("semantic operation", value)?;
    }
    if !object.contains_key("input") {
        return Err("The semantic operation request is invalid.".into());
    }
    Ok(())
}

/// Host-control paths this authority's host token may reach — a fixed literal
/// allowlist, not a caller-supplied prefix bypass. Kept in lockstep with
/// bus_broker.rs::is_host_control_path, which is what decided these routes are
/// host-control (not Workspace-authenticated) in the first place. Only the
/// existing "/v1/local/*" prefix plus these additional exact route shapes are
/// permitted; every other path is still refused.
fn is_permitted_host_control_path(path: &str) -> bool {
    if path.starts_with("/v1/local/") {
        return true;
    }
    let path_only = path.split('?').next().unwrap_or(path);
    if path_only.starts_with("/v1/auth/") {
        return true;
    }
    let Some(rest) = path_only.strip_prefix("/v1/workspaces/") else {
        return false;
    };
    let mut segments = rest.split('/');
    let _workspace = segments.next();
    matches!(segments.next(), Some("select") | Some("delete"))
}

fn validate_workspace_route(method: &Method, path: &str, workspace_id: &str) -> Result<(), String> {
    validate_identifier("Workspace", workspace_id)?;
    let refused = || "The native authority broker refused a route outside the selected Workspace.".to_string();
    let path_only = path.split('?').next().ok_or_else(refused)?;
    let decoded = urlencoding::decode(path_only).map_err(|_| refused())?;
    if !path.starts_with("/v1/")
        || path.contains('#')
        || path.contains('\\')
        || decoded.contains('\\')
        || decoded.split('/').any(|part| part == "." || part == "..")
        || path.chars().chain(decoded.chars()).any(char::is_control)
    {
        return Err(refused());
    }
    let url = reqwest::Url::parse(&format!("{}{path}", bus_http_base())).map_err(|_| refused())?;
    let mut names_workspace = false;
    for (key, value) in url.query_pairs() {
        if key == "workspace_id" {
            if value != workspace_id {
                return Err(refused());
            }
            names_workspace = true;
        }
    }
    let prefix = format!("/v1/workspaces/{}/", urlencoding::encode(workspace_id));
    if path.starts_with(&prefix) {
        return Ok(());
    }

    // Existing conversation projections identify their Workspace in a query or
    // in the retained Context. They still use the selected Workspace's session;
    // the Bus checks every referenced record against that session. Only these
    // reads are admitted here: worker claims and mutations are not projections.
    let parts: Vec<_> = path_only.split('/').skip(1).collect();
    let collection = matches!(parts.as_slice(),
        ["v1", "contexts"] | ["v1", "events"] | ["v1", "delivery"]
        | ["v1", "runtime", "telemetry"]);
    let context_read = matches!(parts.as_slice(),
        ["v1", "contexts", id] | ["v1", "contexts", id, "tree" | "events"]
        if !id.is_empty());
    // The workspace_default runtime binding (Settings > Workspace model) names
    // its Workspace in the request body rather than the path, mirroring the
    // browser's identical /v1/runtime/bindings* calls (see
    // floe-bus/src/server.ts::resolveTransportRequirement). The Bus still
    // verifies the session's bound Workspace against the body/query it reads,
    // so admitting these routes here does not widen what the session can
    // actually reach.
    let runtime_bindings = matches!(parts.as_slice(),
        ["v1", "runtime", "bindings"] | ["v1", "runtime", "bindings", "resolve" | "clear"]);
    if runtime_bindings
        || (method == Method::GET && ((collection && names_workspace) || context_read))
    {
        return Ok(());
    }
    Err(refused())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("The {label} reference is invalid."));
    }
    Ok(())
}

fn validate_attachment_name(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 255
        || value.chars().any(char::is_control)
        || value.replace('\\', "/").split('/').next_back().is_none()
    {
        return Err("The selected file name is invalid.".into());
    }
    Ok(())
}

fn validate_media_type(value: &str) -> Result<(), String> {
    let value = value.trim();
    let mut parts = value.split('/');
    let valid_part = |part: Option<&str>| {
        part.is_some_and(|part| {
            !part.is_empty()
                && part.len() <= 127
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(
                            character,
                            '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                        )
                })
        })
    };
    if !valid_part(parts.next()) || !valid_part(parts.next()) || parts.next().is_some() {
        return Err("The selected file media type is invalid.".into());
    }
    Ok(())
}

fn validate_pending_attachment(
    value: &PendingContextAttachmentIngress,
    workspace_id: &str,
    context_id: &str,
    name: &str,
    media_type: &str,
    size_bytes: usize,
    state: &str,
) -> Result<(), String> {
    validate_identifier("attachment transfer", &value.ingress_session_id)?;
    validate_identifier("attachment principal", &value.principal_id)?;
    if value.workspace_id != workspace_id
        || value.context_id != context_id
        || value.name
            != name
                .replace('\\', "/")
                .split('/')
                .next_back()
                .unwrap_or(name)
        || value.media_type != media_type.to_ascii_lowercase()
        || value.size_bytes != size_bytes
        || value.state != state
        || value.expires_at.trim().is_empty()
    {
        return Err("Floe returned an attachment transfer for different content.".into());
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn response_to_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(operator_http_error(status));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "Floe returned an invalid semantic operation response.".into())
}

async fn response_to_http(response: reqwest::Response) -> Result<AuthorityHttpResponse, String> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.map_err(|_| unavailable_message())?;
    Ok(AuthorityHttpResponse {
        status,
        content_type,
        body,
    })
}

fn operator_http_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => recovery_required_message(),
        StatusCode::NOT_FOUND => "The requested Floe resource is no longer available.".into(),
        _ => format!("Floe's local service returned status {}.", status.as_u16()),
    }
}

fn unavailable_message() -> String {
    "Floe's local service is unavailable. Close and reopen Floe, then try again.".into()
}

fn secure_storage_message() -> String {
    "Floe could not access this computer's secure credential storage.".into()
}

fn recovery_required_message() -> String {
    "Floe cannot verify this installation with the local substrate. Credential recovery is required.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_discovery_builds_only_declared_operation_filters() {
        let query = discovery_query(
            Some("credential".into()),
            Some("credentials".into()),
            Some(&OperationTarget {
                kind: "secret_ref".into(),
                id: "secretref:one".into(),
            }),
        )
        .unwrap();
        assert_eq!(query, "?query=credential&category=credentials&target_kind=secret_ref&target_id=secretref%3Aone");
    }

    #[test]
    fn workspace_routes_cannot_escape_the_named_boundary() {
        assert!(validate_workspace_route(
            &Method::GET,
            "/v1/workspaces/workspace%3Aone/operations",
            "workspace:one"
        )
        .is_ok());
        assert!(validate_workspace_route(
            &Method::GET,
            "/v1/workspaces/workspace%3Atwo/operations",
            "workspace:one"
        )
        .is_err());
        assert!(validate_workspace_route(&Method::GET, "/v1/local/operations", "workspace:one").is_err());
    }

    #[test]
    fn desktop_conversation_reads_use_the_selected_workspace_session() {
        for path in [
            "/v1/contexts?participant=actor%3Aone&workspace_id=workspace%3Aone&limit=20",
            "/v1/contexts/context%3Aone",
            "/v1/events?context_id=context%3Aone&workspace_id=workspace%3Aone&direction=backward&limit=50",
            "/v1/delivery?context_id=context%3Aone&workspace_id=workspace%3Aone&limit=500",
            "/v1/runtime/telemetry?workspace_id=workspace%3Aone&delivery_id=delivery%3Aone&limit=100",
        ] {
            assert!(validate_workspace_route(&Method::GET, path, "workspace:one").is_ok(), "Desktop conversation read was refused: {path}");
        }
    }

    #[test]
    fn conversation_reads_do_not_widen_mutation_or_workspace_authority() {
        for path in [
            "/v1/contexts?workspace_id=workspace%3Aone",
            "/v1/contexts/context%3Aone",
            "/v1/events?workspace_id=workspace%3Aone",
            "/v1/delivery?workspace_id=workspace%3Aone",
            "/v1/runtime/telemetry?workspace_id=workspace%3Aone",
        ] {
            for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
                assert!(validate_workspace_route(&method, path, "workspace:one").is_err());
            }
        }
        for path in [
            "/v1/contexts",
            "/v1/events?context_id=context%3Aone",
            "/v1/contexts?workspace_id=workspace%3Atwo",
            "/v1/contexts?workspace_id=workspace%3Aone&workspace_id=workspace%3Atwo",
            "/v1/workspaces/workspace%3Aone/operations?workspace_id=workspace%3Atwo",
            "/v1/contexts/context%3Aone?workspace_id=workspace%3Atwo",
            "/v1/contexts/context%3Aone/clear-history",
            "/v1/delivery/claim?workspace_id=workspace%3Aone",
            "/v1/local/workspaces",
            "/v1/auth/profiles",
            "/v1/workspaces/workspace%3Aone/../../../local/workspaces",
            "/v1/contexts/%2e%2e/local",
            "/v1/contexts/%2e%2e%2flocal",
            "/v1/contexts/%5clocal",
            "/v1/contexts/context%3Aone#fragment",
            "http://example.invalid/v1/contexts",
        ] {
            assert!(validate_workspace_route(&Method::GET, path, "workspace:one").is_err(), "Unexpectedly accepted {path}");
        }
    }

    #[test]
    fn attachment_transfer_validation_binds_exact_context_and_content() {
        let pending = PendingContextAttachmentIngress {
            ingress_session_id: "attachment-ingress:one".into(),
            workspace_id: "workspace:one".into(),
            context_id: "context:one".into(),
            principal_id: "principal:operator".into(),
            name: "concept.png".into(),
            media_type: "image/png".into(),
            size_bytes: 4,
            digest: None,
            state: "awaiting_content".into(),
            expires_at: "2026-09-04T01:00:00.000Z".into(),
        };
        assert!(validate_pending_attachment(
            &pending,
            "workspace:one",
            "context:one",
            "C:\\fake\\concept.png",
            "image/png",
            4,
            "awaiting_content",
        )
        .is_ok());
        assert!(validate_pending_attachment(
            &pending,
            "workspace:one",
            "context:other",
            "concept.png",
            "image/png",
            4,
            "awaiting_content",
        )
        .is_err());
        assert!(validate_media_type("image/png").is_ok());
        assert!(validate_media_type("invalid").is_err());
        assert!(is_sha256(&"a".repeat(64)));
    }
}
