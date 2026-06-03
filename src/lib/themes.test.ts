// src/lib/themes.test.ts — TDD: Theme preset module + validator

import { describe, it, expect } from "vitest";
import {
  isThemeId,
  DEFAULT_THEME_ID,
  THEME_IDS,
  THEMES,
  parseStoredThemeId,
} from "./themes";

describe("themes — core exports", () => {
  it("DEFAULT_THEME_ID is lamplight", () => {
    expect(DEFAULT_THEME_ID).toBe("lamplight");
  });

  it("THEME_IDS has exactly 2 members", () => {
    expect(THEME_IDS).toHaveLength(2);
    expect(THEME_IDS).toContain("lamplight");
    expect(THEME_IDS).toContain("dark");
  });

  it("THEMES keys match THEME_IDS", () => {
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_IDS].sort());
  });
});

describe("isThemeId", () => {
  it("accepts lamplight", () => {
    expect(isThemeId("lamplight")).toBe(true);
  });

  it("accepts dark", () => {
    expect(isThemeId("dark")).toBe(true);
  });

  it("rejects light", () => {
    expect(isThemeId("light")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isThemeId("")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isThemeId(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isThemeId(null)).toBe(false);
  });
});

describe("THEMES — terminalTheme completeness", () => {
  const ANSI_KEYS = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ] as const;

  const REQUIRED_BASE_KEYS = [
    "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  ] as const;

  const CSS_COLOR_RE = /#[0-9a-fA-F]{3,8}|rgba?\(|oklch\(/;

  for (const id of ["lamplight", "dark"] as const) {
    describe(`THEMES.${id}.terminalTheme`, () => {
      it("has all required base keys (background, foreground, cursor, cursorAccent, selectionBackground)", () => {
        const theme = THEMES[id].terminalTheme;
        for (const key of REQUIRED_BASE_KEYS) {
          expect(theme).toHaveProperty(key);
        }
      });

      it("has exactly 16 ANSI color keys", () => {
        const theme = THEMES[id].terminalTheme;
        const presentAnsi = ANSI_KEYS.filter((k) => k in theme);
        expect(presentAnsi).toHaveLength(16);
      });

      it("all color values are valid CSS color strings", () => {
        const theme = THEMES[id].terminalTheme as Record<string, unknown>;
        const allKeys = [...REQUIRED_BASE_KEYS, ...ANSI_KEYS];
        for (const key of allKeys) {
          const val = theme[key];
          if (val === undefined) continue; // selectionForeground may be undefined
          expect(typeof val).toBe("string");
          expect(CSS_COLOR_RE.test(val as string)).toBe(true);
        }
      });
    });
  }
});

describe("parseStoredThemeId", () => {
  it("parses Zustand persist envelope with dark", () => {
    const raw = JSON.stringify({ state: { themeId: "dark" }, version: 0 });
    expect(parseStoredThemeId(raw)).toBe("dark");
  });

  it("parses Zustand persist envelope with lamplight", () => {
    const raw = JSON.stringify({ state: { themeId: "lamplight" }, version: 0 });
    expect(parseStoredThemeId(raw)).toBe("lamplight");
  });

  it("returns lamplight for null", () => {
    expect(parseStoredThemeId(null)).toBe("lamplight");
  });

  it("returns lamplight for garbage string", () => {
    expect(parseStoredThemeId("not-json")).toBe("lamplight");
  });

  it("returns lamplight for malformed JSON (missing state)", () => {
    expect(parseStoredThemeId(JSON.stringify({ themeId: "dark" }))).toBe("lamplight");
  });

  it("returns lamplight for invalid union value", () => {
    const raw = JSON.stringify({ state: { themeId: "light" }, version: 0 });
    expect(parseStoredThemeId(raw)).toBe("lamplight");
  });

  it("returns lamplight for empty string", () => {
    expect(parseStoredThemeId("")).toBe("lamplight");
  });
});
