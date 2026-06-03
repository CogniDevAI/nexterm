// features/monitoring/useMonitoring.test.ts — TDD: monitoring hook lifecycle

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockTauriInvoke } = vi.hoisted(() => ({
  mockTauriInvoke: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: mockTauriInvoke,
}));

// Captured Channel instance so tests can fire onmessage callbacks.
type ChannelOnMessage = ((msg: unknown) => void) | null;
let capturedOnMessage: ChannelOnMessage = null;

vi.mock("@tauri-apps/api/core", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const ChannelMock: Function = vi.fn(function (this: unknown) {
    capturedOnMessage = null;
    Object.defineProperty(this, "onmessage", {
      set(v: ChannelOnMessage) {
        capturedOnMessage = v;
      },
      get() {
        return capturedOnMessage;
      },
      configurable: true,
    });
  });
  return {
    Channel: ChannelMock,
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Store reset ───────────────────────────────────────────────────────────────

import { useMonitoringStore } from "../../stores/monitoringStore";
import type { MetricSample } from "../../stores/monitoringStore";

function resetMonitoringStore() {
  useMonitoringStore.setState({
    samples: new Map(),
    isSupported: new Map(),
    isRunning: new Map(),
  });
}

// ── Hook import (after mocks) ──────────────────────────────────────────────────

import { useMonitoring } from "./useMonitoring";

const SESSION_ID = "test-session-42";

function makeSampleEvent(tick: number): { event: string; data: MetricSample } {
  return {
    event: "sample",
    data: {
      sessionId: SESSION_ID,
      cpuPct: 25,
      memPct: 50,
      diskEntries: [],
      netRxBps: 1000,
      netTxBps: 500,
      processes: [],
      tick,
    },
  };
}

describe("useMonitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnMessage = null;
    resetMonitoringStore();
    mockTauriInvoke.mockResolvedValue(undefined);
  });

  it("calls start_monitoring on mount", async () => {
    renderHook(() => useMonitoring(SESSION_ID));
    await act(async () => {
      // Let promises settle
    });
    expect(mockTauriInvoke).toHaveBeenCalledWith(
      "start_monitoring",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("calls stop_monitoring on unmount", async () => {
    const { unmount } = renderHook(() => useMonitoring(SESSION_ID));
    await act(async () => {});
    unmount();
    await act(async () => {});
    expect(mockTauriInvoke).toHaveBeenCalledWith(
      "stop_monitoring",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("adding a sample event dispatches to monitoringStore", async () => {
    renderHook(() => useMonitoring(SESSION_ID));
    await act(async () => {});

    // Fire a Sample event through the captured channel
    act(() => {
      capturedOnMessage?.(makeSampleEvent(0));
    });

    const samples = useMonitoringStore.getState().samples.get(SESSION_ID);
    expect(samples).toHaveLength(1);
    expect(samples![0]!.tick).toBe(0);
  });

  it("Unsupported event sets isSupported to false", async () => {
    renderHook(() => useMonitoring(SESSION_ID));
    await act(async () => {});

    act(() => {
      capturedOnMessage?.({ event: "unsupported", data: null });
    });

    expect(useMonitoringStore.getState().isSupported.get(SESSION_ID)).toBe(false);
  });

  it("does not call start_monitoring when sessionId is empty", async () => {
    renderHook(() => useMonitoring(""));
    await act(async () => {});
    expect(mockTauriInvoke).not.toHaveBeenCalledWith("start_monitoring", expect.anything());
  });
});
