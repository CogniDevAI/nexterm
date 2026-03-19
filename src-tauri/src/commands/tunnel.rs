// commands/tunnel.rs — Tunnel Tauri commands
//
// Handles: create_tunnel, start_tunnel, stop_tunnel,
// remove_tunnel, list_tunnels
//
// Tunnel lifecycle: Created (Stopped) → Starting → Active → Stopping → Stopped / Error
// TunnelEvent streamed via Tauri Channel for real-time status updates.

use std::sync::atomic::Ordering;

use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::tunnel::{self, TunnelInfo};
use crate::state::{
    AppState, SessionState, TunnelConfig, TunnelEvent, TunnelId, TunnelState, TunnelType,
};

/// Create a new tunnel configuration and start it.
///
/// The tunnel is stored in the session's tunnel map. If the config already
/// has a non-nil ID, that ID is used; otherwise a new UUID is generated.
#[tauri::command]
pub async fn create_tunnel(
    state: State<'_, AppState>,
    session_id: Uuid,
    mut config: TunnelConfig,
    on_event: Channel<TunnelEvent>,
) -> Result<TunnelId, AppError> {
    // Ensure the config has a valid ID
    if config.id.is_nil() {
        config.id = Uuid::new_v4();
    }
    let tunnel_id = config.id;

    // Validate the session is connected and check for duplicates
    {
        let sessions = state.sessions.lock().await;
        let session = sessions
            .get(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;

        if session.state != SessionState::Connected {
            return Err(AppError::NotConnected);
        }

        if session.tunnels.contains_key(&tunnel_id) {
            return Err(AppError::TunnelError(format!(
                "Tunnel {} already exists in session",
                tunnel_id
            )));
        }
    }

    // Start the tunnel based on type
    let tunnel_handle = match config.tunnel_type {
        TunnelType::Local => {
            // Get shared sessions Arc and session cancel token
            let shared_sessions = state.sessions.clone();
            let session_cancel = {
                let sessions = state.sessions.lock().await;
                sessions
                    .get(&session_id)
                    .ok_or(AppError::SessionNotFound(session_id))?
                    .cancel_token
                    .clone()
            };

            tunnel::start_local_forward(
                shared_sessions,
                session_id,
                &config,
                session_cancel,
                on_event,
            )
            .await?
        }
        TunnelType::Remote => {
            let mut sessions = state.sessions.lock().await;
            let session = sessions
                .get_mut(&session_id)
                .ok_or(AppError::SessionNotFound(session_id))?;

            let ssh_mut = session
                .ssh_handle
                .as_mut()
                .ok_or(AppError::NotConnected)?;

            let registry = session
                .remote_forward_registry
                .clone()
                .ok_or_else(|| {
                    AppError::TunnelError(
                        "Remote forward registry not available".to_string(),
                    )
                })?;

            let session_cancel = session.cancel_token.clone();

            tunnel::start_remote_forward(
                ssh_mut,
                &config,
                session_cancel,
                registry,
                on_event,
            )
            .await?
        }
    };

    // Store the tunnel handle in the session
    {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;
        session.tunnels.insert(tunnel_id, tunnel_handle);
    }

    tracing::info!(
        "Tunnel {} created and started for session {}",
        tunnel_id,
        session_id
    );

    Ok(tunnel_id)
}

/// Start a previously stopped tunnel.
#[tauri::command]
pub async fn start_tunnel(
    state: State<'_, AppState>,
    session_id: Uuid,
    tunnel_id: TunnelId,
    on_event: Channel<TunnelEvent>,
) -> Result<(), AppError> {
    // Get the config and validate state
    let config = {
        let sessions = state.sessions.lock().await;
        let session = sessions
            .get(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;

        if session.state != SessionState::Connected {
            return Err(AppError::NotConnected);
        }

        let existing = session
            .tunnels
            .get(&tunnel_id)
            .ok_or_else(|| AppError::TunnelError(format!("Tunnel {} not found", tunnel_id)))?;

        // Only start if stopped or errored
        match &existing.state {
            TunnelState::Stopped | TunnelState::Error { .. } => {}
            TunnelState::Active { .. } | TunnelState::Starting => {
                return Err(AppError::TunnelError(format!(
                    "Tunnel {} is already running",
                    tunnel_id
                )));
            }
        }

        existing.config.clone()
    };

    // Start the tunnel
    let new_handle = match config.tunnel_type {
        TunnelType::Local => {
            let shared_sessions = state.sessions.clone();
            let session_cancel = {
                let sessions = state.sessions.lock().await;
                sessions
                    .get(&session_id)
                    .ok_or(AppError::SessionNotFound(session_id))?
                    .cancel_token
                    .clone()
            };

            tunnel::start_local_forward(
                shared_sessions,
                session_id,
                &config,
                session_cancel,
                on_event,
            )
            .await?
        }
        TunnelType::Remote => {
            let mut sessions = state.sessions.lock().await;
            let session = sessions
                .get_mut(&session_id)
                .ok_or(AppError::SessionNotFound(session_id))?;

            let ssh_mut = session
                .ssh_handle
                .as_mut()
                .ok_or(AppError::NotConnected)?;

            let registry = session
                .remote_forward_registry
                .clone()
                .ok_or_else(|| {
                    AppError::TunnelError(
                        "Remote forward registry not available".to_string(),
                    )
                })?;

            let session_cancel = session.cancel_token.clone();

            tunnel::start_remote_forward(
                ssh_mut,
                &config,
                session_cancel,
                registry,
                on_event,
            )
            .await?
        }
    };

    // Replace the old handle
    {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;

        // Stop the old handle cleanly
        if let Some(mut old) = session.tunnels.remove(&tunnel_id) {
            tunnel::stop_tunnel(&mut old);
        }
        session.tunnels.insert(tunnel_id, new_handle);
    }

    tracing::info!("Tunnel {} restarted for session {}", tunnel_id, session_id);

    Ok(())
}

/// Stop a running tunnel.
///
/// For remote tunnels, sends `cancel_tcpip_forward` to the SSH server before
/// stopping — this tells the server to stop listening on the forwarded port.
/// Without this, the server keeps the port bound even after the client stops.
#[tauri::command]
pub async fn stop_tunnel(
    state: State<'_, AppState>,
    session_id: Uuid,
    tunnel_id: TunnelId,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    let handle = session
        .tunnels
        .get_mut(&tunnel_id)
        .ok_or_else(|| AppError::TunnelError(format!("Tunnel {} not found", tunnel_id)))?;

    // For remote tunnels, tell the SSH server to stop listening on the forwarded port.
    // This must happen BEFORE we cancel the token / abort the task.
    if handle.config.tunnel_type == TunnelType::Remote {
        if let Some(ssh_handle) = session.ssh_handle.as_ref() {
            let addr = &handle.config.bind_host;
            let port = handle.config.bind_port as u32;
            tracing::debug!(
                "Tunnel {tunnel_id}: sending cancel_tcpip_forward for {addr}:{port}"
            );
            if let Err(e) = ssh_handle.cancel_tcpip_forward(addr, port).await {
                // Log but don't fail — the tunnel stop should proceed regardless.
                // The server may already be disconnected.
                tracing::warn!(
                    "Tunnel {tunnel_id}: cancel_tcpip_forward failed (non-fatal): {e}"
                );
            }
        }
    }

    tunnel::stop_tunnel(handle);

    tracing::info!("Tunnel {} stopped for session {}", tunnel_id, session_id);

    Ok(())
}

/// Remove a tunnel from the session (stops it first if running).
///
/// For remote tunnels, sends `cancel_tcpip_forward` before cleanup.
#[tauri::command]
pub async fn remove_tunnel(
    state: State<'_, AppState>,
    session_id: Uuid,
    tunnel_id: TunnelId,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    let mut handle = session
        .tunnels
        .remove(&tunnel_id)
        .ok_or_else(|| AppError::TunnelError(format!("Tunnel {} not found", tunnel_id)))?;

    // For remote tunnels, cancel the server-side listener before cleanup
    if handle.config.tunnel_type == TunnelType::Remote {
        if let Some(ssh_handle) = session.ssh_handle.as_ref() {
            let addr = &handle.config.bind_host;
            let port = handle.config.bind_port as u32;
            if let Err(e) = ssh_handle.cancel_tcpip_forward(addr, port).await {
                tracing::warn!(
                    "Tunnel {tunnel_id}: cancel_tcpip_forward failed (non-fatal): {e}"
                );
            }
        }
    }

    // Stop if still running
    tunnel::stop_tunnel(&mut handle);

    tracing::info!(
        "Tunnel {} removed from session {}",
        tunnel_id,
        session_id
    );

    Ok(())
}

/// List all tunnels for a session with current state.
#[tauri::command]
pub async fn list_tunnels(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<Vec<TunnelInfo>, AppError> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    let tunnels: Vec<TunnelInfo> = session
        .tunnels
        .values()
        .map(tunnel_handle_to_info)
        .collect();

    Ok(tunnels)
}

/// Convert a TunnelHandle to a serializable TunnelInfo
fn tunnel_handle_to_info(handle: &crate::state::TunnelHandle) -> TunnelInfo {
    let connections = handle
        .active_connections
        .as_ref()
        .map(|c| c.load(Ordering::Relaxed))
        .unwrap_or(0);

    TunnelInfo {
        config: handle.config.clone(),
        state: handle.state.clone(),
        bytes_in: handle.bytes_in.load(Ordering::Relaxed),
        bytes_out: handle.bytes_out.load(Ordering::Relaxed),
        active_connections: connections,
    }
}
