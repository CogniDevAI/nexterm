// commands/connection.rs — SSH connection Tauri commands
//
// Handles: connect, disconnect, list_sessions, get_session_state,
// respond_host_key_verification, test_connection

use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::AppError;
use crate::ssh::session;
use crate::state::{
    AppState, HostKeyVerificationRequest, HostKeyVerificationResponse, SessionId, SessionInfo,
    SessionState,
};

// ─── Session State Event (streamed via Channel) ─────────

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SessionStateEvent {
    StateChanged { session_id: SessionId, state: SessionState },
    HostKeyVerification(HostKeyVerificationRequest),
}

// ─── Pending host key verifications ─────────────────────

/// We store the response_tx for pending host key verifications
/// keyed by session_id so the `respond_host_key_verification` command can find it.
type PendingVerifications =
    tokio::sync::Mutex<std::collections::HashMap<SessionId, oneshot::Sender<HostKeyVerificationResponse>>>;

/// Lazy-initialized global storage for pending host key verification channels.
/// This is necessary because the handler's oneshot bridge needs to be accessible
/// from the `respond_host_key_verification` command.
static PENDING_HK_VERIFICATIONS: std::sync::OnceLock<PendingVerifications> = std::sync::OnceLock::new();

fn pending_hk() -> &'static PendingVerifications {
    PENDING_HK_VERIFICATIONS.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

// ─── Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    profile_id: Uuid,
    password: Option<String>,
    on_event: Channel<SessionStateEvent>,
) -> Result<SessionId, AppError> {
    // Wrap password in Zeroizing so it's wiped from memory when dropped
    let password: Option<Zeroizing<String>> = password.map(Zeroizing::new);
    // Find the profile
    let profile = {
        let profiles = state.profiles.lock().await;
        profiles
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .ok_or_else(|| AppError::ProfileError(format!("Profile not found: {profile_id}")))?
    };

    // ── Phase 1: Prepare connection — extract channels BEFORE handshake ──
    // This is critical: `check_server_key` runs inside `russh::client::connect`
    // and blocks the handshake until the user responds. If we don't wire up the
    // HK bridge first, the response channel is never reachable → deadlock.
    let (session_id, handshake_handle, channels) = session::prepare_connection(&profile);

    // Notify: Connecting (with real session ID — available before handshake now)
    let _ = on_event.send(SessionStateEvent::StateChanged {
        session_id,
        state: SessionState::Connecting,
    });

    // Store the response sender BEFORE the handshake so `respond_host_key_verification`
    // can find it when `check_server_key` fires during `russh::client::connect`.
    {
        let mut pending = pending_hk().lock().await;
        pending.insert(session_id, channels.hk_response_tx);
    }

    // Spawn the HK request watcher BEFORE the handshake — it must be ready to
    // receive the request that `check_server_key` sends during the handshake.
    let on_event_clone = on_event.clone();
    let hk_session_id = session_id;
    let hk_task = tokio::spawn(async move {
        match channels.hk_request_rx.await {
            Ok(mut request) => {
                request.session_id = Some(hk_session_id);
                let _ = on_event_clone.send(SessionStateEvent::HostKeyVerification(request));
            }
            Err(_) => {
                // Channel was dropped — key was already trusted (no dialog needed)
            }
        }
    });

    // ── Phase 2: TCP + SSH handshake (triggers check_server_key) ────
    let handshake_result = session::do_handshake(handshake_handle, &profile).await;

    // If handshake failed, clean up HK state and propagate error
    let mut handle = match handshake_result {
        Ok(h) => h,
        Err(err) => {
            // Clean up pending HK entry + watcher task
            {
                let mut pending = pending_hk().lock().await;
                pending.remove(&session_id);
            }
            hk_task.abort();

            let _ = on_event.send(SessionStateEvent::StateChanged {
                session_id,
                state: SessionState::Error {
                    message: err.to_string(),
                },
            });

            tracing::warn!(
                "Session {session_id} handshake failed for {}:{} — {err}",
                profile.host,
                profile.port
            );

            return Err(err);
        }
    };

    // ── Phase 3: Authentication ─────────────────────────────
    // Handshake succeeded (host key verified). Clean up HK state — it's no
    // longer needed and must not linger if auth fails and we retry.
    {
        let mut pending = pending_hk().lock().await;
        pending.remove(&session_id);
    }
    hk_task.abort();

    let auth_result: Result<(), AppError> = async {
        // Resolve authentication method (pass vault reference for credential lookup)
        let vault_guard = state.vault.lock().await;
        let vault_ref = vault_guard.as_ref();
        let auth_method = session::resolve_auth_method(&profile, password.as_ref().map(|z| z.as_str()), vault_ref)?;
        drop(vault_guard);

        match auth_method {
            Some(auth) => {
                // Notify: Authenticating
                let _ = on_event.send(SessionStateEvent::StateChanged {
                    session_id,
                    state: SessionState::Authenticating,
                });

                // Authenticate
                session::authenticate(&mut handle, auth).await?;
            }
            None => {
                // Need user input for password/passphrase — return error
                // (frontend should prompt and retry)
                return Err(AppError::AuthFailed(
                    "Password or passphrase required — please provide credentials".to_string(),
                ));
            }
        }

        Ok(())
    }
    .await;

    // ── Handle auth failure: disconnect and propagate error ──────
    if let Err(err) = auth_result {
        // Notify frontend about the error state
        let _ = on_event.send(SessionStateEvent::StateChanged {
            session_id,
            state: SessionState::Error {
                message: err.to_string(),
            },
        });

        // Disconnect the SSH handle to release resources
        session::disconnect(&mut handle).await.ok();

        tracing::warn!(
            "Session {session_id} auth failed for {}:{} — cleaned up: {err}",
            profile.host,
            profile.port
        );

        return Err(err);
    }

    // ── Success path ─────────────────────────────────────────────

    // Notify: Connected
    let _ = on_event.send(SessionStateEvent::StateChanged {
        session_id,
        state: SessionState::Connected,
    });

    // Store session in AppState
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id, handle);
    }

    // Spawn a watcher for server-initiated disconnects.
    // When the SSH handler's `disconnected()` fires, we update session state
    // and notify the frontend so the UI doesn't stay stuck in "connected".
    let sessions_arc = Arc::clone(&state.sessions);
    let on_event_disconnect = on_event.clone();
    tokio::spawn(async move {
        match channels.disconnect_rx.await {
            Ok(reason) => {
                tracing::warn!(
                    "Session {session_id}: server-initiated disconnect detected: {reason}"
                );

                // Update session state to Disconnected
                let mut sessions = sessions_arc.lock().await;
                if let Some(session) = sessions.get_mut(&session_id) {
                    // Cancel all session tasks (tunnels, keepalive, etc.)
                    session.cancel_token.cancel();
                    session.state = SessionState::Disconnected;
                    session.ssh_handle.take(); // Drop the dead SSH handle
                }

                // Notify frontend
                let _ = on_event_disconnect.send(SessionStateEvent::StateChanged {
                    session_id,
                    state: SessionState::Disconnected,
                });
            }
            Err(_) => {
                // Sender dropped without sending — this happens during normal
                // client-initiated disconnect (session::disconnect drops the handle
                // which drops the handler which drops the sender). Not an error.
            }
        }
    });

    tracing::info!("Session {session_id} connected to {}:{}", profile.host, profile.port);

    Ok(session_id)
}

#[tauri::command]
pub async fn disconnect(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let handle = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    session::disconnect(handle).await?;

    // Remove from session map
    sessions.remove(&session_id);

    tracing::info!("Session {session_id} disconnected");

    Ok(())
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<SessionInfo>, AppError> {
    let sessions = state.sessions.lock().await;

    let infos: Vec<SessionInfo> = sessions
        .values()
        .map(|h| SessionInfo {
            id: h.id,
            profile_name: h.profile.name.clone(),
            host: format!("{}:{}", h.profile.host, h.profile.port),
            state: h.state.clone(),
            terminal_count: h.terminals.len(),
            has_sftp: h.sftp.is_some(),
            tunnel_count: h.tunnels.len(),
        })
        .collect();

    Ok(infos)
}

#[tauri::command]
pub async fn get_session_state(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<SessionState, AppError> {
    let sessions = state.sessions.lock().await;
    let handle = sessions
        .get(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;
    Ok(handle.state.clone())
}

#[tauri::command]
pub async fn respond_host_key_verification(
    session_id: SessionId,
    response: HostKeyVerificationResponse,
) -> Result<(), AppError> {
    let tx = {
        let mut pending = pending_hk().lock().await;
        pending.remove(&session_id)
    };

    if let Some(tx) = tx {
        tx.send(response).map_err(|_| {
            AppError::Other("Host key verification channel already closed".to_string())
        })?;
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "No pending host key verification for session {session_id}"
        )))
    }
}

// ─── Test Connection ────────────────────────────────────

/// Minimal SSH handler that auto-accepts all host keys.
/// Used exclusively by `test_connection` to avoid triggering the
/// host key verification dialog flow.
struct TestConnectionHandler;

#[async_trait::async_trait]
impl russh::client::Handler for TestConnectionHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Auto-accept for test — we only care about reachability + auth
        Ok(true)
    }
}

/// Test connection timeout (seconds)
const TEST_CONNECTION_TIMEOUT_SECS: u64 = 10;

#[tauri::command]
pub async fn test_connection(
    host: String,
    port: u16,
    username: String,
    auth_method_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
) -> Result<String, AppError> {
    use crate::profile::{AuthMethodConfig, ConnectionProfile};

    let password: Option<Zeroizing<String>> = password.map(Zeroizing::new);

    // Build auth config from the raw form values
    let auth_method = match auth_method_type.as_str() {
        "publicKey" => AuthMethodConfig::PublicKey {
            private_key_path: private_key_path.unwrap_or_default(),
            passphrase_in_keychain: false,
        },
        _ => AuthMethodConfig::Password,
    };

    // Build a temporary profile (not persisted)
    let profile = ConnectionProfile {
        id: Uuid::nil(),
        name: String::new(),
        host: host.clone(),
        port,
        username: username.clone(),
        auth_method,
        startup_directory: None,
        tunnels: vec![],
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };

    // ── TCP + SSH handshake with auto-accept host key handler ──
    let config = russh::client::Config {
        ..Default::default()
    };
    let addr = (host.as_str(), port);

    let mut ssh_handle = tokio::time::timeout(
        Duration::from_secs(TEST_CONNECTION_TIMEOUT_SECS),
        russh::client::connect(Arc::new(config), addr, TestConnectionHandler),
    )
    .await
    .map_err(|_| AppError::ConnectionTimeout)?
    .map_err(AppError::Ssh)?;

    // ── Resolve auth method and authenticate ──
    // test_connection uses a temp profile — no vault lookup needed (password always explicit)
    let auth = session::resolve_auth_method(&profile, password.as_ref().map(|z| z.as_str()), None)?;

    let result: Result<String, AppError> = match auth {
        Some(session::AuthMethod::Password(pw)) => {
            let authenticated = ssh_handle
                .authenticate_password(&username, &pw)
                .await
                .map_err(AppError::Ssh)?;
            if authenticated {
                Ok("Connection successful".to_string())
            } else {
                Err(AppError::AuthFailed(format!(
                    "Server rejected authentication for user '{username}'"
                )))
            }
        }
        Some(session::AuthMethod::PublicKey { key }) => {
            let arc_key = Arc::new(*key);
            let authenticated = ssh_handle
                .authenticate_publickey(&username, arc_key)
                .await
                .map_err(AppError::Ssh)?;
            if authenticated {
                Ok("Connection successful".to_string())
            } else {
                Err(AppError::AuthFailed(format!(
                    "Server rejected public key for user '{username}'"
                )))
            }
        }
        None => Err(AppError::AuthFailed(
            "Password or passphrase required".to_string(),
        )),
    };

    // ── Always disconnect cleanly ──
    let _ = ssh_handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    result
}
