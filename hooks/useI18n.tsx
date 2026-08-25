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
  // 首次渲染始终用服务端传入的 initialLocale——保证 SSR 与 hydration 一致，
  // 避免 React hydration mismatch。客户端探测的偏好在 useEffect 里校正。
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const supportedLocales = useMemo(
    () => getSupportedLocales().map((id) => getLocalePlugin(id)).filter((plugin): plugin is LocalePlugin => Boolean(plugin)),
    [],
  );
  const messages = useMemo(() => getMessages(), []);

  // hydrate 后：校正为客户端实际探测的语言（内联脚本预设值），同时同步 <html lang> 与 localStorage。
  // 仅在内联脚本探测结果与服务端 initialLocale 不同时才 setLocaleState（罕见），
  // 常见情况（cookie/localStorage 一致）不会触发二次渲染。
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
      // 存储失败不影响当前页面内的语言切换。
    }
  }, [initialLocale]);

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
    // 广播给扩展 client（ExtSlots 监听 → 已注册 UI 重渲染，t() 换新语言表）。
    window.dispatchEvent(new CustomEvent("pi-web:locale-changed", { detail: { locale: next } }));
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
