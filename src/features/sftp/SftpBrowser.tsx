// features/sftp/SftpBrowser.tsx — Dual-pane SFTP file browser
//
// Left pane: local filesystem. Right pane: remote SFTP.
// Toolbar with common actions. Wires up useSftp hook.

import { useCallback, useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { FilePane, type SearchMode } from "./FilePane";
import { TransferOverlay } from "./TransferOverlay";
import { FileContextMenu } from "./FileContextMenu";
import { FileViewer } from "./FileViewer";
import { useSftp } from "./useSftp";
import { Spinner } from "../../components/ui/Spinner";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../lib/i18n";
import type { SessionId, FileEntry, FileContent, SearchResult, TransferEvent } from "../../lib/types";
import type { PaneSource, FileAction } from "./sftp.types";

interface SftpBrowserProps {
  sessionId: SessionId;
}

export function SftpBrowser({ sessionId }: SftpBrowserProps) {
  const { t } = useI18n();
  const sftp = useSftp(sessionId);

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

  // Large file confirmation
  const [largeFileConfirm, setLargeFileConfirm] = useState<{
    entry: FileEntry;
    size: string;
  } | null>(null);

  // File viewer state
  const [viewerFile, setViewerFile] = useState<FileContent | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

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

  // Cancellation: monotonic counter so stale readFile results are discarded
  const viewerRequestIdRef = useRef(0);
  // Track the remote path of the currently-viewed file (for "Load Full File")
  const viewerPathRef = useRef<string | null>(null);

  // Cleanup too-large timer on unmount
  useEffect(() => {
    return () => {
      if (tooLargeTimerRef.current) clearTimeout(tooLargeTimerRef.current);
    };
  }, []);

  // Search state
  const [searchMode, setSearchMode] = useState<SearchMode>("filter");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Resizable split
  const [splitPosition, setSplitPosition] = useState(50); // percentage
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  // ─── Initialize SFTP on mount ─────────────────────────

  useEffect(() => {
    void sftp.initSftp();
  }, [sftp.initSftp]);

  // Load initial directories once SFTP is ready
  useEffect(() => {
    if (sftp.sftpInitialized) {
      // Load remote home directory using the path returned by sftp_open (H2 fix)
      if (!sftp.remotePane.path && sftp.remoteHome) {
        void sftp.listRemoteDir(sftp.remoteHome);
      }
      // Load local home directory (use Tauri path API for cross-platform support)
      if (!sftp.localPane.path) {
        void homeDir()
          .then((home) => sftp.listLocalDir(home))
          .catch(() => sftp.listLocalDir("/"));
      }
    }
  }, [sftp.sftpInitialized, sftp.remoteHome, sftp.remotePane.path, sftp.localPane.path, sftp.listRemoteDir, sftp.listLocalDir]);

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

  // ─── File Open Helper ──────────────────────────────────

  /** Default initial load: first 1000 lines for instant preview */
  const INITIAL_MAX_LINES = 1000;

  const openFile = useCallback(
    (entry: FileEntry, maxLines?: number) => {
      const requestId = ++viewerRequestIdRef.current;
      viewerPathRef.current = entry.path;
      setViewerFile(null);
      setViewerError(null);
      setViewerLoading(true);
      sftp
        .readFile(entry.path, maxLines ?? INITIAL_MAX_LINES)
        .then((content) => {
          // Discard result if viewer was closed or a newer request was made
          if (viewerRequestIdRef.current !== requestId) return;
          setViewerFile(content);
        })
        .catch((err) => {
          if (viewerRequestIdRef.current !== requestId) return;
          const message = err instanceof Error ? err.message : String(err);
          setViewerError(message);
        })
        .finally(() => {
          if (viewerRequestIdRef.current !== requestId) return;
          setViewerLoading(false);
        });
    },
    [sftp],
  );

  const handleLargeFileConfirm = useCallback(() => {
    if (largeFileConfirm) {
      openFile(largeFileConfirm.entry);
    }
    setLargeFileConfirm(null);
  }, [largeFileConfirm, openFile]);

  // ─── File Actions ─────────────────────────────────────

  const handleFileAction = useCallback(
    async (action: FileAction) => {
      closeContextMenu();

      switch (action.type) {
        case "open": {
          if (!action.entry || action.entry.fileType !== "file") return;
          const entry = action.entry;
          const fileSize = entry.size;
          const FIFTEEN_MB = 15 * 1024 * 1024;
          const FIVE_MB = 5 * 1024 * 1024;
          const sizeMB = `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

          // >15MB — download to temp + open with system default app
          if (fileSize > FIFTEEN_MB) {
            const extFileName = entry.name;

            // Show progress bar during download
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
            return;
          }

          // 5-15MB — show confirmation dialog
          if (fileSize > FIVE_MB) {
            setLargeFileConfirm({ entry, size: sizeMB });
            return;
          }

          // <5MB — open directly
          openFile(entry);
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
          void sftp.downloadFile(action.entry.path, localDest);
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
        case "openExternal": {
          if (!action.entry) return;
          const externalEntry = action.entry;
          const extFileName = externalEntry.name;

          // Show progress bar during download
          setExternalDownload({
            fileName: extFileName,
            bytesTransferred: 0,
            totalBytes: externalEntry.size || 0,
            label: t("sftp.downloadingProgress", { name: extFileName }),
          });

          sftp
            .openExternal(externalEntry.path, extFileName, (event: TransferEvent) => {
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
                  // Show error in banner briefly
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
    [sftp, contextMenu, closeContextMenu],
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

  const handleViewerClose = useCallback(() => {
    // Bump requestId so any in-flight readFile result is discarded
    viewerRequestIdRef.current++;
    viewerPathRef.current = null;
    setViewerFile(null);
    setViewerLoading(false);
    setViewerError(null);
  }, []);

  /** Re-read the current file without line limit (full content up to 50K lines, max 15MB) */
  const handleLoadFullFile = useCallback(() => {
    const path = viewerPathRef.current;
    if (!path) return;
    const requestId = ++viewerRequestIdRef.current;
    setViewerLoading(true);
    setViewerError(null);
    sftp
      .readFile(path, undefined)
      .then((content) => {
        if (viewerRequestIdRef.current !== requestId) return;
        setViewerFile(content);
      })
      .catch((err) => {
        if (viewerRequestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setViewerError(message);
      })
      .finally(() => {
        if (viewerRequestIdRef.current !== requestId) return;
        setViewerLoading(false);
      });
  }, [sftp]);

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
    // Download all selected remote files to local
    for (const path of remoteSelected) {
      const entry = sftp.remotePane.entries.find((e) => e.path === path);
      if (entry && (entry.fileType === "file" || (entry.fileType === "symlink" && entry.linkTarget === "file"))) {
        const localDest = sftp.localPane.path + "/" + entry.name;
        void sftp.downloadFile(entry.path, localDest);
      }
    }
  }, [remoteSelected, sftp]);

  // ─── Drag & Drop between panes ────────────────────────

  const handleLocalDrop = useCallback(
    (entries: FileEntry[]) => {
      // Dropped from remote → download
      for (const entry of entries) {
        const localDest = sftp.localPane.path + "/" + entry.name;
        void sftp.downloadFile(entry.path, localDest);
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
      {/* Toolbar */}
      <div className="sftp-toolbar">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleUpload}
          disabled={localSelected.size === 0}
          title={t("sftp.uploadTitle")}
        >
          {"\u2B06"} {t("sftp.upload")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDownload}
          disabled={remoteSelected.size === 0}
          title={t("sftp.downloadTitle")}
        >
          {"\u2B07"} {t("sftp.download")}
        </Button>
        <div className="sftp-toolbar-separator" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            sftp.refreshLocal();
            sftp.refreshRemote();
          }}
          title={t("sftp.refreshTitle")}
        >
          {"\u21BB"} {t("sftp.refresh")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setNewFolderDialog({ source: "remote" });
            setNewFolderName("");
          }}
          title={t("sftp.newFolderTitle")}
        >
          + {t("sftp.newFolder")}
        </Button>
      </div>

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
        <div className="sftp-pane-container" style={{ width: `${splitPosition}%` }}>
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
            onFileAction={handleFileAction}
            onDragStart={() => {}}
            onDrop={handleLocalDrop}
          />
        </div>

        {/* Resize handle */}
        <div className="sftp-split-handle" onMouseDown={handleSplitMouseDown} />

        <div className="sftp-pane-container" style={{ width: `${100 - splitPosition}%` }}>
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
            searchMode={searchMode}
            searchQuery={searchQuery}
            searchResults={searchResults}
            searchLoading={searchLoading}
            onSearchQueryChange={handleSearchQueryChange}
            onSearchModeChange={handleSearchModeChange}
            onSearchSubmit={handleSearchSubmit}
            onSearchClear={handleSearchClear}
          />
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
          onAction={handleFileAction}
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

      {/* Large File Confirmation */}
      <Dialog
        open={largeFileConfirm !== null}
        onClose={() => setLargeFileConfirm(null)}
        title=""
        width="420px"
      >
        {largeFileConfirm && (
          <>
            <div className="cd-header">
              <div className="cd-header-icon cd-header-icon-warning">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div className="cd-header-text">
                <h3 className="cd-title">{t("sftp.largeFileTitle")}</h3>
                <p className="cd-subtitle">
                  {t("sftp.largeFileMessage", { size: largeFileConfirm.size })}
                </p>
              </div>
            </div>
            <div className="cd-actions">
              <Button
                variant="ghost"
                onClick={() => setLargeFileConfirm(null)}
                autoFocus
              >
                {t("general.cancel")}
              </Button>
              <Button onClick={handleLargeFileConfirm}>{t("sftp.openAnyway")}</Button>
            </div>
          </>
        )}
      </Dialog>

      {/* File Viewer */}
      {(viewerFile || viewerLoading || viewerError) && (
        <FileViewer
          file={viewerFile}
          loading={viewerLoading}
          error={viewerError}
          onClose={handleViewerClose}
          onLoadFullFile={handleLoadFullFile}
        />
      )}
    </div>
  );
}
