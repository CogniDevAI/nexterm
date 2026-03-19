// App.tsx — Root component
//
// Orchestrates: vault unlock, layout, connection dialogs, terminal + SFTP view routing

import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { TabBar } from "./components/layout/TabBar";
import { ConnectionDialog } from "./features/connection/ConnectionDialog";
import { HostKeyDialog } from "./features/connection/HostKeyDialog";
import { AuthPrompt } from "./features/connection/AuthPrompt";
import { VaultScreen } from "./features/vault/VaultScreen";
import { TerminalTabs } from "./features/terminal/TerminalTabs";
import { SftpBrowser } from "./features/sftp/SftpBrowser";
import { TunnelManager } from "./features/tunnel/TunnelManager";
import { useSessionStore } from "./stores/sessionStore";
import { useProfileStore } from "./stores/profileStore";
import { useConnection } from "./features/connection/useConnection";
import { useI18n } from "./lib/i18n";
import { tauriInvoke } from "./lib/tauri";

interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

function App() {
  const { t } = useI18n();
  const { sessions, activeSessionId, activeFeature } = useSessionStore();
  const { profiles } = useProfileStore();

  const {
    connecting,
    connectingProfileId,
    connectError,
    hostKeyRequest,
    needsPassword,
    pendingProfileId,
    connect,
    disconnect,
    respondHostKey,
    submitPassword,
    cancelConnect,
    clearError,
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

  const handleVaultUnlocked = useCallback(() => {
    setVaultReady(true);
  }, []);

  const handleVaultReset = useCallback(() => {
    // Vault file deleted — switch to "create new vault" mode
    setVaultStatus({ exists: false, unlocked: false });
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
    (profileId: string) => {
      void connect(profileId);
    },
    [connect],
  );

  const handleSaveAndConnect = useCallback(
    (profileId: string, password?: string) => {
      void connect(profileId, password);
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
          <div className="welcome">
            <h2>{t("welcome.title")}</h2>
            <p>
              {connecting
                ? t("welcome.connecting")
                : t("welcome.message")}
            </p>
            {connectError && (
              <div className="error-message">{connectError}</div>
            )}
          </div>
        )}
      </AppLayout>

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

      <AuthPrompt
        open={needsPassword}
        host={pendingProfile ? `${pendingProfile.host}:${pendingProfile.port}` : ""}
        username={pendingProfile?.username ?? ""}
        profileId={pendingProfileId}
        onSubmit={submitPassword}
        onCancel={cancelConnect}
      />
    </>
  );
}

export default App;
