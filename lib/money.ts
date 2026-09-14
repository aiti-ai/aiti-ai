/**
 * 双币格式化（client 端，同步取值）。
 *
 * 规则：界面语言为中文 → `$xx（¥yy）` 双显；其他语言 → `$xx`（现状不变）。
 * 记账单位始终是 USD（目录价计算落库），¥ 纯展示层换算，汇率来自 /api/fx
 * （24h 服务端缓存，见 lib/fx.ts）。**用时而拉**：首次有金额展示组件挂载（
 * useMoneySynced(enabled=true) 或 ensureFx()）才发请求——没有 ¥ 展示需求的
 * 页面/时机（欢迎页、无 cost 的会话）不占开页请求窗口。
 */
import { apiUrl } from "./base-path";
import { useSyncExternalStore } from "react";

export interface FxData { rate: number; source: string; fetchedAt: number }

let fx: FxData | null = null;
let inflight: Promise<void> | null = null;
let version = 0;
const subs = new Set<() => void>();

/** 拉一次汇率（模块级去重；失败静默——保持纯 USD 显示）。首次调用触发网络。 */
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
    .catch(() => { /* 网络失败：保持 null，下次页面加载重试 */ })
    .finally(() => { inflight = null; });
  return inflight;
}
function subscribeMoney(cb: () => void): () => void {
  subs.add(cb);
  // 首个订阅者 = 首个真的会渲染金额的组件 → 此刻才拉汇率（用时而拉）。
  void ensureFx();
  return () => { subs.delete(cb); };
}

function subscribeNothing(): () => void {
  return () => {};
}

/**
 * 挂在含金额显示的组件里：汇率异步到位时触发本组件重渲染（此前渲染的纯 USD
 * 补出 ¥ 部分）。SSR/首帧返回 0 与客户端初始值一致，无 hydration 风险。
 *
 * @param enabled 本组件当前是否真的有金额要显示（无金额时传 false：不订阅、
 *   不触发汇率拉取；等金额出现再翻 true，汇率到位后照常补出 ¥）。
 */
export function useMoneySynced(enabled = true): boolean {
  useSyncExternalStore(enabled ? subscribeMoney : subscribeNothing, () => version, () => 0);
  return Boolean(fx);
}

/** 当前界面语言（与 useI18n 的 localStorage 同源；SSR 缺省 en）。 */
export function currentLocale(): string {
  if (typeof window === "undefined") return "en";
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v) return v;
  } catch { /* 存储不可用 */ }
  return document.documentElement.lang || "en";
}

export function isZh(locale: string): boolean {
  return locale === "zh-CN" || locale === "zh" || locale.startsWith("zh");
}

/**
 * 金额格式化：zh 且有汇率 → `$xx（¥yy）`；否则 `$xx`。
 * 无汇率（未加载完成/SSR）时两种语言都先渲染纯 USD，汇率到位后随 re-render 补出 ¥。
 */
export function fmtMoney(usd: number | null | undefined, prec = 2): string {
  const v = Number(usd ?? 0);
  const usdStr = `$${v.toFixed(prec)}`;
  if (!isZh(currentLocale()) || !fx) return usdStr;
  return `${usdStr}（¥${(v * fx.rate).toFixed(prec)}）`;
}

/** 顶栏小金额场景：`<$0.01` / zh 下 `<$0.01（<¥0.07）`。 */
export function fmtMoneySmall(threshold = 0.01, prec = 2): string {
  const usdStr = `<$${threshold.toFixed(2)}`;
  if (!isZh(currentLocale()) || !fx) return usdStr;
  return `${usdStr}（<¥${(threshold * fx.rate).toFixed(prec)}）`;
}

/** 汇率标注（tooltip 用）：`¥ 汇率 7.14 · er-api`；无汇率返回空串。 */
export function fxNote(): string {
  if (!fx) return "";
  const d = fx.fetchedAt ? new Date(fx.fetchedAt).toISOString().slice(0, 10) : "";
  return `汇率 ${fx.rate.toFixed(2)} · ${fx.source}${d ? ` · ${d}` : ""}`;
}
