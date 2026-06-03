// commands/monitoring.rs — Tauri commands for remote system monitoring
//
// Exposes:
//   start_monitoring — spawn a per-session sampler task, stream MetricEvent via Channel
//   stop_monitoring  — cancel the sampler task for a session
//   kill_remote_process — send TERM/KILL to a remote PID (injection-safe: pid is u32)
//
// Pattern mirrors exec.rs: brief lock to open channel, release lock, then run I/O.

use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::{AppState, MetricEvent, SessionId, SessionState};

// ─── KillSignal ─────────────────────────────────────────────────────────────

/// Signal to send to a remote process via kill(1).
///
/// The enum prevents shell injection: the signal name is derived from a closed
/// set of variants, never from a user-supplied string.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KillSignal {
    /// SIGTERM — graceful termination request.
    Term,
    /// SIGKILL — forceful unconditional kill.
    Kill,
}

impl KillSignal {
    /// Returns the signal name as used by kill(1) (e.g. "TERM", "KILL").
    pub fn as_str(&self) -> &'static str {
        match self {
            KillSignal::Term => "TERM",
            KillSignal::Kill => "KILL",
        }
    }
}

// ─── build_kill_command ──────────────────────────────────────────────────────

/// Construct the kill command string.
///
/// `pid` is a `u32` — no string interpolation from user input is possible.
/// The signal name comes from the closed `KillSignal` enum.
/// Format: `kill -<SIGNAL> <pid>`
pub fn build_kill_command(pid: u32, signal: &KillSignal) -> String {
    format!("kill -{} {}", signal.as_str(), pid)
}

// ─── Inner logic (extracted for testability) ─────────────────────────────────

/// Core kill implementation. Accepts plain `&AppState` for unit testing.
pub(crate) async fn kill_remote_process_inner(
    state: &AppState,
    session_id: SessionId,
    pid: u32,
    signal: KillSignal,
) -> Result<(), AppError> {
    if pid == 0 {
        return Err(AppError::Other("Invalid PID: must be > 0".to_string()));
    }

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
        let channel = ssh_handle
            .channel_open_session()
            .await
            .map_err(AppError::Ssh)?;
        (channel, cancel_token)
    }; // lock released here

    let cmd = build_kill_command(pid, &signal);
    let opts = crate::ssh::exec::ExecOptions {
        timeout_secs: 5,
        ..Default::default()
    };

    tracing::debug!(
        "kill_remote_process: session={session_id} pid={pid} signal={:?}",
        signal
    );

    let output = crate::ssh::exec::run_on_channel(channel, cmd, opts, Some(cancel_token)).await?;

    // kill returns 0 on success, 1 if the process doesn't exist (already dead).
    // Both are acceptable outcomes — the process is gone or was already gone.
    if output.exit_code == Some(0) || output.exit_code == Some(1) {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "kill exited with code {:?}: {}",
            output.exit_code,
            output.stderr.trim()
        )))
    }
}

// ─── start_monitoring ────────────────────────────────────────────────────────

/// Spawn the monitoring sampler for `session_id`.
///
/// `interval_secs` controls the sampling interval (minimum 1, default 3).
/// `on_event` is the Tauri Channel that receives `MetricEvent` values.
///
/// Calling start_monitoring on a session that is already being monitored
/// replaces the previous sampler (the old task is aborted first).
#[tauri::command]
pub async fn start_monitoring(
    state: State<'_, AppState>,
    session_id: Uuid,
    interval_secs: Option<u64>,
    on_event: Channel<MetricEvent>,
) -> Result<(), AppError> {
    let interval = interval_secs.unwrap_or(3).max(1);

    crate::ssh::monitoring::start_monitoring_task(&state, session_id, interval, on_event).await
}

// ─── stop_monitoring ─────────────────────────────────────────────────────────

/// Stop the monitoring sampler for `session_id` (if running).
///
/// Idempotent: safe to call even if no sampler is active.
#[tauri::command]
pub async fn stop_monitoring(state: State<'_, AppState>, session_id: Uuid) -> Result<(), AppError> {
    crate::ssh::monitoring::stop_monitoring_task(&state, session_id).await
}

// ─── kill_remote_process ────────────────────────────────────────────────────

/// Send a signal to a remote process.
///
/// `pid` must be > 0 (validated here and again in `kill_remote_process_inner`).
/// `signal` is a closed enum — no injection surface.
#[tauri::command]
pub async fn kill_remote_process(
    state: State<'_, AppState>,
    session_id: Uuid,
    pid: u32,
    signal: KillSignal,
) -> Result<(), AppError> {
    kill_remote_process_inner(&state, session_id, pid, signal).await
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio::sync::Mutex;
    use uuid::Uuid;

    use super::*;
    use crate::state::{AppState, SessionHandle, SessionState};

    // ── WU2: build_kill_command — injection-safety ─────────────────────────

    #[test]
    fn kill_term_formats_correctly() {
        let cmd = build_kill_command(42, &KillSignal::Term);
        assert_eq!(cmd, "kill -TERM 42");
    }

    #[test]
    fn kill_kill_formats_correctly() {
        let cmd = build_kill_command(1, &KillSignal::Kill);
        assert_eq!(cmd, "kill -KILL 1");
    }

    #[test]
    fn kill_large_pid_no_overflow() {
        let cmd = build_kill_command(u32::MAX, &KillSignal::Term);
        assert_eq!(cmd, format!("kill -TERM {}", u32::MAX));
    }

    #[test]
    fn kill_signal_as_str_matches_enum() {
        assert_eq!(KillSignal::Term.as_str(), "TERM");
        assert_eq!(KillSignal::Kill.as_str(), "KILL");
    }

    // ── WU2: kill error paths ─────────────────────────────────────────────

    fn make_empty_state() -> AppState {
        AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            ..Default::default()
        }
    }

    fn make_disconnected_session(id: Uuid) -> SessionHandle {
        SessionHandle {
            id,
            profile: Default::default(),
            user_id: Uuid::nil(),
            username: "test".to_string(),
            state: SessionState::Disconnected,
            ssh_handle: None,
            bastion_handle: None,
            terminals: HashMap::new(),
            sftp: None,
            tunnels: HashMap::new(),
            keepalive_task: None,
            monitoring_task: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            remote_forward_registry: None,
        }
    }

    #[tokio::test]
    async fn kill_pid_zero_returns_error() {
        let state = make_empty_state();
        let result = kill_remote_process_inner(&state, Uuid::new_v4(), 0, KillSignal::Term).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Invalid PID"),
            "expected invalid PID error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn kill_session_not_found_returns_error() {
        let state = make_empty_state();
        let result = kill_remote_process_inner(&state, Uuid::new_v4(), 42, KillSignal::Term).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Session not found"),
            "expected session not found, got: {msg}"
        );
    }

    #[tokio::test]
    async fn kill_not_connected_returns_error() {
        let session_id = Uuid::new_v4();
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut g = sessions.lock().await;
            g.insert(session_id, make_disconnected_session(session_id));
        }
        let state = AppState {
            sessions,
            ..Default::default()
        };
        let result = kill_remote_process_inner(&state, session_id, 42, KillSignal::Term).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Not connected"),
            "expected not connected, got: {msg}"
        );
    }
}
