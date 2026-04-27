// ssh/terminal.rs — PTY terminal channel management
//
// Handles opening PTY channels, data streaming (input/output),
// terminal resize, and channel lifecycle.
//
// Architecture (H1 fix — mpsc command channel):
// - The reader task OWNS the SSH channel exclusively (no shared Mutex).
// - Write/resize/close operations send commands through an mpsc channel.
// - The reader task uses tokio::select! to listen for both SSH data and commands.
// - This eliminates Mutex contention — writes never block on the reader.

use tauri::ipc::Channel;
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::ssh::handler::SshClientHandler;
use crate::state::{TerminalChannelHandle, TerminalCommand, TerminalEvent, TerminalId};

/// Default terminal type for PTY requests
const TERM_TYPE: &str = "xterm-256color";

/// PTY terminal modes for interactive full-screen terminal apps.
///
/// Editors like vim/nano depend on the server receiving a sane TTY profile for
/// signals, canonical processing, echo, flow control, and line ending
/// translation. Relying on server defaults (`&[]`) can leave these modes in an
/// inconsistent state, which manifests as Esc/Ctrl keys not behaving correctly
/// or insert mode appearing "stuck".
const PTY_MODES: &[(russh::Pty, u32)] = &[
    (russh::Pty::ISIG, 1),
    (russh::Pty::ICANON, 1),
    (russh::Pty::ECHO, 1),
    (russh::Pty::ECHOE, 1),
    (russh::Pty::ECHOK, 1),
    (russh::Pty::ECHONL, 0),
    (russh::Pty::IEXTEN, 1),
    (russh::Pty::IXON, 1),
    (russh::Pty::IXOFF, 0),
    (russh::Pty::ICRNL, 1),
    (russh::Pty::INLCR, 0),
    (russh::Pty::IGNCR, 0),
    (russh::Pty::OPOST, 1),
    (russh::Pty::ONLCR, 1),
    (russh::Pty::CS8, 1),
    (russh::Pty::TTY_OP_ISPEED, 14_400),
    (russh::Pty::TTY_OP_OSPEED, 14_400),
];

/// Buffer size for the terminal command channel.
/// 256 is generous — each command is tiny (keystroke bytes or resize dimensions).
/// This avoids backpressure on the frontend even during burst typing.
const COMMAND_CHANNEL_SIZE: usize = 256;

// ─── Open PTY ───────────────────────────────────────────

/// Open a PTY channel on an existing SSH session.
/// Returns a TerminalChannelHandle with the reader task already spawned.
///
/// This function:
/// 1. Opens an SSH session channel
/// 2. Requests a PTY with xterm-256color and the specified dimensions
/// 3. Starts a shell on the channel
/// 4. Spawns a background task that owns the channel and processes both
///    SSH output and incoming commands (write/resize/close)
pub async fn open_pty(
    ssh_handle: &russh::client::Handle<SshClientHandler>,
    cols: u32,
    rows: u32,
    on_output: Channel<TerminalEvent>,
) -> Result<TerminalChannelHandle, AppError> {
    let terminal_id = uuid::Uuid::new_v4();

    // Open a session channel
    let channel = ssh_handle.channel_open_session().await.map_err(AppError::Ssh)?;
    let channel_id = channel.id();

    // Request PTY
    channel
        .request_pty(
            true, // interactive editors need PTY negotiation to succeed explicitly
            TERM_TYPE,
            cols,
            rows,
            0, // pixel width (0 = let server decide)
            0, // pixel height
            PTY_MODES,
        )
        .await
        .map_err(AppError::Ssh)?;

    // Start shell
    channel
        .request_shell(true)
        .await
        .map_err(AppError::Ssh)?;

    // Create the command channel
    let (command_tx, command_rx) = mpsc::channel::<TerminalCommand>(COMMAND_CHANNEL_SIZE);

    // Spawn the reader task — it OWNS the channel (no Arc<Mutex>)
    let reader_task = spawn_terminal_task(terminal_id, channel, command_rx, on_output);

    let handle = TerminalChannelHandle {
        id: terminal_id,
        channel_id,
        command_tx,
        reader_task: Some(reader_task),
        cols,
        rows,
    };

    Ok(handle)
}

// ─── Terminal Task (reader + command processor) ─────────

/// Spawn the terminal task that owns the SSH channel exclusively.
///
/// Uses `tokio::select!` to multiplex between:
/// - SSH channel output (data from the remote shell)
/// - Command channel (write/resize/close from frontend)
///
/// This eliminates all Mutex contention — the channel is never shared.
fn spawn_terminal_task(
    terminal_id: TerminalId,
    mut channel: russh::Channel<russh::client::Msg>,
    mut command_rx: mpsc::Receiver<TerminalCommand>,
    on_output: Channel<TerminalEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use russh::ChannelMsg;

        loop {
            tokio::select! {
                // Branch 1: SSH channel output
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            if on_output
                                .send(TerminalEvent::Output {
                                    data: data.to_vec(),
                                })
                                .is_err()
                            {
                                tracing::debug!(
                                    "Terminal output channel dropped for {terminal_id}"
                                );
                                break;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, ext: _ }) => {
                            // Extended data (stderr) — forward as output
                            if on_output
                                .send(TerminalEvent::Output {
                                    data: data.to_vec(),
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            tracing::info!(
                                "Terminal {terminal_id} exited with status {exit_status}"
                            );
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: format!("Process exited with code {exit_status}"),
                            });
                            break;
                        }
                        Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                            tracing::info!(
                                "Terminal {terminal_id} killed by signal: {signal_name:?}"
                            );
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: format!("Process killed by signal {signal_name:?}"),
                            });
                            break;
                        }
                        Some(ChannelMsg::Eof) => {
                            tracing::debug!("Terminal {terminal_id} EOF");
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: "Shell session ended".to_string(),
                            });
                            break;
                        }
                        Some(ChannelMsg::Close) => {
                            tracing::debug!("Terminal {terminal_id} channel closed");
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: "Channel closed".to_string(),
                            });
                            break;
                        }
                        None => {
                            // Channel stream ended
                            tracing::debug!("Terminal {terminal_id} channel stream ended");
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: "Connection lost".to_string(),
                            });
                            break;
                        }
                        Some(_) => {
                            // Ignore other message types (WindowAdjust, etc.)
                        }
                    }
                }

                // Branch 2: Commands from frontend (write/resize/close)
                cmd = command_rx.recv() => {
                    match cmd {
                        Some(TerminalCommand::Write(data)) => {
                            if let Err(e) = channel.data(&data[..]).await {
                                tracing::error!(
                                    "Terminal {terminal_id} write failed: {e}"
                                );
                                let _ = on_output.send(TerminalEvent::Error {
                                    message: format!("Write failed: {e}"),
                                });
                                break;
                            }
                        }
                        Some(TerminalCommand::Resize(cols, rows)) => {
                            if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                tracing::error!(
                                    "Terminal {terminal_id} resize failed: {e}"
                                );
                                // Resize failure is non-fatal — don't break
                                let _ = on_output.send(TerminalEvent::Error {
                                    message: format!("Resize failed: {e}"),
                                });
                            }
                        }
                        Some(TerminalCommand::Close) => {
                            tracing::debug!("Terminal {terminal_id} close requested");
                            if let Err(e) = channel.close().await {
                                tracing::warn!(
                                    "Terminal {terminal_id} close error (may already be closed): {e}"
                                );
                            }
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: "Terminal closed by user".to_string(),
                            });
                            break;
                        }
                        None => {
                            // All senders dropped — terminal handle was dropped
                            tracing::debug!(
                                "Terminal {terminal_id} command channel closed (handle dropped)"
                            );
                            let _ = channel.close().await;
                            let _ = on_output.send(TerminalEvent::Closed {
                                reason: "Terminal handle dropped".to_string(),
                            });
                            break;
                        }
                    }
                }
            }
        }

        tracing::debug!("Terminal {terminal_id} task exiting");
    })
}

// ─── Write Data ─────────────────────────────────────────

/// Send raw bytes (keystrokes) to a terminal channel via the command channel.
/// This never blocks on the reader — it sends through mpsc and returns immediately.
pub async fn write_data(
    command_tx: &mpsc::Sender<TerminalCommand>,
    data: &[u8],
) -> Result<(), AppError> {
    command_tx
        .send(TerminalCommand::Write(data.to_vec()))
        .await
        .map_err(|_| AppError::Other("Terminal channel closed".to_string()))?;
    Ok(())
}

// ─── Resize PTY ─────────────────────────────────────────

/// Send a window-change (resize) request to a terminal channel via the command channel.
pub async fn resize_pty(
    command_tx: &mpsc::Sender<TerminalCommand>,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    command_tx
        .send(TerminalCommand::Resize(cols, rows))
        .await
        .map_err(|_| AppError::Other("Terminal channel closed".to_string()))?;
    Ok(())
}

// ─── Close Terminal ─────────────────────────────────────

/// Close a terminal by sending a Close command through the command channel.
/// The reader task will close the SSH channel and exit.
pub async fn close_terminal(
    command_tx: &mpsc::Sender<TerminalCommand>,
) -> Result<(), AppError> {
    // Use try_send for close — if the channel is full or closed, that's fine
    let _ = command_tx.try_send(TerminalCommand::Close);
    Ok(())
}
