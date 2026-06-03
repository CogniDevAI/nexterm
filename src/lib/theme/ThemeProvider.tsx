// src/lib/theme/ThemeProvider.tsx — Applies [data-theme] on mount and on theme changes.
//
// The FOUC inline script in index.html sets data-theme synchronously before React
// mounts (using the same Zustand persist envelope parse logic). ThemeProvider is
// idempotent with that script: it re-applies the same value on mount (no flicker)
// and keeps data-theme in sync when the user switches themes at runtime.

import { useEffect, type ReactNode } from "react";
import { useThemeStore } from "../../stores/themeStore";
import { applyThemeSideEffects } from "../../stores/themeStore";

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const themeId = useThemeStore((s) => s.themeId);

  // Apply on every themeId change (including initial mount).
  // This is idempotent with the inline FOUC script.
  useEffect(() => {
    applyThemeSideEffects(themeId);
  }, [themeId]);

  return <>{children}</>;
}
