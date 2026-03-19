// ssh/handler.rs — russh client::Handler implementation
//
// SshClientHandler implements the russh Handler trait to handle
// server key verification, channel lifecycle, and data routing.
//
// Host key verification bridges to the frontend via a oneshot channel:
// 1. Handler sends HostKeyVerificationRequest to the command layer
// 2. Handler blocks (awaits) on a oneshot::Receiver for user response
// 3. Frontend shows dialog, user responds
// 4. Command sends response on the oneshot::Sender

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use russh::client::Handler;
use russh::client::Msg;
use russh::keys::ssh_key::PublicKey;
use russh::client::DisconnectReason;
use russh::{Channel, ChannelId};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::ssh::known_hosts;
use crate::ssh::tunnel::{
    handle_remote_forward_connection, RemoteForwardKey, RemoteForwardRegistry,
    new_remote_forward_registry,
};
use crate::state::{HostKeyStatus, HostKeyVerificationRequest, HostKeyVerificationResponse};

/// Bridge type for host key verification flow
/// The handler sends the request and awaits the response
pub struct HostKeyVerificationBridge {
    /// Sender for the verification request (handler → command layer)
    pub request_tx: Option<oneshot::Sender<HostKeyVerificationRequest>>,
    /// Receiver for the user's response (command layer → handler)
    pub response_rx: Option<oneshot::Receiver<HostKeyVerificationResponse>>,
}

/// Channel data sender — routes incoming SSH channel data to consumers
pub type ChannelDataSender = mpsc::Sender<Vec<u8>>;

/// SSH client event handler for russh
pub struct SshClientHandler {
    /// Host and port for known_hosts lookup
    pub host: String,
    pub port: u16,

    /// Bridge for host key verification dialog with frontend
    pub host_key_bridge: HostKeyVerificationBridge,

    /// Per-channel data senders — routes incoming data to terminal/sftp consumers
    pub channel_senders: Arc<Mutex<HashMap<ChannelId, ChannelDataSender>>>,

    /// The last host key status observed (for the command layer to inspect)
    pub last_host_key_status: Option<HostKeyStatus>,

    /// Registry for remote port forwards — maps (address, port) to tunnel info.
    /// When the server opens a forwarded-tcpip channel, the handler looks up
    /// the target host:port and event channel from this registry.
    pub remote_forward_registry: RemoteForwardRegistry,

    /// Oneshot sender to notify the command layer when the server disconnects.
    /// Fires from `disconnected()` with a reason string so the command layer
    /// can update session state and notify the frontend.
    pub disconnect_tx: Option<oneshot::Sender<String>>,
}

impl SshClientHandler {
    /// Create a new handler with host key verification bridge
    ///
    /// Returns (handler, request_rx, response_tx, remote_forward_registry, disconnect_rx) so the command layer can:
    /// - Receive the HostKeyVerificationRequest via request_rx
    /// - Send the user's response via response_tx
    /// - Access the remote_forward_registry for tunnel management
    /// - Watch for server-initiated disconnects via disconnect_rx
    pub fn new(
        host: String,
        port: u16,
    ) -> (
        Self,
        oneshot::Receiver<HostKeyVerificationRequest>,
        oneshot::Sender<HostKeyVerificationResponse>,
        RemoteForwardRegistry,
        oneshot::Receiver<String>,
    ) {
        let (request_tx, request_rx) = oneshot::channel();
        let (response_tx, response_rx) = oneshot::channel();
        let (disconnect_tx, disconnect_rx) = oneshot::channel();
        let registry = new_remote_forward_registry();

        let handler = Self {
            host,
            port,
            host_key_bridge: HostKeyVerificationBridge {
                request_tx: Some(request_tx),
                response_rx: Some(response_rx),
            },
            channel_senders: Arc::new(Mutex::new(HashMap::new())),
            last_host_key_status: None,
            remote_forward_registry: registry.clone(),
            disconnect_tx: Some(disconnect_tx),
        };

        (handler, request_rx, response_tx, registry, disconnect_rx)
    }

    /// Register a data sender for a channel
    pub async fn register_channel_sender(
        &self,
        channel_id: ChannelId,
        sender: ChannelDataSender,
    ) {
        let mut senders = self.channel_senders.lock().await;
        senders.insert(channel_id, sender);
    }

    /// Remove a data sender when a channel closes
    pub async fn remove_channel_sender(&self, channel_id: ChannelId) {
        let mut senders = self.channel_senders.lock().await;
        senders.remove(&channel_id);
    }

    /// Get a reference to the remote forward registry (for tunnel.rs to register entries)
    pub fn remote_forward_registry(&self) -> RemoteForwardRegistry {
        self.remote_forward_registry.clone()
    }
}

#[async_trait]
impl Handler for SshClientHandler {
    type Error = russh::Error;

    /// Called during the SSH handshake to verify the server's host key.
    /// Delegates to known_hosts for verification. If Unknown or Changed,
    /// bridges to the frontend for user decision.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let status =
            known_hosts::verify_host_key(&self.host, self.port, server_public_key)
                .map_err(|e| {
                    russh::Error::Keys(russh::keys::Error::from(
                        std::io::Error::other(e.to_string()),
                    ))
                })?;

        match &status {
            HostKeyStatus::Trusted => {
                self.last_host_key_status = Some(status);
                return Ok(true);
            }
            HostKeyStatus::Revoked => {
                self.last_host_key_status = Some(status);
                return Ok(false);
            }
            HostKeyStatus::Unknown { .. } | HostKeyStatus::Changed { .. } => {
                // Need user confirmation — bridge to frontend
                self.last_host_key_status = Some(status.clone());

                // Send the verification request
                let request = HostKeyVerificationRequest {
                    host: self.host.clone(),
                    port: self.port,
                    status: status.clone(),
                    session_id: None, // Injected by the connect command before forwarding
                };

                if let Some(tx) = self.host_key_bridge.request_tx.take() {
                    let _ = tx.send(request);
                } else {
                    // No bridge available — reject
                    tracing::warn!("Host key verification bridge unavailable, rejecting");
                    return Ok(false);
                }

                // Wait for user response
                if let Some(rx) = self.host_key_bridge.response_rx.take() {
                    match rx.await {
                        Ok(HostKeyVerificationResponse::Accept) => {
                            // Trust once — don't save
                            return Ok(true);
                        }
                        Ok(HostKeyVerificationResponse::AcceptAndSave) => {
                            // Save to known_hosts
                            match &status {
                                HostKeyStatus::Unknown { .. } => {
                                    if let Err(e) = known_hosts::add_host_key(
                                        &self.host,
                                        self.port,
                                        server_public_key,
                                    ) {
                                        tracing::error!("Failed to save host key: {e}");
                                    }
                                }
                                HostKeyStatus::Changed { .. } => {
                                    if let Err(e) = known_hosts::update_host_key(
                                        &self.host,
                                        self.port,
                                        server_public_key,
                                    ) {
                                        tracing::error!("Failed to update host key: {e}");
                                    }
                                }
                                _ => {}
                            }
                            return Ok(true);
                        }
                        Ok(HostKeyVerificationResponse::Reject) => {
                            return Ok(false);
                        }
                        Err(_) => {
                            // Channel dropped — treat as rejection
                            tracing::warn!(
                                "Host key verification response channel dropped, rejecting"
                            );
                            return Ok(false);
                        }
                    }
                } else {
                    return Ok(false);
                }
            }
        }
    }

    /// Called when the server opens a channel for a remote port forwarding connection.
    /// This is the callback for -R style tunnels: the server accepted a connection
    /// on the remote port and is forwarding it to us.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        tracing::debug!(
            "Received forwarded-tcpip channel: {connected_address}:{connected_port} from {originator_address}:{originator_port}"
        );

        // Look up which remote forward this belongs to
        let key = RemoteForwardKey {
            address: connected_address.to_string(),
            port: connected_port,
        };

        let entry = {
            let reg = self.remote_forward_registry.lock().await;
            reg.get(&key).cloned()
        };

        match entry {
            Some(entry) => {
                // Spawn a task to handle the connection
                let orig_addr = originator_address.to_string();
                tokio::spawn(async move {
                    handle_remote_forward_connection(
                        channel,
                        entry,
                        orig_addr,
                        originator_port,
                    )
                    .await;
                });
                Ok(())
            }
            None => {
                tracing::warn!(
                    "No remote forward registered for {connected_address}:{connected_port}, ignoring"
                );
                // Close the channel — we don't know what to do with it
                let _ = channel.eof().await;
                Ok(())
            }
        }
    }

    /// Called when the server sends a disconnect message.
    /// Notifies the command layer via the disconnect channel so it can
    /// update session state and inform the frontend.
    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let reason_str = format!("{:?}", reason);
        tracing::info!("SSH disconnected: {reason_str}");

        // Notify the command layer about the disconnect
        if let Some(tx) = self.disconnect_tx.take() {
            let _ = tx.send(reason_str);
        }

        // Clean up all channel senders
        let mut senders = self.channel_senders.lock().await;
        senders.clear();
        // Clean up remote forward registry
        let mut reg = self.remote_forward_registry.lock().await;
        reg.clear();
        Ok(())
    }
}
