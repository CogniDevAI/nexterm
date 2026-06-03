// TerminalTabs.split.test.tsx — TDD: split-pane wiring in TerminalTabs
//
// Verifies that TerminalTabs correctly:
// 1. Renders a split button in the tab bar
// 2. Initializes the pane layout on first render
// 3. Invokes PaneSplitView for the terminal area
// 4. Does NOT break the existing tablist / WAI-ARIA behavior

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useSessionStore } from "../../stores/sessionStore";
import { usePaneLayoutStore } from "../../stores/paneLayoutStore";
import type { SessionEntry } from "../../stores/sessionStore";

// ── Global stubs ──────────────────────────────────────────────────────────────

vi.hoisted(() => {
  globalThis.ResizeObserver = class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(_: ResizeObserverCallback) {}
  };
});

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

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(), open: vi.fn(), cols: 80, rows: 24,
    onData: vi.fn(), onBinary: vi.fn(), focus: vi.fn(), dispose: vi.fn(),
    write: vi.fn(), writeln: vi.fn(), element: document.createElement("div"),
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
    activate: vi.fn(), dispose: vi.fn(),
    findNext: vi.fn().mockReturnValue(false),
    findPrevious: vi.fn().mockReturnValue(false),
    onDidChangeResults: vi.fn(),
  })),
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    onContextLoss: vi.fn(), dispose: vi.fn(),
  })),
}));

vi.mock("./TerminalView", () => ({
  TerminalView: ({ active, isSplitPane }: { active: boolean; isSplitPane?: boolean }) => (
    <div
      data-testid="terminal-view"
      data-active={active}
      data-split-pane={isSplitPane ? "true" : "false"}
    />
  ),
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(id: string): SessionEntry {
  return {
    id,
    profileId: "p1",
    profileName: "Test",
    host: "host",
    userId: "u1",
    username: "user",
    port: 22,
    connectedAt: Date.now(),
    state: "connected",
    terminals: [
      { id: "term-1", label: "Terminal 1", sessionId: id, reactKey: "rk-1" },
    ],
    activeTerminalId: "term-1",
  };
}

function resetStores() {
  useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
  usePaneLayoutStore.setState({ layouts: {} });
}

import { TerminalTabs } from "./TerminalTabs";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TerminalTabs — split button", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("renders a split-horizontal button in the tab bar", () => {
    const session = makeSession("sid-split-1");
    useSessionStore.setState({
      sessions: new Map([["sid-split-1", session]]),
      activeSessionId: "sid-split-1",
    });
    render(<TerminalTabs sessionId="sid-split-1" />);
    const splitBtn = document.querySelector(".terminal-tab-split");
    expect(splitBtn).not.toBeNull();
  });

  it("tablist is still present after mounting with split feature", () => {
    const session = makeSession("sid-split-2");
    useSessionStore.setState({
      sessions: new Map([["sid-split-2", session]]),
      activeSessionId: "sid-split-2",
    });
    render(<TerminalTabs sessionId="sid-split-2" />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });
});

describe("TerminalTabs — pane layout initialization", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("initializes a pane layout for the session on first render", async () => {
    const session = makeSession("sid-init");
    useSessionStore.setState({
      sessions: new Map([["sid-init", session]]),
      activeSessionId: "sid-init",
    });
    render(<TerminalTabs sessionId="sid-init" />);

    // After mount + effect, layout should exist
    await act(async () => {});
    const layout = usePaneLayoutStore.getState().layouts["sid-init"];
    expect(layout).toBeDefined();
  });

  it("layout starts with exactly one slot when session has one terminal", async () => {
    const session = makeSession("sid-one-slot");
    useSessionStore.setState({
      sessions: new Map([["sid-one-slot", session]]),
      activeSessionId: "sid-one-slot",
    });
    render(<TerminalTabs sessionId="sid-one-slot" />);

    await act(async () => {});
    const layout = usePaneLayoutStore.getState().layouts["sid-one-slot"];
    expect(layout?.slots).toHaveLength(1);
  });

  it("removes the layout when session is removed", async () => {
    const session = makeSession("sid-cleanup");
    useSessionStore.setState({
      sessions: new Map([["sid-cleanup", session]]),
      activeSessionId: "sid-cleanup",
    });
    const { unmount } = render(<TerminalTabs sessionId="sid-cleanup" />);

    await act(async () => {});
    expect(usePaneLayoutStore.getState().layouts["sid-cleanup"]).toBeDefined();

    unmount();
    expect(usePaneLayoutStore.getState().layouts["sid-cleanup"]).toBeUndefined();
  });
});

// ── WU-5: Broadcast toggle button ─────────────────────────────────────────────

describe("TerminalTabs — broadcast toggle button", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("broadcast toggle button is NOT rendered when paneCount < 2", async () => {
    const session = makeSession("sid-bcast-1");
    useSessionStore.setState({
      sessions: new Map([["sid-bcast-1", session]]),
      activeSessionId: "sid-bcast-1",
    });
    render(<TerminalTabs sessionId="sid-bcast-1" />);
    await act(async () => {});

    // Only 1 slot → paneCount < 2 → toggle must not render
    const broadcastBtn = document.querySelector(".terminal-tab-broadcast");
    expect(broadcastBtn).toBeNull();
  });

  it("broadcast toggle button IS rendered when paneCount >= 2", async () => {
    const session = makeSession("sid-bcast-2");
    useSessionStore.setState({
      sessions: new Map([["sid-bcast-2", session]]),
      activeSessionId: "sid-bcast-2",
    });
    render(<TerminalTabs sessionId="sid-bcast-2" />);
    await act(async () => {});

    // Manually seed a 2-slot layout
    const layout = usePaneLayoutStore.getState().layouts["sid-bcast-2"];
    if (layout) {
      usePaneLayoutStore.getState().splitSlot("sid-bcast-2", layout.slots[0]!.id);
    }

    // Re-render to pick up new paneCount
    const { rerender } = render(<TerminalTabs sessionId="sid-bcast-2" />);
    await act(async () => {});
    rerender(<TerminalTabs sessionId="sid-bcast-2" />);

    const broadcastBtn = document.querySelector(".terminal-tab-broadcast");
    expect(broadcastBtn).not.toBeNull();
  });

  it("broadcast toggle button has aria-pressed='false' when broadcastEnabled is false", async () => {
    const session = makeSession("sid-bcast-3");
    useSessionStore.setState({
      sessions: new Map([["sid-bcast-3", session]]),
      activeSessionId: "sid-bcast-3",
    });

    // Pre-seed a 2-slot layout with broadcastEnabled: false
    usePaneLayoutStore.setState({
      layouts: {
        "sid-bcast-3": {
          direction: "horizontal",
          slots: [
            { id: "s1", terminalId: "term-1", ratio: 0.5 },
            { id: "s2", terminalId: "term-2", ratio: 0.5 },
          ],
          focusedSlotId: "s1",
          broadcastEnabled: false,
        },
      },
    });

    render(<TerminalTabs sessionId="sid-bcast-3" />);
    await act(async () => {});

    const broadcastBtn = document.querySelector<HTMLButtonElement>(".terminal-tab-broadcast");
    expect(broadcastBtn).not.toBeNull();
    expect(broadcastBtn?.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking broadcast toggle calls toggleBroadcast in the store", async () => {
    const session = makeSession("sid-bcast-4");
    useSessionStore.setState({
      sessions: new Map([["sid-bcast-4", session]]),
      activeSessionId: "sid-bcast-4",
    });

    usePaneLayoutStore.setState({
      layouts: {
        "sid-bcast-4": {
          direction: "horizontal",
          slots: [
            { id: "s1", terminalId: "term-1", ratio: 0.5 },
            { id: "s2", terminalId: "term-2", ratio: 0.5 },
          ],
          focusedSlotId: "s1",
          broadcastEnabled: false,
        },
      },
    });

    render(<TerminalTabs sessionId="sid-bcast-4" />);
    await act(async () => {});

    const broadcastBtn = document.querySelector<HTMLButtonElement>(".terminal-tab-broadcast");
    expect(broadcastBtn).not.toBeNull();

    await act(async () => {
      broadcastBtn!.click();
    });

    const layout = usePaneLayoutStore.getState().layouts["sid-bcast-4"];
    expect(layout?.broadcastEnabled).toBe(true);
  });

  it("aria-pressed reflects broadcastEnabled state in the store", async () => {
    const session = makeSession("sid-bcast-5");
    useSessionStore.setState({
      sessions: new Map([["sid-bcast-5", session]]),
      activeSessionId: "sid-bcast-5",
    });

    usePaneLayoutStore.setState({
      layouts: {
        "sid-bcast-5": {
          direction: "horizontal",
          slots: [
            { id: "s1", terminalId: "term-1", ratio: 0.5 },
            { id: "s2", terminalId: "term-2", ratio: 0.5 },
          ],
          focusedSlotId: "s1",
          broadcastEnabled: true,
        },
      },
    });

    render(<TerminalTabs sessionId="sid-bcast-5" />);
    await act(async () => {});

    const broadcastBtn = document.querySelector<HTMLButtonElement>(".terminal-tab-broadcast");
    expect(broadcastBtn?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("TerminalTabs — split action creates a new pane", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("clicking split adds a slot to the pane layout", async () => {
    const session = makeSession("sid-click-split");
    useSessionStore.setState({
      sessions: new Map([["sid-click-split", session]]),
      activeSessionId: "sid-click-split",
    });
    render(<TerminalTabs sessionId="sid-click-split" />);

    await act(async () => {});
    const layout = usePaneLayoutStore.getState().layouts["sid-click-split"];
    expect(layout?.slots).toHaveLength(1);

    const splitBtn = document.querySelector<HTMLButtonElement>(".terminal-tab-split");
    expect(splitBtn).not.toBeNull();
    await act(async () => {
      splitBtn!.click();
    });

    const layoutAfter = usePaneLayoutStore.getState().layouts["sid-click-split"];
    expect(layoutAfter?.slots).toHaveLength(2);
  });

  it("clicking split also adds a new TerminalTab to the session", async () => {
    const session = makeSession("sid-click-split-tab");
    useSessionStore.setState({
      sessions: new Map([["sid-click-split-tab", session]]),
      activeSessionId: "sid-click-split-tab",
    });
    render(<TerminalTabs sessionId="sid-click-split-tab" />);

    await act(async () => {});

    const splitBtn = document.querySelector<HTMLButtonElement>(".terminal-tab-split");
    await act(async () => {
      splitBtn!.click();
    });

    const updatedSession = useSessionStore.getState().sessions.get("sid-click-split-tab");
    // Should now have 2 terminal tabs (original + new pending)
    expect(updatedSession!.terminals).toHaveLength(2);
  });
});
