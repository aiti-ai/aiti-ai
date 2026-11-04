/**
 * dialog/types — ServicesDialog 拆壳（M2）共享类型与纯函数。
 * （自 ServicesDialog.tsx 原位迁出，逻辑零改动。）
 */
export interface ServicePortInfo {
  port: number;
  pid: number;
  process: string;
  cmdline: string;
  /** Every concrete address the port is listening on (wildcards expanded). */
  addresses: string[];
  /** P2 服务识别（库 enrichWithIdentity + 用户 label 合并；旧库无此字段）。 */
  identity?: {
    label?: string;
    title?: string;
    favicon?: string;
    protocol?: string;
    status?: number;
    server?: string;
  };
}

export interface TunnelInfo {
  name: string;
  cmd: string;
  running: boolean;
  pid: number | null;
  url: string | null;
  lastOutput: string;
}

export interface ExposeInfo {
  name: string;
  port: number;
  tunnelType?: string;
  provider?: string;
  loginUrl?: string;
  protocol?: string;
  url: string | null;
  running: boolean;
  pid: number | null;
  accessLog: string | null;
  errorLog: string | null;
  site?: string;
  label?: string;
  /** 服务 basePath（vhost 剥部署前缀后接回的服务前缀；proxy/both 模式的转发映射）。 */
  serviceBasePath?: string | null;
  localUrl?: string;
  baseUrl?: string;
  domainUrl?: string;
  /** 回环域名(*.localhost)vhost URL——必须带 pi-web 真实端口才可点（服务端生成）。 */
  altUrls?: string[];
  mode?: string;
  /** Expose creation time (pi-web-side record; null for pre-restart exposes). */
  startedAt?: number | null;
  /** Tunnel params (masked secrets) — for the detail modal. */
  params?: Record<string, string> | null;
}

export interface ServicesResponse {
  services: ServicePortInfo[];
  serviceHostSuffix: string;
  serviceHostSuffixes: string[];
  tunnels: TunnelInfo[];
  exposes: ExposeInfo[];
  platform: string;
  allowToolDownload?: boolean;
  toolStatus?: Array<{ name: string; path: string | null; source: "toolPaths" | "path" | "cache" | null }>;
}

/** 站点（认证域）—— GET /status 的 sites 列表项（库 SiteInfo 形状）。 */
export interface SiteInfo {
  name: string;
  provider?: string;
  auth?: boolean;
  basePath?: string;
  policy?: string;
  domain?: string;
  suffix?: string;
  running: boolean;
  port?: number;
  hosts: string[];
}

export interface SelfState {
  exposing: boolean;
  /** 任一 running 自暴露通道未挂 provider（auth-none / tcp）→ 无认证暴露。 */
  unauthenticated?: boolean;
  allowLocal: boolean;
  allowLocalPending: { pending: boolean; expiresAt: number };
  allowHosts: string[];
  port: number;
  mode: string | null;
  auth: string | null;
  tunnel: string | null;
  config: Record<string, unknown> | null;
  urls: Array<{ label: string; labelKey?: string; labelParams?: Record<string, string>; url: string; gated?: boolean; authEntry?: boolean; tunnel?: string; exposeName?: string; noAuth?: boolean }>;
}

export function formatAddrForUrl(addr: string): string {
  return addr.includes(":") ? `[${addr}]` : addr;
}

export function isLikelyIp(hostname: string): boolean {
  if (hostname.includes(":")) return true; // IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** 注入端口条目归一化：纯数字（老格式）或 { port, basePath } → 统一对象。 */
export function normInjectEntries(ports: unknown): Array<{ port: number; basePath?: string }> {
  if (!Array.isArray(ports)) return [];
  return ports
    .map((e) => {
      if (typeof e === "number" && Number.isFinite(e) && e > 0) return { port: e };
      if (e && typeof e === "object" && Number.isFinite(Number((e as { port?: unknown }).port))) {
        const port = Number((e as { port: unknown }).port);
        if (port <= 0 || port > 65535) return null;
        // 兼容两种键名：旧 inject-ports 的 basePath / 新 enroll 的 serviceBasePath
        const raw = e as { basePath?: unknown; serviceBasePath?: unknown };
        const bp0 = typeof raw.basePath === "string" ? raw.basePath : (typeof raw.serviceBasePath === "string" ? raw.serviceBasePath : "");
        const bp = bp0.replace(/^\/+/, "").replace(/\/+$/, "");
        return { port, ...(bp ? { basePath: "/" + bp } : {}) };
      }
      return null;
    })
    .filter((e): e is { port: number; basePath?: string } => e !== null);
}

/**
 * 部署域 vhost URL 的 scheme 规范化（https 部署一致性）：
 *
 * 库端生成 baseUrl/domainUrl/loginUrl 时硬编码 http://（expose.js withDeploy）——
 * 页面经 nginx TLS 部署（https://<domain>/）时，展示/复制/打开的地址应带 https，
 * 否则“协议不一致”（点了 http 会被 nginx 重定向或直接失败）。
 * 规则：仅把 **部署域** URL 的 http 换成当前页面协议；本地回环 vhost
 * （*.localhost / 127.0.0.1 / IP）保持 http（本地无 TLS，且 *.localhost 浏览器
 * 只解析 127.0.0.1，强上 https 反而证书报错）。隧道公网 url（cloudflared/ngrok）
 * 自带 https，不动。
 */
export function normalizeVhostScheme(u: string): string {
  if (!u || !u.startsWith("http://")) return u;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (loopback) return u; // 本地回环：保持 http
    url.protocol = window.location.protocol; // 部署域：跟随页面协议（https）
    return url.toString();
  } catch {
    return u;
  }
}

/** 暴露记录的 URL 规范化：baseUrl/domainUrl/loginUrl 走部署域 scheme 规则，
 *  本地 localUrl 与隧道 url 原样保留。 */
export function normalizeExposeUrls(ex: ExposeInfo): ExposeInfo {
  return {
    ...ex,
    baseUrl: ex.baseUrl ? normalizeVhostScheme(ex.baseUrl) : ex.baseUrl,
    domainUrl: ex.domainUrl ? normalizeVhostScheme(ex.domainUrl) : ex.domainUrl,
    loginUrl: ex.loginUrl ? normalizeVhostScheme(ex.loginUrl) : ex.loginUrl,
  };
}
