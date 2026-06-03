// features/docker/useDocker.ts — Docker container management hook
//
// Lifecycle:
//   - On mount (and when sessionId changes): call docker_list_containers
//   - Populates dockerStore with containers and availability state
//   - Exposes refresh() for manual re-fetch
//   - Optional 10s poll while the panel is open
//
// Poll is stateless — no background Rust task. Each poll is a new
// docker_list_containers one-shot call.

import { useCallback, useEffect, useRef } from "react";

import { tauriInvoke } from "../../lib/tauri";
import { useDockerStore } from "../../stores/dockerStore";
import type { ContainerRow } from "../../stores/dockerStore";

// ─── Response shape from docker_list_containers ───────────────────────────────

interface ListContainersResult {
  containers: ContainerRow[];
  dockerUnavailable: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Slow poll interval (ms) while the panel is open. */
const POLL_INTERVAL_MS = 10_000;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Load and optionally poll Docker container data for a session.
 *
 * Call from DockerPanel. The hook:
 *   - Fetches on mount
 *   - Sets dockerStore containers + availability
 *   - Polls every 10 s while mounted
 *   - Cleans up on unmount
 *
 * @param sessionId - Active session ID. Pass empty string to skip.
 */
export function useDocker(sessionId: string) {
  const setContainers = useDockerStore((s) => s.setContainers);
  const setAvailability = useDockerStore((s) => s.setAvailability);
  const setLoading = useDockerStore((s) => s.setLoading);

  const mountedRef = useRef(false);

  const fetchContainers = useCallback(async () => {
    if (!sessionId) return;

    setLoading(sessionId, true);
    try {
      const result = await tauriInvoke<ListContainersResult>(
        "docker_list_containers",
        { sessionId },
      );

      if (result.dockerUnavailable) {
        setAvailability(sessionId, false);
        setContainers(sessionId, []);
      } else {
        setAvailability(sessionId, true);
        setContainers(sessionId, result.containers);
      }
    } catch (err) {
      console.error("[useDocker] docker_list_containers failed:", err);
    } finally {
      setLoading(sessionId, false);
    }
  }, [sessionId, setContainers, setAvailability, setLoading]);

  useEffect(() => {
    if (!sessionId) return;

    mountedRef.current = true;
    void fetchContainers();

    const timer = setInterval(() => {
      if (mountedRef.current) {
        void fetchContainers();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [sessionId, fetchContainers]);

  return { refresh: fetchContainers };
}
