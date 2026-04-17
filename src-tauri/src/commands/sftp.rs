// commands/sftp.rs — SFTP Tauri commands
//
// Handles: sftp_open, sftp_close, sftp_list_dir, sftp_stat, sftp_mkdir,
// sftp_delete, sftp_rename, sftp_upload, sftp_download, sftp_cancel_transfer,
// list_local_dir
//
// Design: The global sessions lock is held only long enough to extract an
// Arc<SftpSession> clone, then dropped BEFORE any SFTP I/O. This prevents
// transfers (upload/download) from blocking the entire app and eliminates the
// double-lock pattern that affected all SFTP operations.
//
// Transfer progress is streamed via Tauri Channel. The command returns
// the TransferId once the transfer completes (or fails/cancels).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::sftp;
use crate::state::{
    AppState, FileContent, FileEntry, FileType, SearchResult, SessionId, TransferDirection,
    TransferEvent, TransferId, TransferState,
};

// ─── Helper: ensure SFTP is open + return Arc clone ─────

/// Get or lazily initialize the SFTP session for a given SSH session.
/// Returns an Arc clone of the SftpSession, dropping the global sessions
/// lock before returning. This eliminates the double-lock pattern (M1)
/// and allows callers to perform SFTP I/O without holding the global lock.
async fn ensure_sftp(
    state: &State<'_, AppState>,
    session_id: SessionId,
) -> Result<Arc<SftpSession>, AppError> {
    let mut sessions = state.sessions.lock().await;
    let handle = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    // Check session is connected
    if handle.state != crate::state::SessionState::Connected {
        return Err(AppError::NotConnected);
    }

    // If SFTP not yet open, initialize it
    if handle.sftp.is_none() {
        let ssh = handle.ssh_handle.as_ref().ok_or(AppError::NotConnected)?;
        let sftp_handle = sftp::open_sftp(ssh).await?;
        handle.sftp = Some(sftp_handle);
        tracing::info!("SFTP subsystem opened for session {session_id}");
    }

    // Clone the Arc<SftpSession> — O(1) ref-count bump.
    // The lock is dropped when `sessions` goes out of scope at the caller.
    let sftp_session = handle
        .sftp
        .as_ref()
        .expect("SFTP just ensured above")
        .session
        .clone();

    Ok(sftp_session)
}

// ─── SFTP Session Lifecycle ─────────────────────────────

/// Open the SFTP subsystem on an existing SSH session.
/// Returns the remote home directory path.
#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<String, AppError> {
    // Single lock scope: ensure + clone Arc, then lock is dropped
    let sftp_session = ensure_sftp(&state, session_id).await?;
    let home = sftp::get_home_dir(&sftp_session).await?;
    Ok(home)
}

/// Close the SFTP subsystem.
#[tauri::command]
pub async fn sftp_close(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let handle = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    if let Some(sftp_handle) = handle.sftp.take() {
        // Cancel all active transfers
        for (_, transfer) in &sftp_handle.active_transfers {
            transfer.cancel_token.cancel();
        }
        // Close the SFTP session
        let _ = sftp_handle.session.close().await;
        tracing::info!("SFTP subsystem closed for session {session_id}");
    }

    Ok(())
}

// ─── File Operations ────────────────────────────────────
//
// All operations below use ensure_sftp() which acquires the global lock
// once, clones the Arc<SftpSession>, and drops the lock. The SFTP I/O
// then runs on the cloned Arc — no global lock held during I/O.

/// List remote directory contents.
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: SessionId,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    sftp::list_dir(&sftp_session, &path).await
}

/// Get metadata for a remote file/directory.
#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    session_id: SessionId,
    path: String,
) -> Result<FileEntry, AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    sftp::stat(&sftp_session, &path).await
}

/// Create a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: SessionId,
    path: String,
) -> Result<(), AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    sftp::mkdir(&sftp_session, &path).await
}

/// Delete a remote file or directory. If recursive is true, deletes
/// non-empty directories by removing contents first.
#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    session_id: SessionId,
    path: String,
    recursive: bool,
) -> Result<(), AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    sftp::delete(&sftp_session, &path, recursive).await
}

/// Rename a remote file or directory.
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: SessionId,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    sftp::rename(&sftp_session, &from, &to).await
}

// ─── File Viewer ────────────────────────────────────────

/// Read a remote file for in-app preview.
///
/// Returns the file content decoded as text with metadata.
/// Rejects binary files and files larger than 50 MB.
///
/// Lock strategy: same as other file operations — ensure_sftp clones
/// the Arc<SftpSession>, drops the global lock, then runs SFTP I/O.
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: SessionId,
    remote_path: String,
    max_lines: Option<usize>,
) -> Result<FileContent, AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    sftp::read_file(&sftp_session, &remote_path, None, max_lines).await
}

// ─── Recursive File Search ──────────────────────────────

/// Search for files by name across subdirectories on the remote server.
///
/// Uses breadth-first traversal starting from `base_path`.
/// Matches filenames containing `query` (case-insensitive).
///
/// Lock strategy: same as other SFTP commands — ensure_sftp clones the
/// Arc<SftpSession>, drops the global lock, then runs SFTP I/O.
#[tauri::command]
pub async fn sftp_search(
    state: State<'_, AppState>,
    session_id: SessionId,
    base_path: String,
    query: String,
    max_depth: Option<u32>,
    max_results: Option<u32>,
) -> Result<Vec<SearchResult>, AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    let depth = max_depth.unwrap_or(5);
    let results_limit = max_results.unwrap_or(100);
    sftp::search_files(&sftp_session, &base_path, &query, depth, results_limit).await
}

// ─── File Transfers ─────────────────────────────────────

/// Upload a local file to the remote server with chunked progress.
///
/// Progress events are streamed via the Tauri Channel parameter.
/// The command completes when the transfer finishes (success/failure/cancel).
/// Returns the transfer ID.
///
/// Lock strategy (C1 fix): the global sessions lock is acquired once to
/// clone the Arc<SftpSession> and register the transfer, then dropped
/// BEFORE the actual file I/O begins. This allows terminal input,
/// disconnect, and other SFTP operations to proceed during transfers.
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: SessionId,
    local_path: String,
    remote_path: String,
    on_progress: Channel<TransferEvent>,
) -> Result<TransferId, AppError> {
    let local = PathBuf::from(&local_path);

    // Validate local file exists
    if !local.exists() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Local file not found: {local_path}"),
        )));
    }

    // Get file metadata for transfer tracking
    let file_metadata = tokio::fs::metadata(&local).await.map_err(AppError::Io)?;
    let total_bytes = file_metadata.len();
    let file_name = local
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Create cancellation token for this transfer
    let cancel_token = CancellationToken::new();
    let transfer_id = Uuid::new_v4();

    // Single lock scope: ensure SFTP, clone Arc, register transfer, drop lock
    let sftp_session = {
        let mut sessions = state.sessions.lock().await;
        let handle = sessions
            .get_mut(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;

        // Check session is connected
        if handle.state != crate::state::SessionState::Connected {
            return Err(AppError::NotConnected);
        }

        // Ensure SFTP is open
        if handle.sftp.is_none() {
            let ssh = handle.ssh_handle.as_ref().ok_or(AppError::NotConnected)?;
            let sftp_handle = sftp::open_sftp(ssh).await?;
            handle.sftp = Some(sftp_handle);
            tracing::info!("SFTP subsystem opened for session {session_id}");
        }

        let sftp_handle = handle.sftp.as_mut().expect("SFTP just ensured above");

        // Register transfer for cancellation support
        sftp_handle.active_transfers.insert(
            transfer_id,
            TransferState {
                id: transfer_id,
                direction: TransferDirection::Upload,
                file_name,
                total_bytes,
                bytes_transferred: 0,
                cancel_token: cancel_token.clone(),
            },
        );

        // Clone Arc<SftpSession> — O(1) ref-count bump
        sftp_handle.session.clone()
        // `sessions` lock is dropped here
    };

    // Execute the transfer WITHOUT holding the global lock (C1 fix)
    // Pass the same transfer_id down so events and cancellation use ONE id
    let result = sftp::upload(
        &sftp_session,
        &local,
        &remote_path,
        transfer_id,
        on_progress,
        cancel_token,
    )
    .await;

    // Clean up transfer state (brief lock)
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(handle) = sessions.get_mut(&session_id) {
            if let Some(ref mut sftp_handle) = handle.sftp {
                sftp_handle.active_transfers.remove(&transfer_id);
            }
        }
    }

    result
}

/// Download a remote file to the local filesystem with chunked progress.
///
/// Progress events are streamed via the Tauri Channel parameter.
/// The command completes when the transfer finishes (success/failure/cancel).
/// Returns the transfer ID.
///
/// Lock strategy (C1 fix): same as sftp_upload — clone Arc, drop lock,
/// run I/O without holding the global sessions lock.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: SessionId,
    remote_path: String,
    local_path: String,
    on_progress: Channel<TransferEvent>,
) -> Result<TransferId, AppError> {
    let local = PathBuf::from(&local_path);
    let file_name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or("unknown")
        .to_string();

    // Create cancellation token
    let cancel_token = CancellationToken::new();
    let transfer_id = Uuid::new_v4();

    // Single lock scope: ensure SFTP, stat remote file, register transfer,
    // clone Arc, drop lock
    let sftp_session = {
        let mut sessions = state.sessions.lock().await;
        let handle = sessions
            .get_mut(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;

        // Check session is connected
        if handle.state != crate::state::SessionState::Connected {
            return Err(AppError::NotConnected);
        }

        // Ensure SFTP is open
        if handle.sftp.is_none() {
            let ssh = handle.ssh_handle.as_ref().ok_or(AppError::NotConnected)?;
            let sftp_handle = sftp::open_sftp(ssh).await?;
            handle.sftp = Some(sftp_handle);
            tracing::info!("SFTP subsystem opened for session {session_id}");
        }

        let sftp_handle = handle.sftp.as_mut().expect("SFTP just ensured above");

        // Get remote file size while we still have the lock
        let metadata = sftp_handle
            .session
            .metadata(&remote_path)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to stat remote file: {e}")))?;
        let total_bytes = metadata.size.unwrap_or(0);

        // Register transfer for cancellation support
        sftp_handle.active_transfers.insert(
            transfer_id,
            TransferState {
                id: transfer_id,
                direction: TransferDirection::Download,
                file_name,
                total_bytes,
                bytes_transferred: 0,
                cancel_token: cancel_token.clone(),
            },
        );

        // Clone Arc<SftpSession> — O(1) ref-count bump
        sftp_handle.session.clone()
        // `sessions` lock is dropped here
    };

    // Execute the transfer WITHOUT holding the global lock (C1 fix)
    // Pass the same transfer_id down so events and cancellation use ONE id
    let result = sftp::download(
        &sftp_session,
        &remote_path,
        &local,
        transfer_id,
        on_progress,
        cancel_token,
    )
    .await;

    // Clean up transfer state (brief lock)
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(handle) = sessions.get_mut(&session_id) {
            if let Some(ref mut sftp_handle) = handle.sftp {
                sftp_handle.active_transfers.remove(&transfer_id);
            }
        }
    }

    result
}

/// Cancel an active file transfer.
#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    session_id: SessionId,
    transfer_id: TransferId,
) -> Result<(), AppError> {
    let sessions = state.sessions.lock().await;
    let handle = sessions
        .get(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;
    let sftp_handle = handle
        .sftp
        .as_ref()
        .ok_or_else(|| AppError::Sftp("SFTP session not available".to_string()))?;

    if let Some(transfer) = sftp_handle.active_transfers.get(&transfer_id) {
        transfer.cancel_token.cancel();
        tracing::info!("Cancelled transfer {transfer_id}");
        Ok(())
    } else {
        Err(AppError::Sftp(format!(
            "Transfer not found: {transfer_id}"
        )))
    }
}

// ─── Open with External Application ─────────────────────

/// Download a remote file to a temp directory and open it with the system's
/// default application.
///
/// - Creates a "nexterm" subdirectory under the system temp dir
/// - Downloads the file via SFTP with chunked progress reporting
/// - Opens with the OS default handler (macOS: `open`, Windows: `start`,
///   Linux: `xdg-open`)
/// - The temp file persists until system cleanup or app restart
///
/// Progress events are streamed via Tauri Channel so the frontend can
/// display a progress bar during download.
///
/// Lock strategy: same as other SFTP commands — ensure_sftp clones the
/// Arc<SftpSession>, drops the global lock, then runs SFTP I/O.
#[tauri::command]
pub async fn sftp_open_external(
    state: State<'_, AppState>,
    session_id: SessionId,
    remote_path: String,
    file_name: String,
    on_progress: Channel<TransferEvent>,
) -> Result<(), AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;

    // 1. Create temp directory: <system_temp>/nexterm/
    let temp_dir = std::env::temp_dir().join("nexterm");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(AppError::Io)?;

    // 2. Build unique local path to avoid collisions between sessions
    //    Format: <temp>/nexterm/<uuid>_<filename>
    let unique_name = format!("{}_{}", Uuid::new_v4(), file_name);
    let local_path = temp_dir.join(&unique_name);

    // 3. Download with progress reporting
    sftp::download_to_path_with_progress(
        &sftp_session,
        &remote_path,
        &local_path,
        &file_name,
        &on_progress,
    )
    .await?;

    tracing::info!(
        "Downloaded '{}' to temp for external open: {}",
        remote_path,
        local_path.display()
    );

    // 4. Open with the OS default application (or "Open With" chooser on Windows)
    //
    // - macOS: `open <path>` — opens with the default app for the file type
    // - Linux: `xdg-open <path>` — same behavior
    // - Windows: `rundll32 shell32.dll,OpenAs_RunDLL <path>` — shows the
    //   "Open With" chooser dialog so the user can pick an application
    #[cfg(target_os = "windows")]
    {
        let path_str = local_path.to_string_lossy().to_string();
        std::process::Command::new("rundll32")
            .args(["shell32.dll,OpenAs_RunDLL", &path_str])
            .spawn()
            .map_err(|e| {
                AppError::Sftp(format!(
                    "Failed to open 'Open With' dialog for '{}': {e}",
                    local_path.display()
                ))
            })?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        open::that(&local_path).map_err(|e| {
            AppError::Sftp(format!(
                "Failed to open '{}' with system app: {e}",
                local_path.display()
            ))
        })?;
    }

    Ok(())
}

// ─── Save As & Reveal in File Manager ───────────────────

/// Download a remote file to a user-chosen local path and reveal it in
/// the system file manager (Finder on macOS, Explorer on Windows, etc.).
///
/// The frontend is responsible for showing the save dialog and passing
/// the chosen path. This command just downloads + reveals.
///
/// Progress events are streamed via Tauri Channel.
///
/// Lock strategy: same as other SFTP commands — ensure_sftp clones the
/// Arc<SftpSession>, drops the global lock, then runs SFTP I/O.
#[tauri::command]
pub async fn sftp_save_and_reveal(
    state: State<'_, AppState>,
    session_id: SessionId,
    remote_path: String,
    local_path: String,
    file_name: String,
    on_progress: Channel<TransferEvent>,
) -> Result<(), AppError> {
    let sftp_session = ensure_sftp(&state, session_id).await?;
    let local = PathBuf::from(&local_path);

    // Ensure parent directory exists
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(AppError::Io)?;
    }

    // Download with progress reporting
    sftp::download_to_path_with_progress(
        &sftp_session,
        &remote_path,
        &local,
        &file_name,
        &on_progress,
    )
    .await?;

    tracing::info!(
        "Downloaded '{}' to user-chosen path: {}",
        remote_path,
        local.display()
    );

    // Reveal the file in the system file manager
    // macOS: `open -R /path/to/file` selects it in Finder
    // Windows/Linux: open the parent directory
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&local)
            .spawn()
            .map_err(|e| {
                AppError::Sftp(format!("Failed to reveal file in Finder: {e}"))
            })?;
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(parent) = local.parent() {
            open::that(parent).map_err(|e| {
                AppError::Sftp(format!("Failed to reveal file in Explorer: {e}"))
            })?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = local.parent() {
            open::that(parent).map_err(|e| {
                AppError::Sftp(format!("Failed to reveal file in file manager: {e}"))
            })?;
        }
    }

    Ok(())
}

// ─── Local Filesystem Browsing ──────────────────────────

/// List local directory contents. Returns FileEntry[] compatible with
/// the remote SFTP listing format.
///
/// Cross-platform:
/// - Unix: includes permission bits, symlink detection
/// - Windows: omits Unix permissions (shows 0), simplified file types
/// - Includes hidden files (dotfiles on Unix, hidden attribute on Windows)
#[tauri::command]
pub async fn list_local_dir(path: String) -> Result<Vec<FileEntry>, AppError> {
    let dir_path = PathBuf::from(&path);

    // Validate path exists and is a directory
    let metadata = tokio::fs::metadata(&dir_path)
        .await
        .map_err(AppError::Io)?;

    if !metadata.is_dir() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("Not a directory: {path}"),
        )));
    }

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(AppError::Io)?;

    while let Some(entry) = read_dir.next_entry().await.map_err(AppError::Io)? {
        let entry_name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path();
        let entry_path_str = entry_path.to_string_lossy().to_string();

        // Get metadata — follow symlinks first, fall back to symlink metadata
        let (meta, is_symlink) = match tokio::fs::metadata(&entry_path).await {
            Ok(m) => {
                // Check if it's a symlink by also checking symlink_metadata
                let is_sym = match tokio::fs::symlink_metadata(&entry_path).await {
                    Ok(sm) => sm.is_symlink(),
                    Err(_) => false,
                };
                (m, is_sym)
            }
            Err(_) => {
                // Broken symlink or permission denied — try symlink_metadata
                match tokio::fs::symlink_metadata(&entry_path).await {
                    Ok(sm) => {
                        let is_sym = sm.is_symlink();
                        (sm, is_sym)
                    }
                    Err(e) => {
                        tracing::warn!("Cannot read metadata for {entry_path_str}: {e}");
                        continue; // Skip entries we can't read
                    }
                }
            }
        };

        let file_type = if is_symlink {
            FileType::Symlink
        } else if meta.is_dir() {
            FileType::Directory
        } else if meta.is_file() {
            FileType::File
        } else {
            FileType::Other
        };

        // For symlinks, resolve target type using the followed metadata
        let link_target = if is_symlink {
            // `meta` was obtained via metadata() which follows symlinks,
            // so it reflects the target's type
            if meta.is_dir() {
                Some("directory".to_string())
            } else if meta.is_file() {
                Some("file".to_string())
            } else {
                // If we got here via symlink_metadata fallback, the symlink is broken
                Some("broken".to_string())
            }
        } else {
            None
        };

        let size = meta.len();

        // Modified time as Unix timestamp
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);

        // Accessed time as Unix timestamp
        let accessed = meta
            .accessed()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);

        // Platform-specific permission handling
        #[cfg(unix)]
        let (permissions, permissions_str, owner, group) = {
            use std::os::unix::fs::MetadataExt;
            let mode = meta.mode();
            let perms_str =
                crate::ssh::sftp::format_unix_permissions(mode, &file_type);
            (mode, perms_str, Some(meta.uid()), Some(meta.gid()))
        };

        #[cfg(not(unix))]
        let (permissions, permissions_str, owner, group) = {
            let perms: u32 = if meta.permissions().readonly() {
                0o444
            } else {
                0o644
            };
            let perms_str = if meta.is_dir() {
                if meta.permissions().readonly() {
                    "dr-xr-xr-x".to_string()
                } else {
                    "drwxr-xr-x".to_string()
                }
            } else if meta.permissions().readonly() {
                "-r--r--r--".to_string()
            } else {
                "-rw-r--r--".to_string()
            };
            (perms, perms_str, None::<u32>, None::<u32>)
        };

        entries.push(FileEntry {
            name: entry_name,
            path: entry_path_str,
            file_type,
            size,
            permissions,
            permissions_str,
            modified,
            accessed,
            owner,
            group,
            link_target,
        });
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        let a_is_dir = matches!(a.file_type, FileType::Directory);
        let b_is_dir = matches!(b.file_type, FileType::Directory);
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

// ─── Open Local File with System Default App ────────────

/// Open a local file with the operating system's default application.
///
/// This is used when the user double-clicks a file in the LOCAL pane of the
/// SFTP browser. Local files should NOT go through SFTP — they should open
/// natively (e.g., TextEdit, VS Code, Preview, etc.).
#[tauri::command]
pub async fn open_local_file(path: String) -> Result<(), AppError> {
    let file_path = std::path::Path::new(&path);

    if !file_path.exists() {
        return Err(AppError::Sftp(format!(
            "File does not exist: {}",
            path
        )));
    }

    open::that(&path).map_err(|e| {
        AppError::Sftp(format!(
            "Failed to open '{}' with system app: {e}",
            path
        ))
    })?;

    tracing::info!("Opened local file with system app: {}", path);
    Ok(())
}
