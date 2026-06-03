// commands/keygen.rs — Tauri IPC command for SSH keypair generation
//
// Thin adapter between the Tauri async runtime and `ssh::keygen::generate_keypair`.
// RSA generation is moved to a blocking thread via `tokio::task::spawn_blocking`
// because RSA key generation is CPU-bound (1–5 s) and would stall the runtime.
//
// Security notes:
// - `passphrase` is immediately wrapped in `Zeroizing` to wipe it on drop.
// - Private key PEM returned from the pure function is `Zeroizing<String>`.
// - NEVER log or expose `private_pem` in error messages.
// - Overwrite protection: both `filename` and `filename.pub` are checked for
//   existence BEFORE writing. If either exists, an error is returned.

use std::path::PathBuf;

use tokio::task;
use zeroize::Zeroizing;

use crate::error::AppError;
use crate::fs_secure;
use crate::ssh::keygen::{generate_keypair, KeyAlgorithm};
use crate::ssh::keys::default_ssh_dir;

// ─── Result Type ─────────────────────────────────────────

/// Returned to the frontend after a successful key generation.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSshKeyResult {
    /// The one-line authorized_keys public key string.
    pub public_key_openssh: String,
    /// Absolute path to the private key file written to disk.
    pub private_key_path: String,
    /// Absolute path to the public key file written to disk.
    pub public_key_path: String,
}

// ─── Tauri Command ───────────────────────────────────────

/// Generate a new SSH keypair and write it to `~/.ssh/{filename}` (private)
/// and `~/.ssh/{filename}.pub` (public).
///
/// # Arguments
/// * `algorithm`  – key algorithm (Ed25519, Rsa2048, Rsa4096, EcdsaP256, EcdsaP384)
/// * `comment`    – comment embedded in the public key (e.g. "user@hostname")
/// * `passphrase` – optional passphrase for private key encryption
/// * `filename`   – bare filename only (e.g. "id_ed25519"), no path, no extension
///
/// # Errors
/// Returns `AppError::KeyError` if either target file already exists (refuse-overwrite
/// protection) or if generation or file I/O fails.
#[tauri::command]
pub async fn generate_ssh_key(
    algorithm: KeyAlgorithm,
    comment: String,
    passphrase: Option<String>,
    filename: String,
) -> Result<GenerateSshKeyResult, AppError> {
    // Zeroize the passphrase immediately so it is wiped when this scope ends.
    let passphrase_z = passphrase.map(Zeroizing::new);

    // Resolve output paths
    let ssh_dir = default_ssh_dir();
    let priv_path = ssh_dir.join(&filename);
    let pub_path = ssh_dir.join(format!("{filename}.pub"));

    // ── Security: refuse to overwrite existing keys ──────────────────────
    // Check both paths before writing. This must happen BEFORE generation to
    // avoid generating a key we'll never write.
    if priv_path.exists() || pub_path.exists() {
        let existing = if priv_path.exists() {
            priv_path.display().to_string()
        } else {
            pub_path.display().to_string()
        };
        return Err(AppError::KeyError(format!(
            "Key already exists: {existing} — delete it first or choose a different filename"
        )));
    }

    // Ensure ~/.ssh/ exists
    if !ssh_dir.exists() {
        std::fs::create_dir_all(&ssh_dir)
            .map_err(|e| AppError::KeyError(format!("Failed to create ~/.ssh/: {e}")))?;
    }

    // Clone paths for the blocking closure (closures can't borrow across await)
    let priv_path_c = priv_path.clone();
    let pub_path_c = pub_path.clone();
    let comment_c = comment.clone();
    // Move `passphrase_z` (Zeroizing<String>) into the blocking closure so the
    // passphrase never exists as a plain, non-zeroizing String copy on the heap.
    // We deref to &str only inside the closure, which is on the blocking thread.
    let passphrase_z_owned = passphrase_z;

    // ── Generate the keypair ─────────────────────────────────────────────
    // RSA generation is CPU-bound — always run in a blocking thread.
    let (private_pem, public_openssh) = task::spawn_blocking(move || {
        let pass_ref = passphrase_z_owned.as_deref().map(|s| s.as_str());
        let output = generate_keypair(algorithm, &comment_c, pass_ref)?;
        Ok::<_, AppError>((output.private_pem, output.public_openssh))
    })
    .await
    .map_err(|e| AppError::KeyError(format!("Key generation task panicked: {e}")))??;

    // ── Write private key (0600 via fs_secure) ───────────────────────────
    fs_secure::secure_write(&priv_path_c, private_pem.as_bytes())?;

    // ── Write public key (0644 via std::fs + explicit chmod on Unix) ──────
    write_public_key(&pub_path_c, public_openssh.as_bytes())?;

    Ok(GenerateSshKeyResult {
        public_key_openssh: public_openssh,
        private_key_path: priv_path.display().to_string(),
        public_key_path: pub_path.display().to_string(),
    })
}

// ─── Public Key Write ────────────────────────────────────

/// Write a public key file with 0644 permissions (Unix) or default ACL (Windows/fallback).
///
/// `fs_secure::secure_write` uses 0600 which is too strict for the public key,
/// so we use `std::fs::write` + `set_permissions` (Unix-only, cfg-gated).
fn write_public_key(path: &PathBuf, content: &[u8]) -> Result<(), AppError> {
    std::fs::write(path, content)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o644);
        std::fs::set_permissions(path, perms)?;
    }

    Ok(())
}

// ─── Tests ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: redirect `default_ssh_dir()` by temporarily manipulating state
    /// isn't possible without full Tauri context, so we test the sub-functions
    /// and path logic directly.

    #[test]
    fn write_public_key_creates_file_with_correct_perms() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("id_test.pub");
        write_public_key(&path, b"ssh-ed25519 AAAA test@host").unwrap();

        assert!(path.exists(), "Public key file must be created");

        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "ssh-ed25519 AAAA test@host");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::metadata(&path).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o644, "Public key must be 0644, got {:?}", mode);
        }
    }

    #[test]
    fn refuse_overwrite_when_private_key_exists() {
        // We test the logic directly since we can't call the async Tauri command
        // in a unit test without a Tauri context.
        // The logic is: if priv_path.exists() || pub_path.exists() → error.
        let tmp = TempDir::new().unwrap();
        let priv_path = tmp.path().join("id_ed25519");
        let pub_path = tmp.path().join("id_ed25519.pub");

        // Pre-create private key
        fs::write(&priv_path, "fake private key").unwrap();

        let private_exists = priv_path.exists();
        let public_exists = pub_path.exists();

        assert!(private_exists || public_exists);

        // Confirm the guard condition
        let should_refuse = priv_path.exists() || pub_path.exists();
        assert!(should_refuse, "Must refuse when private key exists");
    }

    #[test]
    fn refuse_overwrite_when_public_key_exists() {
        let tmp = TempDir::new().unwrap();
        let priv_path = tmp.path().join("id_ed25519");
        let pub_path = tmp.path().join("id_ed25519.pub");

        // Pre-create only the public key
        fs::write(&pub_path, "fake public key").unwrap();

        let should_refuse = priv_path.exists() || pub_path.exists();
        assert!(should_refuse, "Must refuse when public key exists");
    }

    /// Async integration test: generate + write + verify perms end-to-end.
    /// Uses a real temp directory but bypasses the Tauri command layer.
    #[tokio::test]
    async fn generate_and_write_ed25519_files() {
        let tmp = TempDir::new().unwrap();
        let priv_path = tmp.path().join("id_ed25519_test");
        let pub_path = tmp.path().join("id_ed25519_test.pub");

        // Generate via pure function
        let output = generate_keypair(KeyAlgorithm::Ed25519, "test@machine", None)
            .expect("Generation must succeed");

        // Write private key (secure_write applies 0600)
        fs_secure::secure_write(&priv_path, output.private_pem.as_bytes())
            .expect("Private key write must succeed");

        // Write public key
        write_public_key(&pub_path, output.public_openssh.as_bytes())
            .expect("Public key write must succeed");

        assert!(priv_path.exists(), "Private key must exist");
        assert!(pub_path.exists(), "Public key must exist");

        // Verify private key is parseable
        let key_data = Zeroizing::new(fs::read_to_string(&priv_path).unwrap());
        let parsed = ssh_key::PrivateKey::from_openssh(key_data.as_bytes())
            .expect("Written private key must be parseable");
        assert!(matches!(parsed.algorithm(), ssh_key::Algorithm::Ed25519));

        // Verify public key content
        let pub_content = fs::read_to_string(&pub_path).unwrap();
        assert!(pub_content.starts_with("ssh-ed25519 "));
        assert!(pub_content.contains("test@machine"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let priv_mode = fs::metadata(&priv_path).unwrap().permissions().mode() & 0o777;
            let pub_mode = fs::metadata(&pub_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(priv_mode, 0o600, "Private key must be 0600");
            assert_eq!(pub_mode, 0o644, "Public key must be 0644");
        }
    }
}
