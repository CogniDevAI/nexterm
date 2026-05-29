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

/// Compute SHA-256 fingerprint from a base64-encoded key (as stored in known_hosts).
/// Returns a human-readable "SHA256:..." string, or a fallback if decoding fails.
fn fingerprint_from_base64(key_b64: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    match base64::engine::general_purpose::STANDARD.decode(key_b64) {
        Ok(key_bytes) => {
            let hash = Sha256::digest(&key_bytes);
            let b64 = base64_encode_nopad(&hash);
            format!("SHA256:{b64}")
        }
        Err(_) => "(unable to compute fingerprint)".to_string(),
    }
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

/// Match an already port-qualified host string against an OpenSSH hashed
/// known_hosts pattern "|1|<b64salt>|<b64hash>" (hash = HMAC-SHA1(salt, host)).
/// Returns false on any malformed pattern or decode error (fail-closed).
fn hashed_pattern_matches(pattern: &str, host_pattern: &str) -> bool {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    let parts: Vec<&str> = pattern.split('|').collect();
    // Expected shape: ["", "1", salt_b64, hash_b64]
    if parts.len() != 4 || parts[1] != "1" {
        return false;
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let (salt, expected) = match (engine.decode(parts[2]), engine.decode(parts[3])) {
        (Ok(s), Ok(h)) => (s, h),
        _ => return false,
    };
    let mut mac = match Hmac::<Sha1>::new_from_slice(&salt) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(host_pattern.as_bytes());
    mac.verify_slice(&expected).is_ok() // constant-time compare
}

/// Check if a known_hosts entry matches a given host:port
fn entry_matches_host(entry: &KnownHostEntry, host: &str, port: u16) -> bool {
    let pattern = format_host_pattern(host, port);

    if entry.is_hashed {
        // OpenSSH hashes hostnames with HMAC-SHA1 and a per-entry salt
        // (HashKnownHosts yes — the default on Debian/Ubuntu). Recompute the
        // HMAC over the canonical host string and compare against the stored hash.
        return hashed_pattern_matches(&entry.host_pattern, &pattern);
    }

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
    let mut different_type_entry: Option<&KnownHostEntry> = None;

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
                let old_fp = fingerprint_from_base64(&entry.key_data);
                return Ok(HostKeyStatus::Changed {
                    old_fingerprint: old_fp,
                    new_fingerprint: incoming_fp,
                    key_type: incoming_type,
                    old_key_type: None,
                });
            }
        } else {
            // Host matched but with a different key type — remember it
            different_type_entry = Some(entry);
        }
    }

    if let Some(entry) = different_type_entry {
        // Host exists but the server now presents a key of a DIFFERENT type than
        // the one we trusted. While this can be a legitimate algorithm upgrade
        // (e.g. ssh-rsa → ssh-ed25519), it can EQUALLY be a MITM presenting an
        // attacker-controlled key under a new algorithm. We therefore treat it
        // as a key change that requires explicit user verification — never auto-trust.
        let old_fp = fingerprint_from_base64(&entry.key_data);
        Ok(HostKeyStatus::Changed {
            old_fingerprint: old_fp,
            new_fingerprint: incoming_fp,
            key_type: incoming_type,
            old_key_type: Some(entry.key_type.clone()),
        })
    } else if !found_host {
        // Unknown host
        Ok(HostKeyStatus::Unknown {
            fingerprint: incoming_fp,
            key_type: incoming_type,
        })
    } else {
        // Host was found with a matching key type — already returned early
        // inside the loop (Trusted or Changed). This branch is logically
        // unreachable, but Rust cannot prove it statically.
        Ok(HostKeyStatus::Trusted)
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

    // ─── Hashed Host Matching ───────────────────────────

    /// GOLD-STANDARD, non-circular: RFC 2202 HMAC-SHA1 Test Case 2.
    ///   key/salt  = b"Jefe"
    ///   message   = "what do ya want for nothing?"
    ///   HMAC-SHA1 = effcdf6ae5eb2fa2d27416d5f184df9c259a7c79 (published constant)
    /// Because the digest is the RFC's published value (NOT recomputed here),
    /// a passing test proves our HMAC-SHA1 wiring is correct, not just consistent.
    #[test]
    fn hashed_pattern_matches_rfc2202_vector() {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;

        let salt = b"Jefe";
        let digest: [u8; 20] = [
            0xef, 0xfc, 0xdf, 0x6a, 0xe5, 0xeb, 0x2f, 0xa2, 0xd2, 0x74, 0x16, 0xd5, 0xf1, 0x84,
            0xdf, 0x9c, 0x25, 0x9a, 0x7c, 0x79,
        ];
        let pattern = format!("|1|{}|{}", engine.encode(salt), engine.encode(digest));

        assert!(hashed_pattern_matches(
            &pattern,
            "what do ya want for nothing?"
        ));
        assert!(!hashed_pattern_matches(&pattern, "different host"));
    }

    /// Round-trip through entry_matches_host for the [host]:port canonical form.
    #[test]
    fn entry_matches_hashed_host_with_port() {
        use base64::Engine;
        use hmac::{Hmac, Mac};
        use sha1::Sha1;
        let engine = base64::engine::general_purpose::STANDARD;

        // Hash the canonical port-qualified host string with a fixed salt.
        let salt: &[u8] = b"fixed-salt-bytes";
        let canonical = "[example.com]:2222";
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        mac.update(canonical.as_bytes());
        let digest = mac.finalize().into_bytes();
        let host_pattern = format!("|1|{}|{}", engine.encode(salt), engine.encode(digest));

        let entry = KnownHostEntry {
            host_pattern,
            key_type: "ssh-ed25519".to_string(),
            key_data: "AAAA".to_string(),
            is_hashed: true,
        };

        assert!(entry_matches_host(&entry, "example.com", 2222));
        assert!(!entry_matches_host(&entry, "example.com", 22));
    }

    /// Malformed patterns must fail closed (return false) without panicking.
    #[test]
    fn hashed_pattern_malformed_fails_closed() {
        // Too few parts.
        assert!(!hashed_pattern_matches("|1|onlytwo", "x"));
        // Wrong hash id (not SHA-1).
        assert!(!hashed_pattern_matches("|2|a|b", "x"));
        // Invalid base64 in both salt and hash slots.
        assert!(!hashed_pattern_matches("|1|!!!notbase64!!!|@@@", "x"));
    }

    /// Real OpenSSH compatibility: a line produced by `ssh-keygen -H` for the
    /// hostname "nexterm-test.example.org" (port 22 → plain hostname canonical
    /// form). Proves byte-for-byte interop with real OpenSSH hashing.
    #[test]
    fn hashed_pattern_matches_real_ssh_keygen_vector() {
        let pattern = "|1|TCRWaBiLmieu2rtDS1GKt2c87qU=|8OW88QaCVj66I1DOxvYkXZXi+44=";
        assert!(hashed_pattern_matches(pattern, "nexterm-test.example.org"));
        assert!(!hashed_pattern_matches(pattern, "wrong.example.org"));

        // And end-to-end through entry_matches_host (port 22 canonical form).
        let entry = KnownHostEntry {
            host_pattern: pattern.to_string(),
            key_type: "ssh-ed25519".to_string(),
            key_data: "AAAA".to_string(),
            is_hashed: true,
        };
        assert!(entry_matches_host(&entry, "nexterm-test.example.org", 22));
        assert!(!entry_matches_host(
            &entry,
            "nexterm-test.example.org",
            2222
        ));
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
