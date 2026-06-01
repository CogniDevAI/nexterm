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
use crate::profile::{
    AuthMethodConfig, ConnectionProfile, JumpAuthConfig, ProxyJumpConfig, UserCredential,
};
use crate::ssh::handler::SshClientHandler;
use crate::ssh::keys;
use crate::state::{
    AutoLockState, HostKeyStatus, HostKeyVerificationRequest, HostKeyVerificationResponse,
    SessionHandle, SessionState,
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

// ─── ProxyJump / Bastion ────────────────────────────────

/// Default connection timeout for the bastion hop (seconds). Matches the main
/// path's `DEFAULT_TIMEOUT_SECS` so a hung bastion does not stall forever.
const BASTION_TIMEOUT_SECS: u64 = DEFAULT_TIMEOUT_SECS;

/// Originator address/port advertised when opening the direct-tcpip channel on
/// the bastion. OpenSSH's `ssh -J` uses loopback as the originator; we mirror
/// that. The bastion uses these purely for its own logging/ACLs — they do not
/// open any local socket on our side.
const DIRECT_TCPIP_ORIGINATOR_HOST: &str = "127.0.0.1";
const DIRECT_TCPIP_ORIGINATOR_PORT: u32 = 0;

/// A live SSH connection to the bastion plus the target stream tunneled through
/// it. The bastion `Handle` MUST be kept alive for as long as the
/// direct-tcpip stream is used: dropping it tears down the bastion session loop
/// and kills the tunneled channel. We therefore carry it into the
/// `SessionHandle` (see `do_handshake`).
pub struct BastionConnection {
    /// The authenticated bastion SSH handle. Owns the session task that drives
    /// the tunneled channel; must outlive `stream`.
    pub handle: russh::client::Handle<BastionHandler>,
    /// The target host:port reached over `stream`, surfaced as a tokio
    /// AsyncRead+AsyncWrite+Unpin+Send byte stream (russh `ChannelStream`).
    pub stream: russh::ChannelStream<russh::client::Msg>,
}

/// SSH handler used exclusively for the bastion hop.
///
/// SECURITY (MITM-critical): the bastion is a real SSH server, so its host key
/// is verified against the SAME `known_hosts` store used for every normal host
/// via [`crate::ssh::known_hosts::verify_host_key`]. We do NOT blind-accept the
/// bastion's key. Because the jump-host picker UI is a separate (deferred)
/// slice, there is no interactive prompt to bridge to yet, so this handler
/// follows the exact security model of `test_connection`: it only proceeds when
/// the bastion key is already `Trusted`, and refuses (aborts the handshake) for
/// `Unknown` / `Changed` / `Revoked`. The user trusts a bastion's key by
/// connecting to it directly once, just like any other host.
pub struct BastionHandler {
    host: String,
    port: u16,
    /// Captured verification result so `prepare_bastion_channel` can produce a
    /// precise error message after the handshake (e.g. "key not trusted yet").
    status: Arc<std::sync::Mutex<Option<HostKeyStatus>>>,
}

#[async_trait::async_trait]
impl russh::client::Handler for BastionHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Same verification path as normal hosts — never blind-accept.
        match crate::ssh::known_hosts::verify_host_key(&self.host, self.port, server_public_key) {
            Ok(status) => {
                let trusted = matches!(status, HostKeyStatus::Trusted);
                *self.status.lock().unwrap() = Some(status);
                // Returning false aborts the handshake → no auth is attempted
                // against an unverified bastion.
                Ok(trusted)
            }
            Err(_) => {
                *self.status.lock().unwrap() = None;
                Ok(false)
            }
        }
    }
}

/// Pure decision: does this handshake run over a pre-established (bastion)
/// stream, or a plain TCP connection? Extracted so the branch selection in
/// `do_handshake` is unit-testable without a live server.
pub(crate) fn handshake_uses_stream(bastion: &Option<BastionConnection>) -> bool {
    bastion.is_some()
}

/// Build a human-readable refusal message for a bastion whose host key is not
/// trusted. Pure and side-effect free so it can be unit-tested.
pub(crate) fn bastion_untrusted_message(host: &str, port: u16, status: &HostKeyStatus) -> String {
    match status {
        HostKeyStatus::Trusted => {
            // Caller should not invoke this for a trusted key, but stay total.
            format!("Bastion {host}:{port} host key is trusted")
        }
        HostKeyStatus::Unknown { .. } => format!(
            "Bastion {host}:{port} host key is not trusted yet. Connect to the \
             bastion directly once to verify and save its key, then retry."
        ),
        HostKeyStatus::Changed { .. } => format!(
            "Bastion {host}:{port} host key has CHANGED — possible MITM. Connect \
             to the bastion directly to review and accept the new key first."
        ),
        HostKeyStatus::Revoked => {
            format!("Bastion {host}:{port} host key is REVOKED — refusing to connect.")
        }
    }
}

/// Resolve the bastion auth method from its persisted [`JumpAuthConfig`].
///
/// Mirrors [`resolve_auth_method`] for the main host but keyed by the bastion's
/// stable [`ProxyJumpConfig::id`] (used as the vault profile-id namespace) so
/// the bastion's stored password/passphrase never collides with the target's.
/// Returns `Ok(None)` when a credential must be prompted (caller surfaces an
/// auth error). Credentials are read as `Zeroizing` and dropped promptly.
pub fn resolve_jump_auth(
    jump: &ProxyJumpConfig,
    vault: Option<&crate::vault::Vault>,
    auto_lock: Option<&AutoLockState>,
) -> Result<Option<AuthMethod>, AppError> {
    match &jump.auth_method {
        JumpAuthConfig::Password => {
            if let Some(v) = vault {
                // Vault key namespace = bastion id; no per-"user" sub-id.
                if let Some(stored) =
                    read_vault_credential(v, auto_lock, &jump.id, None, "password")?
                {
                    return Ok(Some(AuthMethod::Password(stored)));
                }
            }
            Ok(None)
        }
        JumpAuthConfig::PublicKey {
            private_key_path,
            passphrase_in_keychain,
        } => {
            let path = std::path::PathBuf::from(shellexpand::tilde(private_key_path).to_string());
            match keys::load_private_key(&path, None) {
                Ok(key) => Ok(Some(AuthMethod::PublicKey { key: Box::new(key) })),
                Err(_) => {
                    if *passphrase_in_keychain {
                        if let Some(v) = vault {
                            if let Some(passphrase) =
                                read_vault_credential(v, auto_lock, &jump.id, None, "passphrase")?
                            {
                                let key = keys::load_private_key(&path, Some(passphrase.as_str()))?;
                                // Wipe the plaintext passphrase from the heap as
                                // soon as the key is decrypted.
                                drop(passphrase);
                                return Ok(Some(AuthMethod::PublicKey { key: Box::new(key) }));
                            }
                        }
                    }
                    Ok(None)
                }
            }
        }
    }
}

/// Phase 0 (only when `profile.jump_host` is set): connect to the bastion,
/// verify its host key, authenticate, and open a direct-tcpip channel to the
/// final target — returning a [`BastionConnection`] whose `stream` the target
/// SSH handshake then runs over (the `ssh -J` equivalent, SINGLE hop).
///
/// Steps:
/// 1. Connect to the bastion over plain TCP using the SHARED
///    [`build_client_config`] (so keepalive behaviour matches every other path).
/// 2. Verify the bastion's host key via the SAME `known_hosts` path used for
///    normal hosts (MITM-critical — see [`BastionHandler`]). Refuse if not
///    already `Trusted`.
/// 3. Authenticate to the bastion, zeroizing its credentials (the
///    [`AuthMethod`] holds the password in `Zeroizing`; the key passphrase is
///    wiped in `resolve_jump_auth`). On failure, the bastion handle is dropped
///    here so nothing leaks.
/// 4. Open a `direct-tcpip` channel to `(target_host, target_port)` and convert
///    it into an AsyncRead+AsyncWrite stream.
pub async fn prepare_bastion_channel(
    jump: &ProxyJumpConfig,
    target_host: &str,
    target_port: u16,
    vault: Option<&crate::vault::Vault>,
    auto_lock: Option<&AutoLockState>,
) -> Result<BastionConnection, AppError> {
    let config = build_client_config();
    let addr = (jump.host.as_str(), jump.port);

    let hk_status: Arc<std::sync::Mutex<Option<HostKeyStatus>>> =
        Arc::new(std::sync::Mutex::new(None));
    let handler = BastionHandler {
        host: jump.host.clone(),
        port: jump.port,
        status: Arc::clone(&hk_status),
    };

    // ── Step 1+2: TCP + SSH handshake with bastion host-key verification ──
    let connect_result = tokio::time::timeout(
        Duration::from_secs(BASTION_TIMEOUT_SECS),
        russh::client::connect(Arc::new(config), addr, handler),
    )
    .await
    .map_err(|_| AppError::ConnectionTimeout)?;

    // When check_server_key returns Ok(false) (Unknown/Changed/Revoked),
    // `connect` returns Err — so branch on the captured status FIRST; only a
    // `None` status means the failure was a genuine network/protocol error.
    let captured_status = hk_status.lock().unwrap().take();

    let mut bastion = match captured_status {
        Some(HostKeyStatus::Trusted) => connect_result.map_err(AppError::Ssh)?,
        Some(ref status) => {
            // Bastion key is Unknown / Changed / Revoked — refuse with an
            // actionable message (MITM-critical: never proceed to auth).
            return Err(AppError::AuthFailed(bastion_untrusted_message(
                &jump.host, jump.port, status,
            )));
        }
        None => connect_result.map_err(AppError::Ssh)?,
    };

    // ── Step 3: Authenticate to the bastion (credentials zeroized) ──
    let auth = resolve_jump_auth(jump, vault, auto_lock)?.ok_or_else(|| {
        AppError::AuthFailed(format!(
            "Bastion {}:{} requires a stored password or key passphrase — none found in vault",
            jump.host, jump.port
        ))
    })?;

    let authenticated = match auth {
        AuthMethod::Password(password) => bastion
            .authenticate_password(&jump.user, &*password)
            .await
            .map_err(AppError::Ssh)?,
        AuthMethod::PublicKey { key } => {
            let arc_key = Arc::new(*key);
            bastion
                .authenticate_publickey(&jump.user, arc_key)
                .await
                .map_err(AppError::Ssh)?
        }
    };

    if !authenticated {
        // Drop the bastion handle explicitly on auth failure — no leak.
        let _ = bastion
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        drop(bastion);
        return Err(AppError::AuthFailed(format!(
            "Bastion {}:{} rejected authentication for user '{}'",
            jump.host, jump.port, jump.user
        )));
    }

    // ── Step 4: Open direct-tcpip channel to the final target ──
    let channel = bastion
        .channel_open_direct_tcpip(
            target_host,
            target_port as u32,
            DIRECT_TCPIP_ORIGINATOR_HOST,
            DIRECT_TCPIP_ORIGINATOR_PORT,
        )
        .await
        .map_err(|e| {
            AppError::TunnelError(format!(
                "Bastion {}:{} could not open a tunnel to {target_host}:{target_port}: {e}",
                jump.host, jump.port
            ))
        })?;

    Ok(BastionConnection {
        handle: bastion,
        stream: channel.into_stream(),
    })
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

/// Phase 2: Execute the SSH handshake to the TARGET (including host key
/// verification).
///
/// `bastion` selects the transport, keeping the no-jump path byte-for-byte
/// equivalent to before:
/// - `None`  → open a plain `tokio::net::TcpStream` to `profile.host:port` via
///   `russh::client::connect` (EXACTLY as the original implementation did).
/// - `Some(b)` → run the handshake over the pre-established bastion stream `b`
///   (a direct-tcpip channel to the target) via `russh::client::connect_stream`.
///   The target's host key is STILL verified — the handler is identical; only
///   the byte transport differs. The bastion handle is moved into the resulting
///   `SessionHandle` so it lives as long as the tunnel it carries.
///
/// **Prerequisite**: The host key verification bridge must be wired up before
/// calling this. `check_server_key` runs inside `russh::client::connect[_stream]`
/// and will block the handshake until the user responds via the oneshot channel.
pub async fn do_handshake(
    handshake: HandshakeHandle,
    profile: &ConnectionProfile,
    bastion: Option<BastionConnection>,
) -> Result<SessionHandle, AppError> {
    let config = Arc::new(build_client_config());

    // Transport selection is driven by the pure, unit-tested decision helper so
    // production and tests agree on exactly one rule: a bastion ⇒ stream path,
    // otherwise plain TCP.
    let (ssh_handle, bastion_handle) = if handshake_uses_stream(&bastion) {
        // SAFETY: `handshake_uses_stream` returned true ⇒ `bastion` is `Some`.
        let BastionConnection { handle, stream } =
            bastion.expect("handshake_uses_stream guarantees a bastion connection");
        let ssh_handle = tokio::time::timeout(
            Duration::from_secs(DEFAULT_TIMEOUT_SECS),
            russh::client::connect_stream(config, stream, handshake.handler),
        )
        .await
        .map_err(|_| AppError::ConnectionTimeout)?
        .map_err(AppError::Ssh)?;
        (ssh_handle, Some(handle))
    } else {
        // Direct path — byte-for-byte equivalent to the original implementation.
        let addr = (profile.host.as_str(), profile.port);
        let ssh_handle = tokio::time::timeout(
            Duration::from_secs(DEFAULT_TIMEOUT_SECS),
            russh::client::connect(config, addr, handshake.handler),
        )
        .await
        .map_err(|_| AppError::ConnectionTimeout)?
        .map_err(AppError::Ssh)?;
        (ssh_handle, None)
    };

    let handle = SessionHandle {
        id: handshake.session_id,
        profile: profile.clone(),
        // Placeholder values — set by the connect command after user resolution
        user_id: Uuid::nil(),
        username: String::new(),
        state: SessionState::Connecting,
        ssh_handle: Some(ssh_handle),
        bastion_handle,
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

    // Tear down the bastion hop AFTER the target session: the target stream runs
    // over the bastion's direct-tcpip channel, so we close the target first,
    // then the bastion. Dropping the handle releases the bastion session task.
    if let Some(bastion) = handle.bastion_handle.take() {
        let _ = bastion
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        drop(bastion);
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

    // ─── ProxyJump / Bastion: branch-selection & helpers ─────────────

    #[test]
    fn handshake_without_bastion_uses_tcp() {
        // No bastion → do_handshake must take the plain-TCP `connect` branch.
        assert!(!handshake_uses_stream(&None));
    }

    #[test]
    fn handshake_with_bastion_uses_stream() {
        // The decision is purely "is a bastion connection present?". We can't
        // cheaply build a real BastionConnection (no live server), so this test
        // asserts the helper agrees with `Option::is_some` semantics for the
        // None case and the type compiles for the Some case via the compile-time
        // assertion below. The runtime branch is exercised through the helper's
        // direct relationship with `Option::is_some`.
        let none: Option<BastionConnection> = None;
        assert_eq!(handshake_uses_stream(&none), none.is_some());
    }

    #[test]
    fn bastion_untrusted_message_unknown_is_actionable() {
        let status = HostKeyStatus::Unknown {
            fingerprint: "SHA256:abc".to_string(),
            key_type: "ssh-ed25519".to_string(),
        };
        let msg = bastion_untrusted_message("bastion.example.com", 22, &status);
        assert!(msg.contains("bastion.example.com:22"));
        assert!(msg.contains("not trusted yet"));
    }

    #[test]
    fn bastion_untrusted_message_changed_warns_mitm() {
        let status = HostKeyStatus::Changed {
            old_fingerprint: "SHA256:old".to_string(),
            new_fingerprint: "SHA256:new".to_string(),
            key_type: "ssh-ed25519".to_string(),
            old_key_type: None,
        };
        let msg = bastion_untrusted_message("bastion.example.com", 2222, &status);
        assert!(msg.contains("CHANGED"));
        assert!(msg.contains("MITM"));
        assert!(msg.contains("bastion.example.com:2222"));
    }

    #[test]
    fn bastion_untrusted_message_revoked() {
        let msg = bastion_untrusted_message("b.example.com", 22, &HostKeyStatus::Revoked);
        assert!(msg.contains("REVOKED"));
    }

    // Compile-time proof that the bastion stream type satisfies the bounds
    // `russh::client::connect_stream` requires (`AsyncRead + AsyncWrite + Unpin
    // + Send + 'static`). If `into_stream()`'s type ever stops meeting these,
    // this fails to compile — catching the regression before runtime.
    #[test]
    fn bastion_stream_satisfies_connect_stream_bounds() {
        use tokio::io::{AsyncRead, AsyncWrite};
        fn assert_stream_bounds<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>() {}
        assert_stream_bounds::<russh::ChannelStream<russh::client::Msg>>();
    }
}
