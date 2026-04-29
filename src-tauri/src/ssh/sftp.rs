// ssh/sftp.rs — SFTP subsystem operations
//
// Wraps russh_sftp::client::SftpSession for file operations,
// directory listing, and chunked file transfers with progress.
//
// Key design decisions:
// - SFTP session is opened on-demand (first SFTP operation triggers it)
// - File operations map russh_sftp errors to AppError::Sftp
// - Uploads/downloads use 64KB chunks with progress events via Tauri Channel
// - Transfers support cancellation via CancellationToken + tokio::select!
// - Never buffers entire file in memory

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::ssh::handler::SshClientHandler;
use crate::state::{
    FileContent, FileEntry, FileType, SearchResult, SftpSessionHandle, TransferDirection,
    TransferEvent, TransferId,
};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;

/// Chunk size for file transfers (64KB)
const TRANSFER_CHUNK_SIZE: usize = 64 * 1024;

// ─── Open SFTP ──────────────────────────────────────────

/// Open an SFTP subsystem on an existing SSH session.
///
/// Opens a new session channel, requests the "sftp" subsystem,
/// and initializes the russh_sftp SftpSession.
///
/// Returns an SftpSessionHandle ready for file operations.
pub async fn open_sftp(
    ssh_handle: &russh::client::Handle<SshClientHandler>,
) -> Result<SftpSessionHandle, AppError> {
    // Open a new session channel for SFTP
    let channel = ssh_handle
        .channel_open_session()
        .await
        .map_err(AppError::Ssh)?;

    // Request the SFTP subsystem
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to request SFTP subsystem: {e}")))?;

    // Convert the channel into a bidirectional stream for russh-sftp
    let stream = channel.into_stream();

    // Initialize the SFTP session with a generous timeout
    let sftp = SftpSession::new(stream)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to initialize SFTP session: {e}")))?;

    // Set a longer timeout for operations (30 seconds)
    sftp.set_timeout(30).await;

    Ok(SftpSessionHandle {
        session: Arc::new(sftp),
        active_transfers: HashMap::new(),
    })
}

/// Get the home directory (canonical path of ".")
pub async fn get_home_dir(sftp: &SftpSession) -> Result<String, AppError> {
    sftp.canonicalize(".")
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to get home directory: {e}")))
}

// ─── File Operations ────────────────────────────────────

/// Convert a russh_sftp DirEntry to our FileEntry type
fn dir_entry_to_file_entry(
    entry: &russh_sftp::client::fs::DirEntry,
    parent_path: &str,
) -> FileEntry {
    let name = entry.file_name();
    let metadata = entry.metadata();

    let file_type = match entry.file_type() {
        russh_sftp::protocol::FileType::Dir => FileType::Directory,
        russh_sftp::protocol::FileType::Symlink => FileType::Symlink,
        russh_sftp::protocol::FileType::File => FileType::File,
        _ => FileType::Other,
    };

    let path = if parent_path == "/" {
        format!("/{name}")
    } else {
        format!("{parent_path}/{name}")
    };

    let permissions = metadata.permissions.unwrap_or(0);
    let permissions_str = format_unix_permissions(permissions, &file_type);

    FileEntry {
        name,
        path,
        file_type,
        size: metadata.size.unwrap_or(0),
        permissions,
        permissions_str,
        modified: metadata.mtime.map(|t| t as i64),
        accessed: metadata.atime.map(|t| t as i64),
        owner: metadata.uid,
        group: metadata.gid,
        link_target: None,
    }
}

/// Convert FileAttributes (from metadata/stat) to our FileEntry type
fn attrs_to_file_entry(
    name: String,
    path: String,
    attrs: &russh_sftp::protocol::FileAttributes,
) -> FileEntry {
    let file_type = if attrs.is_dir() {
        FileType::Directory
    } else if attrs.is_symlink() {
        FileType::Symlink
    } else if attrs.is_regular() {
        FileType::File
    } else {
        FileType::Other
    };

    let permissions = attrs.permissions.unwrap_or(0);
    let permissions_str = format_unix_permissions(permissions, &file_type);

    FileEntry {
        name,
        path,
        file_type,
        size: attrs.size.unwrap_or(0),
        permissions,
        permissions_str,
        modified: attrs.mtime.map(|t| t as i64),
        accessed: attrs.atime.map(|t| t as i64),
        owner: attrs.uid,
        group: attrs.gid,
        link_target: None,
    }
}

/// Format Unix permission bits into human-readable string (e.g., "rwxr-xr-x")
pub fn format_unix_permissions(mode: u32, file_type: &FileType) -> String {
    let type_char = match file_type {
        FileType::Directory => 'd',
        FileType::Symlink => 'l',
        FileType::File => '-',
        FileType::Other => '?',
    };

    // Extract permission bits and special bits
    let perms = mode & 0o777;
    let setuid = mode & 0o4000 != 0;
    let setgid = mode & 0o2000 != 0;
    let sticky = mode & 0o1000 != 0;

    let mut s = String::with_capacity(10);
    s.push(type_char);

    // Owner
    s.push(if perms & 0o400 != 0 { 'r' } else { '-' });
    s.push(if perms & 0o200 != 0 { 'w' } else { '-' });
    s.push(match (perms & 0o100 != 0, setuid) {
        (true, true) => 's',
        (false, true) => 'S',
        (true, false) => 'x',
        (false, false) => '-',
    });

    // Group
    s.push(if perms & 0o040 != 0 { 'r' } else { '-' });
    s.push(if perms & 0o020 != 0 { 'w' } else { '-' });
    s.push(match (perms & 0o010 != 0, setgid) {
        (true, true) => 's',
        (false, true) => 'S',
        (true, false) => 'x',
        (false, false) => '-',
    });

    // Other
    s.push(if perms & 0o004 != 0 { 'r' } else { '-' });
    s.push(if perms & 0o002 != 0 { 'w' } else { '-' });
    s.push(match (perms & 0o001 != 0, sticky) {
        (true, true) => 't',
        (false, true) => 'T',
        (true, false) => 'x',
        (false, false) => '-',
    });

    s
}

/// List directory contents on the remote server.
/// Filters out "." and ".." entries.
/// For symlinks, resolves the target type via stat() (which follows symlinks).
pub async fn list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>, AppError> {
    let read_dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to list directory '{path}': {e}")))?;

    let mut entries: Vec<FileEntry> = read_dir
        .filter(|entry| {
            let name = entry.file_name();
            name != "." && name != ".."
        })
        .map(|entry| dir_entry_to_file_entry(&entry, path))
        .collect();

    // Resolve symlink targets: stat() follows symlinks and returns the
    // target's attributes, so we can determine if it points to a directory.
    for entry in &mut entries {
        if entry.file_type == FileType::Symlink {
            match sftp.metadata(&entry.path).await {
                Ok(target_attrs) => {
                    if target_attrs.is_dir() {
                        entry.link_target = Some("directory".to_string());
                    } else {
                        entry.link_target = Some("file".to_string());
                    }
                }
                Err(_) => {
                    // stat() failed — broken symlink (dangling target)
                    entry.link_target = Some("broken".to_string());
                }
            }
        }
    }

    Ok(entries)
}

/// Get file/directory metadata (stat).
pub async fn stat(sftp: &SftpSession, path: &str) -> Result<FileEntry, AppError> {
    let metadata = sftp
        .metadata(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to stat '{path}': {e}")))?;

    // Extract filename from path
    let name = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string();

    Ok(attrs_to_file_entry(name, path.to_string(), &metadata))
}

/// Create a directory on the remote server.
pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.create_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to create directory '{path}': {e}")))
}

/// Remove a file on the remote server.
pub async fn remove_file(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.remove_file(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to remove file '{path}': {e}")))
}

/// Remove a directory on the remote server (must be empty).
pub async fn remove_dir(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.remove_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to remove directory '{path}': {e}")))
}

/// Recursively remove a directory and all its contents.
pub async fn remove_dir_recursive(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    // List all entries
    let entries = list_dir(sftp, path).await?;

    // Delete contents first (leaf-first)
    for entry in &entries {
        match entry.file_type {
            FileType::Directory => {
                // Recurse into subdirectory
                Box::pin(remove_dir_recursive(sftp, &entry.path)).await?;
            }
            _ => {
                // Remove file/symlink/other
                remove_file(sftp, &entry.path).await?;
            }
        }
    }

    // Now remove the empty directory
    remove_dir(sftp, path).await
}

/// Delete a file or directory. If recursive is true and the path is a directory,
/// delete it and all contents recursively.
pub async fn delete(sftp: &SftpSession, path: &str, recursive: bool) -> Result<(), AppError> {
    let metadata = sftp
        .metadata(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to stat '{path}' for delete: {e}")))?;

    if metadata.is_dir() {
        if recursive {
            remove_dir_recursive(sftp, path).await
        } else {
            remove_dir(sftp, path).await
        }
    } else {
        remove_file(sftp, path).await
    }
}

/// Rename a file or directory.
pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), AppError> {
    sftp.rename(from, to)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to rename '{from}' to '{to}': {e}")))
}

// ─── Read File (for file viewer) ────────────────────────

/// Maximum file size allowed for preview (15 MB).
const MAX_PREVIEW_SIZE: u64 = 15_728_640;

/// Maximum number of lines returned to the frontend.
const MAX_PREVIEW_LINES: usize = 50_000;

/// Size of the sample checked for null bytes (binary detection).
const BINARY_CHECK_SIZE: usize = 8 * 1024;

/// Read a remote file for in-app preview.
///
/// - Stats the file first; rejects files larger than `max_size`
/// - Reads in 64KB chunks (same as transfers) into a memory buffer
/// - Checks the first 8KB for null bytes to reject binary files
/// - Decodes as UTF-8; falls back to Latin-1 (lossy) if invalid
/// - If `max_lines` is provided, stops after that many lines (fast initial preview)
/// - Otherwise caps output at 50,000 lines
pub async fn read_file(
    sftp: &SftpSession,
    remote_path: &str,
    max_size: Option<u64>,
    max_lines: Option<usize>,
) -> Result<FileContent, AppError> {
    let limit = max_size.unwrap_or(MAX_PREVIEW_SIZE);
    let line_limit = max_lines.unwrap_or(MAX_PREVIEW_LINES);

    // 1. Stat the file to check size before reading
    let metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to stat '{remote_path}': {e}")))?;

    let file_size = metadata.size.unwrap_or(0);
    if file_size > limit {
        return Err(AppError::Sftp(format!(
            "File too large ({file_size} bytes, limit {limit} bytes)"
        )));
    }

    // 2. Open file for reading
    let mut file = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to open '{remote_path}' for reading: {e}")))?;

    // 3. Read in 64KB chunks, decoding lines incrementally so we can
    //    stop early when max_lines is reached (avoids reading entire 10MB file
    //    just to show the first 1000 lines).
    let mut buffer = Vec::with_capacity((file_size as usize).min(512 * 1024));
    let mut chunk = vec![0u8; TRANSFER_CHUNK_SIZE];
    let mut line_count: usize = 0;
    let mut hit_line_limit = false;

    loop {
        let n = file
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to read '{remote_path}': {e}")))?;
        if n == 0 {
            break;
        }

        // Count newlines in this chunk to check line limit early
        let newlines_in_chunk = chunk[..n].iter().filter(|&&b| b == b'\n').count();
        line_count += newlines_in_chunk;

        buffer.extend_from_slice(&chunk[..n]);

        // If we've accumulated enough lines, stop reading more data from the
        // network. We'll trim to the exact limit after decoding.
        if line_count >= line_limit {
            hit_line_limit = true;
            break;
        }
    }

    // 4. Binary detection — check first 8KB for null bytes
    let check_len = buffer.len().min(BINARY_CHECK_SIZE);
    if buffer[..check_len].contains(&0) {
        return Err(AppError::Sftp(
            "Binary file cannot be previewed".to_string(),
        ));
    }

    // 5. Decode: try UTF-8, fallback to Latin-1
    let (text, encoding) = match std::str::from_utf8(&buffer) {
        Ok(s) => (s.to_string(), "utf-8".to_string()),
        Err(_) => {
            // Latin-1: each byte maps directly to the same Unicode code point
            let decoded: String = buffer.iter().map(|&b| b as char).collect();
            (decoded, "latin-1".to_string())
        }
    };

    // 6. Cap at line_limit
    let all_lines: Vec<&str> = text.lines().collect();
    let total_lines = all_lines.len();
    let truncated = hit_line_limit || total_lines > line_limit;

    let content = if total_lines > line_limit {
        all_lines[..line_limit].join("\n")
    } else {
        text
    };

    // Extract file name from path
    let file_name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or(remote_path)
        .to_string();

    Ok(FileContent {
        content,
        file_name,
        file_size,
        encoding,
        truncated,
        total_lines,
    })
}

// ─── Recursive File Search (BFS) ────────────────────────

/// Search for files/directories by name using breadth-first traversal.
///
/// - Starts from `base_path` and recurses into subdirectories
/// - Matches filenames containing `query` (case-insensitive)
/// - Stops at `max_depth` levels and `max_results` matches
/// - Silently skips directories that fail to list (permission denied, etc.)
pub async fn search_files(
    sftp: &SftpSession,
    base_path: &str,
    query: &str,
    max_depth: u32,
    max_results: u32,
) -> Result<Vec<SearchResult>, AppError> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    // BFS queue: (directory_path, current_depth)
    let mut queue: std::collections::VecDeque<(String, u32)> = std::collections::VecDeque::new();
    queue.push_back((base_path.to_string(), 0));

    while let Some((dir_path, depth)) = queue.pop_front() {
        if results.len() >= max_results as usize {
            break;
        }

        // List directory contents — skip on error (permission denied, etc.)
        let entries = match list_dir(sftp, &dir_path).await {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in &entries {
            if results.len() >= max_results as usize {
                break;
            }

            // Check if filename matches query
            if entry.name.to_lowercase().contains(&query_lower) {
                let relative = entry
                    .path
                    .strip_prefix(base_path)
                    .unwrap_or(&entry.path)
                    .trim_start_matches('/')
                    .to_string();

                let file_type_str = match entry.file_type {
                    FileType::Directory => "directory",
                    _ => "file",
                };

                results.push(SearchResult {
                    path: entry.path.clone(),
                    file_name: entry.name.clone(),
                    file_type: file_type_str.to_string(),
                    size: entry.size,
                    relative_path: relative,
                });
            }

            // Enqueue subdirectories for further traversal
            if entry.file_type == FileType::Directory && depth + 1 <= max_depth {
                queue.push_back((entry.path.clone(), depth + 1));
            }
        }
    }

    Ok(results)
}

// ─── Chunked Upload ─────────────────────────────────────

/// Upload a local file to the remote server with progress reporting.
///
/// - Reads local file in 64KB chunks
/// - Writes to remote via SFTP
/// - Sends TransferEvent progress through Tauri Channel
/// - Supports cancellation via CancellationToken
/// - Never buffers entire file in memory
pub async fn upload(
    sftp: &SftpSession,
    local_path: &Path,
    remote_path: &str,
    transfer_id: TransferId,
    on_progress: Channel<TransferEvent>,
    cancel_token: CancellationToken,
) -> Result<TransferId, AppError> {

    // Open local file
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| AppError::Io(e))?;

    // Get file size
    let metadata = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| AppError::Io(e))?;
    let total_bytes = metadata.len();

    let file_name = local_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Send Started event
    let _ = on_progress.send(TransferEvent::Started {
        transfer_id,
        file_name: file_name.clone(),
        total_bytes,
        direction: TransferDirection::Upload,
    });

    // Open remote file for writing (create + truncate)
    let mut remote_file = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to open remote file for upload: {e}")))?;

    let mut bytes_transferred: u64 = 0;
    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                // Transfer cancelled — close remote file and report
                let _ = remote_file.shutdown().await;
                let _ = on_progress.send(TransferEvent::Failed {
                    transfer_id,
                    error: "Transfer cancelled".to_string(),
                });
                return Err(AppError::TransferCancelled);
            }
            result = local_file.read(&mut buf) => {
                match result {
                    Ok(0) => {
                        // EOF — upload complete
                        remote_file.flush().await.map_err(|e| {
                            AppError::Sftp(format!("Failed to flush remote file: {e}"))
                        })?;
                        remote_file.shutdown().await.map_err(|e| {
                            AppError::Sftp(format!("Failed to close remote file: {e}"))
                        })?;

                        let _ = on_progress.send(TransferEvent::Completed { transfer_id });
                        return Ok(transfer_id);
                    }
                    Ok(n) => {
                        // Write chunk to remote
                        remote_file.write_all(&buf[..n]).await.map_err(|e| {
                            AppError::Sftp(format!("Failed to write to remote file: {e}"))
                        })?;

                        bytes_transferred += n as u64;

                        // Send progress event
                        let _ = on_progress.send(TransferEvent::Progress {
                            transfer_id,
                            bytes_transferred,
                            total_bytes,
                        });
                    }
                    Err(e) => {
                        let _ = remote_file.shutdown().await;
                        let error_msg = format!("Failed to read local file: {e}");
                        let _ = on_progress.send(TransferEvent::Failed {
                            transfer_id,
                            error: error_msg.clone(),
                        });
                        return Err(AppError::Io(e));
                    }
                }
            }
        }
    }
}

// ─── Chunked Download ───────────────────────────────────

/// Download a remote file to the local filesystem with progress reporting.
///
/// - Reads remote file in 64KB chunks via SFTP
/// - Writes to local file
/// - Sends TransferEvent progress through Tauri Channel
/// - Supports cancellation via CancellationToken
/// - Never buffers entire file in memory
pub async fn download(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    transfer_id: TransferId,
    on_progress: Channel<TransferEvent>,
    cancel_token: CancellationToken,
) -> Result<TransferId, AppError> {

    // Get remote file size first
    let remote_metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to stat remote file '{remote_path}': {e}")))?;

    let total_bytes = remote_metadata.size.unwrap_or(0);

    let file_name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or("unknown")
        .to_string();

    // Send Started event
    let _ = on_progress.send(TransferEvent::Started {
        transfer_id,
        file_name: file_name.clone(),
        total_bytes,
        direction: TransferDirection::Download,
    });

    // Open remote file for reading
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to open remote file for download: {e}")))?;

    // Create local file (create or truncate)
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| AppError::Io(e))?;

    let mut bytes_transferred: u64 = 0;
    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                let _ = local_file.flush().await;
                drop(local_file);
                // Optionally remove partial file
                let _ = tokio::fs::remove_file(local_path).await;
                let _ = on_progress.send(TransferEvent::Failed {
                    transfer_id,
                    error: "Transfer cancelled".to_string(),
                });
                return Err(AppError::TransferCancelled);
            }
            result = remote_file.read(&mut buf) => {
                match result {
                    Ok(0) => {
                        // EOF — download complete
                        local_file.flush().await.map_err(|e| AppError::Io(e))?;

                        let _ = on_progress.send(TransferEvent::Completed { transfer_id });
                        return Ok(transfer_id);
                    }
                    Ok(n) => {
                        // Write chunk to local file
                        local_file.write_all(&buf[..n]).await.map_err(|e| AppError::Io(e))?;

                        bytes_transferred += n as u64;

                        // Send progress event
                        let _ = on_progress.send(TransferEvent::Progress {
                            transfer_id,
                            bytes_transferred,
                            total_bytes,
                        });
                    }
                    Err(e) => {
                        drop(local_file);
                        // Remove partial file on error
                        let _ = tokio::fs::remove_file(local_path).await;
                        let error_msg = format!("Failed to read from remote file: {e}");
                        let _ = on_progress.send(TransferEvent::Failed {
                            transfer_id,
                            error: error_msg.clone(),
                        });
                        return Err(AppError::Sftp(error_msg));
                    }
                }
            }
        }
    }
}

// ─── Simple Download (for open-external) ────────────────

/// Download a remote file to a local path without progress reporting.
///
/// Used internally where progress UI is not needed.
/// Reads in 64KB chunks, never buffers entire file in memory.
pub async fn download_to_path(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), AppError> {
    // Open remote file for reading
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to open remote file '{remote_path}': {e}")))?;

    // Create local file (create or truncate)
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(AppError::Io)?;

    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to read remote file '{remote_path}': {e}")))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buf[..n])
            .await
            .map_err(AppError::Io)?;
    }

    local_file.flush().await.map_err(AppError::Io)?;

    Ok(())
}

// ─── Download with Progress (for open-external, save-and-reveal) ────

/// Download a remote file to a local path with progress reporting via Channel.
///
/// Used by `sftp_open_external` and `sftp_save_and_reveal` for downloads
/// where the frontend needs to display a progress bar. Unlike the full
/// `download()` function, this does NOT support cancellation or register
/// in the transfer store — it's a fire-and-forget download with UI feedback.
///
/// Sends Started, Progress, and Completed/Failed events through the channel.
/// Reads in 64KB chunks, never buffers entire file in memory.
pub async fn download_to_path_with_progress(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    file_name: &str,
    on_progress: &Channel<TransferEvent>,
) -> Result<(), AppError> {
    // Get remote file size for progress reporting
    let remote_metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to stat remote file '{remote_path}': {e}")))?;
    let total_bytes = remote_metadata.size.unwrap_or(0);

    // Use a sentinel transfer ID (not tracked in transfer store)
    let transfer_id = uuid::Uuid::new_v4();

    // Send Started event
    let _ = on_progress.send(TransferEvent::Started {
        transfer_id,
        file_name: file_name.to_string(),
        total_bytes,
        direction: TransferDirection::Download,
    });

    // Open remote file for reading
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| {
            let error_msg = format!("Failed to open remote file '{remote_path}': {e}");
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: error_msg.clone(),
            });
            AppError::Sftp(error_msg)
        })?;

    // Create local file (create or truncate)
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| {
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: format!("Failed to create local file: {e}"),
            });
            AppError::Io(e)
        })?;

    let mut bytes_transferred: u64 = 0;
    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| {
                let error_msg = format!("Failed to read remote file '{remote_path}': {e}");
                let _ = on_progress.send(TransferEvent::Failed {
                    transfer_id,
                    error: error_msg.clone(),
                });
                AppError::Sftp(error_msg)
            })?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| {
                let _ = on_progress.send(TransferEvent::Failed {
                    transfer_id,
                    error: format!("Failed to write local file: {e}"),
                });
                AppError::Io(e)
            })?;

        bytes_transferred += n as u64;

        // Send progress event
        let _ = on_progress.send(TransferEvent::Progress {
            transfer_id,
            bytes_transferred,
            total_bytes,
        });
    }

    local_file.flush().await.map_err(AppError::Io)?;

    // Send Completed event
    let _ = on_progress.send(TransferEvent::Completed { transfer_id });

    Ok(())
}

// ─── Recursive Folder Download ──────────────────────────

/// Walk a remote directory tree and collect every dir/file pair to mirror locally.
///
/// Returns `(dirs, files, total_bytes)` where:
/// - `dirs` is parent-before-child ordered, so `create_dir_all` calls work in sequence
/// - `files` lists `(remote_path, local_path, size)` for every regular file
/// - `total_bytes` is the sum of file sizes — used as the aggregate progress denominator
///
/// Symlinks and other non-regular entries are skipped to avoid loops and ambiguity.
async fn walk_remote_dir(
    sftp: &SftpSession,
    remote_root: &str,
    local_root: &Path,
) -> Result<
    (
        Vec<std::path::PathBuf>,
        Vec<(String, std::path::PathBuf, u64)>,
        u64,
    ),
    AppError,
> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut stack: Vec<(String, std::path::PathBuf)> =
        vec![(remote_root.to_string(), local_root.to_path_buf())];

    while let Some((rdir, ldir)) = stack.pop() {
        dirs.push(ldir.clone());
        let entries = list_dir(sftp, &rdir).await?;
        for entry in entries {
            let local_child = ldir.join(&entry.name);
            match entry.file_type {
                FileType::Directory => {
                    stack.push((entry.path.clone(), local_child));
                }
                FileType::File => {
                    total_bytes += entry.size;
                    files.push((entry.path.clone(), local_child, entry.size));
                }
                FileType::Symlink | FileType::Other => {
                    tracing::warn!(
                        "Skipping non-regular entry during folder download: {}",
                        entry.path
                    );
                }
            }
        }
    }

    Ok((dirs, files, total_bytes))
}

/// Recursively download a remote directory tree to a local path.
///
/// Reports a single aggregate transfer: pre-walks the tree to compute total bytes,
/// emits a `Started` event with the folder name, then accumulates `bytes_transferred`
/// across every file and emits `Progress` events as chunks land. Cancellation is
/// honored both between files and inside chunk loops.
///
/// Local directories are created with `create_dir_all` (parents first). On failure
/// or cancellation, partial files are left on disk for the user to inspect — they're
/// not auto-cleaned because a partial multi-GB transfer may still be useful.
pub async fn download_dir(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    transfer_id: TransferId,
    on_progress: Channel<TransferEvent>,
    cancel_token: CancellationToken,
) -> Result<TransferId, AppError> {
    let folder_name = remote_path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("folder")
        .to_string();

    // Pre-walk (cancellable). Computes total bytes for accurate progress.
    let (dirs, files, total_bytes) = tokio::select! {
        _ = cancel_token.cancelled() => {
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: "Transfer cancelled".to_string(),
            });
            return Err(AppError::TransferCancelled);
        }
        result = walk_remote_dir(sftp, remote_path, local_path) => {
            match result {
                Ok(v) => v,
                Err(e) => {
                    let _ = on_progress.send(TransferEvent::Failed {
                        transfer_id,
                        error: format!("Failed to walk remote directory: {e}"),
                    });
                    return Err(e);
                }
            }
        }
    };

    let _ = on_progress.send(TransferEvent::Started {
        transfer_id,
        file_name: folder_name,
        total_bytes,
        direction: TransferDirection::Download,
    });

    for ldir in &dirs {
        if let Err(e) = tokio::fs::create_dir_all(ldir).await {
            let error_msg = format!(
                "Failed to create local directory '{}': {e}",
                ldir.display()
            );
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: error_msg.clone(),
            });
            return Err(AppError::Io(e));
        }
    }

    let mut bytes_transferred: u64 = 0;
    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];

    for (rfile, lfile, _size) in &files {
        if cancel_token.is_cancelled() {
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: "Transfer cancelled".to_string(),
            });
            return Err(AppError::TransferCancelled);
        }

        let mut remote_file = sftp.open(rfile).await.map_err(|e| {
            let error_msg = format!("Failed to open remote file '{rfile}': {e}");
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: error_msg.clone(),
            });
            AppError::Sftp(error_msg)
        })?;

        let mut local_file = tokio::fs::File::create(lfile).await.map_err(|e| {
            let _ = on_progress.send(TransferEvent::Failed {
                transfer_id,
                error: format!("Failed to create local file '{}': {e}", lfile.display()),
            });
            AppError::Io(e)
        })?;

        loop {
            tokio::select! {
                _ = cancel_token.cancelled() => {
                    let _ = local_file.flush().await;
                    drop(local_file);
                    let _ = on_progress.send(TransferEvent::Failed {
                        transfer_id,
                        error: "Transfer cancelled".to_string(),
                    });
                    return Err(AppError::TransferCancelled);
                }
                result = remote_file.read(&mut buf) => {
                    match result {
                        Ok(0) => {
                            local_file.flush().await.map_err(AppError::Io)?;
                            break;
                        }
                        Ok(n) => {
                            local_file.write_all(&buf[..n]).await.map_err(|e| {
                                let _ = on_progress.send(TransferEvent::Failed {
                                    transfer_id,
                                    error: format!("Failed to write local file: {e}"),
                                });
                                AppError::Io(e)
                            })?;
                            bytes_transferred += n as u64;
                            let _ = on_progress.send(TransferEvent::Progress {
                                transfer_id,
                                bytes_transferred,
                                total_bytes,
                            });
                        }
                        Err(e) => {
                            let error_msg = format!("Failed to read remote file '{rfile}': {e}");
                            let _ = on_progress.send(TransferEvent::Failed {
                                transfer_id,
                                error: error_msg.clone(),
                            });
                            return Err(AppError::Sftp(error_msg));
                        }
                    }
                }
            }
        }
    }

    let _ = on_progress.send(TransferEvent::Completed { transfer_id });
    Ok(transfer_id)
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_permissions_file() {
        let perms = format_unix_permissions(0o644, &FileType::File);
        assert_eq!(perms, "-rw-r--r--");
    }

    #[test]
    fn format_permissions_directory() {
        let perms = format_unix_permissions(0o755, &FileType::Directory);
        assert_eq!(perms, "drwxr-xr-x");
    }

    #[test]
    fn format_permissions_symlink() {
        let perms = format_unix_permissions(0o777, &FileType::Symlink);
        assert_eq!(perms, "lrwxrwxrwx");
    }

    #[test]
    fn format_permissions_no_access() {
        let perms = format_unix_permissions(0o000, &FileType::File);
        assert_eq!(perms, "----------");
    }

    #[test]
    fn format_permissions_executable() {
        let perms = format_unix_permissions(0o755, &FileType::File);
        assert_eq!(perms, "-rwxr-xr-x");
    }

    #[test]
    fn format_permissions_with_extra_bits() {
        // Regular file mode (0o100755) — no special bits
        let perms = format_unix_permissions(0o100755, &FileType::File);
        assert_eq!(perms, "-rwxr-xr-x");
    }

    #[test]
    fn format_permissions_setuid() {
        let perms = format_unix_permissions(0o4755, &FileType::File);
        assert_eq!(perms, "-rwsr-xr-x");
    }

    #[test]
    fn format_permissions_setgid() {
        let perms = format_unix_permissions(0o2755, &FileType::Directory);
        assert_eq!(perms, "drwxr-sr-x");
    }

    #[test]
    fn format_permissions_sticky() {
        let perms = format_unix_permissions(0o1777, &FileType::Directory);
        assert_eq!(perms, "drwxrwxrwt");
    }

    #[test]
    fn format_permissions_setuid_no_exec() {
        let perms = format_unix_permissions(0o4644, &FileType::File);
        assert_eq!(perms, "-rwSr--r--");
    }

    #[test]
    fn format_permissions_sticky_no_exec() {
        let perms = format_unix_permissions(0o1666, &FileType::Directory);
        assert_eq!(perms, "drw-rw-rwT");
    }
}
