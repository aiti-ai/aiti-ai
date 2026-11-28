/**
 * aiti-model-wizard · 共享助手（自手写 h() 版原样迁移）
 * api 助手 / 图标 / 样式表 / LINK / genName / 新模型一次性请求缓存
 */
import { apiUrl } from "./host-shim";

export const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-model-wizard" + p), { cache: "no-store", ...init });
export const jsonBody = (o: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// lucide 图标（与系统内建线条图标同风格）
export const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);

export const ICONS = {
  wand: ["m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72", "m14 7 3 3", "M5 6v4", "M19 14v4", "M10 2v2", "M7 8H3", "M21 16h-4", "M11 3H9"],
  search: ["m21 21-4.34-4.34", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "m15 5 4 4"],
  key: ["m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"],
  plus: ["M5 12h14", "M12 5v14"],
  check: ["M20 6 9 17l-5-5"],
  card: ["M19 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z", "M14 11h6", "M14 15h6", "M2 9h4", "M2 15h4"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  tag: ["M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z", "M7.5 7.5h.01"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  eye: ["M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  stethoscope: ["M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3", "M8 15v1a6 6 0 0 0 6 6a6 6 0 0 0 6-6v-4", "M11 18v2"],
  layers: ["m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z", "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65", "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"],
  sparkles: ["M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z", "M20 3v4", "M22 5h-4", "M4 17v2", "M5 18H3"],
  // lucide gift：免费模型页签（礼物盒+丝带；rect 转 path 与同风格一致）
  gift: ["M4 8h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z", "M12 8v13", "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7", "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"],
  // lucide settings：向导设置（齿轮；circle 转 path 与同风格一致）
  settings: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
};

export const LINK = (url: string) => { try { return /^https?:\/\//.test(url) ? url : "https://" + url; } catch { return url; } };

// 自动生成提供商名：host 品牌词（+ /vX 前最后一个有意义路径段）。
// 品牌词优先：跳过通用前置子域（api/token/key/auth/console…）与 TLD 类尾缀，取第一个「像品牌」的词——
// 如 https://token.sensenova.cn/v1/chat/completions → sensenova（旧版只取到 token，把品牌信息丢了）。
// ark.cn-beijing.volces.com/api/coding/v3 → ark-coding 不变。
export const genName = (url: string) => {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    // 通用功能词：出现在 host 任何位置都跳过（多为网关/凭据/入口子域，不是品牌）
    const skip = new Set(["api", "www", "open", "openai", "app", "gateway", "openapi", "inference", "infer", "backend", "proxy", "paas", "service", "dev", "openplat",
      "token", "key", "keys", "auth", "login", "sso", "console", "cdn", "static", "cloud", "my", "user", "users", "account", "accounts", "pay", "billing"]);
    // TLD / 二级区域尾缀：host 最后一段通常是这些，不是品牌
    const tld = new Set(["cn", "com", "net", "org", "io", "ai", "cc", "dev", "app", "site", "vip", "top", "me", "co", "gov", "edu", "hk", "tw", "jp", "us", "de", "uk", "xyz", "online", "tech", "cloud"]);
    const hostToks = u.hostname.split(".").filter(Boolean);
    const hostTok = (hostToks.find((s) => {
      const t = s.toLowerCase();
      return !skip.has(t) && !tld.has(t) && t.length > 1;
    }) || hostToks[0] || "").toLowerCase();
    // 路径段：跳过版本号、通用功能词与 API 端点名（chat/completions 等不是提供商标识）
    const pathSkip = new Set([...skip, "chat", "completions", "messages", "embeddings", "responses", "generatecontent", "models", "beta", "dashboard", "console"]);
    const pathToks = u.pathname.replace(/\/+$/, "").split("/").filter((s) => {
      const t = String(s || "").toLowerCase();
      return t && !/^v\d+(\.\d+)?$/.test(t) && !pathSkip.has(t);
    });
    const pathTok = (pathToks[pathToks.length - 1] || "").toLowerCase();
    return [(/^\d/.test(hostTok) ? "local" : hostTok), pathTok].filter(Boolean).join("-") || "custom";
  } catch { return "custom"; }
};

// ── 新模型一次性请求缓存（模块级）──
// 结果页内一次性获取：所有组件共享同一份结果（避免重复请求/重复消费 toast 额度）。
// 不轮询——只在页面加载/新 session 打开时拉一次（用户明确要求）。
let nmFetchP: Promise<any> | null = null;
export function fetchNewModelsOnce(opts?: { toast?: boolean }) {
  const wantToast = opts && opts.toast;
  if (!nmFetchP) {
    nmFetchP = api("/new-models" + (wantToast ? "?toast=1" : "")).then((r) => r.json()).catch(() => null);
    return nmFetchP;
  }
  // 缓存命中但缺 toast 裁决（先被徽标的无参请求占位）且本次需要 → 追加一次 ?toast=1 升级缓存，
  // 否则 toast 组件拿到的是无裁决字段的响应 → 永远不弹
  if (wantToast) {
    nmFetchP = nmFetchP.then((d) => {
      if (d && d.toast) return d;
      return api("/new-models?toast=1").then((r2) => r2.json()).catch(() => null);
    });
    return nmFetchP;
  }
  return nmFetchP;
}
// 本地缓存失效 + 通知所有组件重拉（ack 后徽标同步消失用；事件驱动，非轮询）
export function invalidateNewModels() {
  nmFetchP = null;
  try { window.dispatchEvent(new CustomEvent("aiti-model-wizard:new-models-changed")); } catch {}
}

// 带 toast 裁决的请求，并把结果写回共享缓存（原版 ReminderToast 补弹路径的 nmFetchP 升级语义）
export function fetchNewModelsWithToast(): Promise<any> {
  return api("/new-models?toast=1")
    .then((r) => r.json())
    .then((d2) => { nmFetchP = Promise.resolve(d2); return d2; })
    .catch(() => null);
}
