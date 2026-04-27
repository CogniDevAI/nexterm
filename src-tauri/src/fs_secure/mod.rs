// fs_secure — Cross-platform secure file writes for sensitive local data.
//
// Centralizes platform-specific permission/ACL handling so callers (vault,
// profile persistence) do not need #[cfg(unix)] / #[cfg(windows)] branches.
// Permissions are applied to the temp file BEFORE rename to close the race
// window where the final file briefly exists with inherited permissions.
//
// Known limitations:
// - On Windows in GPO-managed environments, Group Policy can re-assert
//   inherited ACLs after this code runs. This cannot be mitigated at the
//   application layer.
// - Networked or cloud-sync filesystems (FAT32, SMB shares, OneDrive folders)
//   may reject ACL operations. Callers that must tolerate this should use
//   `best_effort_harden` instead of the strict variants.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(not(any(unix, windows)))]
mod fallback;
#[cfg(not(any(unix, windows)))]
use fallback as platform;

/// Build the temp-file path for an atomic write by appending `.tmp` to the
/// final file name. Keeps the temp file in the same directory as the
/// destination so rename stays on the same volume.
fn tmp_path_for(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = p
        .file_name()
        .map(|n| {
            let mut s = OsString::from(n);
            s.push(".tmp");
            s
        })
        .unwrap_or_else(|| OsString::from(".tmp"));
    p.set_file_name(name);
    p
}

/// Atomically write `bytes` to `path` with owner-only access.
///
/// Sequence: write to temp file → apply owner-only permissions/ACL to the
/// temp file → rename into place. Same-volume rename preserves the explicit
/// DACL/mode on NTFS, ext4, and APFS.
///
/// On error, the temp file is best-effort removed so we don't leak
/// `<path>.tmp` files on failure.
pub fn secure_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = tmp_path_for(path);

    if let Err(e) = std::fs::write(&tmp, bytes) {
        return Err(e);
    }

    if let Err(e) = platform::set_owner_only(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    Ok(())
}

/// Copy `from` to `to` and apply owner-only access on the destination.
///
/// Used for files where atomic write isn't appropriate (e.g. one-shot
/// migration backups). Permissions are applied AFTER copy because there
/// is no temp-file step to harden first.
pub fn secure_copy(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::copy(from, to)?;
    platform::set_owner_only(to)
}

/// Re-apply owner-only access to an existing file.
///
/// Idempotent. Used to migrate files that were created before this module
/// existed (or by older versions of the app) so they pick up the stricter
/// permissions on first read.
///
/// Returns Ok(()) if the file does not exist (nothing to harden) so this
/// is safe to call unconditionally on a path that may not yet be present.
pub fn harden_existing(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    platform::set_owner_only(path)
}

/// Best-effort variant of `harden_existing` for export targets.
///
/// Logs a warning on failure but never returns an error. Use this when the
/// destination filesystem may not support ACL operations (FAT32, network
/// shares, cloud-sync folders) and failing the operation entirely would
/// be a worse user experience than a degraded permission state.
///
/// Returns true if hardening succeeded, false otherwise.
pub fn best_effort_harden(path: &Path) -> bool {
    match harden_existing(path) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("best-effort hardening failed for {:?}: {}", path, e);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_path_appends_tmp_suffix() {
        let p = Path::new("/foo/bar.json");
        assert_eq!(tmp_path_for(p), PathBuf::from("/foo/bar.json.tmp"));
    }

    #[test]
    fn tmp_path_handles_no_extension() {
        let p = Path::new("/foo/bar");
        assert_eq!(tmp_path_for(p), PathBuf::from("/foo/bar.tmp"));
    }

    #[test]
    fn tmp_path_handles_multi_extension() {
        let p = Path::new("/foo/archive.tar.gz");
        assert_eq!(tmp_path_for(p), PathBuf::from("/foo/archive.tar.gz.tmp"));
    }

    #[test]
    fn secure_write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.json");
        let payload = b"{\"hello\":\"world\"}";

        secure_write(&path, payload).unwrap();

        let read_back = std::fs::read(&path).unwrap();
        assert_eq!(read_back, payload);
    }

    #[test]
    fn secure_write_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.json");

        secure_write(&path, b"first").unwrap();
        secure_write(&path, b"second").unwrap();

        let read_back = std::fs::read(&path).unwrap();
        assert_eq!(read_back, b"second");
    }

    #[test]
    fn secure_write_leaves_no_tmp_file_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.json");

        secure_write(&path, b"payload").unwrap();

        let tmp = tmp_path_for(&path);
        assert!(!tmp.exists(), "temp file should not exist after success");
    }

    #[test]
    fn harden_existing_is_noop_on_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert!(harden_existing(&path).is_ok());
    }

    #[test]
    fn harden_existing_succeeds_on_present_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.json");
        std::fs::write(&path, b"x").unwrap();

        assert!(harden_existing(&path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn secure_write_results_in_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.json");

        secure_write(&path, b"payload").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got {:o}", mode);
    }

    #[cfg(unix)]
    #[test]
    fn secure_copy_results_in_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.json");
        let dst = dir.path().join("dst.json");
        std::fs::write(&src, b"x").unwrap();

        secure_copy(&src, &dst).unwrap();

        let mode = std::fs::metadata(&dst).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got {:o}", mode);
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_tightens_loose_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("loose.json");
        std::fs::write(&path, b"x").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        harden_existing(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
