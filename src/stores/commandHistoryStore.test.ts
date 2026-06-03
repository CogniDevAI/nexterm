// stores/commandHistoryStore.test.ts
// TDD RED phase — Zustand persist store for command history ring buffer.
//
// Pattern mirrors snippetStore.test.ts exactly:
//   - vi.hoisted() localStorage stub before any import
//   - resetStore() helper, beforeEach cleanup
//   - rehydrate() for persistence tests

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── localStorage stub (must be hoisted before any module import) ──────────────
const { localStorageMap } = vi.hoisted(() => {
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
  return { localStorageMap: store };
});

import { useCommandHistoryStore, type HistoryEntry } from "./commandHistoryStore";

function resetStore() {
  useCommandHistoryStore.setState({
    entries: [],
    captureEnabled: false,
    noticeAcknowledged: false,
  });
}

beforeEach(() => {
  localStorageMap.clear();
  resetStore();
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe("commandHistoryStore — initial state", () => {
  it("starts with an empty entries array", () => {
    expect(useCommandHistoryStore.getState().entries).toEqual([]);
  });

  it("captureEnabled defaults to FALSE (opt-in security model)", () => {
    // SECURITY: capture is opt-in — passwords at no-echo prompts would be
    // recorded in plaintext in localStorage if capture were on by default.
    expect(useCommandHistoryStore.getState().captureEnabled).toBe(false);
  });

  it("noticeAcknowledged defaults to false", () => {
    expect(useCommandHistoryStore.getState().noticeAcknowledged).toBe(false);
  });
});

// ── addCommand ────────────────────────────────────────────────────────────────

describe("commandHistoryStore — addCommand", () => {
  it("appends an entry with all required fields", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({
      command: "ls -la",
      sessionId: "sess-1",
      host: "10.0.0.1",
    });
    const { entries } = useCommandHistoryStore.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.command).toBe("ls -la");
    expect(entries[0]!.sessionId).toBe("sess-1");
    expect(entries[0]!.host).toBe("10.0.0.1");
    expect(typeof entries[0]!.id).toBe("string");
    expect(entries[0]!.id.length).toBeGreaterThan(0);
    expect(typeof entries[0]!.timestamp).toBe("number");
  });

  it("assigns a UUID-formatted id", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({
      command: "pwd",
      sessionId: "sess-1",
      host: "host.example.com",
    });
    const id = useCommandHistoryStore.getState().entries[0]!.id;
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("records timestamp as a number close to Date.now()", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    const before = Date.now();
    useCommandHistoryStore.getState().addCommand({
      command: "date",
      sessionId: "s",
      host: "h",
    });
    const after = Date.now();
    const ts = useCommandHistoryStore.getState().entries[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("does NOT add entry when captureEnabled is false", () => {
    // captureEnabled is false by default (reset in beforeEach)
    useCommandHistoryStore.getState().addCommand({
      command: "secret",
      sessionId: "sess-1",
      host: "host",
    });
    expect(useCommandHistoryStore.getState().entries).toHaveLength(0);
  });

  it("does not dedupe non-consecutive identical commands", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s", host: "h" });
    useCommandHistoryStore.getState().addCommand({ command: "pwd", sessionId: "s", host: "h" });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s", host: "h" });
    expect(useCommandHistoryStore.getState().entries).toHaveLength(3);
  });
});

// ── Dedupe consecutive identical ──────────────────────────────────────────────

describe("commandHistoryStore — dedupe consecutive identical", () => {
  it("deduplicates consecutive identical commands on the same sessionId", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s1", host: "h" });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s1", host: "h" });
    expect(useCommandHistoryStore.getState().entries).toHaveLength(1);
  });

  it("does NOT dedupe when sessionId differs", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s1", host: "h" });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s2", host: "h" });
    expect(useCommandHistoryStore.getState().entries).toHaveLength(2);
  });
});

// ── Ring buffer cap ───────────────────────────────────────────────────────────

describe("commandHistoryStore — ring buffer cap (500)", () => {
  it("holds up to 500 entries without dropping any", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    for (let i = 0; i < 500; i++) {
      useCommandHistoryStore.getState().addCommand({
        command: `cmd-${i}`,
        sessionId: "s",
        host: "h",
      });
    }
    expect(useCommandHistoryStore.getState().entries).toHaveLength(500);
  });

  it("drops the oldest entry when the 501st is added", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    for (let i = 0; i < 500; i++) {
      useCommandHistoryStore.getState().addCommand({
        command: `cmd-${i}`,
        sessionId: "s",
        host: "h",
      });
    }
    useCommandHistoryStore.getState().addCommand({
      command: "cmd-500",
      sessionId: "s",
      host: "h",
    });
    const entries = useCommandHistoryStore.getState().entries;
    expect(entries).toHaveLength(500);
    // Oldest (cmd-0) should be gone, newest (cmd-500) should be present
    expect(entries.find((e) => e.command === "cmd-0")).toBeUndefined();
    expect(entries[entries.length - 1]!.command).toBe("cmd-500");
  });
});

// ── deleteCommand ─────────────────────────────────────────────────────────────

describe("commandHistoryStore — deleteCommand", () => {
  it("removes the entry by id", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "rm -rf /tmp/x", sessionId: "s", host: "h" });
    const { id } = useCommandHistoryStore.getState().entries[0]!;
    useCommandHistoryStore.getState().deleteCommand(id);
    expect(useCommandHistoryStore.getState().entries).toHaveLength(0);
  });

  it("leaves other entries intact", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "cmd-a", sessionId: "s", host: "h" });
    useCommandHistoryStore.getState().addCommand({ command: "cmd-b", sessionId: "s", host: "h" });
    const [a, b] = useCommandHistoryStore.getState().entries as [HistoryEntry, HistoryEntry];
    useCommandHistoryStore.getState().deleteCommand(a.id);
    const remaining = useCommandHistoryStore.getState().entries;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(b.id);
  });

  it("is a no-op for unknown id", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "x", sessionId: "s", host: "h" });
    useCommandHistoryStore.getState().deleteCommand("nonexistent-id");
    expect(useCommandHistoryStore.getState().entries).toHaveLength(1);
  });
});

// ── clearAll ──────────────────────────────────────────────────────────────────

describe("commandHistoryStore — clearAll", () => {
  it("empties the entries array", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "a", sessionId: "s", host: "h" });
    useCommandHistoryStore.getState().addCommand({ command: "b", sessionId: "s", host: "h" });
    useCommandHistoryStore.getState().clearAll();
    expect(useCommandHistoryStore.getState().entries).toHaveLength(0);
  });
});

// ── toggleCapture ─────────────────────────────────────────────────────────────

describe("commandHistoryStore — toggleCapture", () => {
  it("flips captureEnabled from false to true", () => {
    useCommandHistoryStore.getState().toggleCapture();
    expect(useCommandHistoryStore.getState().captureEnabled).toBe(true);
  });

  it("flips captureEnabled from true to false", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().toggleCapture();
    expect(useCommandHistoryStore.getState().captureEnabled).toBe(false);
  });
});

// ── dismissNotice ─────────────────────────────────────────────────────────────

describe("commandHistoryStore — dismissNotice", () => {
  it("sets noticeAcknowledged to true", () => {
    useCommandHistoryStore.getState().dismissNotice();
    expect(useCommandHistoryStore.getState().noticeAcknowledged).toBe(true);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("commandHistoryStore — persistence", () => {
  it("writes to localStorage key 'nexterm-command-history'", () => {
    useCommandHistoryStore.setState({ captureEnabled: true });
    useCommandHistoryStore.getState().addCommand({ command: "ls", sessionId: "s", host: "h" });
    const raw = localStorageMap.get("nexterm-command-history");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.entries).toHaveLength(1);
    expect(parsed.state.entries[0].command).toBe("ls");
  });

  it("persists captureEnabled and noticeAcknowledged", () => {
    useCommandHistoryStore.setState({ captureEnabled: true, noticeAcknowledged: true });
    // Trigger a write by mutating
    useCommandHistoryStore.getState().dismissNotice(); // no-op but forces subscription
    const raw = localStorageMap.get("nexterm-command-history");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.captureEnabled).toBe(true);
    expect(parsed.state.noticeAcknowledged).toBe(true);
  });
});

// ── Rehydration merge validator ───────────────────────────────────────────────

describe("commandHistoryStore — rehydration merge validator", () => {
  it("restores valid entries from storage", async () => {
    const valid: HistoryEntry = {
      id: "abc-123",
      command: "ls",
      timestamp: 1000,
      sessionId: "sess-1",
      host: "10.0.0.1",
    };
    const envelope = JSON.stringify({
      state: { entries: [valid], captureEnabled: false, noticeAcknowledged: false },
      version: 0,
    });
    localStorageMap.set("nexterm-command-history", envelope);
    await useCommandHistoryStore.persist.rehydrate();
    expect(useCommandHistoryStore.getState().entries).toHaveLength(1);
    expect(useCommandHistoryStore.getState().entries[0]!.id).toBe("abc-123");
  });

  it("drops entries missing required fields (corrupt entry)", async () => {
    const bad = { command: "ls" }; // missing id, sessionId, host, timestamp
    const envelope = JSON.stringify({
      state: { entries: [bad], captureEnabled: false, noticeAcknowledged: false },
      version: 0,
    });
    localStorageMap.set("nexterm-command-history", envelope);
    await useCommandHistoryStore.persist.rehydrate();
    expect(useCommandHistoryStore.getState().entries).toHaveLength(0);
  });

  it("falls back to empty array when state is corrupt", async () => {
    localStorageMap.set("nexterm-command-history", "{{invalid json");
    await expect(
      useCommandHistoryStore.persist.rehydrate(),
    ).resolves.not.toThrow();
    expect(useCommandHistoryStore.getState().entries).toEqual([]);
  });

  it("keeps valid entries and drops malformed ones", async () => {
    const good: HistoryEntry = {
      id: "g1",
      command: "pwd",
      timestamp: 2000,
      sessionId: "s",
      host: "h",
    };
    const bad = { command: "broken" };
    const envelope = JSON.stringify({
      state: { entries: [good, bad], captureEnabled: false, noticeAcknowledged: false },
      version: 0,
    });
    localStorageMap.set("nexterm-command-history", envelope);
    await useCommandHistoryStore.persist.rehydrate();
    expect(useCommandHistoryStore.getState().entries).toHaveLength(1);
    expect(useCommandHistoryStore.getState().entries[0]!.id).toBe("g1");
  });

  it("restores captureEnabled from storage", async () => {
    const envelope = JSON.stringify({
      state: { entries: [], captureEnabled: true, noticeAcknowledged: true },
      version: 0,
    });
    localStorageMap.set("nexterm-command-history", envelope);
    await useCommandHistoryStore.persist.rehydrate();
    expect(useCommandHistoryStore.getState().captureEnabled).toBe(true);
    expect(useCommandHistoryStore.getState().noticeAcknowledged).toBe(true);
  });
});
