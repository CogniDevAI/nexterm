// features/terminal/FindBar.tsx — Find-bar overlay for in-terminal search
//
// Purely presentational: receives state via props, emits actions via callbacks.
// Opened by TerminalView when Cmd/Ctrl+F is detected via attachCustomKeyEventHandler.

import { useRef, useEffect } from "react";
import { useI18n } from "../../lib/i18n";
import "../../styles/terminal.css";

interface FindBarProps {
  /** Current search query string */
  query: string;
  /** Whether search is case-sensitive */
  caseSensitive: boolean;
  /** 1-based index of the active match (0 = no active match) */
  matchCurrent: number;
  /** Total number of matches in the terminal */
  matchTotal: number;
  /** Called when the user types in the search input */
  onQueryChange: (value: string) => void;
  /** Called when the user toggles case sensitivity */
  onToggleCase: () => void;
  /** Navigate to the previous match */
  onPrev: () => void;
  /** Navigate to the next match */
  onNext: () => void;
  /** Close the find-bar and return focus to the terminal */
  onClose: () => void;
}

export function FindBar({
  query,
  caseSensitive,
  matchCurrent,
  matchTotal,
  onQueryChange,
  onToggleCase,
  onPrev,
  onNext,
  onClose,
}: FindBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when the bar mounts
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasQuery = query.length > 0;
  const hasMatches = matchTotal > 0;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
    }
  }

  return (
    <div className="terminal-find-bar" role="search">
      <input
        ref={inputRef}
        type="text"
        className="terminal-find-input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("terminal.find.placeholder")}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-form-type="other"
        data-lpignore="true"
      />

      {hasQuery && (
        <span className="terminal-find-count">
          {hasMatches
            ? t("terminal.find.matchCount", { current: matchCurrent, total: matchTotal })
            : t("terminal.find.noMatches")}
        </span>
      )}

      <button
        className="terminal-find-case"
        onClick={onToggleCase}
        title={t("terminal.find.caseToggle")}
        aria-pressed={caseSensitive}
      >
        Aa
      </button>

      <button
        className="terminal-find-nav"
        onClick={onPrev}
        disabled={!hasMatches}
        title={t("terminal.find.prevMatch")}
      >
        &#x25B2;
      </button>

      <button
        className="terminal-find-nav"
        onClick={onNext}
        disabled={!hasMatches}
        title={t("terminal.find.nextMatch")}
      >
        &#x25BC;
      </button>

      <button
        className="terminal-find-close"
        onClick={onClose}
        title={t("terminal.find.closeSearch")}
      >
        &times;
      </button>
    </div>
  );
}
