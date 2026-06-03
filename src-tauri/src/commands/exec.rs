// commands/exec.rs — SSH exec-and-capture Tauri command
//
// Exposes a single `ssh_exec` command that runs a one-shot remote command and
// returns its complete stdout, stderr, and exit code.
//
// Pattern:
// 1. Lock sessions briefly to open the SSH channel + capture the CancellationToken.
// 2. RELEASE the lock before calling run_on_channel (no lock held across the
//    channel event loop — mirrors tunnel.rs brief-lock pattern exactly).
// 3. Return ExecOutput (serializable, camelCase) to the frontend.

use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::exec::{self, ExecOptions, ExecOutput};
use crate::state::{AppState, SessionId, SessionState};

// ─── Inner logic (extracted for testability) ────────────

/// Core implementation of ssh_exec, accepting a plain `&AppState` reference
/// so unit tests can call it without going through Tauri's command machinery.
pub(crate) async fn ssh_exec_inner(
    state: &AppState,
    session_id: SessionId,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<ExecOutput, AppError> {
    // ── Brief lock: validate state, open channel, release ──
    //
    // The lock scope is a block so it drops BEFORE the channel event loop.
    // Holding a tokio::sync::Mutex across an await point in the channel loop
    // would deadlock: other commands (e.g. open_terminal) also need the lock.
    let (channel, cancel_token) = {
        let sessions_guard = state.sessions.lock().await;
        let session = sessions_guard
            .get(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;

        if session.state != SessionState::Connected {
            return Err(AppError::NotConnected);
        }

        let ssh_handle = session.ssh_handle.as_ref().ok_or(AppError::NotConnected)?;
        let cancel_token = session.cancel_token.clone();

        // Open the session channel while the lock is held. channel_open_session
        // sends a packet over the SSH connection; it completes quickly (one
        // round-trip) and does not require processing further ChannelMsg events,
        // so holding the lock here is safe and does not risk deadlock.
        let channel = ssh_handle
            .channel_open_session()
            .await
            .map_err(AppError::Ssh)?;

        // Guard drops here — the event loop runs without any lock.
        (channel, cancel_token)
    };

    let opts = ExecOptions {
        timeout_secs: timeout_secs.unwrap_or(ExecOptions::default().timeout_secs),
        ..ExecOptions::default()
    };

    tracing::debug!("ssh_exec: session={session_id} command={command:?}");

    let output = exec::run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    tracing::debug!(
        "ssh_exec: session={session_id} exit_code={:?} stdout_len={} stderr_len={}",
        output.exit_code,
        output.stdout.len(),
        output.stderr.len()
    );

    Ok(output)
}

// ─── Tauri command ───────────────────────────────────────

/// Run a one-shot remote command on an active SSH session.
///
/// # Arguments
/// * `session_id` — the UUID of an active Connected session.
/// * `command` — the command string to execute on the remote host.
/// * `timeout_secs` — optional timeout override (default: 30 s).
///
/// # Returns
/// `ExecOutput` with stdout, stderr, exit_code, exit_signal, and truncation flags.
///
/// # Errors
/// * `SessionNotFound` — session_id does not exist.
/// * `NotConnected` — session exists but is not in Connected state.
/// * `ExecTimeout` — command did not complete within the timeout.
/// * `Ssh` — russh channel error.
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    session_id: Uuid,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<ExecOutput, AppError> {
    ssh_exec_inner(&state, session_id, command, timeout_secs).await
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio::sync::Mutex;
    use uuid::Uuid;

    use crate::state::{AppState, SessionHandle, SessionState};

    // ── WU4: error-path tests (no live SSH needed) ──

    fn make_empty_state() -> AppState {
        AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            ..Default::default()
        }
    }

    fn make_disconnected_session(session_id: Uuid) -> SessionHandle {
        SessionHandle {
            id: session_id,
            profile: Default::default(),
            user_id: Uuid::nil(),
            username: "testuser".to_string(),
            state: SessionState::Disconnected,
            ssh_handle: None,
            bastion_handle: None,
            terminals: HashMap::new(),
            sftp: None,
            tunnels: HashMap::new(),
            keepalive_task: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            remote_forward_registry: None,
        }
    }

    #[tokio::test]
    async fn session_not_found_returns_error() {
        let state = make_empty_state();
        let result = super::ssh_exec_inner(&state, Uuid::new_v4(), "ls".to_string(), None).await;

        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Session not found"),
            "Unexpected error message: {msg}"
        );
    }

    #[tokio::test]
    async fn not_connected_returns_error() {
        let session_id = Uuid::new_v4();
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut guard = sessions.lock().await;
            guard.insert(session_id, make_disconnected_session(session_id));
        }

        let state = AppState {
            sessions,
            ..Default::default()
        };

        let result = super::ssh_exec_inner(&state, session_id, "ls".to_string(), None).await;

        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Not connected"),
            "Unexpected error message: {msg}"
        );
    }
}
