// TerminalTabs.mount-persistence.test.tsx
//
// Invariant: TerminalTabs DOM node is NOT remounted when the side-panel
// section changes. This is the headline guarantee of the terminal-side-panel
// feature: the terminal stays alive regardless of SFTP/Tunnel panel state.
//
// Approach: render the smallest real composition that exercises the
// invariant — TerminalTabs with a live workspaceStore + sessionStore.
// Capture the terminal container DOM node before and after a panelSection
// change; assert object identity (toBe), which fails if React remounted.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspaceStore, buildWorkspaceKey } from "../../stores/workspaceStore";
import type { SessionEntry } from "../../stores/sessionStore";

// ── localStorage stub (workspaceStore uses persist middleware) ────────────────
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

// ── Tauri / xterm mocks (TerminalTabs imports these indirectly) ───────────────
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

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    onContextLoss: vi.fn(),
    dispose: vi.fn(),
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

// ── Import under test AFTER mocks ─────────────────────────────────────────────
import { TerminalTabs } from "./TerminalTabs";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID = "sid-mount-test";
const PROFILE_ID = "profile-1";
const USER_ID = "user-1";
const WORKSPACE_KEY = buildWorkspaceKey(PROFILE_ID, USER_ID);

function makeSession(): SessionEntry {
  return {
    id: SESSION_ID,
    profileId: PROFILE_ID,
    profileName: "Test Server",
    host: "192.168.1.1",
    userId: USER_ID,
    username: "admin",
    port: 22,
    connectedAt: Date.now() - 5000,
    state: "connected",
    terminals: [
      { id: "term-1", label: "Terminal 1", sessionId: SESSION_ID, reactKey: "rk-1" },
    ],
    activeTerminalId: "term-1",
  };
}

function resetStores() {
  useSessionStore.setState({
    sessions: new Map(),
    activeSessionId: null,
  });
  useWorkspaceStore.setState({ workspaces: {} });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TerminalTabs — terminal DOM node persists across panel section changes", () => {
  beforeEach(() => {
    resetStores();
    // Seed session store
    useSessionStore.setState({
      sessions: new Map([[SESSION_ID, makeSession()]]),
      activeSessionId: SESSION_ID,
    });
    // Seed workspace store
    useWorkspaceStore.getState().getOrCreateWorkspace(PROFILE_ID, USER_ID);
  });

  afterEach(() => {
    resetStores();
  });

  it("terminal-tabs container is the same DOM node after switching from null to sftp", () => {
    const { container } = render(<TerminalTabs sessionId={SESSION_ID} />);

    const nodeBefore = container.querySelector(".terminal-tabs");
    expect(nodeBefore).not.toBeNull();

    // Simulate opening the SFTP panel section
    act(() => {
      useWorkspaceStore.getState().setPanelSection(WORKSPACE_KEY, "sftp");
      useWorkspaceStore.getState().setPanelOpen(WORKSPACE_KEY, true);
    });

    const nodeAfter = container.querySelector(".terminal-tabs");
    expect(nodeAfter).toBe(nodeBefore);
  });

  it("terminal-tabs container is the same DOM node after switching sftp → tunnel", () => {
    const { container } = render(<TerminalTabs sessionId={SESSION_ID} />);

    act(() => {
      useWorkspaceStore.getState().setPanelSection(WORKSPACE_KEY, "sftp");
      useWorkspaceStore.getState().setPanelOpen(WORKSPACE_KEY, true);
    });

    const nodeBefore = container.querySelector(".terminal-tabs");

    act(() => {
      useWorkspaceStore.getState().setPanelSection(WORKSPACE_KEY, "tunnel");
    });

    const nodeAfter = container.querySelector(".terminal-tabs");
    expect(nodeAfter).toBe(nodeBefore);
  });

  it("terminal-tabs container is the same DOM node after closing the panel", () => {
    const { container } = render(<TerminalTabs sessionId={SESSION_ID} />);

    act(() => {
      useWorkspaceStore.getState().setPanelSection(WORKSPACE_KEY, "sftp");
      useWorkspaceStore.getState().setPanelOpen(WORKSPACE_KEY, true);
    });

    const nodeBefore = container.querySelector(".terminal-tabs");

    act(() => {
      useWorkspaceStore.getState().setPanelOpen(WORKSPACE_KEY, false);
    });

    const nodeAfter = container.querySelector(".terminal-tabs");
    expect(nodeAfter).toBe(nodeBefore);
  });
});
