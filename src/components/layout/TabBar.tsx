// components/layout/TabBar.tsx — Feature tab bar (Terminal / SFTP / Tunnels)

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

  if (!activeSessionId) return null;

  return (
    <div className="tabbar">
      {FEATURES.map((f) => (
        <button
          key={f.key}
          className={`tabbar-tab ${activeFeature === f.key ? "tabbar-tab-active" : ""}`}
          onClick={() => setActiveFeature(f.key)}
        >
          {t(f.labelKey)}
        </button>
      ))}
    </div>
  );
}
