// stores/monitoringStore.test.ts — TDD: in-memory monitoring ring buffer store

import { describe, it, expect, beforeEach } from "vitest";

import {
  useMonitoringStore,
  RING_BUFFER_SIZE,
  type MetricSample,
} from "./monitoringStore";

// monitoringStore uses no persist middleware — no localStorage stub needed.

function resetStore() {
  useMonitoringStore.setState({
    samples: new Map(),
    isSupported: new Map(),
    isRunning: new Map(),
  });
}

function makeSample(sessionId: string, tick: number): MetricSample {
  return {
    sessionId,
    cpuPct: tick * 10,
    memPct: 50,
    diskEntries: [],
    netRxBps: 0,
    netTxBps: 0,
    processes: [],
    tick,
  };
}

describe("monitoringStore — ring buffer", () => {
  beforeEach(() => {
    resetStore();
  });

  it("addSample stores the first sample for a session", () => {
    const { addSample } = useMonitoringStore.getState();
    addSample(makeSample("session-1", 0));
    const stored = useMonitoringStore.getState().samples.get("session-1");
    expect(stored).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(stored![0]!.tick).toBe(0);
  });

  it("addSample accumulates samples up to RING_BUFFER_SIZE", () => {
    const { addSample } = useMonitoringStore.getState();
    for (let i = 0; i < RING_BUFFER_SIZE; i++) {
      addSample(makeSample("session-1", i));
    }
    const stored = useMonitoringStore.getState().samples.get("session-1")!;
    expect(stored).toHaveLength(RING_BUFFER_SIZE);
    expect(stored[0]!.tick).toBe(0);
    expect(stored[RING_BUFFER_SIZE - 1]!.tick).toBe(RING_BUFFER_SIZE - 1);
  });

  it("addSample drops oldest when buffer exceeds RING_BUFFER_SIZE", () => {
    const { addSample } = useMonitoringStore.getState();
    const total = RING_BUFFER_SIZE + 5;
    for (let i = 0; i < total; i++) {
      addSample(makeSample("session-1", i));
    }
    const stored = useMonitoringStore.getState().samples.get("session-1")!;
    expect(stored).toHaveLength(RING_BUFFER_SIZE);
    // The oldest (tick=0..4) were dropped; newest tick is total-1
    expect(stored[0]!.tick).toBe(5);
    expect(stored[stored.length - 1]!.tick).toBe(total - 1);
  });

  it("addSample keeps separate ring buffers per session", () => {
    const { addSample } = useMonitoringStore.getState();
    addSample(makeSample("session-a", 0));
    addSample(makeSample("session-b", 0));
    addSample(makeSample("session-a", 1));

    const a = useMonitoringStore.getState().samples.get("session-a")!;
    const b = useMonitoringStore.getState().samples.get("session-b")!;
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });
});

describe("monitoringStore — isSupported", () => {
  beforeEach(() => {
    resetStore();
  });

  it("isSupported is null (unknown) by default for any session", () => {
    const supported = useMonitoringStore.getState().isSupported.get("session-x");
    expect(supported).toBeUndefined();
  });

  it("setUnsupported marks session as unsupported (false)", () => {
    const { setUnsupported } = useMonitoringStore.getState();
    setUnsupported("session-1");
    expect(useMonitoringStore.getState().isSupported.get("session-1")).toBe(false);
  });

  it("setSupported marks session as supported (true)", () => {
    const { setSupported } = useMonitoringStore.getState();
    setSupported("session-1");
    expect(useMonitoringStore.getState().isSupported.get("session-1")).toBe(true);
  });
});

describe("monitoringStore — isRunning", () => {
  beforeEach(() => {
    resetStore();
  });

  it("setRunning marks session as running", () => {
    const { setRunning } = useMonitoringStore.getState();
    setRunning("session-1", true);
    expect(useMonitoringStore.getState().isRunning.get("session-1")).toBe(true);
  });

  it("setRunning can mark session as stopped", () => {
    const { setRunning } = useMonitoringStore.getState();
    setRunning("session-1", true);
    setRunning("session-1", false);
    expect(useMonitoringStore.getState().isRunning.get("session-1")).toBe(false);
  });
});

describe("monitoringStore — clearSession", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clearSession removes samples, isSupported, and isRunning for the session", () => {
    const store = useMonitoringStore.getState();
    store.addSample(makeSample("session-1", 0));
    store.setUnsupported("session-1");
    store.setRunning("session-1", true);

    useMonitoringStore.getState().clearSession("session-1");

    const state = useMonitoringStore.getState();
    expect(state.samples.get("session-1")).toBeUndefined();
    expect(state.isSupported.get("session-1")).toBeUndefined();
    expect(state.isRunning.get("session-1")).toBeUndefined();
  });

  it("clearSession does not affect other sessions", () => {
    const store = useMonitoringStore.getState();
    store.addSample(makeSample("session-a", 0));
    store.addSample(makeSample("session-b", 0));

    useMonitoringStore.getState().clearSession("session-a");

    expect(useMonitoringStore.getState().samples.get("session-b")).toHaveLength(1);
  });
});
