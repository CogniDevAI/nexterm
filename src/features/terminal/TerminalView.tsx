// features/terminal/TerminalView.tsx — Single terminal instance view
//
// Wraps an xterm.js terminal element and wires it to the useTerminal hook.
// Hosts the find-bar overlay (opened via Cmd/Ctrl+F through the xterm key handler).

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionId, TerminalId } from "../../lib/types";
import { useTerminal } from "./useTerminal";
import {
  registerFindBarOpener,
  unregisterFindBarOpener,
  registerSearchResultsCallback,
  unregisterSearchResultsCallback,
  findNextInTerminal,
  findPrevInTerminal,
} from "./useTerminal";
import type { SearchResults } from "./useTerminal";
import { FindBar } from "./FindBar";
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
}

export function TerminalView({
  sessionId,
  terminalId,
  onTerminalOpened,
  active,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { openTerminal, focusTerminal, reattachTerminal } = useTerminal();
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

  // Helper: register find-bar opener and search results callback for a given terminalId
  const registerOpener = useCallback((id: TerminalId) => {
    registerFindBarOpener(id, () => setFindBarOpen(true));
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
    const didReattach = reattachTerminal(terminalId, containerRef.current);
    if (didReattach) {
      attachedRef.current = true;
      // Re-register find-bar opener and search results callback after reattach
      registerOpener(terminalId);
    }
  }, [terminalId, reattachTerminal, registerOpener]);

  // Unregister opener and search results callback on unmount
  useEffect(() => {
    return () => {
      if (registeredTerminalIdRef.current) {
        unregisterFindBarOpener(registeredTerminalIdRef.current);
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

  // Right-click paste: read clipboard and send to terminal
  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const id = terminalId ?? registeredTerminalIdRef.current;
      if (!id) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const bytes = new TextEncoder().encode(text);
          await tauriInvoke<void>("write_terminal", {
            sessionId,
            terminalId: id,
            data: Array.from(bytes),
          });
        }
      } catch {
        // Clipboard read may fail (permission or empty) — silently ignore
      }
    },
    [terminalId, sessionId],
  );

  return (
    <div
      className="terminal-wrapper"
      style={{ display: active ? "block" : "none" }}
      onContextMenu={handleContextMenu}
    >
      <div
        ref={containerRef}
        className="terminal-container"
      />
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
    </div>
  );
}
