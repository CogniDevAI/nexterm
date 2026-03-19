// commands/profile.rs — Profile CRUD Tauri commands
//
// Handles: save_profile, load_profiles, delete_profile, get_profile,
//          export_profiles, import_profiles
//
// Credential storage is now handled by commands/vault.rs via the encrypted vault.

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use rand::RngCore;

use crate::error::AppError;
use crate::profile::{self, AuthMethodConfig, ConnectionProfile};
use crate::state::{AppState, SessionState};

// ─── Helpers ────────────────────────────────────────────

/// Get the app data dir from the Tauri app handle
fn get_app_data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok()
}

// ─── Profile CRUD Commands ──────────────────────────────

#[tauri::command]
pub async fn save_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut profile_data: ConnectionProfile,
) -> Result<Uuid, AppError> {
    profile_data.validate()?;
    profile_data.updated_at = chrono::Utc::now();

    let mut profiles = state.profiles.lock().await;
    let app_data_dir = get_app_data_dir(&app);

    // Check if updating existing or creating new
    if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile_data.id) {
        *existing = profile_data.clone();
    } else {
        // New profile — ensure it has a fresh created_at
        profile_data.created_at = chrono::Utc::now();
        profiles.push(profile_data.clone());
    }

    profile::save_profiles_to_disk(&profiles, app_data_dir.as_ref())?;

    Ok(profile_data.id)
}

#[tauri::command]
pub async fn load_profiles(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, AppError> {
    let app_data_dir = get_app_data_dir(&app);
    let loaded = profile::load_profiles_from_disk(app_data_dir.as_ref())?;

    // Sync in-memory state
    let mut profiles = state.profiles.lock().await;
    *profiles = loaded.clone();

    Ok(loaded)
}

#[tauri::command]
pub async fn delete_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile_id: Uuid,
) -> Result<(), AppError> {
    // Check for active sessions using this profile before deleting
    {
        let sessions = state.sessions.lock().await;
        for session in sessions.values() {
            if session.profile.id == profile_id
                && !matches!(session.state, SessionState::Disconnected)
            {
                return Err(AppError::ProfileError(format!(
                    "Cannot delete profile: it has an active session ({}). Disconnect first.",
                    session.id
                )));
            }
        }
    } // sessions lock dropped here before acquiring profiles lock

    let mut profiles = state.profiles.lock().await;
    let app_data_dir = get_app_data_dir(&app);

    let initial_len = profiles.len();
    profiles.retain(|p| p.id != profile_id);

    if profiles.len() == initial_len {
        return Err(AppError::ProfileError(format!(
            "Profile not found: {profile_id}"
        )));
    }

    profile::save_profiles_to_disk(&profiles, app_data_dir.as_ref())?;

    // Clean up vault credentials for this profile (best-effort)
    drop(profiles); // release profiles lock before acquiring vault lock
    let _ = crate::commands::vault::delete_profile_credentials(&state, &profile_id).await;

    Ok(())
}

#[tauri::command]
pub async fn get_profile(
    state: State<'_, AppState>,
    profile_id: Uuid,
) -> Result<ConnectionProfile, AppError> {
    let profiles = state.profiles.lock().await;
    profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| AppError::ProfileError(format!("Profile not found: {profile_id}")))
}

// ─── Export / Import ────────────────────────────────────

/// A single exported profile — safe metadata only, no secrets.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct ExportedProfile {
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    private_key_path: Option<String>,
    /// Password — only present in encrypted exports.
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

/// Top-level export envelope (plain JSON).
#[derive(Debug, Serialize, serde::Deserialize)]
struct ExportEnvelope {
    version: u32,
    app: String,
    exported_at: String,
    profiles: Vec<ExportedProfile>,
}

/// Encrypted export file format: magic + salt(32) + nonce(12) + ciphertext.
const ENCRYPTED_EXPORT_MAGIC: &[u8] = b"RMKT";
const EXPORT_SALT_SIZE: usize = 32;
const EXPORT_NONCE_SIZE: usize = 12;

/// Result returned to the frontend after import.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}

impl From<&ConnectionProfile> for ExportedProfile {
    fn from(p: &ConnectionProfile) -> Self {
        let (auth_method, private_key_path) = match &p.auth_method {
            AuthMethodConfig::Password => ("password".to_string(), None),
            AuthMethodConfig::PublicKey {
                private_key_path, ..
            } => ("publickey".to_string(), Some(private_key_path.clone())),
            AuthMethodConfig::KeyboardInteractive => ("keyboard-interactive".to_string(), None),
        };
        ExportedProfile {
            name: p.name.clone(),
            host: p.host.clone(),
            port: p.port,
            username: p.username.clone(),
            auth_method,
            private_key_path,
            password: None,
        }
    }
}

#[tauri::command]
pub async fn export_profiles(
    state: State<'_, AppState>,
    export_path: String,
    include_credentials: bool,
    export_password: Option<String>,
) -> Result<u32, AppError> {
    let profiles = state.profiles.lock().await;

    if profiles.is_empty() {
        return Err(AppError::ProfileError("No profiles to export".to_string()));
    }

    if include_credentials && export_password.is_none() {
        return Err(AppError::ProfileError(
            "Export password is required when including credentials".to_string(),
        ));
    }

    let mut exported: Vec<ExportedProfile> = profiles.iter().map(ExportedProfile::from).collect();
    let count = exported.len() as u32;

    // If including credentials, read passwords from vault
    if include_credentials {
        let vault_guard = state.vault.lock().await;
        if let Some(ref vault) = *vault_guard {
            for (i, profile) in profiles.iter().enumerate() {
                let key = format!("{}:password", profile.id);
                if let Ok(Some(password)) = vault.get(&key) {
                    exported[i].password = Some(password);
                }
            }
        }
    }

    let envelope = ExportEnvelope {
        version: 1,
        app: "NexTerm".to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        profiles: exported,
    };

    let json = serde_json::to_string_pretty(&envelope)?;

    if include_credentials {
        // Encrypt and write as .nexterm file
        let password = export_password.unwrap();
        let encrypted = encrypt_export_data(json.as_bytes(), &password)?;
        std::fs::write(&export_path, &encrypted)
            .map_err(|e| AppError::ProfileError(format!("Failed to write export file: {e}")))?;
    } else {
        // Write as plain JSON
        std::fs::write(&export_path, &json)
            .map_err(|e| AppError::ProfileError(format!("Failed to write export file: {e}")))?;
    }

    Ok(count)
}

#[tauri::command]
pub async fn import_profiles(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    import_path: String,
    import_password: Option<String>,
) -> Result<ImportResult, AppError> {
    // Detect file type by extension or magic bytes
    let raw_bytes = std::fs::read(&import_path)
        .map_err(|e| AppError::ProfileError(format!("Failed to read import file: {e}")))?;

    let is_encrypted = raw_bytes.starts_with(ENCRYPTED_EXPORT_MAGIC);

    let contents = if is_encrypted {
        let password = import_password.ok_or_else(|| {
            AppError::ProfileError("Import password is required for encrypted exports".to_string())
        })?;
        let decrypted = decrypt_export_data(&raw_bytes, &password)?;
        String::from_utf8(decrypted)
            .map_err(|e| AppError::ProfileError(format!("Invalid decrypted data: {e}")))?
    } else {
        String::from_utf8(raw_bytes)
            .map_err(|e| AppError::ProfileError(format!("Invalid file encoding: {e}")))?
    };

    let envelope: ExportEnvelope = serde_json::from_str(&contents).map_err(|e| {
        AppError::ProfileError(format!("Invalid import file format: {e}"))
    })?;

    if envelope.app != "NexTerm" {
        return Err(AppError::ProfileError(
            "File is not a NexTerm export".to_string(),
        ));
    }

    let mut profiles = state.profiles.lock().await;
    let app_data_dir = get_app_data_dir(&app);

    let mut imported: u32 = 0;
    let mut skipped: u32 = 0;
    let mut errors: Vec<String> = Vec::new();
    let mut credentials_to_store: Vec<(Uuid, String)> = Vec::new();

    for ep in &envelope.profiles {
        // Duplicate check: same name + host + username
        let is_duplicate = profiles.iter().any(|existing| {
            existing.name == ep.name
                && existing.host == ep.host
                && existing.username == ep.username
        });

        if is_duplicate {
            skipped += 1;
            continue;
        }

        // Validate required fields
        if ep.name.trim().is_empty() || ep.host.trim().is_empty() || ep.username.trim().is_empty() {
            errors.push(format!("Skipped invalid profile: '{}'", ep.name));
            continue;
        }

        // Reconstruct AuthMethodConfig from the exported type string
        let auth_method = match ep.auth_method.as_str() {
            "publickey" => AuthMethodConfig::PublicKey {
                private_key_path: ep
                    .private_key_path
                    .clone()
                    .unwrap_or_else(|| "~/.ssh/id_rsa".to_string()),
                passphrase_in_keychain: false,
            },
            "keyboard-interactive" => AuthMethodConfig::KeyboardInteractive,
            _ => AuthMethodConfig::Password, // default to password
        };

        let now = chrono::Utc::now();
        let new_id = Uuid::new_v4();
        let new_profile = ConnectionProfile {
            id: new_id,
            name: ep.name.clone(),
            host: ep.host.clone(),
            port: ep.port,
            username: ep.username.clone(),
            auth_method,
            startup_directory: None,
            tunnels: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        // Queue credential storage if password is present
        if let Some(ref password) = ep.password {
            if !password.is_empty() {
                credentials_to_store.push((new_id, password.clone()));
            }
        }

        profiles.push(new_profile);
        imported += 1;
    }

    // Persist if anything was imported
    if imported > 0 {
        profile::save_profiles_to_disk(&profiles, app_data_dir.as_ref())?;
    }

    // Drop profiles lock before acquiring vault lock (avoid deadlock)
    drop(profiles);

    // Store imported credentials in vault
    if !credentials_to_store.is_empty() {
        let mut vault_guard = state.vault.lock().await;
        if let Some(ref mut vault) = *vault_guard {
            for (profile_id, password) in &credentials_to_store {
                let key = format!("{profile_id}:password");
                if let Err(e) = vault.store(&key, password) {
                    errors.push(format!("Failed to store credential: {e}"));
                }
            }
        }
    }

    Ok(ImportResult {
        imported,
        skipped,
        errors,
    })
}

// ─── Encryption Helpers ─────────────────────────────────

/// Derive a 32-byte key from password + salt using Argon2id.
fn derive_export_key(password: &str, salt: &[u8]) -> Result<[u8; 32], AppError> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::ProfileError(format!("Key derivation failed: {e}")))?;
    Ok(key)
}

/// Encrypt data for export: MAGIC(4) + salt(32) + nonce(12) + ciphertext.
fn encrypt_export_data(plaintext: &[u8], password: &str) -> Result<Vec<u8>, AppError> {
    let mut salt = [0u8; EXPORT_SALT_SIZE];
    OsRng.fill_bytes(&mut salt);

    let key = derive_export_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::ProfileError(format!("Cipher init failed: {e}")))?;

    let mut nonce_bytes = [0u8; EXPORT_NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::ProfileError(format!("Encryption failed: {e}")))?;

    let mut result = Vec::with_capacity(
        ENCRYPTED_EXPORT_MAGIC.len() + EXPORT_SALT_SIZE + EXPORT_NONCE_SIZE + ciphertext.len(),
    );
    result.extend_from_slice(ENCRYPTED_EXPORT_MAGIC);
    result.extend_from_slice(&salt);
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);

    Ok(result)
}

/// Decrypt an encrypted export file.
fn decrypt_export_data(data: &[u8], password: &str) -> Result<Vec<u8>, AppError> {
    let header_size = ENCRYPTED_EXPORT_MAGIC.len() + EXPORT_SALT_SIZE + EXPORT_NONCE_SIZE;
    if data.len() < header_size + 16 {
        return Err(AppError::ProfileError("Encrypted file is too short".to_string()));
    }

    let magic = &data[..ENCRYPTED_EXPORT_MAGIC.len()];
    if magic != ENCRYPTED_EXPORT_MAGIC {
        return Err(AppError::ProfileError("Not a valid encrypted export file".to_string()));
    }

    let salt_start = ENCRYPTED_EXPORT_MAGIC.len();
    let salt = &data[salt_start..salt_start + EXPORT_SALT_SIZE];

    let nonce_start = salt_start + EXPORT_SALT_SIZE;
    let nonce_bytes = &data[nonce_start..nonce_start + EXPORT_NONCE_SIZE];

    let ciphertext = &data[nonce_start + EXPORT_NONCE_SIZE..];

    let key = derive_export_key(password, salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::ProfileError(format!("Cipher init failed: {e}")))?;

    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::ProfileError("Wrong export password or corrupted file".to_string()))?;

    Ok(plaintext)
}
