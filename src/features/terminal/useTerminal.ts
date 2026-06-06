// features/terminal/useTerminal.ts — Terminal session lifecycle hook
//
// Manages: xterm.js instance creation, Tauri Channel for output streaming,
// input forwarding, resize handling.

import { useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import type { ISearchOptions } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  RESIZE_DEBOUNCE_MS,
} from "../../lib/constants";
import { THEMES } from "../../lib/themes";
import type { SessionId, TerminalId, TerminalEvent } from "../../lib/types";
import {
  reduceLineBuffer,
  makeLineBufferState,
  type LineBufferState,
} from "../history/lineBufferReducer";
import { useCommandHistoryStore } from "../../stores/commandHistoryStore";
import { useSessionStore } from "../../stores/sessionStore";
import { usePaneLayoutStore } from "../../stores/paneLayoutStore";
import { getBroadcastTargets } from "./broadcastUtils";
import { isRiskyPaste } from "./pasteSafety";

/** Result of a search results update from the SearchAddon. */
export interface SearchResults {
  /** 0-based index of the active match (-1 = none / over threshold) */
  resultIndex: number;
  /** Total number of matches */
  resultCount: number;
}

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  terminalId: TerminalId;
  sessionId: SessionId;
  resizeObserver: ResizeObserver;
  disposed: boolean;
  /** The DOM container the xterm.js instance was last attached to.
   *  Needed for re-attaching when React remounts the TerminalView
   *  component (e.g., on session switch). */
  container: HTMLDivElement;
  /** Callback registered by TerminalView to open the find-bar overlay.
   *  Called by attachCustomKeyEventHandler when Cmd/Ctrl+F is detected. */
  callbackOnOpenFindBar: (() => void) | null;
  /** Callback registered by TerminalView to handle a risky paste.
   *  Called by the native 'paste' listener when isRiskyPaste flags the clipboard
   *  text, so the same confirmation dialog used by right-click paste runs for
   *  keyboard (Cmd/Ctrl+V, Ctrl+Shift+V) and middle-click pastes too. */
  callbackOnPasteRequest: ((text: string) => void) | null;
  /** Callback registered by TerminalView to receive real-time match counts. */
  callbackOnSearchResults: ((r: SearchResults) => void) | null;
  /** Collected IDisposable subscriptions — disposed when the terminal closes. */
  disposables: IDisposable[];
  /**
   * Per-instance line buffer for the command-history tap.
   * Maintained across onData calls; reset on Ctrl-C/U or Enter-flush.
   * SECURITY: onData tap is guarded by captureEnabled in commandHistoryStore.
   */
  lineBuffer: LineBufferState;
}

// Module-level singleton: all useTerminal() hook instances share the same Map.
// This prevents instance duplication/leaks when TerminalView and TerminalTabs
// each call useTerminal() independently (Bug H3).
const terminalInstances = new Map<string, TerminalInstance>();

// ── Find-bar bridge ──────────────────────────────────────────────────────────

/** Register a callback that opens the find-bar for a specific terminal.
 *  Called by TerminalView after mounting (and after re-attach). */
export function registerFindBarOpener(terminalId: TerminalId, fn: () => void): void {
  const instance = terminalInstances.get(terminalId);
  if (instance) {
    instance.callbackOnOpenFindBar = fn;
  }
}

/** Unregister the find-bar opener callback (called on TerminalView unmount). */
export function unregisterFindBarOpener(terminalId: TerminalId): void {
  const instance = terminalInstances.get(terminalId);
  if (instance) {
    instance.callbackOnOpenFindBar = null;
  }
}

/** Register a callback that handles a risky paste for a specific terminal.
 *  The native 'paste' listener in openTerminal calls this with the clipboard
 *  text when isRiskyPaste flags it, so TerminalView can open the confirmation
 *  dialog. Called by TerminalView after mounting (and after re-attach). */
export function registerPasteHandler(
  terminalId: TerminalId,
  fn: (text: string) => void,
): void {
  const instance = terminalInstances.get(terminalId);
  if (instance) {
    instance.callbackOnPasteRequest = fn;
  }
}

/** Unregister the risky-paste handler callback (called on TerminalView unmount). */
export function unregisterPasteHandler(terminalId: TerminalId): void {
  const instance = terminalInstances.get(terminalId);
  if (instance) {
    instance.callbackOnPasteRequest = null;
  }
}

/** Register a callback to receive real-time search result updates.
 *  The callback fires whenever the SearchAddon's result set changes.
 *  Called by TerminalView after mounting (and after re-attach). */
export function registerSearchResultsCallback(
  terminalId: TerminalId,
  fn: (r: SearchResults) => void,
): void {
  const instance = terminalInstances.get(terminalId);
  if (instance) {
    instance.callbackOnSearchResults = fn;
  }
}

/** Unregister the search results callback (called on TerminalView unmount or find-bar close). */
export function unregisterSearchResultsCallback(terminalId: TerminalId): void {
  const instance = terminalInstances.get(terminalId);
  if (instance) {
    instance.callbackOnSearchResults = null;
  }
}

/** Search forward in the terminal using the SearchAddon.
 *  Returns true if a match was found, false otherwise. */
export function findNextInTerminal(
  terminalId: TerminalId,
  query: string,
  opts?: ISearchOptions,
): boolean {
  const instance = terminalInstances.get(terminalId);
  if (!instance || instance.disposed || !query) return false;
  return instance.searchAddon.findNext(query, opts) ?? false;
}

/** Search backward in the terminal using the SearchAddon.
 *  Returns true if a match was found, false otherwise. */
export function findPrevInTerminal(
  terminalId: TerminalId,
  query: string,
  opts?: ISearchOptions,
): boolean {
  const instance = terminalInstances.get(terminalId);
  if (!instance || instance.disposed || !query) return false;
  return instance.searchAddon.findPrevious(query, opts) ?? false;
}

/**
 * Re-themes all live (non-disposed) terminal instances.
 *
 * Called by themeStore.applyThemeSideEffects when the user switches themes.
 * The terminalInstances Map stays private; this is the only export that touches it.
 * xterm v6 supports terminal.options.theme as a live setter (no dispose+recreate needed).
 */
export function applyThemeToAllTerminals(theme: ITheme): void {
  for (const instance of terminalInstances.values()) {
    if (!instance.disposed) {
      instance.terminal.options.theme = theme;
    }
  }
}

// ── Key handler ─────────────────────────────────────────────────────────────

/** Possible outcomes of the terminal custom key event handler. */
export type TerminalKeyAction = "open-find" | "copy" | "passthrough";

/**
 * Pure function that decides what action to take for a keyboard event.
 *
 * Using event.code (layout-independent) rather than event.key (layout-dependent)
 * prevents misses when the OS or input method alters the produced key character
 * (e.g., Option+F on macOS produces key="ƒ" but code="KeyF" is stable).
 *
 * Rules:
 * - Only acts on "keydown" — keyup/keypress are always passthrough.
 * - Cmd/Ctrl+F  → "open-find"
 * - Ctrl+Shift+C → "copy" (always, any platform)
 * - Ctrl+C + selection (non-Mac) → "copy"   (block SIGINT)
 * - Ctrl+C no selection (non-Mac) → "passthrough" (let SIGINT through)
 * - Mac Cmd+C → "passthrough" (macOS handles it outside the terminal)
 * - Everything else → "passthrough"
 */
export function decideTerminalKeyAction(
  event: KeyboardEvent,
  ctx: { isMac: boolean; hasSelection: boolean },
): TerminalKeyAction {
  if (event.type !== "keydown") return "passthrough";

  const { isMac, hasSelection } = ctx;
  const mod = isMac ? event.metaKey : event.ctrlKey;

  // Cmd/Ctrl+F → open find-bar (no Shift)
  if (mod && !event.shiftKey && event.code === "KeyF") {
    return "open-find";
  }

  // Ctrl+Shift+C → always copy
  if (event.ctrlKey && event.shiftKey && event.code === "KeyC") {
    return "copy";
  }

  // Ctrl+C (non-Mac, no Shift) → copy if there is a selection, else SIGINT
  if (!isMac && event.ctrlKey && !event.shiftKey && event.code === "KeyC") {
    return hasSelection ? "copy" : "passthrough";
  }

  return "passthrough";
}

function isApplePlatform() {
  return /Mac|iPhone|iPad|iPod/.test(window.navigator.platform);
}

export function useTerminal() {

  const openTerminal = useCallback(
    async (
      container: HTMLDivElement,
      sessionId: SessionId,
    ): Promise<TerminalId> => {
      // Lazy runtime import avoids a module-level cycle: themeStore imports this
      // module for applyThemeToAllTerminals; this module reads themeStore only
      // at call time (never at module evaluation). ESM safe. If the bundler warns,
      // the fallback is parseStoredThemeId(localStorage.getItem("nexterm-theme")).
      const { useThemeStore } = await import("../../stores/themeStore");
      const initialThemeId = useThemeStore.getState().themeId;

      // Create xterm.js Terminal
      const term = new Terminal({
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: TERMINAL_LINE_HEIGHT,
        theme: THEMES[initialThemeId].terminalTheme,
        cursorBlink: true,
        cursorStyle: "block",
        allowProposedApi: true,
        macOptionIsMeta: isApplePlatform(),
        scrollback: 10000,
        // a11y: enable xterm's screen-reader mode so it maintains an ARIA live
        // region mirroring terminal output. Without this the terminal surface is
        // invisible to assistive technology (the canvas/WebGL renderer has no
        // accessible text). See TerminalView for the container's accessible name.
        screenReaderMode: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const webLinksAddon = new WebLinksAddon();
      term.loadAddon(webLinksAddon);

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);

      // Wait until the container has been laid out (split panes can mount at 0×0).
      // Without this guard, WebGL initialises at 0×0 and renders a black canvas
      // that the later ResizeObserver re-fit cannot always recover.
      let _waitAttempts = 0;
      while (
        (container.offsetWidth === 0 || container.offsetHeight === 0) &&
        _waitAttempts < 10
      ) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        _waitAttempts++;
      }

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

      // Forward keystrokes to Rust + command-history tap
      term.onData((data) => {
        // Command history tap: process chunk through line buffer reducer.
        // The store's addCommand guards behind captureEnabled — early-returns
        // when capture is OFF, so no history is recorded unless user opted in.
        // SECURITY: We do NOT attempt password-prompt detection (unreliable at
        // the JS layer). The user controls capture via the History panel toggle.
        const inst = terminalInstances.get(terminalId);
        if (inst) {
          const { host } = _getSessionHost(sessionId);
          inst.lineBuffer = _processOnDataChunk(inst.lineBuffer, data, sessionId, host);
        }

        const bytes = new TextEncoder().encode(data);
        void tauriInvoke<void>("write_terminal", {
          sessionId,
          terminalId,
          data: Array.from(bytes),
        });

        // Broadcast fan-out: mirror keystrokes to all other live panes.
        // Reads store at call time (not captured at open time) so toggle changes
        // take effect immediately without reopening the terminal.
        // SAFETY: source is excluded by getBroadcastTargets — no double-write.
        _broadcastFanOut(sessionId, terminalId, Array.from(bytes));
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

        // Broadcast fan-out for paste (onBinary) — same logic as onData.
        // Critical: paste MUST get the same fan-out or pasted content is
        // sent to the source pane only. getBroadcastTargets guarantees no
        // double-write to source.
        _broadcastFanOut(sessionId, terminalId, Array.from(bytes));
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

      // Custom key event handler — uses decideTerminalKeyAction pure function.
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        const isMac = isApplePlatform();
        const hasSelection = term.hasSelection();
        const action = decideTerminalKeyAction(event, { isMac, hasSelection });

        if (action === "open-find") {
          const inst = terminalInstances.get(terminalId);
          inst?.callbackOnOpenFindBar?.();
          return false; // block key from reaching shell
        }

        if (action === "copy") {
          const selection = term.getSelection();
          if (selection) {
            void navigator.clipboard.writeText(selection);
          }
          return false; // block
        }

        return true; // passthrough to shell
      });

      // Copy-on-select: copy when the selection is SETTLED (mouseup), not on every
      // change event. Firing on every onSelectionChange spams the clipboard mid-drag.
      const handleMouseUp = () => {
        const selection = term.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
        }
      };

      // Collect disposables so they are cleaned up when the terminal is closed.
      const disposables: IDisposable[] = [];

      // Subscribe to search results — fires when onDidChangeResults is triggered.
      // Requires decorations to be set in search options (guaranteed by buildSearchOptions).
      const resultsDisposable = searchAddon.onDidChangeResults((e) => {
        const inst = terminalInstances.get(terminalId);
        if (inst?.callbackOnSearchResults) {
          inst.callbackOnSearchResults({
            resultIndex: e.resultIndex,
            resultCount: e.resultCount,
          });
        }
      });
      disposables.push(resultsDisposable);

      // Track the mouseup listener for cleanup
      const mouseUpDisposable: IDisposable = {
        dispose: () => {
          term.element?.removeEventListener("mouseup", handleMouseUp);
        },
      };
      disposables.push(mouseUpDisposable);

      // Attach mouseup AFTER term.open() so term.element exists
      term.element?.addEventListener("mouseup", handleMouseUp);

      // Pastejacking guard for ALL paste gestures handled by xterm.js.
      // Keyboard paste (Cmd/Ctrl+V, Ctrl+Shift+V) and Linux middle-click paste
      // are processed internally by xterm and would otherwise flow straight to
      // onData/onBinary → write_terminal with no isRiskyPaste check. xterm reads
      // the clipboard via a native 'paste' event on its helper textarea, so we
      // intercept that event here: when the clipboard text is risky (embedded
      // newline / control char that could auto-execute multiple commands), we
      // preventDefault to stop xterm from forwarding it and hand the text to the
      // confirmation flow registered by TerminalView. Safe single-line pastes
      // are left untouched so xterm's normal paste path keeps working.
      const handlePaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text") ?? "";
        if (!text || !isRiskyPaste(text)) return; // safe → let xterm handle it
        event.preventDefault();
        event.stopPropagation();
        const inst = terminalInstances.get(terminalId);
        inst?.callbackOnPasteRequest?.(text);
      };
      // Track the paste listener for cleanup
      const pasteDisposable: IDisposable = {
        dispose: () => {
          term.element?.removeEventListener("paste", handlePaste, true);
        },
      };
      disposables.push(pasteDisposable);

      // Capture phase so we intercept before xterm's own paste handler runs.
      term.element?.addEventListener("paste", handlePaste, true);

      // Load WebGL renderer for GPU-accelerated rendering.
      // Must come AFTER term.open() — WebglAddon requires a rendered canvas.
      // Falls back silently to xterm's default DOM renderer when WebGL2 is
      // unavailable (headless/jsdom, blocked GPU, context lost immediately).
      try {
        const webglAddon = new WebglAddon();
        // If the GPU context is lost at runtime, dispose the addon so xterm
        // reverts to its DOM renderer automatically.
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
        // WebglAddon implements IDisposable directly — include in lifecycle cleanup.
        disposables.push(webglAddon);
      } catch {
        // WebGL2 unavailable (e.g. headless/jsdom, blocked GPU) — xterm keeps
        // its default DOM renderer. No action needed.
      }

      const instance: TerminalInstance = {
        terminal: term,
        fitAddon,
        searchAddon,
        terminalId,
        sessionId,
        resizeObserver,
        disposed: false,
        container,
        callbackOnOpenFindBar: null,
        callbackOnPasteRequest: null,
        callbackOnSearchResults: null,
        disposables,
        lineBuffer: makeLineBufferState(),
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
        // Dispose all tracked IDisposable subscriptions before terminal.dispose()
        for (const d of instance.disposables) {
          try { d.dispose(); } catch { /* ignore */ }
        }
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
    async (terminalId: TerminalId, newContainer: HTMLDivElement) => {
      const instance = terminalInstances.get(terminalId);
      if (!instance || instance.disposed) return false;

      const termElement = instance.terminal.element;
      if (!termElement) return false;

      // Disconnect old ResizeObserver (was watching old container)
      instance.resizeObserver.disconnect();

      // Move xterm.js DOM into the new container
      newContainer.appendChild(termElement);
      instance.container = newContainer;

      // Wait for layout before fitting (mirrors the guard in openTerminal).
      let _waitAttempts = 0;
      while (
        (newContainer.offsetWidth === 0 || newContainer.offsetHeight === 0) &&
        _waitAttempts < 10
      ) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        _waitAttempts++;
      }

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
        // Dispose all tracked IDisposable subscriptions before terminal.dispose()
        for (const d of instance.disposables) {
          try { d.dispose(); } catch { /* ignore */ }
        }
        instance.terminal.dispose();
        terminalInstances.delete(id);
      }
    }
  }, []);

  return { openTerminal, closeTerminal, getTerminal, focusTerminal, reattachTerminal, disposeSessionTerminals };
}

// ── Command history onData tap helpers ───────────────────────────────────────

/**
 * Looks up the host string for a session from the session store.
 * Returns empty string if the session is not found (safe fallback).
 */
function _getSessionHost(sessionId: SessionId): { host: string } {
  const session = useSessionStore.getState().sessions.get(sessionId);
  return { host: session?.host ?? "" };
}

/**
 * Core logic for the onData history tap.
 * Processes a raw xterm onData chunk through the line-buffer reducer.
 * When a command is flushed, calls commandHistoryStore.addCommand IF
 * captureEnabled is true (the store guards this internally).
 *
 * @param prevState  - Previous LineBufferState (undefined = fresh start)
 * @param chunk      - Raw xterm onData string
 * @param sessionId  - Active session id (for store entry)
 * @param host       - Remote host (for store entry)
 * @returns           - Next LineBufferState
 */
function _processOnDataChunk(
  prevState: LineBufferState | undefined,
  chunk: string,
  sessionId: string,
  host: string,
): LineBufferState {
  const prev = prevState ?? makeLineBufferState();

  // SECURITY: early return when capture is disabled — do NOT run the reducer
  // and do NOT accumulate any chars. Return a fresh empty state so that typed
  // characters (including passwords at no-echo prompts) are never held in
  // memory. Re-enabling capture starts from a clean slate. Keystrokes are
  // still forwarded to write_terminal by the caller — this tap never affects
  // normal terminal I/O.
  const { captureEnabled, addCommand } = useCommandHistoryStore.getState();
  if (!captureEnabled) {
    return makeLineBufferState();
  }

  const next = reduceLineBuffer(prev, chunk);

  if (next.flushed !== undefined) {
    addCommand({
      command: next.flushed,
      sessionId,
      host,
    });
  }

  return next;
}

/**
 * TEST-ONLY helper — seeds a fake TerminalInstance into the module-level Map
 * so unit tests can verify applyThemeToAllTerminals behaves correctly on live
 * and disposed instances without standing up a real xterm.js environment.
 *
 * This export is guarded by the module-level Map being private; calling it in
 * production is a no-op for callers who don't import it explicitly.
 */
export function _testSeedTerminalInstance(id: string, instance: TerminalInstance): void {
  terminalInstances.set(id, instance);
}

/**
 * TEST-ONLY helper — retrieves the callbackOnOpenFindBar stored for a terminal.
 * Allows tests to drive the find-bar open state by invoking the actual React
 * state-setter that TerminalView registered via registerFindBarOpener.
 */
export function _testGetFindBarOpener(terminalId: TerminalId): (() => void) | null {
  return terminalInstances.get(terminalId)?.callbackOnOpenFindBar ?? null;
}

/**
 * Broadcast fan-out helper.
 *
 * Reads the paneLayoutStore and sessionStore at call time to get the current
 * broadcastEnabled state and session connection state. This deliberately avoids
 * closure-capture so toggling broadcast takes effect on the very next keystroke.
 *
 * SAFETY INVARIANTS (enforced here and by getBroadcastTargets):
 * 1. Source pane is never written a second time (excluded by getBroadcastTargets).
 * 2. Pending slots (null or "pending-*" terminalIds) are excluded.
 * 3. Only fires when session is "connected" string state.
 * 4. write_terminal errors are silently ignored (void) — target PTY closing
 *    mid-broadcast is handled gracefully by Rust; the pane shows PTY-closed msg.
 */
function _broadcastFanOut(
  sessionId: SessionId,
  sourceTerminalId: TerminalId,
  bytes: number[],
): void {
  const layout = usePaneLayoutStore.getState().layouts[sessionId];
  if (!layout?.broadcastEnabled) return;

  const session = useSessionStore.getState().sessions.get(sessionId);
  const sessionState = session?.state ?? "disconnected";

  const targets = getBroadcastTargets(layout.slots, sourceTerminalId, sessionState);
  for (const targetId of targets) {
    void tauriInvoke<void>("write_terminal", {
      sessionId,
      terminalId: targetId,
      data: bytes,
    });
  }
}

/**
 * TEST-ONLY helper — exposes _processOnDataChunk for unit testing the
 * onData history tap logic without going through the full openTerminal flow.
 */
export function _testProcessOnDataChunk(
  prevState: LineBufferState | undefined,
  chunk: string,
  sessionId: string,
  host: string,
): LineBufferState {
  return _processOnDataChunk(prevState, chunk, sessionId, host);
}
