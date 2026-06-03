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
use crate::profile::UserCredential;
use crate::ssh::session;
use crate::state::{
    AppState, HostKeyVerificationRequest, HostKeyVerificationResponse,
    KeyboardInteractiveChallengeRequest, KeyboardInteractiveResponse, SessionId, SessionInfo,
    SessionState,
};

// ─── Session State Event (streamed via Channel) ─────────

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SessionStateEvent {
    StateChanged {
        session_id: SessionId,
        state: SessionState,
    },
    HostKeyVerification(HostKeyVerificationRequest),
    KeyboardInteractiveChallenge(KeyboardInteractiveChallengeRequest),
}

// ─── Pending host key verifications ─────────────────────

/// We store the response_tx for pending host key verifications
/// keyed by session_id so the `respond_host_key_verification` command can find it.
type PendingVerifications = tokio::sync::Mutex<
    std::collections::HashMap<SessionId, oneshot::Sender<HostKeyVerificationResponse>>,
>;

/// Lazy-initialized global storage for pending host key verification channels.
/// This is necessary because the handler's oneshot bridge needs to be accessible
/// from the `respond_host_key_verification` command.
static PENDING_HK_VERIFICATIONS: std::sync::OnceLock<PendingVerifications> =
    std::sync::OnceLock::new();

fn pending_hk() -> &'static PendingVerifications {
    PENDING_HK_VERIFICATIONS
        .get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

// ─── Pending keyboard-interactive challenges ────────────

/// Per-session response sender for the CURRENT keyboard-interactive challenge
/// round. Mirrors `PendingVerifications`, but the value is re-armed for EACH
/// challenge round (the bridge's factory replaces the entry before emitting the
/// next challenge), since one MFA flow can pose several rounds.
///
/// Guarded by a *synchronous* `std::sync::Mutex` (not the tokio one used for
/// host keys): every critical section is a single HashMap insert/remove with no
/// `.await`, and — crucially — the bridge's response-receiver factory is a
/// synchronous `FnMut` that must arm a sender without being able to `.await` a
/// tokio lock. A std mutex is both correct and the only thing callable here.
type PendingKeyboardInteractiveResponses = std::sync::Mutex<
    std::collections::HashMap<SessionId, oneshot::Sender<KeyboardInteractiveResponse>>,
>;

/// Lazy-initialized global storage for the in-flight keyboard-interactive
/// response channel, keyed by session id. The auth loop arms a fresh sender per
/// round; `respond_keyboard_interactive_challenge` removes and fires it.
static PENDING_KI_RESPONSES: std::sync::OnceLock<PendingKeyboardInteractiveResponses> =
    std::sync::OnceLock::new();

fn pending_ki() -> &'static PendingKeyboardInteractiveResponses {
    PENDING_KI_RESPONSES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

// ─── Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    profile_id: Uuid,
    user_id: Option<Uuid>,
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

    // Resolve which user to connect as
    let resolved_user: UserCredential = match user_id {
        Some(uid) => profile
            .users
            .iter()
            .find(|u| u.id == uid)
            .cloned()
            .ok_or(AppError::UserNotFound(uid))?,
        None => {
            if profile.users.len() == 1 {
                profile.users[0].clone()
            } else {
                return Err(AppError::UserSelectionRequired);
            }
        }
    };

    // ── Phase 0: Bastion / jump host (ssh -J equivalent, SINGLE hop) ──
    // When the profile carries a jump_host, reach the target THROUGH the
    // bastion: connect to the bastion, verify ITS host key against known_hosts
    // (MITM-critical — never blind-accept), authenticate (credentials zeroized),
    // and open a direct-tcpip channel to the target. The resulting stream is
    // handed to `do_handshake`, which then runs the TARGET SSH handshake over it
    // (target host-key verification still applies). On any bastion-phase failure
    // we surface a message that is clearly distinct from target-phase errors and
    // the bastion handle is dropped inside `prepare_bastion_channel`, so nothing
    // leaks. SCOPE: a single hop only — a bastion does not carry its own jump.
    let bastion: Option<session::BastionConnection> = match profile.jump_host.as_ref() {
        Some(jump) => {
            let vault_guard = state.vault.lock().await;
            let vault_ref = vault_guard.as_ref();
            let result = session::prepare_bastion_channel(
                jump,
                &profile.host,
                profile.port,
                vault_ref,
                Some(&state.auto_lock),
            )
            .await;
            drop(vault_guard);

            match result {
                Ok(conn) => Some(conn),
                Err(err) => {
                    // Phase 0 fails BEFORE a session id exists, so there is no
                    // StateChanged event to emit (the frontend has no session to
                    // key it to). Return a bastion-tagged error that is clearly
                    // distinct from a target-phase failure.
                    tracing::warn!(
                        "Bastion phase failed for {}:{} (target {}:{}) — {err}",
                        jump.host,
                        jump.port,
                        profile.host,
                        profile.port
                    );
                    return Err(AppError::AuthFailed(format!(
                        "Bastion connection failed: {err}"
                    )));
                }
            }
        }
        None => None,
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

    // ── Phase 2: SSH handshake to the TARGET (triggers check_server_key) ──
    // When `bastion` is Some, the handshake runs over the bastion's
    // direct-tcpip stream and the bastion handle is moved into the resulting
    // SessionHandle. If the target handshake fails, the consumed
    // BastionConnection is dropped here (inside do_handshake), tearing down the
    // bastion hop — no leak.
    let handshake_result = session::do_handshake(handshake_handle, &profile, bastion).await;

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

    // Store resolved user info in the session handle
    handle.user_id = resolved_user.id;
    handle.username = resolved_user.username.clone();

    // ── Keyboard-interactive (MFA) bridge ──────────────────────────
    // Built up front so it can be handed to `authenticate`. It only does work if
    // the resolved method is keyboard-interactive; otherwise the request channel
    // is simply never used. The bridge mirrors the host-key oneshot pattern but
    // for MULTIPLE challenge rounds: an mpsc carries each round's challenge to
    // this command, which forwards it to the frontend as a
    // `KeyboardInteractiveChallenge` event, and a per-round oneshot (armed by the
    // factory below, stored in `pending_ki`) carries the answers back.
    let (ki_request_tx, mut ki_request_rx) =
        tokio::sync::mpsc::channel::<KeyboardInteractiveChallengeRequest>(1);

    // Factory: arm a fresh response oneshot for the NEXT round, store its sender
    // in the pending map keyed by session id, return the receiver to the bridge.
    let ki_session_id = session_id;
    let ki_response_factory = Box::new(move || {
        let (tx, rx) = oneshot::channel::<KeyboardInteractiveResponse>();
        // Synchronous std-mutex insert — no `.await`, safe inside this FnMut.
        pending_ki().lock().unwrap().insert(ki_session_id, tx);
        rx
    });

    let ki_bridge = session::KeyboardInteractiveBridge::new(ki_request_tx, ki_response_factory);

    // Forward each emitted challenge to the frontend (injecting the session id
    // so the dialog can respond without awaiting the connect promise — mirrors
    // the host-key request watcher). Lives until the bridge's request sender is
    // dropped (end of the auth block).
    let on_event_ki = on_event.clone();
    let ki_forward_task = tokio::spawn(async move {
        while let Some(mut request) = ki_request_rx.recv().await {
            request.session_id = Some(ki_session_id);
            let _ = on_event_ki.send(SessionStateEvent::KeyboardInteractiveChallenge(request));
        }
    });

    let auth_result: Result<(), AppError> = async {
        // Resolve authentication method (pass vault reference for credential
        // lookup). The `auto_lock` reference lets `resolve_auth_method` reset the
        // idle timer on a genuine stored-credential read, so a user who is
        // actively (re)connecting with vault credentials is not auto-locked
        // mid-use — which would make the next connection needing a stored
        // credential hit `VaultLocked`.
        let vault_guard = state.vault.lock().await;
        let vault_ref = vault_guard.as_ref();
        let auth_method = session::resolve_auth_method(
            &resolved_user,
            &profile.id,
            password.as_ref().map(|z| z.as_str()),
            vault_ref,
            Some(&state.auto_lock),
        )?;
        drop(vault_guard);

        match auth_method {
            Some(auth) => {
                // Notify: Authenticating
                let _ = on_event.send(SessionStateEvent::StateChanged {
                    session_id,
                    state: SessionState::Authenticating,
                });

                // Authenticate with the resolved user's username. The KI bridge
                // is consumed here; the password/public-key paths ignore it.
                session::authenticate(&mut handle, auth, &resolved_user.username, Some(ki_bridge))
                    .await?;
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

    // ── Tear down the keyboard-interactive bridge ───────────────────
    // The bridge (and its request sender) was moved into `authenticate`, so by
    // here the auth attempt has finished and the sender is dropped: the forward
    // task's `recv()` loop will end on its own. Abort it as a safety net and drop
    // any still-armed per-round response sender so no entry lingers between
    // connection attempts (the answers themselves were already zeroized inside
    // the auth loop).
    ki_forward_task.abort();
    pending_ki().lock().unwrap().remove(&session_id);

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

    tracing::info!(
        "Session {session_id} connected to {}:{}",
        profile.host,
        profile.port
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: SessionId) -> Result<(), AppError> {
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
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, AppError> {
    let sessions = state.sessions.lock().await;

    let infos: Vec<SessionInfo> = sessions
        .values()
        .map(|h| SessionInfo {
            id: h.id,
            profile_name: h.profile.name.clone(),
            host: format!("{}:{}", h.profile.host, h.profile.port),
            user_id: h.user_id,
            username: h.username.clone(),
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

/// Deliver the user's answers for the in-flight keyboard-interactive challenge
/// round back to the awaiting auth loop. Mirrors `respond_host_key_verification`,
/// but the response carrier holds the per-prompt answers.
///
/// SECURITY: the answers are NOT logged here (nor anywhere). They flow straight
/// into the oneshot the auth loop awaits, which wraps them in `Zeroizing`.
#[tauri::command]
pub async fn respond_keyboard_interactive_challenge(
    session_id: SessionId,
    responses: KeyboardInteractiveResponse,
) -> Result<(), AppError> {
    // Remove the armed sender for THIS round (std-mutex; no `.await` held).
    let tx = pending_ki().lock().unwrap().remove(&session_id);

    if let Some(tx) = tx {
        tx.send(responses).map_err(|_| {
            AppError::KeyboardInteractive(
                "keyboard-interactive challenge channel already closed".to_string(),
            )
        })?;
        Ok(())
    } else {
        Err(AppError::KeyboardInteractive(format!(
            "no pending keyboard-interactive challenge for session {session_id}"
        )))
    }
}

// ─── SSH Key Discovery ──────────────────────────────────────

#[tauri::command]
pub fn list_ssh_keys() -> Result<Vec<crate::ssh::keys::KeyInfo>, AppError> {
    crate::ssh::keys::list_available_keys()
}

// ─── Test Connection ────────────────────────────────────

use crate::state::HostKeyStatus;
use serde::Serialize;

/// Serializable result returned by `test_connection`.
/// The frontend uses `authenticated` to decide whether to save credentials.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    /// True only if the credential was actually validated against the server.
    pub authenticated: bool,
    /// Host-key verification outcome: "trusted" | "unknown" | "changed" | "revoked".
    pub host_key: String,
    /// Human-readable summary.
    pub message: String,
}

/// Map a HostKeyStatus to its wire-format label string.
/// Pure and side-effect free — tested in unit tests below.
fn host_key_label(status: &HostKeyStatus) -> &'static str {
    match status {
        HostKeyStatus::Trusted => "trusted",
        HostKeyStatus::Unknown { .. } => "unknown",
        HostKeyStatus::Changed { .. } => "changed",
        HostKeyStatus::Revoked => "revoked",
    }
}

/// `test_connection` may send credentials ONLY to an already-trusted host.
/// Pure, side-effect-free decision gate so it can be unit-tested in isolation.
fn may_authenticate(status: &HostKeyStatus) -> bool {
    matches!(status, HostKeyStatus::Trusted)
}

/// SSH handler used exclusively by `test_connection`.
///
/// Unlike the interactive flow, it never prompts the user. Instead it verifies
/// the server's key against known_hosts and captures the result so the command
/// can refuse to authenticate against any host that is not already `Trusted`.
struct TestConnectionHandler {
    host: String,
    port: u16,
    /// Captured verification result (shared so `test_connection` can read it
    /// after the handshake completes). `None` means verification could not run
    /// (e.g. the handshake failed before/at key check).
    status: std::sync::Arc<std::sync::Mutex<Option<HostKeyStatus>>>,
}

#[async_trait::async_trait]
impl russh::client::Handler for TestConnectionHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Verify against known_hosts. We do NOT prompt and we do NOT save keys
        // here — test_connection must never authenticate to an unverified host.
        match crate::ssh::known_hosts::verify_host_key(&self.host, self.port, server_public_key) {
            Ok(status) => {
                let allow = may_authenticate(&status);
                *self.status.lock().unwrap() = Some(status);
                // Returning false aborts the handshake → no auth is ever attempted.
                Ok(allow)
            }
            Err(_) => {
                *self.status.lock().unwrap() = None;
                Ok(false)
            }
        }
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
) -> Result<TestConnectionResult, AppError> {
    use crate::profile::{AuthMethodConfig, UserCredential};

    let password: Option<Zeroizing<String>> = password.map(Zeroizing::new);

    // Build auth config from the raw form values
    let auth_method = match auth_method_type.as_str() {
        "publicKey" => AuthMethodConfig::PublicKey {
            private_key_path: private_key_path.unwrap_or_default(),
            passphrase_in_keychain: false,
        },
        _ => AuthMethodConfig::Password,
    };

    // Build a temporary UserCredential for auth resolution
    let temp_user = UserCredential {
        id: Uuid::nil(),
        username: username.clone(),
        auth_method,
        is_default: true,
    };
    let temp_profile_id = Uuid::nil();

    // ── TCP + SSH handshake with a known_hosts-verifying handler ──
    // The handler captures the verification result; we inspect it AFTER the
    // handshake to decide whether sending credentials is safe.
    // Share the exact same client config (incl. keepalive) as the interactive
    // path — see `session::build_client_config` for why keepalive matters.
    let config = session::build_client_config();
    let addr = (host.as_str(), port);

    let hk_status: Arc<std::sync::Mutex<Option<HostKeyStatus>>> =
        Arc::new(std::sync::Mutex::new(None));
    let handler = TestConnectionHandler {
        host: host.clone(),
        port,
        status: Arc::clone(&hk_status),
    };

    let connect_result = tokio::time::timeout(
        Duration::from_secs(TEST_CONNECTION_TIMEOUT_SECS),
        russh::client::connect(Arc::new(config), addr, handler),
    )
    .await
    .map_err(|_| AppError::ConnectionTimeout)?;

    // Take the captured verification status BEFORE interpreting connect_result.
    // When check_server_key returns Ok(false) (Unknown/Changed), `connect`
    // returns Err — so we must branch on the captured status first; only a
    // `None` status means the failure was a genuine network/protocol error.
    let captured_status = hk_status.lock().unwrap().take();

    let mut ssh_handle = match captured_status {
        // Host key verified and trusted → handshake succeeded, proceed to auth.
        Some(HostKeyStatus::Trusted) => connect_result.map_err(AppError::Ssh)?,
        // Reachable but not yet trusted → never send credentials.
        Some(ref status @ HostKeyStatus::Unknown { .. }) => {
            return Ok(TestConnectionResult {
                authenticated: false,
                host_key: host_key_label(status).to_string(),
                message: "Host reachable, but its host key is not trusted yet. \
                    Connect once to verify and save the key, then test credentials."
                    .to_string(),
            });
        }
        // Key changed → possible MITM → refuse, surface as structured result.
        Some(ref status @ HostKeyStatus::Changed { .. }) => {
            return Ok(TestConnectionResult {
                authenticated: false,
                host_key: host_key_label(status).to_string(),
                message: "Host key has CHANGED — possible MITM. \
                    Connect to review and explicitly accept the new key first."
                    .to_string(),
            });
        }
        // Revoked key → refuse outright.
        Some(ref status @ HostKeyStatus::Revoked) => {
            return Ok(TestConnectionResult {
                authenticated: false,
                host_key: host_key_label(status).to_string(),
                message: "Host key is REVOKED.".to_string(),
            });
        }
        // No status captured → check_server_key never produced a result, so the
        // failure is a genuine network/protocol error. Preserve existing handling.
        None => connect_result.map_err(AppError::Ssh)?,
    };

    // ── Resolve auth method and authenticate ──
    // test_connection uses a temp user — no vault lookup needed (password always
    // explicit), so no vault and no auto-lock recorder are passed.
    let auth = session::resolve_auth_method(
        &temp_user,
        &temp_profile_id,
        password.as_ref().map(|z| z.as_str()),
        None,
        None,
    )?;

    let result: Result<TestConnectionResult, AppError> = match auth {
        Some(session::AuthMethod::Password(pw)) => {
            let authenticated = ssh_handle
                .authenticate_password(&username, &*pw)
                .await
                .map_err(AppError::Ssh)?;
            if authenticated {
                Ok(TestConnectionResult {
                    authenticated: true,
                    host_key: "trusted".to_string(),
                    message: "Connection successful".to_string(),
                })
            } else {
                Ok(TestConnectionResult {
                    authenticated: false,
                    host_key: "trusted".to_string(),
                    message: format!("Server rejected authentication for user '{username}'"),
                })
            }
        }
        Some(session::AuthMethod::PublicKey { key }) => {
            let arc_key = Arc::new(*key);
            let authenticated = ssh_handle
                .authenticate_publickey(&username, arc_key)
                .await
                .map_err(AppError::Ssh)?;
            if authenticated {
                Ok(TestConnectionResult {
                    authenticated: true,
                    host_key: "trusted".to_string(),
                    message: "Connection successful".to_string(),
                })
            } else {
                Ok(TestConnectionResult {
                    authenticated: false,
                    host_key: "trusted".to_string(),
                    message: format!("Server rejected public key for user '{username}'"),
                })
            }
        }
        // `test_connection` builds its auth config from raw form values that map
        // only to Password / PublicKey, so resolve_auth_method never returns
        // KeyboardInteractive here. There is also no challenge dialog to drive in
        // a one-shot test. Surface that clearly instead of leaving the match
        // non-total.
        Some(session::AuthMethod::KeyboardInteractive(_)) => Err(AppError::KeyboardInteractive(
            "keyboard-interactive auth cannot be tested non-interactively".to_string(),
        )),
        // `test_connection` builds its auth config from raw form values that map
        // only to Password / PublicKey, so resolve_auth_method never returns
        // Agent here. Refuse explicitly (mirrors the KeyboardInteractive arm)
        // rather than leaving the match non-total — agent auth is exercised
        // through the live connect path, not the one-shot tester.
        Some(session::AuthMethod::Agent { .. }) => Err(AppError::Agent(
            "SSH agent auth cannot be tested non-interactively".to_string(),
        )),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::HostKeyStatus;

    #[test]
    fn may_authenticate_allows_trusted() {
        assert!(may_authenticate(&HostKeyStatus::Trusted));
    }

    #[test]
    fn may_authenticate_refuses_unknown() {
        let status = HostKeyStatus::Unknown {
            fingerprint: "SHA256:abc".to_string(),
            key_type: "ssh-ed25519".to_string(),
        };
        assert!(!may_authenticate(&status));
    }

    #[test]
    fn may_authenticate_refuses_changed_same_key_type() {
        // old_key_type: None → genuine fingerprint change on the same algorithm
        let status = HostKeyStatus::Changed {
            old_fingerprint: "SHA256:old".to_string(),
            new_fingerprint: "SHA256:new".to_string(),
            key_type: "ssh-ed25519".to_string(),
            old_key_type: None,
        };
        assert!(!may_authenticate(&status));
    }

    #[test]
    fn may_authenticate_refuses_changed_different_key_type() {
        // old_key_type: Some(..) → algorithm changed; still treated as a key change
        let status = HostKeyStatus::Changed {
            old_fingerprint: "SHA256:old".to_string(),
            new_fingerprint: "SHA256:new".to_string(),
            key_type: "ssh-ed25519".to_string(),
            old_key_type: Some("ssh-rsa".to_string()),
        };
        assert!(!may_authenticate(&status));
    }

    // ── host_key_label tests (RED until helper is added) ──────────────────

    #[test]
    fn host_key_label_trusted() {
        assert_eq!(host_key_label(&HostKeyStatus::Trusted), "trusted");
    }

    #[test]
    fn host_key_label_unknown() {
        let status = HostKeyStatus::Unknown {
            fingerprint: "SHA256:abc".to_string(),
            key_type: "ssh-ed25519".to_string(),
        };
        assert_eq!(host_key_label(&status), "unknown");
    }

    #[test]
    fn host_key_label_changed() {
        let status = HostKeyStatus::Changed {
            old_fingerprint: "SHA256:old".to_string(),
            new_fingerprint: "SHA256:new".to_string(),
            key_type: "ssh-ed25519".to_string(),
            old_key_type: None,
        };
        assert_eq!(host_key_label(&status), "changed");
    }

    #[test]
    fn host_key_label_revoked() {
        assert_eq!(host_key_label(&HostKeyStatus::Revoked), "revoked");
    }
}
