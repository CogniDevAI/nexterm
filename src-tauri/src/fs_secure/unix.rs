// fs_secure::unix — Owner-only file permissions on Unix-family systems.
//
// Sets mode 0o600 (read/write for owner, nothing for group or other).
// Same behaviour on Linux, macOS, and BSDs.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub(super) fn set_owner_only(path: &Path) -> io::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}
