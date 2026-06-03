// features/terminal/useTerminal.broadcast.test.ts — TDD: WU-3 RED phase
//
// Tests for the broadcast fan-out injected in useTerminal's onData + onBinary.
// Verifies that write_terminal is called for target panes when broadcastEnabled,
// and NOT called for the source, pending slots, or when broadcast is off.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePaneLayoutStore } from "../../stores/paneLayoutStore";
import { useSessionStore } from "../../stores/sessionStore";

// ── localStorage stub ─────────────────────────────────────────────────────────

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

// ── Mock heavy native modules ─────────────────────────────────────────────────

// Capture onData / onBinary callbacks so we can invoke them directly in tests
type DataCallback = (data: string) => void;
type BinaryCallback = (data: string) => void;

let capturedOnData: DataCallback | null = null;
let capturedOnBinary: BinaryCallback | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(function MockTerminal() {
    return {
      loadAddon: vi.fn(),
      open: vi.fn(),
      cols: 80,
      rows: 24,
      onData: vi.fn().mockImplementation((cb: DataCallback) => {
        capturedOnData = cb;
        return { dispose: vi.fn() };
      }),
      onBinary: vi.fn().mockImplementation((cb: BinaryCallback) => {
        capturedOnBinary = cb;
        return { dispose: vi.fn() };
      }),
      focus: vi.fn(),
      dispose: vi.fn(),
      write: vi.fn(),
      writeln: vi.fn(),
      element: null,
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(""),
    };
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function MockFitAddon() {
    return { fit: vi.fn(), dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function MockWebLinksAddon() {
    return { dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(function MockSearchAddon() {
    return {
      activate: vi.fn(),
      dispose: vi.fn(),
      findNext: vi.fn().mockReturnValue(false),
      findPrevious: vi.fn().mockReturnValue(false),
      onDidChangeResults: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(function MockWebglAddon() {
    return { onContextLoss: vi.fn(), dispose: vi.fn() };
  }),
}));

// tauriInvoke is what we'll assert against for fan-out calls
const mockTauriInvoke = vi.fn();
vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => mockTauriInvoke(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(function MockChannel() {
    return { onmessage: null };
  }),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../stores/commandHistoryStore", () => ({
  useCommandHistoryStore: {
    getState: vi.fn(() => ({
      captureEnabled: false,
      addCommand: vi.fn(),
    })),
  },
}));

// ── ResizeObserver + navigator.clipboard stubs ────────────────────────────────

if (typeof ResizeObserver === "undefined") {
  (globalThis as Record<string, unknown>).ResizeObserver = vi.fn().mockImplementation(
    function MockResizeObserver(_cb: ResizeObserverCallback) {
      return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    },
  );
}
if (typeof navigator.clipboard === "undefined") {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
}

import { useTerminal } from "./useTerminal";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID = "broadcast-test-sess";
const SESSION_STATE = "connected" as const;

function seedSession() {
  useSessionStore.setState({
    sessions: new Map([
      [
        SESSION_ID,
        {
          id: SESSION_ID,
          profileId: "p1",
          profileName: "Test",
          host: "host",
          userId: "u1",
          username: "user",
          port: 22,
          connectedAt: Date.now(),
          state: SESSION_STATE,
          terminals: [],
          activeTerminalId: null,
        } as never,
      ],
    ]),
    activeSessionId: SESSION_ID,
  });
}

function resetAll() {
  capturedOnData = null;
  capturedOnBinary = null;
  mockTauriInvoke.mockReset();
  usePaneLayoutStore.setState({ layouts: {} });
  useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useTerminal — broadcast fan-out (onData)", () => {
  beforeEach(resetAll);

  it("writes to source pane only when broadcastEnabled is false", async () => {
    seedSession();
    // tauriInvoke for open_terminal returns a terminalId string
    mockTauriInvoke.mockResolvedValueOnce("term-src");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    // Seed layout with broadcastEnabled: false (default)
    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-src", ratio: 0.5 },
            { id: "slot-2", terminalId: "term-target", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: false,
        },
      },
    });

    // Reset mock to count only the fan-out invocations
    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    // Fire onData
    await act(async () => {
      capturedOnData?.("ls");
    });

    // Only write_terminal for the source — exactly 1 call
    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]![1]).toMatchObject({ terminalId: sourceId });
  });

  it("fans out to target pane when broadcastEnabled is true (onData)", async () => {
    seedSession();
    mockTauriInvoke.mockResolvedValueOnce("term-src");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-src", ratio: 0.5 },
            { id: "slot-2", terminalId: "term-target", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: true,
        },
      },
    });

    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    await act(async () => {
      capturedOnData?.("echo hi");
    });

    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    // Source + 1 target = 2 calls
    expect(writeCalls).toHaveLength(2);
    const termIds = writeCalls.map((c) => (c[1] as Record<string, unknown>).terminalId);
    expect(termIds).toContain(sourceId);
    expect(termIds).toContain("term-target");
  });

  it("does NOT double-write to source (source appears exactly once)", async () => {
    seedSession();
    mockTauriInvoke.mockResolvedValueOnce("term-src");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-src", ratio: 0.5 },
            { id: "slot-2", terminalId: "term-target", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: true,
        },
      },
    });

    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    await act(async () => {
      capturedOnData?.("pwd");
    });

    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    const sourceWrites = writeCalls.filter(
      (c) => (c[1] as Record<string, unknown>).terminalId === sourceId,
    );
    // Source written exactly once — never twice
    expect(sourceWrites).toHaveLength(1);
  });

  it("does NOT fan out to pending slots (terminalId starts with 'pending-')", async () => {
    seedSession();
    mockTauriInvoke.mockResolvedValueOnce("term-src");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-src", ratio: 0.5 },
            { id: "slot-2", terminalId: "pending-abc123", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: true,
        },
      },
    });

    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    await act(async () => {
      capturedOnData?.("ls");
    });

    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    // Only source — pending slot excluded
    expect(writeCalls).toHaveLength(1);
    expect((writeCalls[0]![1] as Record<string, unknown>).terminalId).toBe(sourceId);
  });
});

describe("useTerminal — broadcast fan-out (disconnected session)", () => {
  beforeEach(resetAll);

  it("does NOT fan out when session state is 'disconnected' (getBroadcastTargets disconnected branch)", async () => {
    // Seed session as disconnected — getBroadcastTargets must return [] for any non-"connected" state
    useSessionStore.setState({
      sessions: new Map([
        [
          SESSION_ID,
          {
            id: SESSION_ID,
            profileId: "p1",
            profileName: "Test",
            host: "host",
            userId: "u1",
            username: "user",
            port: 22,
            connectedAt: Date.now(),
            state: "disconnected" as const,
            terminals: [],
            activeTerminalId: null,
          } as never,
        ],
      ]),
      activeSessionId: SESSION_ID,
    });

    mockTauriInvoke.mockResolvedValueOnce("term-disconnected-src");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-disconnected-src", ratio: 0.5 },
            { id: "slot-2", terminalId: "term-target-disc", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: true,
        },
      },
    });

    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    await act(async () => {
      capturedOnData?.("ls");
    });

    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    // Session disconnected → getBroadcastTargets returns [] → only source write fires
    expect(writeCalls).toHaveLength(1);
    expect((writeCalls[0]![1] as Record<string, unknown>).terminalId).toBe(sourceId);
  });
});

describe("useTerminal — broadcast fan-out (onBinary / paste)", () => {
  beforeEach(resetAll);

  it("fans out to target pane when broadcastEnabled is true (onBinary)", async () => {
    seedSession();
    mockTauriInvoke.mockResolvedValueOnce("term-src-bin");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-src-bin", ratio: 0.5 },
            { id: "slot-2", terminalId: "term-target-bin", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: true,
        },
      },
    });

    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    // Simulate a paste (binary data)
    await act(async () => {
      capturedOnBinary?.("pasted text");
    });

    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    // Source + 1 target = 2 calls for paste
    expect(writeCalls).toHaveLength(2);
    const termIds = writeCalls.map((c) => (c[1] as Record<string, unknown>).terminalId);
    expect(termIds).toContain(sourceId);
    expect(termIds).toContain("term-target-bin");
  });

  it("does NOT fan out on paste when broadcastEnabled is false", async () => {
    seedSession();
    mockTauriInvoke.mockResolvedValueOnce("term-src-bin2");

    const container = document.createElement("div");
    const { result } = renderHook(() => useTerminal());

    let sourceId: string | undefined;
    await act(async () => {
      sourceId = await result.current.openTerminal(container, SESSION_ID);
    });

    usePaneLayoutStore.setState({
      layouts: {
        [SESSION_ID]: {
          direction: "horizontal",
          slots: [
            { id: "slot-1", terminalId: sourceId ?? "term-src-bin2", ratio: 0.5 },
            { id: "slot-2", terminalId: "term-target-bin2", ratio: 0.5 },
          ],
          focusedSlotId: "slot-1",
          broadcastEnabled: false,
        },
      },
    });

    mockTauriInvoke.mockReset();
    mockTauriInvoke.mockResolvedValue(undefined);

    await act(async () => {
      capturedOnBinary?.("paste data");
    });

    const writeCalls = mockTauriInvoke.mock.calls.filter(
      (c) => c[0] === "write_terminal",
    );
    // Only source
    expect(writeCalls).toHaveLength(1);
    expect((writeCalls[0]![1] as Record<string, unknown>).terminalId).toBe(sourceId);
  });
});
