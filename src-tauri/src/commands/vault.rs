// commands/vault.rs — Vault management Tauri commands
//
// Handles: vault_status, vault_create, vault_unlock, vault_lock,
// store_credential, get_credential (internal), has_credential, delete_credential

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::AppError;
use crate::state::{AppState, AutoLockState};
use crate::vault::Vault;

// ─── Types ──────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    /// True when a vault file exists but is not currently unlocked in memory.
    /// Mirror of `!unlocked` for an existing vault; surfaced explicitly so the
    /// future lock UI can distinguish "needs unlock" from "needs creation".
    pub locked: bool,
    /// Configured idle auto-lock timeout in seconds (0 = auto-lock disabled).
    pub idle_timeout_secs: u64,
    /// Seconds since the last vault activity. Only meaningful while unlocked.
    pub idle_seconds: u64,
    /// Seconds remaining before idle auto-lock fires, or `None` when auto-lock
    /// is disabled (timeout 0). Only meaningful while unlocked.
    pub seconds_until_lock: Option<u64>,
}

// ─── Helpers ────────────────────────────────────────────

/// Get the app data dir from the Tauri app handle
fn get_app_data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok()
}

/// Build vault key in the new format: `{profile_id}:{user_id}:{cred_type}`.
/// If `user_id` is None, falls back to the legacy format `{profile_id}:{cred_type}`.
fn vault_key(profile_id: &Uuid, user_id: Option<&Uuid>, credential_type: &str) -> String {
    match user_id {
        Some(uid) => format!("{profile_id}:{uid}:{credential_type}"),
        None => format!("{profile_id}:{credential_type}"),
    }
}

/// Build legacy vault key: `{profile_id}:{cred_type}` (pre-multi-user format).
fn vault_key_legacy(profile_id: &Uuid, credential_type: &str) -> String {
    format!("{profile_id}:{credential_type}")
}

// ─── Vault Commands ─────────────────────────────────────

#[tauri::command]
pub async fn vault_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<VaultStatus, AppError> {
    let data_dir = get_app_data_dir(&app)
        .ok_or_else(|| AppError::VaultError("Cannot determine app data directory".into()))?;

    let exists = Vault::exists(&data_dir);
    let vault_guard = state.vault.lock().await;
    let unlocked = vault_guard
        .as_ref()
        .map(|v| v.is_unlocked())
        .unwrap_or(false);
    // Release the vault mutex before touching auto-lock state. They are
    // independent locks; we never hold both at once, so no ordering hazard with
    // the background task can arise.
    drop(vault_guard);

    Ok(VaultStatus {
        exists,
        unlocked,
        locked: exists && !unlocked,
        idle_timeout_secs: state.auto_lock.idle_timeout_secs(),
        idle_seconds: state.auto_lock.idle_seconds(),
        seconds_until_lock: state.auto_lock.seconds_until_lock(),
    })
}

/// Configure the vault idle auto-lock timeout, in seconds. A value of `0`
/// disables idle auto-lock entirely. Default is 15 minutes (900s).
#[tauri::command]
pub async fn vault_set_idle_timeout(state: State<'_, AppState>, secs: u64) -> Result<(), AppError> {
    state.auto_lock.set_idle_timeout_secs(secs);
    Ok(())
}

#[tauri::command]
pub async fn vault_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    master_password: String,
) -> Result<(), AppError> {
    let data_dir = get_app_data_dir(&app)
        .ok_or_else(|| AppError::VaultError("Cannot determine app data directory".into()))?;

    if Vault::exists(&data_dir) {
        return Err(AppError::VaultError("Vault already exists".into()));
    }

    let vault = Vault::create(&data_dir, &master_password)?;
    let mut vault_guard = state.vault.lock().await;
    *vault_guard = Some(vault);
    // Creating leaves the vault unlocked — start the idle clock fresh.
    state.auto_lock.record_activity();

    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    master_password: String,
) -> Result<(), AppError> {
    let data_dir = get_app_data_dir(&app)
        .ok_or_else(|| AppError::VaultError("Cannot determine app data directory".into()))?;

    let vault = Vault::unlock(&data_dir, &master_password)?;
    let mut vault_guard = state.vault.lock().await;
    *vault_guard = Some(vault);
    // Unlocking is activity — start the idle clock fresh so the vault doesn't
    // immediately auto-lock against a stale `last_activity`.
    state.auto_lock.record_activity();

    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<(), AppError> {
    let mut vault_guard = state.vault.lock().await;
    if let Some(ref mut vault) = *vault_guard {
        vault.lock();
    }
    *vault_guard = None;
    Ok(())
}

#[tauri::command]
pub async fn vault_reset(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let data_dir = get_app_data_dir(&app)
        .ok_or_else(|| AppError::VaultError("Cannot determine app data directory".into()))?;

    // 1. Delete the vault file from disk (if it exists)
    let vault_path = data_dir.join("vault.json");
    if vault_path.exists() {
        std::fs::remove_file(&vault_path)
            .map_err(|e| AppError::VaultError(format!("Failed to delete vault file: {e}")))?;
    }
    // Also remove any lingering temp file from atomic writes
    let tmp_path = vault_path.with_extension("json.tmp");
    if tmp_path.exists() {
        let _ = std::fs::remove_file(&tmp_path);
    }

    // 2. Clear the vault from AppState (lock + drop)
    let mut vault_guard = state.vault.lock().await;
    if let Some(ref mut vault) = *vault_guard {
        vault.lock(); // zeroize derived key from memory
    }
    *vault_guard = None;

    Ok(())
}

// ─── Credential Commands ────────────────────────────────

#[tauri::command]
pub async fn store_credential(
    state: State<'_, AppState>,
    profile_id: Uuid,
    user_id: Option<Uuid>,
    credential_type: String,
    value: String,
) -> Result<(), AppError> {
    let mut vault_guard = state.vault.lock().await;
    let vault = vault_guard.as_mut().ok_or(AppError::VaultLocked)?;

    let key = vault_key(&profile_id, user_id.as_ref(), &credential_type);
    let result = vault.store(&key, &value);
    state.auto_lock.record_activity();
    result
}

#[tauri::command]
pub async fn has_credential(
    state: State<'_, AppState>,
    profile_id: Uuid,
    user_id: Option<Uuid>,
    credential_type: String,
) -> Result<bool, AppError> {
    let vault_guard = state.vault.lock().await;
    let vault = vault_guard.as_ref().ok_or(AppError::VaultLocked)?;

    let key = vault_key(&profile_id, user_id.as_ref(), &credential_type);
    let exists = vault.has(&key);
    state.auto_lock.record_activity();
    Ok(exists)
}

#[tauri::command]
pub async fn delete_credential(
    state: State<'_, AppState>,
    profile_id: Uuid,
    user_id: Option<Uuid>,
    credential_type: String,
) -> Result<(), AppError> {
    let mut vault_guard = state.vault.lock().await;
    let vault = vault_guard.as_mut().ok_or(AppError::VaultLocked)?;

    let key = vault_key(&profile_id, user_id.as_ref(), &credential_type);
    let result = vault.delete(&key);
    state.auto_lock.record_activity();
    result
}

/// Internal function: retrieve a credential from the vault.
/// Not a Tauri command — called by `ssh/session.rs` for auth resolution.
///
/// Tries the new key format `{profile_id}:{user_id}:{cred_type}` first.
/// Falls back to legacy `{profile_id}:{cred_type}` if the new key is not found.
/// On legacy hit, auto-migrates by writing the credential under the new key
/// (old key is kept for rollback safety).
pub fn get_credential_from_vault(
    vault: &Vault,
    profile_id: &Uuid,
    user_id: Option<&Uuid>,
    credential_type: &str,
) -> Result<Option<Zeroizing<String>>, AppError> {
    let key = vault_key(profile_id, user_id, credential_type);

    // Try new-format key first
    if let Some(value) = vault.get(&key)? {
        return Ok(Some(value));
    }

    // Fall back to legacy key (only if user_id was provided — otherwise we already tried the legacy format)
    if user_id.is_some() {
        let legacy = vault_key_legacy(profile_id, credential_type);
        if let Some(value) = vault.get(&legacy)? {
            // Auto-migrate: write under new key (best-effort, don't fail if vault is read-only)
            // NOTE: We can't mutate vault here since we only have &Vault.
            // Migration will happen lazily on next store_credential call or
            // can be triggered explicitly. For now, just return the legacy value.
            tracing::info!("Found legacy vault key '{legacy}', should be migrated to '{key}'");
            return Ok(Some(value));
        }
    }

    Ok(None)
}

/// Retrieve a stored credential for SSH auth resolution, recording vault
/// activity on a successful read so an actively-connecting (read-only) user
/// does not get auto-locked mid-use.
///
/// Wraps [`get_credential_from_vault`] and resets the idle timer **only** when a
/// stored credential is actually found. A miss (no stored credential — the user
/// will be prompted) is not "use" and must not reset the timer; an explicitly
/// provided password never reaches this function, so it never spuriously
/// extends the idle window either.
pub fn get_credential_for_auth(
    vault: &Vault,
    auto_lock: &AutoLockState,
    profile_id: &Uuid,
    user_id: Option<&Uuid>,
    credential_type: &str,
) -> Result<Option<Zeroizing<String>>, AppError> {
    let found = get_credential_from_vault(vault, profile_id, user_id, credential_type)?;
    if found.is_some() {
        // A stored credential was read for auth — this is genuine vault use.
        auto_lock.record_activity();
    }
    Ok(found)
}

/// Delete all credentials for a given profile from the vault.
pub async fn delete_profile_credentials(
    state: &AppState,
    profile_id: &Uuid,
) -> Result<(), AppError> {
    let mut vault_guard = state.vault.lock().await;
    if let Some(ref mut vault) = *vault_guard {
        let prefix = format!("{profile_id}:");
        vault.delete_by_prefix(&prefix)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AutoLockState;
    use std::time::{Duration, Instant};

    /// A credential READ for auth (a vault hit) must reset the idle timer so an
    /// actively-connecting, read-only user is not auto-locked mid-use.
    #[test]
    fn credential_read_for_auth_resets_idle_timer_on_hit() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::create(dir.path(), "correct-horse").unwrap();
        let profile_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let key = vault_key(&profile_id, Some(&user_id), "password");
        vault.store(&key, "s3cr3t").unwrap();

        let auto_lock = AutoLockState::default();
        auto_lock.set_idle_timeout_secs(900);
        // Place activity deep in the lock-eligible past.
        let now = Instant::now();
        auto_lock.record_activity_at(now - Duration::from_secs(901));
        assert!(
            auto_lock.should_lock_now(now),
            "precondition: stale activity should be lock-eligible"
        );

        let found =
            get_credential_for_auth(&vault, &auto_lock, &profile_id, Some(&user_id), "password")
                .unwrap();

        assert_eq!(found.map(|z| z.to_string()), Some("s3cr3t".to_string()));
        // The read reset the timer: idle elapsed is now tiny, well under timeout.
        assert!(
            auto_lock.idle_elapsed_since(Instant::now()) < Duration::from_secs(900),
            "a successful credential read must reset last_activity"
        );
        assert!(
            !auto_lock.should_lock_now(Instant::now()),
            "after a credential read the vault must not be lock-eligible"
        );
    }

    /// A vault MISS (no stored credential — the user will be prompted) is not
    /// "use" and must NOT reset the idle timer.
    #[test]
    fn credential_read_for_auth_does_not_reset_timer_on_miss() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::create(dir.path(), "correct-horse").unwrap();
        let profile_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();

        let auto_lock = AutoLockState::default();
        auto_lock.set_idle_timeout_secs(900);
        let stale = Instant::now() - Duration::from_secs(901);
        auto_lock.record_activity_at(stale);

        let found =
            get_credential_for_auth(&vault, &auto_lock, &profile_id, Some(&user_id), "password")
                .unwrap();

        assert!(found.is_none(), "no credential stored — expected a miss");
        // The timer was NOT reset: still lock-eligible against the same `now`.
        let now = Instant::now();
        assert!(
            auto_lock.should_lock_now(now),
            "a vault miss must not reset last_activity"
        );
    }

    /// Legacy-key hits also count as vault use and reset the idle timer.
    #[test]
    fn credential_read_for_auth_resets_timer_on_legacy_hit() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::create(dir.path(), "correct-horse").unwrap();
        let profile_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        // Store under the LEGACY key format (no user_id segment).
        let legacy = vault_key_legacy(&profile_id, "password");
        vault.store(&legacy, "s3cr3t").unwrap();

        let auto_lock = AutoLockState::default();
        auto_lock.set_idle_timeout_secs(900);
        let now = Instant::now();
        auto_lock.record_activity_at(now - Duration::from_secs(901));

        let found =
            get_credential_for_auth(&vault, &auto_lock, &profile_id, Some(&user_id), "password")
                .unwrap();

        assert_eq!(found.map(|z| z.to_string()), Some("s3cr3t".to_string()));
        assert!(
            !auto_lock.should_lock_now(Instant::now()),
            "a legacy-key credential read must reset last_activity"
        );
    }
}
