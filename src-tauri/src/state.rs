// state.rs — Application state, session handles, and core type definitions
//
// AppState is registered as Tauri managed state and shared across all commands.
// Uses tokio::sync::Mutex because lock holders need to .await inside critical sections.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::profile::ConnectionProfile;
use crate::ssh::tunnel::RemoteForwardRegistry;
use crate::vault::{idle_should_lock, Vault, DEFAULT_IDLE_TIMEOUT_SECS};

// ─── Type Aliases ───────────────────────────────────────

pub type SessionId = Uuid;
pub type TerminalId = Uuid;
pub type TunnelId = Uuid;
pub type TransferId = Uuid;

// ─── AppState ───────────────────────────────────────────

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<SessionId, SessionHandle>>>,
    pub profiles: Mutex<Vec<ConnectionProfile>>,
    /// `Arc` so the background auto-lock task can share the exact same vault
    /// mutex as the command handlers (one source of truth for the key).
    pub vault: Arc<Mutex<Option<Vault>>>,
    /// Idle/suspend auto-lock bookkeeping for the vault. Held behind its own
    /// synchronization (a std `Mutex` + atomics) so the background lock task and
    /// `vault_status` reads never have to take the async `vault` mutex just to
    /// inspect activity — this keeps lock ordering simple and deadlock-free.
    pub auto_lock: Arc<AutoLockState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            profiles: Mutex::new(Vec::new()),
            vault: Arc::new(Mutex::new(None)),
            auto_lock: Arc::new(AutoLockState::default()),
        }
    }
}

// ─── Auto-Lock State ────────────────────────────────────

/// Tracks vault activity and the configured idle timeout so the background task
/// (and `vault_status`) can decide when to auto-lock.
///
/// `last_activity` is a monotonic `Instant`, guarded by a *synchronous* mutex:
/// every critical section is a couple of field reads/writes with no `.await`,
/// so a `std::sync::Mutex` is correct and cheaper than the async one. The
/// timeout is an `AtomicU64` (seconds; 0 disables auto-lock) so it can be read
/// and reconfigured without taking any lock.
pub struct AutoLockState {
    last_activity: StdMutex<Instant>,
    idle_timeout_secs: AtomicU64,
}

impl Default for AutoLockState {
    fn default() -> Self {
        Self {
            last_activity: StdMutex::new(Instant::now()),
            idle_timeout_secs: AtomicU64::new(DEFAULT_IDLE_TIMEOUT_SECS),
        }
    }
}

impl AutoLockState {
    /// Reset the idle timer — call this on every vault operation that counts as
    /// "use" (unlock, store/get/delete credential, status that implies use).
    pub fn record_activity(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    /// Like [`record_activity`] but pins the timer to a caller-supplied
    /// `Instant`. Exists so tests can place activity deterministically in the
    /// past without sleeping.
    pub fn record_activity_at(&self, at: Instant) {
        *self.last_activity.lock().unwrap() = at;
    }

    /// Configure the idle timeout in seconds. `0` disables auto-lock.
    pub fn set_idle_timeout_secs(&self, secs: u64) {
        self.idle_timeout_secs.store(secs, Ordering::Relaxed);
    }

    /// Current idle timeout in seconds (`0` means auto-lock disabled).
    pub fn idle_timeout_secs(&self) -> u64 {
        self.idle_timeout_secs.load(Ordering::Relaxed)
    }

    /// How long since the last recorded activity, measured against `now`.
    /// Saturates at zero if the clock somehow reports activity in the future.
    pub fn idle_elapsed_since(&self, now: Instant) -> Duration {
        let last = *self.last_activity.lock().unwrap();
        now.saturating_duration_since(last)
    }

    /// Seconds since the last recorded activity (for surfacing to the UI).
    pub fn idle_seconds(&self) -> u64 {
        self.idle_elapsed_since(Instant::now()).as_secs()
    }

    /// Seconds remaining before auto-lock, or `None` when auto-lock is disabled
    /// (`timeout == 0`). Clamps to `0` once the timeout has elapsed.
    pub fn seconds_until_lock(&self) -> Option<u64> {
        let timeout = self.idle_timeout_secs();
        if timeout == 0 {
            return None;
        }
        Some(timeout.saturating_sub(self.idle_seconds()))
    }

    /// Decide whether the vault should auto-lock as of `now`, composing the
    /// pure [`idle_should_lock`] core with the current activity + timeout.
    pub fn should_lock_now(&self, now: Instant) -> bool {
        let timeout = Duration::from_secs(self.idle_timeout_secs());
        idle_should_lock(self.idle_elapsed_since(now), timeout)
    }
}

// ─── Session Handle ─────────────────────────────────────

pub struct SessionHandle {
    pub id: SessionId,
    pub profile: ConnectionProfile,
    /// The user ID of the UserCredential that initiated this session.
    pub user_id: Uuid,
    /// The username of the UserCredential that initiated this session.
    pub username: String,
    pub state: SessionState,
    pub ssh_handle: Option<russh::client::Handle<crate::ssh::handler::SshClientHandler>>,
    /// When the session was established THROUGH a bastion (`ssh -J`), this holds
    /// the live bastion SSH handle. It MUST be kept alive for the lifetime of
    /// the session: the target connection runs over a direct-tcpip channel that
    /// the bastion's session task drives, so dropping this handle would tear
    /// down the tunnel underneath the target. `None` for direct connections.
    pub bastion_handle: Option<russh::client::Handle<crate::ssh::session::BastionHandler>>,
    pub terminals: HashMap<TerminalId, TerminalChannelHandle>,
    pub sftp: Option<SftpSessionHandle>,
    pub tunnels: HashMap<TunnelId, TunnelHandle>,
    pub keepalive_task: Option<tokio::task::JoinHandle<()>>,
    pub cancel_token: tokio_util::sync::CancellationToken,
    /// Remote forward registry — shared with the SshClientHandler for remote tunnel callbacks.
    pub remote_forward_registry: Option<RemoteForwardRegistry>,
}

// ─── Session State ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Disconnected,
    Connecting,
    Authenticating,
    Connected,
    Error { message: String },
}

// ─── Session Info (serializable summary for frontend) ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: SessionId,
    pub profile_name: String,
    pub host: String,
    /// The user ID of the UserCredential that initiated this session.
    pub user_id: Uuid,
    /// The username that authenticated this session.
    pub username: String,
    pub state: SessionState,
    pub terminal_count: usize,
    pub has_sftp: bool,
    pub tunnel_count: usize,
}

// ─── Terminal Command Channel ───────────────────────────

/// Commands sent from Tauri command handlers to the terminal reader task.
/// The reader task owns the SSH channel exclusively — all writes/resizes go
/// through this mpsc channel, eliminating Mutex contention (bug H1 fix).
pub enum TerminalCommand {
    /// Send raw bytes (keystrokes) to the SSH channel
    Write(Vec<u8>),
    /// Resize the PTY (cols, rows)
    Resize(u32, u32),
    /// Gracefully close the SSH channel
    Close,
}

// ─── Terminal Channel Handle ────────────────────────────

pub struct TerminalChannelHandle {
    pub id: TerminalId,
    pub channel_id: russh::ChannelId,
    /// Sender side of the command channel — used by write/resize/close commands.
    /// The receiver lives in the reader task which owns the SSH channel exclusively.
    pub command_tx: tokio::sync::mpsc::Sender<TerminalCommand>,
    pub reader_task: Option<tokio::task::JoinHandle<()>>,
    pub cols: u32,
    pub rows: u32,
}

// ─── SFTP Session Handle ────────────────────────────────

pub struct SftpSessionHandle {
    /// Arc-wrapped SFTP session — allows cloning the reference and dropping
    /// the global sessions lock before long-running I/O (transfers).
    pub session: Arc<russh_sftp::client::SftpSession>,
    pub active_transfers: HashMap<TransferId, TransferState>,
}

// ─── Transfer State ─────────────────────────────────────

pub struct TransferState {
    pub id: TransferId,
    pub direction: TransferDirection,
    pub file_name: String,
    pub total_bytes: u64,
    pub bytes_transferred: u64,
    pub cancel_token: tokio_util::sync::CancellationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

// ─── Transfer Events (streamed via Tauri Channel) ───────

#[derive(Clone, Serialize)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferEvent {
    Started {
        transfer_id: TransferId,
        file_name: String,
        total_bytes: u64,
        direction: TransferDirection,
    },
    Progress {
        transfer_id: TransferId,
        bytes_transferred: u64,
        total_bytes: u64,
    },
    Completed {
        transfer_id: TransferId,
    },
    Failed {
        transfer_id: TransferId,
        error: String,
    },
}

// ─── Tunnel Handle ──────────────────────────────────────

pub struct TunnelHandle {
    pub id: TunnelId,
    pub config: TunnelConfig,
    pub state: TunnelState,
    pub cancel_token: tokio_util::sync::CancellationToken,
    pub task: Option<tokio::task::JoinHandle<()>>,
    /// Bytes received from the remote side (SSH channel → TCP socket)
    pub bytes_in: Arc<AtomicU64>,
    /// Bytes sent to the remote side (TCP socket → SSH channel)
    pub bytes_out: Arc<AtomicU64>,
    pub active_connections: Option<Arc<std::sync::atomic::AtomicU32>>,
}

// ─── Tunnel Config ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    #[serde(default)]
    pub id: TunnelId,
    pub tunnel_type: TunnelType,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelType {
    Local,
    Remote,
    /// Dynamic port forwarding (-D / SOCKS5 proxy).
    ///
    /// A local SOCKS5 listener that forwards each CONNECT request through the
    /// SSH session via `channel_open_direct_tcpip`. `target_host` and `target_port`
    /// in `TunnelConfig` are unused for this variant (kept for struct uniformity).
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelState {
    Stopped,
    Starting,
    Active { connections: u32 },
    Error { message: String },
}

// ─── Tunnel Events (streamed via Tauri Channel) ─────────

#[derive(Clone, Serialize)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TunnelEvent {
    StateChanged {
        tunnel_id: TunnelId,
        state: TunnelState,
    },
    Traffic {
        tunnel_id: TunnelId,
        bytes_in: u64,
        bytes_out: u64,
    },
}

// ─── File Content (for file viewer) ─────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub file_name: String,
    pub file_size: u64,
    pub encoding: String,
    pub truncated: bool,
    pub total_lines: usize,
}

// ─── Search Result (SFTP recursive search) ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Full absolute path on the remote server
    pub path: String,
    /// Just the file/directory name
    pub file_name: String,
    /// "file" or "directory"
    pub file_type: String,
    /// File size in bytes
    pub size: u64,
    /// Path relative to the search base_path
    pub relative_path: String,
}

// ─── File Entry ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub file_type: FileType,
    pub size: u64,
    pub permissions: u32,
    pub permissions_str: String,
    pub modified: Option<i64>,
    pub accessed: Option<i64>,
    pub owner: Option<u32>,
    pub group: Option<u32>,
    /// For symlinks: the type of the target ("directory", "file", or "broken").
    /// None for non-symlink entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileType {
    File,
    Directory,
    Symlink,
    Other,
}

// ─── Host Key Verification ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostKeyStatus {
    Trusted,
    Unknown {
        fingerprint: String,
        #[serde(rename = "keyType")]
        key_type: String,
    },
    Changed {
        #[serde(rename = "oldFingerprint")]
        old_fingerprint: String,
        #[serde(rename = "newFingerprint")]
        new_fingerprint: String,
        #[serde(rename = "keyType")]
        key_type: String,
        /// Set when the stored key uses a different algorithm than the server's
        /// current key (e.g. ssh-rsa → ssh-ed25519). `None` when the key type
        /// is the same (i.e. a genuine fingerprint change — potentially dangerous).
        #[serde(rename = "oldKeyType", skip_serializing_if = "Option::is_none")]
        old_key_type: Option<String>,
    },
    Revoked,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyVerificationRequest {
    pub host: String,
    pub port: u16,
    pub status: HostKeyStatus,
    /// Session ID injected by the connect command so the frontend can respond
    /// without waiting for the connect promise to resolve (avoiding race condition).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyVerificationResponse {
    Accept,
    AcceptAndSave,
    Reject,
}

// ─── Keyboard-Interactive (MFA) Challenge ───────────────
//
// Keyboard-interactive auth (RFC 4256) is how servers drive multi-factor flows:
// the server sends one or more "challenges", each carrying a name, an
// instruction, and an ordered list of prompts (e.g. "Password:", "OTP code:").
// The client must answer every prompt and may face SEVERAL challenge rounds
// before the server accepts or rejects. This bridges that flow to the frontend
// exactly like host-key verification: handler emits a request, awaits a oneshot
// reply carrying the user's answers.

/// A single prompt within a keyboard-interactive challenge.
///
/// `echo` mirrors the SSH `echo` flag: when `false` the answer is secret (a
/// password / OTP) and the frontend MUST mask the input; when `true` it is a
/// visible field (e.g. a username confirmation).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardInteractivePrompt {
    /// The text the server wants shown to the user (e.g. "Verification code:").
    pub text: String,
    /// Whether the typed answer should be visible (`true`) or masked (`false`).
    pub echo: bool,
}

/// One keyboard-interactive challenge round surfaced to the frontend.
///
/// Emitted via [`crate::commands::connection::SessionStateEvent`] each time the
/// server poses a challenge. `round` lets the UI/log distinguish successive
/// rounds (1-based); it is also what the max-rounds cap counts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardInteractiveChallengeRequest {
    /// Session this challenge belongs to. Injected by the connect command before
    /// the event is forwarded (mirrors `HostKeyVerificationRequest::session_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    /// Optional human-readable name the server attached to the challenge set.
    pub name: String,
    /// Optional instruction block (often empty) the server attached.
    pub instruction: String,
    /// The ordered prompts the user must answer. Answers MUST be returned in the
    /// SAME order and count (validated in `session.rs`).
    pub prompts: Vec<KeyboardInteractivePrompt>,
    /// 1-based round counter. The first challenge is round 1.
    pub round: u32,
}

/// The user's answers to a keyboard-interactive challenge, sent from the
/// frontend back to the awaiting handler.
///
/// The answers themselves are plaintext secrets in transit only — the backend
/// wraps them in `zeroize::Zeroizing` the instant they arrive and never logs
/// their content. We do NOT derive `Debug` to avoid accidental logging of the
/// answers.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardInteractiveResponse {
    /// One answer per prompt, in prompt order.
    pub responses: Vec<String>,
}

// ─── Terminal Events (streamed via Tauri Channel) ───────

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Closed { reason: String },
    Error { message: String },
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_lock_defaults_to_fifteen_minutes() {
        let s = AutoLockState::default();
        assert_eq!(s.idle_timeout_secs(), DEFAULT_IDLE_TIMEOUT_SECS);
        assert_eq!(DEFAULT_IDLE_TIMEOUT_SECS, 900);
    }

    #[test]
    fn set_idle_timeout_roundtrips() {
        let s = AutoLockState::default();
        s.set_idle_timeout_secs(60);
        assert_eq!(s.idle_timeout_secs(), 60);
        s.set_idle_timeout_secs(0);
        assert_eq!(s.idle_timeout_secs(), 0);
    }

    #[test]
    fn should_lock_after_timeout_elapses() {
        let s = AutoLockState::default();
        s.set_idle_timeout_secs(900);
        // Activity 901s in the past relative to a fixed `now` => should lock.
        let now = Instant::now();
        s.record_activity_at(now - Duration::from_secs(901));
        assert!(s.should_lock_now(now));
    }

    #[test]
    fn should_not_lock_before_timeout() {
        let s = AutoLockState::default();
        s.set_idle_timeout_secs(900);
        let now = Instant::now();
        s.record_activity_at(now - Duration::from_secs(10));
        assert!(!s.should_lock_now(now));
    }

    #[test]
    fn timeout_zero_never_locks_even_after_long_idle() {
        let s = AutoLockState::default();
        s.set_idle_timeout_secs(0);
        let now = Instant::now();
        s.record_activity_at(now - Duration::from_secs(86_400));
        assert!(!s.should_lock_now(now));
        assert_eq!(s.seconds_until_lock(), None);
    }

    #[test]
    fn record_activity_resets_the_idle_timer() {
        let s = AutoLockState::default();
        s.set_idle_timeout_secs(900);
        let now = Instant::now();
        // First put activity in the lock-eligible past...
        s.record_activity_at(now - Duration::from_secs(901));
        assert!(s.should_lock_now(now));
        // ...then a fresh activity must clear the lock decision.
        s.record_activity_at(now);
        assert!(!s.should_lock_now(now));
    }

    #[test]
    fn seconds_until_lock_clamps_to_zero_when_expired() {
        let s = AutoLockState::default();
        s.set_idle_timeout_secs(900);
        s.record_activity_at(Instant::now() - Duration::from_secs(5000));
        assert_eq!(s.seconds_until_lock(), Some(0));
    }

    // ─── Keyboard-Interactive serde ─────────────────────────────────

    #[test]
    fn ki_prompt_serializes_camel_case() {
        let prompt = KeyboardInteractivePrompt {
            text: "Verification code:".to_string(),
            echo: false,
        };
        let json = serde_json::to_value(&prompt).unwrap();
        assert_eq!(json["text"], "Verification code:");
        assert_eq!(json["echo"], false);
    }

    #[test]
    fn ki_challenge_request_roundtrips() {
        let req = KeyboardInteractiveChallengeRequest {
            session_id: Some(Uuid::nil()),
            name: "MFA".to_string(),
            instruction: "Enter your one-time code".to_string(),
            prompts: vec![
                KeyboardInteractivePrompt {
                    text: "Password:".to_string(),
                    echo: false,
                },
                KeyboardInteractivePrompt {
                    text: "OTP:".to_string(),
                    echo: false,
                },
            ],
            round: 1,
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: KeyboardInteractiveChallengeRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn ki_challenge_request_omits_none_session_id() {
        let req = KeyboardInteractiveChallengeRequest {
            session_id: None,
            name: String::new(),
            instruction: String::new(),
            prompts: vec![],
            round: 1,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("sessionId").is_none());
        // camelCase rename for the round counter is preserved.
        assert_eq!(json["round"], 1);
    }

    #[test]
    fn ki_response_deserializes_from_camel_case() {
        let json = r#"{"responses":["hunter2","123456"]}"#;
        let resp: KeyboardInteractiveResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.responses, vec!["hunter2", "123456"]);
    }

    // ─── TunnelType::Dynamic serde ──────────────────────────────────

    #[test]
    fn tunnel_type_dynamic_serializes_to_camel_case() {
        let json = serde_json::to_string(&TunnelType::Dynamic).unwrap();
        assert_eq!(json, r#""dynamic""#, "Dynamic variant must serialize as \"dynamic\"");
    }

    #[test]
    fn tunnel_type_dynamic_deserializes_from_camel_case() {
        let t: TunnelType = serde_json::from_str(r#""dynamic""#).unwrap();
        assert_eq!(t, TunnelType::Dynamic);
    }

    #[test]
    fn tunnel_type_dynamic_roundtrips_through_json() {
        let original = TunnelType::Dynamic;
        let json = serde_json::to_string(&original).unwrap();
        let back: TunnelType = serde_json::from_str(&json).unwrap();
        assert_eq!(back, TunnelType::Dynamic);
    }

    #[test]
    fn existing_local_remote_tunnel_types_still_deserialize() {
        // Back-compat: old profiles with "local"/"remote" must load without error
        let local: TunnelType = serde_json::from_str(r#""local""#).unwrap();
        let remote: TunnelType = serde_json::from_str(r#""remote""#).unwrap();
        assert_eq!(local, TunnelType::Local);
        assert_eq!(remote, TunnelType::Remote);
    }

    #[test]
    fn tunnel_config_with_dynamic_type_deserializes() {
        // A full TunnelConfig round-trip with tunnelType "dynamic"
        let json = r#"{
            "id": "00000000-0000-0000-0000-000000000000",
            "tunnelType": "dynamic",
            "bindHost": "127.0.0.1",
            "bindPort": 1080,
            "targetHost": "",
            "targetPort": 0,
            "label": null
        }"#;
        let config: TunnelConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.tunnel_type, TunnelType::Dynamic);
        assert_eq!(config.bind_port, 1080);
        assert_eq!(config.target_host, "");
        assert_eq!(config.target_port, 0);
    }

    #[test]
    fn old_tunnel_config_vec_with_local_and_remote_still_loads() {
        // Back-compat: loading an old Vec<TunnelConfig> that has no "dynamic" entries
        let json = r#"[
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "tunnelType": "local",
                "bindHost": "127.0.0.1",
                "bindPort": 8080,
                "targetHost": "db.internal",
                "targetPort": 5432,
                "label": "Database"
            },
            {
                "id": "00000000-0000-0000-0000-000000000002",
                "tunnelType": "remote",
                "bindHost": "0.0.0.0",
                "bindPort": 9090,
                "targetHost": "localhost",
                "targetPort": 3000,
                "label": null
            }
        ]"#;
        let tunnels: Vec<TunnelConfig> = serde_json::from_str(json).unwrap();
        assert_eq!(tunnels.len(), 2);
        assert_eq!(tunnels[0].tunnel_type, TunnelType::Local);
        assert_eq!(tunnels[1].tunnel_type, TunnelType::Remote);
    }
}
