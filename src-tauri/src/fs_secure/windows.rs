// fs_secure::windows — Owner-only NTFS ACL via SetNamedSecurityInfoW.
//
// Builds a protected DACL containing exactly one ACE: GENERIC_ALL for the
// current process user SID, no inheritance, no inherited ACEs. Removes the
// default ACL inherited from the parent directory (typically %APPDATA%),
// which on shared or domain-joined Windows hosts grants Users / Authenticated
// Users read access to the file.
//
// The `windows` crate is already present transitively via tauri-plugin-updater
// so adding it as an explicit `[target.'cfg(windows)'.dependencies]` entry
// has no binary-size cost.
//
// COMPILE-VERIFICATION REQUIRED: this module uses Win32 APIs whose binding
// shapes vary across windows-rs minor versions. Build on Windows and run the
// integration tests in `tests/fs_secure_windows.rs` (or the upstream
// contributor's PR for #2) before relying on this in production.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows::Win32::Security::{
    AddAccessAllowedAceEx, GetLengthSid, GetTokenInformation, InitializeAcl, TokenUser, ACCESS_ALLOWED_ACE,
    ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
    TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Memory::{LocalAlloc, LPTR};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Standard Windows access right: full access via the generic mapping.
const GENERIC_ALL: u32 = 0x10000000;

/// ACE inheritance flag value indicating "do not propagate to children".
/// Defined as 0 in the Windows headers; the `windows` crate does not always
/// re-export it as a named constant across minor versions, so we hardcode it
/// with a comment for traceability.
const NO_INHERITANCE: u32 = 0;

/// RAII guard for a Windows HANDLE — closes on drop.
struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// RAII guard for memory allocated via LocalAlloc — frees on drop.
struct LocalAllocGuard(*mut std::ffi::c_void);

impl Drop for LocalAllocGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = LocalFree(HLOCAL(self.0));
            }
        }
    }
}

pub(super) fn set_owner_only(path: &Path) -> io::Result<()> {
    // 1. Open the current process token to query the user SID.
    let token = unsafe {
        let mut h = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut h)
            .map_err(|e| io::Error::other(format!("OpenProcessToken: {e}")))?;
        HandleGuard(h)
    };

    // 2. First call: query required buffer size for TOKEN_USER.
    let mut needed: u32 = 0;
    unsafe {
        // Intentional ignore: this call is expected to fail with
        // ERROR_INSUFFICIENT_BUFFER and write the required size into `needed`.
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut needed);
    }
    if needed == 0 {
        return Err(io::Error::other("GetTokenInformation size query returned 0"));
    }

    // 3. Allocate the buffer and re-call to fill it.
    let token_user_buf = match unsafe { LocalAlloc(LPTR, needed as usize) } {
        Ok(h) => LocalAllocGuard(h.0 as *mut _),
        Err(e) => return Err(io::Error::other(format!("LocalAlloc TOKEN_USER: {e}"))),
    };
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(token_user_buf.0),
            needed,
            &mut needed,
        )
        .map_err(|e| io::Error::other(format!("GetTokenInformation: {e}")))?;
    }

    // 4. Extract the user SID pointer. The SID lives inside the buffer we
    //    just allocated; we must keep `token_user_buf` alive until after
    //    SetNamedSecurityInfoW returns.
    let token_user_ptr = token_user_buf.0 as *const TOKEN_USER;
    let user_sid: PSID = unsafe { (*token_user_ptr).User.Sid };

    // 5. Compute ACL size: header + one ACE that is just large enough for the
    //    SID. ACCESS_ALLOWED_ACE includes a 4-byte SidStart placeholder which
    //    we replace with the actual SID, hence the subtraction.
    let sid_len = unsafe { GetLengthSid(user_sid) };
    let acl_size: u32 = (std::mem::size_of::<ACL>() as u32)
        + (std::mem::size_of::<ACCESS_ALLOWED_ACE>() as u32)
        - (std::mem::size_of::<u32>() as u32)
        + sid_len;

    let acl_buf = match unsafe { LocalAlloc(LPTR, acl_size as usize) } {
        Ok(h) => LocalAllocGuard(h.0 as *mut _),
        Err(e) => return Err(io::Error::other(format!("LocalAlloc ACL: {e}"))),
    };
    let acl_ptr = acl_buf.0 as *mut ACL;

    // 6. Initialize the empty ACL and add a single allow-all ACE for the user.
    unsafe {
        InitializeAcl(acl_ptr, acl_size, ACL_REVISION.0)
            .map_err(|e| io::Error::other(format!("InitializeAcl: {e}")))?;
        AddAccessAllowedAceEx(
            acl_ptr,
            ACL_REVISION.0,
            windows::Win32::Security::ACE_FLAGS(NO_INHERITANCE),
            GENERIC_ALL,
            user_sid,
        )
        .map_err(|e| io::Error::other(format!("AddAccessAllowedAceEx: {e}")))?;
    }

    // 7. Convert the path to a null-terminated wide string.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);

    // 8. Apply the DACL with PROTECTED_DACL_SECURITY_INFORMATION so inherited
    //    ACEs from the parent directory are stripped. Owner / group / SACL
    //    are intentionally left unchanged (None / default).
    unsafe {
        let status = SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(acl_ptr),
            None,
        );
        if status.is_err() {
            return Err(io::Error::other(format!(
                "SetNamedSecurityInfoW failed: {status:?}"
            )));
        }
    }

    // token_user_buf and acl_buf drop here, freeing both LocalAlloc blocks.
    Ok(())
}
