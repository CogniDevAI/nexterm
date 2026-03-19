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
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#388bfd33",
  selectionForeground: undefined,
  // ANSI colors (GitHub Dark inspired)
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39d353",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d364",
  brightWhite: "#f0f6fc",
} as const;

export const APP_NAME = "NexTerm";
export const KEYCHAIN_SERVICE = "nexterm";
export const RESIZE_DEBOUNCE_MS = 100;
export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 768;
