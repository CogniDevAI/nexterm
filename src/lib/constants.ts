// lib/constants.ts — Application constants and defaults

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_TIMEOUT_SECS = 30;
export const DEFAULT_KEEPALIVE_SECS = 30;
export const DEFAULT_CHUNK_SIZE = 65536; // 64KB
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", "Menlo", monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.35;
export const TERMINAL_THEME = {
  // LAMPLIGHT chrome — bg-abyss canvas, warm foreground, copper cursor
  background: "#0f0b09",       // var(--bg-abyss)
  foreground: "#eeeae7",       // var(--text-primary)
  cursor: "#ea9e51",           // var(--accent) copper
  cursorAccent: "#0f0b09",     // var(--bg-abyss) — text on cursor block
  // accent-wash at ~65% opacity — copper selection replaces old blue #388bfd33
  selectionBackground: "#3c2918a6",
  selectionForeground: undefined,
  // ANSI 16-color ramp — warmed slightly to sit in the warm field while staying
  // perceptually correct for `git diff`, `ls --color`, colored logs.
  // Red stays unmistakably red (error-safe). Green shifts toward jade family
  // (distinct from live-state jade; still clearly green). Blue stays blue for
  // diffs/links. Magenta/cyan slightly desaturated to avoid neon pops.
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
} as const;

export const APP_NAME = "NexTerm";
export const KEYCHAIN_SERVICE = "nexterm";
export const RESIZE_DEBOUNCE_MS = 100;
export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 768;
