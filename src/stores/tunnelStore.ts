// stores/tunnelStore.ts — Zustand store for SSH tunnel state
//
// Tracks tunnels per session as Map<sessionId, Map<tunnelId, TunnelInfo>>.
// Updated by useTunnel hook via TunnelEvent streaming.
// Keyed by sessionId so clearing one session's tunnels doesn't affect others.

import { create } from "zustand";
import type { SessionId, TunnelId, TunnelInfo, TunnelState } from "../lib/types";

interface TunnelStoreState {
  /** All tunnels keyed by sessionId -> tunnelId -> TunnelInfo */
  tunnels: Map<string, Map<string, TunnelInfo>>;

  /** Set all tunnels for a specific session (e.g., from list_tunnels response) */
  setTunnels: (sessionId: SessionId, tunnels: TunnelInfo[]) => void;

  /** Add a single tunnel to a specific session */
  addTunnel: (sessionId: SessionId, tunnel: TunnelInfo) => void;

  /** Update tunnel state within a session */
  updateTunnelState: (sessionId: SessionId, tunnelId: TunnelId, state: TunnelState) => void;

  /** Update tunnel traffic counters within a session */
  updateTunnelTraffic: (sessionId: SessionId, tunnelId: TunnelId, bytesIn: number, bytesOut: number) => void;

  /** Remove a tunnel from a specific session */
  removeTunnel: (sessionId: SessionId, tunnelId: TunnelId) => void;

  /** Clear tunnels for a specific session only (e.g., on session disconnect) */
  clearTunnels: (sessionId: SessionId) => void;

  /** Get tunnels as array for a specific session */
  tunnelList: (sessionId: SessionId) => TunnelInfo[];

  /** Count active tunnels for a specific session */
  activeCount: (sessionId: SessionId) => number;
}

export const useTunnelStore = create<TunnelStoreState>((set, get) => ({
  tunnels: new Map(),

  setTunnels: (sessionId, tunnels) =>
    set((state) => {
      const outer = new Map(state.tunnels);
      const inner = new Map<string, TunnelInfo>();
      for (const t of tunnels) {
        inner.set(t.config.id, t);
      }
      outer.set(sessionId, inner);
      return { tunnels: outer };
    }),

  addTunnel: (sessionId, tunnel) =>
    set((state) => {
      const outer = new Map(state.tunnels);
      const inner = new Map(outer.get(sessionId) ?? new Map<string, TunnelInfo>());
      inner.set(tunnel.config.id, tunnel);
      outer.set(sessionId, inner);
      return { tunnels: outer };
    }),

  updateTunnelState: (sessionId, tunnelId, newState) =>
    set((state) => {
      const sessionTunnels = state.tunnels.get(sessionId);
      if (!sessionTunnels) return state;
      const existing = sessionTunnels.get(tunnelId);
      if (!existing) return state;
      const outer = new Map(state.tunnels);
      const inner = new Map(sessionTunnels);
      inner.set(tunnelId, { ...existing, state: newState });
      outer.set(sessionId, inner);
      return { tunnels: outer };
    }),

  updateTunnelTraffic: (sessionId, tunnelId, bytesIn, bytesOut) =>
    set((state) => {
      const sessionTunnels = state.tunnels.get(sessionId);
      if (!sessionTunnels) return state;
      const existing = sessionTunnels.get(tunnelId);
      if (!existing) return state;
      const outer = new Map(state.tunnels);
      const inner = new Map(sessionTunnels);
      inner.set(tunnelId, { ...existing, bytesIn, bytesOut });
      outer.set(sessionId, inner);
      return { tunnels: outer };
    }),

  removeTunnel: (sessionId, tunnelId) =>
    set((state) => {
      const sessionTunnels = state.tunnels.get(sessionId);
      if (!sessionTunnels) return state;
      const outer = new Map(state.tunnels);
      const inner = new Map(sessionTunnels);
      inner.delete(tunnelId);
      outer.set(sessionId, inner);
      return { tunnels: outer };
    }),

  clearTunnels: (sessionId) =>
    set((state) => {
      if (!state.tunnels.has(sessionId)) return state;
      const outer = new Map(state.tunnels);
      outer.delete(sessionId);
      return { tunnels: outer };
    }),

  tunnelList: (sessionId) => {
    const sessionTunnels = get().tunnels.get(sessionId);
    return sessionTunnels ? Array.from(sessionTunnels.values()) : [];
  },

  activeCount: (sessionId) => {
    const sessionTunnels = get().tunnels.get(sessionId);
    if (!sessionTunnels) return 0;
    let count = 0;
    for (const t of sessionTunnels.values()) {
      if (typeof t.state === "object" && "active" in t.state) count++;
    }
    return count;
  },
}));
