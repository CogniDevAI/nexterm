// stores/paneLayoutStore.test.ts
//
// TDD: RED phase first — tests for the ephemeral pane layout store.
// All tests run in pure Node (no jsdom needed) because the store
// is a Zustand reducer with no DOM interaction.

import { describe, it, expect, beforeEach } from "vitest";
import {
  usePaneLayoutStore,
  MAX_PANE_COUNT,
  type PaneLayout,
} from "./paneLayoutStore";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore() {
  usePaneLayoutStore.setState({ layouts: {} });
}

function getLayout(sessionId: string): PaneLayout | undefined {
  return usePaneLayoutStore.getState().layouts[sessionId];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("paneLayoutStore — openLayout", () => {
  beforeEach(resetStore);

  it("creates a layout with a single slot for a new session", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const layout = getLayout("sess-1");
    expect(layout).toBeDefined();
    expect(layout!.slots).toHaveLength(1);
    expect(layout!.slots[0].terminalId).toBe("term-1");
    expect(layout!.slots[0].ratio).toBeCloseTo(1);
  });

  it("does not clobber an existing layout on re-open", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    usePaneLayoutStore.getState().splitSlot("sess-1", usePaneLayoutStore.getState().layouts["sess-1"].slots[0].id);
    const slotsBefore = getLayout("sess-1")!.slots.length;
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    expect(getLayout("sess-1")!.slots.length).toBe(slotsBefore);
  });
});

describe("paneLayoutStore — splitSlot", () => {
  beforeEach(resetStore);

  it("inserts a new slot after the given slot with equal ratios", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstSlotId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstSlotId);
    const layout = getLayout("sess-1")!;
    expect(layout.slots).toHaveLength(2);
    expect(layout.slots[0].ratio).toBeCloseTo(0.5);
    expect(layout.slots[1].ratio).toBeCloseTo(0.5);
    expect(layout.slots[1].terminalId).toBeNull();
  });

  it("assigns stable UUIDs as slot ids (different from terminalId)", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstSlotId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstSlotId);
    const layout = getLayout("sess-1")!;
    const [a, b] = layout.slots;
    expect(a.id).not.toBe(a.terminalId);
    expect(b.id).not.toBe(b.terminalId);
    expect(a.id).not.toBe(b.id);
  });

  it("caps at MAX_PANE_COUNT and ignores further splits", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    for (let i = 0; i < MAX_PANE_COUNT + 2; i++) {
      const lastId = getLayout("sess-1")!.slots.at(-1)!.id;
      usePaneLayoutStore.getState().splitSlot("sess-1", lastId);
    }
    expect(getLayout("sess-1")!.slots.length).toBeLessThanOrEqual(MAX_PANE_COUNT);
  });

  it("three-way split redistributes ratios equally", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstId);
    const secondId = getLayout("sess-1")!.slots[1].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", secondId);
    const slots = getLayout("sess-1")!.slots;
    expect(slots).toHaveLength(3);
    slots.forEach((s) => expect(s.ratio).toBeCloseTo(1 / 3, 5));
  });
});

describe("paneLayoutStore — closeSlot", () => {
  beforeEach(resetStore);

  it("removes the slot and redistributes ratios equally", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstId);
    const slotToClose = getLayout("sess-1")!.slots[1].id;
    usePaneLayoutStore.getState().closeSlot("sess-1", slotToClose);
    const layout = getLayout("sess-1")!;
    expect(layout.slots).toHaveLength(1);
    expect(layout.slots[0].ratio).toBeCloseTo(1);
  });

  it("does not remove the last slot", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const onlyId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().closeSlot("sess-1", onlyId);
    expect(getLayout("sess-1")!.slots).toHaveLength(1);
  });

  it("removes the layout entry when the session is closed", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    usePaneLayoutStore.getState().removeLayout("sess-1");
    expect(getLayout("sess-1")).toBeUndefined();
  });
});

describe("paneLayoutStore — setRatio", () => {
  beforeEach(resetStore);

  it("clamps ratios to [0, 1]", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const id = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().setRatio("sess-1", id, -0.5);
    expect(getLayout("sess-1")!.slots[0].ratio).toBeCloseTo(0);
    usePaneLayoutStore.getState().setRatio("sess-1", id, 1.5);
    expect(getLayout("sess-1")!.slots[0].ratio).toBeCloseTo(1);
  });

  it("updates the ratio of the target slot", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstId);
    usePaneLayoutStore.getState().setRatio("sess-1", firstId, 0.3);
    expect(getLayout("sess-1")!.slots[0].ratio).toBeCloseTo(0.3);
  });
});

describe("paneLayoutStore — assignTerminal", () => {
  beforeEach(resetStore);

  it("assigns a real terminalId to a pending slot", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstId);
    const pendingSlotId = getLayout("sess-1")!.slots[1].id;
    usePaneLayoutStore.getState().assignTerminal("sess-1", pendingSlotId, "term-2");
    expect(getLayout("sess-1")!.slots[1].terminalId).toBe("term-2");
  });
});

describe("paneLayoutStore — focusSlot", () => {
  beforeEach(resetStore);

  it("updates focusedSlotId in the layout", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const firstId = getLayout("sess-1")!.slots[0].id;
    usePaneLayoutStore.getState().splitSlot("sess-1", firstId);
    const secondId = getLayout("sess-1")!.slots[1].id;
    usePaneLayoutStore.getState().focusSlot("sess-1", secondId);
    expect(getLayout("sess-1")!.focusedSlotId).toBe(secondId);
  });

  it("openLayout sets the initial slot as focused", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    const layout = getLayout("sess-1")!;
    expect(layout.focusedSlotId).toBe(layout.slots[0].id);
  });
});

describe("paneLayoutStore — direction", () => {
  beforeEach(resetStore);

  it("defaults to horizontal direction", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    expect(getLayout("sess-1")!.direction).toBe("horizontal");
  });

  it("setDirection updates the direction", () => {
    usePaneLayoutStore.getState().openLayout("sess-1", "term-1");
    usePaneLayoutStore.getState().setDirection("sess-1", "vertical");
    expect(getLayout("sess-1")!.direction).toBe("vertical");
  });
});
