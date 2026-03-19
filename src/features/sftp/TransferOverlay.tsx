// features/sftp/TransferOverlay.tsx — Floating panel showing active/completed transfers
//
// Collapsible panel at bottom of SFTP browser with progress bars,
// speed estimation, cancel buttons.

import { useEffect, useRef, useState } from "react";
import { useTransferStore } from "../../stores/transferStore";
import { useI18n } from "../../lib/i18n";
import type { SessionId, TransferProgress } from "../../lib/types";

interface TransferOverlayProps {
  sessionId: SessionId;
}

// ─── Utilities ──────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + "/s";
}

// ─── Transfer Row ───────────────────────────────────────

function TransferRow({
  transfer,
  speed,
  sessionId,
}: {
  transfer: TransferProgress;
  speed: number;
  sessionId: SessionId;
}) {
  const { t } = useI18n();
  const { cancelTransfer, removeTransfer } = useTransferStore();
  const percentage = transfer.totalBytes > 0
    ? Math.round((transfer.bytesTransferred / transfer.totalBytes) * 100)
    : 0;

  const dirIcon = transfer.direction === "upload" ? "\u2B06" : "\u2B07";

  const statusIcon =
    transfer.status === "completed"
      ? "\u2705"
      : transfer.status === "failed"
        ? "\u274C"
        : transfer.status === "cancelled"
          ? "\u{1F6AB}"
          : null;

  return (
    <div className={`transfer-row transfer-${transfer.status}`}>
      <div className="transfer-info">
        <span className="transfer-direction">{dirIcon}</span>
        <span className="transfer-name" title={transfer.fileName}>
          {transfer.fileName}
        </span>
        {statusIcon && <span className="transfer-status-icon">{statusIcon}</span>}
      </div>

      {transfer.status === "active" && (
        <>
          <div className="transfer-progress-bar">
            <div
              className="transfer-progress-fill"
              style={{ width: `${percentage}%` }}
            />
          </div>
          <div className="transfer-meta">
            <span>
              {formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.totalBytes)}
            </span>
            <span>{percentage}%</span>
            {speed > 0 && <span>{formatSpeed(speed)}</span>}
          </div>
        </>
      )}

      {transfer.status === "failed" && transfer.error && (
        <div className="transfer-error">{transfer.error}</div>
      )}

      <div className="transfer-actions">
        {transfer.status === "active" && (
          <button
            className="sftp-icon-btn transfer-cancel-btn"
            onClick={() => void cancelTransfer(transfer.id, sessionId)}
            title={t("transfer.cancel")}
          >
            {"\u2716"}
          </button>
        )}
        {transfer.status !== "active" && (
          <button
            className="sftp-icon-btn"
            onClick={() => removeTransfer(transfer.id)}
            title={t("transfer.remove")}
          >
            {"\u2716"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────

export function TransferOverlay({ sessionId }: TransferOverlayProps) {
  const { t } = useI18n();
  const { transfers, clearCompleted } = useTransferStore();
  const [collapsed, setCollapsed] = useState(false);

  // Speed calculation — track bytes at intervals
  const [speeds, setSpeeds] = useState<Map<string, number>>(new Map());
  const prevBytesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const interval = setInterval(() => {
      const newSpeeds = new Map<string, number>();
      for (const [id, tr] of transfers) {
        if (tr.status !== "active") continue;
        const prevBytes = prevBytesRef.current.get(id) ?? 0;
        const speed = tr.bytesTransferred - prevBytes; // bytes per second (1s interval)
        newSpeeds.set(id, speed);
        prevBytesRef.current.set(id, tr.bytesTransferred);
      }
      setSpeeds(newSpeeds);
    }, 1000);

    return () => clearInterval(interval);
  }, [transfers]);

  const transferList = Array.from(transfers.values());
  if (transferList.length === 0) return null;

  const activeCount = transferList.filter((tr) => tr.status === "active").length;
  const completedCount = transferList.filter(
    (tr) => tr.status === "completed" || tr.status === "cancelled" || tr.status === "failed",
  ).length;

  return (
    <div className={`transfer-overlay ${collapsed ? "transfer-overlay-collapsed" : ""}`}>
      {/* Header — always visible */}
      <div className="transfer-overlay-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="transfer-overlay-title">
          {t("transfer.title")}
          {activeCount > 0 && (
            <span className="transfer-badge">{activeCount}</span>
          )}
        </span>
        <div className="transfer-overlay-actions">
          {completedCount > 0 && (
            <button
              className="sftp-icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                clearCompleted();
              }}
              title={t("transfer.clearCompleted")}
            >
              {t("transfer.clear")}
            </button>
          )}
          <button className="sftp-icon-btn" title={collapsed ? "Expand" : "Collapse"}>
            {collapsed ? "\u25B2" : "\u25BC"}
          </button>
        </div>
      </div>

      {/* Transfer list — hidden when collapsed */}
      {!collapsed && (
        <div className="transfer-overlay-body">
          {transferList.map((transfer) => (
            <TransferRow
              key={transfer.id}
              transfer={transfer}
              speed={speeds.get(transfer.id) ?? 0}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
