// stores/workspaceStore.ts — Persistent workspace snapshots per profile/user

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SearchMode } from "../features/sftp/FilePane";
import type { ActiveFeature, TerminalId } from "../lib/types";

export interface WorkspacePaneSnapshot {
  path: string;
  history: string[];
  historyIndex: number;
}

export interface WorkspaceSftpSnapshot {
  local: WorkspacePaneSnapshot;
  remote: WorkspacePaneSnapshot;
  splitPosition: number;
  searchMode: SearchMode;
  searchQuery: string;
}

export interface WorkspaceSnapshot {
  key: string;
  profileId: string;
  userId: string;
  activeFeature: ActiveFeature;
  activeTerminalId: TerminalId | null;
  sftp: WorkspaceSftpSnapshot;
  updatedAt: number;
}

interface WorkspaceStoreState {
  workspaces: Record<string, WorkspaceSnapshot>;
  getOrCreateWorkspace: (profileId: string, userId: string) => WorkspaceSnapshot;
  setActiveFeature: (workspaceKey: string, feature: ActiveFeature) => void;
  setActiveTerminalId: (
    workspaceKey: string,
    terminalId: TerminalId | null,
  ) => void;
  setSftpSnapshot: (
    workspaceKey: string,
    snapshot: Partial<WorkspaceSftpSnapshot>,
  ) => void;
}

const DEFAULT_PANE_SNAPSHOT: WorkspacePaneSnapshot = {
  path: "",
  history: [],
  historyIndex: -1,
};

const DEFAULT_SFTP_SNAPSHOT: WorkspaceSftpSnapshot = {
  local: { ...DEFAULT_PANE_SNAPSHOT },
  remote: { ...DEFAULT_PANE_SNAPSHOT },
  splitPosition: 50,
  searchMode: "filter",
  searchQuery: "",
};

function createWorkspaceSnapshot(
  profileId: string,
  userId: string,
): WorkspaceSnapshot {
  return {
    key: buildWorkspaceKey(profileId, userId),
    profileId,
    userId,
    activeFeature: "terminal",
    activeTerminalId: null,
    sftp: {
      local: { ...DEFAULT_PANE_SNAPSHOT },
      remote: { ...DEFAULT_PANE_SNAPSHOT },
      splitPosition: DEFAULT_SFTP_SNAPSHOT.splitPosition,
      searchMode: DEFAULT_SFTP_SNAPSHOT.searchMode,
      searchQuery: DEFAULT_SFTP_SNAPSHOT.searchQuery,
    },
    updatedAt: Date.now(),
  };
}

function clonePaneSnapshot(
  pane?: Partial<WorkspacePaneSnapshot>,
): WorkspacePaneSnapshot {
  return {
    path: pane?.path ?? "",
    history: [...(pane?.history ?? [])],
    historyIndex: pane?.historyIndex ?? -1,
  };
}

export function buildWorkspaceKey(profileId: string, userId: string) {
  return `${profileId}:${userId}`;
}

export const useWorkspaceStore = create<WorkspaceStoreState>()(
  persist(
    (set, get) => ({
      workspaces: {},

      getOrCreateWorkspace: (profileId, userId) => {
        const key = buildWorkspaceKey(profileId, userId);
        const existing = get().workspaces[key];
        if (existing) {
          return existing;
        }

        const created = createWorkspaceSnapshot(profileId, userId);
        set((state) => ({
          workspaces: {
            ...state.workspaces,
            [key]: created,
          },
        }));
        return created;
      },

      setActiveFeature: (workspaceKey, feature) =>
        set((state) => {
          const current = state.workspaces[workspaceKey];
          if (!current) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceKey]: {
                ...current,
                activeFeature: feature,
                updatedAt: Date.now(),
              },
            },
          };
        }),

      setActiveTerminalId: (workspaceKey, terminalId) =>
        set((state) => {
          const current = state.workspaces[workspaceKey];
          if (!current) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceKey]: {
                ...current,
                activeTerminalId: terminalId,
                updatedAt: Date.now(),
              },
            },
          };
        }),

      setSftpSnapshot: (workspaceKey, snapshot) =>
        set((state) => {
          const current = state.workspaces[workspaceKey];
          if (!current) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceKey]: {
                ...current,
                sftp: {
                  ...current.sftp,
                  ...snapshot,
                  local: snapshot.local
                    ? clonePaneSnapshot(snapshot.local)
                    : current.sftp.local,
                  remote: snapshot.remote
                    ? clonePaneSnapshot(snapshot.remote)
                    : current.sftp.remote,
                },
                updatedAt: Date.now(),
              },
            },
          };
        }),
    }),
    {
      name: "nexterm-workspaces",
      partialize: (state) => ({ workspaces: state.workspaces }),
    },
  ),
);
