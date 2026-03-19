// features/tunnel/useTunnel.ts — Tunnel management hook
//
// Wraps Tauri tunnel commands. Creates Channel for TunnelEvent streaming.
// Pattern follows useConnection.ts (Channel for events, tauriInvoke for commands).
// All store operations are scoped by sessionId to avoid cross-session interference.

import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import { useTunnelStore } from "../../stores/tunnelStore";
import type {
  SessionId,
  TunnelId,
  TunnelConfig,
  TunnelInfo,
  TunnelEvent,
} from "../../lib/types";

interface UseTunnelReturn {
  tunnels: TunnelInfo[];
  loading: boolean;
  error: string | null;
  createTunnel: (config: Omit<TunnelConfig, "id">) => Promise<void>;
  startTunnel: (tunnelId: TunnelId) => Promise<void>;
  stopTunnel: (tunnelId: TunnelId) => Promise<void>;
  removeTunnel: (tunnelId: TunnelId) => Promise<void>;
  refreshTunnels: () => Promise<void>;
}

export function useTunnel(sessionId: SessionId): UseTunnelReturn {
  const {
    tunnelList,
    setTunnels,
    addTunnel,
    updateTunnelState,
    updateTunnelTraffic,
    removeTunnel: removeTunnelFromStore,
    clearTunnels,
  } = useTunnelStore();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a ref to the event channel so we can reuse it across tunnel operations
  const channelRef = useRef<Channel<TunnelEvent> | null>(null);

  // Create a shared channel for tunnel events — scoped to this sessionId
  const getChannel = useCallback(() => {
    if (!channelRef.current) {
      const channel = new Channel<TunnelEvent>();
      channel.onmessage = (message) => {
        switch (message.event) {
          case "stateChanged":
            updateTunnelState(sessionId, message.data.tunnelId, message.data.state);
            break;
          case "traffic":
            updateTunnelTraffic(
              sessionId,
              message.data.tunnelId,
              message.data.bytesIn,
              message.data.bytesOut,
            );
            break;
        }
      };
      channelRef.current = channel;
    }
    return channelRef.current;
  }, [sessionId, updateTunnelState, updateTunnelTraffic]);

  // M11 fix: Declare refreshTunnels BEFORE the effect that uses it,
  // and include it in the effect dependency array.
  const refreshTunnels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tunnels = await tauriInvoke<TunnelInfo[]>("list_tunnels", {
        sessionId,
      });
      setTunnels(sessionId, tunnels);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, setTunnels]);

  // Load tunnels on mount
  useEffect(() => {
    void refreshTunnels();
    return () => {
      clearTunnels(sessionId);
      channelRef.current = null;
    };
  }, [sessionId, refreshTunnels, clearTunnels]);

  const createTunnel = useCallback(
    async (config: Omit<TunnelConfig, "id">) => {
      setError(null);
      try {
        const channel = getChannel();
        const tunnelId = await tauriInvoke<TunnelId>("create_tunnel", {
          sessionId,
          config,
          onEvent: channel,
        });

        // Add to store with initial stopped state — scoped to this session
        addTunnel(sessionId, {
          config: { ...config, id: tunnelId } as TunnelConfig,
          state: "stopped",
          bytesIn: 0,
          bytesOut: 0,
          activeConnections: 0,
        });
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [sessionId, getChannel, addTunnel],
  );

  const startTunnel = useCallback(
    async (tunnelId: TunnelId) => {
      setError(null);
      try {
        const channel = getChannel();
        await tauriInvoke<void>("start_tunnel", {
          sessionId,
          tunnelId,
          onEvent: channel,
        });
        // State update will come via TunnelEvent channel
      } catch (err) {
        setError(String(err));
      }
    },
    [sessionId, getChannel],
  );

  const stopTunnel = useCallback(
    async (tunnelId: TunnelId) => {
      setError(null);
      try {
        await tauriInvoke<void>("stop_tunnel", {
          sessionId,
          tunnelId,
        });
        // State update will come via TunnelEvent channel
      } catch (err) {
        setError(String(err));
      }
    },
    [sessionId],
  );

  const removeTunnel = useCallback(
    async (tunnelId: TunnelId) => {
      setError(null);
      try {
        await tauriInvoke<void>("remove_tunnel", {
          sessionId,
          tunnelId,
        });
        removeTunnelFromStore(sessionId, tunnelId);
      } catch (err) {
        setError(String(err));
      }
    },
    [sessionId, removeTunnelFromStore],
  );

  return {
    tunnels: tunnelList(sessionId),
    loading,
    error,
    createTunnel,
    startTunnel,
    stopTunnel,
    removeTunnel,
    refreshTunnels,
  };
}
