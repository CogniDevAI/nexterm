// features/proxmox/useProxmox.test.ts — TDD: Proxmox hook lifecycle

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockTauriInvoke } = vi.hoisted(() => ({
  mockTauriInvoke: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: mockTauriInvoke,
}));

// ── Store reset ───────────────────────────────────────────────────────────────

import { useProxmoxStore } from "../../stores/proxmoxStore";

function resetStore() {
  useProxmoxStore.setState({
    containers: new Map(),
    snapshots: new Map(),
    availability: new Map(),
    loading: new Map(),
  });
}

// ── Hook import (after mocks) ──────────────────────────────────────────────────

import { useProxmox } from "./useProxmox";

const SESSION_ID = "test-session-proxmox-1";

function makeListResult(available = true) {
  return {
    containers: [
      {
        vmid: 100,
        status: "running",
        name: "debian-dev",
      },
    ],
    pctUnavailable: !available,
  };
}

describe("useProxmox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockTauriInvoke.mockResolvedValue(makeListResult());
  });

  it("calls proxmox_list_lxc on mount", async () => {
    renderHook(() => useProxmox(SESSION_ID));
    await act(async () => {});
    expect(mockTauriInvoke).toHaveBeenCalledWith(
      "proxmox_list_lxc",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("populates store with containers after mount", async () => {
    renderHook(() => useProxmox(SESSION_ID));
    await act(async () => {});
    const containers = useProxmoxStore.getState().containers.get(SESSION_ID);
    expect(containers).toHaveLength(1);
    expect(containers![0]!.vmid).toBe(100);
  });

  it("sets availability=true when pct is available", async () => {
    renderHook(() => useProxmox(SESSION_ID));
    await act(async () => {});
    expect(useProxmoxStore.getState().availability.get(SESSION_ID)).toBe(true);
  });

  it("sets availability=false when pctUnavailable=true", async () => {
    mockTauriInvoke.mockResolvedValue({
      containers: [],
      pctUnavailable: true,
    });
    renderHook(() => useProxmox(SESSION_ID));
    await act(async () => {});
    expect(useProxmoxStore.getState().availability.get(SESSION_ID)).toBe(false);
  });

  it("sets loading=false after fetch completes", async () => {
    renderHook(() => useProxmox(SESSION_ID));
    await act(async () => {});
    expect(useProxmoxStore.getState().loading.get(SESSION_ID)).toBe(false);
  });

  it("does not call proxmox_list_lxc when sessionId is empty", async () => {
    renderHook(() => useProxmox(""));
    await act(async () => {});
    expect(mockTauriInvoke).not.toHaveBeenCalledWith(
      "proxmox_list_lxc",
      expect.anything(),
    );
  });

  it("refresh re-fetches containers", async () => {
    const { result } = renderHook(() => useProxmox(SESSION_ID));
    await act(async () => {});
    mockTauriInvoke.mockClear();
    await act(async () => {
      result.current.refresh();
    });
    await act(async () => {});
    expect(mockTauriInvoke).toHaveBeenCalledWith(
      "proxmox_list_lxc",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });
});
