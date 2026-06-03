// src/lib/themes.ts — Theme preset registry (pure module, no DOM side-effects)
//
// This module is the single source of truth for:
//   - The ThemeId union type and its validator
//   - The xterm.js ITheme for each preset (terminal colors only)
//   - Label strings for UI controls
//
// UI token overrides live in globals.css [data-theme] blocks.
// The two are intentionally separate: CSS handles ~60 tokens via cascade;
// this module handles xterm (which has no CSS hook).

import type { ITheme } from "@xterm/xterm";

export type ThemeId = "lamplight" | "dark";

export interface ThemePreset {
  /** StatusBar toggle label, i18n-key-friendly short id reused as display token */
  label: string;
  /** xterm.js theme: bg/fg/cursor/cursorAccent/selection + all 16 ANSI */
  terminalTheme: ITheme;
}

export const DEFAULT_THEME_ID: ThemeId = "lamplight";
export const THEME_IDS: readonly ThemeId[] = ["lamplight", "dark"] as const;

export const THEMES: Record<ThemeId, ThemePreset> = {
  lamplight: {
    label: "Lamplight",
    terminalTheme: {
      // LAMPLIGHT chrome — bg-abyss canvas, warm foreground, copper cursor
      // This is the canonical definition; constants.ts re-exports it for back-compat.
      background: "#0f0b09",       // var(--bg-abyss)
      foreground: "#eeeae7",       // var(--text-primary)
      cursor: "#ea9e51",           // var(--accent) copper
      cursorAccent: "#0f0b09",     // var(--bg-abyss) — text on cursor block
      // accent-wash at ~65% opacity — copper selection replaces old blue #388bfd33
      selectionBackground: "#3c2918a6",
      selectionForeground: undefined,
      // ANSI 16-color ramp — warmed slightly to sit in the warm field while staying
      // perceptually correct for `git diff`, `ls --color`, colored logs.
      black:         "#3e3830",    // warm near-black (replaces cool #484f58)
      red:           "#e05c4a",    // warm brick-red, still clearly error (was #ff7b72)
      green:         "#4ec99a",    // jade-family green, readable as "ok" (was #3fb950)
      yellow:        "#d4a03a",    // warm ochre, distinct from accent (was #d29922)
      blue:          "#5aabf0",    // stays blue, slightly warmed (was #58a6ff)
      magenta:       "#b589e8",    // slightly desaturated (was #bc8cff)
      cyan:          "#3fc9a0",    // jade-tinted cyan (was #39d353)
      white:         "#b6b0ab",    // var(--text-secondary) warm (was #b1bac4)
      brightBlack:   "#635c57",    // var(--text-faint) warm (was #6e7681)
      brightRed:     "#f5897e",    // brighter warm red (was #ffa198)
      brightGreen:   "#66c7a0",    // var(--connected) jade (was #56d364)
      brightYellow:  "#e8b84e",    // bright warm ochre (was #e3b341)
      brightBlue:    "#82c8ff",    // bright warm blue (was #79c0ff)
      brightMagenta: "#cca8f8",    // bright desaturated magenta (was #d2a8ff)
      brightCyan:    "#66c7a0",    // jade — consistent with brightGreen (was #56d364)
      brightWhite:   "#eeeae7",    // var(--text-primary) (was #f0f6fc)
    },
  },

  dark: {
    label: "Dark",
    terminalTheme: {
      // DARK cool-slate preset — "cold instrument bay, copper still glints"
      // Neutrals shift to hue 250 (slate); copper accent retained but desaturated.
      // ANSI 16-color ramp is IDENTICAL to LAMPLIGHT by design decision D7:
      // colorized CLI output semantics (git diff, ls --color) must not shift with theme.
      //
      // WCAG AA verified (body text vs --bg-panel oklch(0.205 0.012 250)):
      //   --text-primary  oklch(0.945 0.006 250) → 15.25:1 (AAA)
      //   --text-secondary oklch(0.770 0.012 250) → 8.65:1  (AAA)
      //   --text-muted    oklch(0.620 0.014 250) → 4.92:1  (AA body, ≥4.5 required)
      //   --error         oklch(0.660 0.155  32) → 5.38:1  (AA)
      background: "#0c0e12",       // var(--bg-abyss) dark — oklch(0.135 0.010 250)
      foreground: "#eef0f3",       // cool off-white — never pure #fff
      cursor: "#c49a60",           // copper desaturated ~10% for cold room (oklch(0.770 0.118 64))
      cursorAccent: "#181c25",     // near-black on cursor (oklch(0.200 0.018 250))
      // copper accent-wash at ~65% alpha — matches --accent-wash dark override
      selectionBackground: "#3b2e18a6",
      selectionForeground: undefined,
      // ANSI 16-color ramp — SAME AS LAMPLIGHT (design decision D7)
      black:         "#3e3830",
      red:           "#e05c4a",
      green:         "#4ec99a",
      yellow:        "#d4a03a",
      blue:          "#5aabf0",
      magenta:       "#b589e8",
      cyan:          "#3fc9a0",
      white:         "#b6b0ab",
      brightBlack:   "#635c57",
      brightRed:     "#f5897e",
      brightGreen:   "#66c7a0",
      brightYellow:  "#e8b84e",
      brightBlue:    "#82c8ff",
      brightMagenta: "#cca8f8",
      brightCyan:    "#66c7a0",
      brightWhite:   "#eeeae7",
    },
  },
};

/** Type guard — narrows unknown to ThemeId */
export function isThemeId(v: unknown): v is ThemeId {
  return v === "lamplight" || v === "dark";
}

/**
 * Parses the Zustand persist envelope stored in localStorage["nexterm-theme"].
 * Zustand persist writes: {"state":{"themeId":"dark"},"version":0}
 * The FOUC inline script in index.html shares the same parse logic.
 *
 * @param raw - Raw string from localStorage.getItem(), or null
 * @returns ThemeId — valid id or DEFAULT_THEME_ID ("lamplight") as fallback
 */
export function parseStoredThemeId(raw: string | null): ThemeId {
  try {
    if (!raw) return DEFAULT_THEME_ID;
    const parsed = JSON.parse(raw);
    const v = parsed && parsed.state && parsed.state.themeId;
    if (isThemeId(v)) return v;
  } catch {
    // malformed JSON — fall through
  }
  return DEFAULT_THEME_ID;
}
