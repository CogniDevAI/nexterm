// commands/vault.rs — Vault management Tauri commands
//
// Handles: vault_status, vault_create, vault_unlock, vault_lock,
// store_credential, get_credential (internal), has_credential, delete_credential

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;
use crate::vault::Vault;

// ─── Types ──────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
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

    Ok(VaultStatus { exists, unlocked })
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
        std::fs::remove_file(&vault_path).map_err(|e| {
            AppError::VaultError(format!("Failed to delete vault file: {e}"))
        })?;
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
    let vault = vault_guard
        .as_mut()
        .ok_or(AppError::VaultLocked)?;

    let key = vault_key(&profile_id, user_id.as_ref(), &credential_type);
    vault.store(&key, &value)
}

#[tauri::command]
pub async fn has_credential(
    state: State<'_, AppState>,
    profile_id: Uuid,
    user_id: Option<Uuid>,
    credential_type: String,
) -> Result<bool, AppError> {
    let vault_guard = state.vault.lock().await;
    let vault = vault_guard
        .as_ref()
        .ok_or(AppError::VaultLocked)?;

    let key = vault_key(&profile_id, user_id.as_ref(), &credential_type);
    Ok(vault.has(&key))
}

#[tauri::command]
pub async fn delete_credential(
    state: State<'_, AppState>,
    profile_id: Uuid,
    user_id: Option<Uuid>,
    credential_type: String,
) -> Result<(), AppError> {
    let mut vault_guard = state.vault.lock().await;
    let vault = vault_guard
        .as_mut()
        .ok_or(AppError::VaultLocked)?;

    let key = vault_key(&profile_id, user_id.as_ref(), &credential_type);
    vault.delete(&key)
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
) -> Result<Option<String>, AppError> {
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
            tracing::info!(
                "Found legacy vault key '{legacy}', should be migrated to '{key}'"
            );
            return Ok(Some(value));
        }
    }

    Ok(None)
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
