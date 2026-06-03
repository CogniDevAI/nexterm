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
    KeyboardInteractiveChallengeRequest, KeyboardInteractivePrompt, KeyboardInteractiveResponse,
    SessionHandle, SessionState,
};

/// Default connection timeout
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Keepalive interval
const KEEPALIVE_INTERVAL_SECS: u64 = 30;
/// Max consecutive keepalive failures (handled by russh internally)
const MAX_KEEPALIVE_FAILURES: usize = 3;

/// Maximum number of keyboard-interactive challenge rounds we will service for a
/// single authentication attempt. RFC 4256 lets a server send an unbounded
/// stream of `SSH_MSG_USERAUTH_INFO_REQUEST` messages; a malicious or
/// misbehaving server could exploit that to loop forever, pinning the
/// connection task and repeatedly prompting the user. We cap it so the flow
/// always terminates. 5 rounds comfortably covers real MFA stacks
/// (password + OTP + push confirmation, with retries) while denying an infinite
/// challenge loop.
pub(crate) const MAX_KEYBOARD_INTERACTIVE_ROUNDS: u32 = 5;

/// How long we wait for the frontend to deliver the user's answers to a single
/// keyboard-interactive challenge before giving up. Without this, a user who
/// closes the dialog (or a frontend that never responds) would leave the
/// connection task awaiting the oneshot forever. The host-key bridge can block
/// indefinitely because that dialog has explicit Accept/Reject buttons that
/// always fire; an MFA prompt has no guaranteed terminal action, so we bound it.
const KEYBOARD_INTERACTIVE_RESPONSE_TIMEOUT_SECS: u64 = 120;

/// Pure decision: is `round` within the keyboard-interactive round budget?
///
/// `round` is 1-based (the first challenge is round 1). Returns `true` while we
/// are still allowed to service the challenge, `false` once the cap is exceeded.
/// Extracted as a pure function so the cap is unit-testable without a server.
pub(crate) fn ki_round_allowed(round: u32) -> bool {
    round <= MAX_KEYBOARD_INTERACTIVE_ROUNDS
}

/// Pure transform: build a [`KeyboardInteractiveChallengeRequest`] for the
/// frontend from the raw fields russh surfaces in
/// `KeyboardInteractiveAuthResponse::InfoRequest` (russh `Prompt` has fields
/// `prompt: String` and `echo: bool`). `session_id` is left `None` here and
/// injected by the connect command before the event is forwarded, mirroring the
/// host-key bridge. Side-effect free so it is unit-testable.
pub(crate) fn extract_challenge_request(
    name: String,
    instruction: String,
    prompts: &[russh::client::Prompt],
    round: u32,
) -> KeyboardInteractiveChallengeRequest {
    KeyboardInteractiveChallengeRequest {
        session_id: None,
        name,
        instruction,
        prompts: prompts
            .iter()
            .map(|p| KeyboardInteractivePrompt {
                text: p.prompt.clone(),
                echo: p.echo,
            })
            .collect(),
        round,
    }
}

/// Pure validation: the number of answers MUST equal the number of prompts the
/// server posed. russh's `authenticate_keyboard_interactive_respond` documents
/// that the response count must match the prompt count, and submitting the wrong
/// number corrupts the auth exchange. We reject the mismatch with a precise
/// error BEFORE touching the network. Side-effect free for unit testing.
///
/// NOTE: the error message intentionally carries ONLY the counts — never any
/// answer content — so it is safe to log/propagate.
pub(crate) fn validate_ki_responses(
    prompt_count: usize,
    response_count: usize,
) -> Result<(), AppError> {
    if prompt_count == response_count {
        Ok(())
    } else {
        Err(AppError::KeyboardInteractive(format!(
            "expected {prompt_count} answer(s) for the challenge, got {response_count}"
        )))
    }
}

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

    // russh 0.50 auth methods return AuthResult; .success() converts to bool.
    let authenticated = match auth {
        AuthMethod::Password(password) => bastion
            .authenticate_password(&jump.user, &*password)
            .await
            .map_err(AppError::Ssh)?
            .success(),
        AuthMethod::PublicKey { key } => {
            let arc_key = Arc::new(*key);
            // Negotiate the best RSA hash the bastion accepts (see
            // `resolve_rsa_hash_alg`). Ignored for Ed25519/ECDSA keys.
            let hash_alg = resolve_rsa_hash_alg(&bastion).await?;
            let key_with_alg = russh::keys::PrivateKeyWithHashAlg::new(arc_key, hash_alg);
            bastion
                .authenticate_publickey(&jump.user, key_with_alg)
                .await
                .map_err(AppError::Ssh)?
                .success()
        }
        // `resolve_jump_auth` only ever yields Password / PublicKey
        // (`JumpAuthConfig` has no keyboard-interactive variant), so this arm is
        // unreachable in practice. Bastions also have no frontend bridge to drive
        // an MFA dialog yet (the jump-host picker is a deferred slice). Refuse
        // explicitly rather than panic.
        AuthMethod::KeyboardInteractive(_) => {
            return Err(AppError::KeyboardInteractive(
                "keyboard-interactive auth is not supported for the bastion hop".to_string(),
            ));
        }
        // `resolve_jump_auth` only ever yields Password / PublicKey
        // (`JumpAuthConfig` has no agent variant), so this arm is unreachable in
        // practice. The bastion picker that would let a user choose agent auth
        // for the jump host is a deferred frontend slice. Refuse explicitly
        // rather than panic, mirroring the keyboard-interactive arm above.
        AuthMethod::Agent { .. } => {
            return Err(AppError::Agent(
                "SSH agent auth is not supported for the bastion hop".to_string(),
            ));
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
        key: Box<russh::keys::PrivateKey>,
    },
    /// Keyboard-interactive (MFA). Carries no secret: the answers are gathered
    /// per challenge round from the frontend through the
    /// [`KeyboardInteractiveBridge`]. The `String` is the SSH username (kept for
    /// symmetry with the other variants / clearer matching at the call site).
    KeyboardInteractive(String),
    /// SSH agent auth. Carries NO key material — only an optional pin
    /// (`key_id`) used to narrow to one agent identity. The running agent
    /// performs all signing during `authenticate`; the private key never leaves
    /// the agent process. See [`authenticate_agent`].
    Agent {
        key_id: Option<String>,
    },
}

// ─── SSH Agent ──────────────────────────────────────────

/// Upper bound on how many agent identities we will attempt during a single
/// authentication. Each attempt is a full publickey round-trip; an agent
/// stuffed with hundreds of keys could otherwise blow past the server's
/// `MaxAuthTries` (locking us out) and waste time. 16 comfortably covers a real
/// developer's key set while bounding the work. OpenSSH applies a similar
/// practical limit via `MaxAuthTries` on the server side.
pub(crate) const MAX_AGENT_IDENTITIES: usize = 16;

/// Pure predicate: does agent identity `key` match the profile-pinned `pin`?
///
/// A pin matches when it equals EITHER the key's SHA-256 fingerprint
/// (`SHA256:...`, computed via the same [`crate::ssh::known_hosts::fingerprint`]
/// the rest of the app uses, so the user can paste a fingerprint they already
/// saw) OR the key's comment. An empty/whitespace pin never matches anything —
/// otherwise a blank pin would silently latch onto the first comment-less key.
/// Side-effect free so identity selection is unit-testable without a live agent.
pub(crate) fn agent_pin_matches(key: &russh::keys::ssh_key::PublicKey, pin: &str) -> bool {
    let pin = pin.trim();
    if pin.is_empty() {
        return false;
    }
    if crate::ssh::known_hosts::fingerprint(key) == pin {
        return true;
    }
    let comment = key.comment();
    !comment.is_empty() && comment == pin
}

/// Pure selection: from the agent's reported `identities`, choose which ones to
/// attempt, in order.
///
/// - No `pin` → try every identity OpenSSH-style, capped at
///   [`MAX_AGENT_IDENTITIES`].
/// - `Some(pin)` → restrict to the identities whose fingerprint/comment matches
///   the pin (normally exactly one; the cap still applies defensively). An empty
///   result means the pinned key is not loaded in the agent — the caller turns
///   that into a precise error.
///
/// Returns borrowed references (no key cloning) so the auth loop can hand each
/// `PublicKey` to russh. Side-effect free for unit testing.
pub(crate) fn select_agent_identities<'a>(
    identities: &'a [russh::keys::ssh_key::PublicKey],
    pin: Option<&str>,
) -> Vec<&'a russh::keys::ssh_key::PublicKey> {
    identities
        .iter()
        .filter(|key| match pin {
            Some(p) => agent_pin_matches(key, p),
            None => true,
        })
        .take(MAX_AGENT_IDENTITIES)
        .collect()
}

/// Bridge that drives the keyboard-interactive challenge/response loop between
/// the session auth code (which talks to russh) and the frontend (which collects
/// the user's MFA answers). It mirrors the host-key oneshot bridge, but because
/// a server may pose SEVERAL challenge rounds the request side is an `mpsc` and
/// each round gets its own response `oneshot` (created by `next_response`).
///
/// SECURITY: answers returned by `challenge` are wrapped in `Zeroizing` so the
/// plaintext is wiped from the heap as soon as the auth loop drops them; this
/// type never logs answer content.
pub struct KeyboardInteractiveBridge {
    /// Emits each round's challenge to the command layer, which forwards it to
    /// the frontend as a `SessionStateEvent` and arms the matching response
    /// receiver.
    request_tx: tokio::sync::mpsc::Sender<KeyboardInteractiveChallengeRequest>,
    /// Produces the receiver for the NEXT round's answers. The command layer
    /// stores the paired sender in its pending map keyed by session id, so
    /// `respond_keyboard_interactive_challenge` can deliver the answers.
    response_rx_factory:
        Box<dyn FnMut() -> tokio::sync::oneshot::Receiver<KeyboardInteractiveResponse> + Send>,
}

impl KeyboardInteractiveBridge {
    /// Construct a bridge from the request sender and a factory that arms (and
    /// returns the receiver for) the next round's response oneshot.
    pub fn new(
        request_tx: tokio::sync::mpsc::Sender<KeyboardInteractiveChallengeRequest>,
        response_rx_factory: Box<
            dyn FnMut() -> tokio::sync::oneshot::Receiver<KeyboardInteractiveResponse> + Send,
        >,
    ) -> Self {
        Self {
            request_tx,
            response_rx_factory,
        }
    }

    /// Pose one challenge round to the frontend and await the answers.
    ///
    /// Emits `request` (the command layer forwards it as an event), arms a fresh
    /// per-round response receiver, and waits up to
    /// `KEYBOARD_INTERACTIVE_RESPONSE_TIMEOUT_SECS` for the user. The answers are
    /// returned wrapped in `Zeroizing` so the caller can hand them to russh and
    /// drop them immediately. Never logs answer content.
    async fn challenge(
        &mut self,
        request: KeyboardInteractiveChallengeRequest,
    ) -> Result<zeroize::Zeroizing<Vec<String>>, AppError> {
        // Arm the response receiver BEFORE emitting the request so the answer
        // can never race ahead of an armed receiver.
        let response_rx = (self.response_rx_factory)();

        self.request_tx.send(request).await.map_err(|_| {
            AppError::KeyboardInteractive(
                "challenge channel closed before the prompt could be delivered".to_string(),
            )
        })?;

        let response = tokio::time::timeout(
            Duration::from_secs(KEYBOARD_INTERACTIVE_RESPONSE_TIMEOUT_SECS),
            response_rx,
        )
        .await
        .map_err(|_| {
            AppError::KeyboardInteractive(
                "timed out waiting for the keyboard-interactive response".to_string(),
            )
        })?
        .map_err(|_| {
            AppError::KeyboardInteractive(
                "keyboard-interactive response channel dropped".to_string(),
            )
        })?;

        Ok(zeroize::Zeroizing::new(response.responses))
    }
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
        monitoring_task: None,
        cancel_token: handshake.cancel_token,
        remote_forward_registry: Some(handshake.remote_fwd_registry),
    };

    Ok(handle)
}

// ─── Authenticate ───────────────────────────────────────

/// Resolve the RSA signature hash algorithm to advertise for public-key auth,
/// based on what the server reports via the `server-sig-algs` extension.
///
/// `best_supported_rsa_hash()` returns `Result<Option<Option<HashAlg>>>`:
/// - `Some(Some(alg))` — server advertised server-sig-algs and supports a
///   modern rsa-sha2 variant (512 preferred, then 256). Use it as-is.
/// - `Some(None)` — server advertised server-sig-algs but supports ONLY the
///   legacy `ssh-rsa` (SHA-1). Honour the server's stated capability.
/// - `None` — server did NOT send the server-sig-algs extension, so we cannot
///   know. Rather than fall back to SHA-1 (which modern, SHA-1-disabled servers
///   reject outright), OPTIMISTICALLY try `rsa-sha2-256`: virtually every server
///   that omits the extension still accepts rsa-sha2-256, and SHA-1-disabled
///   servers reject the SHA-1 alternative anyway.
///
/// For Ed25519/ECDSA keys the returned value is ignored by
/// `PrivateKeyWithHashAlg::new`, so calling this unconditionally is safe.
pub(crate) async fn resolve_rsa_hash_alg<H: russh::client::Handler>(
    handle: &russh::client::Handle<H>,
) -> Result<Option<russh::keys::HashAlg>, AppError> {
    Ok(
        match handle
            .best_supported_rsa_hash()
            .await
            .map_err(AppError::Ssh)?
        {
            Some(inner) => inner,
            None => Some(russh::keys::HashAlg::Sha256),
        },
    )
}

/// Authenticate an established SSH session.
/// The session must be in Connecting or Authenticating state.
///
/// `username` is the SSH username from the resolved `UserCredential` — no longer
/// read from `handle.profile` since profiles now have multiple users.
///
/// `ki_bridge` is required ONLY for `AuthMethod::KeyboardInteractive`; it drives
/// the per-round challenge/response exchange with the frontend. For the password
/// and public-key paths it is ignored (pass `None`).
pub async fn authenticate(
    handle: &mut SessionHandle,
    auth: AuthMethod,
    username: &str,
    ki_bridge: Option<KeyboardInteractiveBridge>,
) -> Result<(), AppError> {
    let ssh = handle.ssh_handle.as_mut().ok_or(AppError::NotConnected)?;

    handle.state = SessionState::Authenticating;

    // russh 0.50 auth methods return AuthResult (not bool); .success() converts.
    let authenticated = match auth {
        AuthMethod::Password(password) => ssh
            .authenticate_password(username, &*password)
            .await
            .map_err(AppError::Ssh)?
            .success(),
        AuthMethod::PublicKey { key } => {
            let arc_key = Arc::new(*key);
            // Negotiate the best RSA hash the server accepts (see
            // `resolve_rsa_hash_alg`). For Ed25519/ECDSA keys the hash is
            // ignored by PrivateKeyWithHashAlg.
            let hash_alg = resolve_rsa_hash_alg(ssh).await?;
            let key_with_alg = russh::keys::PrivateKeyWithHashAlg::new(arc_key, hash_alg);
            ssh.authenticate_publickey(username, key_with_alg)
                .await
                .map_err(AppError::Ssh)?
                .success()
        }
        AuthMethod::KeyboardInteractive(ki_username) => {
            let bridge = ki_bridge.ok_or_else(|| {
                AppError::KeyboardInteractive(
                    "no challenge bridge supplied for keyboard-interactive auth".to_string(),
                )
            })?;
            authenticate_keyboard_interactive(ssh, &ki_username, bridge).await?
        }
        AuthMethod::Agent { key_id } => {
            authenticate_agent(ssh, username, key_id.as_deref()).await?
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

/// Run the keyboard-interactive (MFA) challenge/response loop against `ssh`.
///
/// Flow (RFC 4256, via russh 0.48.2's `Handle` API):
/// 1. `authenticate_keyboard_interactive_start(user, None)` initiates the method
///    and returns the FIRST `KeyboardInteractiveAuthResponse`.
/// 2. For each `InfoRequest { name, instructions, prompts }`: emit the challenge
///    to the frontend (via the bridge), await the answers, validate the answer
///    count against the prompt count, then submit them with
///    `authenticate_keyboard_interactive_respond(responses)`, which returns the
///    NEXT response (success, failure, or another `InfoRequest`).
/// 3. Repeat until `Success`/`Failure`, OR until the round cap is hit.
///
/// SECURITY:
/// - A MAX-ROUNDS CAP (`MAX_KEYBOARD_INTERACTIVE_ROUNDS`) bounds the loop so a
///   malicious server cannot drive an infinite `InfoRequest` storm.
/// - Answers arrive wrapped in `Zeroizing` and are dropped immediately after
///   russh consumes them (a `Zeroizing<Vec<String>>` zeroizes each `String`'s
///   heap buffer on drop). Answer CONTENT is never logged — only counts/rounds.
///
/// Returns `Ok(true)` on `Success`, `Ok(false)` on `Failure` (so the caller's
/// existing accepted/rejected handling applies uniformly).
async fn authenticate_keyboard_interactive(
    ssh: &mut russh::client::Handle<SshClientHandler>,
    username: &str,
    mut bridge: KeyboardInteractiveBridge,
) -> Result<bool, AppError> {
    use russh::client::KeyboardInteractiveAuthResponse as KiResponse;

    // Step 1: initiate. We advertise no submethods (let the server choose).
    let mut response = ssh
        .authenticate_keyboard_interactive_start(username.to_string(), None)
        .await
        .map_err(AppError::Ssh)?;

    let mut round: u32 = 0;

    loop {
        match response {
            KiResponse::Success => return Ok(true),
            // russh 0.50 adds remaining_methods to Failure; we ignore it since
            // the session-level auth retry logic lives in the frontend.
            KiResponse::Failure { .. } => return Ok(false),
            KiResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                round += 1;

                // Enforce the round cap BEFORE prompting the user again so a
                // malicious server cannot loop forever.
                if !ki_round_allowed(round) {
                    return Err(AppError::KeyboardInteractive(format!(
                        "server exceeded the maximum of {MAX_KEYBOARD_INTERACTIVE_ROUNDS} \
                         challenge rounds"
                    )));
                }

                let prompt_count = prompts.len();
                let request = extract_challenge_request(name, instructions, &prompts, round);

                // Ask the frontend; answers come back zeroized.
                let mut answers = bridge.challenge(request).await?;

                // Validate count BEFORE submitting (never send a malformed reply).
                validate_ki_responses(prompt_count, answers.len())?;

                // russh's `authenticate_keyboard_interactive_respond` takes the
                // responses by value. MOVE the inner Vec out of the Zeroizing
                // wrapper (via `mem::take`, leaving an empty Vec behind) so we do
                // NOT create a second plaintext copy on the heap. russh owns the
                // strings from here; it does not hand them back, so post-submit
                // zeroization of russh's copy is not possible at this layer — we
                // minimize the window by submitting immediately and never logging
                // the content. The now-empty `answers` is dropped right after.
                let to_submit: Vec<String> = std::mem::take(&mut *answers);
                drop(answers);
                let next = ssh
                    .authenticate_keyboard_interactive_respond(to_submit)
                    .await
                    .map_err(AppError::Ssh)?;

                response = next;
            }
        }
    }
}

/// Authenticate `ssh` using the local SSH agent.
///
/// Platform split (using russh-keys' OWN connectors so we never hand-roll the
/// agent protocol or guess socket layouts):
/// - **unix**: `AgentClient::connect_env()` reads `$SSH_AUTH_SOCK` and dials the
///   Unix-domain socket. A missing/empty env var or an unreachable socket yields
///   a clear [`AppError::Agent`] ("agent unavailable") rather than a raw IO error.
/// - **windows** (cfg-gated, thin — NOT compiled/tested on this macOS box): try
///   the default OpenSSH agent named pipe first, then fall back to Pageant.
///   `connect_named_pipe`/`connect_pageant` are russh-keys' own constructors, so
///   this stays minimal and correct by construction.
///
/// Each branch keeps the agent's CONCRETE stream type (unix `UnixStream`, windows
/// named-pipe/Pageant) and hands it to the shared, generic [`agent_authenticate`]
/// core. We deliberately do NOT erase it to `Box<dyn AgentStream>`: a boxed
/// trait object trips a higher-ranked `Send` bound when the resulting
/// `authenticate_publickey_with` future is awaited inside the (Send-required)
/// Tauri command, whereas a concrete `Send + 'static` stream monomorphizes
/// cleanly.
#[cfg(unix)]
async fn authenticate_agent(
    ssh: &mut russh::client::Handle<SshClientHandler>,
    username: &str,
    pin: Option<&str>,
) -> Result<bool, AppError> {
    let agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| {
            AppError::Agent(format!(
                "SSH agent unavailable (is ssh-agent running and SSH_AUTH_SOCK set?): {e}"
            ))
        })?;
    agent_authenticate(ssh, username, pin, agent).await
}

/// Windows agent path — thin, cfg-gated, NOT compile-verified on this macOS dev
/// box. Tries the default OpenSSH agent named pipe first, then Pageant. The two
/// connectors yield different concrete stream types, so each is driven through
/// the shared generic [`agent_authenticate`] core in its own branch.
#[cfg(windows)]
async fn authenticate_agent(
    ssh: &mut russh::client::Handle<SshClientHandler>,
    username: &str,
    pin: Option<&str>,
) -> Result<bool, AppError> {
    // Default Win32-OpenSSH agent pipe (same path OpenSSH for Windows uses).
    const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    match russh::keys::agent::client::AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE).await {
        Ok(agent) => agent_authenticate(ssh, username, pin, agent).await,
        Err(_) => {
            // Fall back to Pageant (PuTTY's agent). `connect_pageant` is
            // infallible in russh::keys (it constructs the stream lazily).
            let agent = russh::keys::agent::client::AgentClient::connect_pageant().await;
            agent_authenticate(ssh, username, pin, agent).await
        }
    }
}

/// Shared agent-auth core, generic over the agent's concrete stream `R`.
///
/// Flow (russh 0.50, merged russh-keys — no hand-rolled protocol):
/// 1. `request_identities()` — the agent reports its public keys. An empty list
///    is a precise error so the user knows to `ssh-add` a key.
/// 2. [`select_agent_identities`] picks which identities to try (all, capped, or
///    the single pinned one).
/// 3. For each selected identity, call
///    `handle.authenticate_publickey_with(user, key, &mut agent, hash_alg)`.
///    russh drives the sign round-trip THROUGH the agent — the private key NEVER
///    leaves the agent process. Stop at the first `Ok(true)`.
///
/// Returns `Ok(true)` on success, `Ok(false)` if every identity was rejected, so
/// the caller's uniform accepted/rejected handling applies. The signer's
/// `AgentAuthError` is mapped to [`AppError::Agent`].
async fn agent_authenticate<R>(
    ssh: &mut russh::client::Handle<SshClientHandler>,
    username: &str,
    pin: Option<&str>,
    mut agent: russh::keys::agent::client::AgentClient<R>,
) -> Result<bool, AppError>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Agent(format!("failed to list agent identities: {e}")))?;

    if identities.is_empty() {
        return Err(AppError::Agent(
            "no identities in agent — add a key with `ssh-add` first".to_string(),
        ));
    }

    let selected = select_agent_identities(&identities, pin);
    if selected.is_empty() {
        // A pin was set but no loaded identity matched it.
        return Err(AppError::Agent(format!(
            "pinned agent key '{}' is not loaded in the agent",
            pin.unwrap_or("")
        )));
    }

    // Resolve the RSA signature hash ONCE before the signing loop. Passing
    // `None` here would make the agent sign RSA keys with the legacy SHA-1 flag,
    // which SHA-1-disabled servers reject; `resolve_rsa_hash_alg` instead
    // advertises rsa-sha2 (see its doc). `best_supported_rsa_hash` borrows `&ssh`
    // only for this call, so there is no conflict with the `&mut agent` borrow
    // used inside the loop. For non-RSA agent keys the hash flag is ignored.
    let hash_alg = resolve_rsa_hash_alg(ssh).await?;

    // Try each selected identity until one is accepted (OpenSSH-style). The
    // `PublicKey` is cloned (cheap, public material only) because
    // `authenticate_publickey_with` takes it by value; the PRIVATE key stays in
    // the agent — russh asks the agent to sign via the `Signer` impl on
    // `AgentClient`, so no secret is ever extracted here.
    //
    // russh 0.50: authenticate_publickey_with takes an explicit hash_alg and
    // returns AuthResult instead of bool.
    for key in selected {
        match ssh
            .authenticate_publickey_with(username, key.clone(), hash_alg, &mut agent)
            .await
        {
            Ok(result) if result.success() => return Ok(true),
            Ok(_) => continue,
            Err(e) => return Err(AppError::Agent(format!("agent signing failed: {e}"))),
        }
    }

    Ok(false)
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
            // No stored secret to resolve: the answers are gathered per challenge
            // round from the frontend during `authenticate` via the
            // `KeyboardInteractiveBridge`. Carry the username so the auth loop can
            // initiate the exchange.
            Ok(Some(AuthMethod::KeyboardInteractive(user.username.clone())))
        }
        AuthMethodConfig::Agent { key_id } => {
            // No stored secret to resolve: the running ssh-agent holds the
            // private key(s) and signs during `authenticate`. Carry only the
            // optional pin used to narrow to one identity.
            Ok(Some(AuthMethod::Agent {
                key_id: key_id.clone(),
            }))
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

    // Abort monitoring sampler — MUST be explicit to prevent resource leak.
    // The monitoring task holds a reference to the session and runs an SSH channel;
    // if not aborted here, it would keep sampling until the CancellationToken fires,
    // but the SSH handle below is about to be dropped which would make it error-loop.
    if let Some(task) = handle.monitoring_task.take() {
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

    // ─── Keyboard-Interactive (MFA): pure cores ─────────────────────

    fn russh_prompt(text: &str, echo: bool) -> russh::client::Prompt {
        russh::client::Prompt {
            prompt: text.to_string(),
            echo,
        }
    }

    #[test]
    fn ki_round_allowed_within_cap() {
        // 1-based rounds 1..=MAX are allowed.
        assert!(ki_round_allowed(1));
        assert!(ki_round_allowed(MAX_KEYBOARD_INTERACTIVE_ROUNDS));
    }

    #[test]
    fn ki_round_allowed_rejects_past_cap() {
        // The round AFTER the cap must be refused — this is what stops an
        // infinite challenge loop from a malicious server.
        assert!(!ki_round_allowed(MAX_KEYBOARD_INTERACTIVE_ROUNDS + 1));
    }

    #[test]
    fn extract_challenge_maps_prompts_and_echo() {
        let prompts = vec![
            russh_prompt("Password:", false),
            russh_prompt("Username confirm:", true),
        ];
        let req =
            extract_challenge_request("PAM".to_string(), "Authenticate".to_string(), &prompts, 1);

        assert_eq!(req.name, "PAM");
        assert_eq!(req.instruction, "Authenticate");
        assert_eq!(req.round, 1);
        assert_eq!(req.session_id, None); // injected later by the connect command
        assert_eq!(req.prompts.len(), 2);
        assert_eq!(req.prompts[0].text, "Password:");
        assert!(!req.prompts[0].echo);
        assert_eq!(req.prompts[1].text, "Username confirm:");
        assert!(req.prompts[1].echo);
    }

    #[test]
    fn extract_challenge_handles_empty_prompts() {
        // A server may send an InfoRequest with zero prompts (informational).
        let req = extract_challenge_request(String::new(), String::new(), &[], 2);
        assert!(req.prompts.is_empty());
        assert_eq!(req.round, 2);
    }

    #[test]
    fn validate_ki_responses_accepts_matching_count() {
        assert!(validate_ki_responses(2, 2).is_ok());
        // Zero prompts ⇒ zero answers is valid.
        assert!(validate_ki_responses(0, 0).is_ok());
    }

    #[test]
    fn validate_ki_responses_rejects_too_few() {
        let err = validate_ki_responses(2, 1).unwrap_err();
        assert!(matches!(err, AppError::KeyboardInteractive(_)));
        // The error carries the counts only — never any answer content.
        let msg = err.to_string();
        assert!(msg.contains('2'));
        assert!(msg.contains('1'));
    }

    #[test]
    fn validate_ki_responses_rejects_too_many() {
        let err = validate_ki_responses(1, 3).unwrap_err();
        assert!(matches!(err, AppError::KeyboardInteractive(_)));
    }

    #[test]
    fn resolve_auth_method_returns_keyboard_interactive() {
        use crate::profile::{AuthMethodConfig, UserCredential};
        let user = UserCredential {
            id: Uuid::nil(),
            username: "alice".to_string(),
            auth_method: AuthMethodConfig::KeyboardInteractive,
            is_default: true,
        };
        let resolved =
            resolve_auth_method(&user, &Uuid::nil(), None, None, None).expect("must resolve");
        match resolved {
            Some(AuthMethod::KeyboardInteractive(name)) => assert_eq!(name, "alice"),
            _ => panic!("expected KeyboardInteractive auth method carrying the username"),
        }
    }

    // ─── SSH Agent: pure cores ──────────────────────────────────────

    /// Build a deterministic Ed25519 public key from a fixed seed (real crypto,
    /// reproducible) — mirrors the known_hosts test helper.
    fn agent_pubkey(seed: [u8; 32]) -> russh::keys::ssh_key::PublicKey {
        use russh::keys::ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey};
        use russh::keys::ssh_key::public::Ed25519PublicKey;
        let private = Ed25519PrivateKey::from_bytes(&seed);
        let keypair = Ed25519Keypair::from(private);
        russh::keys::ssh_key::PublicKey::from(Ed25519PublicKey::from(&keypair))
    }

    #[test]
    fn agent_pin_matches_by_fingerprint() {
        let key = agent_pubkey([3u8; 32]);
        let fp = crate::ssh::known_hosts::fingerprint(&key);
        assert!(agent_pin_matches(&key, &fp));
        // A different fingerprint must NOT match.
        assert!(!agent_pin_matches(&key, "SHA256:definitely-not-it"));
    }

    #[test]
    fn agent_pin_matches_by_comment() {
        let mut key = agent_pubkey([4u8; 32]);
        key.set_comment("my-laptop@host");
        assert!(agent_pin_matches(&key, "my-laptop@host"));
        assert!(!agent_pin_matches(&key, "some-other-comment"));
    }

    #[test]
    fn agent_pin_matches_empty_comment_never_matches_empty_pin() {
        // A key with no comment must not be matched by an empty/whitespace pin —
        // that would silently pin "the first key with a blank comment".
        let key = agent_pubkey([5u8; 32]);
        assert_eq!(key.comment(), "");
        assert!(!agent_pin_matches(&key, ""));
        assert!(!agent_pin_matches(&key, "   "));
    }

    #[test]
    fn select_identities_no_pin_returns_all_capped() {
        // No pin → try every identity, in agent order, up to the cap.
        let keys: Vec<russh::keys::ssh_key::PublicKey> =
            (0u8..3).map(|i| agent_pubkey([i; 32])).collect();
        let selected = select_agent_identities(&keys, None);
        assert_eq!(selected.len(), 3);
    }

    #[test]
    fn select_identities_caps_at_max() {
        // More identities than the cap → only the first MAX_AGENT_IDENTITIES are
        // tried, protecting against an agent stuffed with hundreds of keys
        // (each attempt is a network round-trip that can fail-count us out).
        let keys: Vec<russh::keys::ssh_key::PublicKey> = (0u8..(MAX_AGENT_IDENTITIES as u8 + 5))
            .map(|i| agent_pubkey([i; 32]))
            .collect();
        let selected = select_agent_identities(&keys, None);
        assert_eq!(selected.len(), MAX_AGENT_IDENTITIES);
    }

    #[test]
    fn select_identities_with_pin_returns_only_match() {
        let keys: Vec<russh::keys::ssh_key::PublicKey> =
            (10u8..14).map(|i| agent_pubkey([i; 32])).collect();
        let target_fp = crate::ssh::known_hosts::fingerprint(&keys[2]);
        let selected = select_agent_identities(&keys, Some(&target_fp));
        assert_eq!(selected.len(), 1);
        // The single selected identity must be the pinned one.
        assert_eq!(crate::ssh::known_hosts::fingerprint(selected[0]), target_fp);
    }

    #[test]
    fn select_identities_with_unmatched_pin_returns_empty() {
        // A pin that matches none of the agent's identities yields an empty set —
        // the caller turns that into a precise "pinned key not in agent" error.
        let keys: Vec<russh::keys::ssh_key::PublicKey> =
            (20u8..23).map(|i| agent_pubkey([i; 32])).collect();
        let selected = select_agent_identities(&keys, Some("SHA256:nope"));
        assert!(selected.is_empty());
    }

    #[test]
    fn resolve_auth_method_returns_agent_without_pin() {
        use crate::profile::{AuthMethodConfig, UserCredential};
        let user = UserCredential {
            id: Uuid::nil(),
            username: "bob".to_string(),
            auth_method: AuthMethodConfig::Agent { key_id: None },
            is_default: true,
        };
        let resolved =
            resolve_auth_method(&user, &Uuid::nil(), None, None, None).expect("must resolve");
        match resolved {
            Some(AuthMethod::Agent { key_id }) => assert_eq!(key_id, None),
            _ => panic!("expected Agent auth method"),
        }
    }

    #[test]
    fn resolve_auth_method_returns_agent_with_pin() {
        use crate::profile::{AuthMethodConfig, UserCredential};
        let user = UserCredential {
            id: Uuid::nil(),
            username: "bob".to_string(),
            auth_method: AuthMethodConfig::Agent {
                key_id: Some("SHA256:pinned".to_string()),
            },
            is_default: true,
        };
        let resolved =
            resolve_auth_method(&user, &Uuid::nil(), None, None, None).expect("must resolve");
        match resolved {
            Some(AuthMethod::Agent { key_id }) => {
                assert_eq!(key_id, Some("SHA256:pinned".to_string()));
            }
            _ => panic!("expected Agent auth method with pin"),
        }
    }

    // The bridge's challenge() round-trip is exercised without a network or a
    // real russh Handle: we drive both ends of the channels directly. This
    // proves the request is emitted, a fresh per-round receiver is armed, and the
    // answers come back wrapped in Zeroizing.
    #[tokio::test]
    async fn ki_bridge_challenge_round_trips_answers() {
        let (req_tx, mut req_rx) = tokio::sync::mpsc::channel(1);

        // Factory hands out a fresh response receiver per round and stashes the
        // sender so the test (standing in for the command layer) can reply.
        let pending: Arc<
            std::sync::Mutex<Option<tokio::sync::oneshot::Sender<KeyboardInteractiveResponse>>>,
        > = Arc::new(std::sync::Mutex::new(None));
        let pending_factory = Arc::clone(&pending);
        let factory = Box::new(move || {
            let (tx, rx) = tokio::sync::oneshot::channel();
            *pending_factory.lock().unwrap() = Some(tx);
            rx
        });

        let mut bridge = KeyboardInteractiveBridge::new(req_tx, factory);

        let request = KeyboardInteractiveChallengeRequest {
            session_id: None,
            name: "MFA".to_string(),
            instruction: String::new(),
            prompts: vec![KeyboardInteractivePrompt {
                text: "OTP:".to_string(),
                echo: false,
            }],
            round: 1,
        };

        // Drive the responder concurrently with the challenge call.
        let challenge = bridge.challenge(request);
        let responder = async {
            let emitted = req_rx.recv().await.expect("a challenge must be emitted");
            assert_eq!(emitted.name, "MFA");
            assert_eq!(emitted.round, 1);
            // Reply via the armed per-round sender.
            let tx = pending.lock().unwrap().take().expect("receiver was armed");
            tx.send(KeyboardInteractiveResponse {
                responses: vec!["123456".to_string()],
            })
            .map_err(|_| ())
            .expect("send answers");
        };

        let (answers, ()) = tokio::join!(challenge, responder);
        let answers = answers.expect("challenge resolves");
        assert_eq!(&*answers, &vec!["123456".to_string()]);
    }

    // If the response channel is dropped without answering (e.g. the user closes
    // the dialog), challenge() must surface a KeyboardInteractive error rather
    // than hang or panic.
    #[tokio::test]
    async fn ki_bridge_challenge_errors_when_response_dropped() {
        let (req_tx, mut req_rx) = tokio::sync::mpsc::channel(1);
        let factory = Box::new(move || {
            // Create the oneshot but immediately drop the sender → dropped channel.
            let (_tx, rx) = tokio::sync::oneshot::channel();
            rx
        });
        let mut bridge = KeyboardInteractiveBridge::new(req_tx, factory);

        let request = KeyboardInteractiveChallengeRequest {
            session_id: None,
            name: String::new(),
            instruction: String::new(),
            prompts: vec![],
            round: 1,
        };

        let challenge = bridge.challenge(request);
        let drain = async {
            // Consume the emitted request so send() succeeds.
            let _ = req_rx.recv().await;
        };
        let (result, ()) = tokio::join!(challenge, drain);
        assert!(matches!(result, Err(AppError::KeyboardInteractive(_))));
    }
}
