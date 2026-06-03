// commands/docker.rs — Docker-over-SSH Tauri command handlers
//
// Exposes 3 commands:
//   docker_list_containers  — run `docker ps -a --format '{{json .}}'`, parse, return rows
//   docker_lifecycle_action — run docker start/stop/restart/rm on a validated container id
//   docker_get_logs         — run `docker logs --tail 200 <id>`, return stdout
//
// Pattern mirrors commands/exec.rs:
//   1. Lock sessions briefly → validate state → open SSH channel → release lock.
//   2. Call run_on_channel outside the lock (no lock held across I/O).
//   3. Parse / validate output in pure Rust before returning to the frontend.
//
// INJECTION SAFETY: every container id arriving from the frontend is passed
// through validate_container_id BEFORE use in any command string.

use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::docker::{
    build_lifecycle_command, build_logs_command, is_docker_unavailable, parse_docker_ps_output,
    validate_container_id, ContainerRow, DockerAction,
};
use crate::ssh::exec::{run_on_channel, ExecOptions};
use crate::state::{AppState, SessionId, SessionState};

// ─── Constants ───────────────────────────────────────────────────────────────

/// docker ps / lifecycle timeout — shorter than exec default (30 s) because
/// these commands are expected to be fast.
const DOCKER_CMD_TIMEOUT_SECS: u64 = 15;

/// docker logs timeout — slightly longer because log output can be larger.
const DOCKER_LOGS_TIMEOUT_SECS: u64 = 20;

// ─── docker_list_containers ──────────────────────────────────────────────────

/// The `docker ps` format string (not-available if docker is absent).
const DOCKER_PS_COMMAND: &str = "docker ps -a --format '{{json .}}'";

/// Result returned by docker_list_containers.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListContainersResult {
    /// Container rows. Empty when Docker is available but no containers exist.
    pub containers: Vec<ContainerRow>,
    /// Whether Docker is not available on this remote host.
    /// When true, containers will be empty and the UI should show an unavailable state.
    pub docker_unavailable: bool,
}

/// Inner logic extracted for unit-testability (no Tauri State wrapper).
pub(crate) async fn docker_list_containers_inner(
    state: &AppState,
    session_id: SessionId,
) -> Result<ListContainersResult, AppError> {
    // Brief lock: validate session, open channel, release.
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
    }; // lock released

    let opts = ExecOptions {
        timeout_secs: DOCKER_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, DOCKER_PS_COMMAND, opts, Some(cancel_token)).await?;

    tracing::debug!(
        "docker_list_containers: session={session_id} exit_code={:?} stdout_len={}",
        output.exit_code,
        output.stdout.len()
    );

    if is_docker_unavailable(output.exit_code, &output.stderr) {
        tracing::info!("docker_list_containers: session={session_id} docker not available");
        return Ok(ListContainersResult {
            containers: vec![],
            docker_unavailable: true,
        });
    }

    let containers = parse_docker_ps_output(&output.stdout);
    Ok(ListContainersResult {
        containers,
        docker_unavailable: false,
    })
}

/// List all containers on a remote host via `docker ps -a`.
///
/// Returns a `ListContainersResult` with the container rows and an
/// `dockerUnavailable` flag. The frontend must check the flag before
/// rendering the container table.
#[tauri::command]
pub async fn docker_list_containers(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<ListContainersResult, AppError> {
    docker_list_containers_inner(&state, session_id).await
}

// ─── docker_lifecycle_action ─────────────────────────────────────────────────

/// Inner logic for docker_lifecycle_action — extracted for unit tests.
pub(crate) async fn docker_lifecycle_action_inner(
    state: &AppState,
    session_id: SessionId,
    container_id: String,
    action: DockerAction,
) -> Result<(), AppError> {
    // Re-validate the container id at the Rust boundary (defense-in-depth).
    let validated_id = validate_container_id(&container_id)?.to_owned();

    // Brief lock: validate, open channel, release.
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
    };

    let command = build_lifecycle_command(&action, &validated_id);
    tracing::debug!("docker_lifecycle_action: session={session_id} command={command:?}");

    let opts = ExecOptions {
        timeout_secs: DOCKER_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    if output.exit_code != Some(0) {
        let msg = if output.stderr.is_empty() {
            format!("docker command failed (exit {:?})", output.exit_code)
        } else {
            output.stderr.trim().to_string()
        };
        return Err(AppError::Other(msg));
    }

    Ok(())
}

/// Run a lifecycle action (start/stop/restart/rm) on a remote container.
///
/// The container_id is validated before use — any id containing shell
/// metacharacters is rejected with an injection error.
#[tauri::command]
pub async fn docker_lifecycle_action(
    state: State<'_, AppState>,
    session_id: Uuid,
    container_id: String,
    action: DockerAction,
) -> Result<(), AppError> {
    docker_lifecycle_action_inner(&state, session_id, container_id, action).await
}

// ─── docker_get_logs ─────────────────────────────────────────────────────────

/// Result of docker_get_logs.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLogsResult {
    /// Log output (stdout + stderr merged as docker logs emits them).
    pub logs: String,
    /// True when the output hit the 10 MB cap and was truncated.
    pub truncated: bool,
}

/// Inner logic for docker_get_logs — extracted for unit tests.
pub(crate) async fn docker_get_logs_inner(
    state: &AppState,
    session_id: SessionId,
    container_id: String,
) -> Result<GetLogsResult, AppError> {
    // Re-validate at the Rust boundary.
    let validated_id = validate_container_id(&container_id)?.to_owned();

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
    };

    let command = build_logs_command(&validated_id);
    tracing::debug!("docker_get_logs: session={session_id} command={command:?}");

    let opts = ExecOptions {
        timeout_secs: DOCKER_LOGS_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    // docker logs writes to stderr by default (it uses stderr even for log lines).
    // Combine both streams; prefer stdout when available.
    let logs = if output.stdout.is_empty() {
        output.stderr.clone()
    } else {
        output.stdout.clone()
    };

    let truncated = output.stdout_truncated || output.stderr_truncated;

    Ok(GetLogsResult { logs, truncated })
}

/// Get the last 200 log lines from a remote container.
///
/// Uses `docker logs --tail 200 <id>` (one-shot, not streaming).
/// Returns the log text and a truncation flag if the 10 MB cap was hit.
///
/// Note: live log following (`-f`) is deferred to v2 — run_on_channel is
/// one-shot and does not support streaming output to the frontend.
#[tauri::command]
pub async fn docker_get_logs(
    state: State<'_, AppState>,
    session_id: Uuid,
    container_id: String,
) -> Result<GetLogsResult, AppError> {
    docker_get_logs_inner(&state, session_id, container_id).await
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio::sync::Mutex;
    use uuid::Uuid;

    use crate::state::{AppState, SessionHandle, SessionState};

    // ── Helpers ──────────────────────────────────────────────────────────────

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
            monitoring_task: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            remote_forward_registry: None,
        }
    }

    // ── WU4: docker_list_containers error paths ──────────────────────────────

    #[tokio::test]
    async fn list_containers_session_not_found() {
        let state = make_empty_state();
        let result = super::docker_list_containers_inner(&state, Uuid::new_v4()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn list_containers_not_connected() {
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
        let result = super::docker_list_containers_inner(&state, session_id).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Not connected"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn lifecycle_action_session_not_found() {
        let state = make_empty_state();
        let result = super::docker_lifecycle_action_inner(
            &state,
            Uuid::new_v4(),
            "abc123".to_string(),
            crate::ssh::docker::DockerAction::Start,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn lifecycle_action_not_connected() {
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
        let result = super::docker_lifecycle_action_inner(
            &state,
            session_id,
            "abc123".to_string(),
            crate::ssh::docker::DockerAction::Stop,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Not connected"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn lifecycle_action_injection_rejected() {
        // An injected container_id never reaches the SSH layer — rejected at Rust boundary.
        let state = make_empty_state();
        let result = super::docker_lifecycle_action_inner(
            &state,
            Uuid::new_v4(),
            "abc; rm -rf /".to_string(),
            crate::ssh::docker::DockerAction::Start,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("injection guard") || msg.contains("Invalid container"),
            "Expected injection error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn get_logs_session_not_found() {
        let state = make_empty_state();
        let result =
            super::docker_get_logs_inner(&state, Uuid::new_v4(), "abc123".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn get_logs_not_connected() {
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
        let result = super::docker_get_logs_inner(&state, session_id, "abc123".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Not connected"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn get_logs_injection_rejected() {
        let state = make_empty_state();
        let result =
            super::docker_get_logs_inner(&state, Uuid::new_v4(), "abc$(id)".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("injection guard") || msg.contains("Invalid container"),
            "Expected injection error, got: {msg}"
        );
    }
}
