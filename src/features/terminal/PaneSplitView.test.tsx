// PaneSplitView.test.tsx — TDD RED phase
//
// Tests for the split-pane container component.
// Uses mocked TerminalView so we stay pure jsdom (no real xterm).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { usePaneLayoutStore } from "../../stores/paneLayoutStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionEntry } from "../../stores/sessionStore";
import type { PaneLayout } from "../../stores/paneLayoutStore";

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
    loadAddon: vi.fn(),
    open: vi.fn(),
    cols: 80, rows: 24,
    onData: vi.fn(), onBinary: vi.fn(),
    focus: vi.fn(), dispose: vi.fn(),
    write: vi.fn(), writeln: vi.fn(),
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

// Mock TerminalView — we only care about layout, not real terminal
vi.mock("./TerminalView", () => ({
  TerminalView: ({
    terminalId,
    isSplitPane,
  }: {
    terminalId: string | null;
    isSplitPane?: boolean;
  }) => (
    <div
      data-testid="terminal-view"
      data-terminal-id={terminalId ?? "pending"}
      data-split-pane={isSplitPane ? "true" : "false"}
    />
  ),
}));

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStores() {
  usePaneLayoutStore.setState({ layouts: {} });
  useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
}

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

// Typed helper to get a slot at index without noUncheckedIndexedAccess errors
function slotAt(layout: PaneLayout, idx: number) {
  const s = layout.slots[idx];
  if (!s) throw new Error(`No slot at index ${idx}`);
  return s;
}

import { PaneSplitView } from "./PaneSplitView";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PaneSplitView — single-pane (slots.length === 1)", () => {
  beforeEach(resetStores);

  it("renders a TerminalView for the single slot", () => {
    const sessionId = "sess-single";
    const session = makeSession(sessionId);
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });
    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");

    const { container } = render(
      <PaneSplitView sessionId={sessionId} />,
    );
    const views = screen.getAllByTestId("terminal-view");
    expect(views).toHaveLength(1);
    // Single pane: isSplitPane should be false (single-terminal mode)
    expect(views[0]!.dataset.splitPane).toBe("false");
    // No split container when only 1 slot
    expect(container.querySelector(".terminal-split")).toBeNull();
  });
});

describe("PaneSplitView — multi-pane", () => {
  beforeEach(resetStores);

  it("renders N TerminalViews for N slots", () => {
    const sessionId = "sess-multi";
    const session = {
      ...makeSession(sessionId),
      terminals: [
        { id: "term-1", label: "Terminal 1", sessionId, reactKey: "rk-1" },
        { id: "term-2", label: "Terminal 2", sessionId, reactKey: "rk-2" },
      ],
      activeTerminalId: "term-1",
    };
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });

    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const firstSlotId = slotAt(layout, 0).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, firstSlotId);
    const layout2 = usePaneLayoutStore.getState().layouts[sessionId]!;
    const secondSlotId = slotAt(layout2, 1).id;
    usePaneLayoutStore.getState().assignTerminal(sessionId, secondSlotId, "term-2");

    render(<PaneSplitView sessionId={sessionId} />);
    const views = screen.getAllByTestId("terminal-view");
    expect(views).toHaveLength(2);
    // All panes in split mode should have isSplitPane=true
    views.forEach((v) => expect(v.dataset.splitPane).toBe("true"));
  });

  it("renders the .terminal-split container for multi-pane", () => {
    const sessionId = "sess-split-container";
    const session = {
      ...makeSession(sessionId),
      terminals: [
        { id: "term-1", label: "Terminal 1", sessionId, reactKey: "rk-1" },
        { id: "term-2", label: "Terminal 2", sessionId, reactKey: "rk-2" },
      ],
      activeTerminalId: "term-1",
    };
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });
    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const firstId = slotAt(layout, 0).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, firstId);

    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    expect(container.querySelector(".terminal-split")).not.toBeNull();
  });

  it("renders a SplitHandle between each pair of panes", () => {
    const sessionId = "sess-handles";
    const session = {
      ...makeSession(sessionId),
      terminals: [
        { id: "term-1", label: "Terminal 1", sessionId, reactKey: "rk-1" },
        { id: "term-2", label: "Terminal 2", sessionId, reactKey: "rk-2" },
        { id: "term-3", label: "Terminal 3", sessionId, reactKey: "rk-3" },
      ],
      activeTerminalId: "term-1",
    };
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });
    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
    const l1 = usePaneLayoutStore.getState().layouts[sessionId]!;
    const s1 = slotAt(l1, 0).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, s1);
    const l2 = usePaneLayoutStore.getState().layouts[sessionId]!;
    const s2 = slotAt(l2, 1).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, s2);

    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    // 3 panes = 2 handles
    const handles = container.querySelectorAll(".terminal-split-handle");
    expect(handles).toHaveLength(2);
  });

  it("renders the focused pane with the data-focused attribute", () => {
    const sessionId = "sess-focused";
    const session = {
      ...makeSession(sessionId),
      terminals: [
        { id: "term-1", label: "Terminal 1", sessionId, reactKey: "rk-1" },
        { id: "term-2", label: "Terminal 2", sessionId, reactKey: "rk-2" },
      ],
      activeTerminalId: "term-1",
    };
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });
    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const firstSlotId = slotAt(layout, 0).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, firstSlotId);

    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    const panes = container.querySelectorAll(".terminal-split-pane");
    // First pane focused by default
    expect(panes[0]!.getAttribute("data-focused")).toBe("true");
    expect(panes[1]!.getAttribute("data-focused")).toBe("false");
  });
});

describe("PaneSplitView — a11y", () => {
  beforeEach(resetStores);

  it("gives each pane role=region with an aria-label", () => {
    const sessionId = "sess-a11y";
    const session = {
      ...makeSession(sessionId),
      terminals: [
        { id: "term-1", label: "Terminal 1", sessionId, reactKey: "rk-1" },
        { id: "term-2", label: "Terminal 2", sessionId, reactKey: "rk-2" },
      ],
      activeTerminalId: "term-1",
    };
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });
    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const firstId = slotAt(layout, 0).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, firstId);

    render(<PaneSplitView sessionId={sessionId} />);
    const regions = screen.getAllByRole("region");
    expect(regions.length).toBeGreaterThanOrEqual(2);
    regions.forEach((r) => expect(r.getAttribute("aria-label")).not.toBeNull());
  });

  it("clicking a pane calls focusSlot", () => {
    const sessionId = "sess-click";
    const session = {
      ...makeSession(sessionId),
      terminals: [
        { id: "term-1", label: "Terminal 1", sessionId, reactKey: "rk-1" },
        { id: "term-2", label: "Terminal 2", sessionId, reactKey: "rk-2" },
      ],
      activeTerminalId: "term-1",
    };
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });
    usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const firstId = slotAt(layout, 0).id;
    usePaneLayoutStore.getState().splitSlot(sessionId, firstId);
    const layout2 = usePaneLayoutStore.getState().layouts[sessionId]!;
    const secondId = slotAt(layout2, 1).id;

    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    const panes = container.querySelectorAll(".terminal-split-pane");
    fireEvent.click(panes[1]!);

    expect(usePaneLayoutStore.getState().layouts[sessionId]!.focusedSlotId).toBe(secondId);
  });
});
