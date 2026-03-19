// components/layout/Sidebar.tsx — Left sidebar with profiles and active sessions
//
// Redesigned: search, collapsible sections, profile cards with nested sessions,
// quick-access active sessions section, empty states.

import { useEffect, useMemo, useState, useCallback } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useProfileStore } from "../../stores/profileStore";
import {
  useSessionStore,
  type SessionEntry,
} from "../../stores/sessionStore";
import { useI18n } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";

// ─── Props (UNCHANGED — matches AppLayout contract) ───────
interface SidebarProps {
  onConnect: (profileId: string) => void;
  onDisconnect: (sessionId: string) => void;
  onNewProfile: () => void;
  onEditProfile: (profileId: string) => void;
  connectingProfileId: string | null;
  connectError: string | null;
  onClearError: () => void;
}

// ─── Helpers ──────────────────────────────────────────────

function SessionStateIndicator({ state }: { state: SessionEntry["state"] }) {
  if (state === "connected") return <span className="indicator indicator-success" />;
  if (state === "connecting" || state === "authenticating")
    return <span className="indicator indicator-warning" />;
  if (state === "disconnected") return <span className="indicator indicator-muted" />;
  return <span className="indicator indicator-error" />;
}

import type { TranslationKey } from "../../lib/i18n";

function getSessionStateKey(state: SessionEntry["state"]): TranslationKey {
  if (state === "connected") return "session.connected";
  if (state === "connecting") return "session.connecting";
  if (state === "authenticating") return "session.authenticating";
  if (state === "disconnected") return "session.disconnected";
  return "session.error";
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <span className={`sidebar-chevron ${collapsed ? "sidebar-chevron-collapsed" : ""}`}>
      {"\u25BC"}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────

export function Sidebar({
  onConnect,
  onDisconnect,
  onNewProfile,
  onEditProfile,
  connectingProfileId,
  connectError,
  onClearError,
}: SidebarProps) {
  const { t } = useI18n();
  const {
    profiles,
    loading,
    loadProfiles,
    deleteProfile,
    exportProfiles,
    importProfiles,
  } = useProfileStore();
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [profilesCollapsed, setProfilesCollapsed] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);

  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    profileId: string;
    profileName: string;
    hasActiveSession: boolean;
  } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Export/import feedback banner
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Export dialog state
  const [exportDialog, setExportDialog] = useState(false);
  const [exportIncludePasswords, setExportIncludePasswords] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);

  // Import password dialog state
  const [importPasswordDialog, setImportPasswordDialog] = useState<string | null>(null); // holds file path
  const [importPassword, setImportPassword] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Auto-clear banner after 4 seconds
  useEffect(() => {
    if (banner) {
      const timer = setTimeout(() => setBanner(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [banner]);

  const handleExportClick = useCallback(() => {
    if (profiles.length === 0) {
      setBanner({ type: "error", message: t("sidebar.noProfilesToExport") });
      return;
    }
    // Reset export dialog state
    setExportIncludePasswords(false);
    setExportPassword("");
    setExportPasswordConfirm("");
    setExportError(null);
    setExportLoading(false);
    setExportDialog(true);
  }, [profiles.length, t]);

  const handleExportConfirm = useCallback(async () => {
    if (exportIncludePasswords) {
      if (!exportPassword) {
        setExportError(t("sidebar.exportDialog.passwordRequired"));
        return;
      }
      if (exportPassword !== exportPasswordConfirm) {
        setExportError(t("sidebar.exportDialog.passwordMismatch"));
        return;
      }
    }
    setExportError(null);
    setExportLoading(true);
    try {
      const ext = exportIncludePasswords ? "nexterm" : "json";
      const defaultName = exportIncludePasswords
        ? "nexterm-profiles.nexterm"
        : "nexterm-profiles.json";
      const filterName = exportIncludePasswords ? "NexTerm Encrypted" : "JSON";

      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (!path) {
        setExportLoading(false);
        return;
      }
      const count = await exportProfiles(
        path,
        exportIncludePasswords,
        exportIncludePasswords ? exportPassword : undefined,
      );
      setExportDialog(false);
      setBanner({ type: "success", message: t("sidebar.exportSuccess", { count }) });
    } catch (err) {
      setExportError(String(err));
    } finally {
      setExportLoading(false);
    }
  }, [exportIncludePasswords, exportPassword, exportPasswordConfirm, exportProfiles, t]);

  const handleImportClick = useCallback(async () => {
    try {
      const path = await open({
        filters: [
          { name: "NexTerm", extensions: ["json", "nexterm"] },
        ],
        multiple: false,
      });
      if (!path) return; // user cancelled
      const filePath = path as string;

      // Check if encrypted file
      if (filePath.endsWith(".nexterm")) {
        setImportPassword("");
        setImportError(null);
        setImportLoading(false);
        setImportPasswordDialog(filePath);
        return;
      }

      // Plain JSON import
      const result = await importProfiles(filePath);
      setBanner({
        type: "success",
        message: t("sidebar.importSuccess", {
          imported: result.imported,
          skipped: result.skipped,
        }),
      });
    } catch (err) {
      setBanner({ type: "error", message: t("sidebar.importError") });
    }
  }, [importProfiles, t]);

  const handleImportWithPassword = useCallback(async () => {
    if (!importPasswordDialog || !importPassword) return;
    setImportError(null);
    setImportLoading(true);
    try {
      const result = await importProfiles(importPasswordDialog, importPassword);
      setImportPasswordDialog(null);
      setBanner({
        type: "success",
        message: t("sidebar.importSuccess", {
          imported: result.imported,
          skipped: result.skipped,
        }),
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Wrong export password") || msg.includes("corrupted")) {
        setImportError(t("sidebar.importPassword.wrongPassword"));
      } else {
        setImportError(msg);
      }
    } finally {
      setImportLoading(false);
    }
  }, [importPasswordDialog, importPassword, importProfiles, t]);

  // Auto-clear error after 5 seconds
  useEffect(() => {
    if (connectError) {
      const timer = setTimeout(onClearError, 5000);
      return () => clearTimeout(timer);
    }
  }, [connectError, onClearError]);

  const sessionEntries = Array.from(sessions.values());

  // Build a map: profileId -> active sessions for that profile
  const profileSessionMap = useMemo(() => {
    const map = new Map<string, SessionEntry[]>();
    for (const s of sessionEntries) {
      const existing = map.get(s.profileId) ?? [];
      existing.push(s);
      map.set(s.profileId, existing);
    }
    return map;
  }, [sessionEntries]);

  // Filter profiles by search query
  const filteredProfiles = useMemo(() => {
    if (!searchQuery.trim()) return profiles;
    const q = searchQuery.toLowerCase();
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.username.toLowerCase().includes(q)
    );
  }, [profiles, searchQuery]);

  // Active (connected/connecting) sessions for the quick-access section
  const activeSessions = useMemo(
    () => sessionEntries.filter((s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"),
    [sessionEntries]
  );

  function handleDeleteClick(profileId: string, profileName: string) {
    const profileSessions = profileSessionMap.get(profileId);
    const hasActive =
      profileSessions?.some(
        (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
      ) ?? false;
    setDeleteConfirm({ profileId, profileName, hasActiveSession: hasActive });
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return;
    setDeleteLoading(true);
    try {
      // If active session, disconnect all sessions for this profile first
      if (deleteConfirm.hasActiveSession) {
        const profileSessions = profileSessionMap.get(deleteConfirm.profileId);
        const activeSess = profileSessions?.filter(
          (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
        ) ?? [];
        for (const s of activeSess) {
          onDisconnect(s.id);
        }
        // Brief wait for disconnect to propagate
        await new Promise((r) => setTimeout(r, 300));
      }
      await deleteProfile(deleteConfirm.profileId);
      setDeleteConfirm(null);
    } catch {
      // Backend may still reject — try disconnect+delete approach
      // if the error indicates active session
      try {
        const profileSessions = profileSessionMap.get(deleteConfirm.profileId);
        const activeSess = profileSessions?.filter(
          (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
        ) ?? [];
        for (const s of activeSess) {
          onDisconnect(s.id);
        }
        await new Promise((r) => setTimeout(r, 500));
        await deleteProfile(deleteConfirm.profileId);
        setDeleteConfirm(null);
      } catch {
        // If still failing, update dialog to show active session state
        setDeleteConfirm((prev) =>
          prev ? { ...prev, hasActiveSession: true } : null
        );
      }
    } finally {
      setDeleteLoading(false);
    }
  }

  function handleDeleteCancel() {
    if (deleteLoading) return;
    setDeleteConfirm(null);
  }

  function isProfileConnecting(profileId: string) {
    return connectingProfileId === profileId;
  }

  function isProfileConnected(profileId: string) {
    const profileSessions = profileSessionMap.get(profileId);
    return profileSessions?.some((s) => s.state === "connected") ?? false;
  }

  function handleProfileClick(profileId: string) {
    // If profile has an active session, switch to it. Otherwise, connect.
    const profileSessions = profileSessionMap.get(profileId);
    const connectedSession = profileSessions?.find((s) => s.state === "connected");
    if (connectedSession) {
      setActiveSession(connectedSession.id);
    } else {
      onConnect(profileId);
    }
  }

  function getProfileStatusClass(profileId: string): string {
    if (isProfileConnected(profileId)) return "sidebar-status-dot-connected";
    if (isProfileConnecting(profileId)) return "sidebar-status-dot-connecting";
    return "sidebar-status-dot-idle";
  }

  return (
    <aside className="sidebar">
      {/* ── Search ── */}
      <div className="sidebar-search">
        <div className="sidebar-search-wrapper">
          <span className="sidebar-search-icon">{"\u2315"}</span>
          <input
            className="sidebar-search-input"
            type="text"
            placeholder={t("sidebar.search")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-form-type="other"
            data-lpignore="true"
          />
        </div>
      </div>

      {/* ── Profiles Section ── */}
      <div className="sidebar-section">
        <div
          className="sidebar-section-header-collapsible"
          onClick={() => setProfilesCollapsed((prev) => !prev)}
        >
          <div className="sidebar-section-header-left">
            <ChevronIcon collapsed={profilesCollapsed} />
            <span className="sidebar-section-title">{t("sidebar.profiles")}</span>
            <span className="sidebar-section-badge">{profiles.length}</span>
          </div>
          <div className="sidebar-section-header-actions">
            <button
              className="sidebar-action-btn sidebar-action-btn-subtle"
              onClick={(e) => {
                e.stopPropagation();
                void handleImportClick();
              }}
              title={t("sidebar.import")}
            >
              {"\u2193"}
            </button>
            <button
              className="sidebar-action-btn sidebar-action-btn-subtle"
              onClick={(e) => {
                e.stopPropagation();
                handleExportClick();
              }}
              title={t("sidebar.export")}
            >
              {"\u2191"}
            </button>
            <button
              className="sidebar-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                onNewProfile();
              }}
              title={t("sidebar.newProfile")}
            >
              +
            </button>
          </div>
        </div>

        <div
          className={`sidebar-section-content ${profilesCollapsed ? "sidebar-section-content-collapsed" : ""}`}
        >
          <div className="sidebar-list">
            {/* Loading state */}
            {loading && <div className="sidebar-empty">{t("sidebar.loading")}</div>}

            {/* Empty: no profiles at all */}
            {!loading && profiles.length === 0 && (
              <div className="sidebar-empty-state">
                {t("sidebar.noProfiles")}{" "}
                <button className="sidebar-empty-state-cta" onClick={onNewProfile}>
                  {t("sidebar.noProfilesCta")}
                </button>
              </div>
            )}

            {/* Empty: search returned no results */}
            {!loading && profiles.length > 0 && filteredProfiles.length === 0 && (
              <div className="sidebar-empty-state">{t("sidebar.noResults")}</div>
            )}

            {/* Profile cards */}
            {filteredProfiles.map((p) => {
              const connected = isProfileConnected(p.id);
              const connecting = isProfileConnecting(p.id);
              const profileSessions = profileSessionMap.get(p.id);
              const hasActiveSessions =
                profileSessions?.some(
                  (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
                ) ?? false;

              return (
                <div key={p.id}>
                  {/* Profile card */}
                  <div
                    className={`sidebar-profile-card ${connected ? "sidebar-profile-card-connected" : ""}`}
                    onClick={() => handleProfileClick(p.id)}
                    title={`${p.username}@${p.host}:${p.port}`}
                  >
                    <div className="sidebar-profile-card-left">
                      <span className={`sidebar-status-dot ${getProfileStatusClass(p.id)}`} />
                      <div className="sidebar-profile-text">
                        <div className="sidebar-profile-name">{p.name}</div>
                        <div className="sidebar-profile-host">
                          {p.username}@{p.host}
                        </div>
                      </div>
                    </div>
                    <div
                      className="sidebar-profile-card-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!connected && (
                        <button
                          className="sidebar-profile-btn sidebar-profile-btn-connect"
                          onClick={() => onConnect(p.id)}
                          disabled={connecting}
                          title={connecting ? t("sidebar.connecting") : t("sidebar.connect")}
                        >
                          {connecting ? "..." : "\u25B6"}
                        </button>
                      )}
                      <button
                        className="sidebar-profile-btn"
                        onClick={() => onEditProfile(p.id)}
                        title={t("sidebar.edit")}
                      >
                        {"\u270F"}
                      </button>
                      <button
                        className="sidebar-profile-btn"
                        onClick={() => handleDeleteClick(p.id, p.name)}
                        title={t("sidebar.delete")}
                      >
                        {"\u2715"}
                      </button>
                    </div>
                  </div>

                  {/* D4: Nested sessions under profile */}
                  {hasActiveSessions && profileSessions && (
                    <div className="sidebar-nested-sessions">
                      {profileSessions
                        .filter(
                          (s) =>
                            s.state === "connected" ||
                            s.state === "connecting" ||
                            s.state === "authenticating"
                        )
                        .map((s) => (
                          <div
                            key={s.id}
                            className={`sidebar-nested-session ${s.id === activeSessionId ? "sidebar-nested-session-active" : ""}`}
                            onClick={() => setActiveSession(s.id)}
                          >
                            <div className="sidebar-nested-session-left">
                              <SessionStateIndicator state={s.state} />
                              <div className="sidebar-nested-session-info">
                                <div className="sidebar-nested-session-host">
                                  {s.host}
                                </div>
                                <div className="sidebar-nested-session-state">
                                  {t(getSessionStateKey(s.state))}
                                </div>
                              </div>
                            </div>
                            <button
                              className="sidebar-nested-disconnect-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDisconnect(s.id);
                              }}
                    title={t("sidebar.disconnect")}
                  >
                    {"\u23FB"}
                  </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Export/import feedback banner */}
        {banner && (
          <div
            className={`sidebar-banner ${banner.type === "success" ? "sidebar-banner-success" : "sidebar-banner-error"}`}
            onClick={() => setBanner(null)}
            title={t("general.close")}
          >
            {banner.type === "success" ? "\u2713 " : ""}{banner.message}
          </div>
        )}

        {/* Error feedback inline in sidebar */}
        {connectError && (
          <div className="sidebar-error" onClick={onClearError} title={t("general.close")}>
            {connectError}
          </div>
        )}
      </div>

      {/* ── Active Sessions Section (quick access) ── */}
      {activeSessions.length > 0 && (
        <div className="sidebar-section">
          <div
            className="sidebar-section-header-collapsible"
            onClick={() => setSessionsCollapsed((prev) => !prev)}
          >
            <div className="sidebar-section-header-left">
              <ChevronIcon collapsed={sessionsCollapsed} />
              <span className="sidebar-section-title">{t("sidebar.sessions")}</span>
              <span className="sidebar-section-badge sidebar-section-badge-active">
                {activeSessions.length}
              </span>
            </div>
          </div>

          <div
            className={`sidebar-section-content ${sessionsCollapsed ? "sidebar-section-content-collapsed" : ""}`}
          >
            <div className="sidebar-list">
              {activeSessions.map((s) => (
                <div
                  key={s.id}
                  className={`sidebar-item sidebar-session-item ${s.id === activeSessionId ? "sidebar-item-active" : ""}`}
                  onClick={() => setActiveSession(s.id)}
                >
                  <div className="sidebar-session-main">
                    <SessionStateIndicator state={s.state} />
                    <div className="sidebar-profile-info">
                      <div className="sidebar-item-name">{s.profileName}</div>
                      <div className="sidebar-item-detail">{s.host}</div>
                    </div>
                  </div>
                  <button
                    className="sidebar-disconnect-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDisconnect(s.id);
                    }}
                    title={t("sidebar.disconnect")}
                  >
                    {"\u23FB"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* D5: No active sessions — section hidden (activeSessions.length === 0 hides it above) */}

      {/* ── Delete Confirmation Dialog ── */}
      <Dialog
        open={deleteConfirm !== null}
        onClose={handleDeleteCancel}
        title=""
        width="400px"
      >
        {deleteConfirm && (
          <>
            <div className="delete-confirm-header">
              <div className="delete-confirm-icon">{"\u26A0"}</div>
              <div className="delete-confirm-text">
                <h3 className="delete-confirm-title">
                  {t("sidebar.deleteConfirmTitle")}
                </h3>
                <p className="delete-confirm-message">
                  {deleteConfirm.hasActiveSession
                    ? t("sidebar.deleteConfirmActiveSession", { name: deleteConfirm.profileName })
                    : t("sidebar.deleteConfirmMessage", { name: deleteConfirm.profileName })}
                </p>
              </div>
            </div>
            <div className="delete-confirm-actions">
              <button
                className="btn btn-ghost btn-md"
                onClick={handleDeleteCancel}
                disabled={deleteLoading}
              >
                {t("general.cancel")}
              </button>
              <button
                className="btn btn-danger btn-md"
                onClick={() => void handleDeleteConfirm()}
                disabled={deleteLoading}
              >
                {deleteLoading
                  ? t("sidebar.deleteConfirmDeleting")
                  : deleteConfirm.hasActiveSession
                    ? t("sidebar.deleteConfirmDisconnectDelete")
                    : t("sidebar.deleteConfirmDelete")}
              </button>
            </div>
          </>
        )}
      </Dialog>

      {/* ── Export Dialog ── */}
      <Dialog
        open={exportDialog}
        onClose={() => !exportLoading && setExportDialog(false)}
        title=""
        width="420px"
      >
        <div className="cd-header">
          <div className="cd-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="cd-header-text">
            <h3 className="cd-title">{t("sidebar.exportDialog.title")}</h3>
            <p className="cd-subtitle">{t("sidebar.exportDialog.subtitle")}</p>
          </div>
        </div>
        <div className="cd-section-content">
          <label className="export-checkbox-label">
            <input
              type="checkbox"
              checked={exportIncludePasswords}
              onChange={(e) => {
                setExportIncludePasswords(e.target.checked);
                if (!e.target.checked) {
                  setExportPassword("");
                  setExportPasswordConfirm("");
                  setExportError(null);
                }
              }}
            />
            <span>{t("sidebar.exportDialog.includePasswords")}</span>
          </label>
          {exportIncludePasswords && (
            <>
              <p className="export-password-hint">
                {t("sidebar.exportDialog.exportPasswordHint")}
              </p>
              <div className="input-group">
                <label className="input-label">{t("sidebar.exportDialog.exportPassword")}</label>
                <input
                  className="input"
                  type="password"
                  value={exportPassword}
                  onChange={(e) => setExportPassword(e.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                  autoFocus
                />
              </div>
              <div className="input-group">
                <label className="input-label">{t("sidebar.exportDialog.confirmPassword")}</label>
                <input
                  className="input"
                  type="password"
                  value={exportPasswordConfirm}
                  onChange={(e) => setExportPasswordConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleExportConfirm();
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                />
              </div>
            </>
          )}
          {exportError && (
            <div className="cd-error-message">{exportError}</div>
          )}
        </div>
        <div className="cd-actions">
          <button
            className="btn btn-ghost btn-md"
            onClick={() => setExportDialog(false)}
            disabled={exportLoading}
          >
            {t("general.cancel")}
          </button>
          <button
            className="btn btn-primary btn-md"
            onClick={() => void handleExportConfirm()}
            disabled={exportLoading}
          >
            {exportLoading ? t("general.loading") : t("sidebar.export")}
          </button>
        </div>
      </Dialog>

      {/* ── Import Password Dialog (encrypted .nexterm files) ── */}
      <Dialog
        open={importPasswordDialog !== null}
        onClose={() => !importLoading && setImportPasswordDialog(null)}
        title=""
        width="420px"
      >
        <div className="cd-header">
          <div className="cd-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="cd-header-text">
            <h3 className="cd-title">{t("sidebar.importPassword.title")}</h3>
            <p className="cd-subtitle">{t("sidebar.importPassword.message")}</p>
          </div>
        </div>
        <div className="cd-section-content">
          <div className="input-group">
            <label className="input-label">{t("sidebar.exportDialog.exportPassword")}</label>
            <input
              className="input"
              type="password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleImportWithPassword();
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              autoFocus
            />
          </div>
          {importError && (
            <div className="cd-error-message">{importError}</div>
          )}
        </div>
        <div className="cd-actions">
          <button
            className="btn btn-ghost btn-md"
            onClick={() => setImportPasswordDialog(null)}
            disabled={importLoading}
          >
            {t("general.cancel")}
          </button>
          <button
            className="btn btn-primary btn-md"
            onClick={() => void handleImportWithPassword()}
            disabled={importLoading || !importPassword}
          >
            {importLoading ? t("general.loading") : t("sidebar.import")}
          </button>
        </div>
      </Dialog>
    </aside>
  );
}
