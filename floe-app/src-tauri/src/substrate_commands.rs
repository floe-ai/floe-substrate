use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::ipc::Channel;
use tauri::{path::BaseDirectory, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

static PROVIDER_LOGIN_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ProviderLoginGuard;

impl ProviderLoginGuard {
    fn acquire() -> Result<Self, String> {
        PROVIDER_LOGIN_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "A provider sign-in is already in progress".to_string())
    }
}

impl Drop for ProviderLoginGuard {
    fn drop(&mut self) {
        PROVIDER_LOGIN_ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Default)]
pub(crate) struct ProviderLoginProcess(Mutex<Option<CommandChild>>);

impl ProviderLoginProcess {
    fn start(&self, child: CommandChild) -> Result<(), String> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| "Could not manage the provider sign-in process".to_string())?;
        if let Some(previous) = active.replace(child) {
            let _ = previous.kill();
        }
        Ok(())
    }

    pub(crate) fn stop(&self) {
        if let Ok(mut active) = self.0.lock() {
            if let Some(child) = active.take() {
                let _ = child.kill();
            }
        }
    }
}

struct ProviderLoginChild<'a>(&'a ProviderLoginProcess);

impl Drop for ProviderLoginChild<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0 .0.lock() {
            if let Some(child) = active.take() {
                let _ = child.kill();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthProfileRecord {
    pub id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfilesResponse {
    pub profiles: Vec<AuthProfileRecord>,
    pub default_auth_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProviderModel {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub reasoning_efforts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProviderStatus {
    pub r#type: String,
    pub provider: String,
    pub name: String,
    pub auth_name: String,
    pub connected: bool,
    pub profile_id: String,
    pub models: Vec<ModelProviderModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_ref_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProvidersResponse {
    pub r#type: String,
    pub providers: Vec<ModelProviderStatus>,
}

fn get_floe_config_path() -> Result<PathBuf, String> {
    // Honour FLOE_CONFIG env override (same logic as the TS bridge)
    if let Ok(explicit) = env::var("FLOE_CONFIG") {
        return Ok(PathBuf::from(explicit));
    }
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "Could not determine user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".floe").join("config.yaml"))
}

/// Read config.yaml, update bridge.runtime_adapter, write back.
/// Uses serde_yaml::Value so the rest of the file is not disturbed.
fn write_runtime_adapter_to_config(adapter: &str) -> Result<(), String> {
    let config_path = get_floe_config_path()?;
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse config.yaml: {}", e))?;
    // Navigate bridge section, creating it if missing
    let bridge = doc
        .get_mut("bridge")
        .ok_or_else(|| "config.yaml missing 'bridge' section".to_string())?;
    let bridge_map = bridge
        .as_mapping_mut()
        .ok_or_else(|| "config.yaml 'bridge' is not a mapping".to_string())?;
    bridge_map.insert(
        serde_yaml::Value::String("runtime_adapter".to_string()),
        serde_yaml::Value::String(adapter.to_string()),
    );
    let updated = serde_yaml::to_string(&doc)
        .map_err(|e| format!("Failed to serialize config.yaml: {}", e))?;
    fs::write(&config_path, updated).map_err(|e| format!("Failed to write config.yaml: {}", e))?;
    Ok(())
}

fn read_runtime_adapter_from_config() -> Result<Option<String>, String> {
    let config_path = get_floe_config_path()?;
    if !config_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;
    let doc: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse config.yaml: {}", e))?;
    let adapter = doc
        .get("bridge")
        .and_then(|b| b.get("runtime_adapter"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(adapter)
}

#[tauri::command]
pub async fn get_substrate_auth_profiles(
    bus_broker: tauri::State<'_, crate::bus_broker::DesktopBusBroker>,
) -> Result<ProfilesResponse, String> {
    let profiles = bus_broker
        .provider_accounts()
        .await?
        .into_iter()
        .filter(|account| account.connected)
        .map(|account| AuthProfileRecord {
            id: format!("{}-subscription", account.provider_id),
            provider: account.provider_id.clone(),
            model: None,
            label: Some(provider_display_name(&account.provider_id)),
            created_at: None,
            updated_at: None,
        })
        .collect();
    Ok(ProfilesResponse {
        profiles,
        default_auth_profile: None,
    })
}

fn provider_display_name(provider: &str) -> String {
    match provider {
        "openai-codex" => "ChatGPT".to_string(),
        "anthropic" => "Claude".to_string(),
        "github-copilot" => "GitHub Copilot".to_string(),
        "google-gemini-cli" => "Gemini".to_string(),
        value => value.to_string(),
    }
}

fn parse_model_providers(stdout: &str) -> Result<Vec<ModelProviderStatus>, String> {
    for line in stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(response) = serde_json::from_str::<ModelProvidersResponse>(line) {
            if response.r#type == "provider_statuses" {
                return Ok(response.providers);
            }
        }
    }
    Err(if stdout.trim().is_empty() {
        "The provider helper returned no status".to_string()
    } else {
        "The provider helper returned invalid status".to_string()
    })
}

#[tauri::command]
pub async fn get_model_providers(
    app: tauri::AppHandle,
    bus_broker: tauri::State<'_, crate::bus_broker::DesktopBusBroker>,
) -> Result<Vec<ModelProviderStatus>, String> {
    let script = app
        .path()
        .resolve("resources/floe-desktop.js", BaseDirectory::Resource)
        .map_err(|e| format!("Failed to locate provider setup: {}", e))?;
    let script_dir = script
        .parent()
        .ok_or_else(|| "The provider setup resource has no parent directory".to_string())?;
    let output = app
        .shell()
        .sidecar("floe-node")
        .map_err(|e| format!("Failed to prepare provider setup: {}", e))?
        .current_dir(script_dir)
        .args(["floe-desktop.js", "auth", "providers"])
        .output()
        .await
        .map_err(|e| format!("Failed to inspect model providers: {}", e))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "The provider helper did not respond".to_string()
        } else {
            detail
        });
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "The provider helper returned invalid output".to_string())?;
    let mut providers = parse_model_providers(&stdout)?;
    let accounts = bus_broker.provider_accounts().await?;
    for provider in &mut providers {
        let account = accounts
            .iter()
            .find(|account| account.provider_id == provider.provider);
        provider.connected = account.map(|account| account.connected).unwrap_or(false);
        provider.secret_ref_id = account.map(|account| account.secret_ref_id.clone());
        provider.credential_revision = account.map(|account| {
            format!(
                "generation:{}:{}",
                account.generation,
                if account.connected {
                    "resolved"
                } else {
                    "unresolved"
                },
            )
        });
    }
    Ok(providers)
}

#[tauri::command]
pub async fn connect_model_provider(
    app: tauri::AppHandle,
    provider: String,
    on_event: Channel<serde_json::Value>,
    login_process: tauri::State<'_, ProviderLoginProcess>,
) -> Result<ModelProviderStatus, String> {
    let _login_guard = ProviderLoginGuard::acquire()?;
    let bus_broker = app.state::<crate::bus_broker::DesktopBusBroker>();
    let ingress = bus_broker
        .begin_provider_account_connection(&provider, &provider)
        .await?;
    let script = app
        .path()
        .resolve("resources/floe-desktop.js", BaseDirectory::Resource)
        .map_err(|e| format!("Failed to locate provider setup: {}", e))?;
    let script_dir = script
        .parent()
        .ok_or_else(|| "The provider setup resource has no parent directory".to_string())?;
    let (mut receiver, mut child) = app
        .shell()
        .sidecar("floe-node")
        .map_err(|e| format!("Failed to prepare provider setup: {}", e))?
        .current_dir(script_dir)
        .args(vec![
            "floe-desktop.js".to_string(),
            "auth".to_string(),
            "login".to_string(),
            provider.clone(),
            ingress.ingress_session_id.clone(),
            ingress.audience.clone(),
            ingress.purpose.clone(),
        ])
        .spawn()
        .map_err(|e| format!("Failed to start provider sign-in: {}", e))?;
    if child.write(ingress.bearer_token.as_bytes()).is_err() || child.write(b"\n").is_err() {
        let _ = child.kill();
        bus_broker
            .cancel_provider_account_connection(&ingress)
            .await;
        return Err("Floe could not initialise the protected provider sign-in session".to_string());
    }
    if let Err(error) = login_process.start(child) {
        bus_broker
            .cancel_provider_account_connection(&ingress)
            .await;
        return Err(error);
    }
    let _child_guard = ProviderLoginChild(&login_process);

    let mut result: Option<ModelProviderStatus> = None;
    let mut exit_code: Option<i32> = None;
    let sign_in_result: Result<ModelProviderStatus, String> = async {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                        continue;
                    };
                    if value.get("type").and_then(|item| item.as_str()) == Some("provider_status") {
                        result = serde_json::from_value(value).map_err(|e| {
                            format!("The provider helper returned invalid account status: {}", e)
                        })?;
                    } else {
                        on_event
                            .send(value)
                            .map_err(|e| format!("Could not update the sign-in screen: {}", e))?;
                    }
                }
                CommandEvent::Stderr(_) => {}
                CommandEvent::Error(_) => {
                    return Err("Provider sign-in stopped unexpectedly".to_string())
                }
                CommandEvent::Terminated(payload) => exit_code = payload.code,
                _ => {}
            }
        }

        if exit_code != Some(0) {
            return Err("Provider sign-in did not complete".to_string());
        }
        result.ok_or_else(|| "Provider sign-in completed without account status".to_string())
    }
    .await;
    let mut status = match sign_in_result {
        Ok(status) => status,
        Err(error) => {
            bus_broker
                .cancel_provider_account_connection(&ingress)
                .await;
            return Err(error);
        }
    };
    if let Err(error) = bus_broker
        .finish_provider_account_connection(&ingress)
        .await
    {
        bus_broker
            .cancel_provider_account_connection(&ingress)
            .await;
        return Err(error);
    }
    status.connected = true;
    write_runtime_adapter_to_config("pi-agent-core")?;
    Ok(status)
}

// ---------------------------------------------------------------------------
// Runtime adapter — Test (fake) / Live (Pi) switch
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeAdapterStatus {
    /// The persisted setting in config.yaml bridge.runtime_adapter (None = auto-detect)
    pub configured_adapter: Option<String>,
}

/// Read the persisted runtime_adapter from ~/.floe/config.yaml.
#[tauri::command]
pub fn get_runtime_adapter() -> Result<RuntimeAdapterStatus, String> {
    let configured_adapter = read_runtime_adapter_from_config()?;
    Ok(RuntimeAdapterStatus { configured_adapter })
}

/// Persist runtime_adapter to ~/.floe/config.yaml bridge.runtime_adapter.
/// Valid values: "fake" (Test) or "pi-agent-core" (Live).
/// The former "floe-runtime" name remains an alias for existing local configurations.
/// The new value takes effect on the next bridge start.
#[tauri::command]
pub fn set_runtime_adapter(adapter: String) -> Result<(), String> {
    let normalised = adapter.trim().to_lowercase();
    if normalised != "fake"
        && normalised != "floe-runtime"
        && normalised != "pi"
        && normalised != "pi-agent-core"
    {
        return Err(format!(
            "Invalid adapter \"{}\". Use \"fake\" (Test) or \"pi-agent-core\" (Live).",
            adapter
        ));
    }
    write_runtime_adapter_to_config(&normalised)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn providers_status_json() -> String {
        serde_json::json!({
            "type": "provider_statuses",
            "providers": [{
                "type": "provider_status",
                "provider": "openai-codex",
                "name": "ChatGPT",
                "auth_name": "OpenAI (ChatGPT Plus/Pro)",
                "connected": true,
                "profile_id": "openai-codex-subscription",
                "models": [],
                "secret_ref_id": null,
                "credential_revision": null
            }]
        })
        .to_string()
    }

    #[test]
    fn parses_provider_statuses_before_trailing_blank_or_launcher_output() {
        let json = providers_status_json();
        let providers = parse_model_providers(&format!("startup note\n{}\n\n", json)).unwrap();
        assert!(providers[0].connected);

        let providers = parse_model_providers(&format!("{}\nlauncher finished\n", json)).unwrap();
        assert_eq!(providers[0].provider, "openai-codex");
    }

    #[test]
    fn rejects_empty_or_unrelated_provider_helper_output_without_json_parser_noise() {
        assert_eq!(
            parse_model_providers("\r\n").unwrap_err(),
            "The provider helper returned no status"
        );
        assert_eq!(
            parse_model_providers("browser launcher output\n").unwrap_err(),
            "The provider helper returned invalid status"
        );
    }

    #[test]
    fn permits_only_one_provider_login_at_a_time() {
        let first = ProviderLoginGuard::acquire().unwrap();
        assert_eq!(
            ProviderLoginGuard::acquire().err().as_deref(),
            Some("A provider sign-in is already in progress")
        );
        drop(first);
        assert!(ProviderLoginGuard::acquire().is_ok());
    }

    #[test]
    fn presents_provider_accounts_without_inventing_profile_storage() {
        assert_eq!(provider_display_name("openai-codex"), "ChatGPT");
        assert_eq!(provider_display_name("github-copilot"), "GitHub Copilot");
        assert_eq!(provider_display_name("provider-x"), "provider-x");
    }
}
