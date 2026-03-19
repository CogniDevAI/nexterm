// features/sftp/FileViewer.tsx — Modal file viewer for SFTP text files (virtualized)

import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../../lib/i18n";
import type { FileContent } from "../../lib/types";

/* ─── Types ──────────────────────────────────────────── */

interface FileViewerProps {
  file: FileContent | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  /** Called when user wants to load the full file (no line limit) */
  onLoadFullFile?: () => void;
}

interface MatchPosition {
  line: number;
  startCol: number;
  endCol: number;
}

/* ─── Helpers ────────────────────────────────────────── */

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBinaryError(error: string): boolean {
  return /binary/i.test(error);
}

function isFileTooLargeError(error: string): boolean {
  return /too large/i.test(error);
}

/** Find all case-insensitive matches in lines array, returning positions per-line */
function findMatchesInLines(lines: string[], query: string): MatchPosition[] {
  if (!query || lines.length === 0) return [];
  const lowerQuery = query.toLowerCase();
  const matches: MatchPosition[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lowerLine = (lines[lineIdx] ?? "").toLowerCase();
    let col = 0;
    while (col <= lowerLine.length - lowerQuery.length) {
      const idx = lowerLine.indexOf(lowerQuery, col);
      if (idx === -1) break;
      matches.push({
        line: lineIdx,
        startCol: idx,
        endCol: idx + query.length,
      });
      col = idx + 1; // move past this match start to find overlapping matches
    }
  }
  return matches;
}

/** Build a Set of line indices that contain at least one match (for fast lookup) */
function buildMatchLineSet(matches: MatchPosition[]): Set<number> {
  const s = new Set<number>();
  for (const m of matches) s.add(m.line);
  return s;
}

/** Split a line into segments: plain text and match spans */
function renderLineWithMatches(
  lineText: string,
  lineIndex: number,
  matches: MatchPosition[],
  activeMatchIndex: number,
  allMatches: MatchPosition[],
): React.ReactNode[] {
  // Get matches for this line
  const lineMatches = matches.filter((m) => m.line === lineIndex);
  if (lineMatches.length === 0) return [lineText];

  const segments: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of lineMatches) {
    // Plain text before the match
    if (match.startCol > cursor) {
      segments.push(lineText.slice(cursor, match.startCol));
    }

    // Determine if this is the active match
    const globalIdx = allMatches.indexOf(match);
    const isActive = globalIdx === activeMatchIndex;

    segments.push(
      <mark
        key={`${lineIndex}-${match.startCol}`}
        className={`file-viewer-match${isActive ? " file-viewer-match-active" : ""}`}
        data-match-index={globalIdx}
      >
        {lineText.slice(match.startCol, match.endCol)}
      </mark>,
    );
    cursor = match.endCol;
  }

  // Trailing text after last match
  if (cursor < lineText.length) {
    segments.push(lineText.slice(cursor));
  }

  return segments;
}

/* ─── Component ──────────────────────────────────────── */

export function FileViewer({ file, loading, error, onClose, onLoadFullFile }: FileViewerProps) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  // Copy state
  const [copied, setCopied] = useState(false);

  // Lines — split once via useMemo, wrapped in startTransition to avoid blocking close
  const [lines, setLines] = useState<string[]>([]);
  const prevContentRef = useRef<string | null>(null);

  useEffect(() => {
    const content = file?.content ?? null;
    if (content === prevContentRef.current) return;
    prevContentRef.current = content;

    if (!content) {
      setLines([]);
      return;
    }

    // Use startTransition so the split doesn't block urgent updates (like closing)
    startTransition(() => {
      setLines(content.split("\n"));
    });
  }, [file?.content]);

  // ── Debounce search ─────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setActiveMatchIndex(0);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ── Compute matches (against lines array, not raw content) ──
  const matches = useMemo(() => {
    if (!debouncedQuery || lines.length === 0) return [];
    return findMatchesInLines(lines, debouncedQuery);
  }, [lines, debouncedQuery]);

  // Set of line indices with matches (fast lookup for visible lines)
  const matchLineSet = useMemo(() => buildMatchLineSet(matches), [matches]);

  // ── Virtualizer ─────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20, // ~20px for monospace 12px + line-height 1.6
    overscan: 20,
  });

  // ── Scroll active match into view via virtualizer ───
  useEffect(() => {
    if (matches.length === 0) return;
    const activeMatch = matches[activeMatchIndex];
    if (!activeMatch) return;
    virtualizer.scrollToIndex(activeMatch.line, { align: "center" });
  }, [activeMatchIndex, matches, virtualizer]);

  // ── Navigation helpers ──────────────────────────────
  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setActiveMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setActiveMatchIndex((prev) =>
      prev === 0 ? matches.length - 1 : prev - 1,
    );
  }, [matches.length]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setDebouncedQuery("");
    setActiveMatchIndex(0);
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd+F: open/focus search
      if (isMod && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        // Focus after state update
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      // Escape: close search if focused, otherwise close modal
      if (e.key === "Escape") {
        if (searchOpen) {
          closeSearch();
        } else {
          onClose();
        }
        return;
      }

      // Enter / Shift+Enter in search context
      if (
        searchOpen &&
        e.key === "Enter" &&
        document.activeElement === searchInputRef.current
      ) {
        e.preventDefault();
        if (e.shiftKey) {
          goToPrevMatch();
        } else {
          goToNextMatch();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, searchOpen, closeSearch, goToNextMatch, goToPrevMatch]);

  // ── Focus search input when bar opens ───────────────
  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  // ── Copy all to clipboard ───────────────────────────
  const handleCopyAll = useCallback(async () => {
    if (!file?.content) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: clipboard API may fail in some contexts
      console.warn("Clipboard write failed");
    }
  }, [file?.content]);

  // ── Close on overlay click ──────────────────────────
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  // ── Determine error variant ─────────────────────────
  const errorVariant = error
    ? isBinaryError(error)
      ? "binary"
      : isFileTooLargeError(error)
        ? "too-large"
        : "generic"
    : null;

  // ── Compute gutter width from line count ────────────
  const lineCountDigits = lines.length > 0 ? String(lines.length).length : 1;
  const gutterWidth = Math.max(40, lineCountDigits * 8 + 24);

  return (
    <div
      ref={overlayRef}
      className="file-viewer-overlay"
      onClick={handleOverlayClick}
    >
      <div className="file-viewer-modal">
        {/* ── Header ── */}
        <div className="file-viewer-header">
          <div className="file-viewer-header-info">
            <span className="file-viewer-filename">
              {file?.fileName ?? t("viewer.loading")}
            </span>
            {file && (
              <>
                <span className="file-viewer-meta">
                  {formatFileSize(file.fileSize)}
                </span>
                <span className="file-viewer-badge">{file.encoding}</span>
                {file.truncated && (
                  <span className="file-viewer-badge file-viewer-badge-warning">
                    truncated
                  </span>
                )}
              </>
            )}
          </div>
          <div className="file-viewer-header-actions">
            <button
              className="file-viewer-search-btn"
              onClick={() => {
                setSearchOpen(true);
                requestAnimationFrame(() => searchInputRef.current?.focus());
              }}
              title={t("viewer.searchPlaceholder")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
            <button className="file-viewer-close" onClick={onClose}>
              &times;
            </button>
          </div>
        </div>

        {/* ── Search Bar ── */}
        {searchOpen && (
          <div className="file-viewer-search-bar">
            <input
              ref={searchInputRef}
              type="text"
              className="file-viewer-search-input"
              placeholder={t("viewer.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
            />
            {debouncedQuery && (
              <span className="file-viewer-search-count">
                {matches.length > 0
                  ? t("viewer.matchCount", { current: activeMatchIndex + 1, total: matches.length })
                  : t("viewer.noMatches")}
              </span>
            )}
            <button
              className="file-viewer-search-nav"
              onClick={goToPrevMatch}
              disabled={matches.length === 0}
              title={t("viewer.prevMatch")}
            >
              &#x25B2;
            </button>
            <button
              className="file-viewer-search-nav"
              onClick={goToNextMatch}
              disabled={matches.length === 0}
              title={t("viewer.nextMatch")}
            >
              &#x25BC;
            </button>
            <button
              className="file-viewer-search-close"
              onClick={closeSearch}
              title={t("viewer.closeSearch")}
            >
              &times;
            </button>
          </div>
        )}

        {/* ── Truncated Banner ── */}
        {file?.truncated && !loading && !error && (
          <div className="file-viewer-truncated-banner">
            <span>
              {t("viewer.truncatedBanner", { lines: file.totalLines.toLocaleString() })}
            </span>
            {onLoadFullFile && (
              <button
                className="file-viewer-load-full-btn"
                onClick={onLoadFullFile}
              >
                {t("viewer.loadFull")}
              </button>
            )}
          </div>
        )}

        {/* ── Content Area ── */}
        <div className="file-viewer-content" ref={parentRef}>
          {loading && (
            <div className="file-viewer-state">
              <span className="spinner" style={{ width: 20, height: 20 }} />
              <span>{t("viewer.loading")}</span>
            </div>
          )}

          {error && errorVariant === "binary" && (
            <div className="file-viewer-state file-viewer-state-error">
              <svg
                width="24"
                height="24"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M3.75 1.5a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75ZM10 1.797l2.453 2.453H10V1.797ZM2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25V1.75Z" />
              </svg>
              <span>{t("viewer.binary")}</span>
            </div>
          )}

          {error && errorVariant === "too-large" && (
            <div className="file-viewer-state file-viewer-state-error">
              <svg
                width="24"
                height="24"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm9.22 3.72a.75.75 0 0 0 0 1.06L10.69 8 9.22 9.47a.75.75 0 1 0 1.06 1.06l2-2a.75.75 0 0 0 0-1.06l-2-2a.75.75 0 0 0-1.06 0ZM6.78 6.53 5.31 8l1.47 1.47a.75.75 0 0 1-1.06 1.06l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.06 1.06Z" />
              </svg>
              <div className="file-viewer-state-message">
                <span>
                  {t("viewer.tooLarge", { size: file ? formatFileSize(file.fileSize) : ">10MB" })}
                </span>
              </div>
            </div>
          )}

          {error && errorVariant === "generic" && (
            <div className="file-viewer-state file-viewer-state-error">
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && file && lines.length > 0 && (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                lineHeight: "1.6",
                whiteSpace: "pre",
                tabSize: 4,
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const lineNum = virtualRow.index;
                const lineContent = lines[lineNum] ?? "";
                const hasMatch = matchLineSet.has(lineNum);

                return (
                  <div
                    key={virtualRow.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="file-viewer-line"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <span
                      className="file-viewer-line-number"
                      style={{ width: gutterWidth }}
                    >
                      {lineNum + 1}
                    </span>
                    <span className="file-viewer-line-text">
                      {debouncedQuery && hasMatch
                        ? renderLineWithMatches(
                            lineContent,
                            lineNum,
                            matches,
                            activeMatchIndex,
                            matches,
                          )
                        : lineContent}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        {file && !loading && !error && (
          <div className="file-viewer-footer">
            <div className="file-viewer-footer-left">
              <span className="file-viewer-footer-stat">
                {file.totalLines.toLocaleString()} lines
              </span>
              <span className="file-viewer-footer-hint">
                {navigator.platform.includes("Mac") ? "\u2318F" : "Ctrl+F"} to search
              </span>
            </div>
            <button
              className="file-viewer-copy-btn"
              onClick={handleCopyAll}
            >
              {copied ? t("viewer.copied") : t("viewer.copyAll")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
