// features/tunnel/TunnelManager.tsx — Tunnel management panel
//
// Lists configured tunnels with TunnelRow components.
// "Add Tunnel" button opens TunnelForm dialog.
// Handles tunnel CRUD and lifecycle via useTunnel hook.

import { useCallback, useState } from "react";
import { useTunnel } from "./useTunnel";
import { TunnelForm } from "./TunnelForm";
import { TunnelRow } from "./TunnelRow";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../lib/i18n";
import type { SessionId } from "../../lib/types";
import type { TunnelFormData } from "./tunnel.types";

interface TunnelManagerProps {
  sessionId: SessionId;
}

export function TunnelManager({ sessionId }: TunnelManagerProps) {
  const { t } = useI18n();
  const {
    tunnels,
    loading,
    error,
    createTunnel,
    startTunnel,
    stopTunnel,
    removeTunnel,
    refreshTunnels,
  } = useTunnel(sessionId);

  const [showForm, setShowForm] = useState(false);

  const handleCreate = useCallback(
    async (data: TunnelFormData) => {
      try {
        await createTunnel({
          tunnelType: data.tunnelType,
          bindHost: data.bindHost,
          bindPort: Number(data.bindPort),
          targetHost: data.targetHost,
          targetPort: Number(data.targetPort),
          label: data.label || undefined,
        });
        setShowForm(false);
      } catch {
        // Error is set in useTunnel hook — form stays open
      }
    },
    [createTunnel],
  );

  return (
    <div className="tunnel-manager">
      {/* Header */}
      <div className="tunnel-header">
        <div className="tunnel-header-left">
          <h3 className="tunnel-title">{t("tunnel.title")}</h3>
          <span className="tunnel-count">
            {tunnels.length} tunnel{tunnels.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="tunnel-header-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshTunnels()}
            title={t("tunnel.refreshTitle")}
          >
            {"\u21BB"}
          </Button>
          <Button
            size="sm"
            onClick={() => setShowForm(true)}
          >
            {t("tunnel.addTunnel")}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="tunnel-error-banner">
          {error}
        </div>
      )}

      {/* Tunnel list */}
      <div className="tunnel-list">
        {loading && tunnels.length === 0 ? (
          <div className="tunnel-empty">
            <Spinner size={20} />
            <span>{t("tunnel.loading")}</span>
          </div>
        ) : tunnels.length === 0 ? (
          <div className="tunnel-empty">
            <p>{t("tunnel.empty")}</p>
            <p className="tunnel-empty-hint">
              {t("tunnel.emptyHint")}
            </p>
          </div>
        ) : (
          tunnels.map((tunnel) => (
            <TunnelRow
              key={tunnel.config.id}
              tunnel={tunnel}
              onStart={startTunnel}
              onStop={stopTunnel}
              onDelete={removeTunnel}
            />
          ))
        )}
      </div>

      {/* Add tunnel dialog */}
      <TunnelForm
        open={showForm}
        onClose={() => setShowForm(false)}
        onSubmit={(data) => void handleCreate(data)}
      />
    </div>
  );
}
