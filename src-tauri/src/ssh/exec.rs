// ssh/exec.rs — SSH exec-and-capture primitive
//
// Provides a one-shot "run command and collect output" capability distinct from
// the interactive PTY channel in terminal.rs. Used by monitoring, docker, and
// proxmox features that need complete stdout/stderr/exit-code without a TTY.
//
// Architecture:
// - ExecAccumulator: pure struct (no russh dependency) — fully unit-testable.
//   Processes AccumulatorEvent values and tracks stdout/stderr/exit.
// - run_on_channel: async fn that drives a real russh channel through exec,
//   translates ChannelMsg into AccumulatorEvent, enforces timeout and
//   cancellation, and cleans up the channel on every exit path.
// - ssh_exec is in commands/exec.rs — it opens the channel under a brief
//   sessions-lock scope (mirror of tunnel.rs) and then calls run_on_channel.
//
// CRITICAL correctness invariants (from SSH spec):
// 1. ExitStatus arrives BEFORE Eof — do NOT terminate the loop on ExitStatus.
//    Only Eof / Close / None terminate the accumulation loop.
// 2. ChannelMsg is #[non_exhaustive] — the match MUST have a wildcard arm.
// 3. russh::client::Handle is NOT Clone — callers open the channel under a
//    brief lock and pass it here; we never hold the sessions Mutex ourselves.
// 4. stdout ← ChannelMsg::Data; stderr ← ExtendedData { ext: 1 } (SSH_EXTENDED_DATA_STDERR).
// 5. Output cap: 10 MB per stream. On overflow: set truncated=true, stop
//    appending that stream, but keep draining until Eof/Close so the channel
//    closes cleanly.
// 6. On any error/timeout/cancel path: `let _ = channel.close().await;`.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::error::AppError;

// ─── Constants ──────────────────────────────────────────

pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub const DEFAULT_OUTPUT_CAP_BYTES: usize = 10 * 1024 * 1024; // 10 MB

// ─── ExecOutput ─────────────────────────────────────────

/// Outcome of a single exec-and-capture call.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    /// UTF-8 lossy decoded stdout
    pub stdout: String,
    /// UTF-8 lossy decoded stderr
    pub stderr: String,
    /// Exit code, if the server sent one. None if the process was killed by a
    /// signal or the session ended abnormally before the exit status arrived.
    pub exit_code: Option<i32>,
    /// Signal name that killed the process, if any (e.g. "KILL", "TERM").
    pub exit_signal: Option<String>,
    /// True if stdout exceeded the output cap and was truncated.
    pub stdout_truncated: bool,
    /// True if stderr exceeded the output cap and was truncated.
    pub stderr_truncated: bool,
}

// ─── ExecOptions ────────────────────────────────────────

/// Options controlling a run_on_channel call.
#[derive(Debug, Clone)]
pub struct ExecOptions {
    /// Timeout in seconds for the entire exec call. Default: DEFAULT_TIMEOUT_SECS.
    pub timeout_secs: u64,
    /// Maximum bytes to accumulate per stream before truncating. Default: DEFAULT_OUTPUT_CAP_BYTES.
    pub output_cap_bytes: usize,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            output_cap_bytes: DEFAULT_OUTPUT_CAP_BYTES,
        }
    }
}

// ─── AccumulatorEvent ───────────────────────────────────

/// Mirror of the ChannelMsg variants relevant to exec — decoupled from russh so
/// ExecAccumulator can be unit-tested without a live SSH connection.
#[derive(Debug)]
pub enum AccumulatorEvent {
    /// Bytes received on stdout (ChannelMsg::Data).
    Stdout(Vec<u8>),
    /// Bytes received on stderr (ChannelMsg::ExtendedData { ext: 1 }).
    Stderr(Vec<u8>),
    /// Process exited with the given code (ChannelMsg::ExitStatus).
    ExitCode(u32),
    /// Process was killed by a signal (ChannelMsg::ExitSignal).
    ExitSignal(String),
    /// Channel is done — accumulation should stop (Eof, Close, or None).
    Done,
}

// ─── ExecAccumulator ────────────────────────────────────

/// Pure, synchronous accumulator — no async, no russh dependency.
///
/// Call `process()` for each event, then call `finish()` to consume the
/// accumulator and produce an ExecOutput. The `done` field becomes true
/// when a `Done` event is processed.
pub struct ExecAccumulator {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
    exit_signal: Option<String>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    /// True once a Done event has been received.
    pub done: bool,
    cap: usize,
}

impl ExecAccumulator {
    /// Create a new accumulator with the given output cap per stream.
    pub fn new(cap: usize) -> Self {
        Self {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: None,
            exit_signal: None,
            stdout_truncated: false,
            stderr_truncated: false,
            done: false,
            cap,
        }
    }

    /// Process a single event. After receiving `Done`, further events are ignored.
    pub fn process(&mut self, event: AccumulatorEvent) {
        if self.done {
            return;
        }
        match event {
            AccumulatorEvent::Stdout(data) => {
                if !self.stdout_truncated {
                    let remaining = self.cap.saturating_sub(self.stdout.len());
                    if data.len() > remaining {
                        self.stdout.extend_from_slice(&data[..remaining]);
                        self.stdout_truncated = true;
                    } else {
                        self.stdout.extend_from_slice(&data);
                    }
                }
                // When truncated, keep draining (caller's loop must continue) —
                // we just stop appending.
            }
            AccumulatorEvent::Stderr(data) => {
                if !self.stderr_truncated {
                    let remaining = self.cap.saturating_sub(self.stderr.len());
                    if data.len() > remaining {
                        self.stderr.extend_from_slice(&data[..remaining]);
                        self.stderr_truncated = true;
                    } else {
                        self.stderr.extend_from_slice(&data);
                    }
                }
            }
            AccumulatorEvent::ExitCode(code) => {
                // u32 from SSH → i32 for usability (most callers expect signed).
                self.exit_code = Some(code as i32);
            }
            AccumulatorEvent::ExitSignal(signal) => {
                self.exit_signal = Some(signal);
            }
            AccumulatorEvent::Done => {
                self.done = true;
            }
        }
    }

    /// Consume the accumulator and produce the final ExecOutput.
    pub fn finish(self) -> ExecOutput {
        ExecOutput {
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            stdout_truncated: self.stdout_truncated,
            stderr_truncated: self.stderr_truncated,
        }
    }
}

// ─── run_on_channel ─────────────────────────────────────

/// Core exec primitive.
///
/// Takes an already-opened session channel (opened by the caller under a brief
/// sessions-lock, mirroring tunnel.rs), sends the exec request, accumulates
/// output, and returns ExecOutput.
///
/// # Cancellation
///
/// Pass a `CancellationToken` to allow the caller to abort the exec. On
/// cancellation the channel is closed and `AppError::ExecCancelled` is returned.
///
/// # Timeout
///
/// The entire operation is wrapped in `tokio::time::timeout`. On expiry the
/// channel is closed and `AppError::ExecTimeout` is returned.
///
/// # Error paths
///
/// On every error/timeout/cancel path, `channel.close().await` is called
/// (best-effort, error ignored) to prevent channel leaks.
pub async fn run_on_channel(
    mut channel: russh::Channel<russh::client::Msg>,
    command: impl Into<Vec<u8>>,
    opts: ExecOptions,
    cancel_token: Option<CancellationToken>,
) -> Result<ExecOutput, AppError> {
    use russh::ChannelMsg;

    let command_bytes: Vec<u8> = command.into();

    // Send the exec request.
    channel
        .exec(true, command_bytes)
        .await
        .map_err(AppError::Ssh)?;

    let mut acc = ExecAccumulator::new(opts.output_cap_bytes);
    let timeout_dur = Duration::from_secs(opts.timeout_secs);

    // Wrap the accumulation loop in a timeout.
    let loop_result = tokio::time::timeout(timeout_dur, async {
        loop {
            if let Some(ref token) = cancel_token {
                tokio::select! {
                    _ = token.cancelled() => {
                        return Err(AppError::Other("exec cancelled".to_string()));
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                acc.process(AccumulatorEvent::Stdout(data.to_vec()));
                            }
                            Some(ChannelMsg::ExtendedData { data, ext }) => {
                                if ext == 1 {
                                    acc.process(AccumulatorEvent::Stderr(data.to_vec()));
                                }
                                // Other ext types (rare/unknown) — drain but discard.
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                // ExitStatus arrives BEFORE Eof per SSH spec — capture
                                // it but do NOT terminate; data may still arrive.
                                acc.process(AccumulatorEvent::ExitCode(exit_status));
                            }
                            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                                acc.process(AccumulatorEvent::ExitSignal(
                                    format!("{signal_name:?}"),
                                ));
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                acc.process(AccumulatorEvent::Done);
                                break;
                            }
                            Some(_) => {
                                // #[non_exhaustive]: WindowAdjusted, Success, etc. — ignore.
                            }
                        }
                    }
                }
            } else {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        acc.process(AccumulatorEvent::Stdout(data.to_vec()));
                    }
                    Some(ChannelMsg::ExtendedData { data, ext }) => {
                        if ext == 1 {
                            acc.process(AccumulatorEvent::Stderr(data.to_vec()));
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        acc.process(AccumulatorEvent::ExitCode(exit_status));
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        acc.process(AccumulatorEvent::ExitSignal(format!("{signal_name:?}")));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        acc.process(AccumulatorEvent::Done);
                        break;
                    }
                    Some(_) => {
                        // #[non_exhaustive]: ignore unknown variants.
                    }
                }
            }
        }
        Ok(acc)
    })
    .await;

    match loop_result {
        Ok(Ok(accumulator)) => Ok(accumulator.finish()),
        Ok(Err(e)) => {
            // Cancelled — close channel best-effort.
            let _ = channel.close().await;
            Err(e)
        }
        Err(_timeout) => {
            // Timeout — close channel best-effort.
            let _ = channel.close().await;
            Err(AppError::ExecTimeout)
        }
    }
}

// ─── Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── WU1: ExecAccumulator unit tests (pure, no russh) ──

    #[test]
    fn stdout_accumulates() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        acc.process(AccumulatorEvent::Stdout(b"hello ".to_vec()));
        acc.process(AccumulatorEvent::Stdout(b"world".to_vec()));
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.stdout, "hello world");
        assert!(!out.stdout_truncated);
    }

    #[test]
    fn stderr_separated_from_stdout() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        acc.process(AccumulatorEvent::Stdout(b"out".to_vec()));
        acc.process(AccumulatorEvent::Stderr(b"err".to_vec()));
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.stdout, "out");
        assert_eq!(out.stderr, "err");
    }

    #[test]
    fn exit_code_captured() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        acc.process(AccumulatorEvent::ExitCode(42));
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.exit_code, Some(42));
    }

    #[test]
    fn exit_signal_captured() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        acc.process(AccumulatorEvent::ExitSignal("KILL".to_string()));
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.exit_signal.as_deref(), Some("KILL"));
    }

    #[test]
    fn eof_terminates_via_done_event() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        assert!(!acc.done);
        acc.process(AccumulatorEvent::Done);
        assert!(acc.done);
        // Further events are ignored after Done.
        acc.process(AccumulatorEvent::Stdout(b"ignored".to_vec()));
        let out = acc.finish();
        assert_eq!(out.stdout, "");
    }

    #[test]
    fn stdout_truncated_at_cap() {
        let cap = 10;
        let mut acc = ExecAccumulator::new(cap);
        // Send exactly cap bytes — no truncation yet.
        acc.process(AccumulatorEvent::Stdout(b"0123456789".to_vec()));
        assert!(!acc.finish_ref().stdout_truncated());

        let mut acc2 = ExecAccumulator::new(cap);
        // Send cap + 1 bytes in one chunk.
        acc2.process(AccumulatorEvent::Stdout(b"01234567890".to_vec()));
        let out = acc2.finish();
        assert!(out.stdout_truncated);
        assert_eq!(out.stdout.len(), cap);
    }

    #[test]
    fn stderr_truncated_at_cap() {
        let cap = 5;
        let mut acc = ExecAccumulator::new(cap);
        acc.process(AccumulatorEvent::Stderr(b"123456".to_vec()));
        let out = acc.finish();
        assert!(out.stderr_truncated);
        assert_eq!(out.stderr.len(), cap);
    }

    #[test]
    fn utf8_lossy_decoding() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        // Invalid UTF-8 bytes — should not panic, replaced with U+FFFD.
        acc.process(AccumulatorEvent::Stdout(vec![0xFF, 0xFE, b'X']));
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert!(out.stdout.contains('X'));
        // Contains the replacement character for the invalid bytes.
        assert!(out.stdout.contains('\u{FFFD}'));
    }

    #[test]
    fn no_exit_code_gives_none() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.exit_code, None);
    }

    #[test]
    fn multiple_data_chunks_concatenate() {
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        for i in 0..5u8 {
            acc.process(AccumulatorEvent::Stdout(vec![b'a' + i]));
        }
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.stdout, "abcde");
    }

    #[test]
    fn exit_status_before_eof_does_not_terminate() {
        // Simulates SSH spec: ExitStatus arrives before Eof. Data after
        // ExitStatus must still be captured.
        let mut acc = ExecAccumulator::new(DEFAULT_OUTPUT_CAP_BYTES);
        acc.process(AccumulatorEvent::ExitCode(0));
        assert!(!acc.done, "ExitCode must NOT set done=true");
        acc.process(AccumulatorEvent::Stdout(b"late data".to_vec()));
        acc.process(AccumulatorEvent::Done);
        let out = acc.finish();
        assert_eq!(out.stdout, "late data");
        assert_eq!(out.exit_code, Some(0));
    }

    // ── finish_ref helper ──────────────────────────────────────────────────────
    // finish() consumes self, but stdout_truncated_at_cap needs to check the
    // flag on a still-alive accumulator (first assertion). We use a tiny
    // by-ref view struct scoped inside the test module.

    struct ExecOutputRef<'a> {
        acc: &'a ExecAccumulator,
    }

    impl ExecOutputRef<'_> {
        fn stdout_truncated(&self) -> bool {
            self.acc.stdout_truncated
        }
    }

    impl ExecAccumulator {
        fn finish_ref(&self) -> ExecOutputRef<'_> {
            ExecOutputRef { acc: self }
        }
    }
}
