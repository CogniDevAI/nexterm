// src/features/terminal/useTerminal.test.ts — TDD: applyThemeToAllTerminals export

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ITheme } from "@xterm/xterm";

// ── localStorage stub so themeStore (imported dynamically by useTerminal) can work ──
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

// ── Mock heavy native modules ──
vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    cols: 80,
    rows: 24,
    onData: vi.fn(),
    onBinary: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    element: null,
    options: {},
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn(), dispose: vi.fn() })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    dispose: vi.fn(),
    findNext: vi.fn().mockReturnValue(false),
    findPrevious: vi.fn().mockReturnValue(false),
    onDidChangeResults: vi.fn(),
  })),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue("term-id-1"),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ── commandHistoryStore mock (for onData tap tests) ───────────────────────────
const mockAddCommand = vi.fn();
vi.mock("../../stores/commandHistoryStore", () => ({
  useCommandHistoryStore: {
    getState: vi.fn(() => ({
      captureEnabled: false,
      addCommand: mockAddCommand,
    })),
  },
}));

import { applyThemeToAllTerminals } from "./useTerminal";

const mockTheme: ITheme = {
  background: "#000000",
  foreground: "#ffffff",
};

describe("applyThemeToAllTerminals", () => {
  it("is exported from useTerminal as a function", () => {
    expect(typeof applyThemeToAllTerminals).toBe("function");
  });

  it("does not throw when called with no terminal instances (empty map)", () => {
    // The module-level Map is empty in this test context; calling should be a no-op.
    expect(() => applyThemeToAllTerminals(mockTheme)).not.toThrow();
  });

  it("accepts an ITheme argument without type errors", () => {
    const fullTheme: ITheme = {
      background: "#0c0e12",
      foreground: "#eef0f3",
      cursor: "#c49a60",
      cursorAccent: "#181c25",
      selectionBackground: "#3b2e18a6",
      black: "#3e3830",
      red: "#e05c4a",
      green: "#4ec99a",
      yellow: "#d4a03a",
      blue: "#5aabf0",
      magenta: "#b589e8",
      cyan: "#3fc9a0",
      white: "#b6b0ab",
      brightBlack: "#635c57",
      brightRed: "#f5897e",
      brightGreen: "#66c7a0",
      brightYellow: "#e8b84e",
      brightBlue: "#82c8ff",
      brightMagenta: "#cca8f8",
      brightCyan: "#66c7a0",
      brightWhite: "#eeeae7",
    };
    expect(() => applyThemeToAllTerminals(fullTheme)).not.toThrow();
  });
});

// SearchAddon exports
import {
  registerFindBarOpener,
  unregisterFindBarOpener,
  findNextInTerminal,
  findPrevInTerminal,
} from "./useTerminal";

describe("registerFindBarOpener / unregisterFindBarOpener", () => {
  it("exports registerFindBarOpener as a function", () => {
    expect(typeof registerFindBarOpener).toBe("function");
  });

  it("exports unregisterFindBarOpener as a function", () => {
    expect(typeof unregisterFindBarOpener).toBe("function");
  });

  it("calling registerFindBarOpener and unregisterFindBarOpener does not throw", () => {
    expect(() => registerFindBarOpener("term-x", () => {})).not.toThrow();
    expect(() => unregisterFindBarOpener("term-x")).not.toThrow();
  });
});

describe("findNextInTerminal / findPrevInTerminal", () => {
  it("exports findNextInTerminal as a function", () => {
    expect(typeof findNextInTerminal).toBe("function");
  });

  it("exports findPrevInTerminal as a function", () => {
    expect(typeof findPrevInTerminal).toBe("function");
  });

  it("findNextInTerminal returns false for unknown terminalId", () => {
    expect(findNextInTerminal("nonexistent", "query")).toBe(false);
  });

  it("findPrevInTerminal returns false for unknown terminalId", () => {
    expect(findPrevInTerminal("nonexistent", "query")).toBe(false);
  });
});

// MAJOR-8: decideTerminalKeyAction pure function tests (RED first)
import { decideTerminalKeyAction } from "./useTerminal";

function makeEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: "keydown",
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("decideTerminalKeyAction — all branches", () => {
  // Cmd/Ctrl+F → open-find (only keydown)
  it("Mac: Cmd+F returns open-find", () => {
    const e = makeEvent({ metaKey: true, code: "KeyF" });
    expect(decideTerminalKeyAction(e, { isMac: true, hasSelection: false })).toBe("open-find");
  });

  it("non-Mac: Ctrl+F returns open-find", () => {
    const e = makeEvent({ ctrlKey: true, code: "KeyF" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: false })).toBe("open-find");
  });

  it("Ctrl+F on keyup returns passthrough (only keydown triggers find)", () => {
    const e = makeEvent({ ctrlKey: true, code: "KeyF", type: "keyup" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: false })).toBe("passthrough");
  });

  it("Mac: Ctrl+F returns passthrough (Mac uses Cmd, not Ctrl)", () => {
    const e = makeEvent({ ctrlKey: true, code: "KeyF" });
    expect(decideTerminalKeyAction(e, { isMac: true, hasSelection: false })).toBe("passthrough");
  });

  // Ctrl+C + selection (non-Mac) → copy
  it("non-Mac: Ctrl+C with selection returns copy", () => {
    const e = makeEvent({ ctrlKey: true, code: "KeyC" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: true })).toBe("copy");
  });

  // Ctrl+C no selection (non-Mac) → passthrough (SIGINT)
  it("non-Mac: Ctrl+C without selection returns passthrough (SIGINT)", () => {
    const e = makeEvent({ ctrlKey: true, code: "KeyC" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: false })).toBe("passthrough");
  });

  // Ctrl+Shift+C → copy (always)
  it("Ctrl+Shift+C returns copy (non-Mac, no selection)", () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, code: "KeyC" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: false })).toBe("copy");
  });

  it("Ctrl+Shift+C returns copy (non-Mac, with selection)", () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, code: "KeyC" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: true })).toBe("copy");
  });

  // Mac: Cmd+C → passthrough (handled by OS)
  it("Mac: Cmd+C returns passthrough (OS handles it)", () => {
    const e = makeEvent({ metaKey: true, code: "KeyC" });
    expect(decideTerminalKeyAction(e, { isMac: true, hasSelection: true })).toBe("passthrough");
  });

  // Plain key → passthrough
  it("plain key (letter) returns passthrough", () => {
    const e = makeEvent({ code: "KeyA" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: false })).toBe("passthrough");
  });

  // MINOR-5: layout-independent — code-based, not key-based
  it("uses event.code (KeyF/KeyC) not event.key — Ctrl+F with key='ƒ' still opens find", () => {
    // Option+F on Mac produces key='ƒ' — if we checked key we'd miss it with metaKey
    const e = makeEvent({ metaKey: true, code: "KeyF", key: "ƒ" });
    expect(decideTerminalKeyAction(e, { isMac: true, hasSelection: false })).toBe("open-find");
  });

  it("uses event.code (KeyC) not event.key — Ctrl+Shift+C with key='C' still copies", () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, code: "KeyC", key: "C" });
    expect(decideTerminalKeyAction(e, { isMac: false, hasSelection: false })).toBe("copy");
  });

  // non-keydown event type → passthrough
  it("Cmd+F on keypress (not keydown) returns passthrough", () => {
    const e = makeEvent({ metaKey: true, code: "KeyF", type: "keypress" });
    expect(decideTerminalKeyAction(e, { isMac: true, hasSelection: false })).toBe("passthrough");
  });
});

// MINOR-4: applyThemeToAllTerminals live-instance coverage
// We expose a test-only seeding helper to register fake instances into the Map.
// Import it only in test context; production code never uses it.
import { _testSeedTerminalInstance } from "./useTerminal";

describe("applyThemeToAllTerminals — live and disposed instances (MINOR-4)", () => {
  it("sets options.theme on live instances and skips disposed ones", () => {
    const liveOptions1: { theme?: ITheme } = {};
    const liveOptions2: { theme?: ITheme } = {};
    const disposedOptions: { theme?: ITheme } = {};

    const fakeTerminal1 = { options: liveOptions1 };
    const fakeTerminal2 = { options: liveOptions2 };
    const fakeDisposed = { options: disposedOptions };

    // Register fake instances before calling the applier
    _testSeedTerminalInstance("live-1", { terminal: fakeTerminal1 as never, disposed: false } as never);
    _testSeedTerminalInstance("live-2", { terminal: fakeTerminal2 as never, disposed: false } as never);
    _testSeedTerminalInstance("disposed-1", { terminal: fakeDisposed as never, disposed: true } as never);

    const theme: ITheme = { background: "#123456", foreground: "#abcdef" };
    applyThemeToAllTerminals(theme);

    expect(liveOptions1.theme).toBe(theme);
    expect(liveOptions2.theme).toBe(theme);
    // disposed instance must NOT be re-themed
    expect(disposedOptions.theme).toBeUndefined();
  });
});

// ── onData history tap — _testProcessOnDataChunk ──────────────────────────────
// Tests that the bridge between the line-buffer reducer and commandHistoryStore
// works correctly. _testProcessOnDataChunk is a TEST-ONLY export that runs the
// same logic as the onData handler registered inside openTerminal.
import { _testProcessOnDataChunk } from "./useTerminal";
import { useCommandHistoryStore } from "../../stores/commandHistoryStore";

const mockedHistoryStore = vi.mocked(useCommandHistoryStore);

describe("_testProcessOnDataChunk — onData history tap", () => {
  beforeEach(() => {
    mockAddCommand.mockReset();
    // Ensure getState returns a valid object with a fresh mockAddCommand after each reset
    mockedHistoryStore.getState.mockReturnValue({
      captureEnabled: false,
      addCommand: mockAddCommand,
    } as never);
  });

  it("is exported as a function", () => {
    expect(typeof _testProcessOnDataChunk).toBe("function");
  });

  it("calls addCommand when captureEnabled=true and a command is flushed", () => {
    mockedHistoryStore.getState.mockReturnValue({
      captureEnabled: true,
      addCommand: mockAddCommand,
    } as never);

    const state = _testProcessOnDataChunk(undefined, "ls -la\r", "sess-1", "host.example.com");
    expect(mockAddCommand).toHaveBeenCalledWith({
      command: "ls -la",
      sessionId: "sess-1",
      host: "host.example.com",
    });
    expect(state.buffer).toBe("");
  });

  it("does NOT call addCommand when captureEnabled=false", () => {
    // Default beforeEach sets captureEnabled: false already
    _testProcessOnDataChunk(undefined, "secret-password\r", "sess-1", "host");
    expect(mockAddCommand).not.toHaveBeenCalled();
  });

  // MAJOR-1 (SECURITY): with captureEnabled=false the reducer must NOT accumulate
  // typed chars — the per-instance lineBuffer.buffer must stay "" so passwords
  // typed at no-echo prompts are never held in memory.
  it("does NOT accumulate chars in buffer when captureEnabled=false (SECURITY)", () => {
    // captureEnabled: false is set by beforeEach
    const state = _testProcessOnDataChunk(undefined, "secret-password", "sess-1", "host");
    expect(state.buffer).toBe("");
    expect(mockAddCommand).not.toHaveBeenCalled();
  });

  it("returns fresh empty state on every call when captureEnabled=false", () => {
    // Even when called with an existing non-empty prev state, capture-off must
    // discard everything and return a clean slate.
    const fakeNonEmpty = { buffer: "already-accumulated", inEscSeq: false, inSS3: false };
    const state = _testProcessOnDataChunk(fakeNonEmpty as never, "more", "sess-1", "host");
    expect(state.buffer).toBe("");
    expect(mockAddCommand).not.toHaveBeenCalled();
  });

  it("accumulates chars without flushing when no \\r (captureEnabled=true)", () => {
    // Accumulation requires capture to be enabled — with capture off the buffer
    // is always reset to empty (SECURITY, see MAJOR-1 tests above).
    mockedHistoryStore.getState.mockReturnValue({
      captureEnabled: true,
      addCommand: mockAddCommand,
    } as never);
    const state1 = _testProcessOnDataChunk(undefined, "git", "sess-1", "host");
    const state2 = _testProcessOnDataChunk(state1, " status", "sess-1", "host");
    expect(state2.buffer).toBe("git status");
    expect(mockAddCommand).not.toHaveBeenCalled();
  });

  it("resets buffer on Ctrl-C without calling addCommand", () => {
    mockedHistoryStore.getState.mockReturnValue({
      captureEnabled: true,
      addCommand: mockAddCommand,
    } as never);

    const state1 = _testProcessOnDataChunk(undefined, "partial", "sess-1", "host");
    const state2 = _testProcessOnDataChunk(state1, "\x03", "sess-1", "host");
    expect(state2.buffer).toBe("");
    expect(mockAddCommand).not.toHaveBeenCalled();
  });
});
