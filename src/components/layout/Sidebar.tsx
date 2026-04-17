// components/layout/Sidebar.tsx — Left sidebar with profiles and active sessions
//
// Premium minimalist redesign with drag-and-drop reordering via @dnd-kit.

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useProfileStore } from "../../stores/profileStore";
import {
  useSessionStore,
  type SessionEntry,
} from "../../stores/sessionStore";
import { useI18n } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";
import type { ConnectionProfile } from "../../lib/types";

// ─── Props ────────────────────────────────────────────────
interface SidebarProps {
  onConnect: (profileId: string, userId?: string) => void;
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

// ─── Sortable Profile Card ───────────────────────────────

interface SortableProfileCardProps {
  profile: ConnectionProfile;
  connected: boolean;
  connecting: boolean;
  hasActiveSessions: boolean;
  isExpanded: boolean;
  profileSessions?: SessionEntry[];
  activeSessionId: string | null;
  statusClass: string;
  onProfileClick: (id: string) => void;
  onConnect: (id: string, userId?: string) => void;
  onEditProfile: (id: string) => void;
  onDeleteClick: (id: string, name: string) => void;
  onSetActiveSession: (id: string) => void;
  onDisconnect: (id: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  connectingLabel: string;
  connectLabel: string;
}

function SortableProfileCard({
  profile: p,
  connected,
  connecting,
  hasActiveSessions,
  isExpanded,
  profileSessions,
  activeSessionId,
  statusClass,
  onProfileClick,
  onConnect,
  onEditProfile,
  onDeleteClick,
  onSetActiveSession,
  onDisconnect,
  t,
  connectingLabel,
  connectLabel,
}: SortableProfileCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: p.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  // Build subtitle based on number of users
  const isSingleUser = p.users.length <= 1;
  const defaultUser = p.users.find((u) => u.isDefault) ?? p.users[0];
  const subtitle = isSingleUser && defaultUser
    ? `${defaultUser.username || "?"}@${p.host}:${p.port}`
    : `${p.users.length} users · ${p.host}:${p.port}`;

  // User picker state (for multi-user connect)
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker when clicking outside
  useEffect(() => {
    if (!pickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pickerOpen]);

  // Which users already have an active session?
  const connectedUserIds = new Set(
    (profileSessions ?? [])
      .filter((s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating")
      .map((s) => s.userId)
      .filter(Boolean)
  );

  function handleConnectClick() {
    if (isSingleUser) {
      // Single user — connect directly (even if already connected, allows multiple sessions)
      onConnect(p.id);
    } else {
      // Multi-user — show picker
      setPickerOpen((prev) => !prev);
    }
  }

  function handlePickUser(userId: string) {
    setPickerOpen(false);
    onConnect(p.id, userId);
  }

  return (
    <div ref={setNodeRef} style={style}>
      {/* Profile card */}
      <div
        className={`sidebar-profile-card ${connected ? "sidebar-profile-card-connected" : ""}`}
        onClick={() => onProfileClick(p.id)}
        title={subtitle}
      >
        {/* Drag handle */}
        <div
          className="sidebar-drag-handle"
          {...attributes}
          {...listeners}
        >
          <span className="sidebar-drag-dots" />
        </div>

        <div className="sidebar-profile-card-left">
          <span className={`sidebar-chevron sidebar-profile-chevron ${isExpanded ? "" : "sidebar-chevron-collapsed"}`}>{"\u25BC"}</span>
          <span className={`sidebar-status-dot ${statusClass}`} />
          <div className="sidebar-profile-text">
            <div className="sidebar-profile-name">{p.name}</div>
            <div className="sidebar-profile-host">
              {subtitle}
            </div>
          </div>
        </div>
        <div
          className="sidebar-profile-card-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sidebar-connect-wrapper" ref={pickerRef}>
            <button
              className={`sidebar-profile-btn sidebar-profile-btn-connect ${connected ? "sidebar-profile-btn-add" : ""}`}
              onClick={handleConnectClick}
              disabled={connecting}
              title={connecting ? connectingLabel : connected ? t("sidebar.newSession") : connectLabel}
            >
              {connecting ? (
                <span className="sidebar-btn-spinner" />
              ) : connected ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
              )}
            </button>
            {/* User picker popover (multi-user profiles) */}
            {pickerOpen && !isSingleUser && (
              <div className="sidebar-user-picker">
                {p.users.map((u) => {
                  const isUserConnected = connectedUserIds.has(u.id);
                  return (
                    <button
                      key={u.id}
                      className={`sidebar-user-picker-item ${isUserConnected ? "sidebar-user-picker-item-connected" : ""}`}
                      onClick={() => handlePickUser(u.id)}
                    >
                      <span className="sidebar-user-picker-name">{u.username || "?"}</span>
                      <span className="sidebar-user-picker-auth">
                        {u.authMethod.type === "publicKey" ? "\uD83D\uDD11" : "\uD83D\uDD12"}
                      </span>
                      {isUserConnected && (
                        <span className="sidebar-user-picker-connected-dot" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            className="sidebar-profile-btn"
            onClick={() => onEditProfile(p.id)}
            title={t("sidebar.edit")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
          <button
            className="sidebar-profile-btn sidebar-profile-btn-delete"
            onClick={() => onDeleteClick(p.id, p.name)}
            title={t("sidebar.delete")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Nested sessions under profile (visible when expanded) */}
      {isExpanded && hasActiveSessions && profileSessions && (
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
                onClick={() => onSetActiveSession(s.id)}
              >
                <div className="sidebar-nested-session-left">
                  <SessionStateIndicator state={s.state} />
                  <div className="sidebar-nested-session-info">
                    <div className="sidebar-nested-session-host">
                      {s.username}@{s.host}
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
    reorderProfiles,
    exportProfiles,
    importProfiles,
  } = useProfileStore();
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [profilesCollapsed, setProfilesCollapsed] = useState(false);
  const [expandedProfiles, setExpandedProfiles] = useState<Set<string>>(new Set());

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

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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

  // Track which profiles we've already auto-expanded so we don't fight the user's collapse
  const autoExpandedRef = useRef<Set<string>>(new Set());

  // Auto-expand a profile only when it FIRST gets an active session
  useEffect(() => {
    const profilesWithSessions = new Set<string>();
    for (const [profileId, sess] of profileSessionMap) {
      if (sess.some((s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating")) {
        profilesWithSessions.add(profileId);
      }
    }
    // Only expand profiles we haven't auto-expanded before
    const toExpand: string[] = [];
    for (const id of profilesWithSessions) {
      if (!autoExpandedRef.current.has(id)) {
        toExpand.push(id);
        autoExpandedRef.current.add(id);
      }
    }
    // Clean up profiles that no longer have sessions
    for (const id of autoExpandedRef.current) {
      if (!profilesWithSessions.has(id)) {
        autoExpandedRef.current.delete(id);
      }
    }
    if (toExpand.length > 0) {
      setExpandedProfiles((prev) => {
        const next = new Set(prev);
        for (const id of toExpand) next.add(id);
        return next;
      });
    }
  }, [profileSessionMap]);

  // Filter profiles by search query (searches all usernames in users array)
  const filteredProfiles = useMemo(() => {
    if (!searchQuery.trim()) return profiles;
    const q = searchQuery.toLowerCase();
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.users.some((u) => u.username.toLowerCase().includes(q))
    );
  }, [profiles, searchQuery]);

  // DnD handler
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = filteredProfiles.findIndex((p) => p.id === active.id);
      const newIndex = filteredProfiles.findIndex((p) => p.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Build new order from the full profiles list
      const newProfiles = [...profiles];
      const activeProfile = newProfiles.find((p) => p.id === active.id);
      if (!activeProfile) return;

      // Remove the dragged profile and insert at new position
      const filteredIds = filteredProfiles.map((p) => p.id);
      const newFilteredIds = [...filteredIds];
      newFilteredIds.splice(oldIndex, 1);
      newFilteredIds.splice(newIndex, 0, active.id as string);

      // If search is active, only reorder within filtered results
      // but maintain positions of non-filtered profiles
      if (searchQuery.trim()) {
        const fullIds = newProfiles.map((p) => p.id);
        // Replace filtered IDs in their original positions
        let filterIdx = 0;
        const reorderedIds = fullIds.map((id) => {
          if (filteredIds.includes(id)) {
            return newFilteredIds[filterIdx++];
          }
          return id;
        }).filter((id): id is string => id !== undefined);
        void reorderProfiles(reorderedIds);
      } else {
        void reorderProfiles(newFilteredIds);
      }
    },
    [filteredProfiles, profiles, searchQuery, reorderProfiles]
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
    // Toggle expand/collapse
    setExpandedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }
      return next;
    });
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
          <svg className="sidebar-search-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
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
        </div>
        {!profilesCollapsed && (
          <div className="sidebar-actions-row">
            <button
              className="sidebar-action-btn sidebar-action-btn-labeled"
              onClick={() => void handleImportClick()}
              title={t("sidebar.import")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>{t("sidebar.importShort")}</span>
            </button>
            <button
              className="sidebar-action-btn sidebar-action-btn-labeled"
              onClick={() => handleExportClick()}
              title={t("sidebar.export")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>{t("sidebar.exportShort")}</span>
            </button>
            <button
              className="sidebar-action-btn sidebar-action-btn-labeled sidebar-action-btn-primary"
              onClick={() => onNewProfile()}
              title={t("sidebar.newProfile")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{t("sidebar.newProfileShort")}</span>
            </button>
          </div>
        )}

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

            {/* Profile cards with drag-and-drop */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={filteredProfiles.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                {filteredProfiles.map((p) => {
                  const connected = isProfileConnected(p.id);
                  const connecting = isProfileConnecting(p.id);
                  const profileSessions = profileSessionMap.get(p.id);
                  const hasActiveSessions =
                    profileSessions?.some(
                      (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
                    ) ?? false;

                  return (
                    <SortableProfileCard
                      key={p.id}
                      profile={p}
                      connected={connected}
                      connecting={connecting}
                      hasActiveSessions={hasActiveSessions}
                      isExpanded={expandedProfiles.has(p.id)}
                      profileSessions={profileSessions}
                      activeSessionId={activeSessionId}
                      statusClass={getProfileStatusClass(p.id)}
                      onProfileClick={handleProfileClick}
                      onConnect={onConnect}
                      onEditProfile={onEditProfile}
                      onDeleteClick={handleDeleteClick}
                      onSetActiveSession={setActiveSession}
                      onDisconnect={onDisconnect}
                      t={t}
                      connectingLabel={t("sidebar.connecting")}
                      connectLabel={t("sidebar.connect")}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
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

      {/* Active Sessions section removed — sessions now shown inline under each expanded profile */}

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
