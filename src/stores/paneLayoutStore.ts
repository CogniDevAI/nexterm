// stores/paneLayoutStore.ts — Ephemeral pane layout store
//
// Manages the split-pane layout for each session.
// NOT persisted in v1 — ephemeral per-session state.
// Clean-room design: own model, no external tree/layout primitives.

import { create } from "zustand";
import type { SessionId, TerminalId } from "../lib/types";

// ── Public types ──────────────────────────────────────────────────────────────

export type PaneDirection = "horizontal" | "vertical";

/** Hard cap on live pane count per session. Each pane hosts a live xterm + WebGL context. */
export const MAX_PANE_COUNT = 4;

export interface PaneSlot {
  /** Stable UUID used as React key — never changes, even when terminalId changes. */
  id: string;
  /** Null = pending (terminal not yet opened). Mirrors the TerminalTab pending pattern. */
  terminalId: TerminalId | null;
  /** Fraction of total space. All slots in a layout must sum to ~1. */
  ratio: number;
}

export interface PaneLayout {
  /** Direction all panes split in. Uniform in v1 (no per-pane direction). */
  direction: PaneDirection;
  /** Ordered list of pane slots. */
  slots: PaneSlot[];
  /** Which slot currently holds keyboard focus. Drives the focus ring and
   *  the sessionStore.activeTerminalId pointer for SidePanel/HistoryPanel. */
  focusedSlotId: string;
}

// ── Internal state ────────────────────────────────────────────────────────────

type PaneLayoutMap = Record<SessionId, PaneLayout>;

interface PaneLayoutStoreState {
  layouts: PaneLayoutMap;

  /** Create a layout with a single slot for `sessionId`.
   *  No-op if a layout already exists for this session (idempotent). */
  openLayout: (sessionId: SessionId, terminalId: TerminalId) => void;

  /** Insert a new empty slot immediately after `afterSlotId`.
   *  Redistributes all ratios equally. Capped at MAX_PANE_COUNT. */
  splitSlot: (sessionId: SessionId, afterSlotId: string) => void;

  /** Remove a slot. Redistributes ratios equally. Refuses to remove the last slot. */
  closeSlot: (sessionId: SessionId, slotId: string) => void;

  /** Set the raw ratio for a slot. Clamped to [0, 1]. */
  setRatio: (sessionId: SessionId, slotId: string, ratio: number) => void;

  /** Assign a real terminalId to a slot (replaces null for pending slots). */
  assignTerminal: (sessionId: SessionId, slotId: string, terminalId: TerminalId) => void;

  /** Mark a slot as focused (updates focusedSlotId).
   *  Callers are responsible for also calling sessionStore.setActiveTerminal. */
  focusSlot: (sessionId: SessionId, slotId: string) => void;

  /** Set the split direction for the whole layout. */
  setDirection: (sessionId: SessionId, direction: PaneDirection) => void;

  /** Remove the entire layout entry (called on session close). */
  removeLayout: (sessionId: SessionId) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function equalRatios(count: number): number[] {
  const ratio = 1 / count;
  return Array.from({ length: count }, () => ratio);
}

function redistributeRatios(slots: PaneSlot[]): PaneSlot[] {
  const ratios = equalRatios(slots.length);
  return slots.map((s, i) => ({ ...s, ratio: ratios[i] }));
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const usePaneLayoutStore = create<PaneLayoutStoreState>((set, get) => ({
  layouts: {},

  openLayout: (sessionId, terminalId) => {
    if (get().layouts[sessionId]) return; // idempotent
    const slotId = crypto.randomUUID();
    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: {
          direction: "horizontal",
          slots: [{ id: slotId, terminalId, ratio: 1 }],
          focusedSlotId: slotId,
        },
      },
    }));
  },

  splitSlot: (sessionId, afterSlotId) => {
    const layout = get().layouts[sessionId];
    if (!layout) return;
    if (layout.slots.length >= MAX_PANE_COUNT) return;

    const insertIdx = layout.slots.findIndex((s) => s.id === afterSlotId);
    if (insertIdx === -1) return;

    const newSlot: PaneSlot = {
      id: crypto.randomUUID(),
      terminalId: null,
      ratio: 0, // will be redistributed
    };

    const next = [
      ...layout.slots.slice(0, insertIdx + 1),
      newSlot,
      ...layout.slots.slice(insertIdx + 1),
    ];

    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: {
          ...layout,
          slots: redistributeRatios(next),
        },
      },
    }));
  },

  closeSlot: (sessionId, slotId) => {
    const layout = get().layouts[sessionId];
    if (!layout) return;
    if (layout.slots.length <= 1) return; // never remove the last slot

    const next = layout.slots.filter((s) => s.id !== slotId);
    const focusedSlotId =
      layout.focusedSlotId === slotId
        ? (next[Math.max(0, layout.slots.findIndex((s) => s.id === slotId) - 1)]?.id ?? next[0].id)
        : layout.focusedSlotId;

    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: {
          ...layout,
          slots: redistributeRatios(next),
          focusedSlotId,
        },
      },
    }));
  },

  setRatio: (sessionId, slotId, ratio) => {
    const layout = get().layouts[sessionId];
    if (!layout) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: {
          ...layout,
          slots: layout.slots.map((s) =>
            s.id === slotId ? { ...s, ratio: clamped } : s,
          ),
        },
      },
    }));
  },

  assignTerminal: (sessionId, slotId, terminalId) => {
    const layout = get().layouts[sessionId];
    if (!layout) return;
    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: {
          ...layout,
          slots: layout.slots.map((s) =>
            s.id === slotId ? { ...s, terminalId } : s,
          ),
        },
      },
    }));
  },

  focusSlot: (sessionId, slotId) => {
    const layout = get().layouts[sessionId];
    if (!layout) return;
    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: { ...layout, focusedSlotId: slotId },
      },
    }));
  },

  setDirection: (sessionId, direction) => {
    const layout = get().layouts[sessionId];
    if (!layout) return;
    set((state) => ({
      layouts: {
        ...state.layouts,
        [sessionId]: { ...layout, direction },
      },
    }));
  },

  removeLayout: (sessionId) => {
    set((state) => {
      const next = { ...state.layouts };
      delete next[sessionId];
      return { layouts: next };
    });
  },
}));
