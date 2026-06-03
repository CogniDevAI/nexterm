// features/monitoring/MonitoringPanel.test.tsx — TDD: MonitoringPanel rendering
//
// Regression guard: the panel must mount without an infinite render loop when
// the store has no samples yet for the session (the real first-open state,
// before the sampler delivers its first tick). A selector returning a fresh
// `?? []` array on every call breaks useSyncExternalStore under Zustand v5.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock("../../lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => {
      const labels: Record<string, string> = {
        "monitoring.unsupported": "Monitoring not supported on this host",
        "monitoring.loading": "Collecting system metrics...",
        "monitoring.cpu": "CPU",
        "monitoring.ram": "RAM",
      };
      return labels[k] ?? k;
    },
  }),
}));

// ── Tauri mock ────────────────────────────────────────────────────────────────

const { mockTauriInvoke } = vi.hoisted(() => ({
  mockTauriInvoke: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: mockTauriInvoke,
}));

// ── Hook mock (avoid the real sampler) ──────────────────────────────────────────

vi.mock("./useMonitoring", () => ({
  useMonitoring: () => undefined,
}));

// ── Store ───────────────────────────────────────────────────────────────────────

import { useMonitoringStore } from "../../stores/monitoringStore";

function resetMonitoringStore() {
  useMonitoringStore.setState({
    samples: new Map(),
    isSupported: new Map(),
  });
}

// ── Component import (after mocks) ──────────────────────────────────────────────

import { MonitoringPanel } from "./MonitoringPanel";

const SESSION_ID = "session-monitoring-test";

describe("MonitoringPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMonitoringStore();
  });

  it("renders the loading state without crashing when no samples exist yet", () => {
    // No samples seeded for SESSION_ID — exercises the `s.samples.get(id)`
    // undefined path. A fresh `?? []` inside the selector would loop here.
    render(<MonitoringPanel sessionId={SESSION_ID} />);
    expect(screen.getByText("Collecting system metrics...")).toBeInTheDocument();
  });

  it("renders the unsupported state when isSupported=false", () => {
    useMonitoringStore.setState({
      isSupported: new Map([[SESSION_ID, false]]),
    });
    render(<MonitoringPanel sessionId={SESSION_ID} />);
    expect(
      screen.getByText("Monitoring not supported on this host"),
    ).toBeInTheDocument();
  });
});
