/**
 * 扩展名拼音索引（服务端预计算，client 只做字符串匹配——拼音字典不进 client bundle）。
 *
 * name 含中文的扩展在 status 富化时附 pinyin 字段（全拼连写 + 首字母，空格分隔）：
 *   服务隧道 → "fuwusuidao fwsd"
 * 搜索框输入 fuwusuidao / fuwu suidao（去空格归一）/ fwsd / 错字 fuwusuidau
 * 均可命中（client 侧 hay 拼上本字段 + 现有 includes/OSA 错字容忍）。
 *
 * 字典用 pinyin-pro（第三方，声明进扩展 dependencies → 共享根 reconcile 装机）；
 * jiti 下经 createRequire 从部署目录向上解析，缺失/失败静默降级为无 pinyin 字段
 * （纯增项，不影响其余功能）。同输入 memo 缓存（status/ops 响应高频调用）。
 */
import { createRequire } from "module";

function loadPinyin() {
  try {
    return createRequire(import.meta.url)("pinyin-pro")?.pinyin ?? null;
  } catch {
    // jiti 转换环境兜底（import.meta.url 不可用时）
    try {
      const req = typeof require === "function" ? require : null;
      return req ? req("pinyin-pro")?.pinyin ?? null : null;
    } catch {
      return null;
    }
  }
}

// ⚠ .mjs 经宿主 jiti 走原生 ESM 加载：模块顶层进程内只执行一次，node ESM 缓存不可清。
// 加载必须惰性 + 失败退避：部署 reload 常发生在共享根 reconcile 装 pinyin-pro 之前，
// 顶层固化 null 会导致拼音功能直到进程重启都不生效。失败后 30s 内不重试（require 失败开销小，
// 但 status 调用高频，限频避免浪费）。
let pinyinFn = null;
let lastFailAt = 0;
const RETRY_MS = 30_000;

function ensurePinyin() {
  if (pinyinFn || Date.now() - lastFailAt < RETRY_MS) return pinyinFn;
  pinyinFn = loadPinyin();
  if (!pinyinFn) lastFailAt = Date.now();
  return pinyinFn;
}

const memo = new Map();
const HAS_CJK = /[\u4e00-\u9fa5]/;
const NON_ALNUM = /[^a-z0-9]/g;

/** 中文名 → "全拼连写 首字母"；无中文/i18n key/转换失败/库缺失 → 空串（调用方纯增项拼接）。 */
export function extPinyin(text) {
  const t = String(text ?? "").trim();
  const fn = ensurePinyin();
  if (!t || !fn || !HAS_CJK.test(t) || /^i18n:/i.test(t)) return "";
  const hit = memo.get(t);
  if (hit !== undefined) return hit;
  let out = "";
  try {
    const full = fn(t, { toneType: "none", type: "array", nonZh: "consecutive" }).join("").replace(NON_ALNUM, "").toLowerCase();
    const abbr = fn(t, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" }).join("").replace(NON_ALNUM, "").toLowerCase();
    const parts = full && full !== abbr ? [full, abbr] : full ? [full] : [];
    out = parts.join(" ");
  } catch {}
  memo.set(t, out);
  return out;
}
