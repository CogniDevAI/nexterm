// features/sftp/useSftp.ts — SFTP operations hook
//
// Wraps all Tauri SFTP commands. Manages current remote/local path state,
// navigation, and transfer initiation via Tauri Channels.

import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import { useTransferStore } from "../../stores/transferStore";
import type {
  SessionId,
  FileEntry,
  FileContent,
  SearchResult,
  TransferEvent,
} from "../../lib/types";
import type { PaneState } from "./sftp.types";

const INITIAL_PANE_STATE: PaneState = {
  path: "",
  entries: [],
  loading: false,
  error: null,
  history: [],
  historyIndex: -1,
};

export function useSftp(sessionId: SessionId) {
  const [sftpInitialized, setSftpInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const initializingRef = useRef(false);
  // Track init state via ref so the callback never has a stale closure (M2 fix)
  const sftpInitializedRef = useRef(false);
  // Store the remote home directory returned by sftp_open (H2 fix)
  const [remoteHome, setRemoteHome] = useState<string | null>(null);

  const [localPane, setLocalPane] = useState<PaneState>({ ...INITIAL_PANE_STATE });
  const [remotePane, setRemotePane] = useState<PaneState>({ ...INITIAL_PANE_STATE });

  const { addTransfer, updateProgress, completeTransfer, failTransfer } =
    useTransferStore();

  // ─── SFTP Initialization ──────────────────────────────

  const initSftp = useCallback(async () => {
    // Use ref to avoid stale closure on sftpInitialized (M2 fix)
    if (sftpInitializedRef.current || initializingRef.current) return;
    initializingRef.current = true;
    setInitError(null);

    try {
      // sftp_open returns the remote home directory path (H2 fix)
      const homePath = await tauriInvoke<string>("sftp_open", { sessionId });
      sftpInitializedRef.current = true;
      setSftpInitialized(true);
      setRemoteHome(homePath);
    } catch (err) {
      // On failure, ensure we CAN retry — ref stays false (M2 fix)
      sftpInitializedRef.current = false;
      setInitError(String(err));
    } finally {
      initializingRef.current = false;
    }
  }, [sessionId]);

  /** Reset SFTP state so initSftp can be called again (e.g. after reconnect) */
  const resetSftp = useCallback(() => {
    sftpInitializedRef.current = false;
    initializingRef.current = false;
    setSftpInitialized(false);
    setInitError(null);
    setRemoteHome(null);
    setRemotePane({ ...INITIAL_PANE_STATE });
    setLocalPane({ ...INITIAL_PANE_STATE });
  }, []);

  // Reset SFTP state when the active session changes.
  //
  // SftpBrowser is rendered without a `key` prop in App.tsx, so React reuses
  // the same component instance when the user switches sessions. Without this
  // effect, refs (`sftpInitializedRef`) and state (`remotePane`) persist from
  // the previous session — causing the SFTP browser to show stale data from
  // the wrong session and skip initialization for the new one.
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      // Reset all SFTP state so initSftp re-runs for the new session
      sftpInitializedRef.current = false;
      initializingRef.current = false;
      setSftpInitialized(false);
      setInitError(null);
      setRemoteHome(null);
      setRemotePane({ ...INITIAL_PANE_STATE });
      setLocalPane({ ...INITIAL_PANE_STATE });
    }
  }, [sessionId]);

  // ─── Remote Operations ────────────────────────────────

  // Flag to suppress history push during back/forward navigation (M4 fix)
  const navigatingHistoryRef = useRef(false);

  const listRemoteDir = useCallback(
    async (path: string) => {
      setRemotePane((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const entries = await tauriInvoke<FileEntry[]>("sftp_list_dir", {
          sessionId,
          path,
        });
        const skipHistory = navigatingHistoryRef.current;
        navigatingHistoryRef.current = false;
        setRemotePane((prev) => {
          if (skipHistory) {
            // Navigating via history — don't push a new entry (M4 fix)
            return {
              ...prev,
              path,
              entries,
              loading: false,
              error: null,
            };
          }
          const newHistory = [...prev.history.slice(0, prev.historyIndex + 1), path];
          return {
            path,
            entries,
            loading: false,
            error: null,
            history: newHistory,
            historyIndex: newHistory.length - 1,
          };
        });
      } catch (err) {
        navigatingHistoryRef.current = false;
        setRemotePane((prev) => ({
          ...prev,
          loading: false,
          error: String(err),
        }));
      }
    },
    [sessionId],
  );

  const navigateRemote = useCallback(
    (path: string) => {
      void listRemoteDir(path);
    },
    [listRemoteDir],
  );

  const navigateRemoteUp = useCallback(() => {
    const parent = remotePane.path.replace(/\/[^/]+\/?$/, "") || "/";
    void listRemoteDir(parent);
  }, [remotePane.path, listRemoteDir]);

  const goRemoteBack = useCallback(() => {
    if (remotePane.historyIndex > 0) {
      const prevPath = remotePane.history[remotePane.historyIndex - 1];
      if (!prevPath) return;
      // Set flag BEFORE calling listRemoteDir to prevent history push (M4 fix)
      navigatingHistoryRef.current = true;
      setRemotePane((prev) => ({ ...prev, historyIndex: prev.historyIndex - 1 }));
      void listRemoteDir(prevPath);
    }
  }, [remotePane.historyIndex, remotePane.history, listRemoteDir]);

  const refreshRemote = useCallback(() => {
    if (remotePane.path) {
      // Refresh shouldn't push a new history entry either
      navigatingHistoryRef.current = true;
      void listRemoteDir(remotePane.path);
    }
  }, [remotePane.path, listRemoteDir]);

  // ─── Local Operations ─────────────────────────────────

  const listLocalDir = useCallback(async (path: string) => {
    setLocalPane((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const entries = await tauriInvoke<FileEntry[]>("list_local_dir", { path });
      setLocalPane((prev) => {
        const newHistory = [...prev.history.slice(0, prev.historyIndex + 1), path];
        return {
          path,
          entries,
          loading: false,
          error: null,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        };
      });
    } catch (err) {
      setLocalPane((prev) => ({
        ...prev,
        loading: false,
        error: String(err),
      }));
    }
  }, []);

  const navigateLocal = useCallback(
    (path: string) => {
      void listLocalDir(path);
    },
    [listLocalDir],
  );

  const navigateLocalUp = useCallback(() => {
    const parent = localPane.path.replace(/\/[^/]+\/?$/, "") || "/";
    void listLocalDir(parent);
  }, [localPane.path, listLocalDir]);

  const refreshLocal = useCallback(() => {
    if (localPane.path) {
      void listLocalDir(localPane.path);
    }
  }, [localPane.path, listLocalDir]);

  // ─── File Operations ──────────────────────────────────

  const mkdirRemote = useCallback(
    async (path: string) => {
      await tauriInvoke<void>("sftp_mkdir", { sessionId, path });
      refreshRemote();
    },
    [sessionId, refreshRemote],
  );

  const deleteRemote = useCallback(
    async (path: string, recursive = false) => {
      await tauriInvoke<void>("sftp_delete", { sessionId, path, recursive });
      refreshRemote();
    },
    [sessionId, refreshRemote],
  );

  const renameRemote = useCallback(
    async (oldPath: string, newPath: string) => {
      await tauriInvoke<void>("sftp_rename", { sessionId, from: oldPath, to: newPath });
      refreshRemote();
    },
    [sessionId, refreshRemote],
  );

  const readFile = useCallback(
    async (remotePath: string, maxLines?: number) => {
      return await tauriInvoke<FileContent>("sftp_read_file", {
        sessionId,
        remotePath,
        maxLines: maxLines ?? null,
      });
    },
    [sessionId],
  );

  // ─── Open with External App ────────────────────────────

  const openExternal = useCallback(
    async (
      remotePath: string,
      fileName: string,
      onProgress?: (event: TransferEvent) => void,
    ) => {
      const channel = new Channel<TransferEvent>();
      if (onProgress) {
        channel.onmessage = onProgress;
      }
      await tauriInvoke<void>("sftp_open_external", {
        sessionId,
        remotePath,
        fileName,
        onProgress: channel,
      });
    },
    [sessionId],
  );

  // ─── Save As & Reveal ────────────────────────────────

  const saveAsAndReveal = useCallback(
    async (
      remotePath: string,
      localPath: string,
      fileName: string,
      onProgress?: (event: TransferEvent) => void,
    ) => {
      const channel = new Channel<TransferEvent>();
      if (onProgress) {
        channel.onmessage = onProgress;
      }
      await tauriInvoke<void>("sftp_save_and_reveal", {
        sessionId,
        remotePath,
        localPath,
        fileName,
        onProgress: channel,
      });
    },
    [sessionId],
  );

  // ─── Recursive Search ─────────────────────────────────

  const searchFiles = useCallback(
    async (basePath: string, query: string, maxDepth?: number, maxResults?: number) => {
      return await tauriInvoke<SearchResult[]>("sftp_search", {
        sessionId,
        basePath,
        query,
        maxDepth: maxDepth ?? 5,
        maxResults: maxResults ?? 100,
      });
    },
    [sessionId],
  );

  // ─── Transfers ────────────────────────────────────────

  const uploadFile = useCallback(
    async (localPath: string, remotePath: string) => {
      const channel = new Channel<TransferEvent>();

      channel.onmessage = (message) => {
        switch (message.event) {
          case "started":
            addTransfer({
              id: message.data.transferId,
              fileName: message.data.fileName,
              direction: message.data.direction,
              totalBytes: message.data.totalBytes,
              bytesTransferred: 0,
              status: "active",
            });
            break;
          case "progress":
            updateProgress(
              message.data.transferId,
              message.data.bytesTransferred,
              message.data.totalBytes,
            );
            break;
          case "completed":
            completeTransfer(message.data.transferId);
            refreshRemote();
            break;
          case "failed":
            failTransfer(message.data.transferId, message.data.error);
            break;
        }
      };

      await tauriInvoke<void>("sftp_upload", {
        sessionId,
        localPath,
        remotePath,
        onProgress: channel,
      });
    },
    [sessionId, addTransfer, updateProgress, completeTransfer, failTransfer, refreshRemote],
  );

  const downloadFile = useCallback(
    async (remotePath: string, localPath: string) => {
      const channel = new Channel<TransferEvent>();

      channel.onmessage = (message) => {
        switch (message.event) {
          case "started":
            addTransfer({
              id: message.data.transferId,
              fileName: message.data.fileName,
              direction: message.data.direction,
              totalBytes: message.data.totalBytes,
              bytesTransferred: 0,
              status: "active",
            });
            break;
          case "progress":
            updateProgress(
              message.data.transferId,
              message.data.bytesTransferred,
              message.data.totalBytes,
            );
            break;
          case "completed":
            completeTransfer(message.data.transferId);
            refreshLocal();
            break;
          case "failed":
            failTransfer(message.data.transferId, message.data.error);
            break;
        }
      };

      await tauriInvoke<void>("sftp_download", {
        sessionId,
        remotePath,
        localPath,
        onProgress: channel,
      });
    },
    [sessionId, addTransfer, updateProgress, completeTransfer, failTransfer, refreshLocal],
  );

  return {
    // State
    sftpInitialized,
    initError,
    localPane,
    remotePane,
    remoteHome,

    // Init
    initSftp,
    resetSftp,

    // Remote navigation
    navigateRemote,
    navigateRemoteUp,
    goRemoteBack,
    refreshRemote,
    listRemoteDir,

    // Local navigation
    navigateLocal,
    navigateLocalUp,
    refreshLocal,
    listLocalDir,

    // File ops
    mkdirRemote,
    deleteRemote,
    renameRemote,
    readFile,
    searchFiles,
    openExternal,
    saveAsAndReveal,

    // Transfers
    uploadFile,
    downloadFile,
  };
}
