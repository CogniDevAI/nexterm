// features/terminal/TerminalView.tsx — Single terminal instance view
//
// Wraps an xterm.js terminal element and wires it to the useTerminal hook.

import { useEffect, useRef } from "react";
import type { SessionId, TerminalId } from "../../lib/types";
import { useTerminal } from "./useTerminal";
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

  // Open terminal on mount if no terminalId yet (pending tab)
  useEffect(() => {
    if (terminalId || initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;

    void openTerminal(containerRef.current, sessionId).then((id) => {
      attachedRef.current = true;
      onTerminalOpened(id);
    });
  }, [sessionId, terminalId, openTerminal, onTerminalOpened]);

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
    }
  }, [terminalId, reattachTerminal]);

  // Focus when becoming active tab
  useEffect(() => {
    if (active && terminalId) {
      focusTerminal(terminalId);
    }
  }, [active, terminalId, focusTerminal]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
