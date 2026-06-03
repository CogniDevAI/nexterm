// Unit tests for normalizeStartupCommands helper.
// Written BEFORE the implementation (TDD RED phase).

import { describe, it, expect } from "vitest";
import { normalizeStartupCommands } from "./startupCommands";

describe("normalizeStartupCommands", () => {
  it("trims whitespace from each command", () => {
    expect(normalizeStartupCommands(["  ls -la  ", "uptime"])).toEqual([
      "ls -la",
      "uptime",
    ]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(normalizeStartupCommands(["ls -la", "", "  ", "uptime"])).toEqual([
      "ls -la",
      "uptime",
    ]);
  });

  it("preserves order of commands", () => {
    expect(
      normalizeStartupCommands(["echo a", "echo b", "echo c"]),
    ).toEqual(["echo a", "echo b", "echo c"]);
  });

  it("returns empty array for all-blank input", () => {
    expect(normalizeStartupCommands(["", "  ", "\t"])).toEqual([]);
  });

  it("handles empty input array", () => {
    expect(normalizeStartupCommands([])).toEqual([]);
  });
});
