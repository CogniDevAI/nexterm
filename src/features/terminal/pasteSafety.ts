// features/terminal/pasteSafety.ts — Paste-injection (pastejacking) guard
//
// Pure helpers used by the terminal right-click paste flow. A right-click paste
// writes the clipboard verbatim to the shell PTY. If the clipboard contains an
// embedded newline (or other shell-interpreted control character), the shell
// will EXECUTE every line the moment it is written — without the user pressing
// Enter. A malicious page can exploit this (pastejacking) by hiding extra
// commands behind a benign-looking copy. We detect that case so the UI can ask
// for confirmation before sending.
//
// These functions are pure and synchronous — no DOM, no React — so they are
// trivially unit-tested.

/**
 * C0/DEL control characters that are NOT ordinary horizontal whitespace.
 * Tab (\x09) is intentionally allowed because it is benign inside a single
 * command line. Newline (\x0a) and carriage return (\x0d) are command
 * separators (risky). Every other control char in U+0000–U+001F plus DEL
 * (U+007F) is also risky because the shell/terminal may interpret it
 * (e.g. ESC starting an escape sequence, NUL, vertical tab, form feed).
 */
// eslint-disable-next-line no-control-regex
const RISKY_CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * Returns true when pasting `text` verbatim into the shell could run more than
 * one command, or could inject a terminal control sequence. Single-line text
 * (the common, safe case) returns false.
 *
 * Risky signals:
 *   - any newline (\n) or carriage return (\r) — a command separator
 *   - any other C0/DEL control character except horizontal tab (\t)
 */
export function isRiskyPaste(text: string): boolean {
  if (!text) return false;
  return RISKY_CONTROL_CHARS.test(text);
}

/**
 * Counts how many non-empty command lines `text` would run if pasted to the
 * shell. Splits on any newline variant (\n, \r, \r\n) and ignores blank lines
 * so a trailing newline does not inflate the count. Used to show the user how
 * many commands are about to execute ("This paste contains N lines").
 */
export function countCommandLines(text: string): number {
  if (!text) return 0;
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0).length;
}
