// src/components/layout/StatusBar.test.tsx — TDD: theme toggle in StatusBar

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── localStorage stub (vi.hoisted — must be in place before any persist store loads) ──
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

// ── Mock useTerminal so applyThemeToAllTerminals is a no-op ──
vi.mock("../../features/terminal/useTerminal", () => ({
  applyThemeToAllTerminals: vi.fn(),
}));

// ── Minimal i18n mock — return key as label for simplicity ──
vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string, p?: Record<string, string | number>) => {
      if (p) return `${k}:${JSON.stringify(p)}`;
      return k;
    },
    locale: "en",
    setLocale: vi.fn(),
  }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Mock session + update stores (StatusBar reads them) ──
vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: () => ({
    sessions: new Map(),
    activeSessionId: null,
  }),
}));
vi.mock("../../stores/updateStore", () => ({
  useUpdateStore: () => ({ status: "idle", isCritical: false }),
}));

import { StatusBar } from "./StatusBar";
import { useThemeStore } from "../../stores/themeStore";

beforeEach(() => {
  useThemeStore.setState({ themeId: "lamplight" });
  document.documentElement.removeAttribute("data-theme");
});

describe("StatusBar — theme toggle", () => {
  it("renders the theme toggle button", () => {
    render(<StatusBar />);
    // The button should have a title or aria-label reflecting the current theme
    const btn = screen.getByTitle(/Lamplight|lamplight|Dark|dark|theme/i);
    expect(btn).toBeDefined();
  });

  it("theme toggle is present next to the language toggle", () => {
    render(<StatusBar />);
    const themeBtn = screen.getByTitle(/Lamplight|lamplight|Dark|dark|theme/i);
    const langBtn = screen.getByTitle(/settings\.language/i);
    // Both should exist in the DOM
    expect(themeBtn).toBeDefined();
    expect(langBtn).toBeDefined();
  });

  it("clicking theme toggle switches from lamplight to dark", () => {
    render(<StatusBar />);
    const btn = screen.getByTitle(/Lamplight|lamplight|Dark|dark|theme/i);
    fireEvent.click(btn);
    expect(useThemeStore.getState().themeId).toBe("dark");
  });

  it("clicking theme toggle again switches back to lamplight", () => {
    useThemeStore.setState({ themeId: "dark" });
    render(<StatusBar />);
    // Re-render after state change to get updated button
    const btn = screen.getByTitle(/Lamplight|lamplight|Dark|dark|theme/i);
    fireEvent.click(btn);
    expect(useThemeStore.getState().themeId).toBe("lamplight");
  });

  it("toggle label reflects current theme (Lamplight when active)", () => {
    render(<StatusBar />);
    const btn = screen.getByTitle(/Lamplight|lamplight|Dark|dark|theme/i);
    // The button should display the current theme label
    expect(btn.textContent).toMatch(/Lamplight|lamplight/i);
  });

  it("toggle label reflects dark theme when active", () => {
    useThemeStore.setState({ themeId: "dark" });
    render(<StatusBar />);
    const btn = screen.getByTitle(/Lamplight|lamplight|Dark|dark|theme/i);
    expect(btn.textContent).toMatch(/Dark|dark/i);
  });
});
