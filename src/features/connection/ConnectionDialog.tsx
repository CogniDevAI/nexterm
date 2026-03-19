// features/connection/ConnectionDialog.tsx — Create/edit connection profile form
//
// Premium redesign: grouped sections, segmented auth control, toggle switch,
// test inline, proper button hierarchy.

import { useState, useEffect, useCallback } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { useProfileStore } from "../../stores/profileStore";
import { tauriInvoke } from "../../lib/tauri";
import { DEFAULT_SSH_PORT } from "../../lib/constants";
import { useI18n } from "../../lib/i18n";
import type { ConnectionProfile, AuthMethodConfig } from "../../lib/types";

interface ConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  editProfileId?: string | null;
  onConnectAfterSave?: (profileId: string, password?: string) => void;
}

/* ─── Icons (inline SVG to avoid deps) ──────────── */

function ServerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function XCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function newProfile(): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "",
    port: DEFAULT_SSH_PORT,
    username: "",
    authMethod: { type: "password" },
    tunnels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function ConnectionDialog({
  open,
  onClose,
  editProfileId,
  onConnectAfterSave,
}: ConnectionDialogProps) {
  const { t } = useI18n();
  const { profiles, saveProfile, storeCredential } = useProfileStore();
  const [profile, setProfile] = useState<ConnectionProfile>(newProfile);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      if (editProfileId) {
        const existing = profiles.find((p) => p.id === editProfileId);
        if (existing) {
          setProfile({ ...existing });
        }
      } else {
        setProfile(newProfile());
      }
      setErrors({});
      setPassword("");
      setRememberPassword(false);
      setTestResult(null);
    }
  }, [open, editProfileId, profiles]);

  // Clear test result when connection-relevant fields change
  const clearTestResult = useCallback(() => {
    setTestResult(null);
  }, []);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!profile.name.trim()) e["name"] = "Name is required";
    if (!profile.host.trim()) e["host"] = "Host is required";
    if (!profile.username.trim()) e["username"] = "Username is required";
    if (profile.port < 1 || profile.port > 65535)
      e["port"] = "Port must be 1-65535";
    if (
      profile.authMethod.type === "publicKey" &&
      !profile.authMethod.privateKeyPath.trim()
    ) {
      e["keyPath"] = "Key path is required";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      const id = await saveProfile(profile);
      // Store password in vault if "Remember" is checked
      if (rememberPassword && password.trim()) {
        await storeCredential(id, password);
      }
      onClose();
    } catch {
      // Error handled by store
    } finally {
      setSaving(false);
    }
  }

  function handleSaveAndConnect() {
    if (!validate()) return;
    void (async () => {
      setSaving(true);
      try {
        const id = await saveProfile(profile);
        // Store password in vault if "Remember" is checked
        if (rememberPassword && password.trim()) {
          await storeCredential(id, password);
        }
        onClose();
        if (onConnectAfterSave) {
          // Pass password so connect can use it directly (avoids double-prompt)
          onConnectAfterSave(id, password.trim() ? password : undefined);
        }
      } catch {
        // Error handled by store
      } finally {
        setSaving(false);
      }
    })();
  }

  function setAuthType(type: string) {
    let authMethod: AuthMethodConfig;
    if (type === "publicKey") {
      authMethod = {
        type: "publicKey",
        privateKeyPath: "",
        passphraseInKeychain: false,
      };
    } else {
      authMethod = { type: "password" };
    }
    setProfile((p) => ({ ...p, authMethod }));
    clearTestResult();
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const message = await tauriInvoke<string>("test_connection", {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethodType: profile.authMethod.type,
        password: password.trim() || null,
        privateKeyPath:
          profile.authMethod.type === "publicKey"
            ? profile.authMethod.privateKeyPath
            : null,
      });
      setTestResult({ ok: true, message });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  const canTest = profile.host.trim() !== "" && profile.username.trim() !== "";
  const isEdit = !!editProfileId;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title=""
      width="500px"
    >
      {/* ─── Custom Header with Icon ─── */}
      <div className="cd-header">
        <div className="cd-header-icon">
          <ServerIcon />
        </div>
        <div className="cd-header-text">
          <h3 className="cd-title">
            {isEdit ? t("connection.editTitle") : t("connection.newTitle")}
          </h3>
        </div>
      </div>

      {/* ─── Section: Connection ─── */}
      <div className="cd-section">
        <div className="cd-section-label">{t("connection.sectionConnection")}</div>
        <div className="cd-section-content">
          <Input
            id="profile-name"
            label={t("connection.name")}
            value={profile.name}
            error={errors["name"]}
            onChange={(e) =>
              setProfile((p) => ({ ...p, name: e.target.value }))
            }
            placeholder="My Server"
            autoFocus
          />
          <div className="cd-row">
            <Input
              id="profile-host"
              label={t("connection.host")}
              value={profile.host}
              error={errors["host"]}
              onChange={(e) => {
                setProfile((p) => ({ ...p, host: e.target.value }));
                clearTestResult();
              }}
              placeholder="server.example.com"
              className="cd-row-flex"
            />
            <Input
              id="profile-port"
              label={t("connection.port")}
              type="number"
              value={String(profile.port)}
              error={errors["port"]}
              onChange={(e) => {
                setProfile((p) => ({
                  ...p,
                  port: parseInt(e.target.value, 10) || 22,
                }));
                clearTestResult();
              }}
              className="cd-row-port"
            />
          </div>
          <Input
            id="profile-username"
            label={t("connection.username")}
            value={profile.username}
            error={errors["username"]}
            onChange={(e) => {
              setProfile((p) => ({ ...p, username: e.target.value }));
              clearTestResult();
            }}
            placeholder="root"
          />
        </div>
      </div>

      {/* ─── Section: Authentication ─── */}
      <div className="cd-section">
        <div className="cd-section-label">{t("connection.auth")}</div>
        <div className="cd-section-content">
          {/* Segmented control for auth method */}
          <div className="cd-segmented">
            <button
              type="button"
              className={`cd-segmented-btn ${profile.authMethod.type === "password" ? "cd-segmented-btn-active" : ""}`}
              onClick={() => setAuthType("password")}
            >
              <LockIcon />
              <span>{t("connection.password")}</span>
            </button>
            <button
              type="button"
              className={`cd-segmented-btn ${profile.authMethod.type === "publicKey" ? "cd-segmented-btn-active" : ""}`}
              onClick={() => setAuthType("publicKey")}
            >
              <KeyIcon />
              <span>{t("connection.publicKey")}</span>
            </button>
          </div>

          {profile.authMethod.type === "password" && (
            <>
              <Input
                id="profile-password"
                label={t("connection.password")}
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearTestResult();
                }}
                placeholder={t("connection.passwordPlaceholder")}
              />
              {/* Toggle switch for remember password */}
              <div className="cd-toggle-row">
                <button
                  type="button"
                  className={`cd-toggle ${rememberPassword ? "cd-toggle-on" : ""}`}
                  onClick={() => setRememberPassword(!rememberPassword)}
                  role="switch"
                  aria-checked={rememberPassword}
                >
                  <span className="cd-toggle-thumb" />
                </button>
                <span className="cd-toggle-label">
                  {t("connection.rememberPassword")}
                </span>
              </div>
            </>
          )}

          {profile.authMethod.type === "publicKey" && (
            <Input
              id="profile-keypath"
              label={t("connection.privateKeyPath")}
              value={profile.authMethod.privateKeyPath}
              error={errors["keyPath"]}
              onChange={(e) => {
                setProfile((p) => ({
                  ...p,
                  authMethod: {
                    ...p.authMethod,
                    type: "publicKey",
                    privateKeyPath: e.target.value,
                    passphraseInKeychain:
                      p.authMethod.type === "publicKey"
                        ? p.authMethod.passphraseInKeychain
                        : false,
                  },
                }));
                clearTestResult();
              }}
              placeholder="~/.ssh/id_ed25519"
            />
          )}
        </div>
      </div>

      {/* ─── Test Result (inline) ─── */}
      {testResult && (
        <div className={`cd-test-result ${testResult.ok ? "cd-test-success" : "cd-test-error"}`}>
          <span className="cd-test-icon">
            {testResult.ok ? <CheckCircleIcon /> : <XCircleIcon />}
          </span>
          <span className="cd-test-message">
            {testResult.ok ? `${testResult.message}` : testResult.message}
          </span>
        </div>
      )}

      {/* ─── Footer Actions ─── */}
      <div className="cd-actions">
        <Button variant="ghost" onClick={onClose}>
          {t("connection.cancel")}
        </Button>
        <div className="cd-actions-right">
          <Button
            variant="secondary"
            onClick={handleTestConnection}
            disabled={!canTest || testing || saving}
          >
            {testing ? t("connection.testing") : t("connection.test")}
          </Button>
          <Button variant="secondary" onClick={handleSave} disabled={saving}>
            {t("connection.save")}
          </Button>
          <Button onClick={handleSaveAndConnect} disabled={saving}>
            {t("connection.saveConnect")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
