// TerminalTabs.test.tsx — TDD: Rules-of-Hooks violation fix
//
// Bug: `if (!session) return null` sits BEFORE all hooks → hook count changes
// on session removal → React throws "Rendered fewer hooks than expected".
//
// Fix: all hooks run unconditionally; early return moves to just before JSX.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionEntry } from "../../stores/sessionStore";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock tauri — TerminalTabs → useTerminal → tauriInvoke
vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/api/core (Channel, etc.)
vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({
    onmessage: null,
  })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock xterm — heavy native module, not needed in unit tests
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
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}));

// Mock TerminalView — we only care about TerminalTabs rendering the shell
vi.mock("./TerminalView", () => ({
  TerminalView: ({ active }: { active: boolean }) => (
    <div data-testid="terminal-view" data-active={active} />
  ),
}));

// Mock i18n
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(id: string): SessionEntry {
  return {
    id,
    profileId: "profile-1",
    profileName: "Test Server",
    host: "192.168.1.1:22",
    userId: "user-1",
    username: "admin",
    port: 22,
    connectedAt: Date.now() - 5000,
    state: "connected",
    terminals: [
      {
        id: "term-1",
        label: "Terminal 1",
        sessionId: id,
        reactKey: "rk-1",
      },
    ],
    activeTerminalId: "term-1",
  };
}

// ─── Import TerminalTabs AFTER mocks ─────────────────────────────────────────
// eslint-disable-next-line import/first
import { TerminalTabs } from "./TerminalTabs";

// ─── Store reset helper ───────────────────────────────────────────────────────
function resetStore() {
  useSessionStore.setState({
    sessions: new Map(),
    activeSessionId: null,
    activeFeature: "terminal",
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TerminalTabs — Rules-of-Hooks fix", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("renders the tab bar when a session is present", () => {
    const session = makeSession("sid-1");
    useSessionStore.setState({
      sessions: new Map([["sid-1", session]]),
      activeSessionId: "sid-1",
    });

    render(<TerminalTabs sessionId="sid-1" />);

    // Tab bar should be present
    expect(document.querySelector(".terminal-tabbar")).not.toBeNull();

    // Connection info bar shows host
    expect(screen.getByText(/admin@192\.168\.1\.1/)).toBeInTheDocument();

    // TerminalView rendered for the tab
    expect(screen.getAllByTestId("terminal-view").length).toBeGreaterThan(0);
  });

  it(
    "returns null without throwing when session is deleted (hooks-violation fix)",
    () => {
      const session = makeSession("sid-2");
      useSessionStore.setState({
        sessions: new Map([["sid-2", session]]),
        activeSessionId: "sid-2",
      });

      const { rerender, container } = render(<TerminalTabs sessionId="sid-2" />);
      expect(container.querySelector(".terminal-tabs")).not.toBeNull();

      // Remove the session from the store — before the fix this triggers
      // "Rendered fewer hooks than expected" because the early return cut the
      // hook chain.
      act(() => {
        useSessionStore.setState({
          sessions: new Map(),
          activeSessionId: null,
        });
      });

      // Rerender with the same sessionId (now invalid) — MUST NOT throw.
      expect(() => rerender(<TerminalTabs sessionId="sid-2" />)).not.toThrow();

      // And the component should render nothing (null)
      expect(container.querySelector(".terminal-tabs")).toBeNull();
    },
  );

  it("shows the new-tab button when a session exists", () => {
    const session = makeSession("sid-3");
    useSessionStore.setState({
      sessions: new Map([["sid-3", session]]),
      activeSessionId: "sid-3",
    });

    render(<TerminalTabs sessionId="sid-3" />);
    const newTabBtn = document.querySelector(".terminal-tab-new");
    expect(newTabBtn).not.toBeNull();
  });
});
