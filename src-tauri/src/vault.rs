// vault.rs — Encrypted credential vault (replaces OS keychain)
//
// All SSH credentials are stored in an AES-256-GCM encrypted file,
// keyed by a master password via Argon2id key derivation.
//
// Vault file format (JSON on disk), version 2:
// {
//   "version": 2,
//   "salt": "<base64 32-byte salt>",
//   "kdf": { "algorithm": "argon2id", "m_cost": 65536, "t_cost": 3, "p_cost": 1 },
//   "verifier": "<base64 nonce(12) + ciphertext + tag(16)>",
//   "credentials": {
//     "<profile_id:type>": "<base64 nonce(12) + ciphertext + tag(16)>"
//   }
// }
//
// Legacy version 1 files (no `kdf`, no `verifier`) are still readable; the
// first successful unlock transparently re-encrypts them as version 2.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::AppError;
use crate::fs_secure;

/// Vault file name in the app data directory.
const VAULT_FILE: &str = "vault.json";

/// Current vault format version.
const VAULT_VERSION: u32 = 2;

/// AES-256-GCM nonce size in bytes.
const NONCE_SIZE: usize = 12;

/// Salt size in bytes for Argon2id.
const SALT_SIZE: usize = 32;

/// Fixed plaintext encrypted under the derived key to verify the master
/// password independently of how many credentials the vault holds. The
/// AES-GCM auth tag also guards the verifier's integrity.
const VERIFIER_PLAINTEXT: &[u8] = b"nexterm-vault-verifier-v2";

// ─── On-Disk Format ─────────────────────────────────────

/// KDF parameters persisted with the vault so future reads use the exact
/// settings the file was written with.
#[derive(Serialize, Deserialize, Clone)]
pub struct KdfParams {
    pub algorithm: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

/// Default Argon2id parameters for newly created / migrated vaults:
/// m_cost = 64 MiB, t_cost = 3, p_cost = 1.
pub fn default_kdf_params() -> KdfParams {
    KdfParams {
        algorithm: "argon2id".to_string(),
        m_cost: 65536,
        t_cost: 3,
        p_cost: 1,
    }
}

/// Build an Argon2id hasher from persisted KDF params. Shared by the vault
/// and the profile-export path so both derive keys identically.
pub fn argon2_from_params(p: &KdfParams) -> Result<Argon2<'static>, AppError> {
    if p.algorithm != "argon2id" {
        return Err(AppError::VaultError(format!(
            "Unsupported KDF algorithm: {}",
            p.algorithm
        )));
    }
    let params = Params::new(p.m_cost, p.t_cost, p.p_cost, None)
        .map_err(|e| AppError::VaultError(format!("Invalid KDF params: {e}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// On-disk shape. `kdf` and `verifier` are absent in legacy v1 files, so they
/// are optional here and presence drives the v1-vs-v2 branch in `unlock`.
/// `deny_unknown_fields` makes a corrupt or tampered file fail loudly at parse
/// time instead of silently ignoring junk/typo'd keys.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultFile {
    version: u32,
    salt: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    kdf: Option<KdfParams>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    verifier: Option<String>,
    credentials: HashMap<String, String>,
}

// ─── Vault ──────────────────────────────────────────────

pub struct Vault {
    file_path: PathBuf,
    // TODO(security): best-effort mlock to keep key out of swap
    derived_key: Option<Zeroizing<[u8; 32]>>,
    salt: [u8; SALT_SIZE],
    kdf_params: KdfParams,
    credentials: HashMap<String, Vec<u8>>,
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.lock();
    }
}

impl Vault {
    /// Check if vault file exists on disk.
    pub fn exists(data_dir: &Path) -> bool {
        data_dir.join(VAULT_FILE).exists()
    }

    /// Create a new vault with a master password.
    ///
    /// Generates a random salt, derives the encryption key via Argon2id,
    /// and writes an empty vault file to disk.
    pub fn create(data_dir: &Path, master_password: &str) -> Result<Self, AppError> {
        let file_path = data_dir.join(VAULT_FILE);

        // Ensure parent directory exists
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::VaultError(format!("Failed to create vault directory: {e}"))
            })?;
        }

        // Generate random salt
        let mut salt = [0u8; SALT_SIZE];
        OsRng.fill_bytes(&mut salt);

        // Derive key with the current default KDF params
        let kdf_params = default_kdf_params();
        let derived_key = Self::derive_key(master_password, &salt, &kdf_params)?;

        let vault = Vault {
            file_path,
            derived_key: Some(derived_key),
            salt,
            kdf_params,
            credentials: HashMap::new(),
        };

        vault.save_to_disk()?;

        Ok(vault)
    }

    /// Open an existing vault with the master password.
    ///
    /// For v2 vaults the password is validated by decrypting a fixed verifier
    /// (works regardless of credential count). v1 vaults are read with the
    /// legacy KDF params, validated against their credentials (when any), then
    /// transparently re-encrypted and rewritten as v2.
    pub fn unlock(data_dir: &Path, master_password: &str) -> Result<Self, AppError> {
        let file_path = data_dir.join(VAULT_FILE);

        let contents = std::fs::read_to_string(&file_path)
            .map_err(|e| AppError::VaultError(format!("Failed to read vault file: {e}")))?;

        let vault_file: VaultFile = serde_json::from_str(&contents)
            .map_err(|e| AppError::VaultError(format!("Corrupt vault file: {e}")))?;

        // Decode salt (shared by both formats)
        let salt_bytes = BASE64
            .decode(&vault_file.salt)
            .map_err(|e| AppError::VaultError(format!("Invalid salt encoding: {e}")))?;
        if salt_bytes.len() != SALT_SIZE {
            return Err(AppError::VaultError("Invalid salt length".to_string()));
        }
        let mut salt = [0u8; SALT_SIZE];
        salt.copy_from_slice(&salt_bytes);

        // Decode all credentials from base64 (shared by both formats)
        let mut credentials = HashMap::new();
        for (key, b64_val) in &vault_file.credentials {
            let bytes = BASE64.decode(b64_val).map_err(|e| {
                AppError::VaultError(format!("Invalid credential encoding for {key}: {e}"))
            })?;
            credentials.insert(key.clone(), bytes);
        }

        // Branch on the file shape: a v2 file carries `kdf` + `verifier`; a v1
        // file (version 1, no kdf/verifier) takes the legacy migration path.
        let vault = match (vault_file.version, &vault_file.kdf, &vault_file.verifier) {
            (VAULT_VERSION, Some(kdf), Some(verifier_b64)) => {
                let kdf_params = kdf.clone();
                let derived_key = Self::derive_key(master_password, &salt, &kdf_params)?;

                let vault = Vault {
                    file_path,
                    derived_key: Some(derived_key),
                    salt,
                    kdf_params,
                    credentials,
                };

                // Validate the password by decrypting the fixed verifier; an
                // AEAD failure means a wrong password (or tampered verifier).
                let verifier_bytes = BASE64
                    .decode(verifier_b64)
                    .map_err(|e| AppError::VaultError(format!("Invalid verifier encoding: {e}")))?;
                let plaintext = vault
                    .decrypt_raw(&verifier_bytes)
                    .map_err(|_| AppError::VaultWrongPassword)?;
                if plaintext != VERIFIER_PLAINTEXT {
                    return Err(AppError::VaultWrongPassword);
                }

                vault
            }
            (1, None, None) => Self::migrate_v1(file_path, master_password, salt, credentials)?,
            (version, _, _) => {
                return Err(AppError::VaultError(format!(
                    "Unsupported vault version: {version}"
                )));
            }
        };

        // Idempotent migration: re-apply owner-only access to the existing
        // vault file in case it was created by an older version of the app
        // that didn't tighten permissions, or before fs_secure existed.
        if let Err(e) = fs_secure::harden_existing(&vault.file_path) {
            tracing::warn!("Failed to harden existing vault file: {e}");
        }

        Ok(vault)
    }

    /// Read a legacy v1 vault: derive the key with the legacy Argon2 default
    /// params, validate the password against the existing credentials (when
    /// any exist), then re-key with the current default params and rewrite the
    /// file as v2 with a verifier.
    ///
    /// NOTE: an EMPTY v1 vault cannot validate the password (the pre-existing
    /// v1 limitation — there is nothing to decrypt), so we accept any password
    /// for it, migrate, and write the verifier going forward.
    fn migrate_v1(
        file_path: PathBuf,
        master_password: &str,
        salt: [u8; SALT_SIZE],
        legacy_credentials: HashMap<String, Vec<u8>>,
    ) -> Result<Self, AppError> {
        // Legacy v1 used `Argon2::default()` (m=19456, t=2, p=1).
        let legacy_params = KdfParams {
            algorithm: "argon2id".to_string(),
            m_cost: Params::DEFAULT_M_COST,
            t_cost: Params::DEFAULT_T_COST,
            p_cost: Params::DEFAULT_P_COST,
        };
        let legacy_key = Self::derive_key(master_password, &salt, &legacy_params)?;

        // Decrypt all credentials with the legacy key. A non-empty vault thus
        // validates the password here (an AEAD failure ⇒ wrong password).
        let legacy_vault = Vault {
            file_path: file_path.clone(),
            derived_key: Some(legacy_key),
            salt,
            kdf_params: legacy_params,
            credentials: legacy_credentials,
        };
        let mut plaintext_map: HashMap<String, String> = HashMap::new();
        for (key, encrypted) in &legacy_vault.credentials {
            let plain = legacy_vault
                .decrypt(encrypted)
                .map_err(|_| AppError::VaultWrongPassword)?;
            plaintext_map.insert(key.clone(), plain);
        }

        // Re-key with the current default params and a fresh salt, then
        // re-encrypt every credential. save_to_disk() writes the v2 file with
        // the verifier.
        let mut new_salt = [0u8; SALT_SIZE];
        OsRng.fill_bytes(&mut new_salt);
        let kdf_params = default_kdf_params();
        let new_key = Self::derive_key(master_password, &new_salt, &kdf_params)?;

        let mut vault = Vault {
            file_path,
            derived_key: Some(new_key),
            salt: new_salt,
            kdf_params,
            credentials: HashMap::new(),
        };
        for (key, plain) in &plaintext_map {
            let encrypted = vault.encrypt(plain)?;
            vault.credentials.insert(key.clone(), encrypted);
        }

        vault.save_to_disk()?;

        Ok(vault)
    }

    /// Store a credential (encrypt + save to disk).
    pub fn store(&mut self, key: &str, value: &str) -> Result<(), AppError> {
        let encrypted = self.encrypt(value)?;
        self.credentials.insert(key.to_owned(), encrypted);
        self.save_to_disk()
    }

    /// Get a credential (decrypt from memory).
    ///
    /// The decrypted plaintext is returned wrapped in `Zeroizing` so it is
    /// wiped from the heap when the caller drops it. Callers should keep it
    /// wrapped for as long as possible and avoid copying it into bare `String`s.
    pub fn get(&self, key: &str) -> Result<Option<Zeroizing<String>>, AppError> {
        match self.credentials.get(key) {
            Some(encrypted) => {
                let plaintext = self.decrypt(encrypted)?;
                Ok(Some(Zeroizing::new(plaintext)))
            }
            None => Ok(None),
        }
    }

    /// Check if a credential exists.
    pub fn has(&self, key: &str) -> bool {
        self.credentials.contains_key(key)
    }

    /// Delete a credential.
    pub fn delete(&mut self, key: &str) -> Result<(), AppError> {
        self.credentials.remove(key);
        self.save_to_disk()
    }

    /// Delete all credentials matching a key prefix (e.g., "profile_id:").
    pub fn delete_by_prefix(&mut self, prefix: &str) -> Result<(), AppError> {
        self.credentials.retain(|k, _| !k.starts_with(prefix));
        self.save_to_disk()
    }

    /// Change the master password — re-derive key and re-encrypt all credentials.
    pub fn change_master_password(&mut self, new_password: &str) -> Result<(), AppError> {
        // Decrypt all credentials with current key
        let mut plaintext_map: HashMap<String, String> = HashMap::new();
        for (key, encrypted) in &self.credentials {
            let plain = self.decrypt(encrypted)?;
            plaintext_map.insert(key.clone(), plain);
        }

        // Generate new salt and derive new key with the current default params
        let mut new_salt = [0u8; SALT_SIZE];
        OsRng.fill_bytes(&mut new_salt);
        self.kdf_params = default_kdf_params();
        let new_key = Self::derive_key(new_password, &new_salt, &self.kdf_params)?;

        // Replacing the key drops the old Zeroizing wrapper, which zeroizes it.
        self.salt = new_salt;
        self.derived_key = Some(new_key);

        // Re-encrypt all credentials with new key
        self.credentials.clear();
        for (key, plain) in &plaintext_map {
            let encrypted = self.encrypt(plain)?;
            self.credentials.insert(key.clone(), encrypted);
        }

        self.save_to_disk()
    }

    /// Lock the vault — clear derived key from memory. Dropping the
    /// `Zeroizing` wrapper zeroizes the key bytes.
    pub fn lock(&mut self) {
        self.derived_key = None;
    }

    /// Check if the vault is unlocked (has a derived key in memory).
    pub fn is_unlocked(&self) -> bool {
        self.derived_key.is_some()
    }

    // ─── Private Helpers ────────────────────────────────

    /// Derive a 32-byte key from password + salt using Argon2id with the
    /// supplied KDF params. The key is wrapped in `Zeroizing` so it is wiped
    /// from memory on drop.
    fn derive_key(
        password: &str,
        salt: &[u8; SALT_SIZE],
        params: &KdfParams,
    ) -> Result<Zeroizing<[u8; 32]>, AppError> {
        let mut key = Zeroizing::new([0u8; 32]);
        argon2_from_params(params)?
            .hash_password_into(password.as_bytes(), salt, key.as_mut())
            .map_err(|e| AppError::VaultError(format!("Key derivation failed: {e}")))?;
        Ok(key)
    }

    /// Encrypt raw bytes → nonce(12) + ciphertext + tag(16).
    fn encrypt_bytes(&self, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        let key = self.derived_key.as_ref().ok_or(AppError::VaultLocked)?;

        let cipher = Aes256Gcm::new_from_slice(key.as_slice())
            .map_err(|e| AppError::VaultError(format!("Cipher init failed: {e}")))?;

        // Generate random nonce
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| AppError::VaultError(format!("Encryption failed: {e}")))?;

        // Prepend nonce to ciphertext
        let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(result)
    }

    /// Encrypt a plaintext string → nonce(12) + ciphertext + tag(16).
    fn encrypt(&self, plaintext: &str) -> Result<Vec<u8>, AppError> {
        self.encrypt_bytes(plaintext.as_bytes())
    }

    /// Decrypt nonce(12) + ciphertext + tag(16) → raw plaintext bytes.
    fn decrypt_raw(&self, data: &[u8]) -> Result<Vec<u8>, AppError> {
        let key = self.derived_key.as_ref().ok_or(AppError::VaultLocked)?;

        if data.len() < NONCE_SIZE + 16 {
            return Err(AppError::VaultError("Ciphertext too short".to_string()));
        }

        let cipher = Aes256Gcm::new_from_slice(key.as_slice())
            .map_err(|e| AppError::VaultError(format!("Cipher init failed: {e}")))?;

        let nonce = Nonce::from_slice(&data[..NONCE_SIZE]);
        let ciphertext = &data[NONCE_SIZE..];

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| AppError::VaultError("Decryption failed".to_string()))
    }

    /// Decrypt nonce(12) + ciphertext + tag(16) → plaintext string.
    fn decrypt(&self, data: &[u8]) -> Result<String, AppError> {
        let plaintext = self.decrypt_raw(data)?;
        String::from_utf8(plaintext)
            .map_err(|e| AppError::VaultError(format!("Invalid UTF-8 in credential: {e}")))
    }

    /// Save vault to disk via fs_secure: atomic temp-file write with
    /// owner-only permissions/ACL applied BEFORE rename.
    fn save_to_disk(&self) -> Result<(), AppError> {
        // Encode credentials to base64
        let mut encoded_creds = HashMap::new();
        for (key, bytes) in &self.credentials {
            encoded_creds.insert(key.clone(), BASE64.encode(bytes));
        }

        // Freshly encrypt the verifier under the current key (new nonce each
        // save) so the master password can be validated on the next unlock
        // regardless of credential count.
        let verifier = self.encrypt_bytes(VERIFIER_PLAINTEXT)?;

        let vault_file = VaultFile {
            version: VAULT_VERSION,
            salt: BASE64.encode(self.salt),
            kdf: Some(self.kdf_params.clone()),
            verifier: Some(BASE64.encode(&verifier)),
            credentials: encoded_creds,
        };

        let json = serde_json::to_string_pretty(&vault_file)
            .map_err(|e| AppError::VaultError(format!("Failed to serialize vault: {e}")))?;

        // Ensure parent directory exists
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::VaultError(format!("Failed to create vault directory: {e}"))
            })?;
        }

        fs_secure::secure_write(&self.file_path, json.as_bytes())
            .map_err(|e| AppError::VaultError(format!("Failed to write vault: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_vault_json(dir: &Path) -> serde_json::Value {
        let contents = std::fs::read_to_string(dir.join(VAULT_FILE)).unwrap();
        serde_json::from_str(&contents).unwrap()
    }

    #[test]
    fn unlock_empty_vault_rejects_wrong_password() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _vault = Vault::create(dir.path(), "correct-horse").unwrap();
        }

        let result = Vault::unlock(dir.path(), "wrong").map(|_| ());
        assert!(
            matches!(result, Err(AppError::VaultWrongPassword)),
            "empty vault must reject a wrong master password, got {result:?}"
        );
    }

    #[test]
    fn unlock_empty_vault_accepts_correct_password() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _vault = Vault::create(dir.path(), "correct-horse").unwrap();
        }

        let vault = Vault::unlock(dir.path(), "correct-horse").unwrap();
        assert!(vault.is_unlocked());
    }

    #[test]
    fn unlock_nonempty_rejects_wrong_password() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut vault = Vault::create(dir.path(), "correct-horse").unwrap();
            vault.store("p1:password", "s3cr3t").unwrap();
        }

        let result = Vault::unlock(dir.path(), "wrong").map(|_| ());
        assert!(
            matches!(result, Err(AppError::VaultWrongPassword)),
            "non-empty vault must reject a wrong master password, got {result:?}"
        );
    }

    #[test]
    fn unlock_nonempty_accepts_correct() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut vault = Vault::create(dir.path(), "correct-horse").unwrap();
            vault.store("p1:password", "s3cr3t").unwrap();
        }

        let vault = Vault::unlock(dir.path(), "correct-horse").unwrap();
        assert!(vault.is_unlocked());
        assert_eq!(
            vault.get("p1:password").unwrap().map(|z| z.to_string()),
            Some("s3cr3t".to_string())
        );
    }

    #[test]
    fn vault_file_persists_kdf_params() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _vault = Vault::create(dir.path(), "correct-horse").unwrap();
        }

        let json = read_vault_json(dir.path());
        assert_eq!(json["version"], 2);
        assert_eq!(json["kdf"]["algorithm"], "argon2id");
        assert_eq!(json["kdf"]["m_cost"], 65536);
        assert_eq!(json["kdf"]["t_cost"], 3);
        assert_eq!(json["kdf"]["p_cost"], 1);
        let verifier = json["verifier"].as_str().unwrap();
        assert!(
            !verifier.is_empty(),
            "verifier must be present and non-empty"
        );
    }

    /// Hand-write a legacy v1 vault file (old shape: no `kdf`, no `verifier`),
    /// using the legacy Argon2 default params, and confirm `unlock` migrates it.
    #[test]
    fn v1_vault_migrates_to_v2() {
        let dir = tempfile::tempdir().unwrap();
        let password = "correct-horse";

        // Build a legacy v1 file by hand.
        let mut salt = [0u8; SALT_SIZE];
        OsRng.fill_bytes(&mut salt);
        let legacy_key = legacy_derive_key(password, &salt);

        // Encrypt one credential with the legacy key the same way v1 did.
        let plaintext = "s3cr3t";
        let cipher = Aes256Gcm::new_from_slice(&legacy_key).unwrap();
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = cipher.encrypt(nonce, plaintext.as_bytes()).unwrap();
        let mut blob = Vec::with_capacity(NONCE_SIZE + ct.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ct);

        let mut creds = HashMap::new();
        creds.insert("p1:password".to_string(), BASE64.encode(&blob));

        let v1 = serde_json::json!({
            "version": 1,
            "salt": BASE64.encode(salt),
            "credentials": creds,
        });
        std::fs::write(
            dir.path().join(VAULT_FILE),
            serde_json::to_string_pretty(&v1).unwrap(),
        )
        .unwrap();

        // Wrong password on a non-empty v1 vault must fail.
        let wrong = Vault::unlock(dir.path(), "nope").map(|_| ());
        assert!(
            matches!(wrong, Err(AppError::VaultWrongPassword)),
            "v1 unlock with wrong password must fail, got {wrong:?}"
        );

        // Correct password unlocks and decrypts the credential.
        let vault = Vault::unlock(dir.path(), password).unwrap();
        assert_eq!(
            vault.get("p1:password").unwrap().map(|z| z.to_string()),
            Some(plaintext.to_string())
        );
        drop(vault);

        // The file on disk has been upgraded to v2 with a verifier.
        let json = read_vault_json(dir.path());
        assert_eq!(json["version"], 2);
        assert!(json["verifier"].as_str().is_some_and(|v| !v.is_empty()));
        assert_eq!(json["kdf"]["m_cost"], 65536);

        // And it still opens with the correct password after migration.
        let reopened = Vault::unlock(dir.path(), password).unwrap();
        assert_eq!(
            reopened.get("p1:password").unwrap().map(|z| z.to_string()),
            Some(plaintext.to_string())
        );
    }

    #[test]
    fn change_master_password_rotates_verifier() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut vault = Vault::create(dir.path(), "old-pass").unwrap();
            vault.store("p1:password", "s3cr3t").unwrap();
            let salt_before = read_vault_json(dir.path())["salt"]
                .as_str()
                .unwrap()
                .to_string();
            vault.change_master_password("new-pass").unwrap();
            let salt_after = read_vault_json(dir.path())["salt"]
                .as_str()
                .unwrap()
                .to_string();
            assert_ne!(
                salt_before, salt_after,
                "salt must rotate on password change"
            );
        }

        // Old password no longer works.
        let old = Vault::unlock(dir.path(), "old-pass").map(|_| ());
        assert!(
            matches!(old, Err(AppError::VaultWrongPassword)),
            "old password must fail after change, got {old:?}"
        );

        // New password works and credential survives.
        let vault = Vault::unlock(dir.path(), "new-pass").unwrap();
        assert_eq!(
            vault.get("p1:password").unwrap().map(|z| z.to_string()),
            Some("s3cr3t".to_string())
        );
    }

    /// Derive a key with the legacy Argon2 default params (m=19456, t=2, p=1),
    /// matching how v1 vaults were created via `Argon2::default()`.
    fn legacy_derive_key(password: &str, salt: &[u8; SALT_SIZE]) -> [u8; 32] {
        let mut key = [0u8; 32];
        Argon2::default()
            .hash_password_into(password.as_bytes(), salt, &mut key)
            .unwrap();
        key
    }
}
