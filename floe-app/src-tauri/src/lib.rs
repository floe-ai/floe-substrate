mod bus_broker;
mod fs_commands;
mod substrate_commands;

use serde::Serialize;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubstrateStatus {
    Healthy,
    NotRunning,
    Unresponsive,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubstrateHealthEvent {
    state: &'static str,
    detail: String,
    technical_detail: Option<String>,
}

fn emit_substrate_health(
    app: &tauri::AppHandle,
    state: &'static str,
    detail: impl Into<String>,
    technical_detail: Option<String>,
) {
    if let Err(error) = app.emit(
        "substrate-health",
        SubstrateHealthEvent {
            state,
            detail: detail.into(),
            technical_detail,
        },
    ) {
        log::warn!("could not publish substrate health: {error}");
    }
}

fn remember_stderr(tail: &mut VecDeque<String>, line: &[u8]) {
    let text = String::from_utf8_lossy(line).trim().to_string();
    if text.is_empty() {
        return;
    }
    if tail.len() == 8 {
        tail.pop_front();
    }
    tail.push_back(text.chars().take(500).collect());
}

fn is_healthy_http_response(response: &[u8]) -> bool {
    response.starts_with(b"HTTP/1.1 200") || response.starts_with(b"HTTP/1.0 200")
}

fn substrate_status() -> SubstrateStatus {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 5377);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return SubstrateStatus::NotRunning;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return SubstrateStatus::Unresponsive;
    }
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:5377\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return SubstrateStatus::Unresponsive;
    }
    let mut response = [0_u8; 256];
    match stream.read(&mut response) {
        Ok(read) if read > 0 && is_healthy_http_response(&response[..read]) => {
            SubstrateStatus::Healthy
        }
        _ => SubstrateStatus::Unresponsive,
    }
}

fn start_packaged_substrate(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    match substrate_status() {
        SubstrateStatus::Healthy => return Ok(()),
        SubstrateStatus::NotRunning => {}
        SubstrateStatus::Unresponsive => {
            // A listening process is not proof that the desktop owns it. Never kill
            // by executable name or port: that could interrupt a headless service,
            // another Floe installation, or unrelated operator work.
            return Err("port 5377 is occupied by a service that did not answer Floe's health check; Floe left that process untouched".into());
        }
    }

    emit_substrate_health(app, "starting", "Starting Floe's local services.", None);
    let mut child = app
        .state::<bus_broker::DesktopBusBroker>()
        .launch_packaged_substrate()
        .map_err(|error| format!("{error} Floe did not start an unauthenticated replacement."))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let health_app = app.clone();
    std::thread::spawn(move || {
        let mut stderr_tail = VecDeque::new();
        if let Some(stdout) = stdout {
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    log::info!("substrate: {line}");
                }
            });
        }
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                remember_stderr(&mut stderr_tail, line.as_bytes());
                log::warn!("substrate: {line}");
            }
        }
        let status = child.wait();
        let code = status.as_ref().ok().and_then(|value| value.code());
        let detail = match status {
            Ok(_) => format!(
                "Floe's local services stopped unexpectedly (exit code {}).",
                code.map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into())
            ),
            Err(_) => "Floe could not read the local service process status.".to_string(),
        };
        let technical_detail = if stderr_tail.is_empty() {
            None
        } else {
            Some(stderr_tail.into_iter().collect::<Vec<_>>().join("\n"))
        };
        if code == Some(0) {
            log::info!("packaged substrate exited with status {code:?}");
        } else {
            log::error!("packaged substrate exited with status {code:?}");
        }
        emit_substrate_health(&health_app, "offline", detail, technical_detail);
    });
    Ok(())
}

#[tauri::command]
fn restart_packaged_substrate(app: tauri::AppHandle) -> Result<(), String> {
    start_packaged_substrate(&app).map_err(|error| {
        let detail = format!("Floe could not restart its local services: {error}");
        emit_substrate_health(&app, "offline", detail.clone(), None);
        detail
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bus_broker = bus_broker::DesktopBusBroker::from_os_vault();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(bus_broker)
        .manage(substrate_commands::ProviderLoginProcess::default())
        .setup(|app| {
            if let Err(error) = start_packaged_substrate(app.handle()) {
                // Keep the window alive: the frontend has a bounded startup wait and
                // can explain the failure rather than disappearing without feedback.
                log::error!("could not start packaged substrate: {error}");
                emit_substrate_health(
                    app.handle(),
                    "offline",
                    format!("Floe could not start its local services: {error}"),
                    None,
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_commands::list_agent_files,
            fs_commands::read_file,
            fs_commands::read_media_file,
            fs_commands::write_file,
            substrate_commands::get_substrate_auth_profiles,
            substrate_commands::get_model_providers,
            substrate_commands::connect_model_provider,
            substrate_commands::get_runtime_adapter,
            substrate_commands::set_runtime_adapter,
            bus_broker::bus_request,
            bus_broker::list_local_workspace_bindings,
            bus_broker::get_local_runtime_status,
            bus_broker::list_browser_connections,
            bus_broker::get_auth_models,
            bus_broker::select_workspace,
            bus_broker::delete_workspace,
            bus_broker::approve_browser_connection,
            bus_broker::discover_host_operations,
            bus_broker::invoke_host_operation,
            bus_broker::confirm_and_invoke_host_operation,
            bus_broker::confirm_and_invoke_operation,
            bus_broker::read_bus_media,
            bus_broker::read_artefact_version_content,
            bus_broker::upload_context_attachment,
            bus_broker::open_workspace_stream,
            bus_broker::close_workspace_stream,
            restart_packaged_substrate,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            handle
                .state::<substrate_commands::ProviderLoginProcess>()
                .stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::{is_healthy_http_response, remember_stderr};

    #[test]
    fn accepts_only_successful_http_health_responses() {
        assert!(is_healthy_http_response(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}"
        ));
        assert!(!is_healthy_http_response(
            b"HTTP/1.1 503 Service Unavailable\r\n\r\n"
        ));
        assert!(!is_healthy_http_response(b""));
    }

    #[test]
    fn keeps_a_bounded_stderr_tail_for_operator_diagnostics() {
        let mut tail = VecDeque::new();
        for index in 0..10 {
            remember_stderr(&mut tail, format!("failure {index}").as_bytes());
        }
        assert_eq!(tail.len(), 8);
        assert_eq!(tail.front().map(String::as_str), Some("failure 2"));
        assert_eq!(tail.back().map(String::as_str), Some("failure 9"));
    }
}
