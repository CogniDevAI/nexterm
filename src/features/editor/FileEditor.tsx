// features/editor/FileEditor.tsx — In-app file editor view
//
// Third top-level view alongside Terminal and Files.
// Features:
//   - Tab strip for multiple open documents (per session)
//   - Line-number gutter (monospace, scroll-synced)
//   - Save: button + Cmd/Ctrl+S keyboard shortcut
//   - Loading, error, saving states
//   - Empty state when no docs open

import { useCallback, useEffect, useRef, useMemo } from "react";
import { useEditorStore, isDocDirty } from "../../stores/editorStore";
import type { DocKey } from "../../stores/editorStore";
import type { SessionId } from "../../lib/types";
import { useFileEditor } from "./useFileEditor";
import { useI18n } from "../../lib/i18n";

interface FileEditorProps {
  sessionId: SessionId;
}

// ─── Gutter ─────────────────────────────────────────────

interface GutterProps {
  lineCount: number;
  scrollTop: number;
  lineHeight: number;
}

function LineGutter({ lineCount, scrollTop, lineHeight }: GutterProps) {
  const gutterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
  }, [scrollTop]);

  // Only render visible lines + a small buffer to avoid huge DOMs
  const lines = useMemo(() => {
    return Array.from({ length: Math.max(lineCount, 1) }, (_, i) => i + 1);
  }, [lineCount]);

  return (
    <div
      ref={gutterRef}
      className="editor-gutter"
      aria-hidden="true"
    >
      {lines.map((n) => (
        <div
          key={n}
          className="editor-gutter-line"
          style={{ height: lineHeight }}
        >
          {n}
        </div>
      ))}
    </div>
  );
}

// ─── FileEditor ──────────────────────────────────────────

export function FileEditor({ sessionId }: FileEditorProps) {
  const { t } = useI18n();
  const { loadDoc, saveDoc } = useFileEditor();

  // Select stable primitives — no fresh object refs (Zustand v5 loop guard)
  const docs = useEditorStore((s) => s.docs);
  const activeDocs = useEditorStore((s) => s.activeDocs);
  const { setContent, setActiveDoc, closeDoc } = useEditorStore.getState();

  // Stable: get this session's docs as a sorted list
  const sessionDocKeys = useMemo(() => {
    const keys: DocKey[] = [];
    docs.forEach((doc) => {
      if (doc.sessionId === sessionId) {
        keys.push(doc.key);
      }
    });
    return keys;
  }, [docs, sessionId]);

  const activeKey = activeDocs.get(sessionId) ?? null;
  const activeDoc = activeKey ? docs.get(activeKey) ?? null : null;

  // Textarea scroll state for gutter sync
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTopRef = useRef(0);

  // Load effect: fire when a doc transitions to loading=true
  useEffect(() => {
    if (!activeDoc || !activeDoc.loading) return;
    void loadDoc(activeDoc.key, activeDoc.sessionId, activeDoc.source, activeDoc.path);
  }, [activeDoc?.key, activeDoc?.loading, loadDoc]);

  // Keyboard shortcut: Cmd/Ctrl+S
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isSave = (e.metaKey || e.ctrlKey) && e.key === "s";
      if (!isSave) return;
      e.preventDefault();

      if (!activeDoc || activeDoc.loading || activeDoc.saving) return;
      if (!isDocDirty(activeDoc)) return;

      void saveDoc(
        activeDoc.key,
        activeDoc.sessionId,
        activeDoc.source,
        activeDoc.path,
        activeDoc.content,
      );
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeDoc, saveDoc]);

  const handleSave = useCallback(() => {
    if (!activeDoc || activeDoc.loading || activeDoc.saving) return;
    void saveDoc(
      activeDoc.key,
      activeDoc.sessionId,
      activeDoc.source,
      activeDoc.path,
      activeDoc.content,
    );
  }, [activeDoc, saveDoc]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (!activeKey) return;
      setContent(activeKey, e.target.value);
    },
    [activeKey, setContent],
  );

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLTextAreaElement>) => {
      scrollTopRef.current = e.currentTarget.scrollTop;
      // Force gutter re-sync by triggering a state-free rAF
      const el = e.currentTarget;
      const gutter = el.previousElementSibling as HTMLElement | null;
      if (gutter) {
        gutter.scrollTop = el.scrollTop;
      }
    },
    [],
  );

  const handleTabClick = useCallback(
    (key: DocKey) => {
      setActiveDoc(sessionId, key);
    },
    [sessionId, setActiveDoc],
  );

  const handleTabClose = useCallback(
    (e: React.MouseEvent, key: DocKey) => {
      e.stopPropagation();
      closeDoc(key, sessionId);
    },
    [sessionId, closeDoc],
  );

  // ── Empty state ──────────────────────────────────────
  if (sessionDocKeys.length === 0) {
    return (
      <div className="file-editor">
        <div className="editor-empty">
          <p>{t("editor.empty")}</p>
        </div>
      </div>
    );
  }

  // ── Line count for gutter ────────────────────────────
  const lineCount = activeDoc
    ? (activeDoc.content.match(/\n/g)?.length ?? 0) + 1
    : 1;

  // Approximate line height in px for gutter (monospace, fs-body = 13px, lh-body = 1.5)
  const LINE_HEIGHT_PX = 19; // 13 * 1.5 ≈ 19.5 → 19px avoids rounding drift

  const dirty = activeDoc ? isDocDirty(activeDoc) : false;

  return (
    <div className="file-editor">
      {/* Tab strip */}
      <div className="editor-tabs" role="tablist" aria-label="Open files">
        {sessionDocKeys.map((key) => {
          const doc = docs.get(key);
          if (!doc) return null;
          const isActive = key === activeKey;
          const isDirty = isDocDirty(doc);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`editor-tab${isActive ? " editor-tab-active" : ""}${isDirty ? " editor-tab-dirty" : ""}`}
              onClick={() => handleTabClick(key)}
            >
              <span className="editor-tab-name">
                {isDirty && <span className="editor-tab-dot" aria-hidden="true">●</span>}
                {doc.name}
              </span>
              <span className="editor-tab-source">{doc.source}</span>
              <button
                type="button"
                className="editor-tab-close"
                aria-label={t("editor.tabClose")}
                onClick={(e) => handleTabClose(e, key)}
              >
                ✕
              </button>
            </button>
          );
        })}
      </div>

      {/* Header bar */}
      {activeDoc && (
        <div className="editor-header">
          <span className="editor-header-path" title={activeDoc.path}>
            {activeDoc.path}
          </span>
          <span className={`editor-source-badge editor-source-badge-${activeDoc.source}`}>
            {activeDoc.source}
          </span>
          {dirty && !activeDoc.saving && (
            <span className="editor-dirty-label">{t("editor.unsaved")}</span>
          )}
          {activeDoc.saving && (
            <span className="editor-saving-label">{t("editor.saving")}</span>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={!dirty || activeDoc.loading || activeDoc.saving}
            aria-label={t("editor.save")}
          >
            {activeDoc.saving ? t("editor.saving") : t("editor.save")}
          </button>
        </div>
      )}

      {/* Editor body */}
      {activeDoc && (
        <div className="editor-body">
          {activeDoc.loading && (
            <div className="editor-status-overlay">
              <span className="editor-status-text">Loading…</span>
            </div>
          )}
          {activeDoc.error && (
            <div className="editor-error-overlay">
              <p className="editor-error-message">{activeDoc.error}</p>
              {(activeDoc.error.includes("Binary") || activeDoc.error.includes("binary")) && (
                <p className="editor-error-hint">{t("editor.binaryHint")}</p>
              )}
            </div>
          )}
          {!activeDoc.loading && !activeDoc.error && (
            <div className="editor-content-area">
              <LineGutter
                lineCount={lineCount}
                scrollTop={scrollTopRef.current}
                lineHeight={LINE_HEIGHT_PX}
              />
              <textarea
                ref={textareaRef}
                className="editor-textarea"
                value={activeDoc.content}
                onChange={handleChange}
                onScroll={handleScroll}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-label={`Editor: ${activeDoc.path}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
