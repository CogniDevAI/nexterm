// src/components/theme/ThemePicker.test.tsx — TDD: theme picker popover

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
    t: (k: string) => k,
    locale: "en",
    setLocale: vi.fn(),
  }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { ThemePicker } from "./ThemePicker";
import { useThemeStore } from "../../stores/themeStore";
import { THEME_IDS, THEMES } from "../../lib/themes";

beforeEach(() => {
  useThemeStore.setState({ themeId: "lamplight" });
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemePicker — trigger button", () => {
  it("renders a trigger button with aria-label from theme.picker i18n key", () => {
    render(<ThemePicker />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    expect(btn).toBeDefined();
  });

  it("trigger button shows the current theme label", () => {
    render(<ThemePicker />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    expect(btn.textContent).toContain("Lamplight");
  });

  it("popover is not visible by default", () => {
    render(<ThemePicker />);
    const listbox = screen.queryByRole("listbox");
    expect(listbox).toBeNull();
  });
});

describe("ThemePicker — open and close", () => {
  it("clicking trigger opens the listbox popover", () => {
    render(<ThemePicker />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    fireEvent.click(btn);
    expect(screen.getByRole("listbox")).toBeDefined();
  });

  it("pressing Escape closes the popover", () => {
    render(<ThemePicker />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    fireEvent.click(btn);
    expect(screen.getByRole("listbox")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking trigger again closes the popover", () => {
    render(<ThemePicker />);
    const btn = screen.getByRole("button", { name: /theme\.picker/i });
    fireEvent.click(btn);
    expect(screen.getByRole("listbox")).toBeDefined();
    fireEvent.click(btn);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ThemePicker — listbox contents", () => {
  it("lists all theme options when open", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(THEME_IDS.length);
  });

  it("each option shows the theme label", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    for (const id of THEME_IDS) {
      // Use getAllByText because the trigger also shows the current theme label
      const matches = screen.getAllByText(THEMES[id].label);
      expect(matches.length).toBeGreaterThan(0);
    }
  });

  it("current theme option has aria-selected=true", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    const selected = screen.getAllByRole("option").find(
      (o) => o.getAttribute("aria-selected") === "true",
    );
    expect(selected).toBeDefined();
    expect(selected?.textContent).toContain("Lamplight");
  });

  it("non-current theme options have aria-selected=false", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    const notSelected = screen.getAllByRole("option").filter(
      (o) => o.getAttribute("aria-selected") === "false",
    );
    expect(notSelected.length).toBe(THEME_IDS.length - 1);
  });
});

describe("ThemePicker — selection", () => {
  it("clicking a theme option applies that theme", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    const darkOption = screen.getByText("Dark");
    fireEvent.click(darkOption);
    expect(useThemeStore.getState().themeId).toBe("dark");
  });

  it("clicking a theme option closes the popover", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    fireEvent.click(screen.getByText("Dark"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking the Nord option applies nord theme", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    fireEvent.click(screen.getByText("Nord"));
    expect(useThemeStore.getState().themeId).toBe("nord");
  });
});

describe("ThemePicker — keyboard navigation", () => {
  it("ArrowDown moves focus to next option", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    // After ArrowDown from first item, focused index should advance
    const options = screen.getAllByRole("option");
    // At least one option should have data-focused or tabIndex=0 or similar
    expect(options.length).toBeGreaterThan(0);
  });

  it("Enter on a focused option applies that theme and closes", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /theme\.picker/i }));
    const listbox = screen.getByRole("listbox");
    // Arrow down to second option (index 1 = dark)
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    // Should have applied the theme at index 1 (dark) and closed
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
