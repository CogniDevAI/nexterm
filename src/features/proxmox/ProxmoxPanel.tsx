// features/proxmox/ProxmoxPanel.tsx — Proxmox LXC management panel
//
// Renders:
//   - LXC table with VMID, name, status badges, and per-row action buttons
//   - Lifecycle actions: start / stop / reboot
//   - Interactive shell: pct enter <vmid> via write_terminal (mirrors DockerPanel)
//   - Snapshot sub-view per row: list / create / rollback (confirm) / delete (confirm)
//   - SnapshotConfirmDialog for destructive rollback + delete
//   - "pct not available" state (permissions or not a Proxmox host)
//   - Refresh button in the header area
//
// Shell injection uses the validated VMID (numeric string), never the name.
// Mirrors DockerPanel.handleShell / buildDockerExecCommand exactly.

import React, { useState } from "react";

import { useI18n } from "../../lib/i18n";
import { tauriInvoke } from "../../lib/tauri";
import { useProxmoxStore, snapshotKey } from "../../stores/proxmoxStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useProxmox } from "./useProxmox";
import { SnapshotConfirmDialog } from "./SnapshotConfirmDialog";
import type { LxcRow, SnapshotRow } from "../../stores/proxmoxStore";

// ─── Types ───────────────────────────────────────────────────────────────────

type SnapshotConfirmState = {
  vmid: number;
  action: "rollback" | "delete";
  snapshotName: string;
} | null;

// ─── Status badge ─────────────────────────────────────────────────────────────

function statusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
      return "proxmox-status-badge--running";
    case "stopped":
      return "proxmox-status-badge--stopped";
    case "paused":
      return "proxmox-status-badge--paused";
    default:
      return "proxmox-status-badge--unknown";
  }
}

// ─── RefreshIcon ─────────────────────────────────────────────────────────────

function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.5 2.5A6.5 6.5 0 1 1 4.5 14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <polyline
        points="4,10 4,14 0,14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// ─── Shell command helper ─────────────────────────────────────────────────────

/**
 * Build the `pct enter <vmid>` command string for the interactive shell action.
 * Accepts the validated VMID string (NOT the container name) so a future
 * refactor cannot accidentally swap the arguments without breaking the test.
 *
 * The trailing `\n` submits the command to the PTY.
 */
export function buildPctEnterCommand(vmid: string): string {
  return `pct enter ${vmid}\n`;
}

// ─── SnapshotSubView ─────────────────────────────────────────────────────────

interface SnapshotSubViewProps {
  sessionId: string;
  container: LxcRow;
  onClose: () => void;
}

function SnapshotSubView({ sessionId, container, onClose }: SnapshotSubViewProps) {
  const { t } = useI18n();
  const [newSnapName, setNewSnapName] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<SnapshotConfirmState>(null);

  const key = snapshotKey(sessionId, container.vmid);
  const setSnapshots = useProxmoxStore((s) => s.setSnapshots);
  const snapshotsOrUndef = useProxmoxStore((s) => s.snapshots.get(key));
  const snapshots: SnapshotRow[] = snapshotsOrUndef ?? [];

  async function loadSnapshots() {
    try {
      const result = await tauriInvoke<{ snapshots: SnapshotRow[] }>(
        "proxmox_list_snapshots",
        { sessionId, vmid: String(container.vmid) },
      );
      setSnapshots(sessionId, container.vmid, result.snapshots);
    } catch (err) {
      console.error("[ProxmoxPanel] proxmox_list_snapshots failed:", err);
    }
  }

  async function handleCreate() {
    const name = newSnapName.trim();
    if (!name) return;
    setCreating(true);
    setActionError(null);
    try {
      await tauriInvoke("proxmox_create_snapshot", {
        sessionId,
        vmid: String(container.vmid),
        snapshotName: name,
      });
      setNewSnapName("");
      await loadSnapshots();
    } catch (err) {
      setActionError(typeof err === "string" ? err : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRollback(snapshotName: string) {
    setConfirmState(null);
    setActionError(null);
    try {
      await tauriInvoke("proxmox_rollback_snapshot", {
        sessionId,
        vmid: String(container.vmid),
        snapshotName,
      });
      await loadSnapshots();
    } catch (err) {
      setActionError(typeof err === "string" ? err : String(err));
    }
  }

  async function handleDelete(snapshotName: string) {
    setConfirmState(null);
    setActionError(null);
    try {
      await tauriInvoke("proxmox_delete_snapshot", {
        sessionId,
        vmid: String(container.vmid),
        snapshotName,
      });
      await loadSnapshots();
    } catch (err) {
      setActionError(typeof err === "string" ? err : String(err));
    }
  }

  return (
    <tr>
      <td
        colSpan={4}
        className="proxmox-snapshot-subview"
        aria-label={`${t("proxmox.snapshot.title")}: ${container.name}`}
      >
        <div className="proxmox-snapshot-header">
          <span className="proxmox-snapshot-title">
            {t("proxmox.snapshot.title")}: <strong>{container.name}</strong>
          </span>
          <button
            type="button"
            className="proxmox-snapshot-close-btn"
            onClick={onClose}
            aria-label={t("proxmox.snapshot.close")}
          >
            ✕
          </button>
        </div>
        {actionError && (
          <div className="proxmox-action-error" role="alert">
            {actionError}
          </div>
        )}
        {snapshots.length === 0 ? (
          <div className="proxmox-snapshot-empty" role="status">
            {t("proxmox.snapshot.empty")}
          </div>
        ) : (
          <ul className="proxmox-snapshot-list">
            {snapshots.map((snap) =>
              confirmState?.snapshotName === snap.name ? (
                <li key={snap.name} className="proxmox-snapshot-item">
                  <span className="proxmox-snapshot-item-name">{snap.name}</span>
                  <SnapshotConfirmDialog
                    action={confirmState.action}
                    snapshotName={snap.name}
                    onConfirm={
                      confirmState.action === "rollback"
                        ? handleRollback
                        : handleDelete
                    }
                    onCancel={() => setConfirmState(null)}
                  />
                </li>
              ) : (
                <li key={snap.name} className="proxmox-snapshot-item">
                  <span className="proxmox-snapshot-item-name">{snap.name}</span>
                  <div className="proxmox-snapshot-actions">
                    <button
                      type="button"
                      className="proxmox-action-btn"
                      onClick={() =>
                        setConfirmState({
                          vmid: container.vmid,
                          action: "rollback",
                          snapshotName: snap.name,
                        })
                      }
                      aria-label={`Rollback to ${snap.name}`}
                    >
                      {t("proxmox.snapshot.rollback.arm")}
                    </button>
                    <button
                      type="button"
                      className="proxmox-action-btn proxmox-action-btn--danger"
                      onClick={() =>
                        setConfirmState({
                          vmid: container.vmid,
                          action: "delete",
                          snapshotName: snap.name,
                        })
                      }
                      aria-label={`Delete snapshot ${snap.name}`}
                    >
                      {t("proxmox.snapshot.delete.arm")}
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
        {/* Create snapshot */}
        <div className="proxmox-snapshot-create">
          <input
            type="text"
            className="proxmox-snapshot-create-input"
            value={newSnapName}
            onChange={(e) => setNewSnapName(e.target.value)}
            placeholder={t("proxmox.snapshot.create.label")}
            aria-label={t("proxmox.snapshot.create.label")}
            maxLength={40}
          />
          <button
            type="button"
            className="proxmox-action-btn"
            onClick={handleCreate}
            disabled={creating || !newSnapName.trim()}
            aria-label={t("proxmox.snapshot.create.btn")}
          >
            {t("proxmox.snapshot.create.btn")}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── ProxmoxPanel ─────────────────────────────────────────────────────────────

interface ProxmoxPanelProps {
  sessionId: string;
}

export function ProxmoxPanel({ sessionId }: ProxmoxPanelProps) {
  const { t } = useI18n();
  const { refresh } = useProxmox(sessionId);

  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedVmid, setExpandedVmid] = useState<number | null>(null);

  const containersOrUndef = useProxmoxStore((s) =>
    s.containers.get(sessionId),
  );
  const containers: LxcRow[] = containersOrUndef ?? [];
  const availability = useProxmoxStore((s) => s.availability.get(sessionId));
  const loading = useProxmoxStore(
    (s) => s.loading.get(sessionId) ?? false,
  );

  // ── pct not available ────────────────────────────────────────────────────

  if (availability === false) {
    return (
      <div className="proxmox-panel proxmox-unavailable" role="status">
        {t("proxmox.unavailable")}
      </div>
    );
  }

  // ── initial loading ──────────────────────────────────────────────────────

  if (availability === undefined && loading) {
    return (
      <div className="proxmox-panel proxmox-loading" role="status">
        {t("proxmox.loading")}
      </div>
    );
  }

  // ── Lifecycle action handler ─────────────────────────────────────────────

  async function handleLifecycle(
    vmid: number,
    action: "start" | "stop" | "reboot",
  ) {
    setActionError(null);
    try {
      await tauriInvoke("proxmox_lifecycle_action", {
        sessionId,
        vmid: String(vmid),
        action,
      });
      void refresh();
    } catch (err) {
      console.error(`[ProxmoxPanel] ${action} failed:`, err);
      setActionError(typeof err === "string" ? err : String(err));
    }
  }

  // ── Interactive shell handler — mirrors DockerPanel.handleShell ──────────

  async function handleShell(container: LxcRow) {
    const isReady = (id: string | null | undefined): id is string =>
      !!id && !id.startsWith("pending-");

    let terminalId =
      useSessionStore.getState().sessions.get(sessionId)?.activeTerminalId;

    for (let i = 0; i < 50 && !isReady(terminalId); i++) {
      await new Promise((r) => setTimeout(r, 100));
      terminalId =
        useSessionStore.getState().sessions.get(sessionId)?.activeTerminalId;
    }

    if (!isReady(terminalId)) {
      console.warn("[ProxmoxPanel] No ready terminal for shell injection");
      return;
    }

    // Use the validated numeric vmid (from the LxcRow), never the name.
    const cmd = buildPctEnterCommand(String(container.vmid));
    try {
      await tauriInvoke("write_terminal", {
        sessionId,
        terminalId,
        data: Array.from(new TextEncoder().encode(cmd)),
      });
    } catch (err) {
      console.error("[ProxmoxPanel] write_terminal failed:", err);
    }
  }

  // ── Snapshot sub-view toggle ─────────────────────────────────────────────

  async function handleSnapshotsToggle(container: LxcRow) {
    if (expandedVmid === container.vmid) {
      setExpandedVmid(null);
      return;
    }
    setExpandedVmid(container.vmid);
    // Load snapshots on expand.
    try {
      const result = await tauriInvoke<{ snapshots: SnapshotRow[] }>(
        "proxmox_list_snapshots",
        { sessionId, vmid: String(container.vmid) },
      );
      useProxmoxStore
        .getState()
        .setSnapshots(sessionId, container.vmid, result.snapshots);
    } catch (err) {
      console.error("[ProxmoxPanel] proxmox_list_snapshots failed:", err);
    }
  }

  // ── Container table ───────────────────────────────────────────────────────

  return (
    <div className="proxmox-panel">
      {/* Header: refresh + optional error */}
      <div className="proxmox-panel-header">
        <button
          type="button"
          className="proxmox-refresh-btn"
          onClick={refresh}
          aria-label={t("proxmox.refresh")}
          title={t("proxmox.refresh")}
          disabled={loading}
        >
          <RefreshIcon />
        </button>
        {actionError && (
          <span className="proxmox-action-error" role="alert">
            {actionError}
          </span>
        )}
      </div>

      {/* Empty state */}
      {containers.length === 0 && !loading && (
        <div className="proxmox-empty" role="status">
          {t("proxmox.empty")}
        </div>
      )}

      {/* LXC table */}
      {containers.length > 0 && (
        <section
          className="proxmox-containers"
          aria-label={t("proxmox.col.name")}
        >
          <table className="proxmox-container-table">
            <thead>
              <tr>
                <th scope="col">{t("proxmox.col.vmid")}</th>
                <th scope="col">{t("proxmox.col.name")}</th>
                <th scope="col">{t("proxmox.col.status")}</th>
                <th scope="col">{t("proxmox.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <React.Fragment key={c.vmid}>
                  <tr>
                    <td className="proxmox-container-vmid">{c.vmid}</td>
                    <td className="proxmox-container-name">{c.name}</td>
                    <td>
                      <span
                        className={`proxmox-status-badge ${statusBadgeClass(c.status)}`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="proxmox-container-actions">
                      <div className="proxmox-action-group">
                        {/* Start — only for non-running */}
                        {c.status !== "running" && (
                          <button
                            type="button"
                            className="proxmox-action-btn"
                            onClick={() => handleLifecycle(c.vmid, "start")}
                            aria-label={`${t("proxmox.action.start")} ${c.name}`}
                          >
                            {t("proxmox.action.start")}
                          </button>
                        )}
                        {/* Stop — only for running */}
                        {c.status === "running" && (
                          <button
                            type="button"
                            className="proxmox-action-btn"
                            onClick={() => handleLifecycle(c.vmid, "stop")}
                            aria-label={`${t("proxmox.action.stop")} ${c.name}`}
                          >
                            {t("proxmox.action.stop")}
                          </button>
                        )}
                        {/* Reboot — always shown */}
                        <button
                          type="button"
                          className="proxmox-action-btn"
                          onClick={() => handleLifecycle(c.vmid, "reboot")}
                          aria-label={`${t("proxmox.action.reboot")} ${c.name}`}
                        >
                          {t("proxmox.action.reboot")}
                        </button>
                        {/* Shell — only for running */}
                        {c.status === "running" && (
                          <button
                            type="button"
                            className="proxmox-action-btn"
                            onClick={() => handleShell(c)}
                            aria-label={`${t("proxmox.action.shell")} ${c.name}`}
                          >
                            {t("proxmox.action.shell")}
                          </button>
                        )}
                        {/* Snapshots toggle */}
                        <button
                          type="button"
                          className={`proxmox-action-btn${expandedVmid === c.vmid ? " proxmox-action-btn--active" : ""}`}
                          onClick={() => handleSnapshotsToggle(c)}
                          aria-label={`${t("proxmox.action.snapshots")} ${c.name}`}
                          aria-expanded={expandedVmid === c.vmid}
                        >
                          {t("proxmox.action.snapshots")}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {/* Snapshot sub-view — inline row below the container row */}
                  {expandedVmid === c.vmid && (
                    <SnapshotSubView
                      key={`snap-${c.vmid}`}
                      sessionId={sessionId}
                      container={c}
                      onClose={() => setExpandedVmid(null)}
                    />
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
