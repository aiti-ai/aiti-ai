/**
 * 双币格式化（model-check 本地精简版，与 pi-web core lib/money.ts 同规则）。
 * 单价场景：$/M tokens → zh 下追加（¥yy/M）。模块加载即拉一次 /api/fx。
 */
import { apiUrl } from "./host-shim";

let fx: { rate: number } | null = null;
let fxTried = false;

/**
 * 惰性拉取汇率。不能在模块顶层调用：模块求值早于宿主 register(ctx)，此时
 * host-shim 的 apiUrl 拿不到 basePath（子路径部署如 /win 下会打到根路径 404）。
 * 由 fmtUnitPrice 首次调用触发；一次尝试，失败保持纯 USD 显示（与旧顶层行为一致）。
 */
export function ensureFx(): void {
  if (fx || fxTried) return;
  fxTried = true;
  fetch(apiUrl("/api/fx"))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && typeof j.rate === "number" && j.rate > 0) fx = { rate: j.rate }; })
    .catch(() => { /* 拉取失败保持纯 USD 显示 */ });
}

function currentLocale(): string {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v) return v;
  } catch { /* 存储不可用 */ }
  return document.documentElement.lang || "en";
}

/** 单价格式化：`$0.6` / zh+汇率 → `$0.6（¥4.3）`。 */
export function fmtUnitPrice(v: unknown): string {
  if (v == null || v === "") return "-";
  ensureFx();
  const n = Number(v);
  const usd = Math.abs(n) < 0.01 && n !== 0 ? n.toFixed(5) : String(n);
  if (!(currentLocale().startsWith("zh")) || !fx) return "$" + usd;
  const cny = Math.abs(n) < 0.01 && n !== 0 ? (n * fx.rate).toFixed(4) : (n * fx.rate).toFixed(2);
  return `$${usd}（¥${cny}）`;
}
