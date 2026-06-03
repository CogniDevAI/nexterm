// stores/proxmoxStore.ts — In-memory Proxmox LXC container state per session
//
// Holds LXC rows, snapshot rows, pct availability, and loading state per sessionId.
// Snapshot rows are keyed by "sessionId:vmid" to support per-container snapshot views.
// No persist middleware — data is ephemeral (refreshed on panel open).
// Updated by the useProxmox hook when proxmox_list_lxc returns.

import { create } from "zustand";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single row from `pct list`. Mirrors the Rust LxcRow. */
export interface LxcRow {
  /** Container VMID (validated u32, 100–999999999). */
  vmid: number;
  /** Container status: "running", "stopped", etc. */
  status: string;
  /** Container hostname/name. */
  name: string;
}

/** A single snapshot row from `pct listsnapshot`. Mirrors the Rust SnapshotRow. */
export interface SnapshotRow {
  /** Snapshot name (validated). */
  name: string;
}

/** Lifecycle action for an LXC container. */
export type LxcAction = "start" | "stop" | "reboot";

// ─── Store ───────────────────────────────────────────────────────────────────

interface ProxmoxStoreState {
  /** LXC rows per sessionId. */
  containers: Map<string, LxcRow[]>;
  /**
   * Snapshot rows keyed by "sessionId:vmid".
   * Allows per-container snapshot state without collisions.
   */
  snapshots: Map<string, SnapshotRow[]>;
  /**
   * pct availability per sessionId.
   * undefined = unknown (never fetched), true = available, false = unavailable.
   */
  availability: Map<string, boolean>;
  /** Whether a list/refresh is in flight for a session. */
  loading: Map<string, boolean>;

  /** Replace the LXC list for a session. */
  setLxc: (sessionId: string, rows: LxcRow[]) => void;
  /** Replace snapshots for a specific (session, vmid) pair. */
  setSnapshots: (sessionId: string, vmid: number, rows: SnapshotRow[]) => void;
  /** Mark pct as available (true) or unavailable (false) for a session. */
  setAvailability: (sessionId: string, available: boolean) => void;
  /** Set the loading state for a session. */
  setLoading: (sessionId: string, loading: boolean) => void;
  /** Remove all data for a session (on panel close or disconnect). */
  clearSession: (sessionId: string) => void;
}

/** Snapshot map key for a (sessionId, vmid) pair. */
export function snapshotKey(sessionId: string, vmid: number): string {
  return `${sessionId}:${vmid}`;
}

export const useProxmoxStore = create<ProxmoxStoreState>((set) => ({
  containers: new Map(),
  snapshots: new Map(),
  availability: new Map(),
  loading: new Map(),

  setLxc: (sessionId, rows) =>
    set((state) => {
      const next = new Map(state.containers);
      next.set(sessionId, rows);
      return { containers: next };
    }),

  setSnapshots: (sessionId, vmid, rows) =>
    set((state) => {
      const next = new Map(state.snapshots);
      next.set(snapshotKey(sessionId, vmid), rows);
      return { snapshots: next };
    }),

  setAvailability: (sessionId, available) =>
    set((state) => {
      const next = new Map(state.availability);
      next.set(sessionId, available);
      return { availability: next };
    }),

  setLoading: (sessionId, loading) =>
    set((state) => {
      const next = new Map(state.loading);
      next.set(sessionId, loading);
      return { loading: next };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const nextContainers = new Map(state.containers);
      const nextSnapshots = new Map(state.snapshots);
      const nextAvailability = new Map(state.availability);
      const nextLoading = new Map(state.loading);

      nextContainers.delete(sessionId);
      nextAvailability.delete(sessionId);
      nextLoading.delete(sessionId);

      // Remove all snapshot entries for this session (keyed by "sessionId:vmid").
      for (const key of nextSnapshots.keys()) {
        if (key.startsWith(`${sessionId}:`)) {
          nextSnapshots.delete(key);
        }
      }

      return {
        containers: nextContainers,
        snapshots: nextSnapshots,
        availability: nextAvailability,
        loading: nextLoading,
      };
    }),
}));
