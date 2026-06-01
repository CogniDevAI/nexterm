// useConnection.test.ts — TDD: disposeSessionTerminals called on disconnect
//
// Bug: disconnect() calls the backend and removeSession() but never calls
// disposeSessionTerminals(), leaving xterm.js Terminals/ResizeObservers alive.
//
// Fix: disconnect() calls disposeSessionTerminals(sessionId) before removeSession().

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Track disposeSessionTerminals calls
const mockDisposeSessionTerminals = vi.fn();

// Mock useTerminal — return a spy for disposeSessionTerminals
vi.mock("../terminal/useTerminal", () => ({
  useTerminal: () => ({
    openTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    getTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    reattachTerminal: vi.fn(),
    disposeSessionTerminals: mockDisposeSessionTerminals,
  }),
}));

// Mock tauriInvoke — disconnect command returns void
vi.mock("../../lib/tauri", () => ({
  tauriInvoke: vi.fn().mockResolvedValue(undefined),
  AppError: class AppError extends Error {
    constructor(_cmd: string, msg: string) {
      super(msg);
      this.name = "AppError";
    }
  },
}));

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ─── Store reset ──────────────────────────────────────────────────────────────

import { useSessionStore } from "../../stores/sessionStore";
import type { SessionEntry } from "../../stores/sessionStore";

function makeSession(id: string): SessionEntry {
  return {
    id,
    profileId: "profile-1",
    profileName: "Test",
    host: "10.0.0.1:22",
    userId: "user-1",
    username: "admin",
    port: 22,
    connectedAt: Date.now(),
    state: "connected",
    terminals: [],
    activeTerminalId: null,
  };
}

function resetStore() {
  useSessionStore.setState({
    sessions: new Map(),
    activeSessionId: null,
    activeFeature: "terminal",
  });
}

// ─── Import hook AFTER mocks ──────────────────────────────────────────────────
import { useConnection } from "./useConnection";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useConnection — disposeSessionTerminals called on disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it(
    "calls disposeSessionTerminals(sessionId) when disconnect() is invoked",
    async () => {
      // Seed the session store so removeSession has something to remove
      const sessionId = "test-session-id";
      const session = makeSession(sessionId);
      useSessionStore.setState({
        sessions: new Map([[sessionId, session]]),
        activeSessionId: sessionId,
      });

      const { result } = renderHook(() => useConnection());

      await act(async () => {
        await result.current.disconnect(sessionId);
      });

      // The fix: disposeSessionTerminals MUST be called with the sessionId
      expect(mockDisposeSessionTerminals).toHaveBeenCalledWith(sessionId);
      expect(mockDisposeSessionTerminals).toHaveBeenCalledTimes(1);
    },
  );

  it("calls disposeSessionTerminals before removeSession (dispose first)", async () => {
    const sessionId = "test-session-id-2";
    const session = makeSession(sessionId);
    useSessionStore.setState({
      sessions: new Map([[sessionId, session]]),
      activeSessionId: sessionId,
    });

    const callOrder: string[] = [];

    mockDisposeSessionTerminals.mockImplementation(() => {
      callOrder.push("disposeSessionTerminals");
    });

    // Spy on removeSession by watching the store's sessions map
    const originalRemoveSession = useSessionStore.getState().removeSession;
    useSessionStore.setState({
      removeSession: (id: string) => {
        callOrder.push("removeSession");
        originalRemoveSession(id);
      },
    });

    const { result } = renderHook(() => useConnection());

    await act(async () => {
      await result.current.disconnect(sessionId);
    });

    expect(callOrder[0]).toBe("disposeSessionTerminals");
    expect(callOrder[1]).toBe("removeSession");
  });
});

// ─── runStartupCommands ───────────────────────────────────────────────────────

import { tauriInvoke } from "../../lib/tauri";

describe("useConnection — runStartupCommands", () => {
  const SESSION_ID = "session-startup";
  const TERMINAL_ID = "terminal-real-uuid";

  function seedSession(activeTerminalId: string | null) {
    useSessionStore.setState({
      sessions: new Map([
        [
          SESSION_ID,
          {
            ...makeSession(SESSION_ID),
            activeTerminalId,
          },
        ],
      ]),
      activeSessionId: SESSION_ID,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls write_terminal once per command with correct payload", async () => {
    seedSession(TERMINAL_ID);

    const { result } = renderHook(() => useConnection());

    await act(async () => {
      await result.current.runStartupCommands(SESSION_ID, ["ls -la", "pwd"]);
    });

    const mockInvoke = vi.mocked(tauriInvoke);
    const writeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "write_terminal",
    );

    expect(writeCalls).toHaveLength(2);

    expect(writeCalls[0]![1]).toMatchObject({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      data: Array.from(new TextEncoder().encode("ls -la\n")),
    });

    expect(writeCalls[1]![1]).toMatchObject({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      data: Array.from(new TextEncoder().encode("pwd\n")),
    });
  });

  it("sends commands in order", async () => {
    seedSession(TERMINAL_ID);

    const order: string[] = [];
    vi.mocked(tauriInvoke).mockImplementation(async (cmd, args) => {
      if (cmd === "write_terminal" && args) {
        const enc = new TextDecoder();
        const text = enc.decode(new Uint8Array(args.data as number[]));
        order.push(text.trim());
      }
      return undefined as never;
    });

    const { result } = renderHook(() => useConnection());

    await act(async () => {
      await result.current.runStartupCommands(SESSION_ID, [
        "echo first",
        "echo second",
        "echo third",
      ]);
    });

    expect(order).toEqual(["echo first", "echo second", "echo third"]);
  });

  it("resolves without calling write_terminal when activeTerminalId stays null (timeout path)", async () => {
    vi.useFakeTimers();
    seedSession(null);

    const { result } = renderHook(() => useConnection());

    const runPromise = act(async () => {
      const p = result.current.runStartupCommands(SESSION_ID, ["whoami"]);
      // Advance past the full poll window: 50 iterations × 100ms = 5 000ms
      await vi.advanceTimersByTimeAsync(5100);
      return p;
    });

    await runPromise;

    const mockInvoke = vi.mocked(tauriInvoke);
    const writeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "write_terminal",
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("does not throw when write_terminal rejects", async () => {
    seedSession(TERMINAL_ID);

    vi.mocked(tauriInvoke).mockRejectedValueOnce(new Error("PTY write error"));

    const { result } = renderHook(() => useConnection());

    await expect(
      act(async () => {
        await result.current.runStartupCommands(SESSION_ID, ["bad-cmd"]);
      }),
    ).resolves.not.toThrow();
  });

  it("polls until activeTerminalId becomes a real id (pending → real)", async () => {
    vi.useFakeTimers();

    // Start with pending id
    seedSession("pending-some-uuid");

    const { result } = renderHook(() => useConnection());

    let done = false;
    const runPromise = result.current
      .runStartupCommands(SESSION_ID, ["uname"])
      .then(() => {
        done = true;
      });

    // After 2 poll ticks, swap in the real id
    await vi.advanceTimersByTimeAsync(200);
    useSessionStore.setState((state) => {
      const next = new Map(state.sessions);
      const entry = next.get(SESSION_ID)!;
      next.set(SESSION_ID, { ...entry, activeTerminalId: TERMINAL_ID });
      return { sessions: next };
    });

    await vi.advanceTimersByTimeAsync(200);
    await act(async () => {
      await runPromise;
    });

    expect(done).toBe(true);
    const mockInvoke = vi.mocked(tauriInvoke);
    const writeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "write_terminal",
    );
    expect(writeCalls).toHaveLength(1);
  });
});
