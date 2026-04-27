// fs_secure::fallback — No-op for unsupported platforms.
//
// Reached only on targets that are neither `unix` nor `windows`. Returns
// success without modifying permissions. This is a soft failure: the file
// will exist with default platform permissions, which on supported targets
// would have been tightened.

use std::io;
use std::path::Path;

pub(super) fn set_owner_only(_path: &Path) -> io::Result<()> {
    tracing::warn!(
        "fs_secure: no owner-only permission support on this platform; \
         file will inherit default permissions"
    );
    Ok(())
}
