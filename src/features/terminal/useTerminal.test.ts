// src/features/terminal/useTerminal.test.ts — TDD: applyThemeToAllTerminals export

import { describe, it, expect, vi } from "vitest";
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
