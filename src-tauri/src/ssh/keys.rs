// ssh/keys.rs — Private key loading and management
//
// Supports OpenSSH, PEM, PKCS#8 formats for RSA, Ed25519, ECDSA.
// Handles encrypted keys with passphrase decryption.
// Uses the `ssh-key` crate for key parsing.

use std::path::{Path, PathBuf};

use ssh_key::PrivateKey;
use zeroize::Zeroizing;

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

    // Read the key file into a `Zeroizing` buffer so the raw key material
    // (private key bytes, possibly an encrypted blob) is wiped from the heap
    // when this function returns rather than lingering in a bare `String`.
    let key_data = Zeroizing::new(std::fs::read_to_string(path).map_err(|e| {
        AppError::KeyError(format!("Failed to read key file {}: {e}", path.display()))
    })?);

    decode_private_key(&key_data, passphrase, &path.display().to_string())
}

/// Decode a private key from its textual contents, trying every format we
/// support, with optional passphrase decryption.
///
/// Pure (no filesystem access) so it can be unit-tested directly.
///
/// Format coverage:
/// - OpenSSH (`BEGIN OPENSSH PRIVATE KEY`) — the modern `ssh-keygen` default.
/// - PEM / PKCS#1 (`BEGIN RSA PRIVATE KEY`) — legacy RSA keys.
/// - PKCS#8 (`BEGIN PRIVATE KEY`) and SEC1 (`BEGIN EC PRIVATE KEY`).
///
/// OpenSSH parsing is tried first so its behaviour is unchanged; everything
/// else is delegated to `russh-keys`' format-detecting decoder, which also
/// handles the encrypted variants of each format.
fn decode_private_key(
    data: &str,
    passphrase: Option<&str>,
    label: &str,
) -> Result<PrivateKey, AppError> {
    // OpenSSH format: handle encryption explicitly so the error for an
    // encrypted key without a passphrase is precise (callers prompt on it).
    if let Ok(key) = PrivateKey::from_openssh(data.as_bytes()) {
        if !key.is_encrypted() {
            return Ok(key);
        }
        return match passphrase {
            Some(pp) => key.decrypt(pp).map_err(|e| {
                AppError::KeyError(format!("Failed to decrypt key {label}: {e}"))
            }),
            None => Err(AppError::KeyError(format!(
                "Key {label} is encrypted — passphrase required"
            ))),
        };
    }

    // PEM / PKCS#1 / PKCS#8 / SEC1 (and their encrypted variants) via
    // russh-keys. Returns the same `ssh_key::PrivateKey` type.
    russh_keys::decode_secret_key(data, passphrase)
        .map_err(|e| AppError::KeyError(format!("Failed to load key {label}: {e}")))
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

    let entries = std::fs::read_dir(&ssh_dir)
        .map_err(|e| AppError::KeyError(format!("Failed to read ~/.ssh/ directory: {e}")))?;

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
            if contents.contains("ENCRYPTED")
                || contents.contains("aes256-ctr")
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
                assert!(msg.contains("Failed to load key"));
            }
            other => panic!("Expected KeyError, got: {:?}", other),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Unencrypted PEM / PKCS#1 RSA key (`BEGIN RSA PRIVATE KEY`) — the legacy
    // format `from_openssh` cannot parse. Throwaway 2048-bit key, test-only.
    const PKCS1_RSA_KEY: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEArPf9elp90aF5hLNv2DWagXUV4JNU6rwTaDylSsj1aXfo/gPZ
mT9GsRier0JrJXTIpTSf7X9ZzvH+553WIg/F+k0h6X6Op2olvdLsdNw+caAE0mLW
bo4QVNT+gHW4lZ2+5ayIsTRzFjVaS7kUpKInxyoWO9OvDoBdx7IahXngAj2BP7DM
PhsioPsWt/95g1pbr8RQOEaI4XvJ73zoYxe/qwwSZe235wMUSdlSxJfiTw7UTwDX
RzmYxlaz9zzhJr1ED76B02qcGz+3ZAbMGmP+7+yPMI6938Z2hjKml+CXxeIgF+KJ
WZBOvozUdM84KqZEd4hdsaTx/2YKXjeER8fwrQIDAQABAoIBAAFGadTTvCqX4iJU
SvZUnQy9enCyQcka+O78OMu1qxXn8wyhpjCMWDJlHy1zkFW/rxWhkpGRoBhNG+/v
YXtjPe9C3droj+ylylXgx7kBQUuydyv3ov+yFGaElFLQxDsgyMjNFwTegTjnWuRh
V4/WPNd/AwoOwIh+1U6WqRNjs/DQRl8w09ksJ5QTX2Si68vKi6lncpZcnAEnPMS/
sdHRP1Mb25HpBw5Daq0iRsR2c4M0zfhkabXqf1AtYvOY5PYKB5pooxy4B6B9sMct
+kTw8BdIoNi4Xrx1aV8FNtygMhqXnuwapH5q//iKM1/LNTvqtfzkksgkL3dmA42s
jh3dSgECgYEA3KXV9BGULPFZrJJwpcC2yDf5JLT1QmfZw6GlGcpvLygmQZueZnQ4
Yb5shmkmaGcuWHp1/a/mBO7ITadbldMeXgH8oOEzQnWFiUrKPgYal+V8N3YJO5m5
9eS42yJdUdPUpOovdxj0/uC1DgKc5bBgkhhR2zLKYjIhcO4o20GZoiECgYEAyK6I
dDMes57+fL9MLx0/TYxIs58P9mjXpQunlFSeifa7LodX/b8zPLuru1yufI9kc+Ut
pqoOoMp3x/+nEBJyscYI50r8wqUHdiy8nIwcWBYRmTFH25BkUgGbat3fUxHf7n0t
7S+uxWUNhGNneVRiXJ7bTdVcxXu0FIokM97uFQ0CgYEArgqpHuGWzXR6VWMVM8k0
4+0yuj96jay42lTwk81XsgyrUGjdotbdekvn8oWSZBuvNN8znq1WdGGc4ZO27BEh
DOnoSUYZVry4Xjj+Gbpa06GSP3T9h2OUiV6maUNL9LVwL70BP6IR7dF1Pt3UwGBF
bDd+qbYAaUA9nIRe+cNe2cECgYA+LeXVqykuGmtbl6IxTuyYSIkWLoixnpaCavQH
f5iHws0Ig6L92koz3So+qV7e9Ub4qd/VLgfORi2K6GmJD04+Ss/jalaasKt5MC9Y
igkWOfBF+QD8xOZwilLvb8OMZ5Nsv5iFTyrluoPPq0UaUM0RSZ9FpIBUKBoJ6yuA
buhx2QKBgQCckk9F6K/xuUX5bLEi/TWM4J67NfBJf8By5GlNUyDJD+3d/bH/WVvb
vvbl+9+2kUiXYYgdHc523CNVACf1hg6BfH9Mm5qI8cghRyvhzjbVhJyIQUVs4ZGc
mr0wgcTcPXfyIfsFi3SUAq3beD6lLzcj5sAYNM2HBXirQN9XhBDitw==
-----END RSA PRIVATE KEY-----
";

    #[test]
    fn decodes_unencrypted_pkcs1_rsa_key() {
        // Regression: `from_openssh` cannot parse PKCS#1 PEM, so this key used
        // to be misreported as "passphrase required" and never authenticated.
        let key = decode_private_key(PKCS1_RSA_KEY, None, "test.pem")
            .expect("PKCS#1 RSA key should load without a passphrase");
        assert!(matches!(
            key.algorithm(),
            ssh_key::Algorithm::Rsa { .. }
        ));
    }

    #[test]
    fn loads_pkcs1_rsa_key_from_file() {
        let dir = std::env::temp_dir().join("key_test_pkcs1");
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("id_rsa_pem");
        std::fs::write(&key_path, PKCS1_RSA_KEY).unwrap();

        let result = load_private_key(&key_path, None);
        assert!(result.is_ok(), "PKCS#1 RSA file should load: {result:?}");

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
