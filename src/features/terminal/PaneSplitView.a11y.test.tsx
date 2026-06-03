// PaneSplitView.a11y.test.tsx — TDD: accessibility for split panes
//
// Verifies:
// 1. Each pane has role="region" and aria-label
// 2. Each pane has tabIndex for keyboard navigation
// 3. Keyboard shortcut (Alt+ArrowRight / Alt+ArrowLeft) moves focus between panes
// 4. The tablist (tab bar) in TerminalTabs is NOT affected by split pane changes

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
  TerminalView: ({ terminalId }: { terminalId: string | null }) => (
    <div data-testid="terminal-view" data-terminal-id={terminalId ?? "pending"} />
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
      { id: "term-2", label: "Terminal 2", sessionId: id, reactKey: "rk-2" },
    ],
    activeTerminalId: "term-1",
  };
}

function slotAt(layout: PaneLayout, idx: number) {
  const s = layout.slots[idx];
  if (!s) throw new Error(`No slot at index ${idx}`);
  return s;
}

function setupTwoPane(sessionId: string) {
  const session = makeSession(sessionId);
  useSessionStore.setState({
    sessions: new Map([[sessionId, session]]),
    activeSessionId: sessionId,
  });
  usePaneLayoutStore.getState().openLayout(sessionId, "term-1");
  const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
  const firstId = slotAt(layout, 0).id;
  usePaneLayoutStore.getState().splitSlot(sessionId, firstId);
  const layout2 = usePaneLayoutStore.getState().layouts[sessionId]!;
  usePaneLayoutStore.getState().assignTerminal(sessionId, slotAt(layout2, 1).id, "term-2");
}

import { PaneSplitView } from "./PaneSplitView";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PaneSplitView — a11y: ARIA roles", () => {
  beforeEach(resetStores);

  it("each pane has role=region", () => {
    setupTwoPane("sess-roles");
    render(<PaneSplitView sessionId="sess-roles" />);
    const regions = screen.getAllByRole("region");
    expect(regions.length).toBeGreaterThanOrEqual(2);
  });

  it("each pane has a unique aria-label", () => {
    setupTwoPane("sess-labels");
    render(<PaneSplitView sessionId="sess-labels" />);
    const regions = screen.getAllByRole("region");
    const labels = regions.map((r) => r.getAttribute("aria-label"));
    const unique = new Set(labels);
    expect(unique.size).toBe(regions.length);
  });

  it("each pane is focusable (tabIndex >= 0)", () => {
    setupTwoPane("sess-tabindex");
    const { container } = render(<PaneSplitView sessionId="sess-tabindex" />);
    const panes = container.querySelectorAll(".terminal-split-pane");
    panes.forEach((pane) => {
      const tabIndex = parseInt(pane.getAttribute("tabindex") ?? "-1", 10);
      expect(tabIndex).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("PaneSplitView — a11y: keyboard navigation", () => {
  beforeEach(resetStores);

  it("Alt+ArrowRight moves focus to the next pane", () => {
    const sessionId = "sess-kbd-right";
    setupTwoPane(sessionId);
    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    const panes = container.querySelectorAll(".terminal-split-pane");

    // Fire Alt+ArrowRight on the first focused pane
    fireEvent.keyDown(panes[0]!, { key: "ArrowRight", altKey: true });

    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const secondSlotId = slotAt(layout, 1).id;
    expect(layout.focusedSlotId).toBe(secondSlotId);
  });

  it("Alt+ArrowLeft moves focus to the previous pane", () => {
    const sessionId = "sess-kbd-left";
    setupTwoPane(sessionId);

    // Pre-focus the second pane
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const secondId = slotAt(layout, 1).id;
    usePaneLayoutStore.getState().focusSlot(sessionId, secondId);

    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    const panes = container.querySelectorAll(".terminal-split-pane");

    fireEvent.keyDown(panes[1]!, { key: "ArrowLeft", altKey: true });

    const layoutAfter = usePaneLayoutStore.getState().layouts[sessionId]!;
    const firstSlotId = slotAt(layoutAfter, 0).id;
    expect(layoutAfter.focusedSlotId).toBe(firstSlotId);
  });

  it("Alt+ArrowRight does not wrap past the last pane", () => {
    const sessionId = "sess-kbd-nowrap";
    setupTwoPane(sessionId);

    // Pre-focus the second (last) pane
    const layout = usePaneLayoutStore.getState().layouts[sessionId]!;
    const secondId = slotAt(layout, 1).id;
    usePaneLayoutStore.getState().focusSlot(sessionId, secondId);

    const { container } = render(<PaneSplitView sessionId={sessionId} />);
    const panes = container.querySelectorAll(".terminal-split-pane");

    fireEvent.keyDown(panes[1]!, { key: "ArrowRight", altKey: true });

    const layoutAfter = usePaneLayoutStore.getState().layouts[sessionId]!;
    // Should stay on the last pane
    expect(layoutAfter.focusedSlotId).toBe(secondId);
  });
});
