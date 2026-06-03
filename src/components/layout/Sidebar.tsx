// components/layout/Sidebar.tsx — Left sidebar with profiles and active sessions
//
// LAMPLIGHT STEP 2: Redesigned profile rows, status dots, keyboard nav, group headers.

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

// ─── Middle-ellipsis helper ───────────────────────────────
// CSS text-overflow: ellipsis drops the END (port disappears).
// This splits host:port so the port is always visible.
function middleEllipsis(str: string, maxLen = 30): string {
  if (str.length <= maxLen) return str;
  // Try to preserve the :port suffix
  const portMatch = str.match(/:(\d+)$/);
  if (portMatch) {
    const portSuffix = portMatch[0]; // e.g. ":22"
    const host = str.slice(0, str.length - portSuffix.length);
    const availableForHost = maxLen - portSuffix.length - 1; // 1 for ellipsis
    if (availableForHost > 4) {
      return host.slice(0, availableForHost) + "…" + portSuffix;
    }
  }
  return str.slice(0, maxLen - 1) + "…";
}

// ─── Client-side group derivation ─────────────────────────
// Folder-first grouping: profile.folder takes priority; deriveGroup is the
// fallback for profiles without an explicit folder assignment.
// Logic is extracted to sidebarGrouping.ts for testability.
import { groupProfiles, isLegacyGroupKey } from "./sidebarGrouping";
import type { ProfileGroup } from "./sidebarGrouping";
type GroupKey = string;

// ─── Session elapsed time ─────────────────────────────────
function formatElapsed(connectedAt: number): string {
  const ms = Date.now() - connectedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
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
      {"▼"}
    </span>
  );
}

// ─── Status dot ───────────────────────────────────────────
// idle = hollow ring (text-faint), connecting = copper pulse, live = jade
function StatusDot({ connected, connecting }: { connected: boolean; connecting: boolean }) {
  if (connected) return <span className="lp-status-dot lp-status-dot-live" />;
  if (connecting) return <span className="lp-status-dot lp-status-dot-connecting" />;
  return <span className="lp-status-dot lp-status-dot-idle" />;
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
  onProfileClick: (id: string) => void;
  onConnect: (id: string, userId?: string) => void;
  onEditProfile: (id: string) => void;
  onDeleteClick: (id: string, name: string) => void;
  onSetActiveSession: (id: string) => void;
  onDisconnect: (id: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  connectingLabel: string;
  connectLabel: string;
  isFocused: boolean;
}

function SortableProfileCard({
  profile: p,
  connected,
  connecting,
  hasActiveSessions,
  isExpanded,
  profileSessions,
  activeSessionId,
  onProfileClick,
  onConnect,
  onEditProfile,
  onDeleteClick,
  onSetActiveSession,
  onDisconnect,
  t,
  connectingLabel,
  connectLabel,
  isFocused,
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

  // Build subtitle: for single-user show user@host:port; for multi show "N credentials · host"
  const isSingleUser = p.users.length <= 1;
  const defaultUser = p.users.find((u) => u.isDefault) ?? p.users[0];

  const rawSubtitle = isSingleUser && defaultUser
    ? `${defaultUser.username || "?"}@${p.host}:${p.port}`
    : `${p.host}:${p.port}`;

  const subtitle = middleEllipsis(rawSubtitle, 32);

  const credentialBadge = !isSingleUser
    ? t("sidebar.credentials", { n: p.users.length })
    : null;

  // Find live sessions for this profile to show elapsed time
  const liveSession = connected
    ? profileSessions?.find((s) => s.state === "connected")
    : undefined;

  // User picker state (for multi-user connect)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Close picker or overflow when clicking outside
  useEffect(() => {
    if (!pickerOpen && !overflowOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pickerOpen, overflowOpen]);

  // Which users already have an active session?
  const connectedUserIds = new Set(
    (profileSessions ?? [])
      .filter((s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating")
      .map((s) => s.userId)
      .filter(Boolean)
  );

  function handleConnectClick() {
    if (isSingleUser) {
      onConnect(p.id);
    } else {
      setPickerOpen((prev) => !prev);
    }
  }

  function handlePickUser(userId: string) {
    setPickerOpen(false);
    onConnect(p.id, userId);
  }

  // Live row shows elapsed time instead of connect button prominence
  const elapsedLabel = liveSession ? formatElapsed(liveSession.connectedAt) : null;

  // Does this profile own the session currently shown in the terminal? That is
  // the "you are here" marker, distinct from the transient keyboard focus.
  const ownsActiveSession =
    !!activeSessionId && (profileSessions?.some((s) => s.id === activeSessionId) ?? false);

  return (
    <div ref={setNodeRef} style={style}>
      {/* Profile card */}
      <div
        className={[
          "lp-profile-row",
          connected ? "lp-profile-row-live" : "",
          connecting ? "lp-profile-row-connecting" : "",
          ownsActiveSession ? "lp-profile-row-active" : "",
          isFocused ? "lp-profile-row-focused" : "",
        ].filter(Boolean).join(" ")}
        role="listitem"
        onClick={() => onProfileClick(p.id)}
        title={`${p.name} — ${rawSubtitle}`}
        tabIndex={-1}
      >
        {/* Drag handle (hidden until hover) */}
        <div
          className="lp-drag-handle"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="lp-drag-dots" />
        </div>

        {/* Chevron for expand/collapse */}
        <span className={`sidebar-chevron sidebar-profile-chevron ${isExpanded ? "" : "sidebar-chevron-collapsed"}`}>
          {"▼"}
        </span>

        {/* Status dot */}
        <StatusDot connected={connected} connecting={connecting} />

        {/* Text block */}
        <div className="lp-profile-text">
          <div className="lp-profile-name">{p.name}</div>
          <div className="lp-profile-meta">
            {credentialBadge && (
              <span className="lp-credential-badge">{credentialBadge}</span>
            )}
            <span className="lp-profile-host" title={rawSubtitle}>{subtitle}</span>
          </div>
        </div>

        {/* Right side: elapsed time for live sessions, action buttons */}
        <div className="lp-profile-actions" onClick={(e) => e.stopPropagation()}>
          {connected && elapsedLabel && (
            <span className="lp-elapsed">{elapsedLabel}</span>
          )}

          {/* Connect button — always visible */}
          <div className="lp-connect-wrapper" ref={pickerRef}>
            <button
              className={`lp-action-btn lp-action-btn-connect ${connected ? "lp-action-btn-add" : ""}`}
              onClick={handleConnectClick}
              disabled={connecting}
              title={connecting ? connectingLabel : connected ? t("sidebar.newSession") : connectLabel}
              tabIndex={-1}
            >
              {connecting ? (
                <span className="lp-spinner" />
              ) : connected ? (
                // Plus icon for new session when already connected
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              ) : (
                // Play/Enter glyph for connect
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
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
                        {u.authMethod.type === "publicKey" ? "🔑" : "🔒"}
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

          {/* Overflow menu (edit / delete) — hidden until hover */}
          <div className="lp-overflow-wrapper" ref={overflowRef}>
            <button
              className="lp-action-btn lp-action-btn-overflow"
              onClick={() => setOverflowOpen((prev) => !prev)}
              title={t("sidebar.overflow")}
              tabIndex={-1}
            >
              <span className="lp-overflow-dots">&#xB7;&#xB7;&#xB7;</span>
            </button>
            {overflowOpen && (
              <div className="lp-overflow-menu">
                <button
                  className="lp-overflow-item"
                  onClick={() => { setOverflowOpen(false); onEditProfile(p.id); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                  {t("sidebar.edit")}
                </button>
                <button
                  className="lp-overflow-item lp-overflow-item-danger"
                  onClick={() => { setOverflowOpen(false); onDeleteClick(p.id, p.name); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4h6v2" />
                  </svg>
                  {t("sidebar.delete")}
                </button>
              </div>
            )}
          </div>
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
                  {"⏻"}
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Group header ─────────────────────────────────────────

function GroupHeader({
  groupKey,
  count,
  t,
}: {
  groupKey: GroupKey;
  count: number;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  // Legacy heuristic keys map to i18n; user-assigned folder names render verbatim (uppercased).
  const label = isLegacyGroupKey(groupKey)
    ? t(`sidebar.group.${groupKey}` as TranslationKey)
    : groupKey.toUpperCase();

  return (
    <div className="lp-group-header">
      <span className="lp-group-label">{label}</span>
      <span className="lp-group-count">{count}</span>
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

  // Keyboard navigation: focused row index within filteredProfiles
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
      if (!path) return;
      const filePath = path as string;

      if (filePath.endsWith(".nexterm")) {
        setImportPassword("");
        setImportError(null);
        setImportLoading(false);
        setImportPasswordDialog(filePath);
        return;
      }

      const result = await importProfiles(filePath);
      setBanner({
        type: "success",
        message: t("sidebar.importSuccess", {
          imported: result.imported,
          skipped: result.skipped,
        }),
      });
    } catch {
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

  // Track which profiles we've already auto-expanded
  const autoExpandedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const profilesWithSessions = new Set<string>();
    for (const [profileId, sess] of profileSessionMap) {
      if (sess.some((s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating")) {
        profilesWithSessions.add(profileId);
      }
    }
    const toExpand: string[] = [];
    for (const id of profilesWithSessions) {
      if (!autoExpandedRef.current.has(id)) {
        toExpand.push(id);
        autoExpandedRef.current.add(id);
      }
    }
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

  // Filter profiles by search query
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

  // Group the filtered profiles (only group when not searching)
  const profileGroups = useMemo(() => {
    if (searchQuery.trim()) {
      // When searching, show flat list under the generic "PROFILES" bucket
      return filteredProfiles.length > 0
        ? [{ key: "other", profiles: filteredProfiles } satisfies ProfileGroup]
        : [];
    }
    return groupProfiles(filteredProfiles);
  }, [filteredProfiles, searchQuery]);

  // DnD handler
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = filteredProfiles.findIndex((p) => p.id === active.id);
      const newIndex = filteredProfiles.findIndex((p) => p.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const newProfiles = [...profiles];
      const filteredIds = filteredProfiles.map((p) => p.id);
      const newFilteredIds = [...filteredIds];
      newFilteredIds.splice(oldIndex, 1);
      newFilteredIds.splice(newIndex, 0, active.id as string);

      if (searchQuery.trim()) {
        const fullIds = newProfiles.map((p) => p.id);
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
    const ps = profileSessionMap.get(profileId);
    const hasActive =
      ps?.some(
        (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
      ) ?? false;
    setDeleteConfirm({ profileId, profileName, hasActiveSession: hasActive });
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return;
    setDeleteLoading(true);
    try {
      if (deleteConfirm.hasActiveSession) {
        const ps = profileSessionMap.get(deleteConfirm.profileId);
        const activeSess = ps?.filter(
          (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
        ) ?? [];
        for (const s of activeSess) onDisconnect(s.id);
        await new Promise((r) => setTimeout(r, 300));
      }
      await deleteProfile(deleteConfirm.profileId);
      setDeleteConfirm(null);
    } catch {
      try {
        const ps = profileSessionMap.get(deleteConfirm.profileId);
        const activeSess = ps?.filter(
          (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
        ) ?? [];
        for (const s of activeSess) onDisconnect(s.id);
        await new Promise((r) => setTimeout(r, 500));
        await deleteProfile(deleteConfirm.profileId);
        setDeleteConfirm(null);
      } catch {
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
    const ps = profileSessionMap.get(profileId);
    return ps?.some((s) => s.state === "connected") ?? false;
  }

  function handleProfileClick(profileId: string) {
    setExpandedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }
      return next;
    });
    // Also move keyboard focus to this profile
    const idx = filteredProfiles.findIndex((p) => p.id === profileId);
    if (idx !== -1) setFocusedIndex(idx);
  }

  // Keyboard navigation on the list container
  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const len = filteredProfiles.length;
    if (len === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => {
        if (prev === null) return 0;
        return Math.min(prev + 1, len - 1);
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => {
        if (prev === null) return len - 1;
        return Math.max(prev - 1, 0);
      });
    } else if (e.key === "Enter" && focusedIndex !== null) {
      e.preventDefault();
      const p = filteredProfiles[focusedIndex];
      if (p) onConnect(p.id);
    } else if (e.key === "e" && focusedIndex !== null) {
      e.preventDefault();
      const p = filteredProfiles[focusedIndex];
      if (p) onEditProfile(p.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && focusedIndex !== null) {
      e.preventDefault();
      const p = filteredProfiles[focusedIndex];
      if (p) handleDeleteClick(p.id, p.name);
    }
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

          {/* Profile list with groups and keyboard navigation */}
          {!loading && filteredProfiles.length > 0 && (
            <div
              className="lp-profile-list"
              ref={listRef}
              role="list"
              tabIndex={0}
              onKeyDown={handleListKeyDown}
              aria-label={t("sidebar.profiles")}
            >
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={filteredProfiles.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {profileGroups.map((group, groupIdx) => (
                    <div
                      key={group.key}
                      className={`lp-group ${groupIdx > 0 ? "lp-group-gap" : ""}`}
                    >
                      {/* Only show group header when there are multiple groups */}
                      {profileGroups.length > 1 && (
                        <GroupHeader
                          groupKey={group.key}
                          count={group.profiles.length}
                          t={t}
                        />
                      )}
                      {group.profiles.map((p) => {
                        const connected = isProfileConnected(p.id);
                        const connecting = isProfileConnecting(p.id);
                        const ps = profileSessionMap.get(p.id);
                        const hasActiveSessions =
                          ps?.some(
                            (s) => s.state === "connected" || s.state === "connecting" || s.state === "authenticating"
                          ) ?? false;
                        const globalIdx = filteredProfiles.findIndex((fp) => fp.id === p.id);

                        return (
                          <SortableProfileCard
                            key={p.id}
                            profile={p}
                            connected={connected}
                            connecting={connecting}
                            hasActiveSessions={hasActiveSessions}
                            isExpanded={expandedProfiles.has(p.id)}
                            profileSessions={ps}
                            activeSessionId={activeSessionId}
                            onProfileClick={handleProfileClick}
                            onConnect={onConnect}
                            onEditProfile={onEditProfile}
                            onDeleteClick={handleDeleteClick}
                            onSetActiveSession={setActiveSession}
                            onDisconnect={onDisconnect}
                            t={t}
                            connectingLabel={t("sidebar.connecting")}
                            connectLabel={t("sidebar.connect")}
                            isFocused={focusedIndex === globalIdx}
                          />
                        );
                      })}
                    </div>
                  ))}
                </SortableContext>
              </DndContext>
            </div>
          )}
        </div>

        {/* Export/import feedback banner */}
        {banner && (
          <div
            className={`sidebar-banner ${banner.type === "success" ? "sidebar-banner-success" : "sidebar-banner-error"}`}
            onClick={() => setBanner(null)}
            title={t("general.close")}
          >
            {banner.type === "success" ? "✓ " : ""}{banner.message}
          </div>
        )}

        {/* Error feedback inline in sidebar */}
        {connectError && (
          <div className="sidebar-error" onClick={onClearError} title={t("general.close")}>
            {connectError}
          </div>
        )}
      </div>

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
              <div className="delete-confirm-icon">{"⚠"}</div>
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
