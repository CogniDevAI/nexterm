// ssh/known_hosts.rs — Host key verification and known_hosts management
//
// Reads/writes OpenSSH-compatible known_hosts file.
// Supports plain hostnames and [host]:port format for non-standard ports.
// Hashed hostnames are recognized but not generated (we add plain entries).

use std::io::Write;
use std::path::PathBuf;

use russh::keys::ssh_key::PublicKey;
use ssh_key::public::KeyData;

use crate::error::AppError;
use crate::state::HostKeyStatus;

// ─── Known Hosts Entry ──────────────────────────────────

/// OpenSSH line marker. A line may be prefixed with `@revoked` or
/// `@cert-authority`; everything after the marker is parsed as a normal
/// `hostpattern keytype keydata` entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Marker {
    /// Plain host-key entry (no leading `@` token).
    #[default]
    None,
    /// `@revoked` — this exact key is revoked for the matching host(s).
    Revoked,
    /// `@cert-authority` — the key is a CA that signs host certificates,
    /// NOT a literal host key.
    CertAuthority,
}

#[derive(Debug, Clone)]
pub struct KnownHostEntry {
    /// Line marker (`@revoked` / `@cert-authority` / none).
    pub marker: Marker,
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

/// Parse known_hosts file contents into a `KnownHostsDb`. Pure function — no
/// I/O — so it is directly unit-testable. `load_known_hosts` reads the file
/// then delegates here.
///
/// Recognized line shapes:
///   `[@marker] hostpattern keytype keydata [comment]`
/// where `@marker` is an optional leading `@revoked` / `@cert-authority` token.
pub fn parse_known_hosts_str(contents: &str) -> KnownHostsDb {
    let mut entries = Vec::new();

    for line in contents.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // A line may begin with a `@revoked` / `@cert-authority` marker. Parse
        // it off, then parse the REMAINING `hostpattern keytype keydata` as a
        // normal entry.
        let (marker, rest) = match line.split_once(char::is_whitespace) {
            Some(("@revoked", rest)) => (Marker::Revoked, rest.trim_start()),
            Some(("@cert-authority", rest)) => (Marker::CertAuthority, rest.trim_start()),
            _ => (Marker::None, line),
        };

        // Format: hostname key-type base64-key [comment]
        let parts: Vec<&str> = rest.splitn(3, char::is_whitespace).collect();
        if parts.len() < 3 {
            continue; // malformed line
        }

        let host_pattern = parts[0].to_string();
        let key_type = parts[1].to_string();
        // The base64 key may have a trailing comment — take only the key
        let key_data = parts[2].split_whitespace().next().unwrap_or("").to_string();

        let is_hashed = host_pattern.starts_with("|1|");

        entries.push(KnownHostEntry {
            marker,
            host_pattern,
            key_type,
            key_data,
            is_hashed,
        });
    }

    KnownHostsDb { entries }
}

/// Load and parse the known_hosts file
pub fn load_known_hosts() -> Result<KnownHostsDb, AppError> {
    let path = known_hosts_path();

    if !path.exists() {
        return Ok(KnownHostsDb::default());
    }

    let contents = std::fs::read_to_string(&path)?;
    Ok(parse_known_hosts_str(&contents))
}

// ─── Verify Host Key ────────────────────────────────────

/// Classify a server's host key against an already-loaded known_hosts database.
/// Pure function — no I/O — so it is directly unit-testable. `verify_host_key`
/// loads the db then delegates here.
pub fn classify_host_key(
    db: &KnownHostsDb,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> HostKeyStatus {
    let incoming_type = key_type_str(key);
    let incoming_fp = fingerprint(key);

    // Encode the incoming key to base64 for comparison
    let incoming_b64 = {
        use base64::Engine;
        let key_bytes = key.to_bytes().unwrap_or_default();
        base64::engine::general_purpose::STANDARD.encode(&key_bytes)
    };

    // ── Revocation has PRECEDENCE over everything else ──
    // If an admin marked this exact key `@revoked` for a matching host, reject
    // it outright — even if a separate trusted entry exists for the same host.
    for entry in &db.entries {
        if entry.marker == Marker::Revoked
            && entry.key_data == incoming_b64
            && entry_matches_host(entry, host, port)
        {
            return HostKeyStatus::Revoked;
        }
    }

    // Check all entries that match this host
    let mut found_host = false;
    let mut different_type_entry: Option<&KnownHostEntry> = None;

    for entry in &db.entries {
        // Marked entries are NOT literal host keys for normal matching:
        //  - `@revoked` keys were already handled above (and must never count
        //    as Trusted/Changed/found here).
        //  - `@cert-authority` keys are CA signing keys, not host keys.
        // TODO(security): full @cert-authority host-certificate validation
        // (verifying a server-presented certificate against the CA key) is out
        // of scope; we only ensure a CA entry can't be mistaken for a regular
        // host-key match here.
        if entry.marker != Marker::None {
            continue;
        }

        if !entry_matches_host(entry, host, port) {
            continue;
        }

        found_host = true;

        // Same key type — compare key data
        if entry.key_type == incoming_type {
            if entry.key_data == incoming_b64 {
                return HostKeyStatus::Trusted;
            } else {
                // KEY CHANGED — potential MITM
                let old_fp = fingerprint_from_base64(&entry.key_data);
                return HostKeyStatus::Changed {
                    old_fingerprint: old_fp,
                    new_fingerprint: incoming_fp,
                    key_type: incoming_type,
                    old_key_type: None,
                };
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
        HostKeyStatus::Changed {
            old_fingerprint: old_fp,
            new_fingerprint: incoming_fp,
            key_type: incoming_type,
            old_key_type: Some(entry.key_type.clone()),
        }
    } else if !found_host {
        // Unknown host
        HostKeyStatus::Unknown {
            fingerprint: incoming_fp,
            key_type: incoming_type,
        }
    } else {
        // Host was found with a matching key type — already returned early
        // inside the loop (Trusted or Changed). This branch is logically
        // unreachable, but Rust cannot prove it statically.
        HostKeyStatus::Trusted
    }
}

/// Verify a server's host key against the known_hosts database
pub fn verify_host_key(host: &str, port: u16, key: &PublicKey) -> Result<HostKeyStatus, AppError> {
    let db = load_known_hosts()?;
    Ok(classify_host_key(&db, host, port, key))
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

/// Pure core of `update_host_key`: take the existing known_hosts contents,
/// drop every PLAIN host-key line whose host matches `host:port`, preserve
/// everything else (comments, blank lines, marker lines, other hosts), then
/// append `new_entry_line`. No I/O — directly unit-testable.
///
/// Matching is hash-aware (Fix A): on systems with `HashKnownHosts yes`
/// (Debian/Ubuntu default) the stored host_part is `|1|salt|hash`, which the
/// old plaintext comma-split compare could never match — leaving the STALE
/// hashed entry behind so `classify_host_key` could still match the superseded
/// key and return Trusted, defeating the rotation. We now detect a hashed
/// host_part and compare via `hashed_pattern_matches`.
///
/// Marker lines (`@revoked` / `@cert-authority`) are intentionally LEFT IN
/// PLACE even when their host matches: a `@revoked` marker must survive a
/// key-accept (the admin revoked a specific key; accepting a new one must not
/// silently erase that revocation), and a `@cert-authority` line is a CA
/// trust anchor, not a literal host key being rotated. Only plain host-key
/// lines for the target host are removed.
pub fn rewrite_known_hosts_contents(
    contents: &str,
    host: &str,
    port: u16,
    new_entry_line: &str,
) -> String {
    let pattern = format_host_pattern(host, port);
    let mut out = String::new();

    for line in contents.lines() {
        let trimmed = line.trim();

        // Preserve blank lines and comments verbatim.
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // Preserve marker lines (@revoked / @cert-authority) regardless of host:
        // revocations and CA anchors must outlive a key-accept.
        if trimmed.starts_with('@') {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // Drop plain host-key lines whose host_part matches the target host.
        if let Some(host_part) = trimmed.split_whitespace().next() {
            let matches = if host_part.starts_with("|1|") {
                // Hashed host_part — recompute HMAC against the canonical pattern.
                hashed_pattern_matches(host_part, &pattern)
            } else {
                // Plaintext host_part — keep the existing comma-split compare.
                host_part.split(',').any(|h| h.trim() == pattern)
            };
            if matches {
                continue; // Remove old entry for this host
            }
        }

        out.push_str(line);
        out.push('\n');
    }

    // Append the new key entry.
    out.push_str(new_entry_line);
    out.push('\n');

    out
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
    let existing = if path.exists() {
        std::fs::read_to_string(&path)?
    } else {
        String::new()
    };
    let new_contents = rewrite_known_hosts_contents(&existing, host, port, &new_entry_line);

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
            marker: Marker::None,
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
            marker: Marker::None,
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
            marker: Marker::None,
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
            marker: Marker::None,
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
            marker: Marker::None,
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

    // ─── Test helpers: deterministic Ed25519 keys ──────────

    /// Build a deterministic Ed25519 `PublicKey` from a fixed 32-byte seed.
    /// Same seed → same key, so tests are reproducible and two different seeds
    /// yield two genuinely different keys (real crypto, not stubs).
    fn ed25519_pubkey(seed: [u8; 32]) -> PublicKey {
        use ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey};
        use ssh_key::public::Ed25519PublicKey;

        let private = Ed25519PrivateKey::from_bytes(&seed);
        let keypair = Ed25519Keypair::from(private);
        PublicKey::from(Ed25519PublicKey::from(&keypair))
    }

    /// The canonical base64 wire encoding of a key, as stored in known_hosts.
    fn key_b64(key: &PublicKey) -> String {
        use base64::Engine;
        let bytes = key.to_bytes().unwrap();
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    }

    // ─── parse_known_hosts_str: markers ────────────────────

    #[test]
    fn parse_recognizes_revoked_marker() {
        let key = ed25519_pubkey([7u8; 32]);
        let line = format!("@revoked example.com ssh-ed25519 {}\n", key_b64(&key));

        let db = parse_known_hosts_str(&line);
        assert_eq!(db.entries.len(), 1);
        let e = &db.entries[0];
        assert_eq!(e.marker, Marker::Revoked);
        assert_eq!(e.host_pattern, "example.com");
        assert_eq!(e.key_type, "ssh-ed25519");
        assert_eq!(e.key_data, key_b64(&key));
        assert!(!e.is_hashed);
    }

    #[test]
    fn parse_recognizes_cert_authority_marker() {
        let key = ed25519_pubkey([8u8; 32]);
        let line = format!(
            "@cert-authority *.example.com ssh-ed25519 {}\n",
            key_b64(&key)
        );

        let db = parse_known_hosts_str(&line);
        assert_eq!(db.entries.len(), 1);
        let e = &db.entries[0];
        assert_eq!(e.marker, Marker::CertAuthority);
        assert_eq!(e.host_pattern, "*.example.com");
        assert_eq!(e.key_data, key_b64(&key));
    }

    #[test]
    fn parse_plain_entry_has_no_marker() {
        let key = ed25519_pubkey([9u8; 32]);
        let line = format!("example.com ssh-ed25519 {}\n", key_b64(&key));
        let db = parse_known_hosts_str(&line);
        assert_eq!(db.entries.len(), 1);
        assert_eq!(db.entries[0].marker, Marker::None);
    }

    // ─── Fix B: classify_host_key honors @revoked ──────────

    #[test]
    fn classify_revoked_key_returns_revoked() {
        let key = ed25519_pubkey([1u8; 32]);
        let line = format!("@revoked example.com ssh-ed25519 {}\n", key_b64(&key));
        let db = parse_known_hosts_str(&line);

        // Same host + same key as the @revoked entry → Revoked (no prompt).
        let status = classify_host_key(&db, "example.com", 22, &key);
        assert!(
            matches!(status, HostKeyStatus::Revoked),
            "expected Revoked, got {status:?}"
        );
    }

    #[test]
    fn classify_revoked_different_key_is_not_revoked() {
        // @revoked covers a SPECIFIC key; a different key for the same host is
        // not revoked — it should be Unknown (promptable), not silently rejected.
        let revoked_key = ed25519_pubkey([1u8; 32]);
        let other_key = ed25519_pubkey([2u8; 32]);
        let line = format!(
            "@revoked example.com ssh-ed25519 {}\n",
            key_b64(&revoked_key)
        );
        let db = parse_known_hosts_str(&line);

        let status = classify_host_key(&db, "example.com", 22, &other_key);
        assert!(
            matches!(status, HostKeyStatus::Unknown { .. }),
            "expected Unknown, got {status:?}"
        );
    }

    #[test]
    fn classify_cert_authority_is_not_trusted_host_key() {
        // A server presenting the exact CA key must NOT be auto-Trusted: a CA
        // entry is a signing anchor, not a literal host key. It stays Unknown
        // (and must not panic).
        let ca_key = ed25519_pubkey([3u8; 32]);
        let line = format!(
            "@cert-authority example.com ssh-ed25519 {}\n",
            key_b64(&ca_key)
        );
        let db = parse_known_hosts_str(&line);

        let status = classify_host_key(&db, "example.com", 22, &ca_key);
        assert!(
            matches!(status, HostKeyStatus::Unknown { .. }),
            "CA key must not be Trusted/Changed, got {status:?}"
        );
    }

    #[test]
    fn classify_revocation_wins_over_trusted_entry() {
        // File has BOTH a normal trusted entry AND a @revoked entry for the same
        // host + same key. Revocation must take precedence over Trusted.
        let key = ed25519_pubkey([4u8; 32]);
        let b64 = key_b64(&key);
        let contents =
            format!("example.com ssh-ed25519 {b64}\n@revoked example.com ssh-ed25519 {b64}\n");
        let db = parse_known_hosts_str(&contents);

        let status = classify_host_key(&db, "example.com", 22, &key);
        assert!(
            matches!(status, HostKeyStatus::Revoked),
            "revocation must win over Trusted, got {status:?}"
        );
    }

    #[test]
    fn classify_plain_trusted_still_works() {
        // Regression: a normal trusted entry still classifies as Trusted.
        let key = ed25519_pubkey([5u8; 32]);
        let line = format!("example.com ssh-ed25519 {}\n", key_b64(&key));
        let db = parse_known_hosts_str(&line);

        assert!(matches!(
            classify_host_key(&db, "example.com", 22, &key),
            HostKeyStatus::Trusted
        ));
    }

    // ─── Fix A: hash-aware rewrite on accepted key change ──

    /// Build a hashed host_part `|1|salt|hash` for a canonical host string,
    /// mirroring OpenSSH's HashKnownHosts (HMAC-SHA1 over the canonical name).
    fn hashed_host_part(canonical: &str, salt: &[u8]) -> String {
        use base64::Engine;
        use hmac::{Hmac, Mac};
        use sha1::Sha1;
        let engine = base64::engine::general_purpose::STANDARD;
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        mac.update(canonical.as_bytes());
        let digest = mac.finalize().into_bytes();
        format!("|1|{}|{}", engine.encode(salt), engine.encode(digest))
    }

    #[test]
    fn rewrite_removes_stale_hashed_entry_on_key_change() {
        // Simulate a Debian/Ubuntu HashKnownHosts file: the OLD key for
        // example.com is stored under a HASHED host_part. The user accepts a
        // NEW key. After rewrite, the stale hashed line MUST be gone and the
        // host MUST classify as Trusted against the NEW key only.
        let old_key = ed25519_pubkey([10u8; 32]);
        let new_key = ed25519_pubkey([11u8; 32]);

        let hashed = hashed_host_part("example.com", b"some-fixed-salt!");
        let old_contents = format!("{hashed} ssh-ed25519 {}\n", key_b64(&old_key));

        let new_line = format!("example.com ssh-ed25519 {}", key_b64(&new_key));
        let rewritten = rewrite_known_hosts_contents(&old_contents, "example.com", 22, &new_line);

        // New line present.
        assert!(rewritten.contains(&new_line), "rewritten:\n{rewritten}");
        // Stale hashed line gone.
        assert!(
            !rewritten.contains(&hashed),
            "stale hashed entry survived rewrite:\n{rewritten}"
        );

        // And it actually classifies correctly: new key Trusted, old key NOT
        // Trusted (would be Changed since same type, different data).
        let db = parse_known_hosts_str(&rewritten);
        assert!(matches!(
            classify_host_key(&db, "example.com", 22, &new_key),
            HostKeyStatus::Trusted
        ));
        assert!(
            !matches!(
                classify_host_key(&db, "example.com", 22, &old_key),
                HostKeyStatus::Trusted
            ),
            "old key must no longer be Trusted after rotation"
        );
    }

    #[test]
    fn rewrite_removes_plaintext_entry_regression() {
        // Regression: plaintext entries are still removed (original behavior).
        let old_key = ed25519_pubkey([12u8; 32]);
        let new_key = ed25519_pubkey([13u8; 32]);
        let old_contents = format!("example.com ssh-ed25519 {}\n", key_b64(&old_key));
        let new_line = format!("example.com ssh-ed25519 {}", key_b64(&new_key));

        let rewritten = rewrite_known_hosts_contents(&old_contents, "example.com", 22, &new_line);
        assert!(rewritten.contains(&new_line));
        assert!(!rewritten.contains(&key_b64(&old_key)));
    }

    #[test]
    fn rewrite_preserves_comments_blank_lines_and_other_hosts() {
        let new_key = ed25519_pubkey([14u8; 32]);
        let other_key = ed25519_pubkey([15u8; 32]);
        let target_old = ed25519_pubkey([16u8; 32]);

        let other_line = format!("other.com ssh-ed25519 {}", key_b64(&other_key));
        let old_contents = format!(
            "# a comment\n\nexample.com ssh-ed25519 {}\n{other_line}\n",
            key_b64(&target_old)
        );
        let new_line = format!("example.com ssh-ed25519 {}", key_b64(&new_key));

        let rewritten = rewrite_known_hosts_contents(&old_contents, "example.com", 22, &new_line);
        assert!(rewritten.contains("# a comment"));
        assert!(
            rewritten.contains(&other_line),
            "other host dropped:\n{rewritten}"
        );
        assert!(rewritten.contains(&new_line));
        assert!(!rewritten.contains(&key_b64(&target_old)));
    }

    #[test]
    fn rewrite_preserves_revoked_marker_for_same_host() {
        // A @revoked marker for the target host must SURVIVE a key-accept:
        // accepting a new key must not silently erase an admin's revocation.
        let revoked_key = ed25519_pubkey([17u8; 32]);
        let new_key = ed25519_pubkey([18u8; 32]);
        let revoked_line = format!("@revoked example.com ssh-ed25519 {}", key_b64(&revoked_key));
        let old_contents = format!("{revoked_line}\n");
        let new_line = format!("example.com ssh-ed25519 {}", key_b64(&new_key));

        let rewritten = rewrite_known_hosts_contents(&old_contents, "example.com", 22, &new_line);
        assert!(
            rewritten.contains(&revoked_line),
            "@revoked marker erased by rewrite:\n{rewritten}"
        );
        assert!(rewritten.contains(&new_line));
    }
}
