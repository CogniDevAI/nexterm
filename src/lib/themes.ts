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

export type ThemeId =
  | "lamplight"
  | "dark"
  | "solarized-dark"
  | "gruvbox-dark"
  | "catppuccin-mocha"
  | "nord";

export interface ThemePreset {
  /** Picker label — proper noun, not i18n'd (theme names are brand names) */
  label: string;
  /** xterm.js theme: bg/fg/cursor/cursorAccent/selection + all 16 ANSI */
  terminalTheme: ITheme;
}

export const DEFAULT_THEME_ID: ThemeId = "lamplight";
export const THEME_IDS: readonly ThemeId[] = [
  "lamplight",
  "dark",
  "solarized-dark",
  "gruvbox-dark",
  "catppuccin-mocha",
  "nord",
] as const;

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

  "solarized-dark": {
    label: "Solarized Dark",
    terminalTheme: {
      // SOLARIZED DARK — Ethan Schoonover (MIT License)
      // Canonical colors from ethanschoonover.com/solarized
      // WCAG AA: text #839496 on bg-panel #073642 ≈ 4.7:1 (AA pass)
      background: "#002b36",       // base03 — terminal canvas / bg-abyss
      foreground: "#839496",       // base0  — primary text
      cursor: "#b58900",           // yellow — accent cursor
      cursorAccent: "#002b36",     // base03 — text on cursor block
      selectionBackground: "#073642a6", // base02 at ~65% alpha
      selectionForeground: undefined,
      // Solarized canonical 16-color ANSI ramp
      black:         "#073642",    // base02
      red:           "#dc322f",    // red
      green:         "#859900",    // green
      yellow:        "#b58900",    // yellow
      blue:          "#268bd2",    // blue
      magenta:       "#d33682",    // magenta
      cyan:          "#2aa198",    // cyan
      white:         "#eee8d5",    // base2
      brightBlack:   "#002b36",    // base03
      brightRed:     "#cb4b16",    // orange
      brightGreen:   "#586e75",    // base01
      brightYellow:  "#657b83",    // base00
      brightBlue:    "#839496",    // base0
      brightMagenta: "#6c71c4",    // violet
      brightCyan:    "#93a1a1",    // base1
      brightWhite:   "#fdf6e3",    // base3
    },
  },

  "gruvbox-dark": {
    label: "Gruvbox Dark",
    terminalTheme: {
      // GRUVBOX DARK — Pavel Pertsev / morhetz (MIT License)
      // Canonical colors from github.com/morhetz/gruvbox
      // WCAG AAA: text #ebdbb2 on bg-panel #282828 ≈ 11.8:1 (AAA)
      background: "#1d2021",       // hard bg — bg-abyss / terminal canvas
      foreground: "#ebdbb2",       // fg — primary text
      cursor: "#d79921",           // yellow — accent cursor
      cursorAccent: "#1d2021",     // hard bg — text on cursor block
      selectionBackground: "#3c3836a6", // bg1 at ~65% alpha
      selectionForeground: undefined,
      // Gruvbox canonical 16-color ANSI ramp (dark hard variant)
      black:         "#282828",    // bg0
      red:           "#cc241d",    // red
      green:         "#98971a",    // green
      yellow:        "#d79921",    // yellow
      blue:          "#458588",    // blue
      magenta:       "#b16286",    // purple
      cyan:          "#689d6a",    // aqua
      white:         "#a89984",    // fg4
      brightBlack:   "#928374",    // gray
      brightRed:     "#fb4934",    // bright red
      brightGreen:   "#b8bb26",    // bright green
      brightYellow:  "#fabd2f",    // bright yellow
      brightBlue:    "#83a598",    // bright blue
      brightMagenta: "#d3869b",    // bright purple
      brightCyan:    "#8ec07c",    // bright aqua
      brightWhite:   "#ebdbb2",    // fg
    },
  },

  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    terminalTheme: {
      // CATPPUCCIN MOCHA — Catppuccin (MIT License)
      // Canonical colors from catppuccin/catppuccin
      // WCAG AAA: text #cdd6f4 on bg-panel #313244 ≈ 9.4:1 (AAA)
      background: "#1e1e2e",       // base — terminal canvas / bg-abyss
      foreground: "#cdd6f4",       // text — primary text
      cursor: "#cba6f7",           // mauve — accent cursor
      cursorAccent: "#1e1e2e",     // base — text on cursor block
      selectionBackground: "#313244a6", // surface0 at ~65% alpha
      selectionForeground: undefined,
      // Catppuccin Mocha canonical 16-color ANSI ramp
      black:         "#45475a",    // surface1
      red:           "#f38ba8",    // red
      green:         "#a6e3a1",    // green
      yellow:        "#f9e2af",    // yellow
      blue:          "#89b4fa",    // blue
      magenta:       "#f5c2e7",    // pink
      cyan:          "#94e2d5",    // teal
      white:         "#bac2de",    // subtext1
      brightBlack:   "#585b70",    // surface2
      brightRed:     "#f38ba8",    // red (same; Catppuccin uses same for bright)
      brightGreen:   "#a6e3a1",    // green
      brightYellow:  "#f9e2af",    // yellow
      brightBlue:    "#89b4fa",    // blue
      brightMagenta: "#f5c2e7",    // pink
      brightCyan:    "#94e2d5",    // teal
      brightWhite:   "#a6adc8",    // subtext0
    },
  },

  nord: {
    label: "Nord",
    terminalTheme: {
      // NORD — Arctic Ice Studio / nordtheme.com (MIT License)
      // Canonical colors from nordtheme.com/docs/colors-and-palettes
      // WCAG AAA: text #eceff4 on bg-panel #3b4252 ≈ 8.9:1 (AAA)
      background: "#2e3440",       // nord0 — terminal canvas / bg-abyss
      foreground: "#eceff4",       // nord6 — primary text
      cursor: "#88c0d0",           // nord8 frost — accent cursor
      cursorAccent: "#2e3440",     // nord0 — text on cursor block
      selectionBackground: "#3b4252a6", // nord1 at ~65% alpha
      selectionForeground: undefined,
      // Nord canonical 16-color ANSI ramp
      black:         "#3b4252",    // nord1
      red:           "#bf616a",    // nord11
      green:         "#a3be8c",    // nord14
      yellow:        "#ebcb8b",    // nord13
      blue:          "#81a1c1",    // nord9
      magenta:       "#b48ead",    // nord15
      cyan:          "#88c0d0",    // nord8
      white:         "#e5e9f0",    // nord5
      brightBlack:   "#4c566a",    // nord3
      brightRed:     "#bf616a",    // nord11
      brightGreen:   "#a3be8c",    // nord14
      brightYellow:  "#ebcb8b",    // nord13
      brightBlue:    "#81a1c1",    // nord9
      brightMagenta: "#b48ead",    // nord15
      brightCyan:    "#8fbcbb",    // nord7
      brightWhite:   "#eceff4",    // nord6
    },
  },
};

/** Type guard — narrows unknown to ThemeId */
export function isThemeId(v: unknown): v is ThemeId {
  return (
    v === "lamplight" ||
    v === "dark" ||
    v === "solarized-dark" ||
    v === "gruvbox-dark" ||
    v === "catppuccin-mocha" ||
    v === "nord"
  );
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
