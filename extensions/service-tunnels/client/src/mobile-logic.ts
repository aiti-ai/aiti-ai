/**
 * 「手机访问」纯逻辑（方案 §3.1/§3.3/§3.4）——零 react/DOM 依赖，可被
 * mobile-card.test.mjs 直接 esbuild 打包断言。组件本体在 MobileAccessCard.tsx。
 */

export const REMEMBER_KEY = "pi:st:mobile-scheme:v1";
/** 「手机访问」浮窗 key（与主对话窗 ST_KEY 并列，互不干扰可同开）。 */
export const MOBILE_KEY = "service-tunnels:mobile";

export interface RecoCandidate {
  id: string;
  available: boolean;
  recommended?: boolean;
  risk?: boolean;
  mode?: string;
  auth?: string;
  tunnel?: string | null;
  url?: string | null;
  https?: boolean;
  badges?: string[];
  reason?: string | null;
}

export interface Reco {
  port: number;
  candidates: RecoCandidate[];
  hasUsers: boolean;
  self: { exposing: boolean; unauthenticated?: boolean; channels: Array<{ url: string | null; noAuth?: boolean; tunnel?: string | null; exposeName?: string | null }> };
}

/** 登录方式档位 → 暴露参数（方案 §3.4；Q1 已定：按 https 能力自动定默认档）。 */
export function tierParams(tier: "password" | "face" | "totp"): {
  policy: "one_factor" | "two_factor";
  providerParams?: Record<string, unknown>;
  needFace?: boolean;
  needTotp?: boolean;
} {
  if (tier === "face") return { policy: "two_factor", providerParams: { biometrics: true }, needFace: true };
  if (tier === "totp") return { policy: "two_factor", providerParams: { biometrics: false }, needTotp: true };
  return { policy: "one_factor" };
}

/** 无认证候选必弹确认（方案 §3.3：lan 是唯一 auth:none 候选）。 */
export function confirmNeeded(c: RecoCandidate): boolean {
  return !!c.risk || c.auth === "none";
}

/**
 * 目标候选挑选：记住的方案可用且非风险 → 用它；否则 recommended；都无 → null。
 * 记住方案失效返回 { candidate: fallback, rememberedGone: true } 供 toast。
 */
export function pickCandidate(reco: Reco, remembered?: { id?: string } | null): { candidate: RecoCandidate | null; rememberedGone: boolean } {
  const usable = reco.candidates.filter((c) => c.available && !c.risk);
  if (remembered?.id) {
    const hit = usable.find((c) => c.id === remembered.id);
    if (hit) return { candidate: hit, rememberedGone: false };
  }
  const rec = reco.candidates.find((c) => c.recommended && c.available && !c.risk) ?? null;
  return { candidate: rec, rememberedGone: !!(remembered?.id && rec) };
}

/** 就绪 URL：优先已暴露通道（不新开不停旧），无通道回候选 url；无认证通道不出码。 */
export function resolveReadyUrl(reco: Reco, candidate: RecoCandidate | null): string | null {
  const ch = (reco.self.channels ?? []).filter((c) => !c.noAuth && c.url);
  if (ch.length > 0) return ch[0].url ?? null;
  return candidate?.url ?? null;
}

/** 候选展示名 i18n 键后缀（schemeVhost / schemeTunnel / schemeLan …）。 */
export function schemeKey(id: string): string {
  return `mobile.scheme${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** 页面本身是 https 访问（部署侧有 TLS）→ http 候选升级为 https（QR 直达
 *  https，手机端 getUserMedia 才可用）。回环地址保持原样（本机安全上下文与
 *  手机无关，且 http://127.0.0.1 本就是安全上下文）。 */
export function upgradeToPageProto(url: string | null | undefined, pageHttps: boolean): string | null {
  if (!url || !pageHttps || !url.startsWith("http://")) return url ?? null;
  try {
    const host = new URL(url).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return url;
  } catch { return url; }
  return "https://" + url.slice("http://".length);
}

/** 刷脸档可选：候选本身 https，或页面经 https 访问（部署有 TLS，
 *  vhost/隧道可走 https）。局域网直连是裸 IP 无 TLS，永不放开。 */
export function faceSelectable(candidate: RecoCandidate | null, pageHttps: boolean): boolean {
  if (!candidate) return false;
  if (candidate.https) return true;
  if (candidate.id === "lan") return false;
  return pageHttps;
}
