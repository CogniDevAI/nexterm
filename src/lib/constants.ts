// lib/constants.ts — Application constants and defaults

import { THEMES } from "./themes";

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_TIMEOUT_SECS = 30;
export const DEFAULT_KEEPALIVE_SECS = 30;
export const DEFAULT_CHUNK_SIZE = 65536; // 64KB
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", "Menlo", monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.35;

// Back-compat re-export: the literal has moved to src/lib/themes.ts (THEMES.lamplight.terminalTheme).
// All existing importers of TERMINAL_THEME continue to work without changes.
export const TERMINAL_THEME = THEMES.lamplight.terminalTheme;

export const APP_NAME = "NexTerm";
export const KEYCHAIN_SERVICE = "nexterm";
export const RESIZE_DEBOUNCE_MS = 100;
export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 768;

// How long a copied secret (password, private key, token) is allowed to
// linger in the system clipboard before it is auto-cleared. Kept as a
// constant so it can later be surfaced as a user-configurable Setting.
export const SECRET_CLIPBOARD_CLEAR_MS = 30_000;
