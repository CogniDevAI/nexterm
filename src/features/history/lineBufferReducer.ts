// features/history/lineBufferReducer.ts — Pure line-buffer reducer for xterm onData
//
// Processes raw xterm.js onData chunks one at a time, accumulating printable chars
// into a line buffer and flushing on Enter (\r).
//
// DESIGN NOTES:
// - Pure function — no I/O, no side-effects. Fully unit-testable in isolation.
// - grapheme-safe backspace via [...buffer].slice(0,-1).join("") — handles CJK/emoji.
// - Escape sequences (CSI/SS3): on \x1b set inEscSeq=true, skip until letter or ~.
// - Buffer cap: >2048 chars resets without flush (runaway paste guard).
// - Flushed command is trimmed; empty-after-trim → no flush.
//
// ACCEPTED v1 LIMITATIONS (no behavior change planned):
//
// MINOR-1 — Bare ESC followed by typing may swallow the next char.
//   A lone ESC keypress (not part of a CSI/SS3 sequence) sets inEscSeq=true.
//   The very next character is then treated as a CSI/SS3 byte and skipped
//   instead of being appended to the buffer. We cannot distinguish a standalone
//   ESC from the introducer of a two-byte sequence without lookahead, and
//   xterm.js delivers the ESC in a separate onData chunk when it is part of a
//   real sequence anyway. Practical impact is negligible — bare ESC at a shell
//   prompt exits most modes without producing output.
//
// MINOR-2 — A single onData chunk containing multiple \r-terminated commands
//   records only the last one.
//   reduceLineBuffer processes chars sequentially; each \r flushes and the
//   `flushed` field is overwritten on every flush within the same chunk. Only
//   the final flush in the chunk is visible to the caller. This is a v1
//   simplification: pasting multiple commands at once is unusual, and recording
//   the last is more useful than recording nothing.

/** Maximum buffer length. Exceeded → reset without recording. */
const BUFFER_CAP = 2048;

export interface LineBufferState {
  /** Accumulated printable chars typed so far (before Enter). */
  buffer: string;
  /** True while inside an ANSI escape sequence (skip chars until terminator). */
  inEscSeq: boolean;
  /**
   * True when we saw ESC followed by 'O' (SS3 introducer).
   * We need to skip one more char (the function-key terminator, e.g. 'P' for F1).
   */
  inSS3: boolean;
  /**
   * Set to the trimmed command text when a flush occurred on the most recent
   * reduceLineBuffer call. Absent (undefined) when no flush happened.
   */
  flushed?: string;
}

/** Create a fresh, empty line buffer state. */
export function makeLineBufferState(): LineBufferState {
  return { buffer: "", inEscSeq: false, inSS3: false };
}

/**
 * Process one raw xterm onData chunk and return the next state.
 *
 * Rules per character:
 *  \r           → flush (if non-empty after trim), reset buffer
 *  \x03 Ctrl-C  → reset buffer (cancelled)
 *  \x15 Ctrl-U  → reset buffer (line clear)
 *  \x7f DEL     → grapheme-safe remove last char
 *  \b   BS      → grapheme-safe remove last char
 *  \x1b ESC     → enter escape-sequence mode
 *  inEscSeq     → skip until letter or ~ (CSI/SS3 terminators), then exit
 *  \x09 TAB     → ignore (tab-completion side effect; shell handles it)
 *  < 0x20 other → ignore (other control chars)
 *  printable    → append to buffer; if buffer > BUFFER_CAP → reset, no flush
 */
export function reduceLineBuffer(
  state: LineBufferState,
  chunk: string,
): LineBufferState {
  let buffer = state.buffer;
  let inEscSeq = state.inEscSeq;
  let inSS3 = state.inSS3;
  let flushed: string | undefined = undefined;

  for (const char of chunk) {
    // ── Flush on Enter ────────────────────────────────────────────────────────
    if (char === "\r") {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) {
        flushed = trimmed;
      }
      buffer = "";
      inEscSeq = false;
      inSS3 = false;
      continue;
    }

    // ── Ctrl-C (cancel) ───────────────────────────────────────────────────────
    if (char === "\x03") {
      buffer = "";
      inEscSeq = false;
      inSS3 = false;
      continue;
    }

    // ── Ctrl-U (kill line) ────────────────────────────────────────────────────
    if (char === "\x15") {
      buffer = "";
      inEscSeq = false;
      inSS3 = false;
      continue;
    }

    // ── Backspace / DEL ───────────────────────────────────────────────────────
    if (char === "\x7f" || char === "\b") {
      if (buffer.length > 0) {
        // grapheme-safe: spread to Unicode code points, drop last
        buffer = [...buffer].slice(0, -1).join("");
      }
      continue;
    }

    // ── ESC — enter escape-sequence mode ──────────────────────────────────────
    if (char === "\x1b") {
      inEscSeq = true;
      inSS3 = false;
      continue;
    }

    // ── Inside SS3 sequence (ESC O <letter>) — skip the terminator char ────────
    if (inSS3) {
      // The next single char is the SS3 terminator (e.g. P for F1, Q for F2...)
      inSS3 = false;
      inEscSeq = false;
      continue;
    }

    // ── Inside CSI escape sequence — skip until letter or ~ ──────────────────
    if (inEscSeq) {
      // 'O' immediately after ESC = SS3 introducer (e.g. \x1bOP = F1)
      if (char === "O") {
        inEscSeq = false;
        inSS3 = true;
        continue;
      }
      // CSI/other sequence terminators: any letter (a-zA-Z) or tilde (~)
      const code = char.charCodeAt(0);
      const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
      const isTilde = char === "~";
      if (isLetter || isTilde) {
        inEscSeq = false;
      }
      // Intermediate CSI chars ([, ?, digits, semicolons) — just skip
      continue;
    }

    // ── Tab ───────────────────────────────────────────────────────────────────
    if (char === "\x09") {
      continue; // ignore — tab-completion affects server output, not our buffer
    }

    // ── Other control chars (< 0x20 and not already handled) ─────────────────
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }

    // ── Printable char — append and check cap ─────────────────────────────────
    buffer += char;
    if (buffer.length > BUFFER_CAP) {
      // Runaway paste or huge line — reset, no flush
      buffer = "";
      inEscSeq = false;
      inSS3 = false;
      flushed = undefined; // discard any partial flush in this chunk
      continue;
    }
  }

  return { buffer, inEscSeq, inSS3, flushed };
}
