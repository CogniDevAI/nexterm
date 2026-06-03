// ssh/proxmox.rs — Remote Proxmox LXC management primitives
//
// Pure logic layer: no SSH, no Tauri. All functions are synchronous
// and fully unit-testable without a live connection.
//
// Responsibilities:
//   1. parse_pct_list          — parse `pct list` whitespace-delimited table
//   2. parse_pct_listsnapshot  — parse `pct listsnapshot <vmid>` output
//   3. validate_vmid           — injection-safe validator: digit-only char-loop + u32 range
//   4. validate_snapshot_name  — injection-safe validator: charset + length + starts-with-letter
//   5. build_lifecycle_command — compose pct start/stop/reboot from validated vmid (u32)
//   6. build_listsnapshot_command, build_snapshot_command,
//      build_rollback_command, build_delsnapshot_command
//   7. is_pct_unavailable      — heuristic: not installed / permission denied
//
// INJECTION SAFETY (critical):
//   VMIDs are u32 integers (100–999999999). Pure digit-only char-loop + parse::<u32>()
//   + range check before storing. Command builders take the validated u32 — no raw
//   string interpolation from user input.
//
//   Snapshot names: pure char-loop — len 1..=40, first byte ASCII alphabetic,
//   rest ASCII alphanumeric | '_' | '-' (no dots). NO regex crate.
//
//   Parse-source defense-in-depth: parse_pct_list drops rows whose VMID fails
//   validate_vmid; parse_pct_listsnapshot drops snapshots whose name fails
//   validate_snapshot_name. No unsafe value ever reaches the store or pct-enter PTY.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ─── Types ───────────────────────────────────────────────────────────────────

/// A validated Proxmox container ID (CTID).
/// Stored as u32; range 100..=999_999_999.
pub type ProxmoxVmid = u32;

/// A single row from `pct list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LxcRow {
    /// Container VMID (validated u32, 100..=999_999_999).
    pub vmid: ProxmoxVmid,
    /// Container status: "running", "stopped", etc.
    pub status: String,
    /// Container name (hostname).
    pub name: String,
}

/// A single snapshot from `pct listsnapshot <vmid>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    /// Snapshot name (validated).
    pub name: String,
}

/// Lifecycle action a user can trigger on an LXC container.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LxcAction {
    Start,
    Stop,
    Reboot,
}

// ─── VMID validation ─────────────────────────────────────────────────────────

/// Validate a Proxmox container VMID string.
///
/// Accepts ONLY strings where every byte is an ASCII digit, parses as u32,
/// and checks the valid Proxmox CTID range: 100..=999_999_999.
///
/// Returns the validated u32 on success, or an `AppError::Other` on failure.
///
/// # Security
/// Pure char-loop (no regex). All characters inspected individually. The u32
/// result is stored and used in all command builders — the raw string is
/// never passed to the shell after validation.
pub fn validate_vmid(s: &str) -> Result<ProxmoxVmid, AppError> {
    if s.is_empty() {
        return Err(AppError::Other("VMID is empty".to_string()));
    }
    // Every byte must be an ASCII digit.
    for b in s.bytes() {
        if !b.is_ascii_digit() {
            return Err(AppError::Other(format!(
                "Invalid VMID (injection guard): {s:?}"
            )));
        }
    }
    // Parse as u32 (overflow → invalid).
    let n: u32 = s
        .parse()
        .map_err(|_| AppError::Other(format!("Invalid VMID (overflow or parse error): {s:?}")))?;
    // Proxmox CTID range.
    if !(100..=999_999_999).contains(&n) {
        return Err(AppError::Other(format!(
            "VMID out of range (100–999999999): {n}"
        )));
    }
    Ok(n)
}

// ─── Snapshot name validation ─────────────────────────────────────────────────

/// Validate a Proxmox snapshot name before use in a shell command.
///
/// Rules:
///   - Length: 1..=40 bytes
///   - First byte: ASCII alphabetic (A-Z or a-z)
///   - Remaining bytes: ASCII alphanumeric, underscore (`_`), or hyphen (`-`)
///   - No dots, spaces, slashes, semicolons, or any other character
///
/// Returns `Ok(&str)` on success, `Err(AppError::Other)` on failure.
///
/// # Security
/// Pure char-loop — no regex dependency. Called at parse source and at
/// command boundary (defense-in-depth).
pub fn validate_snapshot_name(name: &str) -> Result<&str, AppError> {
    let bytes = name.as_bytes();

    match bytes.len() {
        0 => return Err(AppError::Other("Snapshot name is empty".to_string())),
        1..=40 => {}
        _ => {
            return Err(AppError::Other(format!(
                "Snapshot name too long (max 40): {name:?}"
            )))
        }
    }

    // First byte must be ASCII alphabetic.
    if !bytes[0].is_ascii_alphabetic() {
        return Err(AppError::Other(format!(
            "Invalid snapshot name (must start with a letter): {name:?}"
        )));
    }

    // Remaining bytes: alphanumeric | '_' | '-'
    for &b in &bytes[1..] {
        if !b.is_ascii_alphanumeric() && b != b'_' && b != b'-' {
            return Err(AppError::Other(format!(
                "Invalid snapshot name (injection guard): {name:?}"
            )));
        }
    }

    Ok(name)
}

// ─── Command builders ─────────────────────────────────────────────────────────

/// Build `pct start|stop|reboot <vmid>` from a validated VMID.
pub fn build_lifecycle_command(action: &LxcAction, vmid: ProxmoxVmid) -> String {
    let verb = match action {
        LxcAction::Start => "start",
        LxcAction::Stop => "stop",
        LxcAction::Reboot => "reboot",
    };
    format!("pct {verb} {vmid}")
}

/// Build `pct listsnapshot <vmid>`.
pub fn build_listsnapshot_command(vmid: ProxmoxVmid) -> String {
    format!("pct listsnapshot {vmid}")
}

/// Build `pct snapshot <vmid> <name>` (create snapshot).
pub fn build_snapshot_command(vmid: ProxmoxVmid, name: &str) -> String {
    format!("pct snapshot {vmid} {name}")
}

/// Build `pct rollback <vmid> <name>`.
pub fn build_rollback_command(vmid: ProxmoxVmid, name: &str) -> String {
    format!("pct rollback {vmid} {name}")
}

/// Build `pct delsnapshot <vmid> <name>`.
pub fn build_delsnapshot_command(vmid: ProxmoxVmid, name: &str) -> String {
    format!("pct delsnapshot {vmid} {name}")
}

// ─── pct not-available detection ─────────────────────────────────────────────

/// Heuristic: detect whether `pct` is not available on the remote host.
///
/// Returns `true` when exit_code != 0 AND stderr suggests pct is absent or
/// restricted:
///   - "command not found" — pct binary absent from PATH
///   - "not found"         — busybox/alpine variant; also "pct: not found"
///   - "permission denied" — pct requires root / sudo group
///
/// A `false` return means pct is probably available (or we got output we
/// don't understand — let the caller degrade gracefully).
pub fn is_pct_unavailable(exit_code: Option<i32>, stderr: &str) -> bool {
    if exit_code == Some(0) {
        return false;
    }
    let lower = stderr.to_lowercase();
    lower.contains("command not found")
        || lower.contains("not found")
        || lower.contains("permission denied")
}

// ─── pct list output parser ───────────────────────────────────────────────────

/// Parse the stdout of `pct list`.
///
/// Output format (whitespace-delimited):
/// ```text
/// VMID       Status     Lock         Name
/// 100        running                 debian-dev
/// 101        stopped                 ubuntu-web
/// 102        running    migrate       db-server
/// ```
///
/// Parsing strategy:
///   - First line (header) is skipped.
///   - Each subsequent line is split on whitespace.
///   - VMID = col[0], Status = col[1], Name = last token (Lock may be blank).
///   - Rows where VMID fails `validate_vmid` are silently dropped.
///   - Blank lines are skipped.
pub fn parse_pct_list(stdout: &str) -> Vec<LxcRow> {
    let mut rows = Vec::new();
    let mut lines = stdout.lines();

    // Skip the header line.
    lines.next();

    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Need at least VMID + Status + Name (3 tokens minimum).
        if cols.len() < 3 {
            continue;
        }
        // Validate VMID at parse source — drop row if invalid.
        let vmid = match validate_vmid(cols[0]) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let status = cols[1].to_string();
        // Name is always the last token (handles optional Lock column).
        let name = cols[cols.len() - 1].to_string();

        rows.push(LxcRow { vmid, status, name });
    }

    rows
}

// ─── pct listsnapshot output parser ──────────────────────────────────────────

/// Parse the stdout of `pct listsnapshot <vmid>`.
///
/// PVE may emit a tree-format or simple format. In practice each
/// non-header, non-current, non-arrow line contains a snapshot name as its
/// first whitespace-delimited token.
///
/// Skipped lines:
///   - Blank lines
///   - Lines starting with `->` (marks the current state)
///   - Lines whose first token is "Name" (header)
///   - Lines whose first token is "current" (the live state pseudo-snapshot)
///   - Lines with tree decorators (`+`, `|`, `\`)
///
/// Any snapshot name that fails `validate_snapshot_name` is silently dropped
/// (defense-in-depth).
pub fn parse_pct_listsnapshot(stdout: &str) -> Vec<SnapshotRow> {
    let mut rows = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Skip the current-pointer arrow lines.
        if line.starts_with("->") {
            continue;
        }
        // Split and get first token.
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.is_empty() {
            continue;
        }

        // Strip tree decorator prefix characters (+, |, \, -) if present.
        let first = cols[0].trim_start_matches(['+', '|', '\\', '-']);
        let name_candidate = if first.is_empty() && cols.len() > 1 {
            cols[1]
        } else {
            first
        };

        // Skip well-known non-snapshot tokens.
        let lower = name_candidate.to_lowercase();
        if lower == "name" || lower == "current" || lower == "snapshots" {
            continue;
        }

        // Validate at parse source.
        if validate_snapshot_name(name_candidate).is_ok() {
            rows.push(SnapshotRow {
                name: name_candidate.to_string(),
            });
        }
    }

    rows
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── WU1: validate_vmid ───────────────────────────────────────────────────

    #[test]
    fn validate_vmid_accepts_min_range() {
        assert_eq!(validate_vmid("100").unwrap(), 100);
    }

    #[test]
    fn validate_vmid_accepts_max_range() {
        assert_eq!(validate_vmid("999999999").unwrap(), 999_999_999);
    }

    #[test]
    fn validate_vmid_accepts_typical_vmid() {
        assert_eq!(validate_vmid("101").unwrap(), 101);
        assert_eq!(validate_vmid("1234").unwrap(), 1234);
    }

    #[test]
    fn validate_vmid_rejects_zero() {
        assert!(validate_vmid("0").is_err());
    }

    #[test]
    fn validate_vmid_rejects_below_minimum() {
        assert!(validate_vmid("99").is_err());
    }

    #[test]
    fn validate_vmid_rejects_empty_string() {
        assert!(validate_vmid("").is_err());
    }

    #[test]
    fn validate_vmid_rejects_alpha_chars() {
        assert!(validate_vmid("abc").is_err());
    }

    #[test]
    fn validate_vmid_rejects_injection_semicolon() {
        assert!(validate_vmid("100;rm -rf /").is_err());
    }

    #[test]
    fn validate_vmid_rejects_injection_newline() {
        assert!(validate_vmid("100\n200").is_err());
    }

    #[test]
    fn validate_vmid_rejects_u32_overflow() {
        // 10 digits, well above u32 max (4294967295 ~ 4.3B)
        assert!(validate_vmid("9999999999").is_err());
    }

    #[test]
    fn validate_vmid_rejects_999999999_plus_one() {
        // Just outside the Proxmox CTID range but fits in u32
        assert!(validate_vmid("1000000000").is_err());
    }

    #[test]
    fn validate_vmid_rejects_negative_representation() {
        // Minus sign is not a digit
        assert!(validate_vmid("-100").is_err());
    }

    #[test]
    fn validate_vmid_rejects_float() {
        assert!(validate_vmid("100.5").is_err());
    }

    // ── WU1: parse_pct_list ──────────────────────────────────────────────────

    #[test]
    fn parse_pct_list_empty_string_returns_empty_vec() {
        assert!(parse_pct_list("").is_empty());
    }

    #[test]
    fn parse_pct_list_header_only_returns_empty_vec() {
        let input = "VMID       Status     Lock         Name\n";
        assert!(parse_pct_list(input).is_empty());
    }

    #[test]
    fn parse_pct_list_single_running_row() {
        let input = "VMID       Status     Lock         Name\n100        running                 debian-dev\n";
        let rows = parse_pct_list(input);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vmid, 100);
        assert_eq!(rows[0].status, "running");
        assert_eq!(rows[0].name, "debian-dev");
    }

    #[test]
    fn parse_pct_list_multiple_rows() {
        let input = concat!(
            "VMID       Status     Lock         Name\n",
            "100        running                 debian-dev\n",
            "101        stopped                 ubuntu-web\n",
        );
        let rows = parse_pct_list(input);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].vmid, 100);
        assert_eq!(rows[1].status, "stopped");
        assert_eq!(rows[1].name, "ubuntu-web");
    }

    #[test]
    fn parse_pct_list_with_lock_column() {
        let input = concat!(
            "VMID       Status     Lock         Name\n",
            "102        running    migrate       db-server\n",
        );
        let rows = parse_pct_list(input);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vmid, 102);
        assert_eq!(rows[0].status, "running");
        assert_eq!(rows[0].name, "db-server");
    }

    #[test]
    fn parse_pct_list_skips_blank_lines() {
        let input = concat!(
            "VMID       Status     Lock         Name\n",
            "\n",
            "100        running                 myct\n",
            "\n",
        );
        let rows = parse_pct_list(input);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn parse_pct_list_drops_row_with_non_numeric_vmid() {
        let input = concat!(
            "VMID       Status     Lock         Name\n",
            "abc        running                 evil\n",
            "100        stopped                 legit\n",
        );
        let rows = parse_pct_list(input);
        // Only the valid row survives.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vmid, 100);
    }

    #[test]
    fn parse_pct_list_drops_row_with_out_of_range_vmid() {
        let input = concat!(
            "VMID       Status     Lock         Name\n",
            "99         stopped                 toosml\n",
            "100        stopped                 legit\n",
        );
        let rows = parse_pct_list(input);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vmid, 100);
    }

    #[test]
    fn parse_pct_list_drops_row_with_injection_vmid() {
        let input = concat!(
            "VMID       Status     Lock         Name\n",
            "100;rm     running                 evil\n",
            "101        stopped                 legit\n",
        );
        let rows = parse_pct_list(input);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vmid, 101);
    }

    // ── WU2: validate_snapshot_name ──────────────────────────────────────────

    #[test]
    fn validate_snapshot_name_accepts_simple() {
        assert!(validate_snapshot_name("snap1").is_ok());
    }

    #[test]
    fn validate_snapshot_name_accepts_single_letter() {
        assert!(validate_snapshot_name("a").is_ok());
    }

    #[test]
    fn validate_snapshot_name_accepts_mixed_case_underscore_hyphen() {
        assert!(validate_snapshot_name("Snap_2-x").is_ok());
    }

    #[test]
    fn validate_snapshot_name_accepts_max_40_chars() {
        // Exactly 40 chars, starts with letter
        let name = "a".repeat(40);
        assert!(validate_snapshot_name(&name).is_ok());
    }

    #[test]
    fn validate_snapshot_name_rejects_empty() {
        assert!(validate_snapshot_name("").is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_starts_with_digit() {
        assert!(validate_snapshot_name("1starts-digit").is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_too_long() {
        // 41 chars
        let name = format!("a{}", "x".repeat(40));
        assert!(validate_snapshot_name(&name).is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_semicolon() {
        assert!(validate_snapshot_name("snap;drop").is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_space() {
        assert!(validate_snapshot_name("snap space").is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_slash() {
        assert!(validate_snapshot_name("snap/slash").is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_dot() {
        // Dots not allowed per spec
        assert!(validate_snapshot_name("snap.dot").is_err());
    }

    #[test]
    fn validate_snapshot_name_rejects_starts_with_hyphen() {
        assert!(validate_snapshot_name("-snapname").is_err());
    }

    // ── WU2: parse_pct_listsnapshot ──────────────────────────────────────────

    #[test]
    fn parse_pct_listsnapshot_empty_returns_empty() {
        assert!(parse_pct_listsnapshot("").is_empty());
    }

    #[test]
    fn parse_pct_listsnapshot_simple_format() {
        let input = "snap1\nsnap2\n";
        let rows = parse_pct_listsnapshot(input);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "snap1");
        assert_eq!(rows[1].name, "snap2");
    }

    #[test]
    fn parse_pct_listsnapshot_skips_current_line() {
        let input = concat!(
            "             Name         Snapshots\n",
            "             snap1\n",
            "->           current (no snapshot)\n",
        );
        let rows = parse_pct_listsnapshot(input);
        // "current" and "->" lines skipped; only snap1
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "snap1");
    }

    #[test]
    fn parse_pct_listsnapshot_skips_header_name_token() {
        let input = "Name    Snapshots\nsnap1\n";
        let rows = parse_pct_listsnapshot(input);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "snap1");
    }

    #[test]
    fn parse_pct_listsnapshot_tree_format_with_prefix() {
        // PVE tree format with +--- prefix
        let input = concat!(
            "             Name         Snapshots\n",
            "             +------- snap1 (2024-01-15 10:23:04) Description\n",
            "             +------- snap2 (2024-01-20 14:55:12) Another snap\n",
            "->           current (no snapshot)\n",
        );
        let rows = parse_pct_listsnapshot(input);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "snap1");
        assert_eq!(rows[1].name, "snap2");
    }

    #[test]
    fn parse_pct_listsnapshot_drops_invalid_snapshot_names() {
        let input = "snap1\n1invalid\nsnap2\n";
        let rows = parse_pct_listsnapshot(input);
        // "1invalid" starts with digit — dropped
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "snap1");
        assert_eq!(rows[1].name, "snap2");
    }

    // ── WU2: command builders ────────────────────────────────────────────────

    #[test]
    fn build_lifecycle_start() {
        assert_eq!(
            build_lifecycle_command(&LxcAction::Start, 100),
            "pct start 100"
        );
    }

    #[test]
    fn build_lifecycle_stop() {
        assert_eq!(
            build_lifecycle_command(&LxcAction::Stop, 100),
            "pct stop 100"
        );
    }

    #[test]
    fn build_lifecycle_reboot() {
        assert_eq!(
            build_lifecycle_command(&LxcAction::Reboot, 100),
            "pct reboot 100"
        );
    }

    #[test]
    fn build_listsnapshot_command_fmt() {
        assert_eq!(build_listsnapshot_command(101), "pct listsnapshot 101");
    }

    #[test]
    fn build_snapshot_command_fmt() {
        assert_eq!(
            build_snapshot_command(101, "snap1"),
            "pct snapshot 101 snap1"
        );
    }

    #[test]
    fn build_rollback_command_fmt() {
        assert_eq!(
            build_rollback_command(101, "snap1"),
            "pct rollback 101 snap1"
        );
    }

    #[test]
    fn build_delsnapshot_command_fmt() {
        assert_eq!(
            build_delsnapshot_command(101, "snap1"),
            "pct delsnapshot 101 snap1"
        );
    }

    // ── WU3: is_pct_unavailable ──────────────────────────────────────────────

    #[test]
    fn pct_not_available_command_not_found() {
        assert!(is_pct_unavailable(Some(127), "pct: command not found\n"));
    }

    #[test]
    fn pct_not_available_not_found_busybox() {
        assert!(is_pct_unavailable(Some(1), "sh: pct: not found\n"));
    }

    #[test]
    fn pct_not_available_permission_denied() {
        assert!(is_pct_unavailable(Some(1), "permission denied\n"));
    }

    #[test]
    fn pct_not_available_pct_not_found_variant() {
        // Common on non-Proxmox hosts where the pct binary doesn't exist
        assert!(is_pct_unavailable(Some(127), "pct: not found"));
    }

    #[test]
    fn pct_not_available_false_on_exit_zero() {
        assert!(!is_pct_unavailable(Some(0), "command not found"));
    }

    #[test]
    fn pct_not_available_false_on_normal_output() {
        assert!(!is_pct_unavailable(Some(0), ""));
    }

    #[test]
    fn pct_not_available_none_exit_with_hint() {
        assert!(is_pct_unavailable(None, "pct: command not found\n"));
    }

    #[test]
    fn pct_not_available_false_on_nonzero_without_hint() {
        assert!(!is_pct_unavailable(
            Some(1),
            "Error: VM 100 is not running\n"
        ));
    }
}
