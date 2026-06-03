// App.tsx — Root component
//
// Orchestrates: vault unlock, layout, connection dialogs, terminal + SFTP view routing

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { TabBar } from "./components/layout/TabBar";
import { ConnectionDialog } from "./features/connection/ConnectionDialog";
import { HostKeyDialog } from "./features/connection/HostKeyDialog";
import { MfaChallengeDialog } from "./features/connection/MfaChallengeDialog";
import { AuthPrompt } from "./features/connection/AuthPrompt";
import { StartupCommandsDialog } from "./features/connection/StartupCommandsDialog";
import { VaultScreen } from "./features/vault/VaultScreen";
import { UpdateDialog } from "./features/updater/UpdateDialog";
import { CriticalUpdateScreen } from "./features/updater/CriticalUpdateScreen";
import { TerminalTabs } from "./features/terminal/TerminalTabs";
import { SftpBrowser } from "./features/sftp/SftpBrowser";
import { RemoteEditCoordinator } from "./features/sftp/RemoteEditCoordinator";
import { TunnelManager } from "./features/tunnel/TunnelManager";
import { OnboardingTour } from "./components/ui/OnboardingTour";
import { useSessionStore } from "./stores/sessionStore";
import { useProfileStore } from "./stores/profileStore";
import type { StartupPreview } from "./stores/sessionStore";
import { useConnection } from "./features/connection/useConnection";
import { useUpdater } from "./features/updater/useUpdater";
import { useI18n } from "./lib/i18n";
import { tauriInvoke } from "./lib/tauri";
import type { ConnectionProfile } from "./lib/types";

interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

// ─── Lamplight Launchpad (empty state) ──────────────────────
// Replaces the raw .welcome h2+p with an action-focused surface.

interface WelcomeLaunchpadProps {
  connecting: boolean;
  connectingProfileId: string | null;
  connectError: string | null;
  onNewProfile: () => void;
  onConnect: (profileId: string) => void;
  onCancelConnect: () => void;
  profiles: ConnectionProfile[];
}

// Server + plug glyph — warm line-art, one copper highlight
function ServerGlyph() {
  return (
    <svg
      className="lp-welcome-glyph"
      width="72"
      height="72"
      viewBox="0 0 72 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Server body */}
      <rect x="12" y="18" width="48" height="12" rx="3" strokeWidth="1.5" stroke="currentColor" />
      <rect x="12" y="34" width="48" height="12" rx="3" strokeWidth="1.5" stroke="currentColor" />
      {/* Drive dots */}
      <circle cx="20" cy="24" r="2" fill="currentColor" />
      <circle cx="20" cy="40" r="2" fill="currentColor" />
      {/* Status lights — copper highlight on the right-most one */}
      <circle cx="50" cy="24" r="2" fill="currentColor" />
      <circle cx="56" cy="24" r="2" className="lp-glyph-accent" />
      <circle cx="50" cy="40" r="2" fill="currentColor" />
      {/* Plug connector at bottom */}
      <line x1="36" y1="46" x2="36" y2="54" strokeWidth="1.5" stroke="currentColor" strokeLinecap="round" />
      <rect x="28" y="54" width="16" height="8" rx="2" strokeWidth="1.5" stroke="currentColor" />
      <line x1="31" y1="58" x2="31" y2="62" strokeWidth="1.5" stroke="currentColor" strokeLinecap="round" />
      <line x1="41" y1="58" x2="41" y2="62" strokeWidth="1.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function timeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function WelcomeLaunchpad({
  connecting,
  connectingProfileId,
  connectError,
  onNewProfile,
  onConnect,
  onCancelConnect,
  profiles,
}: WelcomeLaunchpadProps) {
  const { t } = useI18n();

  // Build "Recent" list from profiles sorted by updatedAt (most recent first)
  // Presentational only — no backend change.
  const recentProfiles = useMemo(() => {
    return [...profiles]
      .sort((a, b) => {
        const ta = new Date(a.updatedAt).getTime();
        const tb = new Date(b.updatedAt).getTime();
        return tb - ta;
      })
      .slice(0, 5);
  }, [profiles]);

  // Find the connecting profile name if one is in progress
  const connectingProfile = connectingProfileId
    ? profiles.find((p) => p.id === connectingProfileId)
    : null;

  if (connecting && connectingProfile) {
    // Inline progress row — replaces the whole welcome surface while connecting
    return (
      <div className="lp-welcome">
        <div className="lp-welcome-connecting">
          <span className="lp-connecting-dot" />
          <span className="lp-connecting-label">
            {t("welcome.connectingTo", { host: `${connectingProfile.host}:${connectingProfile.port}` })}
          </span>
          <button
            className="lp-connecting-cancel"
            onClick={onCancelConnect}
          >
            {t("welcome.cancelConnect")}
          </button>
        </div>
        {connectError && (
          <div className="lp-welcome-error">{connectError}</div>
        )}
      </div>
    );
  }

  return (
    <div className="lp-welcome">
      <div className="lp-welcome-column">
        {/* Line-art server glyph */}
        <ServerGlyph />

        {/* Headline */}
        <h1 className="lp-welcome-headline">{t("welcome.headline")}</h1>

        {/* Subline */}
        <p className="lp-welcome-subline">{t("welcome.subline")}</p>

        {/* Primary CTA */}
        <button
          className="lp-welcome-cta"
          onClick={onNewProfile}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t("welcome.cta")}
        </button>

        {/* Keyboard hint */}
        <p className="lp-welcome-hint">
          {t("welcome.hint")}
        </p>

        {/* Error if any */}
        {connectError && (
          <div className="lp-welcome-error">{connectError}</div>
        )}

        {/* Recent connections */}
        {recentProfiles.length > 0 && (
          <div className="lp-recent">
            <div className="lp-recent-header">{t("welcome.recent")}</div>
            <div className="lp-recent-list">
              {recentProfiles.map((p) => {
                const defaultUser = p.users.find((u) => u.isDefault) ?? p.users[0];
                const label = defaultUser
                  ? `${defaultUser.username}@${p.host}`
                  : p.host;
                return (
                  <button
                    key={p.id}
                    className="lp-recent-row"
                    onClick={() => onConnect(p.id)}
                    title={t("welcome.reconnect")}
                    aria-label={`${t("welcome.reconnect")} ${p.name} (${label})`}
                  >
                    <span className="lp-recent-name">{p.name}</span>
                    <span className="lp-recent-host">{label}</span>
                    <span className="lp-recent-age">{timeAgo(p.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const { sessions, activeSessionId, activeFeature, startupPreview, clearStartupPreview } =
    useSessionStore();
  const { profiles } = useProfileStore();

  const {
    connecting,
    connectingProfileId,
    connectError,
    hostKeyRequest,
    mfaChallenge,
    needsPassword,
    pendingProfileId,
    pendingUser,
    connect,
    disconnect,
    respondHostKey,
    respondMfa,
    submitPassword,
    cancelConnect,
    clearError,
    runStartupCommands,
  } = useConnection();

  // ── Vault state ──────────────────────────────────────
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const status = await tauriInvoke<VaultStatus>("vault_status");
        if (status.unlocked) {
          setVaultReady(true);
        }
        setVaultStatus(status);
      } catch {
        // If vault_status fails, show create screen
        setVaultStatus({ exists: false, unlocked: false });
      }
    })();
  }, []);

  // ── Auto-update check ────────────────────────────────
  const { checkForUpdate } = useUpdater();
  const updateCheckDone = useRef(false);

  useEffect(() => {
    if (!vaultReady || updateCheckDone.current) return;
    updateCheckDone.current = true;

    const timer = setTimeout(() => {
      void checkForUpdate();
    }, 5000);

    return () => clearTimeout(timer);
  }, [vaultReady, checkForUpdate]);

  const handleVaultUnlocked = useCallback(() => {
    setVaultReady(true);
  }, []);

  const handleVaultReset = useCallback(() => {
    // Vault file deleted — switch to "create new vault" mode
    setVaultStatus({ exists: false, unlocked: false });
  }, []);

  // ── Onboarding tour ──────────────────────────────────
  const [showTour, setShowTour] = useState(false);

  useEffect(() => {
    if (vaultReady && !localStorage.getItem("nexterm-onboarding-completed")) {
      const timer = setTimeout(() => setShowTour(true), 500);
      return () => clearTimeout(timer);
    }
  }, [vaultReady]);

  const handleStartTour = useCallback(() => {
    setShowTour(true);
  }, []);

  // ── Dialog state ─────────────────────────────────────
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [editProfileId, setEditProfileId] = useState<string | null>(null);

  const handleNewProfile = useCallback(() => {
    setEditProfileId(null);
    setShowProfileDialog(true);
  }, []);

  const handleEditProfile = useCallback((profileId: string) => {
    setEditProfileId(profileId);
    setShowProfileDialog(true);
  }, []);

  const handleConnect = useCallback(
    (profileId: string, userId?: string) => {
      void connect(profileId, undefined, userId);
    },
    [connect],
  );

  const handleSaveAndConnect = useCallback(
    (profileId: string, password?: string, userId?: string) => {
      void connect(profileId, password, userId);
    },
    [connect],
  );

  const handleDisconnect = useCallback(
    (sessionId: string) => {
      void disconnect(sessionId);
    },
    [disconnect],
  );

  const activeSession = activeSessionId
    ? sessions.get(activeSessionId)
    : undefined;

  // Find profile info for auth prompt
  const pendingProfile = pendingProfileId
    ? profiles.find((p) => p.id === pendingProfileId)
    : null;

  // ── Show vault screen if not ready ───────────────────
  if (!vaultReady) {
    // Still checking vault status
    if (vaultStatus === null) {
      return null; // Brief flash while checking
    }
    return (
      <VaultScreen
        vaultExists={vaultStatus.exists}
        onUnlocked={handleVaultUnlocked}
        onVaultReset={handleVaultReset}
      />
    );
  }

  return (
    <>
      <AppLayout
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onNewProfile={handleNewProfile}
        onEditProfile={handleEditProfile}
        connectingProfileId={connectingProfileId}
        connectError={connectError}
        onClearError={clearError}
        onStartTour={handleStartTour}
      >
        {/* Content area */}
        {activeSession ? (
          <div className="session-view">
            <TabBar />
            <div className="session-content">
              {activeFeature === "terminal" && (
                <TerminalTabs sessionId={activeSession.id} />
              )}
              {activeFeature === "sftp" && (
                <SftpBrowser sessionId={activeSession.id} />
              )}
              {activeFeature === "tunnel" && (
                <TunnelManager sessionId={activeSession.id} />
              )}
            </div>
          </div>
        ) : (
          <WelcomeLaunchpad
            connecting={connecting}
            connectingProfileId={connectingProfileId}
            connectError={connectError}
            onNewProfile={handleNewProfile}
            onConnect={handleConnect}
            onCancelConnect={cancelConnect}
            profiles={profiles}
          />
        )}
      </AppLayout>

      {/* Onboarding tour */}
      {showTour && <OnboardingTour onClose={() => setShowTour(false)} />}

      {/* Modals */}
      <ConnectionDialog
        open={showProfileDialog}
        onClose={() => setShowProfileDialog(false)}
        editProfileId={editProfileId}
        onConnectAfterSave={handleSaveAndConnect}
      />

      <HostKeyDialog
        open={hostKeyRequest !== null}
        request={hostKeyRequest}
        onRespond={respondHostKey}
      />

      <MfaChallengeDialog
        open={mfaChallenge !== null}
        challenge={mfaChallenge}
        onSubmit={respondMfa}
        onCancel={cancelConnect}
      />

      <AuthPrompt
        open={needsPassword}
        host={pendingProfile ? `${pendingProfile.host}:${pendingProfile.port}` : ""}
        username={pendingUser?.username ?? ""}
        profileId={pendingProfileId}
        onSubmit={submitPassword}
        onCancel={cancelConnect}
      />

      {/* Update modals */}
      <UpdateDialog />
      <CriticalUpdateScreen />
      <RemoteEditCoordinator />

      <StartupCommandsDialog
        open={startupPreview !== null}
        commands={startupPreview?.commands ?? []}
        profileName={startupPreview?.profileName}
        onConfirm={() => {
          const preview: StartupPreview | null = startupPreview;
          if (preview) {
            void runStartupCommands(preview.sessionId, preview.commands);
          }
          clearStartupPreview();
        }}
        onCancel={clearStartupPreview}
      />
    </>
  );
}

export default App;
