// a11y invariant: I18nProvider keeps document.documentElement.lang in sync with
// the active locale (mount + on change), so screen readers announce content in
// the correct language.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider, useI18n } from "./index";

// This jsdom config has a non-functional localStorage (setItem throws); i18n
// reads/writes the "locale" key. Force an in-memory stub so it works.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

function LocaleProbe() {
  const { locale, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale("es")}>to-es</button>
      <button onClick={() => setLocale("en")}>to-en</button>
    </div>
  );
}

describe("I18nProvider — html lang sync", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("lang");
  });

  it("sets document.documentElement.lang to the active locale on mount", () => {
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe(
      screen.getByTestId("locale").textContent,
    );
    // Default detect resolves to 'en' in jsdom.
    expect(document.documentElement.lang).toBe("en");
  });

  it("updates document.documentElement.lang when the locale changes", () => {
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("to-es"));
    expect(document.documentElement.lang).toBe("es");

    fireEvent.click(screen.getByText("to-en"));
    expect(document.documentElement.lang).toBe("en");
  });
});
