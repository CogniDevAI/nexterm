// features/vault/VaultScreen.tsx — Master password screen
//
// Shown on app startup before the main UI:
// - If vault doesn't exist: create master password (with confirmation)
// - If vault exists but locked: enter master password to unlock

import { useState, useCallback } from "react";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { tauriInvoke } from "../../lib/tauri";
import { useI18n } from "../../lib/i18n";

interface VaultScreenProps {
  vaultExists: boolean;
  onUnlocked: () => void;
  onVaultReset?: () => void;
}

export function VaultScreen({ vaultExists, onUnlocked, onVaultReset }: VaultScreenProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleCreate = useCallback(async () => {
    setError(null);

    if (password.length < 1) {
      setError(t("vault.passwordRequired"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("vault.passwordMismatch"));
      return;
    }

    setLoading(true);
    try {
      await tauriInvoke("vault_create", { masterPassword: password });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [password, confirmPassword, onUnlocked, t]);

  const handleUnlock = useCallback(async () => {
    setError(null);

    if (!password.trim()) {
      setError(t("vault.passwordRequired"));
      return;
    }

    setLoading(true);
    try {
      await tauriInvoke("vault_unlock", { masterPassword: password });
      onUnlocked();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Wrong master password") || msg.includes("Decryption failed")) {
        setError(t("vault.wrongPassword"));
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [password, onUnlocked, t]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await tauriInvoke("vault_reset");
      setShowResetDialog(false);
      setPassword("");
      setError(null);
      // Notify parent that vault was reset so it re-checks vault status
      onVaultReset?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setShowResetDialog(false);
    } finally {
      setResetting(false);
    }
  }, [onVaultReset]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (vaultExists) {
        void handleUnlock();
      } else {
        void handleCreate();
      }
    },
    [vaultExists, handleUnlock, handleCreate],
  );

  return (
    <div className="vault-overlay">
      <div className="vault-card">
        <div className="vault-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <circle cx="12" cy="16" r="1" />
          </svg>
        </div>

        <h1 className="vault-title">NexTerm</h1>
        <p className="vault-subtitle">
          {vaultExists ? t("vault.enterPassword") : t("vault.createMessage")}
        </p>

        <form onSubmit={handleSubmit} className="vault-form" autoComplete="off">
          <Input
            id="vault-password"
            type="password"
            label={vaultExists ? t("vault.masterPassword") : t("vault.newPassword")}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            placeholder={
              vaultExists
                ? t("vault.enterPasswordPlaceholder")
                : t("vault.newPasswordPlaceholder")
            }
            autoFocus
          />

          {!vaultExists && (
            <Input
              id="vault-confirm"
              type="password"
              label={t("vault.confirmPassword")}
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setError(null);
              }}
              placeholder={t("vault.confirmPlaceholder")}
            />
          )}

          {error && <p className="vault-error">{error}</p>}

          <Button
            type="submit"
            disabled={loading || !password.trim()}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {loading ? (
              <Spinner size={14} />
            ) : vaultExists ? (
              t("vault.unlock")
            ) : (
              t("vault.create")
            )}
          </Button>

          {vaultExists && (
            <button
              type="button"
              className="vault-forgot-link"
              onClick={() => setShowResetDialog(true)}
            >
              {t("vault.forgotPassword")}
            </button>
          )}
        </form>

        {/* ── Reset Vault Warning Dialog ── */}
        {showResetDialog && (
          <div className="vault-reset-backdrop" onClick={() => !resetting && setShowResetDialog(false)}>
            <div className="vault-reset-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="vault-reset-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <h3 className="vault-reset-title">{t("vault.reset.title")}</h3>
              <p className="vault-reset-message">{t("vault.reset.warning")}</p>
              <p className="vault-reset-irreversible">{t("vault.reset.irreversible")}</p>
              <div className="vault-reset-actions">
                <Button
                  variant="ghost"
                  onClick={() => setShowResetDialog(false)}
                  disabled={resetting}
                >
                  {t("general.cancel")}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void handleReset()}
                  disabled={resetting}
                >
                  {resetting ? <Spinner size={14} /> : t("vault.reset.confirm")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
