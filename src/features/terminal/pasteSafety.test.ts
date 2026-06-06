// features/terminal/pasteSafety.test.ts — TDD: paste-guard unit (RED first)
//
// Pure unit tests for isRiskyPaste + countCommandLines.
// No DOM, no React — pure Node. No mocks needed.
//
// A "risky" paste is one that, when written verbatim to a shell PTY, would
// execute more than one command without the user having a chance to review it
// (pastejacking / pastejacking-style injection). The signal is any embedded
// newline (\n or \r) or other C0 control characters the shell would interpret.

import { describe, it, expect } from "vitest";
import { isRiskyPaste, countCommandLines } from "./pasteSafety";

describe("isRiskyPaste", () => {
  it("returns false for empty string", () => {
    expect(isRiskyPaste("")).toBe(false);
  });

  it("returns false for a plain single-line command (safe)", () => {
    expect(isRiskyPaste("echo hello world")).toBe(false);
  });

  it("returns false for a single line with leading/trailing spaces (safe)", () => {
    expect(isRiskyPaste("   ls -la   ")).toBe(false);
  });

  it("returns false for tabs (whitespace, not a command separator)", () => {
    expect(isRiskyPaste("echo\tfoo\tbar")).toBe(false);
  });

  it("returns true for a trailing newline (risky — would auto-run)", () => {
    expect(isRiskyPaste("rm -rf /\n")).toBe(true);
  });

  it("returns true for a trailing carriage return (risky)", () => {
    expect(isRiskyPaste("rm -rf /\r")).toBe(true);
  });

  it("returns true for an embedded newline between two commands (risky)", () => {
    expect(isRiskyPaste("echo hi\nrm -rf /")).toBe(true);
  });

  it("returns true for CRLF line endings (risky)", () => {
    expect(isRiskyPaste("a\r\nb")).toBe(true);
  });

  it("returns true for an embedded ESC control character (risky)", () => {
    // ESC (\x1b) could start a terminal escape sequence
    expect(isRiskyPaste("ls\x1bfoo")).toBe(true);
  });

  it("returns true for a NUL control character (risky)", () => {
    expect(isRiskyPaste("ls\x00foo")).toBe(true);
  });

  it("returns true for a vertical tab control character (risky)", () => {
    expect(isRiskyPaste("ls\x0bfoo")).toBe(true);
  });
});

describe("countCommandLines", () => {
  it("returns 1 for a single line with no terminator", () => {
    expect(countCommandLines("echo hi")).toBe(1);
  });

  it("returns 1 for a single line with a trailing newline", () => {
    expect(countCommandLines("echo hi\n")).toBe(1);
  });

  it("returns 2 for two newline-separated commands", () => {
    expect(countCommandLines("echo hi\nrm -rf /")).toBe(2);
  });

  it("returns 2 for two CRLF-separated commands with trailing CRLF", () => {
    expect(countCommandLines("a\r\nb\r\n")).toBe(2);
  });

  it("ignores blank lines between commands", () => {
    expect(countCommandLines("a\n\n\nb")).toBe(2);
  });

  it("returns 0 for empty string", () => {
    expect(countCommandLines("")).toBe(0);
  });

  it("returns 0 for whitespace-only input", () => {
    expect(countCommandLines("   \n  \n")).toBe(0);
  });
});
