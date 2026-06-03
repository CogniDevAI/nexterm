// features/monitoring/MonitoringPanel.tsx — Live remote system monitoring panel
//
// Renders:
//   - CPU / RAM / Net sparklines with current value badges
//   - Disk usage bars for each filesystem
//   - Process table (top 20 by CPU) with two-step kill
//
// Starts the sampler on mount (useMonitoring hook) and stops on unmount.
// tick=0 shows "—" for delta-based fields (CPU%, net bps) — no value on first tick.

import { useI18n } from "../../lib/i18n";
import { useMonitoringStore } from "../../stores/monitoringStore";
import { useMonitoring } from "./useMonitoring";
import { Sparkline } from "./Sparkline";
import { KillConfirmDialog } from "./KillConfirmDialog";
import { tauriInvoke } from "../../lib/tauri";
import { useState } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBps(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

// ─── MonitoringPanel ────────────────────────────────────────────────────────

interface MonitoringPanelProps {
  sessionId: string;
}

export function MonitoringPanel({ sessionId }: MonitoringPanelProps) {
  const { t } = useI18n();
  const [killingPid, setKillingPid] = useState<number | null>(null);

  // Start/stop sampler on mount/unmount.
  useMonitoring(sessionId);

  const samplesOrUndef = useMonitoringStore((s) => s.samples.get(sessionId));
  const samples = samplesOrUndef ?? [];
  const isSupported = useMonitoringStore((s) => s.isSupported.get(sessionId));

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const isFirstTick = latest?.tick === 0;

  // Build sparkline value arrays.
  const cpuValues = samples.map((s) => s.cpuPct);
  const ramValues = samples.map((s) => s.memPct);
  const rxValues = samples.map((s) => s.netRxBps);
  const txValues = samples.map((s) => s.netTxBps);

  async function handleKill(pid: number) {
    setKillingPid(null);
    try {
      await tauriInvoke("kill_remote_process", {
        sessionId,
        pid,
        signal: "term",
      });
    } catch (err) {
      console.error("[MonitoringPanel] kill failed:", err);
    }
  }

  // ── /proc absent ────────────────────────────────────────────────────────
  if (isSupported === false) {
    return (
      <div className="monitoring-panel monitoring-unsupported" role="status">
        {t("monitoring.unsupported")}
      </div>
    );
  }

  // ── Loading / first tick ────────────────────────────────────────────────
  if (samples.length === 0) {
    return (
      <div className="monitoring-panel monitoring-loading" role="status">
        {t("monitoring.loading")}
      </div>
    );
  }

  return (
    <div className="monitoring-panel">
      {/* ── Metrics grid ─────────────────────────────────────────────────── */}
      <div className="monitoring-metrics-grid">
        {/* CPU */}
        <div className="monitoring-metric">
          <span className="monitoring-metric-label">{t("monitoring.cpu")}</span>
          <Sparkline
            values={cpuValues}
            label={t("monitoring.cpu")}
            unit="%"
            width={80}
            height={24}
          />
          <span className="monitoring-metric-value">
            {isFirstTick ? t("monitoring.firstTick") : `${latest!.cpuPct.toFixed(1)}%`}
          </span>
        </div>

        {/* RAM */}
        <div className="monitoring-metric">
          <span className="monitoring-metric-label">{t("monitoring.ram")}</span>
          <Sparkline
            values={ramValues}
            label={t("monitoring.ram")}
            unit="%"
            width={80}
            height={24}
          />
          <span className="monitoring-metric-value">
            {latest ? `${latest.memPct.toFixed(1)}%` : t("monitoring.firstTick")}
          </span>
        </div>

        {/* Net RX */}
        <div className="monitoring-metric">
          <span className="monitoring-metric-label">{t("monitoring.net.rx")}</span>
          <Sparkline
            values={rxValues}
            label={t("monitoring.net.rx")}
            unit="bps"
            width={80}
            height={24}
          />
          <span className="monitoring-metric-value">
            {isFirstTick ? t("monitoring.firstTick") : formatBps(latest!.netRxBps)}
          </span>
        </div>

        {/* Net TX */}
        <div className="monitoring-metric">
          <span className="monitoring-metric-label">{t("monitoring.net.tx")}</span>
          <Sparkline
            values={txValues}
            label={t("monitoring.net.tx")}
            unit="bps"
            width={80}
            height={24}
          />
          <span className="monitoring-metric-value">
            {isFirstTick ? t("monitoring.firstTick") : formatBps(latest!.netTxBps)}
          </span>
        </div>
      </div>

      {/* ── Disk bars ────────────────────────────────────────────────────── */}
      {latest && latest.diskEntries.length > 0 && (
        <section className="monitoring-disk" aria-label={t("monitoring.disk")}>
          <h3 className="monitoring-section-title">{t("monitoring.disk")}</h3>
          {latest.diskEntries.map((d) => (
            <div key={d.filesystem} className="monitoring-disk-row">
              <span className="monitoring-disk-fs">{d.filesystem}</span>
              <div
                className="monitoring-disk-bar-track"
                role="progressbar"
                aria-valuenow={d.usedPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${d.filesystem}: ${d.usedPct}%`}
              >
                <div
                  className={`monitoring-disk-bar-fill${
                    d.usedPct >= 95
                      ? " monitoring-disk-bar-fill--critical"
                      : d.usedPct >= 80
                        ? " monitoring-disk-bar-fill--warning"
                        : ""
                  }`}
                  style={{ width: `${d.usedPct}%` }}
                />
              </div>
              <span className="monitoring-disk-pct">{d.usedPct}%</span>
            </div>
          ))}
        </section>
      )}

      {/* ── Process table ────────────────────────────────────────────────── */}
      {latest && latest.processes.length > 0 && (
        <section className="monitoring-processes" aria-label={t("monitoring.processes")}>
          <h3 className="monitoring-section-title">{t("monitoring.processes")}</h3>
          <table className="monitoring-process-table">
            <thead>
              <tr>
                <th scope="col">{t("monitoring.col.pid")}</th>
                <th scope="col">{t("monitoring.col.user")}</th>
                <th scope="col">{t("monitoring.col.cpu")}</th>
                <th scope="col">{t("monitoring.col.mem")}</th>
                <th scope="col">{t("monitoring.col.name")}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {latest.processes.map((p) => (
                <tr key={p.pid}>
                  <td>{p.pid}</td>
                  <td>{p.user}</td>
                  <td>{p.cpuPct.toFixed(1)}</td>
                  <td>{p.memPct.toFixed(1)}</td>
                  <td className="monitoring-process-name">{p.name}</td>
                  <td>
                    {killingPid === p.pid ? (
                      <KillConfirmDialog
                        pid={p.pid}
                        onKill={handleKill}
                        onCancel={() => setKillingPid(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="monitoring-kill-arm-btn"
                        onClick={() => setKillingPid(p.pid)}
                        aria-label={`${t("monitoring.kill.arm")} ${p.pid}`}
                      >
                        {t("monitoring.kill.arm")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
