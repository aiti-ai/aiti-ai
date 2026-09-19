"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getLocalePlugin, getSupportedLocales, resolveBrowserLocale } from "@/lib/i18n/registry";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, LocalePlugin, TranslationParams } from "@/lib/i18n/types";

const LOCALE_STORAGE_KEY = "pi-locale";
const LOCALE_COOKIE_KEY = "pi-locale";
const defaultLocale: Locale = "en";

/** Initial locale the server can pass in (from cookie / Accept-Language probing). */
const globalWithLocale = globalThis as typeof globalThis & { __PI_LOCALE__?: Locale };

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: LocalePlugin[];
}

const I18nContext = createContext<I18nContextValue | null>(null);
/** Exported for ExtSlots (sidebarProjects takeover): the extensions' host-shim lazy context resolves to this real context. */
export { I18nContext };

function getMessages(): Record<string, Record<string, string>> {
  return Object.fromEntries(getSupportedLocales().flatMap((id) => {
    const plugin = getLocalePlugin(id);
    return plugin ? [[id, plugin.messages]] : [];
  }));
}

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN" || stored === "zh-TW") return stored;
  } catch {
    // Fall back to the browser language in private mode or when storage is unavailable.
  }
  return resolveBrowserLocale(window.navigator.languages.length ? window.navigator.languages : [window.navigator.language]);
}

/**
 * Provides the Pi Web UI locale state and translation capability.
 * @param props React children
 * @returns A React node carrying the locale context
 */
export function I18nProvider({
  children,
  initialLocale = defaultLocale,
}: {
  children: React.ReactNode;
  /** Initial locale probed server-side (from cookie / Accept-Language); the client prefers the value pre-set by the inline script. */
  initialLocale?: Locale;
}) {
  // The first render always uses the server-provided initialLocale — keeps SSR and hydration
  // consistent and avoids a React hydration mismatch. The client-probed preference is
  // corrected in useEffect.
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const supportedLocales = useMemo(
    () => getSupportedLocales().map((id) => getLocalePlugin(id)).filter((plugin): plugin is LocalePlugin => Boolean(plugin)),
    [],
  );
  const messages = useMemo(() => getMessages(), []);

  // After hydration: correct to the language actually probed by the client (inline-script
  // preset value), and sync <html lang> and localStorage at the same time. setLocaleState is
  // called only when the inline-script probe differs from the server initialLocale (rare);
  // the common case (cookie/localStorage in agreement) does not trigger a second render.
  useEffect(() => {
    const clientLocale = globalWithLocale.__PI_LOCALE__;
    const next = (clientLocale === "en" || clientLocale === "zh-CN")
      ? clientLocale
      : readInitialLocale();
    if (next !== initialLocale) setLocaleState(next);
    document.documentElement.lang = next;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // A storage failure does not affect the in-page locale switch.
    }
  }, [initialLocale]);

  const setLocale = useCallback((next: Locale) => {
    if (!getLocalePlugin(next)) return;
    setLocaleState(next);
    document.documentElement.lang = next;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // A storage failure does not affect the in-page locale switch.
    }
    // Sync the cookie so the next SSR directly lands on the right language.
    try {
      document.cookie = `${LOCALE_COOKIE_KEY}=${next};path=/;max-age=31536000;SameSite=Lax`;
    } catch {
      // A cookie write failure does not affect the current page.
    }
    // Broadcast to extension clients (ExtSlots listens → registered UI re-renders with t() switching to the new message table).
    window.dispatchEvent(new CustomEvent("pi-web:locale-changed", { detail: { locale: next } }));
  }, []);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages, params), [locale, messages]);
  const value = useMemo(() => ({ locale, setLocale, t, supportedLocales }), [locale, setLocale, t, supportedLocales]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Access the i18n capability within the current component tree.
 * @returns The current locale, the translate function, the locale switch function, and the supported locale list
 * @throws When the component is not inside I18nProvider
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
