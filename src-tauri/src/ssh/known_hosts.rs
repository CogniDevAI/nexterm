// ssh/known_hosts.rs — Host key verification and known_hosts management
//
// Reads/writes OpenSSH-compatible known_hosts file.
// Supports plain hostnames and [host]:port format for non-standard ports.
// Hashed hostnames are recognized but not generated (we add plain entries).

use std::io::{BufRead, Write};
use std::path::PathBuf;

use russh::keys::ssh_key::PublicKey;
use ssh_key::public::KeyData;

use crate::error::AppError;
use crate::state::HostKeyStatus;

// ─── Known Hosts Entry ──────────────────────────────────

#[derive(Debug, Clone)]
pub struct KnownHostEntry {
    /// Raw hostname pattern from the file (may be hashed, may include port)
    pub host_pattern: String,
    /// Key type string (e.g., "ssh-ed25519", "ssh-rsa")
    pub key_type: String,
    /// Base64-encoded public key
    pub key_data: String,
    /// Whether this entry uses a hashed hostname
    pub is_hashed: bool,
}

#[derive(Debug, Default)]
pub struct KnownHostsDb {
    pub entries: Vec<KnownHostEntry>,
}

// ─── Path Resolution ────────────────────────────────────

/// Returns the path to the known_hosts file (~/.ssh/known_hosts)
pub fn known_hosts_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ssh").join("known_hosts")
}

// ─── Fingerprint Computation ────────────────────────────

/// Compute SHA-256 fingerprint of a public key in the standard format
pub fn fingerprint(key: &PublicKey) -> String {
    use sha2::{Digest, Sha256};

    // Serialize the key to the wire format
    let key_bytes = key.to_bytes().unwrap_or_default();
    let hash = Sha256::digest(&key_bytes);
    let b64 = base64_encode_nopad(&hash);
    format!("SHA256:{b64}")
}

/// Base64 encode without padding (matches OpenSSH fingerprint format)
fn base64_encode_nopad(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(data)
}

/// Get the key type string from a public key
pub fn key_type_str(key: &PublicKey) -> String {
    match key.key_data() {
        KeyData::Rsa(_) => "ssh-rsa".to_string(),
        KeyData::Ed25519(_) => "ssh-ed25519".to_string(),
        KeyData::Ecdsa(ec) => format!("ecdsa-sha2-{}", ec.curve()),
        _ => "unknown".to_string(),
    }
}

// ─── Host Pattern Matching ──────────────────────────────

/// Format the hostname for known_hosts lookup
/// Standard port 22 → plain hostname
/// Non-standard port → [hostname]:port
fn format_host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Check if a known_hosts entry matches a given host:port
fn entry_matches_host(entry: &KnownHostEntry, host: &str, port: u16) -> bool {
    if entry.is_hashed {
        // We can't match hashed entries without the salt — skip
        // (OpenSSH's hashing uses HMAC-SHA1 with a per-entry salt)
        return false;
    }

    let pattern = format_host_pattern(host, port);

    // The host_pattern field may contain comma-separated hostnames
    entry.host_pattern.split(',').any(|h| h.trim() == pattern)
}

// ─── Load Known Hosts ───────────────────────────────────

/// Load and parse the known_hosts file
pub fn load_known_hosts() -> Result<KnownHostsDb, AppError> {
    let path = known_hosts_path();

    if !path.exists() {
        return Ok(KnownHostsDb::default());
    }

    let file = std::fs::File::open(&path)?;
    let reader = std::io::BufReader::new(file);

    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line?;
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Skip @cert-authority and @revoked markers for now
        // Format: hostname key-type base64-key [comment]
        let parts: Vec<&str> = line.splitn(3, char::is_whitespace).collect();
        if parts.len() < 3 {
            continue; // malformed line
        }

        let host_pattern = parts[0].to_string();
        let key_type = parts[1].to_string();
        // The base64 key may have a trailing comment — take only the key
        let key_data = parts[2].split_whitespace().next().unwrap_or("").to_string();

        let is_hashed = host_pattern.starts_with("|1|");

        entries.push(KnownHostEntry {
            host_pattern,
            key_type,
            key_data,
            is_hashed,
        });
    }

    Ok(KnownHostsDb { entries })
}

// ─── Verify Host Key ────────────────────────────────────

/// Verify a server's host key against the known_hosts database
pub fn verify_host_key(host: &str, port: u16, key: &PublicKey) -> Result<HostKeyStatus, AppError> {
    let db = load_known_hosts()?;
    let incoming_type = key_type_str(key);
    let incoming_fp = fingerprint(key);

    // Encode the incoming key to base64 for comparison
    let incoming_b64 = {
        use base64::Engine;
        let key_bytes = key.to_bytes().unwrap_or_default();
        base64::engine::general_purpose::STANDARD.encode(&key_bytes)
    };

    // Check all entries that match this host
    let mut found_host = false;

    for entry in &db.entries {
        if !entry_matches_host(entry, host, port) {
            continue;
        }

        found_host = true;

        // Same key type — compare key data
        if entry.key_type == incoming_type {
            if entry.key_data == incoming_b64 {
                return Ok(HostKeyStatus::Trusted);
            } else {
                // KEY CHANGED — potential MITM
                return Ok(HostKeyStatus::Changed {
                    old_fingerprint: "(stored in known_hosts)".to_string(),
                    new_fingerprint: incoming_fp,
                    key_type: incoming_type,
                });
            }
        }
    }

    if found_host {
        // Host exists but with different key type — treat as changed
        Ok(HostKeyStatus::Changed {
            old_fingerprint: "(different key type in known_hosts)".to_string(),
            new_fingerprint: incoming_fp,
            key_type: incoming_type,
        })
    } else {
        // Unknown host
        Ok(HostKeyStatus::Unknown {
            fingerprint: incoming_fp,
            key_type: incoming_type,
        })
    }
}

// ─── Add Host Key ───────────────────────────────────────

/// Add a host key entry to the known_hosts file
pub fn add_host_key(host: &str, port: u16, key: &PublicKey) -> Result<(), AppError> {
    let path = known_hosts_path();

    // Ensure ~/.ssh/ directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let host_pattern = format_host_pattern(host, port);
    let key_type = key_type_str(key);

    let key_b64 = {
        use base64::Engine;
        let key_bytes = key.to_bytes().unwrap_or_default();
        base64::engine::general_purpose::STANDARD.encode(&key_bytes)
    };

    let entry_line = format!("{host_pattern} {key_type} {key_b64}\n");

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;

    file.write_all(entry_line.as_bytes())?;

    Ok(())
}

/// Remove existing entries for a host and add the new key.
/// Used when the user explicitly accepts a changed key.
///
/// Uses atomic write (write to temp file, then rename) to prevent
/// corruption from concurrent access (M9 fix).
pub fn update_host_key(host: &str, port: u16, key: &PublicKey) -> Result<(), AppError> {
    let path = known_hosts_path();

    // Ensure ~/.ssh/ directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Build the new key entry line
    let host_pattern = format_host_pattern(host, port);
    let key_type = key_type_str(key);
    let key_b64 = {
        use base64::Engine;
        let key_bytes = key.to_bytes().unwrap_or_default();
        base64::engine::general_purpose::STANDARD.encode(&key_bytes)
    };
    let new_entry_line = format!("{host_pattern} {key_type} {key_b64}");

    // Read existing content (if any), filter out old entries for this host,
    // append the new key, and write atomically via temp file + rename.
    let mut new_contents = String::new();

    if path.exists() {
        let contents = std::fs::read_to_string(&path)?;
        let pattern = format_host_pattern(host, port);

        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                new_contents.push_str(line);
                new_contents.push('\n');
                continue;
            }
            // Check if this line's host pattern matches — if so, skip it
            if let Some(host_part) = trimmed.split_whitespace().next() {
                if host_part.split(',').any(|h| h.trim() == pattern) {
                    continue; // Remove old entry for this host
                }
            }
            new_contents.push_str(line);
            new_contents.push('\n');
        }
    }

    // Append the new key entry
    new_contents.push_str(&new_entry_line);
    new_contents.push('\n');

    // Atomic write: write to a temp file in the same directory, then rename.
    // rename() on the same filesystem is atomic on POSIX systems.
    let parent = path.parent().ok_or_else(|| {
        AppError::Other("Cannot determine parent directory for known_hosts".to_string())
    })?;
    let temp_path = parent.join(".known_hosts.tmp");

    std::fs::write(&temp_path, &new_contents)?;

    // Set file permissions to 0600 before rename (Unix only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&temp_path, perms);
    }

    std::fs::rename(&temp_path, &path).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = std::fs::remove_file(&temp_path);
        AppError::Io(e)
    })?;

    Ok(())
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_host_pattern_standard_port() {
        assert_eq!(format_host_pattern("example.com", 22), "example.com");
    }

    #[test]
    fn format_host_pattern_nonstandard_port() {
        assert_eq!(
            format_host_pattern("example.com", 2222),
            "[example.com]:2222"
        );
    }

    #[test]
    fn entry_matches_plain_host() {
        let entry = KnownHostEntry {
            host_pattern: "example.com".to_string(),
            key_type: "ssh-ed25519".to_string(),
            key_data: "AAAA".to_string(),
            is_hashed: false,
        };
        assert!(entry_matches_host(&entry, "example.com", 22));
        assert!(!entry_matches_host(&entry, "other.com", 22));
    }

    #[test]
    fn entry_matches_with_port() {
        let entry = KnownHostEntry {
            host_pattern: "[example.com]:2222".to_string(),
            key_type: "ssh-ed25519".to_string(),
            key_data: "AAAA".to_string(),
            is_hashed: false,
        };
        assert!(entry_matches_host(&entry, "example.com", 2222));
        assert!(!entry_matches_host(&entry, "example.com", 22));
    }

    #[test]
    fn entry_matches_comma_separated() {
        let entry = KnownHostEntry {
            host_pattern: "example.com,192.168.1.1".to_string(),
            key_type: "ssh-rsa".to_string(),
            key_data: "AAAA".to_string(),
            is_hashed: false,
        };
        assert!(entry_matches_host(&entry, "example.com", 22));
        assert!(entry_matches_host(&entry, "192.168.1.1", 22));
        assert!(!entry_matches_host(&entry, "other.com", 22));
    }

    #[test]
    fn hashed_entry_does_not_match() {
        let entry = KnownHostEntry {
            host_pattern: "|1|salt|hash".to_string(),
            key_type: "ssh-ed25519".to_string(),
            key_data: "AAAA".to_string(),
            is_hashed: true,
        };
        // Hashed entries can't be matched without the salt
        assert!(!entry_matches_host(&entry, "example.com", 22));
    }

    #[test]
    fn parse_known_hosts_line() {
        let line = "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest user@machine";
        let parts: Vec<&str> = line.splitn(3, char::is_whitespace).collect();
        assert_eq!(parts[0], "example.com");
        assert_eq!(parts[1], "ssh-ed25519");
        // Third part includes key + comment
        let key_data = parts[2].split_whitespace().next().unwrap();
        assert_eq!(key_data, "AAAAC3NzaC1lZDI1NTE5AAAAITest");
    }
}
