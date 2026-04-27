// stores/sessionStore.ts — Zustand store for active SSH sessions
//
// Manages connection state, active sessions, terminal tabs per session.

import { create } from "zustand";
import type {
  ActiveFeature,
  SessionId,
  SessionState,
  TerminalId,
} from "../lib/types";
import {
  buildWorkspaceKey,
  useWorkspaceStore,
} from "./workspaceStore";

export interface TerminalTab {
  id: TerminalId;
  label: string;
  sessionId: SessionId;
  /** Stable key for React rendering — never changes after creation.
   *  The `id` field may change (pending → real UUID), but this key stays constant
   *  to prevent React from unmounting/remounting the TerminalView DOM. */
  reactKey: string;
}

export interface SessionEntry {
  id: SessionId;
  profileId: string;
  profileName: string;
  host: string;
  userId: string;
  username: string;
  port: number;
  connectedAt: number; // Date.now() timestamp
  state: SessionState;
  terminals: TerminalTab[];
  activeTerminalId: TerminalId | null;
}

interface SessionStoreState {
  sessions: Map<string, SessionEntry>;
  activeSessionId: string | null;
  activeFeature: ActiveFeature;

  addSession: (session: SessionEntry) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  setActiveFeature: (feature: ActiveFeature) => void;
  updateSessionState: (sessionId: string, state: SessionState) => void;

  // Terminal tab management
  addTerminalTab: (sessionId: string, tab: TerminalTab) => void;
  removeTerminalTab: (sessionId: string, terminalId: string) => void;
  replaceTerminalTab: (sessionId: string, oldId: string, newTab: TerminalTab) => void;
  setActiveTerminal: (sessionId: string, terminalId: string | null) => void;
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  sessions: new Map(),
  activeSessionId: null,
  activeFeature: "terminal",

  addSession: (session) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(session.id, session);
      const workspaceStore = useWorkspaceStore.getState();
      const workspace = workspaceStore.getOrCreateWorkspace(
        session.profileId,
        session.userId,
      );
      return {
        sessions: next,
        activeSessionId: session.id,
        activeFeature: workspace.activeFeature,
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(sessionId);
      const activeSessionId =
        state.activeSessionId === sessionId
          ? (next.keys().next().value ?? null)
          : state.activeSessionId;

      const nextActiveSession = activeSessionId
        ? next.get(activeSessionId)
        : undefined;
      const activeFeature = nextActiveSession
        ? useWorkspaceStore
            .getState()
            .getOrCreateWorkspace(
              nextActiveSession.profileId,
              nextActiveSession.userId,
            ).activeFeature
        : state.activeFeature;

      return { sessions: next, activeSessionId, activeFeature };
    }),

  setActiveSession: (sessionId) =>
    set((state) => {
      if (!sessionId) {
        return { activeSessionId: null };
      }

      const entry = state.sessions.get(sessionId);
      if (!entry) {
        return { activeSessionId: sessionId };
      }

      const workspace = useWorkspaceStore
        .getState()
        .getOrCreateWorkspace(entry.profileId, entry.userId);

      const restoredTerminalId = workspace.activeTerminalId;
      const next = new Map(state.sessions);
      if (
        restoredTerminalId &&
        restoredTerminalId !== entry.activeTerminalId &&
        entry.terminals.some((terminal) => terminal.id === restoredTerminalId)
      ) {
        next.set(sessionId, {
          ...entry,
          activeTerminalId: restoredTerminalId,
        });
      }

      return {
        sessions: next,
        activeSessionId: sessionId,
        activeFeature: workspace.activeFeature,
      };
    }),

  setActiveFeature: (feature) =>
    set((state) => {
      const activeSession = state.activeSessionId
        ? state.sessions.get(state.activeSessionId)
        : undefined;
      if (activeSession) {
        useWorkspaceStore.getState().setActiveFeature(
          buildWorkspaceKey(activeSession.profileId, activeSession.userId),
          feature,
        );
      }
      return { activeFeature: feature };
    }),

  updateSessionState: (sessionId, newState) =>
    set((state) => {
      const entry = state.sessions.get(sessionId);
      if (!entry) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...entry, state: newState });
      return { sessions: next };
    }),

  addTerminalTab: (sessionId, tab) =>
    set((state) => {
      const entry = state.sessions.get(sessionId);
      if (!entry) return state;
      const next = new Map(state.sessions);
      const activeTerminalId = tab.id;
      next.set(sessionId, {
        ...entry,
        terminals: [...entry.terminals, tab],
        activeTerminalId,
      });
      useWorkspaceStore.getState().setActiveTerminalId(
        buildWorkspaceKey(entry.profileId, entry.userId),
        activeTerminalId,
      );
      return { sessions: next };
    }),

  // M3 fix: Atomic tab replacement — swaps oldId with newTab in a single state update
  // to avoid the visual flash caused by remove+add as two separate updates.
  replaceTerminalTab: (sessionId, oldId, newTab) =>
    set((state) => {
      const entry = state.sessions.get(sessionId);
      if (!entry) return state;
      const next = new Map(state.sessions);
      const terminals = entry.terminals.map((t) =>
        t.id === oldId ? newTab : t,
      );
      const activeTerminalId =
        entry.activeTerminalId === oldId ? newTab.id : entry.activeTerminalId;
      next.set(sessionId, { ...entry, terminals, activeTerminalId });
      useWorkspaceStore.getState().setActiveTerminalId(
        buildWorkspaceKey(entry.profileId, entry.userId),
        activeTerminalId,
      );
      return { sessions: next };
    }),

  removeTerminalTab: (sessionId, terminalId) =>
    set((state) => {
      const entry = state.sessions.get(sessionId);
      if (!entry) return state;
      const next = new Map(state.sessions);
      const terminals = entry.terminals.filter((t) => t.id !== terminalId);
      const activeTerminalId =
        entry.activeTerminalId === terminalId
          ? (terminals[terminals.length - 1]?.id ?? null)
          : entry.activeTerminalId;
      next.set(sessionId, { ...entry, terminals, activeTerminalId });
      useWorkspaceStore.getState().setActiveTerminalId(
        buildWorkspaceKey(entry.profileId, entry.userId),
        activeTerminalId,
      );
      return { sessions: next };
    }),

  setActiveTerminal: (sessionId, terminalId) =>
    set((state) => {
      const entry = state.sessions.get(sessionId);
      if (!entry) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...entry, activeTerminalId: terminalId });
      useWorkspaceStore.getState().setActiveTerminalId(
        buildWorkspaceKey(entry.profileId, entry.userId),
        terminalId,
      );
      return { sessions: next };
    }),
}));
