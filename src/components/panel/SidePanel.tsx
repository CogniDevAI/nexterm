// components/panel/SidePanel.tsx — Collapsible terminal side panel
//
// Docks SftpBrowser and TunnelManager beside the live terminal in a flex-row
// layout. The terminal area is never unmounted when this panel is open.
//
// Architecture:
//   - Icon rail (role="toolbar"): two toggle buttons (SFTP, Tunnels)
//   - Content pane: conditionally mounts SftpBrowser or TunnelManager
//   - Width transition 200ms so ResizeObserver/FitAddon fires after CSS ends

import { useI18n } from "../../lib/i18n";
import { useWorkspaceStore, buildWorkspaceKey } from "../../stores/workspaceStore";
import { useSessionStore } from "../../stores/sessionStore";
import { SftpBrowser } from "../../features/sftp/SftpBrowser";
import { TunnelManager } from "../../features/tunnel/TunnelManager";
import { HistoryPanel } from "../../features/history/HistoryPanel";
import type { PanelSection } from "../../stores/workspaceStore";

// ── SVG icons (inline, no external dep) ─────────────────────────────────────

function FolderIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.293l1.5 1.5H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function TunnelIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 8c0-3.314 2.686-6 6-6s6 2.686 6 6-2.686 6-6 6"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <path
        d="M5 8c0-1.657.672-3 1.5-3S8 6.343 8 8s-.672 3-1.5 3"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <line
        x1="2"
        y1="8"
        x2="8"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 5v3.5l2 1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 4L3 2.5M4.5 4l.5-1.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 2l10 10M12 2L2 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function SidePanel() {
  const { t } = useI18n();

  const { activeSessionId, sessions } = useSessionStore();

  const activeSession = activeSessionId
    ? sessions.get(activeSessionId)
    : undefined;

  const workspaceKey =
    activeSession
      ? buildWorkspaceKey(activeSession.profileId, activeSession.userId)
      : null;

  // Selector: subscribe only to the fields we actually render (panelOpen,
  // panelSection, setters). This avoids re-renders on unrelated store changes
  // such as sftp snapshot updates.
  const panelOpen = useWorkspaceStore((s) =>
    workspaceKey ? (s.workspaces[workspaceKey]?.panelOpen ?? false) : false,
  );
  const panelSection = useWorkspaceStore((s) =>
    workspaceKey
      ? ((s.workspaces[workspaceKey]?.panelSection ?? null) as PanelSection)
      : null,
  );
  const setPanelSection = useWorkspaceStore((s) => s.setPanelSection);
  const setPanelOpen = useWorkspaceStore((s) => s.setPanelOpen);

  const sessionId = activeSession?.id ?? "";

  function handleToggle(section: "sftp" | "tunnel" | "history") {
    if (!workspaceKey) return;
    const isActive = panelOpen && panelSection === section;
    if (isActive) {
      setPanelOpen(workspaceKey, false);
    } else {
      setPanelSection(workspaceKey, section);
      setPanelOpen(workspaceKey, true);
    }
  }

  function handleClose() {
    if (!workspaceKey) return;
    setPanelOpen(workspaceKey, false);
  }

  return (
    <div className="side-panel-wrapper" data-open={panelOpen}>
      {/* Icon rail — always visible */}
      <div
        role="toolbar"
        aria-label={t("panel.sections")}
        className="side-panel-rail"
      >
        <button
          type="button"
          aria-pressed={panelOpen && panelSection === "sftp"}
          aria-label={t("panel.sftp")}
          className={`side-panel-rail-btn${panelOpen && panelSection === "sftp" ? " side-panel-rail-btn-active" : ""}`}
          onClick={() => handleToggle("sftp")}
          title={t("panel.sftp")}
        >
          <FolderIcon />
        </button>

        <button
          type="button"
          aria-pressed={panelOpen && panelSection === "tunnel"}
          aria-label={t("panel.tunnels")}
          className={`side-panel-rail-btn${panelOpen && panelSection === "tunnel" ? " side-panel-rail-btn-active" : ""}`}
          onClick={() => handleToggle("tunnel")}
          title={t("panel.tunnels")}
        >
          <TunnelIcon />
        </button>

        <button
          type="button"
          aria-pressed={panelOpen && panelSection === "history"}
          aria-label={t("panel.history")}
          className={`side-panel-rail-btn${panelOpen && panelSection === "history" ? " side-panel-rail-btn-active" : ""}`}
          onClick={() => handleToggle("history")}
          title={t("panel.history")}
        >
          <HistoryIcon />
        </button>
      </div>

      {/* Collapsible content pane */}
      <div
        className={`side-panel-content${panelOpen ? " side-panel-content-open" : ""}`}
        aria-hidden={!panelOpen}
      >
        {panelOpen && (
          <section
            aria-label={t("panel.region")}
            className="side-panel-section"
          >
            {/* Header with close button */}
            <div className="side-panel-header">
              <span className="side-panel-title">
                {panelSection === "sftp"
                  ? t("panel.sftp")
                  : panelSection === "history"
                    ? t("panel.history")
                    : t("panel.tunnels")}
              </span>
              <button
                type="button"
                aria-label={t("panel.close")}
                className="side-panel-close-btn"
                onClick={handleClose}
              >
                <CloseIcon />
              </button>
            </div>

            {/* Content — lazy mount by section */}
            <div className="side-panel-body">
              {panelSection === "sftp" && sessionId && (
                <SftpBrowser sessionId={sessionId} />
              )}
              {panelSection === "tunnel" && sessionId && (
                <TunnelManager sessionId={sessionId} />
              )}
              {panelSection === "history" && sessionId && (
                <HistoryPanel
                  sessionId={sessionId}
                  terminalId={activeSession?.activeTerminalId ?? null}
                  host={activeSession?.host ?? ""}
                />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
