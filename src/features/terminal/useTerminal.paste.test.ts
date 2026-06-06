// useTerminal.paste.test.ts — pastejacking guard on ALL paste gestures
//
// Regression coverage for the paste-injection guard. xterm.js handles keyboard
// paste (Cmd/Ctrl+V, Ctrl+Shift+V) and Linux middle-click paste internally and
// forwards them through onData/onBinary → write_terminal with no isRiskyPaste
// check. openTerminal now attaches a capture-phase 'paste' listener on
// term.element that intercepts the browser paste event BEFORE xterm processes
// it: risky clipboard text is routed to the confirmation flow (via
// callbackOnPasteRequest) and xterm's default paste is prevented; safe text is
// left untouched so xterm pastes it normally.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.hoisted(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
  });
});

// Real DOM element so the 'paste' listener actually attaches and can be dispatched.
const termElement = document.createElement("div");

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(function MockTerminal() {
    return {
      loadAddon: vi.fn(),
      open: vi.fn(),
      cols: 80,
      rows: 24,
      onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onBinary: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      focus: vi.fn(),
      dispose: vi.fn(),
      write: vi.fn(),
      writeln: vi.fn(),
      element: termElement,
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(""),
    };
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function MockFitAddon() {
    return { fit: vi.fn(), dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function MockWebLinksAddon() {
    return { dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(function MockSearchAddon() {
    return {
      activate: vi.fn(),
      dispose: vi.fn(),
      findNext: vi.fn().mockReturnValue(false),
      findPrevious: vi.fn().mockReturnValue(false),
      onDidChangeResults: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    };
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(function MockWebglAddon() {
    return { onContextLoss: vi.fn(), dispose: vi.fn() };
  }),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue("term-paste-1"),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(function MockChannel() {
    return { onmessage: null };
  }),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../stores/commandHistoryStore", () => ({
  useCommandHistoryStore: {
    getState: vi.fn(() => ({ captureEnabled: false, addCommand: vi.fn() })),
  },
}));

if (typeof ResizeObserver === "undefined") {
  (globalThis as Record<string, unknown>).ResizeObserver = vi
    .fn()
    .mockImplementation(function MockResizeObserver(_cb: ResizeObserverCallback) {
      return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    });
}
if (typeof navigator.clipboard === "undefined") {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
}

import { useTerminal, registerPasteHandler } from "./useTerminal";

/** Build a paste event whose clipboardData returns `text`. jsdom does not
 *  implement ClipboardEvent.clipboardData, so we stub a minimal shape and
 *  spy on preventDefault. */
function makePasteEvent(text: string): {
  event: Event;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  const preventDefault = vi.fn();
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { getData: () => text },
  });
  Object.defineProperty(event, "preventDefault", {
    configurable: true,
    value: preventDefault,
  });
  Object.defineProperty(event, "stopPropagation", {
    configurable: true,
    value: vi.fn(),
  });
  return { event, preventDefault };
}

describe("openTerminal — pastejacking guard on the native paste event", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("routes a RISKY paste to callbackOnPasteRequest and preventDefaults xterm", async () => {
    const { result } = renderHook(() => useTerminal());
    let terminalId = "";
    await act(async () => {
      terminalId = await result.current.openTerminal(container, "sess-paste-risky");
    });

    const onPaste = vi.fn();
    registerPasteHandler(terminalId, onPaste);

    const { event, preventDefault } = makePasteEvent("echo hi\nrm -rf /");
    act(() => {
      termElement.dispatchEvent(event);
    });

    expect(onPaste).toHaveBeenCalledWith("echo hi\nrm -rf /");
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("leaves a SAFE single-line paste to xterm (no callback, no preventDefault)", async () => {
    const { result } = renderHook(() => useTerminal());
    let terminalId = "";
    await act(async () => {
      terminalId = await result.current.openTerminal(container, "sess-paste-safe");
    });

    const onPaste = vi.fn();
    registerPasteHandler(terminalId, onPaste);

    const { event, preventDefault } = makePasteEvent("echo hello world");
    act(() => {
      termElement.dispatchEvent(event);
    });

    expect(onPaste).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
