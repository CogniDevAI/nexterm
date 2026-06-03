// stores/monitoringStore.ts — In-memory monitoring data store
//
// Holds a ring buffer of MetricSample per session (max 60 entries).
// No persist middleware — monitoring data is ephemeral.
// Updated by the useMonitoring hook when MetricEvent.Sample arrives.

import { create } from "zustand";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiskEntry {
  filesystem: string;
  usedPct: number;
  availableKb: number;
}

export interface MonitorProcessRow {
  pid: number;
  user: string;
  cpuPct: number;
  memPct: number;
  name: string;
}

export interface MetricSample {
  sessionId: string;
  cpuPct: number;
  memPct: number;
  diskEntries: DiskEntry[];
  netRxBps: number;
  netTxBps: number;
  processes: MonitorProcessRow[];
  /** Monotonic tick counter. tick=0 → first sample, delta fields are 0. */
  tick: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of samples to keep per session. */
export const RING_BUFFER_SIZE = 60;

// ─── Store ───────────────────────────────────────────────────────────────────

interface MonitoringStoreState {
  /** Ring buffer of MetricSample per sessionId. Max RING_BUFFER_SIZE entries. */
  samples: Map<string, MetricSample[]>;
  /** null = unknown, true = supported, false = unsupported (/proc absent). */
  isSupported: Map<string, boolean>;
  /** Whether the sampler is currently running for a session. */
  isRunning: Map<string, boolean>;

  /** Push a new sample into the ring buffer for its session. */
  addSample: (sample: MetricSample) => void;
  /** Mark a session as supported (first successful sample received). */
  setSupported: (sessionId: string) => void;
  /** Mark a session as unsupported (/proc absent). */
  setUnsupported: (sessionId: string) => void;
  /** Update the running state for a session. */
  setRunning: (sessionId: string, running: boolean) => void;
  /** Remove all data for a session (on panel close or disconnect). */
  clearSession: (sessionId: string) => void;
}

export const useMonitoringStore = create<MonitoringStoreState>((set) => ({
  samples: new Map(),
  isSupported: new Map(),
  isRunning: new Map(),

  addSample: (sample) =>
    set((state) => {
      const existing = state.samples.get(sample.sessionId) ?? [];
      const updated =
        existing.length >= RING_BUFFER_SIZE
          ? [...existing.slice(1), sample]
          : [...existing, sample];
      const newSamples = new Map(state.samples);
      newSamples.set(sample.sessionId, updated);
      return { samples: newSamples };
    }),

  setSupported: (sessionId) =>
    set((state) => {
      const next = new Map(state.isSupported);
      next.set(sessionId, true);
      return { isSupported: next };
    }),

  setUnsupported: (sessionId) =>
    set((state) => {
      const next = new Map(state.isSupported);
      next.set(sessionId, false);
      return { isSupported: next };
    }),

  setRunning: (sessionId, running) =>
    set((state) => {
      const next = new Map(state.isRunning);
      next.set(sessionId, running);
      return { isRunning: next };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const newSamples = new Map(state.samples);
      const newSupported = new Map(state.isSupported);
      const newRunning = new Map(state.isRunning);
      newSamples.delete(sessionId);
      newSupported.delete(sessionId);
      newRunning.delete(sessionId);
      return {
        samples: newSamples,
        isSupported: newSupported,
        isRunning: newRunning,
      };
    }),
}));
