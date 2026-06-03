// stores/commandHistoryStore.ts — Persisted command history ring buffer
//
// Key: "nexterm-command-history"
// Pattern mirrors snippetStore.ts: persist + partialize + merge validator.
//
// SECURITY:
//   - captureEnabled defaults to FALSE (opt-in). History records NOTHING until
//     the user explicitly enables capture.
//   - Rationale: xterm onData captures ALL keystrokes including passwords typed
//     at no-echo prompts (sudo, ssh). There is no reliable JS-layer way to detect
//     no-echo state. Defaulting to OFF is the only safe choice.
//   - When captureEnabled is false, addCommand is a no-op.
//   - Provides clearAll() and per-entry deleteCommand() so users can remove
//     sensitive entries at any time.

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Ring buffer capacity — oldest entries are dropped when exceeded. */
const RING_CAP = 500;

export interface HistoryEntry {
  id: string;
  command: string;
  timestamp: number;
  sessionId: string;
  host: string;
}

interface CommandHistoryStoreState {
  entries: HistoryEntry[];
  /** Opt-in capture flag. Defaults to false — see SECURITY comment above. */
  captureEnabled: boolean;
  /** Whether the user has seen and dismissed the first-use privacy notice. */
  noticeAcknowledged: boolean;

  addCommand: (input: Pick<HistoryEntry, "command" | "sessionId" | "host">) => void;
  deleteCommand: (id: string) => void;
  clearAll: () => void;
  toggleCapture: () => void;
  dismissNotice: () => void;
}

function isValidEntry(e: unknown): e is HistoryEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.command === "string" &&
    o.command.length > 0 &&
    typeof o.timestamp === "number" &&
    typeof o.sessionId === "string" &&
    typeof o.host === "string"
  );
}

export const useCommandHistoryStore = create<CommandHistoryStoreState>()(
  persist(
    (set, get) => ({
      entries: [],
      captureEnabled: false, // SECURITY: opt-in, never on by default
      noticeAcknowledged: false,

      addCommand: ({ command, sessionId, host }) => {
        const { captureEnabled, entries } = get();
        // SECURITY: early return when capture is disabled
        if (!captureEnabled) return;

        // Dedupe consecutive identical commands on the same session
        const last = entries[entries.length - 1];
        if (last && last.command === command && last.sessionId === sessionId) {
          return;
        }

        const entry: HistoryEntry = {
          id: crypto.randomUUID(),
          command,
          timestamp: Date.now(),
          sessionId,
          host,
        };

        // Ring buffer: if at cap, drop the oldest (index 0)
        const next =
          entries.length >= RING_CAP
            ? [...entries.slice(1), entry]
            : [...entries, entry];

        set({ entries: next });
      },

      deleteCommand: (id) => {
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
        }));
      },

      clearAll: () => {
        set({ entries: [] });
      },

      toggleCapture: () => {
        set((state) => ({ captureEnabled: !state.captureEnabled }));
      },

      dismissNotice: () => {
        set({ noticeAcknowledged: true });
      },
    }),
    {
      name: "nexterm-command-history",
      partialize: (s) => ({
        entries: s.entries,
        captureEnabled: s.captureEnabled,
        noticeAcknowledged: s.noticeAcknowledged,
      }),
      // MAJOR-3 pattern from themeStore/snippetStore: validate rehydrated data.
      merge: (persisted, current) => {
        const p = persisted as
          | {
              entries?: unknown[];
              captureEnabled?: unknown;
              noticeAcknowledged?: unknown;
            }
          | null
          | undefined;

        const raw = Array.isArray(p?.entries) ? p.entries : [];
        const validEntries = raw.filter(isValidEntry);

        return {
          ...current,
          entries: validEntries,
          captureEnabled:
            typeof p?.captureEnabled === "boolean"
              ? p.captureEnabled
              : current.captureEnabled,
          noticeAcknowledged:
            typeof p?.noticeAcknowledged === "boolean"
              ? p.noticeAcknowledged
              : current.noticeAcknowledged,
        };
      },
    },
  ),
);
