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
