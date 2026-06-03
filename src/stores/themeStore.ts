// src/stores/themeStore.ts — Persisted theme selection (Zustand)
//
// Dependency direction: themeStore -> useTerminal (one-way, design decision D4).
// useTerminal NEVER imports themeStore at module top; it reads getState() lazily
// inside openTerminal (runtime, not module-eval time).

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type ThemeId, DEFAULT_THEME_ID, THEMES, isThemeId } from "../lib/themes";
import { applyThemeToAllTerminals } from "../features/terminal/useTerminal";

interface ThemeStoreState {
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
}

/**
 * Applies theme side-effects: updates the CSS [data-theme] attribute on <html>
 * and re-colors all live xterm terminal instances.
 *
 * LAMPLIGHT is the CSS default — its data-theme attribute is REMOVED rather than set,
 * so the default :root {} block applies without any attribute selector overhead.
 *
 * Exported so ThemeProvider can call it on mount (idempotent with the FOUC inline script).
 */
export function applyThemeSideEffects(id: ThemeId): void {
  if (id === DEFAULT_THEME_ID) {
    // LAMPLIGHT is the CSS default: no [data-theme] attribute needed or wanted.
    // Spec: "no [data-theme] attribute for LAMPLIGHT"
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = id;
  }
  applyThemeToAllTerminals(THEMES[id].terminalTheme);
}

export const useThemeStore = create<ThemeStoreState>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME_ID,
      setTheme: (id) => {
        if (!isThemeId(id)) return;
        set({ themeId: id });
        applyThemeSideEffects(id);
      },
    }),
    {
      name: "nexterm-theme",
      partialize: (s) => ({ themeId: s.themeId }),
      // version: 0 (Zustand default) — matches workspaceStore convention
      // INVARIANT: themeId is always at path .state.themeId in the persisted JSON.
      // The FOUC inline script in index.html reads this path; keep it stable.
      //
      // MAJOR-3: validate rehydrated themeId — reject unknown values (e.g., "blue")
      // and fall back to DEFAULT_THEME_ID so a corrupt store never crashes.
      merge: (persisted, current) => {
        const p = persisted as Partial<ThemeStoreState>;
        const themeId = isThemeId(p?.themeId) ? p.themeId : DEFAULT_THEME_ID;
        return { ...current, themeId };
      },
    },
  ),
);
