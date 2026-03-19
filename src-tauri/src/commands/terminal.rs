// commands/terminal.rs — Terminal Tauri commands
//
// Handles: open_terminal, write_terminal, resize_terminal, close_terminal
//
// Terminal output is streamed from Rust to frontend via Tauri Channel<TerminalEvent>.
// Terminal input is sent from frontend to Rust via invoke('write_terminal').

use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::ssh::terminal as term;
use crate::state::{AppState, SessionId, SessionState, TerminalEvent, TerminalId};

// ─── Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn open_terminal(
    state: State<'_, AppState>,
    session_id: SessionId,
    cols: u32,
    rows: u32,
    on_output: Channel<TerminalEvent>,
) -> Result<TerminalId, AppError> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    // Must be connected
    if session.state != SessionState::Connected {
        return Err(AppError::NotConnected);
    }

    let ssh_handle = session
        .ssh_handle
        .as_ref()
        .ok_or(AppError::NotConnected)?;

    // Open PTY channel (includes spawning reader task)
    let terminal_handle = term::open_pty(ssh_handle, cols, rows, on_output).await?;
    let terminal_id = terminal_handle.id;

    // Store the terminal handle in the session
    session.terminals.insert(terminal_id, terminal_handle);

    tracing::info!("Opened terminal {terminal_id} on session {session_id} ({cols}x{rows})");

    Ok(terminal_id)
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    session_id: SessionId,
    terminal_id: TerminalId,
    data: Vec<u8>,
) -> Result<(), AppError> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    let terminal = session
        .terminals
        .get(&terminal_id)
        .ok_or(AppError::TerminalNotFound(terminal_id))?;

    term::write_data(&terminal.command_tx, &data).await
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    session_id: SessionId,
    terminal_id: TerminalId,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    let terminal = session
        .terminals
        .get_mut(&terminal_id)
        .ok_or(AppError::TerminalNotFound(terminal_id))?;

    term::resize_pty(&terminal.command_tx, cols, rows).await?;

    // Update stored dimensions
    terminal.cols = cols;
    terminal.rows = rows;

    Ok(())
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    session_id: SessionId,
    terminal_id: TerminalId,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound(session_id))?;

    let terminal = session
        .terminals
        .remove(&terminal_id)
        .ok_or(AppError::TerminalNotFound(terminal_id))?;

    // Send close command through the mpsc channel.
    // The reader task will close the SSH channel and exit cleanly.
    term::close_terminal(&terminal.command_tx).await?;

    // Wait briefly for the reader task to finish, then abort if it hasn't.
    // The Close command should cause it to exit, but we have a safety net.
    if let Some(task) = terminal.reader_task {
        // Give the task a moment to process the Close command
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), task).await;
    }

    tracing::info!("Closed terminal {terminal_id} on session {session_id}");

    Ok(())
}
