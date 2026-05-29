// features/connection/ConnectionDialog.tsx — Create/edit connection profile form
//
// Multi-user redesign: Server section (name/host/port) + Users section
// (collapsible user cards with username + auth method + default toggle).

import { useState, useEffect } from "react";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { useProfileStore } from "../../stores/profileStore";
import { tauriInvoke } from "../../lib/tauri";
import { DEFAULT_SSH_PORT } from "../../lib/constants";
import { useI18n } from "../../lib/i18n";
import type { ConnectionProfile, AuthMethodConfig, UserCredential, TestConnectionResult, KeyInfo } from "../../lib/types";
import { classifyTestResult, type TestTone } from "./testResult";

interface ConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  editProfileId?: string | null;
  onConnectAfterSave?: (profileId: string, password?: string, userId?: string) => void;
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

function UserPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  );
}

function newUserCredential(): UserCredential {
  return {
    id: crypto.randomUUID(),
    username: "",
    authMethod: { type: "password" },
    isDefault: false,
  };
}

function newProfile(): ConnectionProfile {
  const defaultUser = { ...newUserCredential(), isDefault: true };
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "",
    port: DEFAULT_SSH_PORT,
    users: [defaultUser],
    tunnels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function ConnectionDialog({
  open,
  onClose,
  editProfileId,
}: ConnectionDialogProps) {
  const { t } = useI18n();
  const { profiles, saveProfile, storeCredential } = useProfileStore();
  const [profile, setProfile] = useState<ConnectionProfile>(newProfile);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Per-user password map: userId -> password string
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  // Per-user test state
  const [testingUser, setTestingUser] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { tone: TestTone; message: string }>>({});
  // Discovered SSH keys for the key picker dropdown
  const [availableKeys, setAvailableKeys] = useState<KeyInfo[]>([]);

  useEffect(() => {
    if (open) {
      if (editProfileId) {
        const existing = profiles.find((p) => p.id === editProfileId);
        if (existing) {
          setProfile({ ...existing, users: existing.users.map((u) => ({ ...u })) });
        }
      } else {
        setProfile(newProfile());
      }
      setErrors({});
      setPasswords({});
      setTestingUser(null);
      setTestResults({});
    }
  }, [open, editProfileId, profiles]);

  // Pre-fetch available SSH keys independently of profile changes.
  // Separated to avoid re-running when `profiles` reference changes on save.
  useEffect(() => {
    if (!open) return;
    void tauriInvoke<KeyInfo[]>("list_ssh_keys")
      .then(setAvailableKeys)
      .catch(() => setAvailableKeys([]));
  }, [open]);

  // ─── User management helpers ─────────────────────────

  function updateUser(userId: string, updates: Partial<UserCredential>) {
    setProfile((p) => ({
      ...p,
      users: p.users.map((u) => (u.id === userId ? { ...u, ...updates } : u)),
    }));
    // Clear test result when credentials change
    setTestResults((prev) => {
      if (!(userId in prev)) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }

  function setUserAuthType(userId: string, type: string) {
    let authMethod: AuthMethodConfig;
    if (type === "publicKey") {
      authMethod = { type: "publicKey", privateKeyPath: "", passphraseInKeychain: false };
      // Fetch (or refresh) available keys when switching to publicKey auth
      void tauriInvoke<KeyInfo[]>("list_ssh_keys")
        .then(setAvailableKeys)
        .catch(() => setAvailableKeys([]));
    } else if (type === "keyboardInteractive") {
      authMethod = { type: "keyboardInteractive" };
    } else {
      authMethod = { type: "password" };
    }
    updateUser(userId, { authMethod });
  }

  function addUser() {
    const newUser = newUserCredential();
    setProfile((p) => ({
      ...p,
      users: [...p.users, newUser],
    }));
  }

  function removeUser(userId: string) {
    setProfile((p) => {
      const remaining = p.users.filter((u) => u.id !== userId);
      // If we removed the default, make the first one default
      const first = remaining[0];
      if (first && !remaining.some((u) => u.isDefault)) {
        remaining[0] = { ...first, isDefault: true };
      }
      return { ...p, users: remaining };
    });
    // Clean up password state
    setPasswords((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }

  // ─── Validation ──────────────────────────────────────

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!profile.name.trim()) e["name"] = "Name is required";
    if (!profile.host.trim()) e["host"] = "Host is required";
    if (profile.port < 1 || profile.port > 65535) e["port"] = "Port must be 1-65535";

    if (profile.users.length === 0) {
      e["users"] = t("connection.atLeastOneUser");
    } else {
      for (const user of profile.users) {
        if (!user.username.trim()) {
          e[`user-${user.id}-username`] = t("connection.usernameRequired");
        }
        if (
          user.authMethod.type === "publicKey" &&
          !user.authMethod.privateKeyPath.trim()
        ) {
          e[`user-${user.id}-keyPath`] = "Key path is required";
        }
      }
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ─── Save / Save & Connect ───────────────────────────

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      const id = await saveProfile(profile);
      // Store ALL passwords that have content in vault
      for (const user of profile.users) {
        const pw = passwords[user.id];
        if (pw?.trim()) {
          await storeCredential(id, user.id, pw);
        }
      }
      onClose();
    } catch {
      // Error handled by store
    } finally {
      setSaving(false);
    }
  }



  // ─── Test & Auto-Save per user ───────────────────
  // Tests the connection in-place WITHOUT closing the dialog.
  // On success: saves profile + stores password in vault.

  async function handleTestAndSave(userId: string) {
    const user = profile.users.find((u) => u.id === userId);
    if (!user || !profile.host.trim() || !user.username.trim()) return;

    setTestingUser(userId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });

    try {
      const pw = passwords[userId] ?? "";
      const result = await tauriInvoke<TestConnectionResult>("test_connection", {
        host: profile.host,
        port: profile.port,
        username: user.username,
        authMethodType: user.authMethod.type,
        password: pw.trim() || null,
        privateKeyPath:
          user.authMethod.type === "publicKey"
            ? user.authMethod.privateKeyPath
            : null,
      });

      const cls = classifyTestResult(result);

      // Save profile + credential ONLY when authentication was confirmed
      if (cls.shouldSave) {
        try {
          const id = await saveProfile(profile);
          if (pw.trim()) {
            await storeCredential(id, user.id, pw);
          }
          // Update profile ID for subsequent saves (new profile case)
          setProfile((p) => ({ ...p, id }));
        } catch {
          // Save failed but connection worked — still show success
        }
      }

      setTestResults((prev) => ({ ...prev, [userId]: { tone: cls.tone, message: result.message } }));
    } catch (err) {
      // Genuine network/unreachable error — Rust returned Err(AppError)
      setTestResults((prev) => ({
        ...prev,
        [userId]: {
          tone: "danger" as TestTone,
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setTestingUser(null);
    }
  }

  const isEdit = !!editProfileId;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title=""
      width="540px"
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

      {/* ─── Section: Connection (Server) ─── */}
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
              }}
              className="cd-row-port"
            />
          </div>
        </div>
      </div>

      {/* ─── Section: Users ─── */}
      <div className="cd-section">
        <div className="cd-section-label">
          {t("connection.sectionUsers")}
          <span className="cd-section-label-badge">{profile.users.length}</span>
        </div>
        <div className="cd-section-content">
          {errors["users"] && (
            <div className="cd-error-message">{errors["users"]}</div>
          )}

          <div className="cd-user-rows">
            {profile.users.map((user) => (
              <div key={user.id} className="cd-user-row">
                {/* Username */}
                <div className="cd-user-row-field cd-user-row-username">
                  <input
                    className={`cd-user-row-input ${errors[`user-${user.id}-username`] ? "cd-user-row-input-error" : ""}`}
                    value={user.username}
                    onChange={(e) => updateUser(user.id, { username: e.target.value })}
                    placeholder={t("connection.username")}
                    spellCheck={false}
                  />
                </div>

                {/* Auth type toggle */}
                <div className="cd-user-row-auth">
                  <button
                    type="button"
                    className={`cd-user-row-auth-btn ${user.authMethod.type === "password" ? "cd-user-row-auth-btn-active" : ""}`}
                    onClick={() => setUserAuthType(user.id, "password")}
                    title={t("connection.password")}
                  >
                    <LockIcon />
                  </button>
                  <button
                    type="button"
                    className={`cd-user-row-auth-btn ${user.authMethod.type === "publicKey" ? "cd-user-row-auth-btn-active" : ""}`}
                    onClick={() => setUserAuthType(user.id, "publicKey")}
                    title={t("connection.publicKey")}
                  >
                    <KeyIcon />
                  </button>
                </div>

                {/* Credential field (password or key path) */}
                <div className="cd-user-row-field cd-user-row-credential">
                  {user.authMethod.type === "password" ? (
                    <input
                      className="cd-user-row-input"
                      type="password"
                      value={passwords[user.id] ?? ""}
                      onChange={(e) => {
                        setPasswords((prev) => ({ ...prev, [user.id]: e.target.value }));
                        setTestResults((prev) => {
                          if (!(user.id in prev)) return prev;
                          const next = { ...prev };
                          delete next[user.id];
                          return next;
                        });
                      }}
                      placeholder={t("connection.passwordPlaceholder")}
                    />
                  ) : (
                    // publicKey auth — dropdown picker + manual text fallback
                    (() => {
                      const currentPath =
                        user.authMethod.type === "publicKey"
                          ? user.authMethod.privateKeyPath
                          : "";
                      const passphraseInKeychain =
                        user.authMethod.type === "publicKey"
                          ? user.authMethod.passphraseInKeychain
                          : false;
                      // "other" means the current value is not in the list
                      const isOther =
                        currentPath !== "" &&
                        !availableKeys.some((k) => k.path === currentPath);

                      function setKeyPath(path: string) {
                        updateUser(user.id, {
                          authMethod: {
                            type: "publicKey",
                            privateKeyPath: path,
                            passphraseInKeychain,
                          },
                        });
                      }

                      return (
                        <div className="cd-key-picker">
                          <select
                            data-testid="key-picker-select"
                            className={`cd-user-row-input cd-key-picker-select ${errors[`user-${user.id}-keyPath`] ? "cd-user-row-input-error" : ""}`}
                            value={isOther ? "__other__" : currentPath}
                            onChange={(e) => {
                              if (e.target.value === "__other__") {
                                setKeyPath(currentPath || "");
                              } else {
                                setKeyPath(e.target.value);
                              }
                            }}
                          >
                            <option value="">
                              {availableKeys.length === 0
                                ? "~/.ssh/id_ed25519"
                                : t("connection.privateKeyPath")}
                            </option>
                            {availableKeys.map((key) => (
                              <option key={key.path} value={key.path}>
                                {key.keyType}
                                {key.comment ? ` — ${key.comment}` : ""}
                                {key.isEncrypted ? " (encrypted)" : ""}
                              </option>
                            ))}
                            <option value="__other__">Other…</option>
                          </select>
                          {(isOther ||
                            (currentPath === "" &&
                              availableKeys.length === 0)) && (
                            <input
                              className={`cd-user-row-input cd-key-picker-manual ${errors[`user-${user.id}-keyPath`] ? "cd-user-row-input-error" : ""}`}
                              value={currentPath}
                              onChange={(e) => setKeyPath(e.target.value)}
                              placeholder="~/.ssh/id_ed25519"
                              spellCheck={false}
                            />
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>

                {/* Test connection for this user (stays in dialog) */}
                {(() => {
                  const tr = testResults[user.id];
                  const connClass = tr?.tone === "success" ? "cd-user-row-connect-ok" :
                    tr?.tone === "untrusted" ? "cd-user-row-connect-untrusted" :
                    tr?.tone === "authFailed" ? "cd-user-row-connect-auth-failed" :
                    tr?.tone === "danger" ? "cd-user-row-connect-fail" : "";
                  const connTitle = tr?.tone === "success" ? t("connection.testSuccess") :
                    tr?.tone === "authFailed" ? `${t("connection.testAuthFailed")}: ${tr.message}` :
                    tr?.tone === "untrusted" ? `${t("connection.testUntrusted")}: ${tr.message}` :
                    tr?.tone === "danger" ? `${t("connection.testMitm")}: ${tr.message}` :
                    t("connection.testUser");
                  return (
                <button
                  type="button"
                  className={`cd-user-row-connect ${connClass}`}
                  onClick={() => handleTestAndSave(user.id)}
                  disabled={testingUser !== null || !user.username.trim() || !profile.host.trim()}
                  title={connTitle}
                >
                  {testingUser === user.id ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="cd-spin">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : testResults[user.id]?.tone === "success" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : testResults[user.id]?.tone === "untrusted" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  ) : testResults[user.id] ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5,3 19,12 5,21" />
                    </svg>
                  )}
                </button>
                  );
                })()}

                {/* Delete button */}
                <button
                  type="button"
                  className="cd-user-row-delete"
                  onClick={() => removeUser(user.id)}
                  disabled={profile.users.length <= 1}
                  title={t("connection.removeUser")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Add User row */}
          <button
            type="button"
            className="cd-add-user-btn"
            onClick={addUser}
          >
            <UserPlusIcon />
            <span>{t("connection.addUser")}</span>
          </button>
        </div>
      </div>

      {/* ─── Footer Actions ─── */}
      <div className="cd-actions">
        <Button variant="ghost" onClick={onClose}>
          {t("connection.cancel")}
        </Button>
        <div className="cd-actions-right">
          <Button onClick={handleSave} disabled={saving}>
            {t("connection.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
