// components/layout/StatusBar.tsx — Bottom status bar with language switcher

import { useSessionStore } from "../../stores/sessionStore";
import { useI18n, type Locale } from "../../lib/i18n";

export function StatusBar() {
  const { t, locale, setLocale } = useI18n();
  const { sessions } = useSessionStore();

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
