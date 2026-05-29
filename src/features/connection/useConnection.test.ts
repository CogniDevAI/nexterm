// useConnection.test.ts — TDD: disposeSessionTerminals called on disconnect
//
// Bug: disconnect() calls the backend and removeSession() but never calls
// disposeSessionTerminals(), leaving xterm.js Terminals/ResizeObservers alive.
//
// Fix: disconnect() calls disposeSessionTerminals(sessionId) before removeSession().

import { describe, it, expect, vi, beforeEach } from "vitest";
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
