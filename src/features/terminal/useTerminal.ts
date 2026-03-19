// features/terminal/useTerminal.ts — Terminal session lifecycle hook
//
// Manages: xterm.js instance creation, Tauri Channel for output streaming,
// input forwarding, resize handling.

import { useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_THEME,
  RESIZE_DEBOUNCE_MS,
} from "../../lib/constants";
import type { SessionId, TerminalId, TerminalEvent } from "../../lib/types";

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  terminalId: TerminalId;
  sessionId: SessionId;
  resizeObserver: ResizeObserver;
  disposed: boolean;
  /** The DOM container the xterm.js instance was last attached to.
   *  Needed for re-attaching when React remounts the TerminalView
   *  component (e.g., on session switch). */
  container: HTMLDivElement;
}

// Module-level singleton: all useTerminal() hook instances share the same Map.
// This prevents instance duplication/leaks when TerminalView and TerminalTabs
// each call useTerminal() independently (Bug H3).
const terminalInstances = new Map<string, TerminalInstance>();

export function useTerminal() {

  const openTerminal = useCallback(
    async (
      container: HTMLDivElement,
      sessionId: SessionId,
    ): Promise<TerminalId> => {
      // Create xterm.js Terminal
      const term = new Terminal({
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: TERMINAL_LINE_HEIGHT,
        theme: TERMINAL_THEME,
        cursorBlink: true,
        cursorStyle: "block",
        allowProposedApi: true,
        scrollback: 10000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const webLinksAddon = new WebLinksAddon();
      term.loadAddon(webLinksAddon);

      // Attach to DOM
      term.open(container);
      fitAddon.fit();

      const { cols, rows } = term;

      // Create Tauri Channel for streaming terminal output
      const onOutput = new Channel<TerminalEvent>();
      onOutput.onmessage = (message) => {
        if (message.event === "output") {
          // Data arrives as number[] — convert to Uint8Array for xterm
          const bytes = new Uint8Array(message.data.data);
          term.write(bytes);
        } else if (message.event === "closed") {
          term.writeln(`\r\n\x1b[33m[Session closed: ${message.data.reason}]\x1b[0m`);
        } else if (message.event === "error") {
          term.writeln(`\r\n\x1b[31m[Error: ${message.data.message}]\x1b[0m`);
        }
      };

      // Open PTY on Rust side
      const terminalId = await tauriInvoke<TerminalId>("open_terminal", {
        sessionId,
        cols,
        rows,
        onOutput,
      });

      // Forward keystrokes to Rust
      term.onData((data) => {
        const bytes = new TextEncoder().encode(data);
        void tauriInvoke<void>("write_terminal", {
          sessionId,
          terminalId,
          data: Array.from(bytes),
        });
      });

      // Handle binary data (e.g., from paste)
      term.onBinary((data) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          bytes[i] = data.charCodeAt(i);
        }
        void tauriInvoke<void>("write_terminal", {
          sessionId,
          terminalId,
          data: Array.from(bytes),
        });
      });

      // Resize handler with debounce
      let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          try {
            fitAddon.fit();
            void tauriInvoke<void>("resize_terminal", {
              sessionId,
              terminalId,
              cols: term.cols,
              rows: term.rows,
            });
          } catch {
            // Terminal might be disposed
          }
        }, RESIZE_DEBOUNCE_MS);
      });
      resizeObserver.observe(container);

      const instance: TerminalInstance = {
        terminal: term,
        fitAddon,
        terminalId,
        sessionId,
        resizeObserver,
        disposed: false,
        container,
      };
      terminalInstances.set(terminalId, instance);

      // Focus the terminal
      term.focus();

      return terminalId;
    },
    [],
  );

  const closeTerminal = useCallback(
    async (terminalId: TerminalId, sessionId: SessionId) => {
      const instance = terminalInstances.get(terminalId);
      if (instance && !instance.disposed) {
        instance.disposed = true;
        instance.resizeObserver.disconnect();
        instance.terminal.dispose();
        terminalInstances.delete(terminalId);
      }

      try {
        await tauriInvoke<void>("close_terminal", {
          sessionId,
          terminalId,
        });
      } catch {
        // Session might already be disconnected
      }
    },
    [],
  );

  const getTerminal = useCallback((terminalId: TerminalId) => {
    return terminalInstances.get(terminalId)?.terminal ?? null;
  }, []);

  const focusTerminal = useCallback((terminalId: TerminalId) => {
    const instance = terminalInstances.get(terminalId);
    if (instance && !instance.disposed) {
      instance.terminal.focus();
      instance.fitAddon.fit();
    }
  }, []);

  /** Re-attach an existing xterm.js instance to a new DOM container.
   *
   *  When the user switches sessions, React unmounts the old TerminalView and
   *  mounts a new one (different `key`). The xterm.js Terminal is still alive
   *  in `terminalInstances` (receiving data from Rust via Channel), but its DOM
   *  was destroyed with the old container. This function moves the terminal's
   *  DOM subtree into the new container and reconnects the ResizeObserver so
   *  the terminal renders correctly without re-creating the PTY session. */
  const reattachTerminal = useCallback(
    (terminalId: TerminalId, newContainer: HTMLDivElement) => {
      const instance = terminalInstances.get(terminalId);
      if (!instance || instance.disposed) return false;

      const termElement = instance.terminal.element;
      if (!termElement) return false;

      // Disconnect old ResizeObserver (was watching old container)
      instance.resizeObserver.disconnect();

      // Move xterm.js DOM into the new container
      newContainer.appendChild(termElement);
      instance.container = newContainer;

      // Re-fit to the (potentially different-sized) new container
      instance.fitAddon.fit();

      // Create a new ResizeObserver on the new container
      let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          try {
            instance.fitAddon.fit();
            void tauriInvoke<void>("resize_terminal", {
              sessionId: instance.sessionId,
              terminalId: instance.terminalId,
              cols: instance.terminal.cols,
              rows: instance.terminal.rows,
            });
          } catch {
            // Terminal might be disposed
          }
        }, RESIZE_DEBOUNCE_MS);
      });
      resizeObserver.observe(newContainer);
      instance.resizeObserver = resizeObserver;

      return true;
    },
    [],
  );

  // Dispose all terminals for a specific session (e.g., on disconnect).
  // Unlike the previous per-hook cleanup, this targets only the given session's
  // instances, not the entire shared Map.
  const disposeSessionTerminals = useCallback((sessionId: SessionId) => {
    for (const [id, instance] of terminalInstances) {
      if (instance.sessionId === sessionId && !instance.disposed) {
        instance.disposed = true;
        instance.resizeObserver.disconnect();
        instance.terminal.dispose();
        terminalInstances.delete(id);
      }
    }
  }, []);

  return { openTerminal, closeTerminal, getTerminal, focusTerminal, reattachTerminal, disposeSessionTerminals };
}
