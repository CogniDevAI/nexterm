// features/tunnel/TunnelRow.tsx — Single tunnel row with status and controls
//
// Shows: type icon (-L/-R), bind:port -> target:port, status badge,
// active connections count, start/stop toggle, delete button.

import { useCallback } from "react";
import { useI18n } from "../../lib/i18n";
import type { TunnelInfo, TunnelId } from "../../lib/types";
import {
  getTunnelStateLabel,
  getTunnelStateIndicator,
  getActiveConnections,
  getTunnelErrorMessage,
} from "./tunnel.types";

interface TunnelRowProps {
  tunnel: TunnelInfo;
  onStart: (tunnelId: TunnelId) => void;
  onStop: (tunnelId: TunnelId) => void;
  onDelete: (tunnelId: TunnelId) => void;
}

/** Format bytes as human-readable */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function TunnelRow({ tunnel, onStart, onStop, onDelete }: TunnelRowProps) {
  const { t } = useI18n();
  const { config, state, bytesIn, bytesOut } = tunnel;
  const isLocal = config.tunnelType === "local";
  const stateLabel = getTunnelStateLabel(state);
  const indicatorClass = getTunnelStateIndicator(state);
  const connections = getActiveConnections(state);
  const errorMsg = getTunnelErrorMessage(state);
  const isActive = typeof state === "object" && "active" in state;
  const isStarting = state === "starting";

  const handleToggle = useCallback(() => {
    if (isActive || isStarting) {
      onStop(config.id);
    } else {
      onStart(config.id);
    }
  }, [isActive, isStarting, config.id, onStart, onStop]);

  const handleDelete = useCallback(() => {
    onDelete(config.id);
  }, [config.id, onDelete]);

  return (
    <div className={`tunnel-row ${errorMsg ? "tunnel-row-error" : ""}`}>
      {/* Type badge */}
      <div className="tunnel-type-badge" title={isLocal ? t("tunnel.localForward") : t("tunnel.remoteForward")}>
        {isLocal ? "-L" : "-R"}
      </div>

      {/* Tunnel info */}
      <div className="tunnel-info">
        <div className="tunnel-route">
          {config.label && (
            <span className="tunnel-label">{config.label}</span>
          )}
          <span className="tunnel-endpoints">
            <span className="tunnel-endpoint">
              {config.bindHost}:{config.bindPort}
            </span>
            <span className="tunnel-arrow">{isLocal ? "\u2192" : "\u2190"}</span>
            <span className="tunnel-endpoint">
              {config.targetHost}:{config.targetPort}
            </span>
          </span>
        </div>

        {/* Status row */}
        <div className="tunnel-status-row">
          <span className={`indicator ${indicatorClass}`} />
          <span className="tunnel-state-label">{stateLabel}</span>
          {connections > 0 && (
            <span className="tunnel-connections">
              {connections} conn{connections !== 1 ? "s" : ""}
            </span>
          )}
          {(bytesIn > 0 || bytesOut > 0) && (
            <span className="tunnel-traffic">
              {"\u2191"}{formatBytes(bytesOut)} {"\u2193"}{formatBytes(bytesIn)}
            </span>
          )}
        </div>

        {/* Error message */}
        {errorMsg && (
          <div className="tunnel-error-msg">{errorMsg}</div>
        )}
      </div>

      {/* Actions */}
      <div className="tunnel-actions">
        <button
          className={`btn btn-sm ${isActive || isStarting ? "btn-secondary" : "btn-primary"}`}
          onClick={handleToggle}
          disabled={isStarting}
          title={isActive || isStarting ? t("tunnel.stopTitle") : t("tunnel.startTitle")}
        >
          {isActive || isStarting ? t("tunnel.stop") : t("tunnel.start")}
        </button>
        <button
          className="btn btn-sm btn-ghost tunnel-delete-btn"
          onClick={handleDelete}
          title={t("tunnel.deleteTitle")}
          disabled={isStarting}
        >
          {"\u00D7"}
        </button>
      </div>
    </div>
  );
}
