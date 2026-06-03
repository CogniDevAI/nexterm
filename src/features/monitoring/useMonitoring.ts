// features/monitoring/useMonitoring.ts — Monitoring hook
//
// Lifecycle:
//   - On mount (and when sessionId changes): call start_monitoring + subscribe Channel
//   - On unmount (or sessionId change): call stop_monitoring + clean up
//
// Event handling:
//   - MetricEvent.Sample → addSample to monitoringStore
//   - MetricEvent.Unsupported → setUnsupported, stop further sampling
//   - MetricEvent.Error → logged, sampler continues

import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tauriInvoke } from "../../lib/tauri";
import { useMonitoringStore } from "../../stores/monitoringStore";
import type { MetricSample } from "../../stores/monitoringStore";

// ─── MetricEvent (matches Rust #[serde(tag="event", content="data")] enum) ───

type MetricEvent =
  | { event: "sample"; data: MetricSample }
  | { event: "unsupported"; data: null }
  | { event: "error"; data: { message: string } };

// ─── Hook ────────────────────────────────────────────────────────────────────

/** Default sampling interval in seconds. */
const DEFAULT_INTERVAL_SECS = 3;

/**
 * Start/stop monitoring for a session.
 *
 * Call this from a panel that shows monitoring data. The hook:
 *   - Starts the sampler when mounted
 *   - Stops the sampler when unmounted or when sessionId changes
 *   - Dispatches samples to monitoringStore
 *
 * @param sessionId - Active session ID, or empty string to skip.
 * @param intervalSecs - Sampling interval (default 3 s).
 */
export function useMonitoring(
  sessionId: string,
  intervalSecs: number = DEFAULT_INTERVAL_SECS,
) {
  const { addSample, setUnsupported, setSupported, setRunning } =
    useMonitoringStore();
  // Track whether we've started so stop is idempotent.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    const channel = new Channel<MetricEvent>();

    channel.onmessage = (event: MetricEvent) => {
      if (event.event === "sample") {
        setSupported(sessionId);
        addSample(event.data);
      } else if (event.event === "unsupported") {
        setUnsupported(sessionId);
        setRunning(sessionId, false);
      }
      // "error" events are transient — the sampler continues.
    };

    setRunning(sessionId, true);
    startedRef.current = true;

    tauriInvoke("start_monitoring", {
      sessionId,
      intervalSecs,
      onEvent: channel,
    }).catch((err: unknown) => {
      console.error("[useMonitoring] start_monitoring failed:", err);
      setRunning(sessionId, false);
    });

    return () => {
      if (startedRef.current) {
        startedRef.current = false;
        setRunning(sessionId, false);
        tauriInvoke("stop_monitoring", { sessionId }).catch((err: unknown) => {
          console.error("[useMonitoring] stop_monitoring failed:", err);
        });
      }
    };
  }, [sessionId, intervalSecs, addSample, setUnsupported, setSupported, setRunning]);
}
