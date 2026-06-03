// TerminalTabs.fix.test.tsx — TDD RED phase: regression tests for FIX PASS
//
// CRITICAL-1: single-pane multi-tab renders blank on "+"
//   - With 2 tabs and NO split (<=1 slot), both TerminalViews must render.
//   - Active tab has display:block, inactive display:none.
//   - Clicking "+" keeps a visible active terminal (not blank).
//
// CRITICAL-2: closing a tab while split orphans its pane
//   - With 2 panes (2 slots), closing one tab removes its slot.
//   - Ratios renormalize. Slots drop below 2 → single-pane mode.
//
// MAJOR-1: close-pane button exists and is wired (non-destructive)
//   - A per-pane close button (× or similar) must exist in split mode.
//   - Clicking it removes the slot (not the tab). Slots < 2 → single-pane.
//
// MAJOR-2: active prop only true for the focused pane in split mode
//   - Only the focused pane's TerminalView gets active=true.
//   - Clicking a pane makes it active.

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
      get length() {
        return store.size;
      },
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

// TerminalView mock that reports active and isSplitPane as attributes
vi.mock("./TerminalView", () => ({
  TerminalView: ({
    active,
    isSplitPane,
    terminalId,
  }: {
    active: boolean;
    isSplitPane?: boolean;
    terminalId?: string | null;
    sessionId?: string;
    onTerminalOpened?: (id: string) => void;
    reactKey?: string;
  }) => (
    <div
      data-testid="terminal-view"
      data-active={String(active)}
      data-split-pane={isSplitPane ? "true" : "false"}
      data-terminal-id={terminalId ?? ""}
    />
  ),
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(id: string, terminalCount = 1): SessionEntry {
  const terminals = Array.from({ length: terminalCount }, (_, i) => ({
    id: `term-${i + 1}`,
    label: `Terminal ${i + 1}`,
    sessionId: id,
    reactKey: `rk-${i + 1}`,
  }));
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
    terminals,
    activeTerminalId: "term-1",
  };
}

function resetStores() {
  useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
  usePaneLayoutStore.setState({ layouts: {} });
}

import { TerminalTabs } from "./TerminalTabs";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CRITICAL-1: single-pane multi-tab renders all tabs", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("renders TWO TerminalViews when session has 2 tabs and no split (1 slot)", async () => {
    // Session with 2 real tabs, no split
    const session = makeSession("sid-multi", 2);
    useSessionStore.setState({
      sessions: new Map([["sid-multi", session]]),
      activeSessionId: "sid-multi",
    });
    // Seed layout with 1 slot (unsplit)
    usePaneLayoutStore.getState().openLayout("sid-multi", "term-1");
    expect(usePaneLayoutStore.getState().layouts["sid-multi"]?.slots).toHaveLength(1);

    render(<TerminalTabs sessionId="sid-multi" />);
    await act(async () => {});

    // Both TerminalViews must be in the DOM
    const views = screen.getAllByTestId("terminal-view");
    expect(views.length).toBeGreaterThanOrEqual(2);
  });

  it("active tab has data-active=true, inactive tab has data-active=false in single-pane mode", async () => {
    const session = makeSession("sid-active", 2);
    // term-1 is active
    useSessionStore.setState({
      sessions: new Map([["sid-active", session]]),
      activeSessionId: "sid-active",
    });
    usePaneLayoutStore.getState().openLayout("sid-active", "term-1");

    render(<TerminalTabs sessionId="sid-active" />);
    await act(async () => {});

    const views = screen.getAllByTestId("terminal-view");
    const activeViews = views.filter((v) => v.getAttribute("data-active") === "true");
    const inactiveViews = views.filter((v) => v.getAttribute("data-active") === "false");
    // Exactly one active, at least one inactive
    expect(activeViews.length).toBe(1);
    expect(inactiveViews.length).toBeGreaterThanOrEqual(1);
  });

  it("all TerminalViews in single-pane mode have isSplitPane=false", async () => {
    const session = makeSession("sid-nosplit", 2);
    useSessionStore.setState({
      sessions: new Map([["sid-nosplit", session]]),
      activeSessionId: "sid-nosplit",
    });
    usePaneLayoutStore.getState().openLayout("sid-nosplit", "term-1");

    render(<TerminalTabs sessionId="sid-nosplit" />);
    await act(async () => {});

    const views = screen.getAllByTestId("terminal-view");
    for (const v of views) {
      expect(v.getAttribute("data-split-pane")).toBe("false");
    }
  });
});

describe("CRITICAL-2: closing a tab while split removes its pane slot", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("closing one tab in split mode removes its slot and returns to single-pane", async () => {
    const session = makeSession("sid-close-split", 2);
    useSessionStore.setState({
      sessions: new Map([["sid-close-split", session]]),
      activeSessionId: "sid-close-split",
    });
    // Seed layout with 2 slots (split active)
    usePaneLayoutStore.getState().openLayout("sid-close-split", "term-1");
    usePaneLayoutStore.getState().splitSlot(
      "sid-close-split",
      usePaneLayoutStore.getState().layouts["sid-close-split"]!.slots[0]!.id,
    );
    // Assign term-2 to slot-1
    const slots = usePaneLayoutStore.getState().layouts["sid-close-split"]!.slots;
    usePaneLayoutStore.getState().assignTerminal("sid-close-split", slots[1]!.id, "term-2");

    expect(usePaneLayoutStore.getState().layouts["sid-close-split"]?.slots).toHaveLength(2);

    render(<TerminalTabs sessionId="sid-close-split" />);
    await act(async () => {});

    // Close the first tab (term-1) via its × button
    const closeButtons = document.querySelectorAll(".terminal-tab-close");
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      (closeButtons[0] as HTMLButtonElement).click();
    });

    // Slot count must drop below 2 (returns to single-pane)
    const layoutAfter = usePaneLayoutStore.getState().layouts["sid-close-split"];
    const slotCount = layoutAfter?.slots.length ?? 0;
    expect(slotCount).toBeLessThan(2);
  });

  it("closing a tab in split mode also removes the corresponding tab from session", async () => {
    const session = makeSession("sid-tab-close", 2);
    useSessionStore.setState({
      sessions: new Map([["sid-tab-close", session]]),
      activeSessionId: "sid-tab-close",
    });
    usePaneLayoutStore.getState().openLayout("sid-tab-close", "term-1");
    usePaneLayoutStore.getState().splitSlot(
      "sid-tab-close",
      usePaneLayoutStore.getState().layouts["sid-tab-close"]!.slots[0]!.id,
    );
    const slots = usePaneLayoutStore.getState().layouts["sid-tab-close"]!.slots;
    usePaneLayoutStore.getState().assignTerminal("sid-tab-close", slots[1]!.id, "term-2");

    render(<TerminalTabs sessionId="sid-tab-close" />);
    await act(async () => {});

    const closeButtons = document.querySelectorAll(".terminal-tab-close");
    await act(async () => {
      (closeButtons[0] as HTMLButtonElement).click();
    });

    // One tab should have been removed
    const updatedSession = useSessionStore.getState().sessions.get("sid-tab-close");
    expect(updatedSession?.terminals.length).toBe(1);
  });
});

describe("MAJOR-2: active prop only for focused pane in split mode", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("only the focused pane's TerminalView gets active=true in split mode", async () => {
    const session = makeSession("sid-focus", 2);
    useSessionStore.setState({
      sessions: new Map([["sid-focus", session]]),
      activeSessionId: "sid-focus",
    });
    usePaneLayoutStore.getState().openLayout("sid-focus", "term-1");
    usePaneLayoutStore.getState().splitSlot(
      "sid-focus",
      usePaneLayoutStore.getState().layouts["sid-focus"]!.slots[0]!.id,
    );
    const slots = usePaneLayoutStore.getState().layouts["sid-focus"]!.slots;
    usePaneLayoutStore.getState().assignTerminal("sid-focus", slots[1]!.id, "term-2");

    render(<TerminalTabs sessionId="sid-focus" />);
    await act(async () => {});

    // In split mode, active=true must only be on the focused pane
    const views = screen.getAllByTestId("terminal-view");
    const activeViews = views.filter((v) => v.getAttribute("data-active") === "true");
    // Exactly one pane should have active=true
    expect(activeViews.length).toBe(1);
  });
});
