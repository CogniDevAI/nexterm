// features/terminal/broadcastUtils.test.ts — TDD: WU-1 RED phase
//
// Pure unit tests for getBroadcastTargets.
// No DOM, no React — pure Node. No mocks needed.

import { describe, it, expect } from "vitest";
import { getBroadcastTargets } from "./broadcastUtils";
import type { PaneSlot } from "../../stores/paneLayoutStore";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSlot(terminalId: string | null): PaneSlot {
  return { id: crypto.randomUUID(), terminalId, ratio: 0.5 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getBroadcastTargets", () => {
  it("returns [] when session is not connected (disconnected)", () => {
    const slots = [makeSlot("term-1"), makeSlot("term-2")];
    expect(getBroadcastTargets(slots, "term-1", "disconnected")).toEqual([]);
  });

  it("returns [] when session is connecting", () => {
    const slots = [makeSlot("term-1"), makeSlot("term-2")];
    expect(getBroadcastTargets(slots, "term-1", "connecting")).toEqual([]);
  });

  it("returns [] when session is authenticating", () => {
    const slots = [makeSlot("term-1"), makeSlot("term-2")];
    expect(getBroadcastTargets(slots, "term-1", "authenticating")).toEqual([]);
  });

  it("returns [] when session state is an error object", () => {
    const slots = [makeSlot("term-1"), makeSlot("term-2")];
    expect(
      getBroadcastTargets(slots, "term-1", { error: { message: "connection reset" } }),
    ).toEqual([]);
  });

  it("excludes the source terminalId from targets", () => {
    const slots = [makeSlot("term-1"), makeSlot("term-2"), makeSlot("term-3")];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).not.toContain("term-1");
  });

  it("includes all other live (non-source) terminalIds when connected", () => {
    const slots = [makeSlot("term-1"), makeSlot("term-2"), makeSlot("term-3")];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).toContain("term-2");
    expect(result).toContain("term-3");
    expect(result).toHaveLength(2);
  });

  it("excludes slots with null terminalId (pending slots)", () => {
    const slots = [makeSlot("term-1"), makeSlot(null), makeSlot("term-3")];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).toEqual(["term-3"]);
  });

  it("excludes slots whose terminalId starts with 'pending-'", () => {
    const slots = [makeSlot("term-1"), makeSlot("pending-abc123"), makeSlot("term-3")];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).toEqual(["term-3"]);
  });

  it("returns [] when only the source slot exists (no other panes)", () => {
    const slots = [makeSlot("term-1")];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).toEqual([]);
  });

  it("returns [] when all other slots are null or pending", () => {
    const slots = [makeSlot("term-1"), makeSlot(null), makeSlot("pending-xyz")];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).toEqual([]);
  });

  it("handles 4 panes correctly — returns 3 targets", () => {
    const slots = [
      makeSlot("term-1"),
      makeSlot("term-2"),
      makeSlot("term-3"),
      makeSlot("term-4"),
    ];
    const result = getBroadcastTargets(slots, "term-1", "connected");
    expect(result).toHaveLength(3);
    expect(result).toContain("term-2");
    expect(result).toContain("term-3");
    expect(result).toContain("term-4");
  });
});
