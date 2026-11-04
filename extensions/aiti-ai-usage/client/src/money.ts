/**
 * 双币格式化（扩展本地版，与 pi-web core lib/money.ts 同规则）。
 *
 * 规则：界面语言为中文 → `$xx（¥yy）` 双显；其他语言 → `$xx`。
 * 记账单位始终是 USD；¥ 纯展示层换算。汇率来自宿主核心 /api/fx
 * （服务端 24h 惰性缓存 + 手动覆盖，见 pi-web lib/fx.ts）。
 * locale 读 localStorage pi-locale（与宿主 useI18n 同源）+ 监听 pi-web:locale-changed。
 */
import { apiUrl, useState, useEffect } from "./host-shim";

interface FxData { rate: number; source: string; fetchedAt: number }

let fx: FxData | null = null;
let inflight: Promise<void> | null = null;

export function ensureFx(): Promise<void> {
  if (fx || inflight) return inflight ?? Promise.resolve();
  inflight = fetch(apiUrl("/api/fx"))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && typeof j.rate === "number" && j.rate > 0) fx = { rate: j.rate, source: j.source, fetchedAt: j.fetchedAt };
    })
    .catch(() => { /* 拉取失败保持纯 USD 显示 */ })
    .finally(() => { inflight = null; });
  return inflight;
}

export function currentLocale(): string {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v) return v;
  } catch { /* 存储不可用 */ }
  return document.documentElement.lang || "en";
}

export function isZh(locale: string): boolean {
  return locale === "zh-CN" || locale === "zh" || locale.startsWith("zh");
}

/** 金额格式化：zh 且有汇率 → `$xx（¥yy）`；否则 `$xx`。 */
export function fmtUsdCny(usd: number | null | undefined, prec = 2): string {
  const v = Number(usd ?? 0);
  const usdStr = `$${v.toFixed(prec)}`;
  if (!isZh(currentLocale()) || !fx) return usdStr;
  return `${usdStr}（¥${(v * fx.rate).toFixed(prec)}）`;
}

/** 汇率标注（title/tooltip 用）：`¥ 汇率 7.14 · er-api · 2026-02-10`；无汇率空串。 */
export function fxNote(): string {
  if (!fx) return "";
  const d = fx.fetchedAt ? new Date(fx.fetchedAt).toISOString().slice(0, 10) : "";
  return `¥ ${fx.rate.toFixed(2)} ${fx.source}${d ? ` ${d}` : ""}`;
}

/** 人民币计费厂商（目录价为美元换算值，实际开票为人民币）。前缀匹配。 */
const CNY_BILLING_PREFIXES = [
  "zai", "zhipu", "bigmodel", "deepseek", "kimi", "moonshot", "siliconflow",
  "modelscope", "ark", "dashscope", "minimax", "baichuan", "stepfun", "sensenova",
];

export function isCnyBillingProvider(provider: string): boolean {
  const p = String(provider ?? "").toLowerCase();
  return CNY_BILLING_PREFIXES.some((k) => p.includes(k));
}

/**
 * 挂在报表根组件：汇率到位/语言切换时 force re-render——
 * fmtCost 是模块级函数，显示刷新依赖组件重渲染。
 */
export function useMoneyTick(): void {
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    void ensureFx().then(() => { if (alive) force((v: number) => v + 1); });
    const onLocale = () => force((v: number) => v + 1);
    window.addEventListener("pi-web:locale-changed", onLocale);
    return () => {
      alive = false;
      window.removeEventListener("pi-web:locale-changed", onLocale);
    };
  }, []);
}
