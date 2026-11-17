/**
 * 「手机访问」纯逻辑（方案 §3.1/§3.3/§3.4）——零 react/DOM 依赖，可被
 * mobile-card.test.mjs 直接 esbuild 打包断言。组件本体在 MobileAccessCard.tsx。
 */

export const REMEMBER_KEY = "pi:st:mobile-scheme:v1";
/** 「手机访问」浮窗 key（与主对话窗 ST_KEY 并列，互不干扰可同开）。 */
export const MOBILE_KEY = "service-tunnels:mobile";

// ---- QR source switch + parametrized launch (sources-and-service plan §3.1/§3.2) ----

/** Source memory key (Q2: remember last pick on the ports tab). */
export const SOURCE_KEY = "pi:st:mobile-source:v1";

/** QR source: entry = the original expose wizard (pi-web service entry,
 *  username/password + scheme + QR — the v1 card, kept intact as its own tab);
 *  page = the current browser URL; ports = exposed service URLs from the ports
 *  dialog; link = custom link passed via a parametrized launch ({url} only). */
export type Source = "entry" | "page" | "ports" | "link";

/** Parametrized launch args (client service "service-tunnels.mobile" input). */
export interface MobileLaunch {
  /** Full URL: render the QR for this link directly (http/https only). */
  url?: string;
  /** Query params appended onto the current page URL (e.g. "pair=1"). */
  query?: string;
  /** Custom caption shown on the card (link source subtitle). */
  title?: string;
}

/** Reachability of the current page URL from a phone: loopback = phones can't
 *  reach it; lan = same-network only; public = reachable anywhere (domain or
 *  public IP). Best-effort hostname heuristics. */
export type PageReach = "public" | "lan" | "loopback";
export function pageReachability(url: string | null | undefined): PageReach {
  const h = (() => {
    try { return new URL(url ?? "").hostname.toLowerCase(); } catch { return ""; }
  })();
  if (!h) return "public";
  if (h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".localhost") || h.endsWith(".local")) return "loopback";
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "lan";
  return "public";
}

/** appendQuery: merge query params via the URL API. Same-name params are
 *  overwritten (caller semantics win), other existing params are kept;
 *  tolerates "?"/"&" prefixes; returns the input unchanged when query is
 *  empty or the URL is malformed. */
export function appendQuery(url: string | null | undefined, query: string | null | undefined): string | null {
  if (!url) return null;
  const q = (query ?? "").trim().replace(/^[?&]+/, "");
  if (!q) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
    return u.toString();
  } catch { return url; }
}

/** launch.url protocol allowlist (http/https only; used as QR text/display
 *  only — no HTML injection surface). */
export function launchUrlSafe(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : null;
  } catch { return null; }
}

/** Expose record → QR-able URL list. Order matches the PortsTab result block
 *  (url → localUrl → baseUrl → domainUrl → altUrls), deduped case- and
 *  order-stable, empties filtered; loginUrl is never QR-encoded nor listed
 *  (same as the PortsTab detail modal). */
export function exposeToUrls(e: {
  url?: string | null; localUrl?: string | null; baseUrl?: string | null;
  domainUrl?: string | null; altUrls?: string[] | null;
}): string[] {
  const out: string[] = [];
  for (const u of [e.url, e.localUrl, e.baseUrl, e.domainUrl, ...(e.altUrls ?? [])]) {
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Source memory payload: source + last picked URL on the ports tab. */
export interface SourceMemory { source: Source; portUrl?: string | null }

/** Load source memory (defensive: bad source / parse failure → null; storage
 *  is injectable for tests). v1 legacy value "self" migrates to "entry" (same
 *  semantic — the expose wizard tab). */
export function loadSourceMemory(storage?: { getItem(k: string): string | null } | null): SourceMemory | null {
  try {
    const raw = storage?.getItem(SOURCE_KEY) ?? null;
    if (!raw) return null;
    const d = JSON.parse(raw) as SourceMemory;
    const src = d?.source === "self" ? "entry" : d?.source;
    if (src === "entry" || src === "page" || src === "ports") return { source: src, portUrl: d.portUrl ?? null };
  } catch { /* ignore */ }
  return null;
}

/** Save source memory (link is never persisted — a parametrized launch is
 *  governed by its args, not by memory). */
export function saveSourceMemory(storage: { setItem(k: string, v: string): void } | null, m: SourceMemory): void {
  try { storage?.setItem(SOURCE_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

export interface RecoCandidate {
  id: string;
  available: boolean;
  recommended?: boolean;
  risk?: boolean;
  mode?: string;
  auth?: string;
  tunnel?: string | null;
  /** Tunnel tools usable on this machine (tunnel candidate only). */
  tunnelOptions?: string[];
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

/** Tunnel tool choice for the tunnel candidate: the remembered tool if still
 *  usable (or the tool list is unknown), else the candidate default, else the
 *  first option, else cloudflared. Non-tunnel candidates → null. */
export function pickTunnelTool(c: RecoCandidate | null, remembered?: string | null): string | null {
  if (!c || c.id !== "tunnel") return null;
  const opts = c.tunnelOptions ?? [];
  if (remembered && (opts.length === 0 || opts.includes(remembered))) return remembered;
  return c.tunnel ?? opts[0] ?? "cloudflared";
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
