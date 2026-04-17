// features/sftp/FilePane.tsx — Single file listing pane (used for both local and remote)
//
// Shows: PathBar (nav + always-editable path input), sortable table columns,
// file rows with icons, loading state, empty state, error state.
// Supports keyboard navigation: Arrow Up/Down, Enter, Backspace.

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Spinner } from "../../components/ui/Spinner";
import { PathBar } from "./PathBar";
import { useI18n } from "../../lib/i18n";
import type { FileEntry, SearchResult } from "../../lib/types";
import type { PaneSource, SortConfig, SortField, FileAction } from "./sftp.types";

export type SearchMode = "filter" | "search";

interface FilePaneProps {
  source: PaneSource;
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  onNavigate: (path: string) => void;
  onNavigateUp: () => void;
  onRefresh: () => void;
  onContextMenu?: (e: React.MouseEvent, entry: FileEntry | null) => void;
  selectedEntries?: Set<string>;
  onSelectionChange?: (selected: Set<string>) => void;
  // File actions (open, etc.)
  onFileAction?: (action: FileAction) => void;
  // Drag and drop
  onDragStart?: (entries: FileEntry[]) => void;
  onDrop?: (entries: FileEntry[]) => void;
  // Search (remote pane only)
  searchMode?: SearchMode;
  searchQuery?: string;
  searchResults?: SearchResult[];
  searchLoading?: boolean;
  onSearchQueryChange?: (query: string) => void;
  onSearchModeChange?: (mode: SearchMode) => void;
  onSearchSubmit?: () => void;
  onSearchClear?: () => void;
  // Navigation history (for PathBar)
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onGoHome?: () => void;
  // Focus management (PR3)
  isFocused?: boolean;
  onPaneFocus?: () => void;
  // Per-pane toolbar actions
  onTransfer?: () => void;
  onNewFolder?: () => void;
  selectedCount?: number;
}

// ─── Utilities ──────────────────────────────────────────

/** Check if an entry is navigable (directory or symlink pointing to a directory). */
function isNavigable(entry: FileEntry): boolean {
  return entry.fileType === "directory" ||
    (entry.fileType === "symlink" && entry.linkTarget === "directory");
}

function getFileIcon(entry: FileEntry): string {
  if (entry.fileType === "directory") return "\u{1F4C1}";
  if (entry.fileType === "symlink") {
    // Symlink to directory: folder with link overlay
    if (entry.linkTarget === "directory") return "\u{1F4C2}";
    // Broken symlink
    if (entry.linkTarget === "broken") return "\u26D3\uFE0F";
    // Symlink to file: link icon
    return "\u{1F517}";
  }
  // File type detection by extension
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "svg", "webp", "ico"].includes(ext)) return "\u{1F5BC}";
  if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "\u{1F3B5}";
  if (["mp4", "mkv", "avi", "mov", "webm"].includes(ext)) return "\u{1F3AC}";
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(ext)) return "\u{1F4E6}";
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "rb", "java", "c", "cpp", "h"].includes(ext)) return "\u{1F4DD}";
  return "\u{1F4C4}";
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return "\u2014";
  const date = new Date(timestamp * 1000);
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function sortEntries(entries: FileEntry[], sort: SortConfig): FileEntry[] {
  const sorted = [...entries];
  const dir = sort.direction === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    // Directories (and symlinks to directories) always first
    const aIsDir = isNavigable(a);
    const bIsDir = isNavigable(b);
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;

    switch (sort.field) {
      case "name":
        return dir * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      case "size":
        return dir * (a.size - b.size);
      case "modified":
        return dir * ((a.modified ?? 0) - (b.modified ?? 0));
      case "permissions":
        return dir * a.permissionsStr.localeCompare(b.permissionsStr);
      default:
        return 0;
    }
  });

  return sorted;
}

// ─── Column Header ──────────────────────────────────────

function ColumnHeader({
  label,
  field,
  sort,
  onSort,
  className,
}: {
  label: string;
  field: SortField;
  sort: SortConfig;
  onSort: (field: SortField) => void;
  className?: string;
}) {
  const isActive = sort.field === field;
  const arrow = isActive ? (sort.direction === "asc" ? " \u25B2" : " \u25BC") : "";
  return (
    <div
      className={`sftp-col-header ${className ?? ""} ${isActive ? "sftp-col-active" : ""}`}
      onClick={() => onSort(field)}
    >
      {label}
      {arrow}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────

export function FilePane({
  source,
  path,
  entries,
  loading,
  error,
  onNavigate,
  onNavigateUp,
  onRefresh,
  onContextMenu,
  selectedEntries,
  onSelectionChange,
  onFileAction,
  onDragStart,
  onDrop,
  searchMode,
  searchQuery,
  searchResults,
  searchLoading,
  onSearchQueryChange,
  onSearchModeChange,
  onSearchSubmit,
  onSearchClear,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onGoHome,
  isFocused,
  onPaneFocus,
  onTransfer,
  onNewFolder,
  selectedCount,
}: FilePaneProps) {
  const { t } = useI18n();
  const [sort, setSort] = useState<SortConfig>({
    field: "name",
    direction: "asc",
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tableBodyRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [typeSearchQuery, setTypeSearchQuery] = useState("");
  const typeSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSort = useCallback((field: SortField) => {
    setSort((prev) => ({
      field,
      direction: prev.field === field && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  // Apply local filter when in filter mode
  const filteredEntries = useMemo(() => {
    if (!searchQuery || searchMode !== "filter") return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, searchQuery, searchMode]);

  const sortedEntries = useMemo(() => sortEntries(filteredEntries, sort), [filteredEntries, sort]);

  // Focus search input on Ctrl+F / Cmd+F
  useEffect(() => {
    if (!onSearchQueryChange) return; // only for panes with search enabled
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSearchQueryChange]);

  // Reset focusedIndex and type-search when navigating to a new directory
  useEffect(() => {
    setFocusedIndex(-1);
    setTypeSearchQuery("");
  }, [path]);

  // Clean up type-search timeout on unmount
  useEffect(() => {
    return () => {
      if (typeSearchTimeoutRef.current) clearTimeout(typeSearchTimeoutRef.current);
    };
  }, []);

  // ─── Keyboard Navigation (PR3) ───────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Don't handle keyboard nav when search/filter input is focused
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const items = sortedEntries;
      if (items.length === 0) return;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setTypeSearchQuery("");
          const nextIdx = Math.min(focusedIndex + 1, items.length - 1);
          setFocusedIndex(nextIdx);
          const entry = items[nextIdx];
          if (entry && onSelectionChange) {
            onSelectionChange(new Set([entry.path]));
          }
          // Scroll into view
          const row = tableBodyRef.current?.children[nextIdx] as HTMLElement | undefined;
          row?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          setTypeSearchQuery("");
          const prevIdx = Math.max(focusedIndex - 1, 0);
          setFocusedIndex(prevIdx);
          const entry = items[prevIdx];
          if (entry && onSelectionChange) {
            onSelectionChange(new Set([entry.path]));
          }
          const row = tableBodyRef.current?.children[prevIdx] as HTMLElement | undefined;
          row?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "Enter": {
          e.preventDefault();
          setTypeSearchQuery("");
          const entry = items[focusedIndex];
          if (!entry) return;
          if (isNavigable(entry)) {
            onNavigate(entry.path);
          } else if (
            entry.fileType === "file" ||
            (entry.fileType === "symlink" && entry.linkTarget === "file")
          ) {
            onFileAction?.({ type: "open", entry });
          }
          break;
        }
        case "Escape": {
          if (typeSearchQuery) {
            e.preventDefault();
            setTypeSearchQuery("");
          }
          break;
        }
        case "Backspace": {
          e.preventDefault();
          if (typeSearchQuery) {
            setTypeSearchQuery((prev) => prev.slice(0, -1));
          } else {
            onNavigateUp();
          }
          break;
        }
        default: {
          // Type-to-search: single printable characters (not modifier combos)
          if (
            e.key.length === 1 &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            /^[a-zA-Z0-9\-._\s]$/.test(e.key)
          ) {
            e.preventDefault();
            const nextQuery = typeSearchQuery + e.key;
            setTypeSearchQuery(nextQuery);

            // Reset auto-clear timeout
            if (typeSearchTimeoutRef.current) clearTimeout(typeSearchTimeoutRef.current);
            typeSearchTimeoutRef.current = setTimeout(() => {
              setTypeSearchQuery("");
              typeSearchTimeoutRef.current = null;
            }, 1500);

            // Find first matching entry (case-insensitive prefix match)
            const lowerQuery = nextQuery.toLowerCase();
            const matchIdx = items.findIndex((item) =>
              item.name.toLowerCase().startsWith(lowerQuery),
            );
            if (matchIdx !== -1) {
              setFocusedIndex(matchIdx);
              const matchedEntry = items[matchIdx];
              if (matchedEntry && onSelectionChange) {
                onSelectionChange(new Set([matchedEntry.path]));
              }
              const row = tableBodyRef.current?.children[matchIdx] as HTMLElement | undefined;
              row?.scrollIntoView({ block: "nearest" });
            }
          }
          break;
        }
      }
    },
    [sortedEntries, focusedIndex, typeSearchQuery, onSelectionChange, onNavigate, onNavigateUp, onFileAction],
  );

  // Whether we're showing search results (recursive mode with results)
  const showSearchResults = searchMode === "search" && searchResults && searchResults.length > 0 && !searchLoading;

  const handleRowClick = useCallback(
    (entry: FileEntry, e: React.MouseEvent) => {
      if (!onSelectionChange) return;

      if (e.ctrlKey || e.metaKey) {
        // Toggle selection
        const next = new Set(selectedEntries);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }
        onSelectionChange(next);
      } else if (e.shiftKey && selectedEntries && selectedEntries.size > 0) {
        // Range selection
        const lastSelected = Array.from(selectedEntries).pop();
        if (!lastSelected) {
          onSelectionChange(new Set([entry.path]));
          return;
        }
        const lastIdx = sortedEntries.findIndex((e) => e.path === lastSelected);
        const curIdx = sortedEntries.findIndex((e2) => e2.path === entry.path);
        const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        const next = new Set(selectedEntries);
        for (let i = start; i <= end; i++) {
          const e = sortedEntries[i];
          if (e) next.add(e.path);
        }
        onSelectionChange(next);
      } else {
        onSelectionChange(new Set([entry.path]));
      }
    },
    [selectedEntries, onSelectionChange, sortedEntries],
  );

  const handleRowDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (isNavigable(entry)) {
        onNavigate(entry.path);
      } else if (entry.fileType === "file" || (entry.fileType === "symlink" && entry.linkTarget === "file")) {
        onFileAction?.({ type: "open", entry });
      }
    },
    [onNavigate, onFileAction],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, entry: FileEntry) => {
      if (!onDragStart) return;
      const selected = selectedEntries && selectedEntries.has(entry.path)
        ? sortedEntries.filter((en) => selectedEntries.has(en.path))
        : [entry];
      e.dataTransfer.setData("text/plain", JSON.stringify(selected.map((s) => s.path)));
      e.dataTransfer.effectAllowed = "copy";
      onDragStart(selected);
    },
    [onDragStart, selectedEntries, sortedEntries],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!onDrop) return;
      try {
        const paths: string[] = JSON.parse(e.dataTransfer.getData("text/plain"));
        // The actual entries need to come from the other pane — 
        // SftpBrowser will handle the cross-pane logic.
        // We pass a synthetic FileEntry array with paths.
        const syntheticEntries: FileEntry[] = paths.map((p) => ({
          name: p.split("/").pop() ?? p,
          path: p,
          fileType: "file" as const,
          size: 0,
          permissions: 0,
          permissionsStr: "",
          modified: null,
          accessed: null,
          owner: null,
          group: null,
        }));
        onDrop(syntheticEntries);
      } catch {
        // Invalid drag data
      }
    },
    [onDrop],
  );

  // Handle search result double-click: navigate to containing directory
  const handleSearchResultDoubleClick = useCallback(
    (result: SearchResult) => {
      if (result.fileType === "directory") {
        onNavigate(result.path);
        onSearchClear?.();
      } else {
        // Navigate to the file's parent directory
        const parentDir = result.path.replace(/\/[^/]+$/, "") || "/";
        onNavigate(parentDir);
        onSearchClear?.();
        // Also open the file in the viewer
        onFileAction?.({
          type: "open",
          entry: {
            name: result.fileName,
            path: result.path,
            fileType: "file",
            size: result.size,
            permissions: 0,
            permissionsStr: "",
            modified: null,
            accessed: null,
            owner: null,
            group: null,
          },
        });
      }
    },
    [onNavigate, onSearchClear, onFileAction],
  );

  const hasSearch = !!onSearchQueryChange;

  return (
    <div
      className={`sftp-pane ${isFocused ? "sftp-pane-focused" : ""}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e, null);
      }}
      onClick={onPaneFocus}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Header */}
      <div className="sftp-pane-header">
        <span className="sftp-pane-label">
          {source === "local" ? t("sftp.local") : t("sftp.remote")}
        </span>
        <div className="sftp-pane-actions">
          <button
            className="sftp-icon-btn"
            onClick={onNavigateUp}
            title={t("sftp.goUp")}
            disabled={!path || path === "/"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
          </button>
          <button
            className={`sftp-icon-btn sftp-action-btn ${!onTransfer || !selectedCount ? "" : "sftp-action-btn-active"}`}
            onClick={onTransfer ?? undefined}
            title={source === "local" ? t("sftp.uploadTitle") : t("sftp.downloadTitle")}
            disabled={!onTransfer || !selectedCount}
          >
            {source === "local" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            )}
          </button>
          <button className="sftp-icon-btn" onClick={onRefresh} title={t("sftp.refresh")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          {(source === "remote" && onNewFolder) && (
            <button
              className="sftp-icon-btn"
              onClick={onNewFolder}
              title={t("sftp.newFolderTitle")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
            </button>
          )}
        </div>
      </div>

      {/* PathBar (nav buttons + always-editable path input) */}
      {path && !showSearchResults && (
        <PathBar
          source={source}
          path={path}
          onNavigate={onNavigate}
          canGoBack={canGoBack ?? false}
          canGoForward={canGoForward ?? false}
          onGoBack={onGoBack ?? (() => {})}
          onGoForward={onGoForward ?? (() => {})}
          onGoHome={onGoHome ?? (() => {})}
        />
      )}

      {/* Search Bar (remote pane only) */}
      {hasSearch && (
        <div className="sftp-search-bar">
          <div className="sftp-search-input-wrap">
            <span className="sftp-search-icon">{"\uD83D\uDD0D"}</span>
            <input
              ref={searchInputRef}
              className="sftp-search-input"
              type="text"
              placeholder={searchMode === "search" ? t("sftp.searchRecursive") : t("sftp.filterByName")}
              value={searchQuery ?? ""}
              onChange={(e) => onSearchQueryChange?.(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchMode === "search") {
                  onSearchSubmit?.();
                }
                if (e.key === "Escape") {
                  onSearchClear?.();
                }
              }}
            />
            {searchQuery && (
              <button
                className="sftp-search-clear"
                onClick={onSearchClear}
                title={t("sftp.clearSearch")}
              >
                {"\u2715"}
              </button>
            )}
          </div>
          <div className="sftp-search-mode-toggle">
            <button
              className={`sftp-search-mode-btn ${searchMode === "filter" ? "sftp-search-mode-active" : ""}`}
              onClick={() => onSearchModeChange?.("filter")}
              title={t("sftp.filter")}
            >
              {t("sftp.filter")}
            </button>
            <button
              className={`sftp-search-mode-btn ${searchMode === "search" ? "sftp-search-mode-active" : ""}`}
              onClick={() => onSearchModeChange?.("search")}
              title={t("sftp.search")}
            >
              {t("sftp.search")}
            </button>
          </div>
          {/* Match count for filter mode */}
          {searchMode === "filter" && searchQuery && (
            <span className="sftp-search-count">
              {filteredEntries.length} of {entries.length} files
            </span>
          )}
          {/* Result count for search mode */}
          {searchMode === "search" && searchResults && !searchLoading && (
            <span className="sftp-search-count">
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}

      {/* Search results view (recursive mode) */}
      {showSearchResults ? (
        <>
          <div className="sftp-table-header">
            <div className="sftp-col-header sftp-col-name">{t("sftp.colName")}</div>
            <div className="sftp-col-header sftp-col-size">{t("sftp.colSize")}</div>
          </div>
          <div className="sftp-table-body">
            {searchResults!.map((result) => (
              <div
                key={result.path}
                className="sftp-row"
                onDoubleClick={() => handleSearchResultDoubleClick(result)}
              >
                <div className="sftp-col-name">
                  <span className="sftp-file-icon">
                    {result.fileType === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}
                  </span>
                  <div className="sftp-search-result-name">
                    <span className="sftp-file-name" title={result.fileName}>
                      {result.fileName}
                    </span>
                    <span className="sftp-search-result-path" title={result.relativePath}>
                      {result.relativePath}
                    </span>
                  </div>
                </div>
                <div className="sftp-col-size">
                  {result.fileType === "directory" ? "\u2014" : formatSize(result.size)}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Column headers */}
          <div className="sftp-table-header">
            <ColumnHeader label={t("sftp.colName")} field="name" sort={sort} onSort={handleSort} className="sftp-col-name" />
            <ColumnHeader label={t("sftp.colSize")} field="size" sort={sort} onSort={handleSort} className="sftp-col-size" />
            <ColumnHeader label={t("sftp.colModified")} field="modified" sort={sort} onSort={handleSort} className="sftp-col-date" />
            <ColumnHeader label={t("sftp.colPerms")} field="permissions" sort={sort} onSort={handleSort} className="sftp-col-perms" />
          </div>

          {/* Content */}
          <div className="sftp-table-body" ref={tableBodyRef}>
            {(loading || searchLoading) && (
              <div className="sftp-state-message">
                <Spinner size={20} />
                <span>{searchLoading ? t("sftp.searching") : t("general.loading")}</span>
              </div>
            )}

            {error && !loading && (
              <div className="sftp-state-message sftp-state-error">
                <span>{error}</span>
                <button className="sftp-icon-btn" onClick={onRefresh}>
                  {t("sftp.retry")}
                </button>
              </div>
            )}

            {!loading && !searchLoading && !error && sortedEntries.length === 0 && (
              <div className="sftp-state-message">
                {searchQuery && searchMode === "filter"
                  ? t("sftp.noFilterMatch")
                  : searchMode === "search" && searchQuery
                    ? t("sftp.noSearchResults")
                    : t("sftp.emptyDir")}
              </div>
            )}

            {!loading &&
              !searchLoading &&
              !error &&
              sortedEntries.map((entry, idx) => {
                const isSelected = selectedEntries?.has(entry.path) ?? false;
                const isKeyboardFocused = idx === focusedIndex;
                return (
                  <div
                    key={entry.path}
                    className={`sftp-row ${isSelected ? "sftp-row-selected" : ""} ${isKeyboardFocused ? "sftp-row-focused" : ""}`}
                    onClick={(e) => handleRowClick(entry, e)}
                    onDoubleClick={() => handleRowDoubleClick(entry)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Select the entry if not already selected
                      if (!isSelected && onSelectionChange) {
                        onSelectionChange(new Set([entry.path]));
                      }
                      onContextMenu?.(e, entry);
                    }}
                    draggable={!!onDragStart}
                    onDragStart={(e) => handleDragStart(e, entry)}
                  >
                    <div className="sftp-col-name">
                      <span className="sftp-file-icon">{getFileIcon(entry)}</span>
                      <span className="sftp-file-name" title={entry.name}>
                        {entry.name}
                      </span>
                    </div>
                    <div className="sftp-col-size">
                      {isNavigable(entry) ? "\u2014" : formatSize(entry.size)}
                    </div>
                    <div className="sftp-col-date">{formatDate(entry.modified)}</div>
                    <div className="sftp-col-perms">
                      <span className="sftp-perms" title={`${entry.permissions.toString(8)}`}>
                        {entry.permissionsStr || "\u2014"}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* Type-to-search badge */}
      {typeSearchQuery && (
        <div
          className={`sftp-type-search-badge ${
            !sortedEntries.some((e) => e.name.toLowerCase().startsWith(typeSearchQuery.toLowerCase()))
              ? "sftp-type-search-badge-no-match"
              : ""
          }`}
        >
          {"\uD83D\uDD0D"}
          {typeSearchQuery}
        </div>
      )}
    </div>
  );
}
