// features/sftp/FilePane.tsx — Single file listing pane (used for both local and remote)
//
// Shows: breadcrumb path, sortable table columns, file rows with icons,
// loading state, empty state, error state.

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Spinner } from "../../components/ui/Spinner";
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

// ─── Breadcrumb ─────────────────────────────────────────

function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = path.split("/").filter(Boolean);

  return (
    <div className="sftp-breadcrumb">
      <button
        className="sftp-breadcrumb-segment sftp-breadcrumb-root"
        onClick={() => onNavigate("/")}
        title="Go to root"
      >
        /
      </button>
      {segments.map((segment, idx) => {
        const segPath = "/" + segments.slice(0, idx + 1).join("/");
        const isLast = idx === segments.length - 1;
        return (
          <span key={segPath}>
            <span className="sftp-breadcrumb-separator">{"\u203A"}</span>
            <button
              className={`sftp-breadcrumb-segment ${isLast ? "sftp-breadcrumb-current" : ""}`}
              onClick={() => !isLast && onNavigate(segPath)}
              disabled={isLast}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </div>
  );
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
}: FilePaneProps) {
  const { t } = useI18n();
  const [sort, setSort] = useState<SortConfig>({
    field: "name",
    direction: "asc",
  });
  const searchInputRef = useRef<HTMLInputElement>(null);

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
      className="sftp-pane"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e, null);
      }}
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
            {"\u2B06"}
          </button>
          <button className="sftp-icon-btn" onClick={onRefresh} title={t("sftp.refresh")}>
            {"\u21BB"}
          </button>
        </div>
      </div>

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

      {/* Breadcrumb */}
      {path && !showSearchResults && <Breadcrumb path={path} onNavigate={onNavigate} />}

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
          <div className="sftp-table-body">
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
              sortedEntries.map((entry) => {
                const isSelected = selectedEntries?.has(entry.path) ?? false;
                return (
                  <div
                    key={entry.path}
                    className={`sftp-row ${isSelected ? "sftp-row-selected" : ""}`}
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
    </div>
  );
}
