"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getLocalePlugin, getSupportedLocales, resolveBrowserLocale } from "@/lib/i18n/registry";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, LocalePlugin, TranslationParams } from "@/lib/i18n/types";

const LOCALE_STORAGE_KEY = "pi-locale";
const LOCALE_COOKIE_KEY = "pi-locale";
const defaultLocale: Locale = "en";

/** 服务端可传入的初始语言（来自 cookie / Accept-Language 探测）。 */
const globalWithLocale = globalThis as typeof globalThis & { __PI_LOCALE__?: Locale };

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: LocalePlugin[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getMessages(): Record<string, Record<string, string>> {
  return Object.fromEntries(getSupportedLocales().flatMap((id) => {
    const plugin = getLocalePlugin(id);
    return plugin ? [[id, plugin.messages]] : [];
  }));
}

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
    // 隐私模式或存储不可用时继续使用浏览器语言。
  }
  return resolveBrowserLocale(window.navigator.languages.length ? window.navigator.languages : [window.navigator.language]);
}

/**
 * 提供 Pi Web 的界面语言状态和翻译能力。
 * @param props React 子节点
 * @returns 包含语言上下文的 React 节点
 */
export function I18nProvider({
  children,
  initialLocale = defaultLocale,
}: {
  children: React.ReactNode;
  /** 服务端探测的初始语言（来自 cookie / Accept-Language）；客户端优先用内联脚本预设值。 */
  initialLocale?: Locale;
}) {
  // 懒初始化：客户端优先读取 <head> 内联脚本预设的 window.__PI_LOCALE__（在 React
  // hydrate 前已就绪），保证首次渲染即为正确语言，避免「先英文再切中文」的二次渲染。
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window !== "undefined") {
      const preset = globalWithLocale.__PI_LOCALE__;
      if (preset === "en" || preset === "zh-CN") return preset;
      // 内联脚本未跑（极端情况），退回 localStorage / 浏览器语言同步探测。
      return readInitialLocale();
    }
    return initialLocale;
  });
  const supportedLocales = useMemo(
    () => getSupportedLocales().map((id) => getLocalePlugin(id)).filter((plugin): plugin is LocalePlugin => Boolean(plugin)),
    [],
  );
  const messages = useMemo(() => getMessages(), []);

  // hydrate 后同步 <html lang> 与 localStorage（内联脚本已设过，这里确保一致性）。
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // 存储失败不影响当前页面内的语言切换。
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    if (!getLocalePlugin(next)) return;
    setLocaleState(next);
    document.documentElement.lang = next;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // 存储失败不影响当前页面内的语言切换。
    }
    // 同步 cookie，让下次 SSR 直接命中正确语言。
    try {
      document.cookie = `${LOCALE_COOKIE_KEY}=${next};path=/;max-age=31536000;SameSite=Lax`;
    } catch {
      // cookie 写入失败不影响当前页面。
    }
  }, []);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages, params), [locale, messages]);
  const value = useMemo(() => ({ locale, setLocale, t, supportedLocales }), [locale, setLocale, t, supportedLocales]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 获取当前组件树中的国际化能力。
 * @returns 当前 locale、翻译函数、语言切换函数和支持的语言列表
 * @throws 当组件不在 I18nProvider 内时抛出异常
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
