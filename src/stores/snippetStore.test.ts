// stores/snippetStore.test.ts
// TDD RED phase — Zustand persist store for snippet library.
// Pattern mirrors themeStore.test.ts exactly (vi.hoisted localStorage stub,
// rehydrate() calls, merge validator).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── localStorage stub (must be hoisted before any module import) ──
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

import { useSnippetStore, type Snippet } from "./snippetStore";

function resetStore() {
  useSnippetStore.setState({ snippets: [] });
}

beforeEach(() => {
  localStorageMap.clear();
  resetStore();
});

// ── Initial state ──────────────────────────────────────────────

describe("snippetStore — initial state", () => {
  it("starts with an empty snippets array", () => {
    expect(useSnippetStore.getState().snippets).toEqual([]);
  });
});

// ── addSnippet ────────────────────────────────────────────────

describe("snippetStore — addSnippet", () => {
  it("creates an entry with a UUID id", () => {
    useSnippetStore.getState().addSnippet({
      name: "List files",
      template: "ls -la {{path:text:.}}",
      favorite: false,
    });
    const { snippets } = useSnippetStore.getState();
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.id).toBeTruthy();
    expect(snippets[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("creates an entry with createdAt and updatedAt timestamps", () => {
    const before = Date.now();
    useSnippetStore.getState().addSnippet({
      name: "Ping",
      template: "ping {{HOST}}",
      favorite: false,
    });
    const after = Date.now();
    const s = useSnippetStore.getState().snippets[0]!;
    expect(s.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.createdAt).toBeLessThanOrEqual(after);
    expect(s.updatedAt).toBe(s.createdAt);
  });

  it("stores the provided name and template", () => {
    useSnippetStore.getState().addSnippet({
      name: "Disk usage",
      template: "df -h {{path:text:/}}",
      favorite: true,
    });
    const s = useSnippetStore.getState().snippets[0]!;
    expect(s.name).toBe("Disk usage");
    expect(s.template).toBe("df -h {{path:text:/}}");
    expect(s.favorite).toBe(true);
  });
});

// ── updateSnippet ─────────────────────────────────────────────

describe("snippetStore — updateSnippet", () => {
  it("mutates only the specified fields", () => {
    useSnippetStore.getState().addSnippet({
      name: "Old name",
      template: "old template",
      favorite: false,
    });
    const { id, createdAt } = useSnippetStore.getState().snippets[0]!;
    useSnippetStore.getState().updateSnippet(id, { name: "New name" });
    const s = useSnippetStore.getState().snippets[0]!;
    expect(s.name).toBe("New name");
    expect(s.template).toBe("old template"); // unchanged
    expect(s.createdAt).toBe(createdAt); // unchanged
    expect(s.updatedAt).toBeGreaterThanOrEqual(createdAt);
  });

  it("is a no-op for unknown id", () => {
    useSnippetStore.getState().addSnippet({
      name: "A",
      template: "ls",
      favorite: false,
    });
    const before = useSnippetStore.getState().snippets[0]!;
    useSnippetStore.getState().updateSnippet("nonexistent-id", { name: "X" });
    const after = useSnippetStore.getState().snippets[0]!;
    expect(after.name).toBe(before.name);
  });
});

// ── deleteSnippet ─────────────────────────────────────────────

describe("snippetStore — deleteSnippet", () => {
  it("removes the snippet by id", () => {
    useSnippetStore.getState().addSnippet({
      name: "To delete",
      template: "rm -rf {{path}}",
      favorite: false,
    });
    const { id } = useSnippetStore.getState().snippets[0]!;
    useSnippetStore.getState().deleteSnippet(id);
    expect(useSnippetStore.getState().snippets).toHaveLength(0);
  });

  it("leaves other snippets intact", () => {
    useSnippetStore.getState().addSnippet({ name: "A", template: "ls", favorite: false });
    useSnippetStore.getState().addSnippet({ name: "B", template: "pwd", favorite: false });
    const [a, b] = useSnippetStore.getState().snippets as [Snippet, Snippet];
    useSnippetStore.getState().deleteSnippet(a.id);
    const remaining = useSnippetStore.getState().snippets;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(b.id);
  });
});

// ── reorderSnippets ───────────────────────────────────────────

describe("snippetStore — reorderSnippets", () => {
  it("reorders snippets to match the provided id array", () => {
    useSnippetStore.getState().addSnippet({ name: "A", template: "a", favorite: false });
    useSnippetStore.getState().addSnippet({ name: "B", template: "b", favorite: false });
    useSnippetStore.getState().addSnippet({ name: "C", template: "c", favorite: false });
    const [a, b, c] = useSnippetStore.getState().snippets as [Snippet, Snippet, Snippet];
    useSnippetStore.getState().reorderSnippets([c.id, a.id, b.id]);
    const after = useSnippetStore.getState().snippets;
    expect(after.map((s) => s.name)).toEqual(["C", "A", "B"]);
  });
});

// ── Persistence ───────────────────────────────────────────────

describe("snippetStore — persistence", () => {
  it("writes to localStorage key 'nexterm-snippets'", () => {
    useSnippetStore.getState().addSnippet({
      name: "test",
      template: "test",
      favorite: false,
    });
    const raw = localStorageMap.get("nexterm-snippets");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.snippets).toHaveLength(1);
    expect(parsed.version).toBe(0);
  });

  it("persists name and template but not runtime-resolved values", () => {
    useSnippetStore.getState().addSnippet({
      name: "SSH",
      template: "ssh {{HOST}}",
      favorite: false,
    });
    const raw = localStorageMap.get("nexterm-snippets")!;
    const parsed = JSON.parse(raw);
    const s: Snippet = parsed.state.snippets[0];
    expect(s.name).toBe("SSH");
    expect(s.template).toBe("ssh {{HOST}}");
  });
});

// ── Rehydration merge validator ───────────────────────────────

describe("snippetStore — rehydration merge validator", () => {
  it("restores valid snippets from storage", async () => {
    const validSnippet: Snippet = {
      id: "abc-123",
      name: "Valid",
      template: "ls",
      favorite: false,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const envelope = JSON.stringify({
      state: { snippets: [validSnippet] },
      version: 0,
    });
    localStorageMap.set("nexterm-snippets", envelope);
    await useSnippetStore.persist.rehydrate();
    expect(useSnippetStore.getState().snippets).toHaveLength(1);
    expect(useSnippetStore.getState().snippets[0]!.id).toBe("abc-123");
  });

  it("drops snippets missing id", async () => {
    const badSnippet = { name: "No id", template: "ls", favorite: false, createdAt: 1, updatedAt: 1 };
    const envelope = JSON.stringify({ state: { snippets: [badSnippet] }, version: 0 });
    localStorageMap.set("nexterm-snippets", envelope);
    await useSnippetStore.persist.rehydrate();
    expect(useSnippetStore.getState().snippets).toHaveLength(0);
  });

  it("drops snippets missing name", async () => {
    const badSnippet = { id: "x", template: "ls", favorite: false, createdAt: 1, updatedAt: 1 };
    const envelope = JSON.stringify({ state: { snippets: [badSnippet] }, version: 0 });
    localStorageMap.set("nexterm-snippets", envelope);
    await useSnippetStore.persist.rehydrate();
    expect(useSnippetStore.getState().snippets).toHaveLength(0);
  });

  it("drops snippets missing template", async () => {
    const badSnippet = { id: "x", name: "N", favorite: false, createdAt: 1, updatedAt: 1 };
    const envelope = JSON.stringify({ state: { snippets: [badSnippet] }, version: 0 });
    localStorageMap.set("nexterm-snippets", envelope);
    await useSnippetStore.persist.rehydrate();
    expect(useSnippetStore.getState().snippets).toHaveLength(0);
  });

  it("falls back to empty array when stored JSON is corrupt", async () => {
    localStorageMap.set("nexterm-snippets", "{{not valid json}}");
    await expect(useSnippetStore.persist.rehydrate()).resolves.not.toThrow();
    expect(useSnippetStore.getState().snippets).toEqual([]);
  });

  it("keeps valid snippets and drops malformed ones in the same array", async () => {
    const good: Snippet = { id: "g1", name: "Good", template: "ls", favorite: false, createdAt: 1, updatedAt: 1 };
    const bad = { name: "Bad", template: "pwd" }; // missing id
    const envelope = JSON.stringify({ state: { snippets: [good, bad] }, version: 0 });
    localStorageMap.set("nexterm-snippets", envelope);
    await useSnippetStore.persist.rehydrate();
    expect(useSnippetStore.getState().snippets).toHaveLength(1);
    expect(useSnippetStore.getState().snippets[0]!.id).toBe("g1");
  });
});
