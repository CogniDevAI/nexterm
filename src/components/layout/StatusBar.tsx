// components/layout/StatusBar.tsx — Bottom status bar with language switcher + update badge

import { useSessionStore } from "../../stores/sessionStore";
import { useUpdateStore } from "../../stores/updateStore";
import { useI18n, type Locale } from "../../lib/i18n";

interface StatusBarProps {
  onStartTour?: () => void;
}

export function StatusBar({ onStartTour }: StatusBarProps) {
  const { t, locale, setLocale } = useI18n();
  const { sessions } = useSessionStore();
  const { status, isCritical } = useUpdateStore();

  // Show badge when user dismissed a normal update
  const showUpdateBadge = status === "dismissed" && !isCritical;

  const connectedCount = Array.from(sessions.values()).filter(
    (s) => s.state === "connected",
  ).length;

  const totalTerminals = Array.from(sessions.values()).reduce(
    (sum, s) => sum + s.terminals.length,
    0,
  );

  const toggleLocale = () => {
    setLocale(locale === "en" ? "es" : "en" as Locale);
  };

  const handleUpdateBadgeClick = () => {
    // Re-open the update dialog by setting status back to available
    useUpdateStore.getState().setStatus("available");
  };

  return (
    <footer className="statusbar">
      <span className="statusbar-item">
        {connectedCount !== 1
          ? t("status.connections", { count: connectedCount })
          : t("status.connection", { count: connectedCount })}
      </span>
      <span className="statusbar-item">
        {totalTerminals !== 1
          ? t("status.terminals", { count: totalTerminals })
          : t("status.terminal", { count: totalTerminals })}
      </span>
      <div className="statusbar-spacer" />
      {showUpdateBadge && (
        <button
          className="statusbar-update-badge"
          onClick={handleUpdateBadgeClick}
          title={t("update.statusBadge")}
        >
          <span className="statusbar-update-dot" />
          {t("update.statusBadge")}
        </button>
      )}
      {onStartTour && (
        <button
          className="statusbar-help-btn"
          onClick={onStartTour}
          title={t("tour.helpButton")}
        >
          ?
        </button>
      )}
      <button
        className="statusbar-lang-toggle"
        onClick={toggleLocale}
        title={t("settings.language")}
      >
        {t(`settings.${locale}`)}
      </button>
    </footer>
  );
}
