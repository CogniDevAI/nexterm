// ssh/keygen.rs — In-app SSH keypair generation
//
// Pure generation logic with no Tauri dependencies — fully unit-testable.
// Supports Ed25519 (default), RSA 2048/4096, ECDSA P-256/P-384.
// Private key is always OpenSSH format; passphrase encryption via AES-256-CTR + bcrypt-pbkdf.

use rand::rngs::OsRng;
use ssh_key::{
    private::{KeypairData, RsaKeypair},
    Algorithm, EcdsaCurve, LineEnding, PrivateKey,
};
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
    // Generate the raw keypair.
    //
    // RSA requires an explicit bit-size at construction time.
    // PrivateKey::random() uses DEFAULT_RSA_KEY_SIZE (4096) for *all* RSA
    // variants, so we must use RsaKeypair::random() directly and wrap it.
    // Ed25519 / ECDSA have no user-visible size parameter and use PrivateKey::random().
    let mut key: PrivateKey = match algorithm {
        KeyAlgorithm::Rsa2048 | KeyAlgorithm::Rsa4096 => {
            let bits = match algorithm {
                KeyAlgorithm::Rsa2048 => 2048_usize,
                KeyAlgorithm::Rsa4096 => 4096_usize,
                _ => unreachable!(),
            };
            let kp = RsaKeypair::random(&mut OsRng, bits)
                .map_err(|e| AppError::KeyError(format!("RSA generation failed: {e}")))?;
            PrivateKey::new(KeypairData::from(kp), "")
                .map_err(|e| AppError::KeyError(format!("RSA key construction failed: {e}")))?
        }
        KeyAlgorithm::Ed25519 => PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
            .map_err(|e| AppError::KeyError(format!("Key generation failed: {e}")))?,
        KeyAlgorithm::EcdsaP256 => PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .map_err(|e| AppError::KeyError(format!("Key generation failed: {e}")))?,
        KeyAlgorithm::EcdsaP384 => PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP384,
            },
        )
        .map_err(|e| AppError::KeyError(format!("Key generation failed: {e}")))?,
    };

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
            key.to_openssh(LineEnding::LF)
                .map_err(|e| AppError::KeyError(format!("Failed to encode private key: {e}")))?
        } else {
            let encrypted = key
                .encrypt(&mut OsRng, pass)
                .map_err(|e| AppError::KeyError(format!("Failed to encrypt private key: {e}")))?;
            encrypted
                .to_openssh(LineEnding::LF)
                .map_err(|e| AppError::KeyError(format!("Failed to encode encrypted key: {e}")))?
        }
    } else {
        key.to_openssh(LineEnding::LF)
            .map_err(|e| AppError::KeyError(format!("Failed to encode private key: {e}")))?
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

    /// RSA 2048: generated key must have a 2048-bit modulus (not 4096).
    ///
    /// This test is the RED guard for CRITICAL-1. It MUST fail if both Rsa2048
    /// and Rsa4096 silently produce 4096-bit keys.
    #[test]
    fn rsa_2048_key_has_correct_bits() {
        let output = generate_keypair(KeyAlgorithm::Rsa2048, "rsa@host", None)
            .expect("RSA 2048 generation must not fail");

        let reparsed = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("RSA private PEM must be parseable");

        let rsa_pub = match reparsed.key_data() {
            ssh_key::private::KeypairData::Rsa(kp) => &kp.public,
            other => panic!("Expected RSA keypair, got {:?}", other),
        };

        // The modulus `n` is stored as a big-endian mpint. Strip the leading
        // sign byte (0x00) that OpenSSH prepends when the MSB is set, then
        // count the significant bits: byte_count * 8, adjusted for leading
        // zero bits in the first data byte.
        let n_bytes = rsa_pub
            .n
            .as_positive_bytes()
            .expect("RSA modulus must be a positive integer");
        let bit_len = (n_bytes.len() * 8)
            - n_bytes
                .first()
                .map(|b| b.leading_zeros() as usize)
                .unwrap_or(0);

        assert_eq!(
            bit_len, 2048,
            "RSA 2048 key must have a 2048-bit modulus, got {bit_len} bits"
        );
    }

    /// RSA 4096: generated key must have a 4096-bit modulus.
    #[test]
    fn rsa_4096_key_has_correct_bits() {
        let output = generate_keypair(KeyAlgorithm::Rsa4096, "rsa4096@host", None)
            .expect("RSA 4096 generation must not fail");

        let reparsed = SshPrivateKey::from_openssh(output.private_pem.as_bytes())
            .expect("RSA 4096 private PEM must be parseable");

        let rsa_pub = match reparsed.key_data() {
            ssh_key::private::KeypairData::Rsa(kp) => &kp.public,
            other => panic!("Expected RSA keypair, got {:?}", other),
        };

        let n_bytes = rsa_pub
            .n
            .as_positive_bytes()
            .expect("RSA modulus must be a positive integer");
        let bit_len = (n_bytes.len() * 8)
            - n_bytes
                .first()
                .map(|b| b.leading_zeros() as usize)
                .unwrap_or(0);

        assert_eq!(
            bit_len, 4096,
            "RSA 4096 key must have a 4096-bit modulus, got {bit_len} bits"
        );
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

        assert!(
            !reparsed.is_encrypted(),
            "Empty passphrase must not encrypt"
        );
    }
}
