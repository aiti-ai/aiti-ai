import { homedir, networkInterfaces } from "os";
import { join } from "path";
import { createServiceTunnels, type ServiceTunnels } from "service-tunnels";
import { getBaseDomains, getPiWebPort, getAllowLocal, getAllowLocalHosts, getAllowLocalPending } from "./service-proxy-shared.ts";

/**
 * service-tunnels integration — library mode inside pi-web.
 *
 * The manager runs in pi-web's process (no daemon): helpers it spawns become
 * pi-web's descendants, discovery scopes to pi-web's process tree, and the
 * internal registry keeps framework ports (nginx/authelia/redis) out of the
 * user-service discovery results.
 *
 * Dirs are pi-web-specific (~/.pi/service-tunnels{,-cache}) so pi-web and a
 * standalone CLI install never share config/cache. Marker "pi-web" keeps the
 * allow-list cache keyed to this instance.
 *
 * SITE isolation (service-tunnels ≥0.2.38, sites-design.md): pi-web's own UI
 * and its subprocess dev servers live in two SEPARATE auth realms — different
 * domains, different user dbs, different providers. `ensureSites()` presets
 * them idempotently; exposeService/exposeSelf route to their own site.
 */

declare global {
  var __piServiceTunnels: ServiceTunnels | undefined;
}

export function getServiceTunnels(): ServiceTunnels {
  if (!globalThis.__piServiceTunnels) {
    // Deployment domains (PI_WEB_BASE_DOMAIN — explicit, host:port allowed;
    // legacy fallbacks PI_WEB_ALLOWED_HOSTS / PI_WEB_HOSTNAME) are passed to
    // the service-tunnels API as the base domain: the proxy serves
    // `<port>[-<label>].<domain>` and expose returns portless baseUrls under
    // them (user nginx reverse-proxies *.<domain> to the proxy port). First
    // host is the primary; host:port forms keep their port in generated URLs.
    const deployHosts = getBaseDomains();
    globalThis.__piServiceTunnels = createServiceTunnels({
      configDir: join(homedir(), ".pi", "service-tunnels"),
      cacheDir: join(homedir(), ".pi", "service-tunnels-cache"),
      marker: "pi-web",
      // 部署转发前缀(deployBasePath)必须传:provider 登录路径合并成 /dev/portal-xxx,
      // 登录重定向/登录页都带部署前缀,走 nginx 路径路由直达本实例。service-tunnels
      // 0.3.11 修复了 hasPath 恒真导致合并失效的问题(此前 provider 监听 /portal 但
      // DEPLOY_BASE_PATH=/dev → 登录 302 嵌套,故该行曾被移除)。
      ...(process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "")
        ? { deployBasePath: (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "") }
        : {},
      // 真实服务默认在根;pi-web 自身暴露时显式传 basePath(见 exposeSelf)
      ...(deployHosts.length
        ? { baseDomain: deployHosts[0], baseDomains: deployHosts.slice(1) }
        : {}),
    });
  }
  return globalThis.__piServiceTunnels;
}

/** pi-web's own process cmdline patterns (never "services"). */
const PI_WEB_OWN = [/next[\\/]dist[\\/]bin[\\/]next/, /next-server/, /pi-web(-options)?\.js/, /bin[\\/]pi-web/];

/** Expose start timestamps (per expose name) — the library's exposes() has no
 *  time; pi-web records it at expose time for the detail modal. Keyed by the
 *  expose name (tunnel name, or `proxy:port:label` for proxy mode). In-memory
 *  only, same lifetime as the library's exposes registry. */
const exposeStartedAt = new Map<string, number>();

/** 当前实例的部署 basePath(与 proxy.ts 的根路径重定向 / pipe 一致)。 */
export function getPiWebBasePath(): string {
  return (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
}

export function getExposeStartedAt(name: string): number | undefined {
  return exposeStartedAt.get(name);
}

export function removeExposeStartedAt(name: string): void {
  exposeStartedAt.delete(name);
}

/** User test services only (framework ports excluded by the registry). */
export function listPiServices() {
  return getServiceTunnels().discovery.getPorts({ excludeCmdline: PI_WEB_OWN });
}

/**
 * Preset the two auth realms (idempotent; a user-registered site wins):
 *   - site "pi-web"    → pi-web's own admin UI (portal, its own users)
 *   - site "services"  → pi-web subprocess dev servers (basic, separate users)
 */
export function ensureSites(): void {
  const st = getServiceTunnels();
  const existing = st.sites.list().map((s) => s.name);
  const presets: Record<string, { provider?: string; domain?: string; policy?: "one_factor" | "two_factor" | "deny" }> = {
    "pi-web": { provider: "portal", policy: "two_factor" },
    services: { provider: "basic" },
  };
  for (const [name, cfg] of Object.entries(presets)) {
    if (existing.includes(name)) continue;
    try {
      st.sites.add(name, cfg);
    } catch {
      // name conflict — keep whatever the user registered
    }
  }
}

/** One-shot expose with optional gateway auth. tunnelParams/providerParams
 *  are schema-driven form values (service-tunnels applies them).
 *
 *  mode: "tunnel" (default, public URL) | "proxy" (local vhost, no tunnel) |
 *        "both" (local vhost + public tunnel, same site).
 *  site: auth realm — "services" (subprocess dev servers), "pi-web" (pi-web's
 *        own UI), or "default" (legacy behavior). Default "default" keeps
 *        existing callers unchanged.
 */
export async function exposeService(
  port: number,
  opts: {
    auth?: boolean;
    tunnel?: string;
    provider?: string;
    mode?: "tunnel" | "proxy" | "both";
    site?: string;
    ngrokAuthtoken?: string;
    policy?: string;
    protocol?: "http" | "https" | "tcp";
    allowToolDownload?: boolean;
    tunnelParams?: Record<string, unknown>;
    providerParams?: Record<string, unknown>;
    /** 真实服务的 base path(默认 "" 根路径;转发时剥部署前缀后接此路径)。 */
    serviceBasePath?: string;
  } = {},
) {
  const st = getServiceTunnels();
  const res = await st.auth.expose(port, {
    auth: opts.auth ?? false,
    mode: opts.mode,
    site: opts.site,
    tunnelType: opts.tunnel ?? "cloudflared",
    provider: opts.provider,
    ngrokAuthtoken: opts.ngrokAuthtoken,
    policy: opts.policy as "one_factor" | "two_factor" | undefined,
    protocol: opts.protocol,
    allowToolDownload: opts.allowToolDownload,
    tunnelParams: opts.tunnelParams,
    providerParams: opts.providerParams,
    // Caller-side naming: the SAME port can be exposed several ways at once
    // (redundant channels — a dead tunnel/provider never takes the others
    // down). tunnelName carries provider + site + tunnel type (+ mode for
    // proxy/both) so each combo gets its own tunnel process; service-tunnels'
    // default would collide on expose-<port>. The default cloudflared/tunnel
    // combo keeps the legacy `expose-<port>-<provider>` name (existing
    // exposes are not renamed).
    tunnelName: `expose-${port}-${opts.provider ?? "direct"}${opts.site && opts.site !== "default" ? `-${opts.site}` : ""}${opts.tunnel && opts.tunnel !== "cloudflared" ? `-${opts.tunnel}` : ""}${opts.mode && opts.mode !== "tunnel" ? `-${opts.mode}` : ""}`,
    // The middleware serves vhosts in-process (st.proxy.resolve) — no
    // separate proxy transport listener.
    startTransport: false,
  });
  // Record when this expose was created (detail modal 开启时间). The library
  // keys exposes the same way: tunnel name, or `proxy:port:label` for proxy.
  const name = res.tunnel || `proxy:${port}:${res.label ?? ""}`;
  exposeStartedAt.set(name, Date.now());
  return res;
}

/** pi-web's OWN UI under site "pi-web" — separate users from dev services. */
export interface SelfExposeOptions {
  mode?: "tunnel" | "proxy" | "both";
  /** Auth provider name (site "pi-web" default is portal). */
  auth?: string;
  policy?: "one_factor" | "two_factor" | "deny";
  /** Tunnel type (mode tunnel/both). */
  tunnel?: string;
  protocol?: "http" | "https" | "tcp";
  allowToolDownload?: boolean;
  ngrokAuthtoken?: string;
  tunnelParams?: Record<string, unknown>;
  providerParams?: Record<string, unknown>;
  /** Pre-provision an auth user (basic/portal). */
  user?: { name: string; password: string };
  /** Override pi-web's own port (default PORT ?? 30141). */
  port?: number;
  /** Direct local access gate: false → only authenticated forwards pass. */
  allowlocal?: boolean;
  /** pi-web 自身服务的 base path(默认 = 实例部署 basePath,转发映射用)。 */
  serviceBasePath?: string;
}

export async function exposeSelf(opts: SelfExposeOptions = {}) {
  const st = getServiceTunnels();
  const port = opts.port ?? getPiWebPort();
  // Idempotent: an already-running self expose wins (hot reload / re-invoke).
  const existing = st.exposes().find((e) => e.site === "pi-web" && e.port === port && e.running);
  if (existing) return existing;
  const authNone = opts.auth === "none";
  const provider = opts.auth && opts.auth !== "auto" && !authNone ? opts.auth : "portal";
  const mode = opts.mode ?? "proxy";
  // 所有模式都注册 labeled 绑定(label "pi-web"):pi-web 是 basePath 应用,
  // labeled vhost 走 pipe 保留完整路径(裸 open vhost 会 strip /dev → 404),
  // 且 auth=none 时 provider="" 由 resolveSite 短路开放。隧道域经 middleware
  // 映射回该 vhost 统一认证,无白名单后门。
  st.proxy.addBinding({
    port,
    label: "pi-web",
    site: "pi-web",
    provider: authNone ? "" : provider,
    // pi-web 自身服务在部署前缀下(/dev):labeled vhost 的 pipe 必须带上
    // serviceBasePath,否则 mapServicePath 剥 deploy 前缀后不接回 → 重写
    // 到 http://127.0.0.1:<port>/api/... 丢掉 /dev → Next 404(自暴露隧道
    // 打开即 404 的根因;裸 open vhost 才会 strip)。
    serviceBasePath: opts.serviceBasePath ?? getPiWebBasePath(),
    ...(opts.policy ? { policy: { policy: opts.policy } } : {}),
  });
  const res = await st.auth.expose(port, {
    // auth "none" → open binding (no gateway); everything else is gated.
    auth: authNone ? "none" : true,
    mode,
    site: "pi-web",
    label: "pi-web",
    ...(provider !== "portal" && !authNone ? { provider } : {}),
    tunnelType: opts.tunnel ?? "cloudflared",
    tunnelName: `expose-self-${port}`,
    serviceBasePath: opts.serviceBasePath ?? getPiWebBasePath(),
    protocol: opts.protocol,
    policy: opts.policy,
    allowToolDownload: opts.allowToolDownload,
    ngrokAuthtoken: opts.ngrokAuthtoken,
    tunnelParams: opts.tunnelParams,
    providerParams: opts.providerParams,
    user: opts.user,
    // Middleware serves vhosts in-process — no separate transport listener.
    startTransport: false,
  });
  // 自暴露同样记录时间 + basePath 选项(详情弹窗 开启时间 / vhost 链接)。
  const name = res.tunnel || `proxy:${port}:${res.label ?? ""}`;
  exposeStartedAt.set(name, Date.now());
  return res;
}

/** Stop pi-web's own exposure: tunnel processes + proxy enrollment. */
export async function stopSelf(): Promise<void> {
  const st = getServiceTunnels();
  const port = getPiWebPort();
  const selfs = st.exposes().filter((e) => e.port === port && (e.site === "pi-web" || e.name?.startsWith("expose-self-")));
  for (const e of selfs) {
    try {
      await st.tunnels.stop(e.name);
    } catch {
      // not a tunnel expose
    }
  }
  // Drop every binding for pi-web's own port (open "" and labeled "pi-web")
  // — an auth="none" self-expose registers an open binding that the
  // site/label filter above would miss.
  for (const b of st.proxy.bindings()) {
    if (b.port === port) {
      try {
        st.proxy.removeBinding(b.port, b.label);
      } catch {
        // already gone
      }
    }
  }
}

/** Current effective self-expose config (env parsed + runtime overrides). */
export function getSelfExposeState() {
  const st = getServiceTunnels();
  const port = getPiWebPort();
  const selfs = st.exposes().filter((e) => e.port === port && (e.site === "pi-web" || e.name?.startsWith("expose-self-")));
  // 自暴露入口信号以 labeled binding 为准：exposeSelf 所有模式（proxy/both/tunnel）
  // 都注册 (port, "pi-web", "pi-web") 绑定；proxy 模式库内 running 恒为 false、
  // 隧道模式由隧道进程决定且隧道挂了 binding 仍在（虚拟主机入口可达）、expose
  // 中途失败还会留下孤儿 binding——只查记录会漏报。mode=none 未暴露时无 binding。
  const selfBindings = st.proxy.bindings().filter((b) => b.port === port && b.label === "pi-web");
  const exposing = selfBindings.length > 0 || selfs.some((e) => e.running);
  const first = selfs[0];
  // 无认证（不带秘）暴露：开放 binding（provider ""）或任一 running 自暴露通道
  // 未挂 provider（auth-none 记录 provider 为空/undefined，tcp 自暴露同样无
  // provider）。运行时换成带认证的暴露方法后 binding/记录同步替换 → 自动消除；
  // 不依赖 env 配置（auth=none 只是启动初始值，不能作为持久信号）。
  const unauthenticated = exposing && (
    selfBindings.some((b) => !b.provider)
    || selfs.some((e) => e.running && !e.provider)
  );
  return {
    exposing,
    unauthenticated,
    allowLocal: getAllowLocal(),
    allowHosts: getAllowLocalHosts(),
    allowLocalPending: getAllowLocalPending(),
    port,
    mode: (first?.label ? "proxy" : undefined) ?? globalThis.__piWebExposeConfig?.mode ?? null,
    auth: first?.provider ?? globalThis.__piWebExposeConfig?.auth ?? null,
    tunnel: first?.tunnelType ?? null,
    config: globalThis.__piWebExposeConfig ?? null,
    urls: getSelfAccessUrls(),
  };
}

/** Every address pi-web's UI is reachable at (loopback / LAN / vhost / tunnel).
 *  noAuth=true → 该入口的无认证（auth-none / tcp）暴露，前端行内标红提示。 */
export function getSelfAccessUrls(): Array<{ label: string; labelKey?: string; labelParams?: Record<string, string>; url: string; gated?: boolean; authEntry?: boolean; tunnel?: string; exposeName?: string; noAuth?: boolean }> {
  const st = getServiceTunnels();
  const port = getPiWebPort();
  const base = (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "");
  // allowlocal=false → 回环与局域网裸直连都被门禁 403(回环也不例外,仅带
  // self-forward token 的内部转发放行);虚拟主机/隧道入口走代理认证不受
  // 直连门禁影响(authEntry=true,关闭期间仍可访问)。
  const allowLocal = getAllowLocal();
  // labelKey = 稳定翻译 id(前端按 locale 翻译;label 为中文回退)
  const out: Array<{ label: string; labelKey?: string; labelParams?: Record<string, string>; url: string; gated?: boolean; authEntry?: boolean; tunnel?: string; exposeName?: string; noAuth?: boolean }> = [];
  out.push({ label: "本机（回环）", labelKey: "services.selfUrl.loopback", url: `http://127.0.0.1:${port}${base}`, gated: !allowLocal });
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        out.push({ label: `局域网（${name}）`, labelKey: "services.selfUrl.lan", labelParams: { name }, url: `http://${a.address}:${port}${base}`, gated: !allowLocal });
      }
    }
  }
  for (const e of st.exposes()) {
    const isSelf = e.site === "pi-web" || e.name?.startsWith("expose-self-");
    if (!isSelf || e.port !== port) continue;
    // 无认证（auth-none / tcp）入口 → noAuth=true，行内标红（与 Ports 页活动列表一致）
    const noAuth = !e.provider;
    // baseUrl 已由库拼接部署前缀(0.3.13+,见 expose.proxyExpose withDeploy);
    // exposeName 让客户端加载即知该 vhost 的停止目标
    if (e.localUrl) out.push({ label: "服务虚拟主机（本机）", labelKey: "services.selfUrl.vhostLocal", url: e.localUrl, authEntry: true, exposeName: e.name, noAuth });
    if (e.baseUrl) out.push({ label: "服务虚拟主机（部署域）", labelKey: "services.selfUrl.vhostBase", url: e.baseUrl, authEntry: true, exposeName: e.name, noAuth });
    if (e.url) out.push({ label: "隧道公网", labelKey: "services.selfUrl.tunnel", url: e.url, authEntry: true, tunnel: e.name, noAuth });
  }
  // allowHost 白名单:关闭期间仍可直连的例外域名(用户自己的反代入口,无端口信息)
  for (const h of getAllowLocalHosts()) {
    out.push({ label: "例外域名（allowHost）", labelKey: "services.selfUrl.allowhost", url: h, authEntry: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PI_WEB_EXPOSE env parsing — plain "k=v,k2=v2" (no JSON), dotted keys nest:
//   mode=both,auth=portal,tunnel=cloudflared,allowlocal=false
//   tunnel.domain=alice.ngrok-free.app,user.name=admin,user.password=pw
//   provider.oidc.issuerUrl=https://...
// ---------------------------------------------------------------------------

const EXPOSE_SCALAR_KEYS = new Set([
  "mode", "auth", "policy", "tunnel", "protocol", "allowToolDownload",
  "port", "ngrokAuthtoken", "allowlocal",
]);

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function setDotted(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Parse PI_WEB_EXPOSE. Unknown keys warn+skip; invalid mode → null (fail-closed). */
export function parseExposeEnv(raw: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let hasKey = false;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || value === "") continue;
    hasKey = true;
    if (key.startsWith("tunnel.")) {
      const tp = (out.tunnelParams ??= {}) as Record<string, unknown>;
      tp[key.slice(7)] = coerce(value);
    } else if (key.startsWith("provider.")) {
      const pp = (out.providerParams ??= {}) as Record<string, unknown>;
      setDotted(pp, key.slice(9), coerce(value));
    } else if (key.startsWith("user.")) {
      const u = (out.user ??= {}) as Record<string, unknown>;
      u[key.slice(5)] = coerce(value);
    } else if (key === "allowHost") {
      // repeatable key: allowHost=a.com,allowHost=b.com (or space-separated)
      const arr = (out.allowHost ??= []) as string[];
      for (const h of value.split(/[\s,]+/)) {
        if (h.trim()) arr.push(h.trim());
      }
    } else if (EXPOSE_SCALAR_KEYS.has(key)) {
      out[key] = coerce(value);
    } else {
      console.warn(`[pi-web] PI_WEB_EXPOSE: 未知键 "${key}"，已忽略`);
    }
  }
  if (!hasKey) return null;
  // mode defaults to "none": PI_WEB_EXPOSE applies configuration
  // (allowlocal / allowHost) without exposing pi-web itself unless explicitly
  // requested. "none" also guards against accidental self-exposure.
  out.mode = out.mode ?? "none";
  const mode = out.mode;
  if (!["tunnel", "proxy", "both", "none"].includes(String(mode))) {
    console.warn(`[pi-web] PI_WEB_EXPOSE: 非法 mode "${mode}"（tunnel|proxy|both|none），不启用自暴露`);
    return null;
  }
  return out;
}

/** Startup hook: parse PI_WEB_EXPOSE and expose pi-web itself (best-effort). */
export async function maybeExposeSelf(): Promise<void> {
  const raw = process.env.PI_WEB_EXPOSE;
  if (!raw?.trim()) return;
  const cfg = parseExposeEnv(raw);
  if (!cfg) {
    console.warn("[pi-web] PI_WEB_EXPOSE 无效，不启用自暴露（fail-closed）");
    return;
  }
  globalThis.__piWebExposeConfig = cfg;
  if (typeof cfg.allowlocal === "boolean") {
    globalThis.__piWebAllowLocalOverride = cfg.allowlocal;
  }
  if (cfg.mode === "none") {
    console.log(`[pi-web] PI_WEB_EXPOSE: mode=none — 仅应用 allowlocal/allowHost 配置，不暴露自身`);
    return;
  }
  try {
    await exposeSelf(cfg as unknown as SelfExposeOptions);
    const mode = cfg.mode ?? "proxy";
    const auth = typeof cfg.auth === "string" ? cfg.auth : "portal";
    console.log(`[pi-web] 自暴露已启用: mode=${mode} auth=${auth} port=${cfg.port ?? getPiWebPort()}`);
  } catch (err) {
    console.error("[pi-web] 自暴露失败:", err);
  }
}
