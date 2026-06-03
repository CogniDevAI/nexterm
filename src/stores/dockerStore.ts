// stores/dockerStore.ts — In-memory Docker container state per session
//
// Holds container rows, docker availability, and loading state per sessionId.
// No persist middleware — container data is ephemeral (refreshed on panel open).
// Updated by the useDocker hook when docker_list_containers returns.

import { create } from "zustand";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single container row from `docker ps -a`. Mirrors the Rust ContainerRow. */
export interface ContainerRow {
  id: string;
  names: string;
  image: string;
  /** Container lifecycle state: "running", "exited", "paused", "created", etc. */
  state: string;
  /** Human-readable status string, e.g. "Up 2 hours". */
  status: string;
  ports: string;
}

/** Lifecycle action the user can trigger on a container. */
export type DockerAction = "start" | "stop" | "restart" | "rm";

// ─── Store ───────────────────────────────────────────────────────────────────

interface DockerStoreState {
  /** Container rows per sessionId. */
  containers: Map<string, ContainerRow[]>;
  /**
   * Docker availability per sessionId.
   * undefined = unknown (never fetched), true = available, false = unavailable.
   */
  availability: Map<string, boolean>;
  /** Whether a list/refresh is in flight for a session. */
  loading: Map<string, boolean>;

  /** Replace the container list for a session. */
  setContainers: (sessionId: string, rows: ContainerRow[]) => void;
  /** Mark docker as available (true) or unavailable (false) for a session. */
  setAvailability: (sessionId: string, available: boolean) => void;
  /** Set the loading state for a session. */
  setLoading: (sessionId: string, loading: boolean) => void;
  /** Remove all data for a session (on panel close or disconnect). */
  clearSession: (sessionId: string) => void;
}

export const useDockerStore = create<DockerStoreState>((set) => ({
  containers: new Map(),
  availability: new Map(),
  loading: new Map(),

  setContainers: (sessionId, rows) =>
    set((state) => {
      const next = new Map(state.containers);
      next.set(sessionId, rows);
      return { containers: next };
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
      const nextAvailability = new Map(state.availability);
      const nextLoading = new Map(state.loading);
      nextContainers.delete(sessionId);
      nextAvailability.delete(sessionId);
      nextLoading.delete(sessionId);
      return {
        containers: nextContainers,
        availability: nextAvailability,
        loading: nextLoading,
      };
    }),
}));
