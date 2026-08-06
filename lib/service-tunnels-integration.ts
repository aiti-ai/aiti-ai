import { homedir, networkInterfaces } from "os";
import { join } from "path";
import { createServiceTunnels, type ServiceTunnels } from "service-tunnels";
import { getBaseDomains, getPiWebPort, getAllowLocal, getAllowLocalHosts } from "./service-proxy-shared.ts";

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
      // Deployment base path merges under auth-provider login paths:
      // PI_WEB_BASE_PATH=/dev → portal login at /dev/portal/login
      // (plain /portal/login when pi-web is root-deployed).
      ...((process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "") ? { deployBasePath: (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "") } : {}),
      ...(deployHosts.length
        ? { baseDomain: deployHosts[0], baseDomains: deployHosts.slice(1) }
        : {}),
    });
  }
  return globalThis.__piServiceTunnels;
}

/** pi-web's own process cmdline patterns (never "services"). */
const PI_WEB_OWN = [/next[\\/]dist[\\/]bin[\\/]next/, /next-server/, /pi-web(-options)?\.js/, /bin[\\/]pi-web/];

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
  } = {},
) {
  const st = getServiceTunnels();
  return st.auth.expose(port, {
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
    // Caller-side naming: same port can be exposed with several providers;
    // distinct tunnelName keeps them coexisting (service-tunnels default would
    // collide on expose-<port>).
    tunnelName: `expose-${port}-${opts.provider ?? "direct"}`,
    // The middleware serves vhosts in-process (st.proxy.resolve) — no
    // separate proxy transport listener.
    startTransport: false,
  });
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
  // Tunnel-only mode still registers the proxy virtual-host binding so the
  // middleware can map the public tunnel domain back to <port>-pi-web.<suffix>
  // and authenticate it through resolve() — all authorized access flows
  // through the proxy, there is no whitelist backdoor.
  if (mode === "tunnel") {
    try {
      st.proxy.addBinding({
        port,
        label: "pi-web",
        site: "pi-web",
        provider: opts.auth === "none" ? "" : provider,
        ...(opts.policy ? { policy: { policy: opts.policy } } : {}),
      });
    } catch {
      // binding already exists — fine
    }
  }
  return st.auth.expose(port, {
    // auth "none" → open binding (no gateway); everything else is gated.
    auth: authNone ? "none" : true,
    mode,
    site: "pi-web",
    ...(provider !== "portal" && !authNone ? { provider } : {}),
    tunnelType: opts.tunnel ?? "cloudflared",
    tunnelName: `expose-self-${port}`,
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
  const exposing = selfs.some((e) => e.running);
  const first = selfs[0];
  return {
    exposing,
    allowLocal: getAllowLocal(),
    allowHosts: getAllowLocalHosts(),
    port,
    mode: (first?.label ? "proxy" : undefined) ?? globalThis.__piWebExposeConfig?.mode ?? null,
    auth: first?.provider ?? globalThis.__piWebExposeConfig?.auth ?? null,
    tunnel: first?.tunnelType ?? null,
    config: globalThis.__piWebExposeConfig ?? null,
    urls: getSelfAccessUrls(),
  };
}

/** Every address pi-web's UI is reachable at (loopback / LAN / vhost / tunnel). */
export function getSelfAccessUrls(): Array<{ label: string; url: string; gated?: boolean }> {
  const st = getServiceTunnels();
  const port = getPiWebPort();
  const base = (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "");
  // allowlocal=false → 非回环直连(局域网 IP)被门禁 403;回环始终可用;
  // 虚拟主机/隧道入口走代理认证,不受直连门禁影响。
  const allowLocal = getAllowLocal();
  const out: Array<{ label: string; url: string; gated?: boolean }> = [];
  out.push({ label: "本机（回环）", url: `http://127.0.0.1:${port}${base}` });
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        out.push({ label: `局域网（${name}）`, url: `http://${a.address}:${port}${base}`, gated: !allowLocal });
      }
    }
  }
  for (const e of st.exposes()) {
    const isSelf = e.site === "pi-web" || e.name?.startsWith("expose-self-");
    if (!isSelf || e.port !== port) continue;
    if (e.localUrl) out.push({ label: "服务虚拟主机（本机）", url: e.localUrl });
    if (e.baseUrl) out.push({ label: "服务虚拟主机（部署域）", url: e.baseUrl });
    if (e.url) out.push({ label: "隧道公网", url: e.url });
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
