// profile.rs — Connection profile types and JSON persistence
//
// Profiles are stored as a JSON array in {app_data_dir}/profiles.json.
// Passwords/passphrases are NEVER stored in the JSON file — only in the encrypted vault.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::fs_secure;
use crate::state::TunnelConfig;

// ─── User Credential ────────────────────────────────────

/// A single user identity + auth config within a connection profile.
/// Each profile has one or more users that can connect to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCredential {
    pub id: Uuid,
    pub username: String,
    pub auth_method: AuthMethodConfig,
    #[serde(default)]
    pub is_default: bool,
}

// ─── Proxy Jump (Bastion) Config ────────────────────────

/// Authentication for a bastion / jump host.
///
/// This intentionally mirrors the shape of [`AuthMethodConfig`] (the persisted
/// per-user auth config) so the bastion auth path can reuse the exact same
/// credential-resolution logic as the main host. Secrets are NEVER stored here
/// — only metadata. A password is fetched from the encrypted vault at connect
/// time, keyed by the jump host's stable [`ProxyJumpConfig::id`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JumpAuthConfig {
    /// Password fetched from the vault at connect time.
    #[default]
    Password,
    /// Public key auth — passphrase may be stored in the vault.
    PublicKey {
        private_key_path: String,
        #[serde(default)]
        passphrase_in_keychain: bool,
    },
}

/// An OPTIONAL single bastion / jump host that the target is reached through
/// (the `ssh -J` equivalent). SCOPE: single hop only. A bastion does NOT carry
/// its own nested `jump_host` — chained jumps are explicitly out of scope and
/// guarded (see [`ProxyJumpConfig::validate`]).
///
/// Backward compatibility: a `ConnectionProfile` stores this behind
/// `#[serde(default)] jump_host: Option<ProxyJumpConfig>`, so existing
/// `profiles.json` files that predate this field still deserialize cleanly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyJumpConfig {
    /// Stable identifier used as the vault key namespace for the bastion's
    /// credentials. Defaulted on deserialization of profiles written before the
    /// id existed so older single-field jump configs still load.
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    /// Bastion hostname or IP.
    pub host: String,
    /// Bastion SSH port.
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    /// SSH username on the bastion.
    pub user: String,
    /// How to authenticate to the bastion.
    #[serde(default)]
    pub auth_method: JumpAuthConfig,
}

fn default_ssh_port() -> u16 {
    22
}

impl ProxyJumpConfig {
    /// Validate the bastion config. Pure and side-effect free.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.host.trim().is_empty() {
            return Err(AppError::ProfileError(
                "jump host hostname is required".to_string(),
            ));
        }
        if self.port == 0 {
            return Err(AppError::ProfileError(
                "jump host port must be > 0".to_string(),
            ));
        }
        if self.user.trim().is_empty() {
            return Err(AppError::ProfileError(
                "jump host username is required".to_string(),
            ));
        }
        Ok(())
    }
}

// ─── Connection Profile ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    /// OPTIONAL bastion / jump host (single hop, `ssh -J` equivalent).
    /// `#[serde(default)]` keeps pre-existing profiles (written before this
    /// field) deserializing without error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<ProxyJumpConfig>,
    /// Legacy field — only used for backward-compatible deserialization of old profiles.
    /// New profiles store credentials in the `users` array.
    #[serde(default, skip_serializing)]
    pub username: Option<String>,
    /// Legacy field — only used for backward-compatible deserialization of old profiles.
    #[serde(default, skip_serializing)]
    pub auth_method: Option<AuthMethodConfig>,
    /// Users array — the canonical source of user credentials for this profile.
    /// On deserialization of old profiles (with top-level username/auth_method),
    /// post-processing migrates them into this array.
    #[serde(default)]
    pub users: Vec<UserCredential>,
    pub startup_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub startup_commands: Vec<String>,
    /// User-assigned folder name for sidebar grouping.
    /// When set, the sidebar groups this profile under the folder name verbatim
    /// instead of falling back to the name-heuristic group.
    /// `#[serde(default)]` keeps pre-existing profiles (written before this
    /// field) deserializing without error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub tunnels: Vec<TunnelConfig>,
    #[serde(default)]
    pub display_order: i32,
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
    /// SSH agent auth — the running ssh-agent holds the private key(s) and
    /// performs the signing; no key material is ever read or stored by us.
    ///
    /// Backward-compat: this is a NEW enum variant, so profiles written before
    /// it existed never carried it and are unaffected. `key_id` is an OPTIONAL
    /// pin used to narrow auth to a single agent identity when the agent holds
    /// several. It accepts either the key's SHA-256 fingerprint (`SHA256:...`,
    /// matching [`crate::ssh::known_hosts::fingerprint`]) or its comment. When
    /// absent (the common case), every agent identity is tried OpenSSH-style.
    /// `#[serde(default)]` lets the minimal marker `{"type":"agent"}` load.
    Agent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_id: Option<String>,
    },
}

impl Default for ConnectionProfile {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            name: String::new(),
            host: String::new(),
            port: 22,
            jump_host: None,
            username: None,
            auth_method: None,
            users: Vec::new(),
            startup_directory: None,
            startup_commands: Vec::new(),
            folder: None,
            tunnels: Vec::new(),
            display_order: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

impl ConnectionProfile {
    /// Migrate legacy profiles that have top-level username/auth_method
    /// but no users array. Creates a single UserCredential from the old fields.
    /// This is idempotent — if users is already populated, does nothing.
    pub fn migrate_legacy_fields(&mut self) {
        if !self.users.is_empty() {
            return;
        }
        if let Some(ref username) = self.username {
            if !username.is_empty() {
                let auth = self
                    .auth_method
                    .clone()
                    .unwrap_or(AuthMethodConfig::Password);
                self.users.push(UserCredential {
                    id: Uuid::new_v4(),
                    username: username.clone(),
                    auth_method: auth,
                    is_default: true,
                });
            }
        }
        // Clear legacy fields after migration
        self.username = None;
        self.auth_method = None;
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
        if self.port == 0 {
            return Err(AppError::ProfileError("port must be > 0".to_string()));
        }
        if self.users.is_empty() {
            return Err(AppError::ProfileError(
                "profile must have at least one user".to_string(),
            ));
        }
        // Validate each user has a username
        for user in &self.users {
            if user.username.trim().is_empty() {
                return Err(AppError::ProfileError(
                    "each user must have a username".to_string(),
                ));
            }
        }
        // Reject multiple defaults
        let default_count = self.users.iter().filter(|u| u.is_default).count();
        if default_count > 1 {
            return Err(AppError::ProfileError(
                "only one default user allowed".to_string(),
            ));
        }
        // Validate the optional bastion / jump host, if present.
        if let Some(ref jump) = self.jump_host {
            jump.validate()?;
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

/// Load all profiles from disk, auto-migrating legacy format if needed.
pub fn load_profiles_from_disk(
    app_data_dir: Option<&PathBuf>,
) -> Result<Vec<ConnectionProfile>, AppError> {
    let path = profiles_file_path(app_data_dir);

    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| AppError::ProfileError(format!("Failed to read profiles file: {e}")))?;

    let mut profiles: Vec<ConnectionProfile> = serde_json::from_str(&contents)?;

    // Auto-migrate legacy profiles (top-level username/auth_method → users array)
    let mut migrated = false;
    for profile in profiles.iter_mut() {
        if profile.users.is_empty() && profile.username.is_some() {
            profile.migrate_legacy_fields();
            migrated = true;
        }
    }

    // Persist migrated profiles (backup first)
    if migrated {
        // Create backup before first migration write — route through fs_secure
        // so the backup file picks up owner-only permissions/ACL just like
        // the live profiles file. Previously this used std::fs::copy which
        // left the backup with default inherited permissions on every platform.
        let backup_path = path.with_extension("backup.json");
        if !backup_path.exists() {
            if let Err(e) = fs_secure::secure_copy(&path, &backup_path) {
                tracing::warn!("Failed to create profiles backup: {e}");
            }
        }
        // Re-save with migrated format
        if let Err(e) = save_profiles_to_disk(&profiles, app_data_dir) {
            tracing::warn!("Failed to persist migrated profiles: {e}");
        }
    }

    // Idempotent migration: re-apply owner-only access to the existing
    // profiles file in case it was created by an older version of the app
    // before fs_secure existed.
    if let Err(e) = fs_secure::harden_existing(&path) {
        tracing::warn!("Failed to harden existing profiles file: {e}");
    }

    profiles.sort_by_key(|p| p.display_order);
    Ok(profiles)
}

/// Save all profiles to disk via fs_secure: atomic temp-file write with
/// owner-only permissions/ACL applied BEFORE rename.
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

    fs_secure::secure_write(&path, json.as_bytes())
        .map_err(|e| AppError::ProfileError(format!("Failed to write profiles: {e}")))
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a profile with a single user (the common test case).
    fn test_profile(name: &str, host: &str, username: &str) -> ConnectionProfile {
        ConnectionProfile {
            name: name.to_string(),
            host: host.to_string(),
            users: vec![UserCredential {
                id: Uuid::new_v4(),
                username: username.to_string(),
                auth_method: AuthMethodConfig::Password,
                is_default: true,
            }],
            ..ConnectionProfile::default()
        }
    }

    #[test]
    fn profile_serialize_deserialize_roundtrip() {
        let profile = test_profile("Test", "example.com", "user");

        let json = serde_json::to_string(&profile).unwrap();
        let deserialized: ConnectionProfile = serde_json::from_str(&json).unwrap();

        assert_eq!(profile.id, deserialized.id);
        assert_eq!(profile.name, deserialized.name);
        assert_eq!(profile.host, deserialized.host);
        assert_eq!(profile.port, deserialized.port);
        assert_eq!(deserialized.users.len(), 1);
        assert_eq!(deserialized.users[0].username, "user");
    }

    #[test]
    fn publickey_auth_serializes_correctly() {
        let auth = AuthMethodConfig::PublicKey {
            private_key_path: "~/.ssh/id_ed25519".to_string(),
            passphrase_in_keychain: true,
        };

        let json = serde_json::to_string(&auth).unwrap();
        assert!(json.contains("\"type\":\"publicKey\""));
        assert!(json.contains("privateKeyPath"));
    }

    #[test]
    fn agent_auth_serializes_with_type_tag() {
        // A bare agent marker (no pinned key) serializes with the discriminant
        // and omits keyId (skip_serializing_if keeps the JSON clean).
        let auth = AuthMethodConfig::Agent { key_id: None };
        let json = serde_json::to_string(&auth).unwrap();
        assert!(json.contains("\"type\":\"agent\""), "got: {json}");
        assert!(
            !json.contains("keyId"),
            "keyId must be omitted when None, got: {json}"
        );
    }

    #[test]
    fn agent_auth_with_pinned_key_roundtrips() {
        let auth = AuthMethodConfig::Agent {
            key_id: Some("SHA256:abc123".to_string()),
        };
        let json = serde_json::to_string(&auth).unwrap();
        assert!(json.contains("\"type\":\"agent\""), "got: {json}");
        assert!(json.contains("keyId"), "got: {json}");

        let back: AuthMethodConfig = serde_json::from_str(&json).unwrap();
        match back {
            AuthMethodConfig::Agent { key_id } => {
                assert_eq!(key_id, Some("SHA256:abc123".to_string()));
            }
            _ => panic!("expected Agent variant"),
        }
    }

    #[test]
    fn agent_auth_bare_marker_deserializes_without_key_id() {
        // Backward-compat: an agent config written without keyId (the minimal
        // marker form) must still deserialize, with key_id defaulting to None.
        let json = r#"{"type":"agent"}"#;
        let back: AuthMethodConfig = serde_json::from_str(json).unwrap();
        match back {
            AuthMethodConfig::Agent { key_id } => assert_eq!(key_id, None),
            _ => panic!("expected Agent variant"),
        }
    }

    #[test]
    fn profile_with_agent_user_validates() {
        // A profile whose user authenticates via the agent is valid; the agent
        // marker carries no secret to validate.
        let profile = ConnectionProfile {
            name: "Agent Host".to_string(),
            host: "example.com".to_string(),
            users: vec![UserCredential {
                id: Uuid::new_v4(),
                username: "deploy".to_string(),
                auth_method: AuthMethodConfig::Agent { key_id: None },
                is_default: true,
            }],
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn profile_with_agent_user_roundtrips_on_disk() {
        let dir = std::env::temp_dir().join(format!("agent_profile_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let profiles = vec![ConnectionProfile {
            name: "Agent Host".to_string(),
            host: "agent.example.com".to_string(),
            users: vec![UserCredential {
                id: Uuid::new_v4(),
                username: "deploy".to_string(),
                auth_method: AuthMethodConfig::Agent {
                    key_id: Some("my-laptop-key".to_string()),
                },
                is_default: true,
            }],
            ..ConnectionProfile::default()
        }];

        save_profiles_to_disk(&profiles, Some(&dir)).unwrap();
        let loaded = load_profiles_from_disk(Some(&dir)).unwrap();

        assert_eq!(loaded.len(), 1);
        match &loaded[0].users[0].auth_method {
            AuthMethodConfig::Agent { key_id } => {
                assert_eq!(key_id.as_deref(), Some("my-laptop-key"));
            }
            other => panic!("expected Agent auth, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation_rejects_empty_name() {
        let profile = test_profile("", "example.com", "user");
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_rejects_empty_host() {
        let profile = test_profile("Test", "", "user");
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_rejects_empty_users() {
        let profile = ConnectionProfile {
            name: "Test".to_string(),
            host: "example.com".to_string(),
            users: vec![],
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_rejects_user_with_empty_username() {
        let profile = ConnectionProfile {
            name: "Test".to_string(),
            host: "example.com".to_string(),
            users: vec![UserCredential {
                id: Uuid::new_v4(),
                username: "".to_string(),
                auth_method: AuthMethodConfig::Password,
                is_default: true,
            }],
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_rejects_multiple_defaults() {
        let profile = ConnectionProfile {
            name: "Test".to_string(),
            host: "example.com".to_string(),
            users: vec![
                UserCredential {
                    id: Uuid::new_v4(),
                    username: "root".to_string(),
                    auth_method: AuthMethodConfig::Password,
                    is_default: true,
                },
                UserCredential {
                    id: Uuid::new_v4(),
                    username: "deploy".to_string(),
                    auth_method: AuthMethodConfig::Password,
                    is_default: true,
                },
            ],
            ..ConnectionProfile::default()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validation_accepts_valid_profile() {
        let profile = test_profile("Production", "prod.example.com", "deploy");
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn disk_persistence_roundtrip() {
        let dir = std::env::temp_dir().join(format!("profile_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let profiles = vec![
            test_profile("Server A", "a.example.com", "admin"),
            ConnectionProfile {
                name: "Server B".to_string(),
                host: "b.example.com".to_string(),
                users: vec![UserCredential {
                    id: Uuid::new_v4(),
                    username: "deploy".to_string(),
                    auth_method: AuthMethodConfig::PublicKey {
                        private_key_path: "~/.ssh/id_ed25519".to_string(),
                        passphrase_in_keychain: false,
                    },
                    is_default: true,
                }],
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

    #[test]
    fn legacy_profile_migration() {
        // Simulate old-format JSON with top-level username/authMethod
        let legacy_json = r#"[{
            "id": "00000000-0000-0000-0000-000000000001",
            "name": "Legacy Server",
            "host": "legacy.example.com",
            "port": 22,
            "username": "root",
            "authMethod": {"type": "password"},
            "tunnels": [],
            "displayOrder": 0,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z"
        }]"#;

        let mut profiles: Vec<ConnectionProfile> = serde_json::from_str(legacy_json).unwrap();

        // Before migration: users is empty, username is Some
        assert!(profiles[0].users.is_empty());
        assert_eq!(profiles[0].username, Some("root".to_string()));

        // Run migration
        profiles[0].migrate_legacy_fields();

        // After migration: users has 1 entry, legacy fields cleared
        assert_eq!(profiles[0].users.len(), 1);
        assert_eq!(profiles[0].users[0].username, "root");
        assert!(profiles[0].users[0].is_default);
        assert!(profiles[0].username.is_none());
        assert!(profiles[0].auth_method.is_none());
    }

    // ─── ProxyJump / Bastion tests ──────────────────────────────────

    #[test]
    fn old_profile_without_jump_host_deserializes() {
        // A profile written before the jump_host field existed must still
        // deserialize cleanly (jump_host defaults to None).
        let old_json = r#"{
            "id": "00000000-0000-0000-0000-000000000002",
            "name": "Pre-bastion Server",
            "host": "legacy.example.com",
            "port": 22,
            "users": [{
                "id": "00000000-0000-0000-0000-000000000003",
                "username": "deploy",
                "authMethod": {"type": "password"},
                "isDefault": true
            }],
            "startupDirectory": null,
            "tunnels": [],
            "displayOrder": 0,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z"
        }"#;

        let profile: ConnectionProfile = serde_json::from_str(old_json).unwrap();
        assert!(
            profile.jump_host.is_none(),
            "missing jumpHost field must default to None"
        );
        assert_eq!(profile.users.len(), 1);
    }

    #[test]
    fn old_profiles_array_without_jump_host_loads() {
        // The on-disk format is a JSON array. An array of old-format profiles
        // (no jumpHost) must load without error via the same path as new ones.
        let old_array = r#"[{
            "id": "00000000-0000-0000-0000-000000000004",
            "name": "Old A",
            "host": "a.example.com",
            "port": 22,
            "users": [{
                "id": "00000000-0000-0000-0000-000000000005",
                "username": "root",
                "authMethod": {"type": "password"},
                "isDefault": true
            }],
            "startupDirectory": null,
            "tunnels": [],
            "displayOrder": 0,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z"
        }]"#;

        let profiles: Vec<ConnectionProfile> = serde_json::from_str(old_array).unwrap();
        assert_eq!(profiles.len(), 1);
        assert!(profiles[0].jump_host.is_none());
    }

    #[test]
    fn profile_with_jump_host_roundtrips() {
        let mut profile = test_profile("Behind Bastion", "10.0.0.5", "deploy");
        let jump_id = Uuid::new_v4();
        profile.jump_host = Some(ProxyJumpConfig {
            id: jump_id,
            host: "bastion.example.com".to_string(),
            port: 2222,
            user: "jumpuser".to_string(),
            auth_method: JumpAuthConfig::PublicKey {
                private_key_path: "~/.ssh/id_ed25519".to_string(),
                passphrase_in_keychain: true,
            },
        });

        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains("jumpHost"));
        assert!(json.contains("bastion.example.com"));

        let back: ConnectionProfile = serde_json::from_str(&json).unwrap();
        let jump = back.jump_host.expect("jump host must survive roundtrip");
        assert_eq!(jump.id, jump_id);
        assert_eq!(jump.host, "bastion.example.com");
        assert_eq!(jump.port, 2222);
        assert_eq!(jump.user, "jumpuser");
        assert_eq!(
            jump.auth_method,
            JumpAuthConfig::PublicKey {
                private_key_path: "~/.ssh/id_ed25519".to_string(),
                passphrase_in_keychain: true,
            }
        );
    }

    #[test]
    fn jump_host_omitted_from_json_when_none() {
        // skip_serializing_if keeps clean JSON for the common no-bastion case.
        let profile = test_profile("No Bastion", "example.com", "user");
        let json = serde_json::to_string(&profile).unwrap();
        assert!(
            !json.contains("jumpHost"),
            "jumpHost must be omitted when None, got: {json}"
        );
    }

    #[test]
    fn jump_config_defaults_port_to_22() {
        // A jump config missing the port field defaults to 22 (default_ssh_port).
        let json = r#"{
            "id": "00000000-0000-0000-0000-000000000006",
            "host": "bastion.example.com",
            "user": "jumpuser",
            "authMethod": {"type": "password"}
        }"#;
        let jump: ProxyJumpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(jump.port, 22);
        assert_eq!(jump.auth_method, JumpAuthConfig::Password);
    }

    #[test]
    fn jump_config_defaults_id_when_missing() {
        // A jump config written before the id field existed still loads (id is
        // freshly generated via default).
        let json = r#"{
            "host": "bastion.example.com",
            "port": 22,
            "user": "jumpuser",
            "authMethod": {"type": "password"}
        }"#;
        let jump: ProxyJumpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(jump.host, "bastion.example.com");
        // id must be non-nil (freshly generated)
        assert_ne!(jump.id, Uuid::nil());
    }

    #[test]
    fn jump_config_validate_rejects_empty_host() {
        let jump = ProxyJumpConfig {
            id: Uuid::new_v4(),
            host: "  ".to_string(),
            port: 22,
            user: "jumpuser".to_string(),
            auth_method: JumpAuthConfig::Password,
        };
        assert!(jump.validate().is_err());
    }

    #[test]
    fn jump_config_validate_rejects_zero_port() {
        let jump = ProxyJumpConfig {
            id: Uuid::new_v4(),
            host: "bastion.example.com".to_string(),
            port: 0,
            user: "jumpuser".to_string(),
            auth_method: JumpAuthConfig::Password,
        };
        assert!(jump.validate().is_err());
    }

    #[test]
    fn jump_config_validate_rejects_empty_user() {
        let jump = ProxyJumpConfig {
            id: Uuid::new_v4(),
            host: "bastion.example.com".to_string(),
            port: 22,
            user: "".to_string(),
            auth_method: JumpAuthConfig::Password,
        };
        assert!(jump.validate().is_err());
    }

    #[test]
    fn jump_config_validate_accepts_valid() {
        let jump = ProxyJumpConfig {
            id: Uuid::new_v4(),
            host: "bastion.example.com".to_string(),
            port: 22,
            user: "jumpuser".to_string(),
            auth_method: JumpAuthConfig::Password,
        };
        assert!(jump.validate().is_ok());
    }

    #[test]
    fn profile_validate_rejects_invalid_jump_host() {
        let mut profile = test_profile("Bad Bastion", "10.0.0.5", "deploy");
        profile.jump_host = Some(ProxyJumpConfig {
            id: Uuid::new_v4(),
            host: "".to_string(), // invalid
            port: 22,
            user: "jumpuser".to_string(),
            auth_method: JumpAuthConfig::Password,
        });
        assert!(profile.validate().is_err());
    }

    #[test]
    fn profile_validate_accepts_valid_jump_host() {
        let mut profile = test_profile("Good Bastion", "10.0.0.5", "deploy");
        profile.jump_host = Some(ProxyJumpConfig {
            id: Uuid::new_v4(),
            host: "bastion.example.com".to_string(),
            port: 22,
            user: "jumpuser".to_string(),
            auth_method: JumpAuthConfig::Password,
        });
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn startup_commands_roundtrips_on_disk() {
        let dir = std::env::temp_dir().join(format!("startup_cmds_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let profiles = vec![ConnectionProfile {
            name: "Startup Server".to_string(),
            host: "startup.example.com".to_string(),
            users: vec![UserCredential {
                id: Uuid::new_v4(),
                username: "deploy".to_string(),
                auth_method: AuthMethodConfig::Password,
                is_default: true,
            }],
            startup_commands: vec!["ls -la".to_string(), "uptime".to_string()],
            ..ConnectionProfile::default()
        }];

        save_profiles_to_disk(&profiles, Some(&dir)).unwrap();
        let loaded = load_profiles_from_disk(Some(&dir)).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].startup_commands, vec!["ls -la", "uptime"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_profile_without_startup_commands_defaults_empty() {
        // A profile written before startup_commands existed must deserialize
        // cleanly with an empty vec (via #[serde(default)]).
        let old_json = r#"{
            "id": "00000000-0000-0000-0000-000000000010",
            "name": "Pre-startup Server",
            "host": "legacy.example.com",
            "port": 22,
            "users": [{
                "id": "00000000-0000-0000-0000-000000000011",
                "username": "root",
                "authMethod": {"type": "password"},
                "isDefault": true
            }],
            "startupDirectory": null,
            "tunnels": [],
            "displayOrder": 0,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z"
        }"#;

        let profile: ConnectionProfile = serde_json::from_str(old_json).unwrap();
        assert!(
            profile.startup_commands.is_empty(),
            "startup_commands must default to empty for old profiles"
        );
    }

    // ─── folder field back-compat tests ────────────────────────────────────

    #[test]
    fn folder_field_defaults_none_on_old_profile() {
        // A profile written before the folder field existed must still
        // deserialize cleanly with folder == None (back-compat critical path).
        let old_json = r#"{
            "id": "00000000-0000-0000-0000-000000000020",
            "name": "Old Server",
            "host": "old.example.com",
            "port": 22,
            "users": [{
                "id": "00000000-0000-0000-0000-000000000021",
                "username": "root",
                "authMethod": {"type": "password"},
                "isDefault": true
            }],
            "startupDirectory": null,
            "tunnels": [],
            "displayOrder": 0,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z"
        }"#;

        let profile: ConnectionProfile = serde_json::from_str(old_json).unwrap();
        assert!(
            profile.folder.is_none(),
            "missing folder key must default to None"
        );
    }

    #[test]
    fn folder_roundtrips_on_disk() {
        let dir = std::env::temp_dir().join(format!("folder_roundtrip_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let profiles = vec![ConnectionProfile {
            name: "Folder Server".to_string(),
            host: "folder.example.com".to_string(),
            users: vec![UserCredential {
                id: Uuid::new_v4(),
                username: "deploy".to_string(),
                auth_method: AuthMethodConfig::Password,
                is_default: true,
            }],
            folder: Some("production".to_string()),
            ..ConnectionProfile::default()
        }];

        save_profiles_to_disk(&profiles, Some(&dir)).unwrap();
        let loaded = load_profiles_from_disk(Some(&dir)).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded[0].folder.as_deref(),
            Some("production"),
            "folder must survive save+load roundtrip"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_omitted_from_json_when_none() {
        // skip_serializing_if = "Option::is_none" keeps clean JSON when no folder.
        let profile = test_profile("No Folder", "example.com", "user");
        let json = serde_json::to_string(&profile).unwrap();
        assert!(
            !json.contains("folder"),
            "folder must be omitted when None, got: {json}"
        );
    }

    #[test]
    fn already_migrated_profile_untouched() {
        let user_id = Uuid::new_v4();
        let mut profile = ConnectionProfile {
            name: "Modern".to_string(),
            host: "modern.example.com".to_string(),
            users: vec![UserCredential {
                id: user_id,
                username: "deploy".to_string(),
                auth_method: AuthMethodConfig::Password,
                is_default: true,
            }],
            ..ConnectionProfile::default()
        };

        profile.migrate_legacy_fields();

        // Should be untouched — still 1 user with same ID
        assert_eq!(profile.users.len(), 1);
        assert_eq!(profile.users[0].id, user_id);
    }
}
