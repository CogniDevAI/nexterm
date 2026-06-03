// src/lib/theme/ThemeProvider.test.tsx — TDD: ThemeProvider applies data-theme on mount

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// ── localStorage stub (same pattern as i18n/index.test.tsx) ──
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

// ── Mock useTerminal so applyThemeToAllTerminals is a no-op ──
vi.mock("../../features/terminal/useTerminal", () => ({
  applyThemeToAllTerminals: vi.fn(),
}));

import { ThemeProvider } from "./ThemeProvider";
import { useThemeStore } from "../../stores/themeStore";

beforeEach(() => {
  localStorageMap.clear();
  useThemeStore.setState({ themeId: "lamplight" });
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeProvider", () => {
  it("applies data-theme from store themeId on mount (lamplight)", () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("lamplight");
  });

  it("applies data-theme dark when store is seeded with dark", () => {
    // Pre-seed store as if restored from localStorage
    useThemeStore.setState({ themeId: "dark" });

    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders children transparently", () => {
    const { container } = render(
      <ThemeProvider>
        <span data-testid="child">hello</span>
      </ThemeProvider>,
    );
    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
  });

  it("reacts to themeId store changes after mount", () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );

    // Simulate theme switch
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    useThemeStore.getState().setTheme("lamplight");
    expect(document.documentElement.dataset.theme).toBe("lamplight");
  });
});
