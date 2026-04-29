// features/sftp/SftpBrowser.tsx — Dual-pane SFTP file browser
//
// Left pane: local filesystem. Right pane: remote SFTP.
// Per-pane action buttons in each FilePane header. Wires up useSftp hook.

import { useCallback, useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { FilePane, type SearchMode } from "./FilePane";
import { TransferOverlay } from "./TransferOverlay";
import { FileContextMenu } from "./FileContextMenu";
import { useSftp } from "./useSftp";
import { Spinner } from "../../components/ui/Spinner";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../lib/i18n";
import { tauriInvoke } from "../../lib/tauri";
import type { SessionId, FileEntry, SearchResult, TransferEvent } from "../../lib/types";
import type { PaneSource, FileAction } from "./sftp.types";
import { useProfileStore } from "../../stores/profileStore";
import { useSessionStore } from "../../stores/sessionStore";
import {
  buildWorkspaceKey,
  useWorkspaceStore,
} from "../../stores/workspaceStore";
import {
  buildRemoteEditId,
  useRemoteEditStore,
} from "../../stores/remoteEditStore";

async function selectApplicationPath(title: string): Promise<string | null> {
  const isMac = navigator.userAgent.includes("Mac") || navigator.platform.includes("Mac");
  const isWindows = navigator.userAgent.includes("Windows") || navigator.platform.includes("Win");

  if (isMac || isWindows) {
    return await tauriInvoke<string | null>("choose_application", { prompt: title });
  }

  const selected = await openDialog({
    title,
    multiple: false,
  });

  if (Array.isArray(selected)) {
    return selected[0] ?? null;
  }

  return selected;
}

interface SftpBrowserProps {
  sessionId: SessionId;
}

export function SftpBrowser({ sessionId }: SftpBrowserProps) {
  const { t } = useI18n();
  const session = useSessionStore((state) => state.sessions.get(sessionId));
  const profiles = useProfileStore((state) => state.profiles);
  const workspaceKey = session
    ? buildWorkspaceKey(session.profileId, session.userId)
    : null;
  const workspaceSnapshot = useWorkspaceStore((state) =>
    workspaceKey ? state.workspaces[workspaceKey] : undefined,
  );
  const setSftpSnapshot = useWorkspaceStore((state) => state.setSftpSnapshot);
  const upsertRemoteEditSession = useRemoteEditStore(
    (state) => state.upsertSession,
  );
  const startupDirectory = session
    ? profiles.find((profile) => profile.id === session.profileId)?.startupDirectory
    : undefined;
  const sftp = useSftp(sessionId, {
    initialLocalPane: workspaceSnapshot?.sftp.local,
    initialRemotePane: workspaceSnapshot?.sftp.remote,
  });

  // Selection state per pane
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
    source: PaneSource;
  } | null>(null);

  // New folder dialog
  const [newFolderDialog, setNewFolderDialog] = useState<{
    source: PaneSource;
  } | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  // Rename dialog
  const [renameDialog, setRenameDialog] = useState<{
    entry: FileEntry;
    source: PaneSource;
  } | null>(null);
  const [renameName, setRenameName] = useState("");

  // Delete confirmation dialog
  const [deleteDialog, setDeleteDialog] = useState<{
    entry: FileEntry;
    source: PaneSource;
  } | null>(null);



  // Error banner (download failures, etc.)
  const [tooLargeMessage, setTooLargeMessage] = useState<string | null>(null);
  const tooLargeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Download progress for open-external / save-as-and-open
  const [externalDownload, setExternalDownload] = useState<{
    fileName: string;
    bytesTransferred: number;
    totalBytes: number;
    label: string;
  } | null>(null);

  // Cleanup too-large timer on unmount
  useEffect(() => {
    return () => {
      if (tooLargeTimerRef.current) clearTimeout(tooLargeTimerRef.current);
    };
  }, []);

  // Search state
  const [searchMode, setSearchMode] = useState<SearchMode>(
    () => workspaceSnapshot?.sftp.searchMode ?? "filter",
  );
  const [searchQuery, setSearchQuery] = useState(
    () => workspaceSnapshot?.sftp.searchQuery ?? "",
  );
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // ─── OS Drag & Drop state (PR2) ──────────────────────
  const [isDraggingFromOS, setIsDraggingFromOS] = useState(false);
  const remotePaneRef = useRef<HTMLDivElement>(null);

  // Active pane tracking (PR3 — focus management)
  const [activePane, setActivePane] = useState<PaneSource>("local");
  const localPaneRef = useRef<HTMLDivElement>(null);

  // Resizable split
  const [splitPosition, setSplitPosition] = useState(
    () => workspaceSnapshot?.sftp.splitPosition ?? 50,
  ); // percentage
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    setSearchMode(workspaceSnapshot?.sftp.searchMode ?? "filter");
    setSearchQuery(workspaceSnapshot?.sftp.searchQuery ?? "");
    setSearchResults([]);
    setSearchLoading(false);
    setSplitPosition(workspaceSnapshot?.sftp.splitPosition ?? 50);
  }, [workspaceKey]);

  // ─── Initialize SFTP on mount ─────────────────────────

  useEffect(() => {
    void sftp.initSftp();
  }, [sftp.initSftp]);

  // Load initial directories once SFTP is ready
  useEffect(() => {
    if (sftp.sftpInitialized) {
      const initialRemotePath =
        sftp.remotePane.path || startupDirectory || sftp.remoteHome;
      if (initialRemotePath) {
        if (sftp.remotePane.path === initialRemotePath) {
          sftp.refreshRemote();
        } else {
          void sftp.listRemoteDir(initialRemotePath);
        }
      }
      // Load local home directory (use Tauri path API for cross-platform support)
      if (sftp.localPane.path) {
        sftp.refreshLocal();
      } else {
        void homeDir()
          .then((home) => sftp.listLocalDir(home))
          .catch(() => sftp.listLocalDir("/"));
      }
    }
  }, [
    sftp.sftpInitialized,
    sftp.remoteHome,
    sftp.remotePane.path,
    sftp.localPane.path,
    sftp.listRemoteDir,
    sftp.listLocalDir,
    sftp.refreshLocal,
    sftp.refreshRemote,
    startupDirectory,
  ]);

  useEffect(() => {
    if (!workspaceKey) return;
    setSftpSnapshot(workspaceKey, {
      local: {
        path: sftp.localPane.path,
        history: sftp.localPane.history,
        historyIndex: sftp.localPane.historyIndex,
      },
      remote: {
        path: sftp.remotePane.path,
        history: sftp.remotePane.history,
        historyIndex: sftp.remotePane.historyIndex,
      },
      splitPosition,
      searchMode,
      searchQuery,
    });
  }, [
    searchMode,
    searchQuery,
    sftp.localPane.history,
    sftp.localPane.historyIndex,
    sftp.localPane.path,
    sftp.remotePane.history,
    sftp.remotePane.historyIndex,
    sftp.remotePane.path,
    setSftpSnapshot,
    splitPosition,
    workspaceKey,
  ]);

  // ─── OS Drag & Drop via Tauri (PR2) ────────────────────

  /**
   * Check if a physical position falls within the remote pane bounds.
   * Returns true if the drop should target the remote pane.
   */
  const isOverRemotePane = useCallback((x: number, y: number): boolean => {
    if (!remotePaneRef.current) return false;
    const rect = remotePaneRef.current.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }, []);

  /**
   * Handle OS file drop on the remote pane: upload each file with per-file
   * error handling so one failure doesn't block the rest.
   */
  const handleOSDrop = useCallback(
    async (paths: string[], x: number, y: number) => {
      if (!isOverRemotePane(x, y)) return;
      if (!sftp.remotePane.path) return;

      for (const localPath of paths) {
        const fileName = localPath.split(/[/\\]/).pop() ?? localPath;
        const remoteDest = sftp.remotePane.path + "/" + fileName;
        try {
          await sftp.uploadFile(localPath, remoteDest);
        } catch (err) {
          // Per-file error handling: log and continue with the rest.
          // The transfer store's failTransfer will show the error in TransferOverlay.
          console.error(`OS DnD upload failed for ${fileName}:`, err);
        }
      }
    },
    [sftp, isOverRemotePane],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { payload } = event;
        switch (payload.type) {
          case "enter":
          case "over":
            setIsDraggingFromOS(true);
            break;
          case "drop":
            setIsDraggingFromOS(false);
            void handleOSDrop(payload.paths, payload.position.x, payload.position.y);
            break;
          case "leave":
            setIsDraggingFromOS(false);
            break;
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleOSDrop]);

  // ─── Global Keyboard Shortcuts (PR3) ───────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Alt+Left → Back
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        if (activePane === "remote") {
          sftp.goRemoteBack();
        } else {
          sftp.goLocalBack();
        }
        return;
      }

      // Alt+Right → Forward
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (activePane === "remote") {
          sftp.goRemoteForward();
        } else {
          sftp.goLocalForward();
        }
        return;
      }

      // Alt+Up → Parent directory
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        if (activePane === "remote") {
          sftp.navigateRemoteUp();
        } else {
          sftp.navigateLocalUp();
        }
        return;
      }

      // Tab to switch panes (when not in an input)
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Don't intercept Tab globally — let natural tab order work
        // unless the active element is the pane itself
        const paneEl = activePane === "local" ? localPaneRef.current : remotePaneRef.current;
        if (paneEl && paneEl.contains(e.target as Node)) {
          // If focus is on the pane container, tab switches to other pane
          const isOnPane = e.target === paneEl || (e.target as HTMLElement).classList?.contains("sftp-pane");
          if (isOnPane) {
            e.preventDefault();
            setActivePane(activePane === "local" ? "remote" : "local");
            const otherPane = activePane === "local" ? remotePaneRef.current : localPaneRef.current;
            // Focus the pane container within the other pane-container
            const otherPaneFocusable = otherPane?.querySelector<HTMLElement>(".sftp-pane");
            otherPaneFocusable?.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePane, sftp]);

  // ─── Split Resize ─────────────────────────────────────

  const handleSplitMouseDown = useCallback(() => {
    isDraggingRef.current = true;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      setSplitPosition(Math.max(20, Math.min(80, pct)));
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // ─── Context Menu ─────────────────────────────────────

  const handleLocalContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry | null) => {
      setContextMenu({ x: e.clientX, y: e.clientY, entry, source: "local" });
    },
    [],
  );

  const handleRemoteContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry | null) => {
      setContextMenu({ x: e.clientX, y: e.clientY, entry, source: "remote" });
    },
    [],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ─── File Actions ─────────────────────────────────────

  const handleFileAction = useCallback(
    async (action: FileAction) => {
      closeContextMenu();

      switch (action.type) {
        case "open": {
          if (!action.entry) return;
          const entry = action.entry;
          // Only open files and symlinks-to-files (not directories)
          if (entry.fileType !== "file" && !(entry.fileType === "symlink" && entry.linkTarget === "file")) return;
          const extFileName = entry.name;

          // All remote files: download to temp + open with OS default app
          setExternalDownload({
            fileName: extFileName,
            bytesTransferred: 0,
            totalBytes: entry.size || 0,
            label: t("sftp.downloadingProgress", { name: extFileName }),
          });

          sftp
            .openExternal(entry.path, extFileName, (event: TransferEvent) => {
              switch (event.event) {
                case "progress":
                  setExternalDownload((prev) =>
                    prev
                      ? {
                          ...prev,
                          bytesTransferred: event.data.bytesTransferred,
                          totalBytes: event.data.totalBytes,
                        }
                      : null,
                  );
                  break;
                case "completed":
                  setExternalDownload(null);
                  break;
                case "failed":
                  setExternalDownload(null);
                  setTooLargeMessage(event.data.error);
                  tooLargeTimerRef.current = setTimeout(() => {
                    setTooLargeMessage(null);
                    tooLargeTimerRef.current = null;
                  }, 4000);
                  break;
              }
            })
            .then(() => {
              setExternalDownload(null);
            })
            .catch((err) => {
              setExternalDownload(null);
              const message = err instanceof Error ? err.message : String(err);
              setTooLargeMessage(message);
              tooLargeTimerRef.current = setTimeout(() => {
                setTooLargeMessage(null);
                tooLargeTimerRef.current = null;
              }, 4000);
            });
          break;
        }
        case "openWith": {
          if (!action.entry) return;
          const entry = action.entry;
          if (entry.fileType !== "file" && !(entry.fileType === "symlink" && entry.linkTarget === "file")) return;

          const appPath = await selectApplicationPath(t("sftp.chooseApp"));
          if (!appPath) return;

          const editId = buildRemoteEditId(sessionId, entry.path);
          const existing = useRemoteEditStore.getState().sessions[editId];
          if (existing) {
            await tauriInvoke<void>("open_local_file_with", {
              path: existing.localPath,
              appPath,
            });
            return;
          }

          setExternalDownload({
            fileName: entry.name,
            bytesTransferred: 0,
            totalBytes: entry.size || 0,
            label: t("sftp.downloadingProgress", { name: entry.name }),
          });

          sftp
            .openWithApp(entry.path, entry.name, appPath, (event: TransferEvent) => {
              switch (event.event) {
                case "progress":
                  setExternalDownload((prev) =>
                    prev
                      ? {
                          ...prev,
                          bytesTransferred: event.data.bytesTransferred,
                          totalBytes: event.data.totalBytes,
                        }
                      : null,
                  );
                  break;
                case "completed":
                  setExternalDownload(null);
                  break;
                case "failed":
                  setExternalDownload(null);
                  setTooLargeMessage(event.data.error);
                  tooLargeTimerRef.current = setTimeout(() => {
                    setTooLargeMessage(null);
                    tooLargeTimerRef.current = null;
                  }, 4000);
                  break;
              }
            })
            .then((localPath) => {
              setExternalDownload(null);
              upsertRemoteEditSession({
                id: editId,
                sessionId,
                remotePath: entry.path,
                localPath,
                fileName: entry.name,
                dirty: false,
                syncing: false,
                lastKnownMtime: null,
              });
            })
            .catch((err) => {
              setExternalDownload(null);
              const message = err instanceof Error ? err.message : String(err);
              setTooLargeMessage(message);
              tooLargeTimerRef.current = setTimeout(() => {
                setTooLargeMessage(null);
                tooLargeTimerRef.current = null;
              }, 4000);
            });
          break;
        }
        case "upload": {
          if (!action.entry) return;
          const remoteDest = sftp.remotePane.path + "/" + action.entry.name;
          void sftp.uploadFile(action.entry.path, remoteDest);
          break;
        }
        case "download": {
          if (!action.entry) return;
          const localDest = sftp.localPane.path + "/" + action.entry.name;
          const isDir =
            action.entry.fileType === "directory" ||
            (action.entry.fileType === "symlink" && action.entry.linkTarget === "directory");
          if (isDir) {
            void sftp.downloadFolder(action.entry.path, localDest);
          } else {
            void sftp.downloadFile(action.entry.path, localDest);
          }
          break;
        }
        case "rename": {
          if (!action.entry) return;
          setRenameDialog({
            entry: action.entry,
            source: contextMenu?.source ?? "remote",
          });
          setRenameName(action.entry.name);
          break;
        }
        case "delete": {
          if (!action.entry) return;
          setDeleteDialog({
            entry: action.entry,
            source: contextMenu?.source ?? "remote",
          });
          break;
        }
        case "newFolder": {
          setNewFolderDialog({
            source: contextMenu?.source ?? "remote",
          });
          setNewFolderName("");
          break;
        }
        case "refresh": {
          if (contextMenu?.source === "local") {
            sftp.refreshLocal();
          } else {
            sftp.refreshRemote();
          }
          break;
        }
        case "saveAsAndOpen": {
          if (!action.entry) return;
          const saveEntry = action.entry;
          const saveFileName = saveEntry.name;

          // Show native save dialog
          const savePath = await save({
            defaultPath: saveFileName,
            title: t("ctx.saveAsAndOpen"),
          });

          if (!savePath) return; // User cancelled

          // Show progress bar during download
          setExternalDownload({
            fileName: saveFileName,
            bytesTransferred: 0,
            totalBytes: saveEntry.size || 0,
            label: t("sftp.savingAs", { name: saveFileName }),
          });

          sftp
            .saveAsAndReveal(saveEntry.path, savePath, saveFileName, (event: TransferEvent) => {
              switch (event.event) {
                case "progress":
                  setExternalDownload((prev) =>
                    prev
                      ? {
                          ...prev,
                          bytesTransferred: event.data.bytesTransferred,
                          totalBytes: event.data.totalBytes,
                        }
                      : null,
                  );
                  break;
                case "completed":
                  setExternalDownload(null);
                  break;
                case "failed":
                  setExternalDownload(null);
                  setTooLargeMessage(event.data.error);
                  tooLargeTimerRef.current = setTimeout(() => {
                    setTooLargeMessage(null);
                    tooLargeTimerRef.current = null;
                  }, 4000);
                  break;
              }
            })
            .then(() => {
              setExternalDownload(null);
            })
            .catch((err) => {
              setExternalDownload(null);
              const message = err instanceof Error ? err.message : String(err);
              setTooLargeMessage(message);
              tooLargeTimerRef.current = setTimeout(() => {
                setTooLargeMessage(null);
                tooLargeTimerRef.current = null;
              }, 4000);
            });
          break;
        }
        case "copyPath": {
          if (action.entry) {
            void navigator.clipboard.writeText(action.entry.path);
          }
          break;
        }
      }
    },
    [sftp, contextMenu, closeContextMenu, sessionId, t, upsertRemoteEditSession],
  );

  // ─── Local File Actions ───────────────────────────────
  // Local pane files should open with the OS native app, NOT via SFTP.

  const handleLocalFileAction = useCallback(
    async (action: FileAction) => {
      closeContextMenu();

      switch (action.type) {
        case "open": {
          if (!action.entry) return;
          const entry = action.entry;
          // Local files: open with OS default application
          if (entry.fileType === "file" || (entry.fileType === "symlink" && entry.linkTarget === "file")) {
            try {
              await tauriInvoke<void>("open_local_file", { path: entry.path });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              setTooLargeMessage(message);
              tooLargeTimerRef.current = setTimeout(() => {
                setTooLargeMessage(null);
                tooLargeTimerRef.current = null;
              }, 4000);
            }
          }
          break;
        }
        case "openWith": {
          if (!action.entry) return;
          const entry = action.entry;
          if (entry.fileType !== "file" && !(entry.fileType === "symlink" && entry.linkTarget === "file")) return;

          const appPath = await selectApplicationPath(t("sftp.chooseApp"));
          if (!appPath) return;

          try {
            await tauriInvoke<void>("open_local_file_with", {
              path: entry.path,
              appPath,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setTooLargeMessage(message);
            tooLargeTimerRef.current = setTimeout(() => {
              setTooLargeMessage(null);
              tooLargeTimerRef.current = null;
            }, 4000);
          }
          break;
        }
        case "upload": {
          if (!action.entry) return;
          const remoteDest = sftp.remotePane.path + "/" + action.entry.name;
          void sftp.uploadFile(action.entry.path, remoteDest);
          break;
        }
        case "copyPath": {
          if (action.entry) {
            void navigator.clipboard.writeText(action.entry.path);
          }
          break;
        }
        case "refresh": {
          sftp.refreshLocal();
          break;
        }
        default:
          // For any other actions on the local pane, delegate to the general handler
          void handleFileAction(action);
          break;
      }
    },
    [sftp, closeContextMenu, handleFileAction, t],
  );

  // ─── Dialog Actions ───────────────────────────────────

  const handleNewFolder = useCallback(async () => {
    if (!newFolderDialog || !newFolderName.trim()) return;
    const basePath =
      newFolderDialog.source === "local"
        ? sftp.localPane.path
        : sftp.remotePane.path;
    const fullPath = basePath + "/" + newFolderName.trim();

    try {
      if (newFolderDialog.source === "remote") {
        await sftp.mkdirRemote(fullPath);
      }
      // Local mkdir would need a backend command — skip for now
    } catch (err) {
      // Error displayed in pane
      console.error("mkdir failed:", err);
    }
    setNewFolderDialog(null);
  }, [newFolderDialog, newFolderName, sftp]);

  const handleRename = useCallback(async () => {
    if (!renameDialog || !renameName.trim()) return;
    const oldPath = renameDialog.entry.path;
    const parentPath = oldPath.replace(/\/[^/]+$/, "");
    const newPath = parentPath + "/" + renameName.trim();

    try {
      if (renameDialog.source === "remote") {
        await sftp.renameRemote(oldPath, newPath);
      }
    } catch (err) {
      console.error("rename failed:", err);
    }
    setRenameDialog(null);
  }, [renameDialog, renameName, sftp]);

  const handleDelete = useCallback(async () => {
    if (!deleteDialog) return;
    try {
      if (deleteDialog.source === "remote") {
        const isDir = deleteDialog.entry.fileType === "directory";
        await sftp.deleteRemote(deleteDialog.entry.path, isDir);
      }
    } catch (err) {
      console.error("delete failed:", err);
    }
    setDeleteDialog(null);
  }, [deleteDialog, sftp]);

  // ─── Search Handlers ───────────────────────────────────

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    // In search mode, clear previous results when query changes
    if (searchMode === "search") {
      setSearchResults([]);
    }
  }, [searchMode]);

  const handleSearchModeChange = useCallback((mode: SearchMode) => {
    setSearchMode(mode);
    setSearchResults([]);
    setSearchLoading(false);
  }, []);

  const handleSearchSubmit = useCallback(async () => {
    if (!searchQuery.trim() || searchMode !== "search") return;
    setSearchLoading(true);
    setSearchResults([]);
    try {
      const results = await sftp.searchFiles(sftp.remotePane.path, searchQuery.trim());
      setSearchResults(results);
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery, searchMode, sftp]);

  const handleSearchClear = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchLoading(false);
  }, []);

  // ─── Toolbar Actions ──────────────────────────────────

  const handleUpload = useCallback(() => {
    // Upload all selected local files to remote
    for (const path of localSelected) {
      const entry = sftp.localPane.entries.find((e) => e.path === path);
      if (entry && (entry.fileType === "file" || (entry.fileType === "symlink" && entry.linkTarget === "file"))) {
        const remoteDest = sftp.remotePane.path + "/" + entry.name;
        void sftp.uploadFile(entry.path, remoteDest);
      }
    }
  }, [localSelected, sftp]);

  const handleDownload = useCallback(() => {
    // Download all selected remote files and folders to local
    for (const path of remoteSelected) {
      const entry = sftp.remotePane.entries.find((e) => e.path === path);
      if (!entry) continue;
      const localDest = sftp.localPane.path + "/" + entry.name;
      const isDir =
        entry.fileType === "directory" ||
        (entry.fileType === "symlink" && entry.linkTarget === "directory");
      const isFile =
        entry.fileType === "file" ||
        (entry.fileType === "symlink" && entry.linkTarget === "file");
      if (isDir) {
        void sftp.downloadFolder(entry.path, localDest);
      } else if (isFile) {
        void sftp.downloadFile(entry.path, localDest);
      }
    }
  }, [remoteSelected, sftp]);

  // ─── Drag & Drop between panes ────────────────────────

  const handleLocalDrop = useCallback(
    (entries: FileEntry[]) => {
      // Dropped from remote → download (file or folder)
      for (const entry of entries) {
        const localDest = sftp.localPane.path + "/" + entry.name;
        const isDir =
          entry.fileType === "directory" ||
          (entry.fileType === "symlink" && entry.linkTarget === "directory");
        if (isDir) {
          void sftp.downloadFolder(entry.path, localDest);
        } else {
          void sftp.downloadFile(entry.path, localDest);
        }
      }
    },
    [sftp],
  );

  const handleRemoteDrop = useCallback(
    (entries: FileEntry[]) => {
      // Dropped from local → upload
      for (const entry of entries) {
        const remoteDest = sftp.remotePane.path + "/" + entry.name;
        void sftp.uploadFile(entry.path, remoteDest);
      }
    },
    [sftp],
  );

  // ─── Render ───────────────────────────────────────────

  // Show init state
  if (!sftp.sftpInitialized) {
    return (
      <div className="sftp-init">
        {sftp.initError ? (
          <div className="sftp-init-error">
            <p>{t("sftp.initFailed")}</p>
            <p className="error-message">{sftp.initError}</p>
            <Button variant="secondary" onClick={() => void sftp.initSftp()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="sftp-init-loading">
            <Spinner size={24} />
            <span>{t("sftp.initializing")}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sftp-browser" onClick={closeContextMenu}>
      {/* Download progress banner (open external / save as) */}
      {externalDownload && (
        <div className="sftp-too-large-banner sftp-download-progress-banner">
          <div className="sftp-download-progress-info">
            <span>{externalDownload.label}</span>
            {externalDownload.totalBytes > 0 && (
              <span className="sftp-download-progress-pct">
                {Math.round(
                  (externalDownload.bytesTransferred / externalDownload.totalBytes) * 100,
                )}
                %
              </span>
            )}
          </div>
          <div className="sftp-download-progress-bar">
            <div
              className="sftp-download-progress-fill"
              style={{
                width: `${
                  externalDownload.totalBytes > 0
                    ? (externalDownload.bytesTransferred / externalDownload.totalBytes) * 100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Too-large file banner / error banner */}
      {tooLargeMessage && !externalDownload && (
        <div className="sftp-too-large-banner">
          <span>{tooLargeMessage}</span>
          <button
            className="sftp-too-large-banner-close"
            onClick={() => {
              setTooLargeMessage(null);
              if (tooLargeTimerRef.current) {
                clearTimeout(tooLargeTimerRef.current);
                tooLargeTimerRef.current = null;
              }
            }}
          >
            {"\u00D7"}
          </button>
        </div>
      )}

      {/* Dual pane container */}
      <div className="sftp-panes" ref={containerRef}>
        <div className="sftp-pane-container" style={{ width: `${splitPosition}%` }} ref={localPaneRef}>
          <FilePane
            source="local"
            path={sftp.localPane.path}
            entries={sftp.localPane.entries}
            loading={sftp.localPane.loading}
            error={sftp.localPane.error}
            onNavigate={sftp.navigateLocal}
            onNavigateUp={sftp.navigateLocalUp}
            onRefresh={sftp.refreshLocal}
            onContextMenu={handleLocalContextMenu}
            selectedEntries={localSelected}
            onSelectionChange={setLocalSelected}
            onFileAction={handleLocalFileAction}
            onDragStart={() => {}}
            onDrop={handleLocalDrop}
            canGoBack={sftp.localPane.historyIndex > 0}
            canGoForward={sftp.localPane.historyIndex < sftp.localPane.history.length - 1}
            onGoBack={sftp.goLocalBack}
            onGoForward={sftp.goLocalForward}
            onGoHome={sftp.goLocalHome}
            isFocused={activePane === "local"}
            onPaneFocus={() => setActivePane("local")}
            onTransfer={handleUpload}
            selectedCount={localSelected.size}
          />
        </div>

        {/* Resize handle */}
        <div className="sftp-split-handle" onMouseDown={handleSplitMouseDown} />

        <div
          className="sftp-pane-container"
          style={{ width: `${100 - splitPosition}%`, position: "relative" }}
          ref={remotePaneRef}
        >
          <FilePane
            source="remote"
            path={sftp.remotePane.path}
            entries={sftp.remotePane.entries}
            loading={sftp.remotePane.loading}
            error={sftp.remotePane.error}
            onNavigate={sftp.navigateRemote}
            onNavigateUp={sftp.navigateRemoteUp}
            onRefresh={sftp.refreshRemote}
            onContextMenu={handleRemoteContextMenu}
            selectedEntries={remoteSelected}
            onSelectionChange={setRemoteSelected}
            onFileAction={handleFileAction}
            onDragStart={() => {}}
            onDrop={handleRemoteDrop}
            canGoBack={sftp.remotePane.historyIndex > 0}
            canGoForward={sftp.remotePane.historyIndex < sftp.remotePane.history.length - 1}
            onGoBack={sftp.goRemoteBack}
            onGoForward={sftp.goRemoteForward}
            onGoHome={sftp.goRemoteHome}
            searchMode={searchMode}
            searchQuery={searchQuery}
            searchResults={searchResults}
            searchLoading={searchLoading}
            onSearchQueryChange={handleSearchQueryChange}
            onSearchModeChange={handleSearchModeChange}
            onSearchSubmit={handleSearchSubmit}
            onSearchClear={handleSearchClear}
            isFocused={activePane === "remote"}
            onPaneFocus={() => setActivePane("remote")}
            onTransfer={handleDownload}
            selectedCount={remoteSelected.size}
            onNewFolder={() => {
              setNewFolderDialog({ source: "remote" });
              setNewFolderName("");
            }}
          />

          {/* OS Drag & Drop overlay (PR2) */}
          {isDraggingFromOS && (
            <div className="sftp-drop-overlay">
              <div className="sftp-drop-overlay-content">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>{t("sftp.dropToUpload")}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Transfer Overlay */}
      <TransferOverlay sessionId={sessionId} />

      {/* Context Menu */}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          source={contextMenu.source}
          onAction={contextMenu.source === "local" ? handleLocalFileAction : handleFileAction}
          onClose={closeContextMenu}
        />
      )}

      {/* New Folder Dialog */}
      <Dialog
        open={newFolderDialog !== null}
        onClose={() => setNewFolderDialog(null)}
        title=""
        width="420px"
      >
        <div className="cd-header">
          <div className="cd-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </div>
          <div className="cd-header-text">
            <h3 className="cd-title">{t("sftp.newFolderTitle2")}</h3>
            <p className="cd-subtitle">{t("sftp.newFolderSubtitle")}</p>
          </div>
        </div>
        <div className="cd-section-content">
          <div className="input-group">
            <label className="input-label">{t("sftp.folderName")}</label>
            <input
              className="input"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleNewFolder();
              }}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
            />
          </div>
        </div>
        <div className="cd-actions">
          <Button variant="ghost" onClick={() => setNewFolderDialog(null)}>
            {t("general.cancel")}
          </Button>
          <Button onClick={() => void handleNewFolder()} disabled={!newFolderName.trim()}>
            {t("sftp.create")}
          </Button>
        </div>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        open={renameDialog !== null}
        onClose={() => setRenameDialog(null)}
        title=""
        width="420px"
      >
        {renameDialog && (
          <>
            <div className="cd-header">
              <div className="cd-header-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </div>
              <div className="cd-header-text">
                <h3 className="cd-title">{t("sftp.renameTitle")}</h3>
                <p className="cd-subtitle">{t("sftp.renameSubtitle")}</p>
              </div>
            </div>
            <div className="cd-section-content">
              <div className="input-group">
                <label className="input-label">{t("sftp.newName")}</label>
                <input
                  className="input"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRename();
                  }}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                />
              </div>
            </div>
            <div className="cd-actions">
              <Button variant="ghost" onClick={() => setRenameDialog(null)}>
                {t("general.cancel")}
              </Button>
              <Button onClick={() => void handleRename()} disabled={!renameName.trim()}>
                {t("sftp.rename")}
              </Button>
            </div>
          </>
        )}
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteDialog !== null}
        onClose={() => setDeleteDialog(null)}
        title=""
        width="420px"
      >
        {deleteDialog && (
          <>
            <div className="cd-header">
              <div className="cd-header-icon cd-header-icon-danger">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </div>
              <div className="cd-header-text">
                <h3 className="cd-title">{t("sftp.deleteTitle")}</h3>
                <p className="cd-subtitle">
                  {deleteDialog.entry.fileType === "directory"
                    ? t("sftp.deleteDir", { name: deleteDialog.entry.name })
                    : t("sftp.deleteFile", { name: deleteDialog.entry.name })}
                </p>
              </div>
            </div>
            {deleteDialog.entry.fileType === "directory" && (
              <div className="cd-warning-banner">
                {t("sftp.deleteRecursiveWarning")}
              </div>
            )}
            <div className="cd-actions">
              <Button variant="ghost" onClick={() => setDeleteDialog(null)}>
                {t("general.cancel")}
              </Button>
              <Button variant="danger" onClick={() => void handleDelete()}>
                {t("sftp.deleteTitle")}
              </Button>
            </div>
          </>
        )}
      </Dialog>


    </div>
  );
}
