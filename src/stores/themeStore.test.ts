// src/stores/themeStore.test.ts — TDD: Zustand persist + side effects

import { describe, it, expect, vi, beforeEach } from "vitest";
import { THEMES } from "../lib/themes";

// ── localStorage stub — must be set up via vi.hoisted so it is in place
// before any module is imported (Zustand persist reads localStorage at store-create time).
// Reuses the Object.defineProperty pattern from src/lib/i18n/index.test.tsx.
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
      get length() { return store.size; },
    },
  });
  return { localStorageMap: store };
});

// ── Mock useTerminal so applyThemeToAllTerminals is a spy ──
const { mockApplyThemeToAllTerminals } = vi.hoisted(() => ({
  mockApplyThemeToAllTerminals: vi.fn(),
}));
vi.mock("../features/terminal/useTerminal", () => ({
  applyThemeToAllTerminals: mockApplyThemeToAllTerminals,
}));

// ── Import store AFTER mocks/stubs are set up ──
import { useThemeStore, applyThemeSideEffects } from "./themeStore";

beforeEach(() => {
  localStorageMap.clear();
  // Merge-reset themeId to lamplight (do NOT use replace=true or setTheme action is lost)
  useThemeStore.setState({ themeId: "lamplight" });
  mockApplyThemeToAllTerminals.mockClear();
  document.documentElement.removeAttribute("data-theme");
});

describe("themeStore — initial state", () => {
  it("has themeId === lamplight by default (no storage)", () => {
    expect(useThemeStore.getState().themeId).toBe("lamplight");
  });
});

describe("themeStore — setTheme", () => {
  it("setTheme(dark) updates state.themeId to dark", () => {
    useThemeStore.getState().setTheme("dark");
    expect(useThemeStore.getState().themeId).toBe("dark");
  });

  it("setTheme(dark) writes nexterm-theme to localStorage with Zustand envelope shape", () => {
    useThemeStore.getState().setTheme("dark");
    const raw = localStorageMap.get("nexterm-theme");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.themeId).toBe("dark");
    expect(parsed.version).toBe(0);
  });

  it("setTheme(dark) sets document.documentElement.dataset.theme to dark", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("setTheme with invalid id is a no-op (state unchanged)", () => {
    // @ts-expect-error — intentional invalid id for test
    useThemeStore.getState().setTheme("light");
    expect(useThemeStore.getState().themeId).toBe("lamplight");
  });

  it("setTheme(dark) calls applyThemeToAllTerminals with THEMES.dark.terminalTheme", () => {
    useThemeStore.getState().setTheme("dark");
    expect(mockApplyThemeToAllTerminals).toHaveBeenCalledWith(
      THEMES.dark.terminalTheme,
    );
  });

  it("setTheme(lamplight) calls applyThemeToAllTerminals with THEMES.lamplight.terminalTheme", () => {
    useThemeStore.setState({ themeId: "dark" });
    useThemeStore.getState().setTheme("lamplight");
    expect(mockApplyThemeToAllTerminals).toHaveBeenCalledWith(
      THEMES.lamplight.terminalTheme,
    );
  });
});

describe("themeStore — restore from localStorage", () => {
  it("restores dark when localStorage is pre-seeded with dark envelope", async () => {
    const envelope = JSON.stringify({ state: { themeId: "dark" }, version: 0 });
    localStorageMap.set("nexterm-theme", envelope);
    // Trigger real Zustand persist rehydration (not a setState mock)
    await useThemeStore.persist.rehydrate();
    expect(useThemeStore.getState().themeId).toBe("dark");
  });

  it("MAJOR-3: corrupt persisted themeId falls back to lamplight, no crash", async () => {
    // Seed localStorage with an invalid themeId (e.g., a future value or corrupt data)
    const corrupt = JSON.stringify({ state: { themeId: "blue" }, version: 0 });
    localStorageMap.set("nexterm-theme", corrupt);
    // Trigger real Zustand persist rehydration
    await useThemeStore.persist.rehydrate();
    // Must fall back to lamplight — NOT "blue", and NOT crash
    expect(useThemeStore.getState().themeId).toBe("lamplight");
  });

  it("MAJOR-3: malformed JSON in storage falls back to lamplight, no crash", async () => {
    localStorageMap.set("nexterm-theme", "{{not valid json}}");
    await expect(useThemeStore.persist.rehydrate()).resolves.not.toThrow();
    expect(useThemeStore.getState().themeId).toBe("lamplight");
  });

  it("MAJOR-3: missing themeId in stored state falls back to lamplight", async () => {
    const corrupt = JSON.stringify({ state: {}, version: 0 });
    localStorageMap.set("nexterm-theme", corrupt);
    await useThemeStore.persist.rehydrate();
    expect(useThemeStore.getState().themeId).toBe("lamplight");
  });
});

describe("applyThemeSideEffects", () => {
  it("sets document.documentElement.dataset.theme to dark", () => {
    applyThemeSideEffects("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("calls applyThemeToAllTerminals with the correct theme", () => {
    applyThemeSideEffects("dark");
    expect(mockApplyThemeToAllTerminals).toHaveBeenCalledWith(
      THEMES.dark.terminalTheme,
    );
  });

  it("MINOR-2: lamplight REMOVES the data-theme attribute (not sets it to 'lamplight')", () => {
    // First set it to dark so the attribute is present
    document.documentElement.dataset.theme = "dark";
    applyThemeSideEffects("lamplight");
    // Spec: no [data-theme] attribute for LAMPLIGHT (it is the CSS default)
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("MINOR-2: setTheme(lamplight) removes data-theme attribute", () => {
    useThemeStore.setState({ themeId: "dark" });
    document.documentElement.dataset.theme = "dark";
    useThemeStore.getState().setTheme("lamplight");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
