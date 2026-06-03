// features/docker/useDocker.test.ts — TDD: docker hook lifecycle

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

import { useDockerStore } from "../../stores/dockerStore";

function resetDockerStore() {
  useDockerStore.setState({
    containers: new Map(),
    availability: new Map(),
    loading: new Map(),
  });
}

// ── Hook import (after mocks) ──────────────────────────────────────────────────

import { useDocker } from "./useDocker";

const SESSION_ID = "test-session-docker-1";

function makeListResult(available = true) {
  return {
    containers: [
      {
        id: "abc123",
        names: "myapp",
        image: "nginx",
        state: "running",
        status: "Up 1h",
        ports: "",
      },
    ],
    dockerUnavailable: !available,
  };
}

describe("useDocker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDockerStore();
    mockTauriInvoke.mockResolvedValue(makeListResult());
  });

  it("calls docker_list_containers on mount", async () => {
    renderHook(() => useDocker(SESSION_ID));
    await act(async () => {});
    expect(mockTauriInvoke).toHaveBeenCalledWith(
      "docker_list_containers",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("populates store with containers after mount", async () => {
    renderHook(() => useDocker(SESSION_ID));
    await act(async () => {});
    const containers = useDockerStore.getState().containers.get(SESSION_ID);
    expect(containers).toHaveLength(1);
    expect(containers![0]!.id).toBe("abc123");
  });

  it("sets availability=true when docker is available", async () => {
    renderHook(() => useDocker(SESSION_ID));
    await act(async () => {});
    expect(useDockerStore.getState().availability.get(SESSION_ID)).toBe(true);
  });

  it("sets availability=false when dockerUnavailable=true", async () => {
    mockTauriInvoke.mockResolvedValue({
      containers: [],
      dockerUnavailable: true,
    });
    renderHook(() => useDocker(SESSION_ID));
    await act(async () => {});
    expect(useDockerStore.getState().availability.get(SESSION_ID)).toBe(false);
  });

  it("sets loading=false after fetch completes", async () => {
    renderHook(() => useDocker(SESSION_ID));
    await act(async () => {});
    expect(useDockerStore.getState().loading.get(SESSION_ID)).toBe(false);
  });

  it("does not call docker_list_containers when sessionId is empty", async () => {
    renderHook(() => useDocker(""));
    await act(async () => {});
    expect(mockTauriInvoke).not.toHaveBeenCalledWith(
      "docker_list_containers",
      expect.anything(),
    );
  });

  it("refresh re-fetches containers", async () => {
    const { result } = renderHook(() => useDocker(SESSION_ID));
    await act(async () => {});
    mockTauriInvoke.mockClear();
    await act(async () => {
      result.current.refresh();
    });
    await act(async () => {});
    expect(mockTauriInvoke).toHaveBeenCalledWith(
      "docker_list_containers",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });
});
