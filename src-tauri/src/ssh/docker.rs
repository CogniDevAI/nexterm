// ssh/docker.rs — Remote Docker management primitives
//
// Pure logic layer: no SSH, no Tauri. All functions are synchronous
// and fully unit-testable without a live connection.
//
// Responsibilities:
//   1. parse_docker_ps_output   — parse `docker ps -a --format '{{json .}}'` lines
//   2. validate_container_id    — injection-safe validator (Docker charset only)
//   3. build_lifecycle_command  — compose docker start/stop/restart/rm from validated id
//   4. is_docker_unavailable    — heuristic: not installed / permission denied
//
// INJECTION SAFETY (critical):
//   Container IDs and names come from `docker ps` output but MUST be validated
//   before going into any shell command. validate_container_id accepts ONLY
//   Docker's actual charset: `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`. Any input
//   outside that set — semicolons, pipes, $, spaces, quotes, backticks, slashes,
//   newlines — is rejected with DockerInjectionError. Commands are built from
//   validated tokens only; no raw interpolation.
//
//   The validator is a pure manual char-loop (no external crate). Every byte is
//   checked individually, so any non-ASCII character, control character, or shell
//   metacharacter is rejected at the first forbidden byte encountered.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ─── Types ───────────────────────────────────────────────────────────────────

/// A single row from `docker ps -a --format '{{json .}}'`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRow {
    /// Short container ID (12-hex chars from Docker).
    pub id: String,
    /// Container name(s), comma-joined if multiple.
    pub names: String,
    /// Image the container was created from.
    pub image: String,
    /// Container state: "running", "exited", "paused", "created", etc.
    pub state: String,
    /// Human-readable status string, e.g. "Up 2 hours".
    pub status: String,
    /// Exposed port mappings, e.g. "0.0.0.0:8080->80/tcp".
    pub ports: String,
}

/// Lifecycle action a user can trigger on a container.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DockerAction {
    Start,
    Stop,
    Restart,
    Rm,
}

// ─── Container-id validation ─────────────────────────────────────────────────

/// Returns true for bytes that are legal in the *tail* of a container id/name
/// (positions 1..): ASCII alphanumeric, underscore, dot, or hyphen.
#[inline]
fn is_tail_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-'
}

/// Validate a container ID or name before use in a shell command.
///
/// Accepts ONLY Docker's actual charset: `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`.
///   - Length: 1..=128 bytes
///   - First byte: ASCII alphanumeric
///   - Remaining bytes (up to 127): ASCII alphanumeric, `_`, `.`, `-`
///
/// Anything outside that set (shell metacharacters, spaces, slashes, quotes,
/// control chars, non-ASCII) is rejected with an `AppError::Other`.
///
/// # Security
/// Pure manual char-loop — no external crate. Every byte is inspected, so
/// any non-ASCII character, control character, or shell metacharacter is
/// rejected at the first forbidden byte. Called at the Rust boundary even
/// when the id came from `docker ps` output: defense-in-depth against
/// corrupted daemon output or smuggled metacharacters.
pub fn validate_container_id(id: &str) -> Result<&str, AppError> {
    let bytes = id.as_bytes();

    // Length gate: must be 1..=128 bytes.
    match bytes.len() {
        0 => return Err(AppError::Other("Docker container id is empty".to_string())),
        1..=128 => {}
        _ => {
            return Err(AppError::Other(format!(
                "Invalid container id (injection guard): {id:?}"
            )))
        }
    }

    // First byte must be ASCII alphanumeric.
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(AppError::Other(format!(
            "Invalid container id (injection guard): {id:?}"
        )));
    }

    // Remaining bytes: alphanumeric | '_' | '.' | '-'
    for &b in &bytes[1..] {
        if !is_tail_byte(b) {
            return Err(AppError::Other(format!(
                "Invalid container id (injection guard): {id:?}"
            )));
        }
    }

    Ok(id)
}

// ─── Lifecycle command builder ────────────────────────────────────────────────

/// Build a `docker <action> <id>` command string from a **validated** container id.
///
/// The caller MUST pass a validated id (from `validate_container_id`). This
/// function does NOT re-validate; it constructs the command using `format!`
/// with the already-clean token.
///
/// # Panics
/// Never. The format string is static; the id is a plain string slice.
pub fn build_lifecycle_command(action: &DockerAction, id: &str) -> String {
    let verb = match action {
        DockerAction::Start => "start",
        DockerAction::Stop => "stop",
        DockerAction::Restart => "restart",
        DockerAction::Rm => "rm",
    };
    format!("docker {verb} {id}")
}

/// Build a `docker logs --tail 200 <id>` command from a validated container id.
pub fn build_logs_command(id: &str) -> String {
    format!("docker logs --tail 200 {id}")
}

// ─── Docker not-available detection ──────────────────────────────────────────

/// Heuristic: detect whether Docker is not available on the remote host.
///
/// Returns `true` when exit_code != 0 AND stderr suggests Docker is absent or
/// restricted:
///   - "command not found" — docker binary absent from PATH
///   - "not found"         — busybox/alpine variant
///   - "permission denied" — rootless docker / socket not accessible
///
/// A `false` return means Docker is probably available (or we got output we
/// don't understand — let the caller degrade gracefully).
pub fn is_docker_unavailable(exit_code: Option<i32>, stderr: &str) -> bool {
    // Only flag unavailable when the command failed.
    if exit_code == Some(0) {
        return false;
    }
    let lower = stderr.to_lowercase();
    lower.contains("command not found")
        || lower.contains("not found")
        || lower.contains("permission denied")
}

// ─── docker ps output parser ─────────────────────────────────────────────────

/// Raw JSON shape emitted by `docker ps -a --format '{{json .}}'`.
///
/// Docker emits each container as an independent JSON object on its own line —
/// NOT a JSON array. Fields match the Docker Go template names (PascalCase).
/// We `#[allow(dead_code)]` fields we parse but may not expose in v1.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DockerPsLine {
    #[serde(rename = "ID", alias = "Id")]
    id: Option<String>,
    #[serde(rename = "Names")]
    names: Option<String>,
    #[serde(rename = "Image")]
    image: Option<String>,
    #[serde(rename = "State")]
    state: Option<String>,
    #[serde(rename = "Status")]
    status: Option<String>,
    #[serde(rename = "Ports")]
    ports: Option<String>,
}

/// Parse a single line of `docker ps -a --format '{{json .}}'` output.
///
/// Returns `None` on malformed JSON or missing required fields — the caller
/// skips the line. This is graceful degradation: one bad line doesn't abort
/// the entire parse.
pub fn parse_docker_ps_line(line: &str) -> Option<ContainerRow> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let raw: DockerPsLine = serde_json::from_str(line).ok()?;
    let id = raw.id.filter(|s| !s.is_empty())?;
    // Validate the ID at the parse source (defense-in-depth).
    // Any id that fails the charset check silently drops the row — this
    // guarantees no out-of-charset id can ever populate the store or reach
    // write_terminal via the interactive-shell path.
    validate_container_id(&id).ok()?;
    Some(ContainerRow {
        id,
        names: raw.names.unwrap_or_default(),
        image: raw.image.unwrap_or_default(),
        state: raw.state.unwrap_or_default(),
        status: raw.status.unwrap_or_default(),
        ports: raw.ports.unwrap_or_default(),
    })
}

/// Parse the full stdout of `docker ps -a --format '{{json .}}'`.
///
/// Each line is an independent JSON object. Blank lines and malformed lines
/// are skipped. Returns an empty Vec when there are no containers or the
/// output is entirely malformed.
pub fn parse_docker_ps_output(stdout: &str) -> Vec<ContainerRow> {
    stdout.lines().filter_map(parse_docker_ps_line).collect()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── WU1: parser ──────────────────────────────────────────────────────────

    #[test]
    fn parse_line_valid_json_produces_container_row() {
        let line = r#"{"ID":"abc123def456","Names":"myapp","Image":"nginx:latest","State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:80->80/tcp"}"#;
        let row = parse_docker_ps_line(line).expect("should parse");
        assert_eq!(row.id, "abc123def456");
        assert_eq!(row.names, "myapp");
        assert_eq!(row.image, "nginx:latest");
        assert_eq!(row.state, "running");
        assert_eq!(row.status, "Up 2 hours");
        assert_eq!(row.ports, "0.0.0.0:80->80/tcp");
    }

    #[test]
    fn parse_line_malformed_json_returns_none() {
        assert!(parse_docker_ps_line("{not valid json}").is_none());
    }

    #[test]
    fn parse_line_missing_id_returns_none() {
        // ID is empty string → filtered out
        let line = r#"{"ID":"","Names":"myapp","Image":"nginx","State":"running","Status":"Up","Ports":""}"#;
        assert!(parse_docker_ps_line(line).is_none());
    }

    #[test]
    fn parse_line_blank_line_returns_none() {
        assert!(parse_docker_ps_line("").is_none());
        assert!(parse_docker_ps_line("   ").is_none());
    }

    #[test]
    fn parse_output_multi_line_produces_vec() {
        let output = concat!(
            r#"{"ID":"aaa111","Names":"alpha","Image":"alpine","State":"running","Status":"Up 1h","Ports":""}"#,
            "\n",
            r#"{"ID":"bbb222","Names":"beta","Image":"ubuntu","State":"exited","Status":"Exited(1) 5m ago","Ports":""}"#,
        );
        let rows = parse_docker_ps_output(output);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "aaa111");
        assert_eq!(rows[1].state, "exited");
    }

    #[test]
    fn parse_output_blank_lines_skipped() {
        let output = "\n\n";
        assert!(parse_docker_ps_output(output).is_empty());
    }

    #[test]
    fn parse_output_malformed_lines_skipped_gracefully() {
        let output = concat!(
            "bad line\n",
            r#"{"ID":"ccc333","Names":"gamma","Image":"debian","State":"running","Status":"Up","Ports":""}"#,
        );
        let rows = parse_docker_ps_output(output);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ccc333");
    }

    #[test]
    fn parse_output_empty_string_returns_empty_vec() {
        assert!(parse_docker_ps_output("").is_empty());
    }

    #[test]
    fn parse_line_optional_ports_empty() {
        let line = r#"{"ID":"ddd444","Names":"delta","Image":"redis","State":"running","Status":"Up","Ports":""}"#;
        let row = parse_docker_ps_line(line).expect("should parse");
        assert_eq!(row.ports, "");
    }

    // Alternative field name: some Docker versions emit "Id" instead of "ID"
    #[test]
    fn parse_line_lowercase_id_alias() {
        let line = r#"{"Id":"eee555","Names":"epsilon","Image":"postgres","State":"exited","Status":"Exited(0)","Ports":""}"#;
        let row = parse_docker_ps_line(line).expect("should parse lowercase Id alias");
        assert_eq!(row.id, "eee555");
    }

    // ── MINOR-1: parse_docker_ps_line drops rows with unsafe IDs ────────────

    /// RED → GREEN: a JSON line whose ID contains a shell metacharacter
    /// must be silently dropped (returns None) — defense-in-depth so no
    /// out-of-charset id can ever reach write_terminal.
    #[test]
    fn parse_line_drops_row_with_metacharacter_in_id() {
        let line = r#"{"ID":"abc; rm -rf /","Names":"evil","Image":"alpine","State":"running","Status":"Up","Ports":""}"#;
        assert!(
            parse_docker_ps_line(line).is_none(),
            "row with shell metachar in ID must be dropped"
        );
    }

    #[test]
    fn parse_line_drops_row_with_pipe_in_id() {
        let line = r#"{"ID":"abc|cat /etc/passwd","Names":"evil","Image":"alpine","State":"running","Status":"Up","Ports":""}"#;
        assert!(parse_docker_ps_line(line).is_none());
    }

    #[test]
    fn parse_line_drops_row_with_newline_in_id() {
        // Newline in JSON would be escaped; simulate a tab instead which is
        // also rejected by the validator.
        let line = "{\"ID\":\"abc\\tdef\",\"Names\":\"evil\",\"Image\":\"alpine\",\"State\":\"running\",\"Status\":\"Up\",\"Ports\":\"\"}";
        assert!(parse_docker_ps_line(line).is_none());
    }

    /// Sanity: a normal hex ID row still parses fine after the validator is added.
    #[test]
    fn parse_line_valid_hex_id_still_parses() {
        let line = r#"{"ID":"abc123def456","Names":"myapp","Image":"nginx:latest","State":"running","Status":"Up 2 hours","Ports":""}"#;
        let row = parse_docker_ps_line(line).expect("normal hex id must still parse");
        assert_eq!(row.id, "abc123def456");
    }

    // ── WU2: validator ───────────────────────────────────────────────────────

    #[test]
    fn validate_accepts_short_hex_id() {
        assert!(validate_container_id("abc123def456").is_ok());
    }

    #[test]
    fn validate_accepts_container_name_with_hyphens() {
        assert!(validate_container_id("my-app-container").is_ok());
    }

    #[test]
    fn validate_accepts_name_with_underscores_and_dots() {
        assert!(validate_container_id("my_app.v2").is_ok());
    }

    #[test]
    fn validate_accepts_single_char_id() {
        assert!(validate_container_id("a").is_ok());
    }

    #[test]
    fn validate_accepts_128_char_id() {
        // Exactly 128 chars = 1 first + 127 rest
        let id = "a".repeat(128);
        assert!(validate_container_id(&id).is_ok());
    }

    #[test]
    fn validate_rejects_empty_string() {
        assert!(validate_container_id("").is_err());
    }

    #[test]
    fn validate_rejects_semicolon_injection() {
        assert!(validate_container_id("abc; rm -rf /").is_err());
    }

    #[test]
    fn validate_rejects_pipe_injection() {
        assert!(validate_container_id("abc|cat /etc/passwd").is_err());
    }

    #[test]
    fn validate_rejects_dollar_injection() {
        assert!(validate_container_id("abc$(id)").is_err());
    }

    #[test]
    fn validate_rejects_backtick_injection() {
        assert!(validate_container_id("abc`id`").is_err());
    }

    #[test]
    fn validate_rejects_space_injection() {
        assert!(validate_container_id("abc def").is_err());
    }

    #[test]
    fn validate_rejects_newline_injection() {
        assert!(validate_container_id("abc\ndef").is_err());
    }

    #[test]
    fn validate_rejects_slash_injection() {
        assert!(validate_container_id("abc/def").is_err());
    }

    #[test]
    fn validate_rejects_quote_injection() {
        assert!(validate_container_id("abc\"def").is_err());
    }

    #[test]
    fn validate_rejects_single_quote_injection() {
        assert!(validate_container_id("abc'def").is_err());
    }

    #[test]
    fn validate_rejects_129_char_id() {
        let id = "a".repeat(129);
        assert!(validate_container_id(&id).is_err());
    }

    #[test]
    fn validate_rejects_id_starting_with_hyphen() {
        assert!(validate_container_id("-abc").is_err());
    }

    #[test]
    fn validate_rejects_id_starting_with_dot() {
        assert!(validate_container_id(".abc").is_err());
    }

    // ── WU2: command builders ────────────────────────────────────────────────

    #[test]
    fn build_lifecycle_start_command() {
        assert_eq!(
            build_lifecycle_command(&DockerAction::Start, "abc123"),
            "docker start abc123"
        );
    }

    #[test]
    fn build_lifecycle_stop_command() {
        assert_eq!(
            build_lifecycle_command(&DockerAction::Stop, "abc123"),
            "docker stop abc123"
        );
    }

    #[test]
    fn build_lifecycle_restart_command() {
        assert_eq!(
            build_lifecycle_command(&DockerAction::Restart, "abc123"),
            "docker restart abc123"
        );
    }

    #[test]
    fn build_lifecycle_rm_command() {
        assert_eq!(
            build_lifecycle_command(&DockerAction::Rm, "abc123"),
            "docker rm abc123"
        );
    }

    #[test]
    fn build_logs_command_includes_tail() {
        assert_eq!(
            build_logs_command("abc123"),
            "docker logs --tail 200 abc123"
        );
    }

    // ── WU3: not-available detection ─────────────────────────────────────────

    #[test]
    fn not_available_command_not_found_in_stderr() {
        assert!(is_docker_unavailable(
            Some(127),
            "docker: command not found\n"
        ));
    }

    #[test]
    fn not_available_not_found_busybox_variant() {
        assert!(is_docker_unavailable(Some(1), "sh: docker: not found\n"));
    }

    #[test]
    fn not_available_permission_denied() {
        assert!(is_docker_unavailable(
            Some(1),
            "Got permission denied while trying to connect to the Docker daemon socket\n"
        ));
    }

    #[test]
    fn not_available_false_on_zero_exit_code() {
        // exit_code 0 → available, even if stderr has weird content
        assert!(!is_docker_unavailable(Some(0), "command not found"));
    }

    #[test]
    fn not_available_false_on_normal_output() {
        // Normal ps output — no unavailability signal
        assert!(!is_docker_unavailable(Some(0), ""));
    }

    #[test]
    fn not_available_none_exit_code_treated_as_failure() {
        // None exit code (killed by signal) + stderr hint → unavailable
        assert!(is_docker_unavailable(None, "docker: command not found\n"));
    }

    #[test]
    fn not_available_false_on_nonzero_without_hint() {
        // Non-zero exit but stderr has no unavailability hint → not "unavailable"
        // (could be any other docker error)
        assert!(!is_docker_unavailable(
            Some(1),
            "Error: No such container: foo\n"
        ));
    }
}
