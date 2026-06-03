// src/components/layout/StatusBar.test.tsx — TDD: StatusBar with ThemePicker

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── localStorage stub ──
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

vi.mock("../../features/terminal/useTerminal", () => ({
  applyThemeToAllTerminals: vi.fn(),
}));

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

describe("StatusBar — ThemePicker integration", () => {
  it("renders the theme picker trigger button", () => {
    render(<StatusBar />);
    // The trigger button uses the "theme.picker" i18n key as aria-label
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    expect(btn).toBeDefined();
  });

  it("theme picker trigger shows current theme label", () => {
    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    expect(btn.textContent).toContain("Lamplight");
  });

  it("theme picker trigger is present next to the language toggle", () => {
    render(<StatusBar />);
    const themeBtn = screen.getByRole("button", { name: /theme\.picker/i });
    const langBtn = screen.getByTitle(/settings\.language/i);
    expect(themeBtn).toBeDefined();
    expect(langBtn).toBeDefined();
  });

  it("no binary theme toggle exists (oppositeThemeId logic removed)", () => {
    render(<StatusBar />);
    // The old toggle had title = THEMES[themeId].label e.g. "Lamplight" or "Dark"
    // Now there should be NO button with title exactly matching a theme label only
    // (the picker trigger has aria-label "theme.picker", not the label as title)
    const themeBtn = screen.getByRole("button", { name: /theme\.picker/i });
    // Should NOT have a title attribute equal to the theme label (old pattern)
    expect(themeBtn.getAttribute("title")).not.toBe("Lamplight");
    expect(themeBtn.getAttribute("title")).not.toBe("Dark");
  });

  it("clicking trigger opens listbox with all 6 themes", () => {
    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    fireEvent.click(btn);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(6);
  });

  it("clicking Dark option in picker sets theme to dark", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    fireEvent.click(screen.getByText("Dark"));
    expect(useThemeStore.getState().themeId).toBe("dark");
  });

  it("clicking Nord option in picker sets theme to nord", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    fireEvent.click(screen.getByText("Nord"));
    expect(useThemeStore.getState().themeId).toBe("nord");
  });

  it("trigger label updates when theme changes to dark", () => {
    useThemeStore.setState({ themeId: "dark" });
    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    expect(btn.textContent).toContain("Dark");
  });

  it("trigger label updates when theme changes to Catppuccin Mocha", () => {
    useThemeStore.setState({ themeId: "catppuccin-mocha" });
    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    expect(btn.textContent).toContain("Catppuccin Mocha");
  });
});
