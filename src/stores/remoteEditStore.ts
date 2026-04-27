// stores/remoteEditStore.ts — In-memory coordination for remote external edits

import { create } from "zustand";

export interface RemoteEditSession {
  id: string;
  sessionId: string;
  remotePath: string;
  localPath: string;
  fileName: string;
  dirty: boolean;
  syncing: boolean;
  lastKnownMtime: number | null;
}

interface RemoteEditStoreState {
  sessions: Record<string, RemoteEditSession>;
  promptSessionId: string | null;
  closingRequested: boolean;
  upsertSession: (session: RemoteEditSession) => void;
  removeSession: (id: string) => void;
  markDirty: (id: string) => void;
  markSyncing: (id: string, syncing: boolean) => void;
  markSynced: (id: string, mtime: number | null) => void;
  updateMtime: (id: string, mtime: number | null) => void;
  setPromptSessionId: (id: string | null) => void;
  requestCloseProtection: () => void;
  clearCloseProtection: () => void;
}

export function buildRemoteEditId(sessionId: string, remotePath: string) {
  return `${sessionId}:${remotePath}`;
}

export const useRemoteEditStore = create<RemoteEditStoreState>((set) => ({
  sessions: {},
  promptSessionId: null,
  closingRequested: false,

  upsertSession: (session) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [session.id]: session,
      },
    })),

  removeSession: (id) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[id];
      return {
        sessions: next,
        promptSessionId:
          state.promptSessionId === id ? null : state.promptSessionId,
      };
    }),

  markDirty: (id) =>
    set((state) => {
      const current = state.sessions[id];
      if (!current || current.dirty) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: {
            ...current,
            dirty: true,
          },
        },
        promptSessionId: state.promptSessionId ?? id,
      };
    }),

  markSyncing: (id, syncing) =>
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: {
            ...current,
            syncing,
          },
        },
      };
    }),

  markSynced: (id, mtime) =>
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: {
            ...current,
            dirty: false,
            syncing: false,
            lastKnownMtime: mtime,
          },
        },
      };
    }),

  updateMtime: (id, mtime) =>
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: {
            ...current,
            lastKnownMtime: mtime,
          },
        },
      };
    }),

  setPromptSessionId: (id) => set({ promptSessionId: id }),

  requestCloseProtection: () => set({ closingRequested: true }),

  clearCloseProtection: () => set({ closingRequested: false }),
}));
