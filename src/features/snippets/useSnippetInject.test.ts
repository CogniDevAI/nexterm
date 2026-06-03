// features/snippets/useSnippetInject.test.ts
// TDD RED phase — hook that injects resolved snippet text into the active terminal.
// Mirrors useConnection.test.ts mock style for tauriInvoke.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mock functions so they are available in factory closures ──
const { mockTauriInvoke, mockGetState } = vi.hoisted(() => ({
  mockTauriInvoke: vi.fn().mockResolvedValue(undefined),
  mockGetState: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: mockTauriInvoke,
}));

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: { getState: mockGetState },
}));

import { injectSnippet } from "./useSnippetInject";

beforeEach(() => {
  mockTauriInvoke.mockClear();
  mockGetState.mockClear();
});

// ── Insert mode (no trailing \n) ──────────────────────────────

describe("injectSnippet — Insert mode", () => {
  it("calls write_terminal WITHOUT a trailing newline", async () => {
    mockGetState.mockReturnValue({
      sessions: new Map([
        [
          "sess-1",
          {
            id: "sess-1",
            activeTerminalId: "term-1",
            host: "10.0.0.1",
            username: "admin",
            port: 22,
          },
        ],
      ]),
      activeSessionId: "sess-1",
    });

    await injectSnippet("sess-1", "term-1", "ls -la", "insert");

    expect(mockTauriInvoke).toHaveBeenCalledOnce();
    const [cmd, args] = mockTauriInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("write_terminal");
    expect(args.sessionId).toBe("sess-1");
    expect(args.terminalId).toBe("term-1");

    const data = args.data as number[];
    const decoded = new TextDecoder().decode(new Uint8Array(data));
    expect(decoded).toBe("ls -la");
    expect(decoded.endsWith("\n")).toBe(false);
  });
});

// ── Execute mode (with trailing \n) ──────────────────────────

describe("injectSnippet — Execute mode", () => {
  it("calls write_terminal WITH a trailing newline", async () => {
    mockGetState.mockReturnValue({
      sessions: new Map([
        ["sess-1", { id: "sess-1", activeTerminalId: "term-1" }],
      ]),
      activeSessionId: "sess-1",
    });

    await injectSnippet("sess-1", "term-1", "whoami", "execute");

    const [, args] = mockTauriInvoke.mock.calls[0] as [string, Record<string, unknown>];
    const data = args.data as number[];
    const decoded = new TextDecoder().decode(new Uint8Array(data));
    expect(decoded).toBe("whoami\n");
  });

  it("handles multi-line resolved command as single write_terminal call", async () => {
    mockGetState.mockReturnValue({
      sessions: new Map([
        ["sess-1", { id: "sess-1", activeTerminalId: "term-1" }],
      ]),
      activeSessionId: "sess-1",
    });

    const multiline = "echo hello\necho world";
    await injectSnippet("sess-1", "term-1", multiline, "execute");

    // ONE call only (not per-line like runStartupCommands)
    expect(mockTauriInvoke).toHaveBeenCalledOnce();
    const [, args] = mockTauriInvoke.mock.calls[0] as [string, Record<string, unknown>];
    const data = args.data as number[];
    const decoded = new TextDecoder().decode(new Uint8Array(data));
    expect(decoded).toBe("echo hello\necho world\n");
  });
});

// ── Null / missing activeTerminalId guard ─────────────────────

describe("injectSnippet — null activeTerminalId guard", () => {
  it("is a no-op when terminalId is null (does not throw, does not write)", async () => {
    mockGetState.mockReturnValue({
      sessions: new Map([
        ["sess-1", { id: "sess-1", activeTerminalId: null }],
      ]),
      activeSessionId: "sess-1",
    });

    await expect(
      injectSnippet("sess-1", null, "ls", "insert"),
    ).resolves.not.toThrow();
    expect(mockTauriInvoke).not.toHaveBeenCalled();
  });

  it("is a no-op when terminalId is undefined (no crash)", async () => {
    await expect(
      injectSnippet("sess-1", undefined, "ls", "execute"),
    ).resolves.not.toThrow();
    expect(mockTauriInvoke).not.toHaveBeenCalled();
  });
});

// ── Password-type vars: no logging ───────────────────────────

describe("injectSnippet — password variable safety", () => {
  it("does not console.log the resolved command (password safety)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetState.mockReturnValue({
      sessions: new Map([
        ["sess-1", { id: "sess-1", activeTerminalId: "term-1" }],
      ]),
      activeSessionId: "sess-1",
    });

    await injectSnippet("sess-1", "term-1", "Bearer super-secret-token", "insert");

    // Must not log the resolved command (could contain password values)
    const loggedArgs = consoleSpy.mock.calls.flat();
    expect(loggedArgs).not.toContain("Bearer super-secret-token");
    consoleSpy.mockRestore();
  });
});
