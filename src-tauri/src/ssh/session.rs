// ssh/session.rs — SSH session manager: connect, auth, disconnect, keepalive
//
// Manages the SSH connection lifecycle and state transitions.
// Each session is tracked via SessionHandle in AppState.
//
// State machine: Disconnected → Connecting → Authenticating → Connected → Disconnected
// Error states can transition to Disconnected via disconnect/retry.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::AppError;
use crate::profile::{AuthMethodConfig, ConnectionProfile, UserCredential};
use crate::ssh::handler::SshClientHandler;
use crate::ssh::keys;
use crate::state::{
    AutoLockState, HostKeyVerificationRequest, HostKeyVerificationResponse, SessionHandle,
    SessionState,
};

/// Default connection timeout
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Keepalive interval
const KEEPALIVE_INTERVAL_SECS: u64 = 30;
/// Max consecutive keepalive failures (handled by russh internally)
const MAX_KEEPALIVE_FAILURES: usize = 3;

/// Build the shared russh client configuration used by every connection path
/// (interactive `do_handshake` and `test_connection`).
///
/// Keepalive is the reason this is centralized: without it, a TCP connection
/// silently broken by a NAT timeout, a dropped VPN, or a proxy that GC's idle
/// flows leaves the SSH session looking "connected" while the peer is gone.
/// russh sends a keepalive every `KEEPALIVE_INTERVAL_SECS` and tears the session
/// down after `MAX_KEEPALIVE_FAILURES` unanswered probes, so dead connections are
/// detected promptly instead of hanging until the next write. Both code paths
/// MUST share these settings — that is the whole point of this function.
pub(crate) fn build_client_config() -> russh::client::Config {
    russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(KEEPALIVE_INTERVAL_SECS)),
        keepalive_max: MAX_KEEPALIVE_FAILURES,
        ..Default::default()
    }
}

/// Authentication method for runtime use (not persisted)
pub enum AuthMethod {
    /// Plaintext password held in `Zeroizing` so it is wiped from the heap when
    /// the auth attempt completes (success or failure) and the value is dropped.
    Password(zeroize::Zeroizing<String>),
    PublicKey {
        key: Box<ssh_key::PrivateKey>,
    },
}

// ─── Connect ────────────────────────────────────────────

/// Opaque handle consumed by `do_handshake` — holds the handler and internal
/// state that the command layer doesn't need direct access to.
pub struct HandshakeHandle {
    session_id: Uuid,
    cancel_token: CancellationToken,
    handler: SshClientHandler,
    remote_fwd_registry: crate::ssh::tunnel::RemoteForwardRegistry,
}

/// Channels extracted from the handler that the command layer wires up
/// BEFORE the handshake begins.
pub struct ConnectionChannels {
    pub hk_request_rx: tokio::sync::oneshot::Receiver<HostKeyVerificationRequest>,
    pub hk_response_tx: tokio::sync::oneshot::Sender<HostKeyVerificationResponse>,
    pub disconnect_rx: tokio::sync::oneshot::Receiver<String>,
}

/// Phase 1: Create the handler, channels, and session ID — but do NOT connect yet.
///
/// Returns `(session_id, handshake_handle, channels)`.
///
/// The caller MUST wire up the host key verification bridge (store the
/// `hk_response_tx` in the pending map and spawn the HK-request watcher)
/// BEFORE calling `do_handshake`. Otherwise `check_server_key` will block
/// forever waiting for a response that nobody can deliver.
pub fn prepare_connection(
    profile: &ConnectionProfile,
) -> (Uuid, HandshakeHandle, ConnectionChannels) {
    let session_id = Uuid::new_v4();
    let cancel_token = CancellationToken::new();

    let (handler, hk_request_rx, hk_response_tx, remote_fwd_registry, disconnect_rx) =
        SshClientHandler::new(profile.host.clone(), profile.port);

    let handshake = HandshakeHandle {
        session_id,
        cancel_token,
        handler,
        remote_fwd_registry,
    };

    let channels = ConnectionChannels {
        hk_request_rx,
        hk_response_tx,
        disconnect_rx,
    };

    (session_id, handshake, channels)
}

/// Phase 2: Execute TCP + SSH handshake (including host key verification).
///
/// **Prerequisite**: The host key verification bridge must be wired up before
/// calling this. `check_server_key` runs inside `russh::client::connect` and
/// will block the handshake until the user responds via the oneshot channel.
pub async fn do_handshake(
    handshake: HandshakeHandle,
    profile: &ConnectionProfile,
) -> Result<SessionHandle, AppError> {
    let config = build_client_config();

    let addr = (profile.host.as_str(), profile.port);

    let ssh_handle = tokio::time::timeout(
        Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        russh::client::connect(Arc::new(config), addr, handshake.handler),
    )
    .await
    .map_err(|_| AppError::ConnectionTimeout)?
    .map_err(AppError::Ssh)?;

    let handle = SessionHandle {
        id: handshake.session_id,
        profile: profile.clone(),
        // Placeholder values — set by the connect command after user resolution
        user_id: Uuid::nil(),
        username: String::new(),
        state: SessionState::Connecting,
        ssh_handle: Some(ssh_handle),
        terminals: HashMap::new(),
        sftp: None,
        tunnels: HashMap::new(),
        keepalive_task: None,
        cancel_token: handshake.cancel_token,
        remote_forward_registry: Some(handshake.remote_fwd_registry),
    };

    Ok(handle)
}

// ─── Authenticate ───────────────────────────────────────

/// Authenticate an established SSH session.
/// The session must be in Connecting or Authenticating state.
///
/// `username` is the SSH username from the resolved `UserCredential` — no longer
/// read from `handle.profile` since profiles now have multiple users.
pub async fn authenticate(
    handle: &mut SessionHandle,
    auth: AuthMethod,
    username: &str,
) -> Result<(), AppError> {
    let ssh = handle.ssh_handle.as_mut().ok_or(AppError::NotConnected)?;

    handle.state = SessionState::Authenticating;

    let authenticated = match auth {
        AuthMethod::Password(password) => ssh
            .authenticate_password(username, &*password)
            .await
            .map_err(AppError::Ssh)?,
        AuthMethod::PublicKey { key } => {
            let arc_key = Arc::new(*key);
            ssh.authenticate_publickey(username, arc_key)
                .await
                .map_err(AppError::Ssh)?
        }
    };

    if authenticated {
        handle.state = SessionState::Connected;
        Ok(())
    } else {
        handle.state = SessionState::Error {
            message: "Authentication failed".to_string(),
        };
        Err(AppError::AuthFailed(format!(
            "Server rejected authentication for user '{username}'"
        )))
    }
}

/// Read a stored credential for auth, routing through
/// [`crate::commands::vault::get_credential_for_auth`] when an `auto_lock`
/// recorder is present so a genuine read resets the idle timer. When no
/// recorder is supplied (callers that never auto-lock, e.g. `test_connection`),
/// it falls back to the plain read.
fn read_vault_credential(
    vault: &crate::vault::Vault,
    auto_lock: Option<&AutoLockState>,
    profile_id: &Uuid,
    user_id: Option<&Uuid>,
    credential_type: &str,
) -> Result<Option<zeroize::Zeroizing<String>>, AppError> {
    match auto_lock {
        Some(al) => crate::commands::vault::get_credential_for_auth(
            vault,
            al,
            profile_id,
            user_id,
            credential_type,
        ),
        None => crate::commands::vault::get_credential_from_vault(
            vault,
            profile_id,
            user_id,
            credential_type,
        ),
    }
}

/// Resolve the auth method from a user credential, fetching credentials as needed.
/// Returns None if the password/passphrase needs to be prompted from the user.
///
/// `user` is the resolved `UserCredential` from the profile's `users` array.
/// `profile_id` is needed for vault key construction.
///
/// `auto_lock`, when supplied, has its idle timer reset on a genuine stored-
/// credential read so an actively-connecting user is not auto-locked mid-use.
/// It is `None` for callers that never read the vault (e.g. `test_connection`).
///
/// Priority order:
/// 1. Explicitly provided password/passphrase (from connect command)
/// 2. Encrypted vault lookup
pub fn resolve_auth_method(
    user: &UserCredential,
    profile_id: &Uuid,
    password: Option<&str>,
    vault: Option<&crate::vault::Vault>,
    auto_lock: Option<&AutoLockState>,
) -> Result<Option<AuthMethod>, AppError> {
    match &user.auth_method {
        AuthMethodConfig::Password => {
            // Prefer explicitly-provided password
            if let Some(pw) = password {
                return Ok(Some(AuthMethod::Password(zeroize::Zeroizing::new(
                    pw.to_string(),
                ))));
            }
            // Fall back to vault. A successful read resets the idle timer (only
            // an actual hit counts as use — see `get_credential_for_auth`).
            if let Some(v) = vault {
                if let Some(stored) =
                    read_vault_credential(v, auto_lock, profile_id, Some(&user.id), "password")?
                {
                    return Ok(Some(AuthMethod::Password(stored)));
                }
            }
            // Need to prompt
            Ok(None)
        }
        AuthMethodConfig::PublicKey {
            private_key_path,
            passphrase_in_keychain,
        } => {
            let path = std::path::PathBuf::from(shellexpand::tilde(private_key_path).to_string());

            // Try loading without passphrase first
            match keys::load_private_key(&path, None) {
                Ok(key) => Ok(Some(AuthMethod::PublicKey { key: Box::new(key) })),
                Err(_) => {
                    // Key is encrypted — prefer explicitly-provided passphrase
                    if let Some(pp) = password {
                        let key = keys::load_private_key(&path, Some(pp))?;
                        return Ok(Some(AuthMethod::PublicKey { key: Box::new(key) }));
                    }
                    // Fall back to vault passphrase. A successful read resets the
                    // idle timer (only an actual hit counts as use).
                    if *passphrase_in_keychain {
                        if let Some(v) = vault {
                            if let Some(passphrase) = read_vault_credential(
                                v,
                                auto_lock,
                                profile_id,
                                Some(&user.id),
                                "passphrase",
                            )? {
                                // `passphrase` is a `Zeroizing<String>`; pass it as
                                // `&str` (deref coercion does not reach through
                                // `Option`, so call `.as_str()` explicitly), then
                                // drop it so the plaintext is wiped from the heap
                                // immediately after the key is decrypted.
                                let key = keys::load_private_key(&path, Some(passphrase.as_str()))?;
                                drop(passphrase);
                                return Ok(Some(AuthMethod::PublicKey { key: Box::new(key) }));
                            }
                        }
                    }
                    // Need to prompt for passphrase
                    Ok(None)
                }
            }
        }
        AuthMethodConfig::KeyboardInteractive => {
            // Keyboard-interactive requires dynamic prompts — not implemented in MVP
            Err(AppError::AuthFailed(
                "Keyboard-interactive auth not yet implemented".to_string(),
            ))
        }
    }
}

// ─── Disconnect ─────────────────────────────────────────

/// Cleanly disconnect a session, closing all channels and releasing resources.
pub async fn disconnect(handle: &mut SessionHandle) -> Result<(), AppError> {
    // Cancel all background tasks (keepalive, tunnel listeners, etc.)
    handle.cancel_token.cancel();

    // Close all terminals — send Close command then drop the sender.
    // The reader task owns the SSH channel and will close it upon receiving Close
    // or when the sender is dropped.
    for (_, terminal) in handle.terminals.drain() {
        // Best-effort send — if channel is full or task already exited, that's fine
        let _ = terminal
            .command_tx
            .try_send(crate::state::TerminalCommand::Close);
        // Drop the sender — this also signals the reader task to exit if Close didn't
        drop(terminal.command_tx);
        // Abort the reader task as a safety net (in case it's stuck in SSH wait)
        if let Some(task) = terminal.reader_task {
            task.abort();
        }
    }

    // Close SFTP session if open
    if let Some(sftp) = handle.sftp.take() {
        drop(sftp);
    }

    // Close all tunnel handles
    for (_, tunnel) in handle.tunnels.drain() {
        tunnel.cancel_token.cancel();
        if let Some(task) = tunnel.task {
            task.abort();
        }
    }

    // Cancel keepalive task
    if let Some(task) = handle.keepalive_task.take() {
        task.abort();
    }

    // Disconnect SSH session
    if let Some(ssh) = handle.ssh_handle.take() {
        let _ = ssh
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }

    handle.state = SessionState::Disconnected;

    Ok(())
}

// ─── Keepalive ──────────────────────────────────────────
//
// Keepalive is handled by russh internally via Config.keepalive_interval
// and Config.keepalive_max. When MAX_KEEPALIVE_FAILURES consecutive keepalives
// fail, russh disconnects the session and calls handler.disconnected().
// No manual keepalive loop is needed.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_client_config_sets_keepalive_interval() {
        let config = build_client_config();
        assert_eq!(
            config.keepalive_interval,
            Some(Duration::from_secs(KEEPALIVE_INTERVAL_SECS))
        );
    }

    #[test]
    fn build_client_config_sets_keepalive_max() {
        let config = build_client_config();
        assert_eq!(config.keepalive_max, MAX_KEEPALIVE_FAILURES);
    }

    #[test]
    fn build_client_config_is_idempotent() {
        // Two invocations must produce structurally identical keepalive settings.
        // `russh::client::Config` does not derive `PartialEq`, so we compare the
        // fields the builder is responsible for — the single source of truth here.
        let a = build_client_config();
        let b = build_client_config();
        assert_eq!(a.keepalive_interval, b.keepalive_interval);
        assert_eq!(a.keepalive_max, b.keepalive_max);
    }
}
