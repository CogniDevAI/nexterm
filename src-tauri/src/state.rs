// state.rs — Application state, session handles, and core type definitions
//
// AppState is registered as Tauri managed state and shared across all commands.
// Uses tokio::sync::Mutex because lock holders need to .await inside critical sections.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::profile::ConnectionProfile;
use crate::ssh::tunnel::RemoteForwardRegistry;
use crate::vault::Vault;

// ─── Type Aliases ───────────────────────────────────────

pub type SessionId = Uuid;
pub type TerminalId = Uuid;
pub type TunnelId = Uuid;
pub type TransferId = Uuid;

// ─── AppState ───────────────────────────────────────────

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<SessionId, SessionHandle>>>,
    pub profiles: Mutex<Vec<ConnectionProfile>>,
    pub vault: Mutex<Option<Vault>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            profiles: Mutex::new(Vec::new()),
            vault: Mutex::new(None),
        }
    }
}

// ─── Session Handle ─────────────────────────────────────

pub struct SessionHandle {
    pub id: SessionId,
    pub profile: ConnectionProfile,
    pub state: SessionState,
    pub ssh_handle: Option<russh::client::Handle<crate::ssh::handler::SshClientHandler>>,
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
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
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
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
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

// ─── Terminal Events (streamed via Tauri Channel) ───────

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Closed { reason: String },
    Error { message: String },
}
