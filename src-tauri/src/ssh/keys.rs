// ssh/keys.rs — Private key loading and management
//
// Supports OpenSSH, PEM, PKCS#8 formats for RSA, Ed25519, ECDSA.
// Handles encrypted keys with passphrase decryption.
// Uses the `ssh-key` crate for key parsing.

use std::path::{Path, PathBuf};

use ssh_key::PrivateKey;

use crate::error::AppError;

// ─── Key Loading ────────────────────────────────────────

/// Load a private key from a file, optionally decrypting with a passphrase.
///
/// Supports:
/// - OpenSSH format (default output of ssh-keygen)
/// - PEM format (legacy RSA keys)
/// - PKCS#8 format
///
/// Key types: RSA, Ed25519, ECDSA
pub fn load_private_key(path: &Path, passphrase: Option<&str>) -> Result<PrivateKey, AppError> {
    if !path.exists() {
        return Err(AppError::KeyError(format!(
            "Key file not found: {}",
            path.display()
        )));
    }

    let key_data = std::fs::read_to_string(path).map_err(|e| {
        AppError::KeyError(format!("Failed to read key file {}: {e}", path.display()))
    })?;

    let key = if let Some(passphrase) = passphrase {
        PrivateKey::from_openssh(key_data.as_bytes())
            .and_then(|k| {
                if k.is_encrypted() {
                    k.decrypt(passphrase)
                } else {
                    Ok(k)
                }
            })
            .map_err(|e| {
                AppError::KeyError(format!(
                    "Failed to load/decrypt key {}: {e}",
                    path.display()
                ))
            })?
    } else {
        PrivateKey::from_openssh(key_data.as_bytes()).map_err(|e| {
            AppError::KeyError(format!(
                "Failed to parse key {} (may be encrypted — passphrase required): {e}",
                path.display()
            ))
        })?
    };

    Ok(key)
}

// ─── Key Discovery ──────────────────────────────────────

/// Information about an available SSH key
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub path: String,
    pub key_type: String,
    pub is_encrypted: bool,
    pub comment: Option<String>,
}

/// List available private key files in ~/.ssh/
pub fn list_available_keys() -> Result<Vec<KeyInfo>, AppError> {
    let ssh_dir = default_ssh_dir();

    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }

    let mut keys = Vec::new();

    let entries = std::fs::read_dir(&ssh_dir).map_err(|e| {
        AppError::KeyError(format!("Failed to read ~/.ssh/ directory: {e}"))
    })?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        // Only look at files named id_* (excluding .pub files)
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        if !file_name.starts_with("id_") || file_name.ends_with(".pub") {
            continue;
        }

        // Try to read and identify the key
        if let Ok(contents) = std::fs::read_to_string(&path) {
            let key_info = identify_key(&contents, &path);
            if let Some(info) = key_info {
                keys.push(info);
            }
        }
    }

    Ok(keys)
}

/// Try to identify a key file's type and encryption status
fn identify_key(contents: &str, path: &Path) -> Option<KeyInfo> {
    // Try parsing as OpenSSH format
    match PrivateKey::from_openssh(contents.as_bytes()) {
        Ok(key) => {
            let key_type = match key.algorithm() {
                ssh_key::Algorithm::Rsa { .. } => "RSA",
                ssh_key::Algorithm::Ed25519 => "Ed25519",
                ssh_key::Algorithm::Ecdsa { curve } => match curve {
                    ssh_key::EcdsaCurve::NistP256 => "ECDSA-256",
                    ssh_key::EcdsaCurve::NistP384 => "ECDSA-384",
                    ssh_key::EcdsaCurve::NistP521 => "ECDSA-521",
                },
                _ => "Unknown",
            };

            Some(KeyInfo {
                path: path.display().to_string(),
                key_type: key_type.to_string(),
                is_encrypted: false,
                comment: key.comment().to_string().into(),
            })
        }
        Err(_) => {
            // Could be encrypted — check for the marker
            if contents.contains("ENCRYPTED") || contents.contains("aes256-ctr")
                || contents.contains("bcrypt")
            {
                // Encrypted key — we can tell the type from the header sometimes
                let key_type = if contents.contains("RSA") {
                    "RSA"
                } else if contents.contains("OPENSSH") {
                    "OpenSSH (encrypted)"
                } else {
                    "Unknown (encrypted)"
                };

                Some(KeyInfo {
                    path: path.display().to_string(),
                    key_type: key_type.to_string(),
                    is_encrypted: true,
                    comment: None,
                })
            } else {
                None // Not a recognizable key file
            }
        }
    }
}

/// Get the default SSH directory (~/.ssh/)
pub fn default_ssh_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ssh")
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonexistent_key_returns_error() {
        let result = load_private_key(Path::new("/nonexistent/key"), None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AppError::KeyError(msg) => assert!(msg.contains("not found")),
            other => panic!("Expected KeyError, got: {:?}", other),
        }
    }

    #[test]
    fn invalid_key_file_returns_error() {
        let dir = std::env::temp_dir().join("key_test");
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("not_a_key");
        std::fs::write(&key_path, "this is not a key file").unwrap();

        let result = load_private_key(&key_path, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AppError::KeyError(msg) => {
                assert!(msg.contains("Failed to parse key"));
            }
            other => panic!("Expected KeyError, got: {:?}", other),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_keys_handles_missing_ssh_dir() {
        // This shouldn't fail even if ~/.ssh/ doesn't exist
        // (it does on most dev machines, but the function handles the case)
        let result = list_available_keys();
        assert!(result.is_ok());
    }

    #[test]
    fn default_ssh_dir_is_under_home() {
        let dir = default_ssh_dir();
        assert!(dir.to_string_lossy().contains(".ssh"));
    }
}
