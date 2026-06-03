// commands/proxmox.rs — Proxmox LXC management Tauri command handlers
//
// Exposes 6 commands:
//   proxmox_list_lxc          — run `pct list`, parse, return rows + availability
//   proxmox_lifecycle_action  — run pct start/stop/reboot on a validated VMID
//   proxmox_list_snapshots    — run `pct listsnapshot <vmid>`, parse, return rows
//   proxmox_create_snapshot   — run `pct snapshot <vmid> <name>`
//   proxmox_rollback_snapshot — run `pct rollback <vmid> <name>`
//   proxmox_delete_snapshot   — run `pct delsnapshot <vmid> <name>`
//
// Pattern mirrors commands/docker.rs:
//   1. Brief lock: validate session + open SSH channel + release lock.
//   2. run_on_channel outside the lock (no lock held across I/O).
//   3. Validate VMIDs / snapshot names at the Rust boundary (defense-in-depth).
//
// INJECTION SAFETY:
//   VMIDs from the frontend are passed through validate_vmid → stored as u32 →
//   formatted back as decimal in command builders. Snapshot names through
//   validate_snapshot_name. No raw string interpolation.

use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::exec::{run_on_channel, ExecOptions};
use crate::ssh::proxmox::{
    build_delsnapshot_command, build_lifecycle_command, build_listsnapshot_command,
    build_rollback_command, build_snapshot_command, is_pct_unavailable, parse_pct_list,
    parse_pct_listsnapshot, validate_snapshot_name, validate_vmid, LxcAction, LxcRow, SnapshotRow,
};
use crate::state::{AppState, SessionId, SessionState};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Timeout for pct list / lifecycle / snapshot ops.
const PCT_CMD_TIMEOUT_SECS: u64 = 20;

// ─── proxmox_list_lxc ────────────────────────────────────────────────────────

const PCT_LIST_COMMAND: &str = "pct list";

/// Result returned by proxmox_list_lxc.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLxcResult {
    /// LXC rows. Empty when pct is available but no containers exist.
    pub containers: Vec<LxcRow>,
    /// Whether pct is not available on this remote host.
    /// When true, the UI should show an unavailable state.
    pub pct_unavailable: bool,
}

/// Inner logic extracted for unit-testability.
pub(crate) async fn proxmox_list_lxc_inner(
    state: &AppState,
    session_id: SessionId,
) -> Result<ListLxcResult, AppError> {
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
        timeout_secs: PCT_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, PCT_LIST_COMMAND, opts, Some(cancel_token)).await?;

    tracing::debug!(
        "proxmox_list_lxc: session={session_id} exit_code={:?} stdout_len={}",
        output.exit_code,
        output.stdout.len()
    );

    if is_pct_unavailable(output.exit_code, &output.stderr) {
        tracing::info!("proxmox_list_lxc: session={session_id} pct not available");
        return Ok(ListLxcResult {
            containers: vec![],
            pct_unavailable: true,
        });
    }

    let containers = parse_pct_list(&output.stdout);
    Ok(ListLxcResult {
        containers,
        pct_unavailable: false,
    })
}

/// List all LXC containers on a remote Proxmox host via `pct list`.
#[tauri::command]
pub async fn proxmox_list_lxc(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<ListLxcResult, AppError> {
    proxmox_list_lxc_inner(&state, session_id).await
}

// ─── proxmox_lifecycle_action ─────────────────────────────────────────────────

/// Inner logic for proxmox_lifecycle_action — extracted for unit tests.
pub(crate) async fn proxmox_lifecycle_action_inner(
    state: &AppState,
    session_id: SessionId,
    vmid_str: String,
    action: LxcAction,
) -> Result<(), AppError> {
    // Re-validate the VMID at the Rust boundary (defense-in-depth).
    let vmid = validate_vmid(&vmid_str)?;

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

    let command = build_lifecycle_command(&action, vmid);
    tracing::debug!("proxmox_lifecycle_action: session={session_id} command={command:?}");

    let opts = ExecOptions {
        timeout_secs: PCT_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    if output.exit_code != Some(0) {
        let msg = if output.stderr.is_empty() {
            format!("pct command failed (exit {:?})", output.exit_code)
        } else {
            output.stderr.trim().to_string()
        };
        return Err(AppError::Other(msg));
    }

    Ok(())
}

/// Run a lifecycle action (start/stop/reboot) on a remote LXC container.
#[tauri::command]
pub async fn proxmox_lifecycle_action(
    state: State<'_, AppState>,
    session_id: Uuid,
    vmid: String,
    action: LxcAction,
) -> Result<(), AppError> {
    proxmox_lifecycle_action_inner(&state, session_id, vmid, action).await
}

// ─── proxmox_list_snapshots ───────────────────────────────────────────────────

/// Result returned by proxmox_list_snapshots.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSnapshotsResult {
    pub snapshots: Vec<SnapshotRow>,
}

/// Inner logic for proxmox_list_snapshots.
pub(crate) async fn proxmox_list_snapshots_inner(
    state: &AppState,
    session_id: SessionId,
    vmid_str: String,
) -> Result<ListSnapshotsResult, AppError> {
    let vmid = validate_vmid(&vmid_str)?;

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

    let command = build_listsnapshot_command(vmid);
    let opts = ExecOptions {
        timeout_secs: PCT_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;
    let snapshots = parse_pct_listsnapshot(&output.stdout);
    Ok(ListSnapshotsResult { snapshots })
}

/// List snapshots for a specific LXC container.
#[tauri::command]
pub async fn proxmox_list_snapshots(
    state: State<'_, AppState>,
    session_id: Uuid,
    vmid: String,
) -> Result<ListSnapshotsResult, AppError> {
    proxmox_list_snapshots_inner(&state, session_id, vmid).await
}

// ─── proxmox_create_snapshot ──────────────────────────────────────────────────

/// Inner logic for proxmox_create_snapshot.
pub(crate) async fn proxmox_create_snapshot_inner(
    state: &AppState,
    session_id: SessionId,
    vmid_str: String,
    snapshot_name: String,
) -> Result<(), AppError> {
    let vmid = validate_vmid(&vmid_str)?;
    let validated_name = validate_snapshot_name(&snapshot_name)?.to_owned();

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

    let command = build_snapshot_command(vmid, &validated_name);
    tracing::debug!("proxmox_create_snapshot: session={session_id} command={command:?}");

    let opts = ExecOptions {
        timeout_secs: PCT_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    if output.exit_code != Some(0) {
        let msg = if output.stderr.is_empty() {
            format!("pct snapshot failed (exit {:?})", output.exit_code)
        } else {
            output.stderr.trim().to_string()
        };
        return Err(AppError::Other(msg));
    }

    Ok(())
}

/// Create a snapshot for an LXC container.
#[tauri::command]
pub async fn proxmox_create_snapshot(
    state: State<'_, AppState>,
    session_id: Uuid,
    vmid: String,
    snapshot_name: String,
) -> Result<(), AppError> {
    proxmox_create_snapshot_inner(&state, session_id, vmid, snapshot_name).await
}

// ─── proxmox_rollback_snapshot ────────────────────────────────────────────────

/// Inner logic for proxmox_rollback_snapshot.
pub(crate) async fn proxmox_rollback_snapshot_inner(
    state: &AppState,
    session_id: SessionId,
    vmid_str: String,
    snapshot_name: String,
) -> Result<(), AppError> {
    let vmid = validate_vmid(&vmid_str)?;
    let validated_name = validate_snapshot_name(&snapshot_name)?.to_owned();

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

    let command = build_rollback_command(vmid, &validated_name);
    tracing::debug!("proxmox_rollback_snapshot: session={session_id} command={command:?}");

    let opts = ExecOptions {
        timeout_secs: PCT_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    if output.exit_code != Some(0) {
        let msg = if output.stderr.is_empty() {
            format!("pct rollback failed (exit {:?})", output.exit_code)
        } else {
            output.stderr.trim().to_string()
        };
        return Err(AppError::Other(msg));
    }

    Ok(())
}

/// Roll back an LXC container to a snapshot (destructive — requires UI confirmation).
#[tauri::command]
pub async fn proxmox_rollback_snapshot(
    state: State<'_, AppState>,
    session_id: Uuid,
    vmid: String,
    snapshot_name: String,
) -> Result<(), AppError> {
    proxmox_rollback_snapshot_inner(&state, session_id, vmid, snapshot_name).await
}

// ─── proxmox_delete_snapshot ──────────────────────────────────────────────────

/// Inner logic for proxmox_delete_snapshot.
pub(crate) async fn proxmox_delete_snapshot_inner(
    state: &AppState,
    session_id: SessionId,
    vmid_str: String,
    snapshot_name: String,
) -> Result<(), AppError> {
    let vmid = validate_vmid(&vmid_str)?;
    let validated_name = validate_snapshot_name(&snapshot_name)?.to_owned();

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

    let command = build_delsnapshot_command(vmid, &validated_name);
    tracing::debug!("proxmox_delete_snapshot: session={session_id} command={command:?}");

    let opts = ExecOptions {
        timeout_secs: PCT_CMD_TIMEOUT_SECS,
        ..ExecOptions::default()
    };

    let output = run_on_channel(channel, command, opts, Some(cancel_token)).await?;

    if output.exit_code != Some(0) {
        let msg = if output.stderr.is_empty() {
            format!("pct delsnapshot failed (exit {:?})", output.exit_code)
        } else {
            output.stderr.trim().to_string()
        };
        return Err(AppError::Other(msg));
    }

    Ok(())
}

/// Delete a snapshot for an LXC container (destructive — requires UI confirmation).
#[tauri::command]
pub async fn proxmox_delete_snapshot(
    state: State<'_, AppState>,
    session_id: Uuid,
    vmid: String,
    snapshot_name: String,
) -> Result<(), AppError> {
    proxmox_delete_snapshot_inner(&state, session_id, vmid, snapshot_name).await
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio::sync::Mutex;
    use uuid::Uuid;

    use crate::ssh::proxmox::LxcAction;
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

    // ── WU4: proxmox_list_lxc error paths ────────────────────────────────────

    #[tokio::test]
    async fn list_lxc_session_not_found() {
        let state = make_empty_state();
        let result = super::proxmox_list_lxc_inner(&state, Uuid::new_v4()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn list_lxc_not_connected() {
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
        let result = super::proxmox_list_lxc_inner(&state, session_id).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Not connected"), "Unexpected error: {msg}");
    }

    // ── WU4: proxmox_lifecycle_action error paths ─────────────────────────────

    #[tokio::test]
    async fn lifecycle_session_not_found() {
        let state = make_empty_state();
        let result = super::proxmox_lifecycle_action_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            LxcAction::Start,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn lifecycle_not_connected() {
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
        let result = super::proxmox_lifecycle_action_inner(
            &state,
            session_id,
            "100".to_string(),
            LxcAction::Stop,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Not connected"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn lifecycle_injection_rejected_non_numeric_vmid() {
        let state = make_empty_state();
        let result = super::proxmox_lifecycle_action_inner(
            &state,
            Uuid::new_v4(),
            "100; rm -rf /".to_string(),
            LxcAction::Start,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("injection guard") || msg.contains("Invalid VMID"),
            "Expected injection error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn lifecycle_injection_rejected_out_of_range_vmid() {
        let state = make_empty_state();
        let result = super::proxmox_lifecycle_action_inner(
            &state,
            Uuid::new_v4(),
            "99".to_string(),
            LxcAction::Start,
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("out of range") || msg.contains("Invalid VMID"),
            "Expected range error, got: {msg}"
        );
    }

    // ── WU4: proxmox_list_snapshots error paths ───────────────────────────────

    #[tokio::test]
    async fn list_snapshots_session_not_found() {
        let state = make_empty_state();
        let result =
            super::proxmox_list_snapshots_inner(&state, Uuid::new_v4(), "100".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn list_snapshots_not_connected() {
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
        let result =
            super::proxmox_list_snapshots_inner(&state, session_id, "100".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Not connected"), "Unexpected error: {msg}");
    }

    // ── WU4: proxmox_create_snapshot error paths ──────────────────────────────

    #[tokio::test]
    async fn create_snapshot_session_not_found() {
        let state = make_empty_state();
        let result = super::proxmox_create_snapshot_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            "snap1".to_string(),
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn create_snapshot_bad_name_rejected() {
        let state = make_empty_state();
        let result = super::proxmox_create_snapshot_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            "1bad; rm /".to_string(),
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("injection guard") || msg.contains("Invalid snapshot"),
            "Expected injection error, got: {msg}"
        );
    }

    // ── WU4: proxmox_rollback_snapshot error paths ────────────────────────────

    #[tokio::test]
    async fn rollback_snapshot_session_not_found() {
        let state = make_empty_state();
        let result = super::proxmox_rollback_snapshot_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            "snap1".to_string(),
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn rollback_snapshot_bad_name_rejected() {
        let state = make_empty_state();
        let result = super::proxmox_rollback_snapshot_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            "bad name!".to_string(),
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("injection guard") || msg.contains("Invalid snapshot"),
            "Expected injection error, got: {msg}"
        );
    }

    // ── WU4: proxmox_delete_snapshot error paths ──────────────────────────────

    #[tokio::test]
    async fn delete_snapshot_session_not_found() {
        let state = make_empty_state();
        let result = super::proxmox_delete_snapshot_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            "snap1".to_string(),
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Session not found"), "Unexpected error: {msg}");
    }

    #[tokio::test]
    async fn delete_snapshot_bad_name_rejected() {
        let state = make_empty_state();
        let result = super::proxmox_delete_snapshot_inner(
            &state,
            Uuid::new_v4(),
            "100".to_string(),
            "; ls /".to_string(),
        )
        .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("injection guard") || msg.contains("Invalid snapshot"),
            "Expected injection error, got: {msg}"
        );
    }
}
