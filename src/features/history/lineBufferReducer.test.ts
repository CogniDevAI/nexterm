// features/history/lineBufferReducer.test.ts
// TDD RED phase — pure reducer for capturing typed commands from xterm onData stream.
//
// The reducer processes raw xterm.js onData chunks and maintains a line buffer
// that flushes when the user presses Enter (\r).

import { describe, it, expect } from "vitest";
import {
  reduceLineBuffer,
  makeLineBufferState,
} from "./lineBufferReducer";

// ── Initial state ─────────────────────────────────────────────────────────────

describe("lineBufferReducer — makeLineBufferState", () => {
  it("returns empty buffer and inEscSeq false", () => {
    const state = makeLineBufferState();
    expect(state.buffer).toBe("");
    expect(state.inEscSeq).toBe(false);
  });
});

// ── Printable char accumulation ───────────────────────────────────────────────

describe("lineBufferReducer — printable chars", () => {
  it("appends printable ASCII chars to the buffer", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "l");
    s = reduceLineBuffer(s, "s");
    s = reduceLineBuffer(s, " ");
    s = reduceLineBuffer(s, "-");
    s = reduceLineBuffer(s, "l");
    expect(s.buffer).toBe("ls -l");
    expect(s.flushed).toBeUndefined();
  });

  it("handles a whole printable string in one chunk", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "git status");
    expect(s.buffer).toBe("git status");
  });

  it("does not flush on printable input (flushed stays absent)", () => {
    const s = reduceLineBuffer(makeLineBufferState(), "hello");
    expect(s.flushed).toBeUndefined();
  });
});

// ── Backspace ─────────────────────────────────────────────────────────────────

describe("lineBufferReducer — backspace (\\x7f / \\b)", () => {
  it("removes the last char on \\x7f (DEL)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "abc");
    s = reduceLineBuffer(s, "\x7f");
    expect(s.buffer).toBe("ab");
  });

  it("removes the last char on \\b (BS)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "xyz");
    s = reduceLineBuffer(s, "\b");
    expect(s.buffer).toBe("xy");
  });

  it("does nothing on backspace when buffer is empty", () => {
    const s = reduceLineBuffer(makeLineBufferState(), "\x7f");
    expect(s.buffer).toBe("");
  });

  it("handles multiple backspaces correctly", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "hello");
    s = reduceLineBuffer(s, "\x7f\x7f\x7f");
    expect(s.buffer).toBe("he");
  });

  it("correctly removes multi-byte (emoji/CJK) last char via grapheme-safe slice", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "hi");
    // Add an emoji (multi-codepoint)
    s = reduceLineBuffer(s, "😀");
    s = reduceLineBuffer(s, "\x7f");
    // After backspace, emoji should be removed, leaving "hi"
    expect(s.buffer).toBe("hi");
  });
});

// ── Ctrl-C reset ──────────────────────────────────────────────────────────────

describe("lineBufferReducer — Ctrl-C (\\x03)", () => {
  it("resets buffer to empty (command cancelled)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "sudo rm -rf");
    s = reduceLineBuffer(s, "\x03");
    expect(s.buffer).toBe("");
    expect(s.flushed).toBeUndefined();
  });

  it("does not flush (flushed stays absent)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "cmd");
    s = reduceLineBuffer(s, "\x03");
    expect(s.flushed).toBeUndefined();
  });
});

// ── Ctrl-U reset ──────────────────────────────────────────────────────────────

describe("lineBufferReducer — Ctrl-U (\\x15)", () => {
  it("resets buffer to empty (line cleared)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "partial command");
    s = reduceLineBuffer(s, "\x15");
    expect(s.buffer).toBe("");
    expect(s.flushed).toBeUndefined();
  });
});

// ── Enter flush ───────────────────────────────────────────────────────────────

describe("lineBufferReducer — Enter (\\r) flush", () => {
  it("flushes non-empty buffer and returns flushed command", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "ls -la");
    s = reduceLineBuffer(s, "\r");
    expect(s.flushed).toBe("ls -la");
    expect(s.buffer).toBe("");
  });

  it("trims whitespace from the flushed command", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "  git status  ");
    s = reduceLineBuffer(s, "\r");
    expect(s.flushed).toBe("git status");
  });

  it("does NOT flush when buffer is empty after trim", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "   ");
    s = reduceLineBuffer(s, "\r");
    expect(s.flushed).toBeUndefined();
    expect(s.buffer).toBe("");
  });

  it("resets the buffer after flush", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "cmd1");
    s = reduceLineBuffer(s, "\r");
    expect(s.buffer).toBe("");
    // Next input goes to fresh buffer
    s = reduceLineBuffer(s, "cmd2");
    expect(s.buffer).toBe("cmd2");
  });

  it("flushed is absent when pressing Enter on empty buffer", () => {
    const s = reduceLineBuffer(makeLineBufferState(), "\r");
    expect(s.flushed).toBeUndefined();
  });
});

// ── Escape sequence skip ──────────────────────────────────────────────────────

describe("lineBufferReducer — ESC sequence skip (\\x1b)", () => {
  it("does not accumulate up-arrow (\\x1b[A) into buffer", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "ls");
    s = reduceLineBuffer(s, "\x1b[A"); // up-arrow
    expect(s.buffer).toBe("ls");
    expect(s.inEscSeq).toBe(false);
  });

  it("does not accumulate delete-key sequence (\\x1b[3~)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "ab");
    s = reduceLineBuffer(s, "\x1b[3~");
    expect(s.buffer).toBe("ab");
    expect(s.inEscSeq).toBe(false);
  });

  it("does not accumulate F1 sequence (\\x1bOP)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "abc");
    s = reduceLineBuffer(s, "\x1bOP");
    expect(s.buffer).toBe("abc");
    expect(s.inEscSeq).toBe(false);
  });

  it("can resume accumulating printable chars after an escape sequence", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "git");
    s = reduceLineBuffer(s, "\x1b[A"); // up-arrow
    s = reduceLineBuffer(s, " status");
    expect(s.buffer).toBe("git status");
  });

  it("does not flush on an escape sequence", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "ls");
    s = reduceLineBuffer(s, "\x1b[A");
    expect(s.flushed).toBeUndefined();
  });
});

// ── Tab (\\x09) ignored ────────────────────────────────────────────────────────

describe("lineBufferReducer — tab (\\x09)", () => {
  it("ignores tab character (not accumulated)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "git");
    s = reduceLineBuffer(s, "\x09"); // tab (completion attempt)
    expect(s.buffer).toBe("git");
  });
});

// ── Paste chunk with \\r mid-string ───────────────────────────────────────────

describe("lineBufferReducer — paste with \\r mid-chunk", () => {
  it("flushes at the \\r in a multi-char chunk", () => {
    // Simulate pasting "echo hello\r"
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "echo hello\r");
    expect(s.flushed).toBe("echo hello");
    expect(s.buffer).toBe("");
  });

  it("handles chars after \\r going into a new buffer", () => {
    // "cmd1\rcmd2" — flush cmd1, start cmd2
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "cmd1\rcmd2");
    expect(s.flushed).toBe("cmd1");
    // flushed reflects the LAST flush in the chunk
    // buffer accumulates what came after
    expect(s.buffer).toBe("cmd2");
  });

  it("handles multiple \\r in one chunk — returns last flushed", () => {
    // Two Enter presses in one chunk
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "cmd1\rcmd2\r");
    // flushed should be "cmd2" (the last flush)
    expect(s.flushed).toBe("cmd2");
    expect(s.buffer).toBe("");
  });
});

// ── Buffer cap (>2048 chars) ─────────────────────────────────────────────────

describe("lineBufferReducer — buffer cap", () => {
  it("resets buffer without flush when length exceeds 2048 chars", () => {
    let s = makeLineBufferState();
    // Build a string just over the cap
    const longStr = "a".repeat(2049);
    s = reduceLineBuffer(s, longStr);
    expect(s.buffer).toBe("");
    expect(s.flushed).toBeUndefined();
  });

  it("exactly 2048 chars does not reset", () => {
    let s = makeLineBufferState();
    const exactly2048 = "a".repeat(2048);
    s = reduceLineBuffer(s, exactly2048);
    expect(s.buffer).toBe(exactly2048);
    expect(s.flushed).toBeUndefined();
  });

  it("after a cap reset, subsequent typing accumulates normally", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "x".repeat(2049));
    s = reduceLineBuffer(s, "ok");
    expect(s.buffer).toBe("ok");
  });
});

// ── Cross-chunk escape state (inEscSeq / inSS3 persists between chunks) ──────
//
// The reducer carries escape-sequence state across calls. These tests verify
// that a sequence split across two onData chunks is handled correctly and no
// char leaks into the buffer.

describe("lineBufferReducer — cross-chunk escape state (MINOR-3)", () => {
  it("CSI split: feeding 'ls\\x1b' then '[A' keeps buffer as 'ls'", () => {
    // Simulates an up-arrow split: chunk1 ends with bare ESC, chunk2 has '[A'
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "ls\x1b");
    // inEscSeq must be true after chunk1
    expect(s.inEscSeq).toBe(true);
    s = reduceLineBuffer(s, "[A");
    // '[' is an intermediate CSI char; 'A' is the letter terminator
    expect(s.buffer).toBe("ls");
    expect(s.inEscSeq).toBe(false);
    expect(s.flushed).toBeUndefined();
  });

  it("CSI split: buffer flushes correctly on \\r after cross-chunk sequence", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "ls\x1b");
    s = reduceLineBuffer(s, "[A\r");
    // The up-arrow should be eaten; only 'ls' should flush
    expect(s.flushed).toBe("ls");
    expect(s.buffer).toBe("");
  });

  it("SS3 split: feeding 'x\\x1b' then 'OP' (F1) keeps buffer as 'x'", () => {
    // ESC O is SS3 introducer, P is the F1 terminator — split across two chunks
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "x\x1b");
    expect(s.inEscSeq).toBe(true);
    s = reduceLineBuffer(s, "OP");
    // 'O' transitions to inSS3; 'P' terminates it — 'x' must remain, no leakage
    expect(s.buffer).toBe("x");
    expect(s.inEscSeq).toBe(false);
    expect(s.inSS3).toBe(false);
    expect(s.flushed).toBeUndefined();
  });
});

// ── Other control chars ignored ───────────────────────────────────────────────

describe("lineBufferReducer — other control chars", () => {
  it("ignores null char (\\x00)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "a\x00b");
    expect(s.buffer).toBe("ab");
  });

  it("ignores \\x01 (Ctrl-A)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "a\x01b");
    expect(s.buffer).toBe("ab");
  });

  it("ignores \\n (LF, 0x0a)", () => {
    let s = makeLineBufferState();
    s = reduceLineBuffer(s, "a\nb");
    expect(s.buffer).toBe("ab");
  });
});
