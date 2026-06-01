// components/layout/TabBar.tsx — Feature tab bar (Terminal / SFTP / Tunnels)

import { useRef } from "react";
import {
  useSessionStore,
} from "../../stores/sessionStore";
import type { ActiveFeature } from "../../lib/types";
import { useI18n, type TranslationKey } from "../../lib/i18n";

const FEATURES: { key: ActiveFeature; labelKey: TranslationKey }[] = [
  { key: "terminal", labelKey: "tabbar.terminal" },
  { key: "sftp", labelKey: "tabbar.sftp" },
  { key: "tunnel", labelKey: "tabbar.tunnels" },
];

export function TabBar() {
  const { t } = useI18n();
  const { activeFeature, setActiveFeature, activeSessionId } =
    useSessionStore();

  // Roving-tabindex refs so keyboard navigation can move DOM focus.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!activeSessionId) return null;

  function selectByIndex(index: number) {
    const feature = FEATURES[index];
    if (!feature) return;
    setActiveFeature(feature.key);
    tabRefs.current[index]?.focus();
  }

  // WAI-ARIA tabs keyboard pattern: ArrowLeft/Right move (no wrap),
  // Home → first, End → last. Selection follows focus to match click behavior.
  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        selectByIndex(Math.min(index + 1, FEATURES.length - 1));
        break;
      case "ArrowLeft":
        e.preventDefault();
        selectByIndex(Math.max(index - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        selectByIndex(0);
        break;
      case "End":
        e.preventDefault();
        selectByIndex(FEATURES.length - 1);
        break;
    }
  }

  return (
    <div className="tabbar" role="tablist">
      {FEATURES.map((f, i) => {
        const isActive = activeFeature === f.key;
        return (
          <button
            key={f.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`tabbar-tab ${isActive ? "tabbar-tab-active" : ""}`}
            onClick={() => setActiveFeature(f.key)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            {t(f.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
