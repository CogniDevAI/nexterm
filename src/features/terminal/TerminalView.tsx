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
  findNextInTerminal,
  findPrevInTerminal,
} from "./useTerminal";
import { FindBar } from "./FindBar";
import { tauriInvoke } from "../../lib/tauri";
import "../../styles/terminal.css";
import "@xterm/xterm/css/xterm.css";

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

  // Helper: register find-bar opener for a given terminalId
  const registerOpener = useCallback((id: TerminalId) => {
    registerFindBarOpener(id, () => setFindBarOpen(true));
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
      // Re-register find-bar opener after reattach (the instance is fresh)
      registerOpener(terminalId);
    }
  }, [terminalId, reattachTerminal, registerOpener]);

  // Unregister opener on unmount
  useEffect(() => {
    return () => {
      if (registeredTerminalIdRef.current) {
        unregisterFindBarOpener(registeredTerminalIdRef.current);
      }
    };
  }, []);

  // Focus when becoming active tab
  useEffect(() => {
    if (active && terminalId) {
      focusTerminal(terminalId);
    }
  }, [active, terminalId, focusTerminal]);

  // Run search whenever query, caseSensitive, or findBarOpen changes
  useEffect(() => {
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (!id || !findBarOpen || !findQuery) {
      setMatchCurrent(0);
      setMatchTotal(0);
      return;
    }
    // Run findNext to highlight the first match and get a result
    const found = findNextInTerminal(id, findQuery, { caseSensitive, decorations: {
      matchBackground: "rgba(255,200,0,0.3)",
      matchBorder: "rgba(255,200,0,0.6)",
      matchOverviewRuler: "#ffcc00",
      activeMatchBackground: "rgba(255,160,0,0.5)",
      activeMatchBorder: "rgba(255,160,0,0.9)",
      activeMatchColorOverviewRuler: "#ffa000",
    }});
    // xterm SearchAddon doesn't expose total count synchronously in v6;
    // we track found as a boolean and show 1/? or 0
    setMatchTotal(found ? 1 : 0);
    setMatchCurrent(found ? 1 : 0);
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
    findNextInTerminal(id, findQuery, { caseSensitive });
  }, [terminalId, findQuery, caseSensitive]);

  const handleFindPrev = useCallback(() => {
    const id = terminalId ?? registeredTerminalIdRef.current;
    if (!id || !findQuery) return;
    findPrevInTerminal(id, findQuery, { caseSensitive });
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
