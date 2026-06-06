// features/terminal/TerminalView.tsx — Single terminal instance view
//
// Wraps an xterm.js terminal element and wires it to the useTerminal hook.
// Hosts the find-bar overlay (opened via Cmd/Ctrl+F through the xterm key handler).

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionId, TerminalId } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { useSessionStore } from "../../stores/sessionStore";
import { useTerminal } from "./useTerminal";
import {
  registerFindBarOpener,
  unregisterFindBarOpener,
  registerPasteHandler,
  unregisterPasteHandler,
  registerSearchResultsCallback,
  unregisterSearchResultsCallback,
  findNextInTerminal,
  findPrevInTerminal,
} from "./useTerminal";
import type { SearchResults } from "./useTerminal";
import { FindBar } from "./FindBar";
import { Dialog } from "../../components/ui/Dialog";
import { isRiskyPaste, countCommandLines } from "./pasteSafety";
import { tauriInvoke } from "../../lib/tauri";
import "../../styles/terminal.css";
import "@xterm/xterm/css/xterm.css";

/** Shared search options — MUST be passed to every findNext/findPrevious call.
 *  Decorations are required for onDidChangeResults to fire. Colors are concrete
 *  hex/rgba strings (xterm cannot resolve CSS var() references). */
function buildSearchOptions(caseSensitive: boolean) {
  return {
    caseSensitive,
    decorations: {
      // Non-active matches: warm amber wash
      matchBackground: "rgba(212,160,58,0.25)",
      matchBorder: "rgba(212,160,58,0.55)",
      matchOverviewRuler: "#d4a03a",
      // Active match: copper accent (#ea9e51 from LAMPLIGHT/DARK cursor)
      activeMatchBackground: "rgba(234,158,81,0.45)",
      activeMatchBorder: "rgba(234,158,81,0.90)",
      activeMatchColorOverviewRuler: "#ea9e51",
    },
  } as const;
}

interface TerminalViewProps {
  sessionId: SessionId;
  terminalId: TerminalId | null;
  /** Called when a new terminal tab has been opened */
  onTerminalOpened: (terminalId: TerminalId) => void;
  /** Whether this terminal tab is currently visible */
  active: boolean;
  /**
   * When true the terminal is inside a split-pane grid.
   * Split panes are ALWAYS visible (display:block) — the display:none
   * hide/show for inactive tabs is disabled. The `active` prop then only
   * drives focus (the terminal receives focus when it becomes the active pane)
   * and the focus-ring CSS class.
   *
   * When false/absent (default), single-terminal mode is preserved exactly
   * as today: display:block when active, display:none when inactive.
   */
  isSplitPane?: boolean;
  /**
   * Stable React key forwarded from the owning component. When provided,
   * the key is used to avoid unnecessary remounts (same as TerminalTab.reactKey).
   * If omitted, the parent must ensure stable keying externally.
   */
  reactKey?: string;
}

export function TerminalView({
  sessionId,
  terminalId,
  onTerminalOpened,
  active,
  isSplitPane = false,
}: TerminalViewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const { openTerminal, focusTerminal, reattachTerminal } = useTerminal();

  // a11y: announce connection-state changes to assistive technology.
  // Subscribe to this session's state so the polite live region updates as the
  // session moves through connecting → connected → disconnected/error.
  const sessionState = useSessionStore(
    (s) => s.sessions.get(sessionId)?.state ?? "disconnected",
  );
  const statusMessage =
    typeof sessionState === "string"
      ? t(`terminal.status.${sessionState}`)
      : t("terminal.status.error");
  const initializedRef = useRef(false);
  const attachedRef = useRef(false);

  // Track the terminalId we registered the opener for (to unregister on unmount)
  const registeredTerminalIdRef = useRef<TerminalId | null>(null);

  // Find-bar state
  const [findBarOpen, setFindBarOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchCurrent, setMatchCurrent] = useState(0);
  const [matchTotal, setMatchTotal] = useState(0);

  // Paste guard (pastejacking protection): when a right-click paste contains an
  // embedded newline / control char it could run multiple commands the instant
  // it reaches the shell. We hold the pending clipboard text here and ask the
  // user to confirm before writing it to the PTY.
  const [pendingPaste, setPendingPaste] = useState<{
    text: string;
    lineCount: number;
  } | null>(null);

  // Helper: register find-bar opener, paste handler, and search results callback
  // for a given terminalId
  const registerOpener = useCallback((id: TerminalId) => {
    registerFindBarOpener(id, () => setFindBarOpen(true));
    // Risky paste handler: keyboard / middle-click pastes flagged by isRiskyPaste
    // in useTerminal are routed here so they go through the SAME confirmation
    // dialog as right-click paste instead of auto-executing in the shell.
    registerPasteHandler(id, (text: string) => {
      setPendingPaste({ text, lineCount: countCommandLines(text) });
    });
    registerSearchResultsCallback(id, (r: SearchResults) => {
      // resultIndex is -1 when there are no matches or when the decoration threshold
      // has been exceeded. Display 1-based: current = resultIndex + 1 (0 when -1).
      setMatchCurrent(r.resultIndex < 0 ? 0 : r.resultIndex + 1);
      setMatchTotal(r.resultCount);
    });
    registeredTerminalIdRef.current = id;
  }, []);

  // Open terminal on mount if no terminalId yet (pending tab)
  useEffect(() => {
    if (terminalId || initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;

    void openTerminal(containerRef.current, sessionId).then((id) => {
      attachedRef.current = true;
      registerOpener(id);
      onTerminalOpened(id);
    });
  }, [sessionId, terminalId, openTerminal, onTerminalOpened, registerOpener]);

  // Re-attach existing xterm.js instance to new container on remount.
  //
  // When the user switches sessions, React unmounts and remounts TerminalView
  // components (different session → different terminal tabs → different keys).
  // The xterm.js Terminal is still alive in the module-level `terminalInstances`
  // Map, but its DOM was destroyed with the old container. This effect moves
  // the terminal DOM into the fresh container so it renders again.
  useEffect(() => {
    if (!terminalId || attachedRef.current || !containerRef.current) return;
    const container = containerRef.current;
    void reattachTerminal(terminalId, container).then((didReattach) => {
      if (didReattach) {
        attachedRef.current = true;
        // Re-register find-bar opener and search results callback after reattach
        registerOpener(terminalId);
      }
    });
  }, [terminalId, reattachTerminal, registerOpener]);

  // Unregister opener, paste handler, and search results callback on unmount
  useEffect(() => {
    return () => {
      if (registeredTerminalIdRef.current) {
        unregisterFindBarOpener(registeredTerminalIdRef.current);
        unregisterPasteHandler(registeredTerminalIdRef.current);
        unregisterSearchResultsCallback(registeredTerminalIdRef.current);
      }
    };
  }, []);

  // Focus when becoming active tab
  useEffect(() => {
    if (active && terminalId) {
      focusTerminal(terminalId);
    }
  }, [active, terminalId, focusTerminal]);

  // Run search whenever query, caseSensitive, or findBarOpen changes.
  // Match counts are updated via the onDidChangeResults subscription wired in
  // openTerminal → they arrive through the callbackOnSearchResults callback.
  // We reset counts when the bar is closed or the query is empty.
  useEffect(() => {
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (!id || !findBarOpen || !findQuery) {
      setMatchCurrent(0);
      setMatchTotal(0);
      return;
    }
    // Trigger the initial search — onDidChangeResults will fire and update counts.
    findNextInTerminal(id, findQuery, buildSearchOptions(caseSensitive));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, caseSensitive, findBarOpen]);

  const closeFindBar = useCallback(() => {
    setFindBarOpen(false);
    setFindQuery("");
    setMatchCurrent(0);
    setMatchTotal(0);
    // Return focus to terminal
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (id) focusTerminal(id);
  }, [terminalId, focusTerminal]);

  const handleFindNext = useCallback(() => {
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (!id || !findQuery) return;
    // Use shared options (with decorations) so highlights + counts are preserved
    findNextInTerminal(id, findQuery, buildSearchOptions(caseSensitive));
  }, [terminalId, findQuery, caseSensitive]);

  const handleFindPrev = useCallback(() => {
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (!id || !findQuery) return;
    // Use shared options (with decorations) so highlights + counts are preserved
    findPrevInTerminal(id, findQuery, buildSearchOptions(caseSensitive));
  }, [terminalId, findQuery, caseSensitive]);

  // Write raw text to the terminal PTY. Shared by the direct paste path and the
  // "Paste anyway" confirmation so the byte-encoding logic lives in one place.
  const writeToTerminal = useCallback(
    async (text: string) => {
      const id = terminalId ?? registeredTerminalIdRef.current;
      if (!id || !text) return;
      const bytes = new TextEncoder().encode(text);
      await tauriInvoke<void>("write_terminal", {
        sessionId,
        terminalId: id,
        data: Array.from(bytes),
      });
    },
    [terminalId, sessionId],
  );

  // Right-click paste: read clipboard and send to terminal.
  // If the clipboard contains an embedded newline / control char, pasting it
  // verbatim would execute multiple commands instantly (pastejacking). In that
  // case we hold the text and open a confirmation dialog instead of writing.
  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const id = terminalId ?? registeredTerminalIdRef.current;
      if (!id) return;
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        if (isRiskyPaste(text)) {
          setPendingPaste({ text, lineCount: countCommandLines(text) });
          return;
        }
        await writeToTerminal(text);
      } catch {
        // Clipboard read may fail (permission or empty) — silently ignore
      }
    },
    [terminalId, writeToTerminal],
  );

  // Confirm a risky paste: write the held text, then clear the pending state.
  const confirmPendingPaste = useCallback(async () => {
    if (!pendingPaste) return;
    const { text } = pendingPaste;
    setPendingPaste(null);
    await writeToTerminal(text);
    // Return focus to the terminal after the dialog closes.
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (id) focusTerminal(id);
  }, [pendingPaste, writeToTerminal, terminalId, focusTerminal]);

  // Cancel a risky paste: discard the held text and return focus to terminal.
  const cancelPendingPaste = useCallback(() => {
    setPendingPaste(null);
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (id) focusTerminal(id);
  }, [terminalId, focusTerminal]);

  // Split-pane mode: always display:block (all panes visible simultaneously).
  // Single-terminal mode: show only the active tab, hide the rest.
  const displayStyle = isSplitPane ? "block" : active ? "block" : "none";

  return (
    <div
      className="terminal-wrapper"
      style={{ display: displayStyle }}
      onContextMenu={handleContextMenu}
    >
      <div
        ref={containerRef}
        className="terminal-container"
        role="application"
        aria-label={t("terminal.ariaLabel")}
      />
      {/* a11y: polite live region announcing connection-state changes.
          Visually hidden (.sr-only) — only assistive technology consumes it. */}
      <div className="sr-only" role="status" aria-live="polite">
        {statusMessage}
      </div>
      {findBarOpen && (
        <FindBar
          query={findQuery}
          caseSensitive={caseSensitive}
          matchCurrent={matchCurrent}
          matchTotal={matchTotal}
          onQueryChange={setFindQuery}
          onToggleCase={() => setCaseSensitive((prev) => !prev)}
          onPrev={handleFindPrev}
          onNext={handleFindNext}
          onClose={closeFindBar}
        />
      )}
      {/* Paste guard: confirmation for multi-line / control-char pastes. */}
      <Dialog
        open={pendingPaste !== null}
        onClose={cancelPendingPaste}
        title={t("terminal.paste.confirmTitle")}
        width="440px"
      >
        <p className="delete-confirm-message">
          {t("terminal.paste.confirmMessage", {
            count: pendingPaste?.lineCount ?? 0,
          })}
        </p>
        <div className="dialog-actions">
          <button
            className="btn btn-secondary btn-sm"
            data-autofocus="true"
            autoFocus
            onClick={cancelPendingPaste}
          >
            {t("terminal.paste.cancel")}
          </button>
          <button
            className="btn btn-danger btn-sm"
            data-variant="danger"
            onClick={() => void confirmPendingPaste()}
          >
            {t("terminal.paste.confirm")}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
