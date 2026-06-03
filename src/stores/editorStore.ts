// stores/editorStore.ts — In-app file editor state (no persist)
//
// Tracks open documents per session. Each doc is keyed by
// `${sessionId}:${source}:${path}` — a stable unique identifier.
//
// Zustand v5 caution: selectors MUST NOT return fresh object/array literals
// on every call (causes infinite-render loops). All selectors return primitive
// slices or stable Map references. Consumers derive dirty = content !== savedContent
// outside the selector.

import { create } from "zustand";
import type { SessionId } from "../lib/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DocSource = "local" | "remote";

/** Unique key for a document: `${sessionId}:${source}:${path}` */
export type DocKey = string;

export interface EditorDoc {
  key: DocKey;
  sessionId: SessionId;
  source: DocSource;
  path: string;
  name: string;
  /** Current text content (edited, possibly unsaved). */
  content: string;
  /** Content as of last save/load — used to compute dirty state. */
  savedContent: string;
  loading: boolean;
  error: string | null;
  saving: boolean;
}

// ─── Key builder ─────────────────────────────────────────────────────────────

export function buildDocKey(sessionId: SessionId, source: DocSource, path: string): DocKey {
  return `${sessionId}:${source}:${path}`;
}

// ─── Convenience helper (derive dirty outside selectors) ─────────────────────

export function isDocDirty(doc: EditorDoc): boolean {
  return doc.content !== doc.savedContent;
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface OpenDocParams {
  sessionId: SessionId;
  source: DocSource;
  path: string;
  name: string;
}

interface EditorStoreState {
  /** All open documents, keyed by DocKey. */
  docs: Map<DocKey, EditorDoc>;
  /** Per-session active doc key. null = session has no active doc. */
  activeDocs: Map<SessionId, DocKey | null>;

  /** Open a document. Dedupes by key — if already open, just activates it. */
  openDoc: (params: OpenDocParams) => void;
  /** Update the editable content of a doc. */
  setContent: (key: DocKey, content: string) => void;
  /** Mark a doc as saved. Sets savedContent and clears saving/error. */
  markSaved: (key: DocKey, savedContent: string) => void;
  /** Set/clear the saving spinner flag. */
  setSaving: (key: DocKey, saving: boolean) => void;
  /** Record an error (load or save failure). */
  setError: (key: DocKey, error: string | null) => void;
  /** Set loading state (used during initial fetch). */
  setLoading: (key: DocKey, loading: boolean) => void;
  /** Close a doc. Picks a sane next active for the session. */
  closeDoc: (key: DocKey, sessionId: SessionId) => void;
  /** Explicitly set the active doc for a session. */
  setActiveDoc: (sessionId: SessionId, key: DocKey | null) => void;
}

export const useEditorStore = create<EditorStoreState>()((set, get) => ({
  docs: new Map(),
  activeDocs: new Map(),

  openDoc: ({ sessionId, source, path, name }) => {
    const key = buildDocKey(sessionId, source, path);
    const state = get();

    if (state.docs.has(key)) {
      // Already open — just make it active
      const newActiveDocs = new Map(state.activeDocs);
      newActiveDocs.set(sessionId, key);
      set({ activeDocs: newActiveDocs });
      return;
    }

    const newDoc: EditorDoc = {
      key,
      sessionId,
      source,
      path,
      name,
      content: "",
      savedContent: "",
      loading: true,
      error: null,
      saving: false,
    };

    const newDocs = new Map(state.docs);
    newDocs.set(key, newDoc);

    const newActiveDocs = new Map(state.activeDocs);
    newActiveDocs.set(sessionId, key);

    set({ docs: newDocs, activeDocs: newActiveDocs });
  },

  setContent: (key, content) => {
    const state = get();
    const doc = state.docs.get(key);
    if (!doc) return;
    const newDocs = new Map(state.docs);
    newDocs.set(key, { ...doc, content });
    set({ docs: newDocs });
  },

  markSaved: (key, savedContent) => {
    const state = get();
    const doc = state.docs.get(key);
    if (!doc) return;
    const newDocs = new Map(state.docs);
    newDocs.set(key, { ...doc, savedContent, saving: false, error: null });
    set({ docs: newDocs });
  },

  setSaving: (key, saving) => {
    const state = get();
    const doc = state.docs.get(key);
    if (!doc) return;
    const newDocs = new Map(state.docs);
    newDocs.set(key, { ...doc, saving });
    set({ docs: newDocs });
  },

  setError: (key, error) => {
    const state = get();
    const doc = state.docs.get(key);
    if (!doc) return;
    const newDocs = new Map(state.docs);
    newDocs.set(key, { ...doc, error, loading: false, saving: false });
    set({ docs: newDocs });
  },

  setLoading: (key, loading) => {
    const state = get();
    const doc = state.docs.get(key);
    if (!doc) return;
    const newDocs = new Map(state.docs);
    newDocs.set(key, { ...doc, loading });
    set({ docs: newDocs });
  },

  closeDoc: (key, sessionId) => {
    const state = get();
    if (!state.docs.has(key)) return;

    const newDocs = new Map(state.docs);
    newDocs.delete(key);

    // Find the next active doc for this session
    const sessionDocs = Array.from(newDocs.values()).filter(
      (d) => d.sessionId === sessionId,
    );

    const newActiveDocs = new Map(state.activeDocs);
    if (sessionDocs.length === 0) {
      newActiveDocs.set(sessionId, null);
    } else {
      // Pick last remaining doc for this session
      const next = sessionDocs[sessionDocs.length - 1]!;
      newActiveDocs.set(sessionId, next.key);
    }

    set({ docs: newDocs, activeDocs: newActiveDocs });
  },

  setActiveDoc: (sessionId, key) => {
    const state = get();
    const newActiveDocs = new Map(state.activeDocs);
    newActiveDocs.set(sessionId, key);
    set({ activeDocs: newActiveDocs });
  },
}));
