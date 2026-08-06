/**
 * Middleware-safe service-proxy helpers.
 *
 * proxy.ts (Next middleware) runs in the SAME process as the app server
 * (verified: shared globalThis), so no file/IPC channel is needed — the proxy
 * reads the live service-tunnels instance directly from globalThis (created
 * by lib/service-tunnels-integration.ts). NO library import is required here.
 */

declare global {
  var __piWebExposeConfig: Record<string, unknown> | undefined;
  var __piWebAllowLocalOverride: boolean | undefined;
  var __piWebAllowHostsOverride: string[] | undefined;
  var __piWebPort: number | undefined;
  /** Self-exposure forward proof tokens (allowlocal=false gate): token → issued-at. */
  var __piWebSelfForwardTokens: Map<string, number> | undefined;
}

/** pi-web's own port (PORT env ?? 30141); overridable via PI_WEB_EXPOSE port=. */
export function getPiWebPort(): number {
  if (Number.isInteger(globalThis.__piWebPort)) return globalThis.__piWebPort as number;
  const p = Number(process.env.PORT ?? "30141");
  globalThis.__piWebPort = Number.isInteger(p) && p > 0 ? p : 30141;
  return globalThis.__piWebPort;
}

export function setPiWebPort(p: number): void {
  if (Number.isInteger(p) && p > 0) globalThis.__piWebPort = p;
}

/** Direct local access: runtime override > PI_WEB_EXPOSE allowlocal > true. */
export function getAllowLocal(): boolean {
  if (typeof globalThis.__piWebAllowLocalOverride === "boolean") {
    return globalThis.__piWebAllowLocalOverride;
  }
  const cfg = globalThis.__piWebExposeConfig;
  if (cfg && typeof cfg.allowlocal === "boolean") return cfg.allowlocal;
  return true;
}

/** UI / API runtime override (one-shot; resets on restart, env wins then). */
export function setAllowLocal(v: boolean): void {
  globalThis.__piWebAllowLocalOverride = v;
}

// 两阶段关闭(Windows 分辨率式防锁):第一阶段临时关闭 + TTL 自动恢复,
// 用户 30s 窗口内二次确认才永久;超时/不确认直接退回。
let allowLocalPendingTimer: ReturnType<typeof setTimeout> | null = null;
let allowLocalPendingExpires = 0;

/** 第一阶段:临时关闭,ttlMs 后自动恢复(override 回到 env/默认值)。 */
export function setAllowLocalTemporary(v: boolean, ttlMs: number): void {
  if (allowLocalPendingTimer) clearTimeout(allowLocalPendingTimer);
  globalThis.__piWebAllowLocalOverride = v;
  allowLocalPendingExpires = Date.now() + ttlMs;
  allowLocalPendingTimer = setTimeout(() => {
    allowLocalPendingTimer = null;
    allowLocalPendingExpires = 0;
    // 回到 env/默认(不强制 true:若启动时 env 显式 allowlocal=false 则尊重它)
    globalThis.__piWebAllowLocalOverride = undefined;
  }, ttlMs);
}

/** 第二阶段:二次确认,永久生效(取消 TTL 自动恢复)。 */
export function confirmAllowLocal(v: boolean): void {
  if (allowLocalPendingTimer) clearTimeout(allowLocalPendingTimer);
  allowLocalPendingTimer = null;
  allowLocalPendingExpires = 0;
  globalThis.__piWebAllowLocalOverride = v;
}

/** 待二次确认状态(UI 倒计时展示):{ pending, expiresAt }。 */
export function getAllowLocalPending(): { pending: boolean; expiresAt: number } {
  return { pending: allowLocalPendingTimer !== null, expiresAt: allowLocalPendingExpires };
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\\./, "").replace(/:\d{1,5}$/, "");
}

/**
 * Hostnames the allowlocal gate treats as trusted entries even when
 * allowlocal=false. ONLY the operator's explicit allow-list counts (env
 * PI_WEB_EXPOSE `allowHost=` plus runtime overrides) — deployment domains are
 * deliberately NOT auto-excepted: a bare deployment-domain request must go
 * through the proxy auth (virtual-host form) or be listed here explicitly,
 * so every authorized access still flows through the proxy by default.
 */
export function getAllowLocalHosts(): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  const cfg = globalThis.__piWebExposeConfig;
  const ah = cfg?.allowHost;
  if (Array.isArray(ah)) {
    for (const h of ah) add(normalizeHost(String(h)));
  } else if (typeof ah === "string") {
    for (const h of ah.split(/[\s,]+/)) add(normalizeHost(h));
  }
  if (Array.isArray(globalThis.__piWebAllowHostsOverride)) {
    for (const h of globalThis.__piWebAllowHostsOverride) add(normalizeHost(h));
  }
  return out;
}

/** UI / API runtime override of the explicit allow-host list (one-shot). */
export function setAllowLocalHosts(hosts: string[]): void {
  globalThis.__piWebAllowHostsOverride = (hosts ?? [])
    .map((h) => normalizeHost(h))
    .filter(Boolean);
}

/** Self-exposure forward tokens are valid for this long (ms). */
const SELF_FORWARD_TTL_MS = 30_000;

/**
 * Issue a one-shot proof that a request is a gateway-authenticated
 * self-exposure forward (not a raw direct connection).
 *
 * Why: with allowlocal=false the direct-access gate must refuse EVERY host —
 * including loopback — otherwise a raw `http://127.0.0.1:<port>` request
 * bypasses the exposure/auth gateway (the bug being fixed). But the
 * self-exposure forward (vhost → pi-web itself) re-enters this middleware
 * with a loopback Host after Next's external rewrite, and custom headers do
 * NOT survive that rewrite. So the forward carries a random token in the
 * rewrite URL; the gate accepts loopback hosts ONLY when the token is valid.
 * The browser never sees it (the internal hop is server-side) and the token
 * is unobservable to LAN clients, so TTL-only (no one-shot delete) keeps
 * concurrent forwards and the app's internal re-fetches working.
 */
export function issueSelfForwardToken(): string {
  const now = Date.now();
  const tokens = globalThis.__piWebSelfForwardTokens ??= new Map<string, number>();
  // prune expired entries
  for (const [t, ts] of tokens) {
    if (now - ts > SELF_FORWARD_TTL_MS) tokens.delete(t);
  }
  const token = crypto.randomUUID();
  tokens.set(token, now);
  return token;
}

/** True when `token` is an unexpired self-exposure forward proof. */
export function isValidSelfForwardToken(token: string): boolean {
  if (!token) return false;
  const ts = globalThis.__piWebSelfForwardTokens?.get(token);
  return typeof ts === "number" && Date.now() - ts <= SELF_FORWARD_TTL_MS;
}

/** Forget every self-exposure forward token (tests / shutdown). */
export function clearSelfForwardTokens(): void {
  globalThis.__piWebSelfForwardTokens = undefined;
}

/**
 * Map a public tunnel-domain request to pi-web's own proxy virtual host so
 * the middleware can authenticate it through the same resolve() path as
 * everything else (no whitelist backdoor). Matches the Host against the URL
 * of every running pi-web SELF expose (site "pi-web" or expose-self-*) and
 * returns a vhost hostname (`<port>-pi-web.<suffix>`) whose binding exists.
 */
export function mapSelfTunnelToVhost(hostname: string): string | null {
  const st = globalThis.__piServiceTunnels;
  if (!st?.exposes || !st?.proxy?.parseHost) return null;
  for (const e of st.exposes()) {
    const isSelf = e.site === "pi-web" || (typeof e.name === "string" && e.name.startsWith("expose-self-"));
    if (!isSelf || !e.url || !e.running) continue;
    let urlHost: string;
    try {
      urlHost = new URL(e.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (urlHost !== hostname.toLowerCase()) continue;
    // Candidate vhosts for this expose: deployment domains (registered with
    // the library via baseDomain/baseDomains), then the library's default
    // local suffixes. pi-web's own suffix (PI_WEB_SVC_HOST_SUFFIX) is NOT
    // registered with the library, so it would never match parseHost.
    const candidates = [
      ...getBaseDomains().map((d) => `${e.port}-pi-web.${d}`),
      `${e.port}-pi-web.st.localhost`,
      `${e.port}-pi-web.service-tunnel.localhost`,
      `${e.port}-pi-web.localhost`,
    ];
    for (const v of candidates) {
      if (st.proxy.parseHost(v)) return v;
    }
    return `${e.port}-pi-web.st.localhost`;
  }
  return null;
}

/** The live service-tunnels instance created by the app server (same process). */
function liveInstance(): { exposes(): Array<Record<string, unknown> & { port?: number; running?: boolean; localUrl?: string | null; baseUrl?: string | null; domainUrl?: string | null }> } | null {
  return globalThis.__piServiceTunnels ?? null;
}

/**
 * Enrolled ports = running exposes that produce a LOCAL virtual host
 * (proxy/both mode). D4: default zero-forward — only these are proxied.
 * In-process, real-time (no file, no TTL cache).
 */
export function getAllowedPorts(): Set<number> {
  const st = liveInstance();
  if (!st) return new Set();
  const out = new Set<number>();
  for (const e of st.exposes()) {
    if (!e.running || !(e.localUrl || e.baseUrl || e.domainUrl)) continue;
    if (Number.isInteger(e.port) && (e.port as number) > 0) out.add(e.port as number);
  }
  return out;
}

/** Whether a port is explicitly enrolled and running (may be proxied). */
export function isServicePortAllowed(port: number): boolean {
  return getAllowedPorts().has(port);
}

/** Virtual-host suffix used for service URLs, e.g. ".pi.localhost". */
export function getServiceHostSuffix(): string {
  const raw = process.env.PI_WEB_SVC_HOST_SUFFIX ?? ".pi.localhost";
  return raw.startsWith(".") ? raw : `.${raw}`;
}

/**
 * Operator-configured deployment domains, in priority order:
 *  1. PI_WEB_BASE_DOMAIN (explicit — comma-separated, host:port allowed,
 *     e.g. "example.com:57442,backup.example.com")
 *  2. PI_WEB_ALLOWED_HOSTS (trusted hosts — legacy fallback)
 *  3. PI_WEB_HOSTNAME (legacy — originally the LISTEN address; only kept as
 *     a fallback so existing deployments keep working)
 *
 * IP literals are dropped (they are listen addresses, never wildcard-capable
 * domain suffixes). The host:port form is preserved: virtual-host matching
 * uses the host part, while URL generation keeps the port (service-tunnels
 * baseDomain semantics).
 */
export function getBaseDomains(): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/^\./, "");
    if (!s) return;
    const host = s.replace(/:\d{1,5}$/, "");
    if (isIP(host) !== 0) return;
    if (!out.includes(s)) out.push(s);
  };
  for (const src of [
    process.env.PI_WEB_BASE_DOMAIN,
    process.env.PI_WEB_ALLOWED_HOSTS,
    process.env.PI_WEB_HOSTNAME,
  ]) {
    for (const h of (src ?? "").split(",")) add(h);
  }
  return out;
}

/**
 * All suffixes that proxy.ts accepts as service virtual hosts, in priority
 * order: the built-in .pi.localhost, the explicit PI_WEB_SVC_HOST_SUFFIX, and
 * every configured deployment domain (PI_WEB_BASE_DOMAIN /
 * PI_WEB_ALLOWED_HOSTS / PI_WEB_HOSTNAME — ports stripped).
 */
export function getServiceHostSuffixes(): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/^\./, "").replace(/:\d{1,5}$/, "");
    if (!s || isIP(s) !== 0) return;
    if (!out.includes(`.${s}`)) out.push(`.${s}`);
  };
  add(getServiceHostSuffix());
  for (const d of getBaseDomains()) add(d);
  return out;
}

function isIP(s: string): number {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return 4;
  if (s.includes(":")) return 6;
  return 0;
}

/** Strip pi-web's basePath from a path before forwarding to a service. */
export function stripBasePath(pathname: string, basePath: string): string {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base || pathname === "/") return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return pathname;
}
