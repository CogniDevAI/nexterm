// a11y invariant: the terminal tab strip is a WAI-ARIA tablist — role="tablist"
// wraps role="tab" elements with aria-selected reflecting the active terminal,
// roving tabindex (active=0/others=-1), and Arrow/Home/End keyboard navigation.
// All hooks stay unconditional (no Rules-of-Hooks regression).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionEntry } from "../../stores/sessionStore";

// This jsdom config has a non-functional localStorage; the workspace store
// persist middleware resolves its storage at import time, so the in-memory stub
// MUST be installed before any store module loads. vi.hoisted runs first.
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
      get length() {
        return store.size;
      },
    },
  });
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    fit: vi.fn(),
    cols: 80,
    rows: 24,
    onData: vi.fn(),
    onBinary: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    element: document.createElement("div"),
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

vi.mock("./TerminalView", () => ({
  TerminalView: ({ active }: { active: boolean }) => (
    <div data-testid="terminal-view" data-active={active} />
  ),
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(id: string, activeTerminalId = "term-1"): SessionEntry {
  return {
    id,
    profileId: "profile-1",
    profileName: "Test Server",
    host: "192.168.1.1",
    userId: "user-1",
    username: "admin",
    port: 22,
    connectedAt: Date.now() - 5000,
    state: "connected",
    terminals: [
      { id: "term-1", label: "Terminal 1", sessionId: id, reactKey: "rk-1" },
      { id: "term-2", label: "Terminal 2", sessionId: id, reactKey: "rk-2" },
      { id: "term-3", label: "Terminal 3", sessionId: id, reactKey: "rk-3" },
    ],
    activeTerminalId,
  };
}

// eslint-disable-next-line import/first
import { TerminalTabs } from "./TerminalTabs";

function resetStore() {
  useSessionStore.setState({
    sessions: new Map(),
    activeSessionId: null,
  });
}

function setup(id = "sid-1", activeTerminalId = "term-1") {
  useSessionStore.setState({
    sessions: new Map([[id, makeSession(id, activeTerminalId)]]),
    activeSessionId: id,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TerminalTabs — WAI-ARIA tabs", () => {
  beforeEach(() => {
    resetStore();
    setup();
  });

  afterEach(() => {
    resetStore();
  });

  it("renders a tablist with one tab per terminal", () => {
    render(<TerminalTabs sessionId="sid-1" />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Terminal 3/ })).toBeInTheDocument();
  });

  it("marks the active terminal with aria-selected=true", () => {
    render(<TerminalTabs sessionId="sid-1" />);
    expect(screen.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("applies roving tabindex (active=0, others=-1)", () => {
    render(<TerminalTabs sessionId="sid-1" />);
    expect(screen.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("click still selects a terminal tab (existing behavior preserved)", () => {
    render(<TerminalTabs sessionId="sid-1" />);
    fireEvent.click(screen.getByRole("tab", { name: /Terminal 2/ }));
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ArrowRight moves selection to the next terminal", () => {
    render(<TerminalTabs sessionId="sid-1" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Terminal 1/ }), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ArrowLeft moves selection to the previous terminal", () => {
    resetStore();
    setup("sid-1", "term-2");
    render(<TerminalTabs sessionId="sid-1" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Terminal 2/ }), {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("Home selects the first terminal, End selects the last", () => {
    resetStore();
    setup("sid-1", "term-2");
    render(<TerminalTabs sessionId="sid-1" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Terminal 2/ }), {
      key: "End",
    });
    expect(screen.getByRole("tab", { name: /Terminal 3/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /Terminal 3/ }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
