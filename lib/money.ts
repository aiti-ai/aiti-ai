/**
 * Dual-currency formatting (client-side, synchronous reads).
 *
 * Rule: when the UI language is Chinese → `$xx（¥yy）` dual display; other languages → `$xx`
 * (unchanged). The accounting unit is always USD (list-price computations are persisted);
 * ¥ is purely a display-layer conversion, with the rate from /api/fx (24h server-side cache,
 * see lib/fx.ts). **Fetch on demand**: the request goes out only when the first
 * money-displaying component mounts (useMoneySynced(enabled=true) or ensureFx()) — pages or
 * moments with no ¥ display need (welcome page, sessions without cost) never spend the
 * page-load request budget.
 */
import { apiUrl } from "./base-path";
import { getLocalePlugin, getSupportedLocales } from "./i18n/registry";
import { interpolateMessage } from "./i18n/format";
import { useSyncExternalStore } from "react";

export interface FxData { rate: number; source: string; fetchedAt: number }

let fx: FxData | null = null;
let inflight: Promise<void> | null = null;
let version = 0;
const subs = new Set<() => void>();

/** Fetch the exchange rate once (deduplicated at module level; silent on failure — keeps plain USD display). The first call triggers the network request. */
export function ensureFx(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (fx || inflight) return inflight ?? Promise.resolve();
  inflight = fetch(apiUrl("/api/fx"))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && typeof j.rate === "number" && j.rate > 0) {
        fx = { rate: j.rate, source: j.source, fetchedAt: j.fetchedAt };
        version++;
        for (const s of [...subs]) s();
      }
    })
    .catch(() => { /* network failure: stay null, retry on next page load */ })
    .finally(() => { inflight = null; });
  return inflight;
}
function subscribeMoney(cb: () => void): () => void {
  subs.add(cb);
  // First subscriber = the first component that will actually render money → this is when the rate is fetched (fetch on demand).
  void ensureFx();
  return () => { subs.delete(cb); };
}

function subscribeNothing(): () => void {
  return () => {};
}

/**
 * Use inside components that display money: triggers a re-render of this component once the
 * exchange rate arrives asynchronously (the previously rendered plain USD gains its ¥ part).
 * SSR/first frame return 0, matching the client's initial value — no hydration risk.
 *
 * @param enabled Whether this component currently has money to display (pass false when there
 *   is none: no subscription, no rate fetch; flip to true once money appears, and the ¥ part
 *   is filled in as usual after the rate arrives).
 */
export function useMoneySynced(enabled = true): boolean {
  useSyncExternalStore(enabled ? subscribeMoney : subscribeNothing, () => version, () => 0);
  return Boolean(fx);
}

/** Current UI language (same localStorage source as useI18n; defaults to en on SSR). */
export function currentLocale(): string {
  if (typeof window === "undefined") return "en";
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v) return v;
  } catch { /* storage unavailable */ }
  return document.documentElement.lang || "en";
}

export function isZh(locale: string): boolean {
  return locale === "zh-CN" || locale === "zh" || locale.startsWith("zh");
}

/** Catalog lookup for this module's copy, resolved for the active locale (en fallback). */
function tr(key: string, params?: Record<string, string>): string {
  const id = currentLocale();
  const plugin = getSupportedLocales().includes(id) ? getLocalePlugin(id) : undefined;
  const template = plugin?.messages[key] ?? getLocalePlugin("en")?.messages[key] ?? key;
  return interpolateMessage(template, params);
}

/**
 * Money formatting: zh with a rate available → `$xx（¥yy）`; otherwise `$xx`.
 * Without a rate (not yet loaded/SSR) both languages render plain USD first; the ¥ part is
 * filled in on re-render once the rate arrives.
 */
export function fmtMoney(usd: number | null | undefined, prec = 2): string {
  const v = Number(usd ?? 0);
  const usdStr = `$${v.toFixed(prec)}`;
  if (!isZh(currentLocale()) || !fx) return usdStr;
  return usdStr + tr("money.dualSuffix", { v: (v * fx.rate).toFixed(prec) });
}

/** Header small-amount case: `<$0.01` / `<$0.01（<¥0.07）` in zh. */
export function fmtMoneySmall(threshold = 0.01, prec = 2): string {
  const usdStr = `<$${threshold.toFixed(2)}`;
  if (!isZh(currentLocale()) || !fx) return usdStr;
  return usdStr + tr("money.dualSmallSuffix", { v: (threshold * fx.rate).toFixed(prec) });
}

/** Exchange-rate annotation (for tooltips): `FX rate 7.14 · er-api`; returns an empty string when no rate is available. */
export function fxNote(): string {
  if (!fx) return "";
  const d = fx.fetchedAt ? new Date(fx.fetchedAt).toISOString().slice(0, 10) : "";
  return tr("money.fxNote", { rate: fx.rate.toFixed(2), source: fx.source }) + (d ? ` · ${d}` : "");
}
