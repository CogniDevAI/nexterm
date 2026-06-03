// stores/snippetStore.ts — Persisted snippet library (Zustand persist)
//
// Key: "nexterm-snippets"
// Pattern mirrors themeStore.ts: persist + partialize + merge validator.
//
// SECURITY: partialize ensures only Snippet[] (templates) are persisted.
// Resolved variable VALUES (especially password-type) must NEVER reach this store.
// The SnippetVariableModal holds runtime values in local React state only and
// discards them after calling useSnippetInject — they never enter Zustand state.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Snippet {
  id: string;
  name: string;
  template: string;
  folder?: string;
  tags?: string[];
  favorite: boolean;
  createdAt: number; // Date.now()
  updatedAt: number;
}

interface SnippetStoreState {
  snippets: Snippet[];
  addSnippet: (s: Omit<Snippet, "id" | "createdAt" | "updatedAt">) => void;
  updateSnippet: (id: string, changes: Partial<Snippet>) => void;
  deleteSnippet: (id: string) => void;
  reorderSnippets: (ids: string[]) => void;
}

function isValidSnippet(s: unknown): s is Snippet {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    o.name.length > 0 &&
    typeof o.template === "string"
  );
}

export const useSnippetStore = create<SnippetStoreState>()(
  persist(
    (set) => ({
      snippets: [],

      addSnippet: (s) => {
        const now = Date.now();
        const newSnippet: Snippet = {
          ...s,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ snippets: [...state.snippets, newSnippet] }));
      },

      updateSnippet: (id, changes) => {
        set((state) => ({
          snippets: state.snippets.map((s) =>
            s.id === id ? { ...s, ...changes, updatedAt: Date.now() } : s,
          ),
        }));
      },

      deleteSnippet: (id) => {
        set((state) => ({
          snippets: state.snippets.filter((s) => s.id !== id),
        }));
      },

      reorderSnippets: (ids) => {
        set((state) => {
          const map = new Map(state.snippets.map((s) => [s.id, s]));
          const reordered = ids.flatMap((id) => {
            const s = map.get(id);
            return s ? [s] : [];
          });
          return { snippets: reordered };
        });
      },
    }),
    {
      name: "nexterm-snippets",
      // SECURITY: only persist the snippets array (Snippet objects contain templates only).
      // No runtime/resolved values ever reach localStorage.
      partialize: (s) => ({ snippets: s.snippets }),
      // MAJOR-3 pattern from themeStore: validate rehydrated data to reject corrupt entries.
      merge: (persisted, current) => {
        const p = persisted as { snippets?: unknown[] } | null | undefined;
        const raw = Array.isArray(p?.snippets) ? p.snippets : [];
        const validSnippets = raw.filter(isValidSnippet);
        return { ...current, snippets: validSnippets };
      },
    },
  ),
);
