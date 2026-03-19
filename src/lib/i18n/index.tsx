// lib/i18n/index.tsx — Lightweight i18n system (context + hook)

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import { en, type TranslationKey } from "./en";
import { es } from "./es";

export type { TranslationKey };
export type Locale = "en" | "es";

const translations: Record<Locale, Record<TranslationKey, string>> = { en, es };

type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface I18nContextValue {
  t: TranslateFn;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectLocale(): Locale {
  // 1. Check localStorage
  const stored = localStorage.getItem("locale");
  if (stored === "en" || stored === "es") return stored;

  // 2. Check browser/OS language
  const browserLang = navigator.language?.split("-")[0];
  if (browserLang === "es") return "es";

  // 3. Default to English
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const t: TranslateFn = useCallback(
    (key, params) => {
      const dict = translations[locale] ?? translations.en;
      let text = dict[key] ?? translations.en[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
    [locale],
  );

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem("locale", newLocale);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({ t, locale, setLocale }), [t, locale, setLocale]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
