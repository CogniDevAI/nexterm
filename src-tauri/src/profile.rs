// profile.rs — Connection profile types and JSON persistence
//
// Profiles are stored as a JSON array in {app_data_dir}/profiles.json.
// Passwords/passphrases are NEVER stored in the JSON file — only in the encrypted vault.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::TunnelConfig;

// ─── Connection Profile ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethodConfig,
    pub startup_directory: Option<String>,
    pub tunnels: Vec<TunnelConfig>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ─── Auth Method Config (persisted) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuthMethodConfig {
    /// Password fetched from keychain at connect time
    Password,
    /// Public key auth — passphrase may be in keychain
    PublicKey {
        private_key_path: String,
        passphrase_in_keychain: bool,
    },
    /// Keyboard-interactive auth
    KeyboardInteractive,
}

impl Default for ConnectionProfile {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            name: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_method: AuthMethodConfig::Password,
            startup_directory: None,
            tunnels: Vec::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

// ─── Validation ─────────────────────────────────────────

impl ConnectionProfile {
    /// Validate required fields before persisting
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(AppError::ProfileError("name is required".to_string()));
        }
        if self.host.trim().is_empty() {
            return Err(AppError::ProfileError("hostname is required".to_string()));
        }
        if self.username.trim().is_empty() {
            return Err(AppError::ProfileError("username is required".to_string()));
        }
        if self.port == 0 {
            return Err(AppError::ProfileError("port must be > 0".to_string()));
        }
        Ok(())
    }
}

// ─── Profile Storage ────────────────────────────────────

/// Returns the path to the profiles JSON file.
/// Uses `dirs::data_dir()` as a fallback when no Tauri AppHandle is available.
pub fn profiles_file_path(app_data_dir: Option<&PathBuf>) -> PathBuf {
    if let Some(dir) = app_data_dir {
        dir.join("profiles.json")
    } else {
        // Fallback for tests or non-Tauri contexts
        let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("nexterm").join("profiles.json")
    }
}

/// Load all profiles from disk
pub fn load_profiles_from_disk(
    app_data_dir: Option<&PathBuf>,
) -> Result<Vec<ConnectionProfile>, AppError> {
    let path = profiles_file_path(app_data_dir);

    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| AppError::ProfileError(format!("Failed to read profiles file: {e}")))?;

    let profiles: Vec<ConnectionProfile> = serde_json::from_str(&contents)?;
    Ok(profiles)
}

/// Save all profiles to disk (atomic write via temp file)
pub fn save_profiles_to_disk(
    profiles: &[ConnectionProfile],
    app_data_dir: Option<&PathBuf>,
) -> Result<(), AppError> {
    let path = profiles_file_path(app_data_dir);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::ProfileError(format!("Failed to create profiles directory: {e}"))
        })?;
    }

    let json = serde_json::to_string_pretty(profiles)?;

    // Write to temp file then rename for atomicity
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json)
        .map_err(|e| AppError::ProfileError(format!("Failed to write profiles: {e}")))?;

    std::fs::rename(&tmp_path, &path)
        .map_err(|e| AppError::ProfileError(format!("Failed to finalize profiles write: {e}")))?;

    // Restrict file permissions to owner-only on Unix (0o600)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| AppError::ProfileError(format!("Failed to set file permissions: {e}")))?;
    }

    Ok(())
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_serialize_deserialize_roundtrip() {
        let profile = ConnectionProfile {
            id: Uuid::new_v4(),
            name: "Test".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethodConfig::Password,
            startup_directory: None,
            tunnels: vec![],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = serde_json::to_string(&profile).unwrap();
        let deserialized: ConnectionProfile = serde_json::from_str(&json).unwrap();

        assert_eq!(profile.id, deserialized.id);
        assert_eq!(profile.name, deserialized.name);
        assert_eq!(profile.host, deserialized.host);
        assert_eq!(profile.port, deserialized.port);
    }

    #[test]
    fn publickey_auth_serializes_correctly() {
        let profile = ConnectionProfile {
            auth_method: AuthMethodConfig::PublicKey {
                private_key_path: "~/.ssh/id_ed25519".to_string(),
                passphrase_in_keychain: true,
            },
            ..ConnectionProfile::default()
        };

        let json = serde_json::to_string(&profile.auth_method).unwrap();
        assert!(json.contains("\"type\":\"publicKey\""));
        assert!(json.contains("privateKeyPath"));
    }

    #[test]
    fn validation_rejects_empty_name() {
        let profile = ConnectionProfile {
            name: "".to_string(),
            host: "example.com".to_string(),
            username: "user".to_string(),
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_rejects_empty_host() {
        let profile = ConnectionProfile {
            name: "Test".to_string(),
            host: "".to_string(),
            username: "user".to_string(),
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_rejects_empty_username() {
        let profile = ConnectionProfile {
            name: "Test".to_string(),
            host: "example.com".to_string(),
            username: "".to_string(),
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_accepts_valid_profile() {
        let profile = ConnectionProfile {
            name: "Production".to_string(),
            host: "prod.example.com".to_string(),
            username: "deploy".to_string(),
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn disk_persistence_roundtrip() {
        let dir = std::env::temp_dir().join(format!("profile_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let profiles = vec![
            ConnectionProfile {
                name: "Server A".to_string(),
                host: "a.example.com".to_string(),
                username: "admin".to_string(),
                ..ConnectionProfile::default()
            },
            ConnectionProfile {
                name: "Server B".to_string(),
                host: "b.example.com".to_string(),
                username: "deploy".to_string(),
                auth_method: AuthMethodConfig::PublicKey {
                    private_key_path: "~/.ssh/id_ed25519".to_string(),
                    passphrase_in_keychain: false,
                },
                ..ConnectionProfile::default()
            },
        ];

        save_profiles_to_disk(&profiles, Some(&dir)).unwrap();
        let loaded = load_profiles_from_disk(Some(&dir)).unwrap();

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].name, "Server A");
        assert_eq!(loaded[1].name, "Server B");

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_from_nonexistent_returns_empty() {
        let dir = PathBuf::from("/tmp/nonexistent_profile_dir_12345");
        let profiles = load_profiles_from_disk(Some(&dir)).unwrap();
        assert!(profiles.is_empty());
    }
}
