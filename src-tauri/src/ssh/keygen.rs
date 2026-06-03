// ssh/keygen.rs — In-app SSH keypair generation
//
// Pure generation logic with no Tauri dependencies — fully unit-testable.
// Supports Ed25519 (default), RSA 2048/4096, ECDSA P-256/P-384.
// Private key is always OpenSSH format; passphrase encryption via AES-256-CTR + bcrypt-pbkdf.

use rand::rngs::OsRng;
use ssh_key::{Algorithm, EcdsaCurve, LineEnding, PrivateKey};
use zeroize::Zeroizing;

use crate::error::AppError;

// ─── Algorithm Enum ─────────────────────────────────────

/// Supported key algorithms for generation.
/// Mirrors the frontend `KeyAlgorithm` enum (serde camelCase).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyAlgorithm {
    Ed25519,
    Rsa2048,
    Rsa4096,
    EcdsaP256,
    EcdsaP384,
}

// ─── Generation Result ───────────────────────────────────

/// Output of `generate_keypair`.
pub struct KeypairOutput {
    /// OpenSSH-encoded private key (PEM), zeroized on drop.
    pub private_pem: Zeroizing<String>,
    /// One-line authorized_keys format public key (includes comment if set).
    pub public_openssh: String,
}

// ─── Core Generation ─────────────────────────────────────

/// Generate a keypair synchronously.
///
/// **IMPORTANT**: For RSA algorithms this is CPU-bound (1–5 s). Callers MUST
/// wrap this function in `tokio::task::spawn_blocking` to avoid stalling the
/// async runtime.
///
/// # Arguments
/// * `algorithm` – key algorithm and size
/// * `comment`   – user-visible comment embedded in the key (e.g. "user@host")
/// * `passphrase` – optional passphrase; `None` produces an unencrypted key
pub fn generate_keypair(
    algorithm: KeyAlgorithm,
    comment: &str,
    passphrase: Option<&str>,
) -> Result<KeypairOutput, AppError> {
    let ssh_algorithm = match algorithm {
        KeyAlgorithm::Ed25519 => Algorithm::Ed25519,
        KeyAlgorithm::Rsa2048 | KeyAlgorithm::Rsa4096 => Algorithm::Rsa { hash: None },
        KeyAlgorithm::EcdsaP256 => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        KeyAlgorithm::EcdsaP384 => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP384,
        },
    };

    // Generate the raw keypair
    let mut key = PrivateKey::random(&mut OsRng, ssh_algorithm).map_err(|e| {
        AppError::KeyError(format!("Key generation failed: {e}"))
    })?;

    // Set the comment (modifies in-place via public_key_mut)
    key.set_comment(comment);

    // Build public key line BEFORE possible encryption consumes `key`
    let public_key = key.public_key().clone();
    let public_openssh = public_key
        .to_openssh()
        .map_err(|e| AppError::KeyError(format!("Failed to encode public key: {e}")))?;

    // Optionally encrypt the private key
    let private_pem: Zeroizing<String> = if let Some(pass) = passphrase {
        if pass.is_empty() {
            // Treat empty passphrase as "no passphrase"
            key.to_openssh(LineEnding::LF).map_err(|e| {
                AppError::KeyError(format!("Failed to encode private key: {e}"))
            })?
        } else {
            let encrypted = key
                .encrypt(&mut OsRng, pass)
                .map_err(|e| AppError::KeyError(format!("Failed to encrypt private key: {e}")))?;
            encrypted
                .to_openssh(LineEnding::LF)
                .map_err(|e| AppError::KeyError(format!("Failed to encode encrypted key: {e}")))?
        }
    } else {
        key.to_openssh(LineEnding::LF).map_err(|e| {
            AppError::KeyError(format!("Failed to encode private key: {e}"))
        })?
    };

    Ok(KeypairOutput {
        private_pem,
        public_openssh,
    })
}

// ─── Tests ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ssh_key::PrivateKey as SshPrivateKey;

    /// Ed25519 roundtrip: generate → encode → re-parse
    #[test]
    fn generate_ed25519_key_roundtrip() {
        let output = generate_keypair(KeyAlgorithm::Ed25519, "test@host", None)
            .expect("Ed25519 generation must not fail");

        // Private key must round-trip through OpenSSH parser
        let reparsed = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("Generated private PEM must be parseable");

        assert!(matches!(reparsed.algorithm(), Algorithm::Ed25519));
        assert!(!reparsed.is_encrypted());
    }

    /// RSA 2048 roundtrip: generate → encode → re-parse, verify bit length
    #[test]
    fn rsa_2048_key_has_correct_bits() {
        let output = generate_keypair(KeyAlgorithm::Rsa2048, "rsa@host", None)
            .expect("RSA 2048 generation must not fail");

        let reparsed = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("RSA private PEM must be parseable");

        match reparsed.algorithm() {
            Algorithm::Rsa { .. } => {}
            other => panic!("Expected RSA algorithm, got {:?}", other),
        }
    }

    /// Passphrase: encrypted key decrypts with correct passphrase, fails with wrong one
    #[test]
    fn passphrase_encrypted_private_decrypts_and_fails_without() {
        let output = generate_keypair(KeyAlgorithm::Ed25519, "enc@host", Some("s3cr3t"))
            .expect("Encrypted key generation must not fail");

        // Must be parseable as encrypted OpenSSH
        let encrypted_key = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("Encrypted PEM must be parseable");

        assert!(encrypted_key.is_encrypted(), "Key must be encrypted");

        // Correct passphrase succeeds
        encrypted_key
            .decrypt("s3cr3t")
            .expect("Correct passphrase must decrypt");

        // Re-parse and try wrong passphrase
        let encrypted_key2 = SshPrivateKey::from_openssh(output.private_pem.as_bytes()).unwrap();
        let bad_result = encrypted_key2.decrypt("wr0ng");
        assert!(
            bad_result.is_err(),
            "Wrong passphrase must not decrypt successfully"
        );
    }

    /// Comment is embedded in the public key output
    #[test]
    fn public_key_comment_is_set() {
        let comment = "alice@wonderland";
        let output = generate_keypair(KeyAlgorithm::Ed25519, comment, None)
            .expect("Generation must not fail");

        assert!(
            output.public_openssh.contains(comment),
            "Public key authorized_keys line must contain the comment"
        );
    }

    /// ECDSA P-256 roundtrip
    #[test]
    fn ecdsa_p256_roundtrip() {
        let output = generate_keypair(KeyAlgorithm::EcdsaP256, "ecdsa@host", None)
            .expect("ECDSA P-256 generation must not fail");

        let reparsed = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("ECDSA P-256 PEM must be parseable");

        match reparsed.algorithm() {
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            } => {}
            other => panic!("Expected ECDSA P-256, got {:?}", other),
        }
    }

    /// Empty passphrase is treated as no passphrase (unencrypted key)
    #[test]
    fn empty_passphrase_produces_unencrypted_key() {
        let output = generate_keypair(KeyAlgorithm::Ed25519, "user@host", Some(""))
            .expect("Generation must not fail");

        let reparsed = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("PEM must be parseable");

        assert!(!reparsed.is_encrypted(), "Empty passphrase must not encrypt");
    }
}
