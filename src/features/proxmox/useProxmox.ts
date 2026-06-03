// features/proxmox/useProxmox.ts — Proxmox LXC management hook
//
// Lifecycle:
//   - On mount (and when sessionId changes): call proxmox_list_lxc
//   - Populates proxmoxStore with containers and availability state
//   - Exposes refresh() for manual re-fetch
//   - Optional 10s poll while the panel is open
//
// Poll is stateless — no background Rust task. Each poll is a new
// proxmox_list_lxc one-shot call. Mirrors useDocker exactly.

import { useCallback, useEffect, useRef } from "react";

import { tauriInvoke } from "../../lib/tauri";
import { useProxmoxStore } from "../../stores/proxmoxStore";
import type { LxcRow } from "../../stores/proxmoxStore";

// ─── Response shape from proxmox_list_lxc ────────────────────────────────────

interface ListLxcResult {
  containers: LxcRow[];
  pctUnavailable: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Slow poll interval (ms) while the panel is open. */
const POLL_INTERVAL_MS = 10_000;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Load and optionally poll Proxmox LXC data for a session.
 *
 * Call from ProxmoxPanel. The hook:
 *   - Fetches on mount
 *   - Sets proxmoxStore containers + availability
 *   - Polls every 10 s while mounted
 *   - Cleans up on unmount
 *
 * @param sessionId - Active session ID. Pass empty string to skip.
 */
export function useProxmox(sessionId: string) {
  const setLxc = useProxmoxStore((s) => s.setLxc);
  const setAvailability = useProxmoxStore((s) => s.setAvailability);
  const setLoading = useProxmoxStore((s) => s.setLoading);

  const mountedRef = useRef(false);

  const fetchContainers = useCallback(async () => {
    if (!sessionId) return;

    setLoading(sessionId, true);
    try {
      const result = await tauriInvoke<ListLxcResult>("proxmox_list_lxc", {
        sessionId,
      });

      if (result.pctUnavailable) {
        setAvailability(sessionId, false);
        setLxc(sessionId, []);
      } else {
        setAvailability(sessionId, true);
        setLxc(sessionId, result.containers);
      }
    } catch (err) {
      console.error("[useProxmox] proxmox_list_lxc failed:", err);
    } finally {
      setLoading(sessionId, false);
    }
  }, [sessionId, setLxc, setAvailability, setLoading]);

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
