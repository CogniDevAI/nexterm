// ssh/monitoring.rs — Remote system monitoring sampler task
//
// Per-session background task that periodically:
//   1. Opens a brief SSH channel (brief-lock pattern from exec.rs)
//   2. Runs a combined command that reads /proc/stat, /proc/meminfo,
//      /proc/net/dev, df -kP, and ps output in one SSH round-trip
//   3. Parses the output via metrics_parser (pure, no russh dep)
//   4. Computes CPU% and net bps deltas across consecutive ticks
//   5. Emits MetricEvent::Sample over the Tauri Channel
//
// Lifecycle:
//   - start_monitoring_task: spawns the tokio task, stores JoinHandle in
//     SessionHandle.monitoring_task. Replaces any existing task.
//   - stop_monitoring_task: aborts the task and clears the handle.
//   - session::disconnect aborts monitoring_task explicitly before dropping SSH.
//
// /proc-absent detection:
//   If the combined command fails with a "No such file" error referencing /proc,
//   emit MetricEvent::Unsupported and stop the sampler cleanly.
//   Transient SSH errors (channel open fail, timeout) are logged and skipped —
//   the sampler retries on the next tick.

use std::time::Instant;

use tauri::ipc::Channel;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::exec::{run_on_channel, ExecOptions};
use crate::ssh::metrics_parser::{self, CpuRaw, NetIfaceRaw};
use crate::state::{
    AppState, DiskEntry, MetricEvent, MetricSample, MonitorProcessRow, SessionId, SessionState,
};

// ─── Combined command ────────────────────────────────────────────────────────

/// The combined sampling command executed on the remote host every tick.
///
/// Uses `printf` markers to separate sections so parse_combined can split them.
/// Outputs /proc files directly (no subshell) — busybox compatible.
/// `ps` uses POSIX flags; stderr redirected to /dev/null for compatibility.
const COMBINED_COMMAND: &str = concat!(
    "printf '===STAT===\\n'; cat /proc/stat 2>/dev/null; ",
    "printf '===MEM===\\n'; cat /proc/meminfo 2>/dev/null; ",
    "printf '===NET===\\n'; cat /proc/net/dev 2>/dev/null; ",
    "printf '===DISK===\\n'; df -kP 2>/dev/null; ",
    "printf '===PS===\\n'; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 21"
);

/// Exec timeout for each monitoring sample.
/// Shorter than the default 30 s to avoid stalling the next tick.
const SAMPLE_TIMEOUT_SECS: u64 = 8;

// ─── PrevSample — state between ticks ───────────────────────────────────────

struct PrevSample {
    cpu: CpuRaw,
    net: Vec<NetIfaceRaw>,
    /// Wall-clock time of the previous sample, used to compute net bps.
    taken_at: Instant,
}

// ─── start_monitoring_task ───────────────────────────────────────────────────

/// Spawn (or replace) the monitoring sampler for a session.
pub async fn start_monitoring_task(
    state: &AppState,
    session_id: SessionId,
    interval_secs: u64,
    on_event: Channel<MetricEvent>,
) -> Result<(), AppError> {
    // Validate session and get cancel token — brief lock.
    let cancel_token = {
        let sessions = state.sessions.lock().await;
        let session = sessions
            .get(&session_id)
            .ok_or(AppError::SessionNotFound(session_id))?;
        if session.state != SessionState::Connected {
            return Err(AppError::NotConnected);
        }
        session.cancel_token.clone()
    };

    // Spawn a child cancellation token so stop_monitoring only cancels the
    // sampler without affecting the whole session.
    let child_token = cancel_token.child_token();
    let child_token_clone = child_token.clone();

    let sessions_arc = state.sessions.clone();

    let task = tokio::task::spawn(async move {
        run_monitoring_loop(
            sessions_arc,
            session_id,
            interval_secs,
            on_event,
            child_token_clone,
        )
        .await;
    });

    // Store the new task handle, aborting any previous sampler.
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            if let Some(old_task) = session.monitoring_task.take() {
                old_task.abort();
            }
            // Store (task, child_token) — we need the child_token to cancel via stop.
            // We encode this by storing a wrapper task that the child_token controls.
            // The actual child_token cancellation is done via stop_monitoring_task below.
            session.monitoring_task = Some(task);
            // child_token was cloned into the loop above; abort() on the JoinHandle
            // is sufficient to stop the sampler — no separate cancel needed here.
        }
    }

    Ok(())
}

// ─── stop_monitoring_task ────────────────────────────────────────────────────

/// Stop the monitoring sampler for a session.
///
/// Aborts the task if running. Idempotent.
pub async fn stop_monitoring_task(state: &AppState, session_id: SessionId) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&session_id) {
        if let Some(task) = session.monitoring_task.take() {
            task.abort();
        }
    }
    Ok(())
}

// ─── run_monitoring_loop ─────────────────────────────────────────────────────

/// The core sampling loop. Runs in a dedicated tokio task.
///
/// Exits cleanly when:
/// - The CancellationToken fires (session disconnect or stop_monitoring)
/// - The task is aborted (stop_monitoring, session cleanup)
/// - MetricEvent::Unsupported is emitted (/proc absent)
async fn run_monitoring_loop(
    sessions: std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<Uuid, crate::state::SessionHandle>>,
    >,
    session_id: SessionId,
    interval_secs: u64,
    on_event: Channel<MetricEvent>,
    cancel_token: tokio_util::sync::CancellationToken,
) {
    let mut prev: Option<PrevSample> = None;
    let mut tick: u64 = 0;
    let interval = Duration::from_secs(interval_secs);

    loop {
        // Wait for the next tick or cancellation.
        tokio::select! {
            _ = cancel_token.cancelled() => {
                tracing::debug!("monitoring: session={session_id} cancelled");
                break;
            }
            _ = sleep(interval) => {}
        }

        // Open SSH channel — brief lock pattern.
        let channel_result = {
            let sessions_guard = sessions.lock().await;
            let Some(session) = sessions_guard.get(&session_id) else {
                tracing::debug!("monitoring: session={session_id} not found, exiting loop");
                break;
            };
            if session.state != SessionState::Connected {
                tracing::debug!("monitoring: session={session_id} not connected, exiting loop");
                break;
            }
            let Some(ssh_handle) = session.ssh_handle.as_ref() else {
                break;
            };
            ssh_handle
                .channel_open_session()
                .await
                .map_err(AppError::Ssh)
        }; // lock released here

        let channel = match channel_result {
            Ok(ch) => ch,
            Err(e) => {
                tracing::warn!("monitoring: session={session_id} channel open failed: {e}");
                // Transient error — skip this tick, retry on next.
                continue;
            }
        };

        let opts = ExecOptions {
            timeout_secs: SAMPLE_TIMEOUT_SECS,
            output_cap_bytes: 256 * 1024, // 256 KB is more than enough
        };

        let exec_result =
            run_on_channel(channel, COMBINED_COMMAND, opts, Some(cancel_token.clone())).await;

        let output = match exec_result {
            Ok(o) => o,
            Err(AppError::ExecCancelled) => {
                tracing::debug!("monitoring: session={session_id} exec cancelled");
                break;
            }
            Err(e) => {
                tracing::warn!("monitoring: session={session_id} exec error: {e}");
                // Transient — skip tick.
                continue;
            }
        };

        // Detect /proc absent: if stdout is empty and stderr contains "No such file"
        // or the combined markers are all missing, the remote isn't Linux.
        if is_proc_absent(&output.stdout, &output.stderr) {
            tracing::info!("monitoring: session={session_id} /proc absent — emitting Unsupported");
            let _ = on_event.send(MetricEvent::Unsupported);
            break;
        }

        // Parse the combined output.
        let parsed = metrics_parser::parse_combined(&output.stdout);

        // Compute deltas.
        let now = Instant::now();
        let (cpu_pct, net_rx_bps, net_tx_bps) = if let Some(ref p) = prev {
            let elapsed = now.duration_since(p.taken_at).as_secs_f64();
            let cpu = parsed
                .cpu
                .as_ref()
                .map_or(0.0, |c| metrics_parser::cpu_delta(&p.cpu, c));
            let (rx, tx) = metrics_parser::net_delta(&p.net, &parsed.net, elapsed);
            (cpu, rx, tx)
        } else {
            // First tick — no prev state, deltas are undefined.
            (0.0, 0, 0)
        };

        // Update prev state.
        prev = parsed.cpu.map(|cpu| PrevSample {
            cpu,
            net: parsed.net.clone(),
            taken_at: now,
        });

        // Build the sample.
        let sample = MetricSample {
            session_id,
            cpu_pct,
            mem_pct: parsed.mem.usage_pct(),
            disk_entries: parsed
                .disk
                .iter()
                .map(|d| DiskEntry {
                    filesystem: d.filesystem.clone(),
                    used_pct: d.used_pct,
                    available_kb: d.available_kb,
                })
                .collect(),
            net_rx_bps,
            net_tx_bps,
            processes: parsed
                .processes
                .iter()
                .map(|p| MonitorProcessRow {
                    pid: p.pid,
                    user: p.user.clone(),
                    cpu_pct: p.cpu_pct,
                    mem_pct: p.mem_pct,
                    name: p.name.clone(),
                })
                .collect(),
            tick,
        };

        if on_event.send(MetricEvent::Sample(sample)).is_err() {
            // Frontend closed the channel — stop sampling.
            tracing::debug!("monitoring: session={session_id} channel closed by frontend");
            break;
        }

        tick += 1;
    }

    tracing::debug!("monitoring: session={session_id} loop exited (tick={tick})");
}

// ─── /proc detection ────────────────────────────────────────────────────────

/// Heuristic: the combined command output has no section markers at all,
/// or stdout is empty while stderr mentions "No such file or directory" or
/// "not found" — indicating /proc is absent (non-Linux remote).
fn is_proc_absent(stdout: &str, stderr: &str) -> bool {
    let has_any_marker = stdout.contains("===STAT===")
        || stdout.contains("===MEM===")
        || stdout.contains("===DISK===");

    if !has_any_marker && stdout.trim().is_empty() {
        // Could be a restricted shell that doesn't allow cat.
        // Check stderr for hints.
        let stderr_lower = stderr.to_lowercase();
        return stderr_lower.contains("no such file")
            || stderr_lower.contains("not found")
            || stderr_lower.contains("permission denied");
    }

    false
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── WU3: /proc-absent detection ──────────────────────────────────────

    #[test]
    fn proc_absent_empty_stdout_with_no_such_file_stderr() {
        assert!(is_proc_absent(
            "",
            "cat: /proc/stat: No such file or directory\n"
        ));
    }

    #[test]
    fn proc_absent_empty_stdout_with_not_found_stderr() {
        assert!(is_proc_absent("", "sh: cat: not found\n"));
    }

    #[test]
    fn proc_absent_false_when_markers_present() {
        assert!(!is_proc_absent("===STAT===\ncpu 1 2 3 4\n", ""));
    }

    #[test]
    fn proc_absent_false_on_normal_output() {
        let output = "===STAT===\ncpu 100 0 50 800\n===MEM===\nMemTotal: 8192 kB\n";
        assert!(!is_proc_absent(output, ""));
    }

    #[test]
    fn proc_absent_false_when_stdout_nonempty_no_marker() {
        // Unusual but non-empty stdout without markers is NOT treated as absent —
        // it might be a restricted shell echoing something. Let the parser degrade
        // gracefully rather than killing the sampler.
        assert!(!is_proc_absent("some output without markers", ""));
    }

    // ── WU3: COMBINED_COMMAND sanity ─────────────────────────────────────

    #[test]
    fn combined_command_has_all_section_markers() {
        assert!(COMBINED_COMMAND.contains("===STAT==="));
        assert!(COMBINED_COMMAND.contains("===MEM==="));
        assert!(COMBINED_COMMAND.contains("===NET==="));
        assert!(COMBINED_COMMAND.contains("===DISK==="));
        assert!(COMBINED_COMMAND.contains("===PS==="));
    }

    #[test]
    fn combined_command_references_proc_files() {
        assert!(COMBINED_COMMAND.contains("/proc/stat"));
        assert!(COMBINED_COMMAND.contains("/proc/meminfo"));
        assert!(COMBINED_COMMAND.contains("/proc/net/dev"));
    }
}
