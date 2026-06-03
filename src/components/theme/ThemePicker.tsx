// src/components/theme/ThemePicker.tsx — Theme picker popover for the StatusBar
//
// Replaces the binary toggle with a listbox-style dropdown that opens upward
// (StatusBar is at viewport bottom). Mirrors the lp-overflow-menu popover
// pattern from Sidebar.tsx.
//
// a11y: role=listbox/option, aria-selected, keyboard ArrowUp/Down+Enter+Escape.
// i18n: trigger aria-label uses "theme.picker" key; theme names are proper nouns.

import { useState, useEffect, useRef, useCallback } from "react";
import { useThemeStore } from "../../stores/themeStore";
import { THEMES, THEME_IDS } from "../../lib/themes";
import type { ThemeId } from "../../lib/themes";
import { useI18n } from "../../lib/i18n";

export function ThemePicker() {
  const { t } = useI18n();
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);

  const [open, setOpen] = useState(false);
  // Keyboard-focused index within the options list (0-based)
  const [focusedIdx, setFocusedIdx] = useState(0);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape (attached to document so it fires regardless of focus)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Seed focusedIdx to the current theme when opening
  const handleToggle = useCallback(() => {
    if (!open) {
      setFocusedIdx(THEME_IDS.indexOf(themeId));
    }
    setOpen((v) => !v);
  }, [open, themeId]);

  const handleSelect = useCallback(
    (id: ThemeId) => {
      setTheme(id);
      setOpen(false);
    },
    [setTheme],
  );

  const handleListboxKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(i + 1, THEME_IDS.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = THEME_IDS[focusedIdx];
        if (target !== undefined) handleSelect(target);
      }
    },
    [focusedIdx, handleSelect],
  );

  // Sync DOM focus to the focused option when focusedIdx changes
  useEffect(() => {
    if (!open || !listboxRef.current) return;
    const items = listboxRef.current.querySelectorAll<HTMLElement>("[role='option']");
    items[focusedIdx]?.focus();
  }, [focusedIdx, open]);

  return (
    <div className="theme-picker-wrapper" ref={wrapperRef}>
      <button
        className="statusbar-theme-toggle theme-picker-trigger"
        onClick={handleToggle}
        aria-label={t("theme.picker")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {THEMES[themeId].label}
      </button>

      {open && (
        <ul
          ref={listboxRef}
          role="listbox"
          aria-label={t("theme.picker")}
          className="theme-picker-menu"
          onKeyDown={handleListboxKeyDown}
          tabIndex={-1}
        >
          {THEME_IDS.map((id, idx) => {
            const preset = THEMES[id];
            const isSelected = id === themeId;
            const isFocused = idx === focusedIdx;
            return (
              <li
                key={id}
                role="option"
                aria-selected={isSelected}
                tabIndex={isFocused ? 0 : -1}
                className={[
                  "theme-picker-option",
                  isSelected ? "theme-picker-option-selected" : "",
                ].join(" ").trim()}
                onClick={() => handleSelect(id)}
                onMouseEnter={() => setFocusedIdx(idx)}
              >
                <span className="theme-picker-option-label">{preset.label}</span>
                <span className="theme-picker-swatches" aria-hidden="true">
                  <span
                    className="theme-picker-swatch"
                    style={{ background: preset.terminalTheme.background }}
                    title="bg"
                  />
                  <span
                    className="theme-picker-swatch"
                    style={{ background: preset.terminalTheme.foreground }}
                    title="fg"
                  />
                  <span
                    className="theme-picker-swatch"
                    style={{ background: preset.terminalTheme.cursor }}
                    title="accent"
                  />
                  <span
                    className="theme-picker-swatch"
                    style={{
                      background: (preset.terminalTheme.selectionBackground ?? "#3c2918a6")
                        .replace(/[a-f0-9]{2}$/, "ff"),
                    }}
                    title="selection"
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
