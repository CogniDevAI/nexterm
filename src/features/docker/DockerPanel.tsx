// features/docker/DockerPanel.tsx — Remote Docker container management panel
//
// Renders:
//   - Container table with state badges and per-row action buttons
//   - Logs modal (one-shot tail 200 lines via docker_get_logs)
//   - RmConfirmDialog (two-step confirm for destructive rm)
//   - "Docker not available" state (mirrors MonitoringPanel.Unsupported)
//   - Refresh button in the header area
//
// Interactive shell (docker exec): injects `docker exec -it <id> sh\n` into
// the active terminal PTY via write_terminal. Mirrors runStartupCommands.
//
// Deferred (v2): live log streaming (-f), /bin/bash fallback.

import { useState } from "react";

import { useI18n } from "../../lib/i18n";
import { tauriInvoke } from "../../lib/tauri";
import { useDockerStore } from "../../stores/dockerStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useDocker } from "./useDocker";
import { RmConfirmDialog } from "./RmConfirmDialog";
import type { ContainerRow } from "../../stores/dockerStore";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LogsModalState {
  containerId: string;
  containerName: string;
  logs: string;
  truncated: boolean;
}

// ─── State badge ─────────────────────────────────────────────────────────────

/** Map a docker container state string to a CSS modifier class. */
function stateBadgeClass(state: string): string {
  switch (state.toLowerCase()) {
    case "running":
      return "docker-state-badge--running";
    case "exited":
      return "docker-state-badge--exited";
    case "paused":
      return "docker-state-badge--paused";
    case "created":
    case "restarting":
      return "docker-state-badge--created";
    default:
      return "docker-state-badge--unknown";
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
 * Build the `docker exec -it <id> sh` command string for the interactive shell
 * action. Accepts a validated container **id** (NOT the name) so a future
 * refactor cannot accidentally swap the arguments without breaking the test.
 *
 * The trailing `\n` is intentional — write_terminal expects the newline to
 * submit the command to the PTY just as pressing Enter would.
 */
export function buildDockerExecCommand(id: string): string {
  return `docker exec -it ${id} sh\n`;
}

// ─── DockerPanel ─────────────────────────────────────────────────────────────

interface DockerPanelProps {
  sessionId: string;
}

export function DockerPanel({ sessionId }: DockerPanelProps) {
  const { t } = useI18n();
  const { refresh } = useDocker(sessionId);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [logsModal, setLogsModal] = useState<LogsModalState | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const containersOrUndef = useDockerStore((s) => s.containers.get(sessionId));
  const containers = containersOrUndef ?? [];
  const availability = useDockerStore((s) => s.availability.get(sessionId));
  const loading = useDockerStore((s) => s.loading.get(sessionId) ?? false);

  // ── docker not available ─────────────────────────────────────────────────

  if (availability === false) {
    return (
      <div className="docker-panel docker-unavailable" role="status">
        {t("docker.unavailable")}
      </div>
    );
  }

  // ── initial loading (availability unknown + loading) ─────────────────────

  if (availability === undefined && loading) {
    return (
      <div className="docker-panel docker-loading" role="status">
        {t("docker.loading")}
      </div>
    );
  }

  // ── Lifecycle action handler ──────────────────────────────────────────────

  async function handleLifecycle(
    containerId: string,
    action: "start" | "stop" | "restart",
  ) {
    setActionError(null);
    try {
      await tauriInvoke("docker_lifecycle_action", {
        sessionId,
        containerId,
        action,
      });
      void refresh();
    } catch (err) {
      console.error(`[DockerPanel] ${action} failed:`, err);
      setActionError(typeof err === "string" ? err : String(err));
    }
  }

  // ── Rm handler (called after two-step confirm) ────────────────────────────

  async function handleRm(containerId: string) {
    setRemovingId(null);
    setActionError(null);
    try {
      await tauriInvoke("docker_lifecycle_action", {
        sessionId,
        containerId,
        action: "rm",
      });
      void refresh();
    } catch (err) {
      console.error("[DockerPanel] rm failed:", err);
      setActionError(typeof err === "string" ? err : String(err));
    }
  }

  // ── Logs handler ─────────────────────────────────────────────────────────

  async function handleLogs(container: ContainerRow) {
    setLogsLoading(true);
    try {
      const result = await tauriInvoke<{ logs: string; truncated: boolean }>(
        "docker_get_logs",
        { sessionId, containerId: container.id },
      );
      setLogsModal({
        containerId: container.id,
        containerName: container.names,
        logs: result.logs,
        truncated: result.truncated,
      });
    } catch (err) {
      console.error("[DockerPanel] get_logs failed:", err);
    } finally {
      setLogsLoading(false);
    }
  }

  // ── Interactive shell handler ─────────────────────────────────────────────
  // Mirrors runStartupCommands: poll for a real terminalId, then write_terminal.

  async function handleShell(container: ContainerRow) {
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
      console.warn("[DockerPanel] No ready terminal for shell injection");
      return;
    }

    const cmd = buildDockerExecCommand(container.id);
    try {
      await tauriInvoke("write_terminal", {
        sessionId,
        terminalId,
        data: Array.from(new TextEncoder().encode(cmd)),
      });
    } catch (err) {
      console.error("[DockerPanel] write_terminal failed:", err);
    }
  }

  // ── Container table ───────────────────────────────────────────────────────

  return (
    <div className="docker-panel">
      {/* Header: refresh button + optional error */}
      <div className="docker-panel-header">
        <button
          type="button"
          className="docker-refresh-btn"
          onClick={refresh}
          aria-label={t("docker.refresh")}
          title={t("docker.refresh")}
          disabled={loading}
        >
          <RefreshIcon />
        </button>
        {actionError && (
          <span className="docker-action-error" role="alert">
            {actionError}
          </span>
        )}
      </div>

      {/* Empty state */}
      {containers.length === 0 && !loading && (
        <div className="docker-empty" role="status">
          {t("docker.empty")}
        </div>
      )}

      {/* Container table */}
      {containers.length > 0 && (
        <section
          className="docker-containers"
          aria-label={t("docker.col.name")}
        >
          <table className="docker-container-table">
            <thead>
              <tr>
                <th scope="col">{t("docker.col.name")}</th>
                <th scope="col">{t("docker.col.image")}</th>
                <th scope="col">{t("docker.col.state")}</th>
                <th scope="col">{t("docker.col.status")}</th>
                <th scope="col">{t("docker.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.id}>
                  <td className="docker-container-name">{c.names}</td>
                  <td className="docker-container-image">{c.image}</td>
                  <td>
                    <span
                      className={`docker-state-badge ${stateBadgeClass(c.state)}`}
                    >
                      {c.state}
                    </span>
                  </td>
                  <td className="docker-container-status">{c.status}</td>
                  <td className="docker-container-actions">
                    {removingId === c.id ? (
                      <RmConfirmDialog
                        containerId={c.id}
                        containerName={c.names}
                        onRm={handleRm}
                        onCancel={() => setRemovingId(null)}
                      />
                    ) : (
                      <div className="docker-action-group">
                        {/* Start — only for stopped containers */}
                        {c.state !== "running" && (
                          <button
                            type="button"
                            className="docker-action-btn"
                            onClick={() => handleLifecycle(c.id, "start")}
                            aria-label={`${t("docker.action.start")} ${c.names}`}
                          >
                            {t("docker.action.start")}
                          </button>
                        )}
                        {/* Stop — only for running containers */}
                        {c.state === "running" && (
                          <button
                            type="button"
                            className="docker-action-btn"
                            onClick={() => handleLifecycle(c.id, "stop")}
                            aria-label={`${t("docker.action.stop")} ${c.names}`}
                          >
                            {t("docker.action.stop")}
                          </button>
                        )}
                        {/* Restart — always shown */}
                        <button
                          type="button"
                          className="docker-action-btn"
                          onClick={() => handleLifecycle(c.id, "restart")}
                          aria-label={`${t("docker.action.restart")} ${c.names}`}
                        >
                          {t("docker.action.restart")}
                        </button>
                        {/* Logs */}
                        <button
                          type="button"
                          className="docker-action-btn"
                          onClick={() => handleLogs(c)}
                          disabled={logsLoading}
                          aria-label={`${t("docker.logs.title")} ${c.names}`}
                        >
                          {t("docker.logs.title")}
                        </button>
                        {/* Shell — only for running containers */}
                        {c.state === "running" && (
                          <button
                            type="button"
                            className="docker-action-btn"
                            onClick={() => handleShell(c)}
                            aria-label={`${t("docker.action.shell")} ${c.names}`}
                          >
                            {t("docker.action.shell")}
                          </button>
                        )}
                        {/* Rm (two-step) */}
                        <button
                          type="button"
                          className="docker-action-btn docker-action-btn--rm"
                          onClick={() => setRemovingId(c.id)}
                          aria-label={`${t("docker.action.rm")} ${c.names}`}
                        >
                          {t("docker.action.rm")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Logs modal */}
      {logsModal && (
        <div
          className="docker-logs-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${t("docker.logs.title")}: ${logsModal.containerName}`}
        >
          <div className="docker-logs-modal">
            <div className="docker-logs-modal-header">
              <span className="docker-logs-modal-title">
                {t("docker.logs.title")}: <strong>{logsModal.containerName}</strong>
              </span>
              <button
                type="button"
                className="docker-logs-close-btn"
                onClick={() => setLogsModal(null)}
                aria-label={t("docker.logs.close")}
              >
                ✕
              </button>
            </div>
            {logsModal.truncated && (
              <div className="docker-logs-truncated-banner" role="status">
                {t("docker.logs.truncated")}
              </div>
            )}
            <pre className="docker-logs-output">{logsModal.logs}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
