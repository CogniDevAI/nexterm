// ssh/tunnel.rs — SSH port forwarding (local and remote)
//
// Manages tunnel lifecycle: create, start, stop, delete.
// Local forwards bind a TCP listener and forward through SSH.
// Remote forwards request server-side listeners.
//
// Architecture:
// - Each tunnel gets its own CancellationToken (child of session's token)
// - Local forward: TcpListener accept loop → channel_open_direct_tcpip → bidirectional proxy
// - Remote forward: tcpip_forward() request → handler callback → local TcpStream → proxy
// - Active connection count tracked via Arc<AtomicU32>
// - Bytes transferred tracked via Arc<AtomicU64>
//
// Key constraint: russh::client::Handle is NOT Clone. For local forwarding,
// the accept loop needs to open new SSH channels for each incoming connection.
// We share the sessions Mutex (from AppState) with the spawned task, which
// briefly locks it to access the Handle for each channel_open_direct_tcpip call.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use russh::client::Msg;
use russh::ChannelMsg;
use tauri::ipc::Channel as TauriChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::ssh::handler::SshClientHandler;
use crate::state::{
    SessionHandle, SessionId, TunnelConfig, TunnelEvent, TunnelHandle, TunnelId, TunnelState,
};

/// Type alias for the shared sessions map (same as AppState.sessions, but Arc-wrapped)
pub type SharedSessions = Arc<Mutex<HashMap<SessionId, SessionHandle>>>;

/// Start a local port forward (-L style).
///
/// Binds a TCP listener on `config.bind_host:config.bind_port`.
/// For each incoming connection, opens an SSH direct-tcpip channel to
/// `config.target_host:config.target_port` and proxies data bidirectionally.
///
/// The `sessions` parameter provides shared access to the session map
/// for opening new SSH channels from the accept loop.
pub async fn start_local_forward(
    sessions: SharedSessions,
    session_id: SessionId,
    config: &TunnelConfig,
    session_cancel: CancellationToken,
    on_event: TauriChannel<TunnelEvent>,
) -> Result<TunnelHandle, AppError> {
    let tunnel_id = config.id;
    let tunnel_cancel = session_cancel.child_token();
    let active_connections = Arc::new(AtomicU32::new(0));
    let bytes_in = Arc::new(AtomicU64::new(0));
    let bytes_out = Arc::new(AtomicU64::new(0));

    // Bind the local listener
    let bind_addr = format!("{}:{}", config.bind_host, config.bind_port);
    let listener = TcpListener::bind(&bind_addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            AppError::TunnelError(format!("Port {} already in use", config.bind_port))
        } else {
            AppError::TunnelError(format!("Failed to bind {}: {}", bind_addr, e))
        }
    })?;

    tracing::info!(
        "Local tunnel {tunnel_id}: listening on {bind_addr} → {}:{}",
        config.target_host,
        config.target_port
    );

    // Send initial state change
    let _ = on_event.send(TunnelEvent::StateChanged {
        tunnel_id,
        state: TunnelState::Active { connections: 0 },
    });

    // Clone what we need for the spawned task
    let target_host = config.target_host.clone();
    let target_port = config.target_port;
    let cancel = tunnel_cancel.clone();
    let conns = active_connections.clone();
    let bytes_in_clone = bytes_in.clone();
    let bytes_out_clone = bytes_out.clone();
    let event_channel = on_event.clone();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    tracing::info!("Local tunnel {tunnel_id}: cancelled, stopping listener");
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, peer_addr)) => {
                            let conn_count = conns.fetch_add(1, Ordering::Relaxed) + 1;
                            tracing::debug!(
                                "Local tunnel {tunnel_id}: accepted connection from {peer_addr} (active: {conn_count})"
                            );

                            // Notify frontend of connection count change
                            let _ = event_channel.send(TunnelEvent::StateChanged {
                                tunnel_id,
                                state: TunnelState::Active { connections: conn_count },
                            });

                            // Open SSH direct-tcpip channel by briefly locking sessions
                            let sessions_clone = sessions.clone();
                            let target_h = target_host.clone();
                            let conns_inner = conns.clone();
                            let bytes_in_inner = bytes_in_clone.clone();
                            let bytes_out_inner = bytes_out_clone.clone();
                            let cancel_inner = cancel.clone();
                            let event_inner = event_channel.clone();

                            tokio::spawn(async move {
                                // Open the SSH channel — lock sessions briefly
                                let channel_result = {
                                    let sessions_guard = sessions_clone.lock().await;
                                    let session = match sessions_guard.get(&session_id) {
                                        Some(s) => s,
                                        None => {
                                            tracing::error!("Local tunnel {tunnel_id}: session {session_id} not found");
                                            let conn_count = atomic_saturating_sub(&conns_inner, 1);
                                            let _ = event_inner.send(TunnelEvent::StateChanged {
                                                tunnel_id,
                                                state: TunnelState::Active {
                                                    connections: conn_count,
                                                },
                                            });
                                            return;
                                        }
                                    };
                                    let ssh_handle = match &session.ssh_handle {
                                        Some(h) => h,
                                        None => {
                                            tracing::error!("Local tunnel {tunnel_id}: no SSH handle");
                                            let conn_count = atomic_saturating_sub(&conns_inner, 1);
                                            let _ = event_inner.send(TunnelEvent::StateChanged {
                                                tunnel_id,
                                                state: TunnelState::Active {
                                                    connections: conn_count,
                                                },
                                            });
                                            return;
                                        }
                                    };

                                    ssh_handle
                                        .channel_open_direct_tcpip(
                                            target_h.as_str(),
                                            target_port as u32,
                                            peer_addr.ip().to_string(),
                                            peer_addr.port() as u32,
                                        )
                                        .await
                                };

                                match channel_result {
                                    Ok(channel) => {
                                        let result = proxy_bidirectional(
                                            stream,
                                            channel,
                                            tunnel_id,
                                            &bytes_in_inner,
                                            &bytes_out_inner,
                                            cancel_inner,
                                        )
                                        .await;

                                        if let Err(e) = result {
                                            tracing::debug!(
                                                "Local tunnel {tunnel_id}: connection from {peer_addr} ended with error: {e}"
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        tracing::debug!(
                                            "Local tunnel {tunnel_id}: failed to open direct-tcpip channel: {e}"
                                        );
                                    }
                                }

                                // Decrement active connections (saturating to avoid u32 underflow)
                                let conn_count = atomic_saturating_sub(&conns_inner, 1);
                                let _ = event_inner.send(TunnelEvent::StateChanged {
                                    tunnel_id,
                                    state: TunnelState::Active { connections: conn_count },
                                });
                            });
                        }
                        Err(e) => {
                            tracing::error!("Local tunnel {tunnel_id}: accept error: {e}");
                            // Don't break on transient accept errors
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                    }
                }
            }
        }
    });

    Ok(TunnelHandle {
        id: tunnel_id,
        config: config.clone(),
        state: TunnelState::Active { connections: 0 },
        cancel_token: tunnel_cancel,
        task: Some(task),
        bytes_in,
        bytes_out,
        active_connections: Some(active_connections),
    })
}

/// Start a remote port forward (-R style).
///
/// Requests the SSH server to listen on `config.bind_host:config.bind_port`.
/// When connections arrive on the remote side, the handler's
/// `server_channel_open_forwarded_tcpip` callback handles them via the
/// RemoteForwardRegistry.
pub async fn start_remote_forward(
    ssh_handle: &mut russh::client::Handle<SshClientHandler>,
    config: &TunnelConfig,
    session_cancel: CancellationToken,
    registry: RemoteForwardRegistry,
    on_event: TauriChannel<TunnelEvent>,
) -> Result<TunnelHandle, AppError> {
    let tunnel_id = config.id;
    let tunnel_cancel = session_cancel.child_token();
    let active_connections = Arc::new(AtomicU32::new(0));
    let bytes_in = Arc::new(AtomicU64::new(0));
    let bytes_out = Arc::new(AtomicU64::new(0));

    // Request server to bind the remote port
    let bind_addr = config.bind_host.clone();
    let bind_port = config.bind_port;

    tracing::info!(
        "Remote tunnel {tunnel_id}: requesting server to listen on {bind_addr}:{bind_port}"
    );

    let actual_port = ssh_handle
        .tcpip_forward(&bind_addr, bind_port as u32)
        .await
        .map_err(|e| match e {
            russh::Error::RequestDenied => AppError::TunnelError(format!(
                "Server denied remote port forward on {}:{}. Check server GatewayPorts setting.",
                bind_addr, bind_port
            )),
            other => AppError::TunnelError(format!(
                "Failed to request remote forward on {}:{}: {}",
                bind_addr, bind_port, other
            )),
        })?;

    let effective_port = if actual_port > 0 {
        actual_port as u16
    } else {
        bind_port
    };

    tracing::info!(
        "Remote tunnel {tunnel_id}: server listening on {bind_addr}:{effective_port} → {}:{}",
        config.target_host,
        config.target_port
    );

    // Register this remote forward in the handler's registry so
    // server_channel_open_forwarded_tcpip knows how to route incoming connections
    let registry_entry = RemoteForwardEntry {
        tunnel_id,
        target_host: config.target_host.clone(),
        target_port: config.target_port,
        active_connections: active_connections.clone(),
        bytes_in: bytes_in.clone(),
        bytes_out: bytes_out.clone(),
        cancel_token: tunnel_cancel.clone(),
        on_event: on_event.clone(),
    };

    // Store in the shared registry (accessible by both tunnel code and handler)
    {
        let mut reg = registry.lock().await;
        reg.insert(
            RemoteForwardKey {
                address: bind_addr.clone(),
                port: effective_port as u32,
            },
            registry_entry,
        );
    }

    // Notify frontend
    let _ = on_event.send(TunnelEvent::StateChanged {
        tunnel_id,
        state: TunnelState::Active { connections: 0 },
    });

    // The "task" for remote forward is the cancellation cleanup —
    // actual connection handling happens in the Handler callback.
    // We spawn a task that waits for cancellation and then cleans up.
    let cancel = tunnel_cancel.clone();
    let registry_clone = registry.clone();
    let addr_clone = bind_addr.clone();

    let task = tokio::spawn(async move {
        // Wait for cancellation
        cancel.cancelled().await;

        tracing::info!(
            "Remote tunnel {tunnel_id}: cancelled, cleaning up"
        );

        // Remove from registry
        {
            let mut reg = registry_clone.lock().await;
            reg.remove(&RemoteForwardKey {
                address: addr_clone.clone(),
                port: effective_port as u32,
            });
        }

        // Note: cancel_tcpip_forward is called by the command layer (commands/tunnel.rs)
        // before cancelling the token, since it has access to the SSH Handle.
        // This task only handles registry cleanup.
    });

    // Build the TunnelHandle — update config with effective port if server chose one
    let mut effective_config = config.clone();
    if actual_port > 0 && actual_port as u16 != bind_port {
        effective_config.bind_port = effective_port;
    }

    Ok(TunnelHandle {
        id: tunnel_id,
        config: effective_config,
        state: TunnelState::Active { connections: 0 },
        cancel_token: tunnel_cancel,
        task: Some(task),
        bytes_in,
        bytes_out,
        active_connections: Some(active_connections),
    })
}

/// Handle an incoming remote-forwarded connection.
/// Called from the Handler's `server_channel_open_forwarded_tcpip` callback.
pub async fn handle_remote_forward_connection(
    channel: russh::Channel<Msg>,
    entry: RemoteForwardEntry,
    originator_address: String,
    originator_port: u32,
) {
    let tunnel_id = entry.tunnel_id;
    let conn_count = entry.active_connections.fetch_add(1, Ordering::Relaxed) + 1;

    tracing::debug!(
        "Remote tunnel {tunnel_id}: incoming connection from {originator_address}:{originator_port} (active: {conn_count})"
    );

    // Notify frontend
    let _ = entry.on_event.send(TunnelEvent::StateChanged {
        tunnel_id,
        state: TunnelState::Active {
            connections: conn_count,
        },
    });

    // Connect to local target and proxy
    let target_addr = format!("{}:{}", entry.target_host, entry.target_port);

    match TcpStream::connect(&target_addr).await {
        Ok(tcp_stream) => {
            let result = proxy_bidirectional(
                tcp_stream,
                channel,
                tunnel_id,
                &entry.bytes_in,
                &entry.bytes_out,
                entry.cancel_token.clone(),
            )
            .await;

            if let Err(e) = result {
                tracing::debug!(
                    "Remote tunnel {tunnel_id}: connection from {originator_address}:{originator_port} ended with error: {e}"
                );
            }
        }
        Err(e) => {
            tracing::debug!(
                "Remote tunnel {tunnel_id}: failed to connect to local target {target_addr}: {e}"
            );
            // Close the SSH channel — target not reachable
            let _ = channel.eof().await;
        }
    }

    // Decrement active connections (saturating to avoid u32 underflow)
    let conn_count = atomic_saturating_sub(&entry.active_connections, 1);
    let _ = entry.on_event.send(TunnelEvent::StateChanged {
        tunnel_id,
        state: TunnelState::Active {
            connections: conn_count,
        },
    });
}

// ─── Atomic Helpers ─────────────────────────────────────

/// Decrement an AtomicU32 with saturating subtraction (never wraps below 0).
///
/// `fetch_sub(1)` on an AtomicU32 wraps to u32::MAX when the counter is already 0.
/// This can happen if a tunnel connection closes after the tunnel was already stopped.
/// We use `fetch_update` with a CAS loop to guarantee the counter stays at 0 minimum.
///
/// Returns the new value after decrement (saturated at 0).
fn atomic_saturating_sub(counter: &AtomicU32, val: u32) -> u32 {
    let prev = counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(current.saturating_sub(val))
        })
        // fetch_update with a closure that always returns Some never fails
        .unwrap();
    prev.saturating_sub(val)
}

// ─── Bidirectional Proxy ────────────────────────────────

/// Proxy data bidirectionally between a TCP stream and an SSH channel.
/// Used by both local and remote forwarding.
///
/// `bytes_in_counter` tracks data flowing from SSH channel → TCP socket (received).
/// `bytes_out_counter` tracks data flowing from TCP socket → SSH channel (sent).
async fn proxy_bidirectional(
    mut tcp_stream: TcpStream,
    mut channel: russh::Channel<Msg>,
    tunnel_id: TunnelId,
    bytes_in_counter: &AtomicU64,
    bytes_out_counter: &AtomicU64,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let mut buf = vec![0u8; 65536];
    let mut stream_closed = false;
    let mut channel_closed = false;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                tracing::debug!("Tunnel {tunnel_id}: proxy cancelled");
                let _ = channel.eof().await;
                break;
            }

            // Read from TCP socket → write to SSH channel (outbound)
            read_result = tcp_stream.read(&mut buf), if !stream_closed => {
                match read_result {
                    Ok(0) => {
                        // TCP socket closed
                        stream_closed = true;
                        let _ = channel.eof().await;
                        if channel_closed {
                            break;
                        }
                    }
                    Ok(n) => {
                        bytes_out_counter.fetch_add(n as u64, Ordering::Relaxed);
                        if let Err(e) = channel.data(&buf[..n]).await {
                            tracing::debug!("Tunnel {tunnel_id}: channel write error: {e}");
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::debug!("Tunnel {tunnel_id}: tcp read error: {e}");
                        let _ = channel.eof().await;
                        break;
                    }
                }
            }

            // Read from SSH channel → write to TCP socket (inbound)
            msg = channel.wait(), if !channel_closed => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        bytes_in_counter.fetch_add(data.len() as u64, Ordering::Relaxed);
                        if let Err(e) = tcp_stream.write_all(data).await {
                            tracing::debug!("Tunnel {tunnel_id}: tcp write error: {e}");
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        channel_closed = true;
                        let _ = tcp_stream.shutdown().await;
                        if stream_closed {
                            break;
                        }
                    }
                    Some(ChannelMsg::WindowAdjusted { .. }) => {
                        // Ignore flow control messages
                    }
                    Some(_) => {
                        // Ignore other channel messages
                    }
                    None => {
                        // Channel dropped
                        let _ = tcp_stream.shutdown().await;
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Stop a tunnel — cancels the token, which triggers cleanup.
pub fn stop_tunnel(handle: &mut TunnelHandle) {
    handle.cancel_token.cancel();
    handle.state = TunnelState::Stopped;
    if let Some(task) = handle.task.take() {
        task.abort();
    }
}

// ─── Remote Forward Registry ────────────────────────────
//
// Shared between tunnel.rs and handler.rs. The handler needs to look up
// which remote forward an incoming forwarded_tcpip channel belongs to.

/// Key for the remote forward registry — matches on address:port.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct RemoteForwardKey {
    pub address: String,
    pub port: u32,
}

/// Entry in the remote forward registry — contains all info needed
/// to handle incoming connections for a specific remote forward.
pub struct RemoteForwardEntry {
    pub tunnel_id: TunnelId,
    pub target_host: String,
    pub target_port: u16,
    pub active_connections: Arc<AtomicU32>,
    pub bytes_in: Arc<AtomicU64>,
    pub bytes_out: Arc<AtomicU64>,
    pub cancel_token: CancellationToken,
    pub on_event: TauriChannel<TunnelEvent>,
}

// Allow cloning for spawning into tasks
impl Clone for RemoteForwardEntry {
    fn clone(&self) -> Self {
        Self {
            tunnel_id: self.tunnel_id,
            target_host: self.target_host.clone(),
            target_port: self.target_port,
            active_connections: self.active_connections.clone(),
            bytes_in: self.bytes_in.clone(),
            bytes_out: self.bytes_out.clone(),
            cancel_token: self.cancel_token.clone(),
            on_event: self.on_event.clone(),
        }
    }
}

/// Type alias for the shared remote forward registry
pub type RemoteForwardRegistry =
    Arc<Mutex<HashMap<RemoteForwardKey, RemoteForwardEntry>>>;

/// Create a new empty remote forward registry
pub fn new_remote_forward_registry() -> RemoteForwardRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

// ─── Tunnel Info (serializable summary for frontend) ────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub config: TunnelConfig,
    pub state: TunnelState,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub active_connections: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TunnelType;

    #[test]
    fn remote_forward_key_equality() {
        let k1 = RemoteForwardKey {
            address: "0.0.0.0".to_string(),
            port: 8080,
        };
        let k2 = RemoteForwardKey {
            address: "0.0.0.0".to_string(),
            port: 8080,
        };
        assert_eq!(k1, k2);
    }

    #[test]
    fn remote_forward_key_inequality() {
        let k1 = RemoteForwardKey {
            address: "0.0.0.0".to_string(),
            port: 8080,
        };
        let k2 = RemoteForwardKey {
            address: "0.0.0.0".to_string(),
            port: 9090,
        };
        assert_ne!(k1, k2);
    }

    #[test]
    fn tunnel_info_serializes() {
        let info = TunnelInfo {
            config: TunnelConfig {
                id: uuid::Uuid::nil(),
                tunnel_type: TunnelType::Local,
                bind_host: "127.0.0.1".to_string(),
                bind_port: 8080,
                target_host: "remote.host".to_string(),
                target_port: 80,
                label: Some("test".to_string()),
            },
            state: TunnelState::Active { connections: 3 },
            bytes_in: 1024,
            bytes_out: 2048,
            active_connections: 3,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("127.0.0.1"));
        assert!(json.contains("\"connections\":3"));
    }

    #[test]
    fn tunnel_state_serialization() {
        let stopped = TunnelState::Stopped;
        let json = serde_json::to_string(&stopped).unwrap();
        assert_eq!(json, "\"stopped\"");

        let active = TunnelState::Active { connections: 5 };
        let json = serde_json::to_string(&active).unwrap();
        assert!(json.contains("connections"));

        let error = TunnelState::Error {
            message: "port in use".to_string(),
        };
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains("port in use"));
    }

    #[test]
    fn atomic_saturating_sub_normal_decrement() {
        let counter = AtomicU32::new(5);
        assert_eq!(atomic_saturating_sub(&counter, 1), 4);
        assert_eq!(counter.load(Ordering::Relaxed), 4);
        assert_eq!(atomic_saturating_sub(&counter, 1), 3);
        assert_eq!(counter.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn atomic_saturating_sub_at_zero_does_not_underflow() {
        let counter = AtomicU32::new(0);
        // This would wrap to u32::MAX with plain fetch_sub — must stay 0
        assert_eq!(atomic_saturating_sub(&counter, 1), 0);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
        // Repeated calls still stay at 0
        assert_eq!(atomic_saturating_sub(&counter, 1), 0);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn atomic_saturating_sub_decrement_to_zero() {
        let counter = AtomicU32::new(1);
        assert_eq!(atomic_saturating_sub(&counter, 1), 0);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
        // Next call saturates at 0
        assert_eq!(atomic_saturating_sub(&counter, 1), 0);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn atomic_saturating_sub_large_value() {
        let counter = AtomicU32::new(2);
        // Subtracting more than the current value saturates to 0
        assert_eq!(atomic_saturating_sub(&counter, 100), 0);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }
}
