import { homedir, networkInterfaces } from "os";
import { join } from "path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServiceTunnels, tunnelParamSchemas, AUTH_PARAM_SCHEMAS, type ServiceTunnels } from "service-tunnels";
import { getBaseDomains, getPiWebPort, getAllowLocal, getAllowLocalHosts, getAllowLocalPending } from "./proxy-shared.ts";
import { aggregateInjections, resolveInjection } from "./inject-registry.ts";

/**
 * aiti-devtools injection registry — the extension registers
 * globalThis.__aitiInject.scriptFor(port, url, method) to decide what to
 * inject into proxied responses (transformResponse hook).
 */
export interface AitiInjectRegistry {
  scriptFor: (port: number, url: string, method: string) => string | { html: string; position?: "head" | "prepend" } | null;
}

declare global {
  var __aitiInject: AitiInjectRegistry | undefined;
}

/**
 * service-tunnels integration — library mode inside the host process.
 *
 * The manager runs in the host's process (no daemon): helpers it spawns become
 * the host's descendants, discovery scopes to the host's process tree, and the
 * internal registry keeps framework ports (nginx/authelia/redis) out of the
 * user-service discovery results.
 *
 * Dirs are host-specific (<root>/service-tunnels{,-cache}) so the host and a
 * standalone CLI install never share config/cache. Root: AITI_SERVICE_TUNNELS_DIR
 * (dedicated override) → PI_WEB_DATA_DIR (Docker/Windows data root, independent
 * of ~/.pi) → ~/.pi (legacy default; unset env = unchanged behavior). Marker
 * "pi-web" keeps the allow-list cache keyed to this instance.
 *
 * SITE isolation (service-tunnels ≥0.2.38, sites-design.md): the host's own UI
 * and its subprocess dev servers live in SEPARATE auth realms — different
 * domains, different user dbs, different providers. `ensureSites()` idempotently
 * guarantees the PROTECTED ones ("default" implicit + "pi-web" for the self
 * page) at init; other sites are user-managed (add/remove in the Users tab).
 * exposeService/exposeSelf route to their own site.
 */

declare global {
  var __piServiceTunnels: ServiceTunnels | undefined;
}

// 数据根（S2 路径规范）：专属 env → PI_WEB_DATA_DIR → ~/.pi 原行为（env 未设时与历史完全一致）
const TUNNELS_ROOT = process.env.AITI_SERVICE_TUNNELS_DIR
  || process.env.PI_WEB_DATA_DIR
  || join(homedir(), ".pi");

/**
 * 从盘自愈：重读共享 state.json，把端口登记 upsert 进当前实例（库的 restore
 * 是 Map.set 合并语义，不清掉内存多出的条目）。两处消费：
 *  ① getServiceTunnels() 单例创建时——embedded 模式库不自动 restore（仅 daemon
 *     模式），进程重启后不从盘恢复登记会 vhost 403；
 *  ② middleware 的 not-enrolled 自愈——登记可能由 CLI/同机其它实例在进程启动后
 *     直写共享 state.json（多实例谁最后写为准），而运行中实例只在创建时恢复过
 *     一次，不重读就永远看不到新登记。
 * 返回恢复的登记条数；文件缺失/为空/结构异常一律 0，绝不抛出（自愈路径允许失败）。
 */
export function rehydrateBindingsFromDisk(): number {
  try {
    const st = globalThis.__piServiceTunnels;
    const stateFile = join(TUNNELS_ROOT, "service-tunnels", "cache", "state.json");
    if (!st || !existsSync(stateFile)) return 0;
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { bindings?: unknown[] };
    if (!Array.isArray(state.bindings) || !state.bindings.length) return 0;
    if (typeof st.proxy?.restore !== "function") return 0;
    st.proxy.restore(state.bindings);
    return state.bindings.length;
  } catch {
    return 0;
  }
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
    // 共享 cacheDir（state.json）：端口登记是系统级数据，dev/prod 同机共享；
    // 实例间以「谁最后写为准」处理（开发环境特殊，多实例差异靠稍后同步）。
    globalThis.__piServiceTunnels = createServiceTunnels({
      configDir: join(TUNNELS_ROOT, "service-tunnels", "config"),
      cacheDir: join(TUNNELS_ROOT, "service-tunnels", "cache"),
      marker: "pi-web",
      // 通用响应注入（service-tunnels transformResponse）：__stInjectRegistry
      // 多注册者聚合（任意扩展可注册注入片段；无注册者时零开销）。
      // 库契约单段（string | {html,position}）：聚合结果取 prepend 优先（head 兼容）。
      transformResponse: ({ port, url, method }) => {
        return resolveInjection(aggregateInjections(port, url, method));
      },
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
    // 初始化即确保受保护站点存在（default 隐式永远存在；"pi-web" 是 self
    // 页默认认证域——自暴露/用户管理/告警都指向它，必须存在）。
    try {
      ensureSites();
      ensurePortalBiometricsDefault();
    } catch {
      // sites.json 读写异常不阻断启动（后续 /status 会再试）
    }
    // embedded 模式库不自动 restore bindings（仅 daemon 模式）——进程重启后
    // 从共享 state.json 恢复端口登记，否则每次重启丢登记（vhost 403/循环）。
    try {
      const restored = rehydrateBindingsFromDisk();
      if (restored > 0) console.log(`[service-tunnels] 已恢复 ${restored} 条端口登记`);
    } catch (err) {
      console.error("[service-tunnels] 恢复端口登记失败（非致命）:", err);
    }
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

/** 每次公开的注入配置（expose 名称 → 要注入的源 id 列表）——注入是公开配置的
 *  一部分（跟 provider/tunnel/site/basePath 一样随公开提交），非全局/端口级。 */
const exposeInjectMap = new Map<string, string[]>();
// 注入白名单持久化文件（expose 周期一致：reload 后恢复，stop 时清除；失败静默，不影响注入主体）
let _injectFile: string | null = null;
export function initExposeInjectFile(filePath: string): void {
  _injectFile = filePath;
}
function persistExposeInject(): void {
  if (!_injectFile) return;
  try {
    const obj: Record<string, string[]> = {};
    for (const [k, v] of exposeInjectMap) obj[k] = v;
    writeFileSync(_injectFile, JSON.stringify(obj, null, 2));
  } catch { /* 非致命 */ }
}
/** 恢复注入白名单（service-tunnels startup 调）：读数据文件 → 填内存 map。
 *  仅填充存活项由调用方对账（这里全量恢复——stop expose 已从文件删除，残留项在
 *  resolve 阶段查不到 expose 自然失效，无害）。 */
export function restoreExposeInject(): void {
  if (!_injectFile) return;
  try {
    const raw = readFileSync(_injectFile, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) exposeInjectMap.set(k, v.filter((s) => typeof s === "string" && s));
    }
  } catch { /* 无文件/损坏 → 空 */ }
}
export function setExposeInject(name: string, inject?: string[] | null): void {
  if (!inject || !inject.length) exposeInjectMap.delete(name);
  else exposeInjectMap.set(name, inject.filter((s) => typeof s === "string" && s));
  persistExposeInject();
}
export function getExposeInject(name: string): string[] | undefined {
  return exposeInjectMap.get(name);
}
export function removeExposeInject(name: string): void {
  exposeInjectMap.delete(name);
  persistExposeInject();
}
/** 按 decision（port+site/label）反查该公开通道的注入配置 */
export function resolveExposeInject(port: number, site?: string): string[] | undefined {
  const st = getServiceTunnels();
  try {
    const ex = (st.exposes?.() ?? []).find((e) => e.port === port && ((e.site ?? "") === (site ?? "")));
    return ex && typeof ex.name === "string" ? exposeInjectMap.get(ex.name) : undefined;
  } catch { return undefined; }
}

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

/** 受保护站点（不可删除，UI 禁用删除按钮、API 拒绝）：
 *  - "default"：隐式站点（库 sites.remove 本就抛错），缺省认证域，删了所有
 *    不带 --site 的调用都会崩；
 *  - "pi-web"：self 页（自暴露）默认认证域——exposeSelf/stopSelf/
 *    getSelfExposeState/SelfTab 用户管理全部硬编码指向它，必须存在。
 *  交给 service-tunnels 的时机 = getServiceTunnels() 初始化（ensureSites
 *  幂等确保存在），不是等首次 /status。 */
export const PROTECTED_SITES: readonly string[] = ["default", "pi-web"];

export function isProtectedSite(name: string): boolean {
  return PROTECTED_SITES.includes(name);
}

/** 初始化时确保受保护站点存在（幂等；用户已注册的同名站点配置优先，不覆盖）。
 *  历史上这里还预置过 "services"（子进程服务的建议认证域）——现在站点
 *  用户可增删，预置只保留受保护项，用户删掉的非保护站点不再被悄悄建回。 */
export function ensureSites(): void {
  const st = getServiceTunnels();
  const existing = st.sites.list().map((s) => s.name);
  const presets: Record<string, { provider?: string; domain?: string; policy?: "one_factor" | "two_factor" | "deny"; providerParams?: Record<string, unknown> }> = {
    // biometrics 默认开：portal 站点未显式配置（含关闭）时人脸/语音 2FA 可用；
    // 用户要关 → 显式 providerParams.biometrics=false（迁移尊重已显式设置）。
    "pi-web": { provider: "portal", policy: "two_factor", providerParams: { biometrics: true } },
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

/** portal 站点 biometrics 默认开（用户没配 = 开；显式 biometrics:false = 手工关）。
 * 迁移已存在的 portal 站点：providerParams 未显式含 biometrics 键 → 补 true 写回
 * sites.json（幂等；受保护站点 / 写入失败不阻断）。 */
export function ensurePortalBiometricsDefault(): void {
  const st = getServiceTunnels();
  for (const s of st.sites.list()) {
    if (s.provider !== "portal") continue;
    const pp = (s as { providerParams?: Record<string, unknown> }).providerParams;
    if (pp && "biometrics" in pp) continue; // 显式设置过（开或关）→ 尊重
    try {
      const { name, running, port, hosts, ...cfg } = s as unknown as Record<string, unknown>;
      st.sites.add(s.name, { ...cfg, providerParams: { ...(pp ?? {}), biometrics: true } });
    } catch {
      // 单站点失败不阻断（default 等）
    }
  }
}

/** providerParams 归一化（pi-web 集成层）：
 *  - boolean 字段字符串化值（表单 "true"/"false"）转真布尔——portal 只认 === true；
 *  - biometrics 默认开：未显式设置 → true；显式 false → 尊重（手工关）。
 *  仅 portal 消费 biometrics，对其它 provider 补 true 无副作用。 */
export function normalizeProviderParams(pp?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!pp) return undefined;
  const out: Record<string, unknown> = { ...pp };
  for (const k of ["biometrics"]) {
    if (out[k] === "true") out[k] = true;
    else if (out[k] === "false") out[k] = false;
  }
  if (!("biometrics" in out)) out.biometrics = true;
  return out;
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
    // M3: mode 放开库全联合（portmap 路由器映射 / ipv6 直连）
    mode?: "tunnel" | "proxy" | "both" | "portmap" | "ipv6";
    site?: string;
    ngrokAuthtoken?: string;
    policy?: string;
    protocol?: "http" | "https" | "tcp";
    allowToolDownload?: boolean;
    tunnelParams?: Record<string, unknown>;
    providerParams?: Record<string, unknown>;
    /** mode "portmap" 路由器映射参数（白名单透传，深度 1——api.ts 已过滤）。 */
    portmap?: Record<string, unknown>;
    /** mode "ipv6" 直连入口地址（可选；缺省自动检测 global）。 */
    ipv6?: { address?: string };
    /** 真实服务的 base path(默认 "" 根路径;转发时剥部署前缀后接此路径)。 */
    serviceBasePath?: string;
    /** 本通道要注入的源 id 列表（注入是公开配置的一部分，随公开提交）。 */
    inject?: string[];
    /** 注入「登录信息按钮」（FAB：登录用户名 + 退出登录，可拖动）。 */
    loginInfoButton?: boolean;
  } = {},
) {
  const st = getServiceTunnels();
  // basePath 继承：调用方没传 serviceBasePath 时，从现有 open binding（
  // st.proxy.enrolled()，数据源唯一为库持久化）继承——expose 会覆盖写 binding，
  // 不带 basePath 会把已登记的前缀冲掉 → base 应用（vite --base）302 死循环。
  // basePath 是端口属性，跟 binding 走。
  let serviceBasePath = opts.serviceBasePath;
  if (serviceBasePath === undefined) {
    try {
      const existing = st.proxy.bindings().find((b) => b.port === port && b.label === "");
      if (existing?.serviceBasePath) serviceBasePath = existing.serviceBasePath;
    } catch { /* 读取失败 → 保持缺省 */ }
  }
  const tunnelName = `expose-${port}-${opts.provider ?? "direct"}${opts.site && opts.site !== "default" ? `-${opts.site}` : ""}${opts.tunnel && opts.tunnel !== "cloudflared" ? `-${opts.tunnel}` : ""}${opts.mode && opts.mode !== "tunnel" ? `-${opts.mode}` : ""}`;
  // 已登记（外部）端口跳过库的端口归属校验：外部端口的形态正是进程扫描看不到
  // （另一用户的 systemd/docker 进程 /proc 不可读 → verifyPortOwner 误报
  // "not being listened"；或压根在别的机器），登记本身已是显式管理动作
  // （等同 CLI --force 语义）。未登记端口维持校验，报错引导先登记。
  let skipOwnerCheck = false;
  try {
    skipOwnerCheck = typeof st.proxy.enrolled === "function" && st.proxy.enrolled().some((e) => e.port === port);
  } catch { /* 读取失败 → 维持校验 */ }
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
    providerParams: normalizeProviderParams(opts.providerParams),
    force: skipOwnerCheck,
    ...(opts.portmap && Object.keys(opts.portmap).length ? { portmap: opts.portmap } : {}),
    ...(opts.ipv6?.address ? { ipv6: { address: opts.ipv6.address } } : {}),
    loginInfoButton: opts.loginInfoButton,
    serviceBasePath,
    // 注入是公开配置的一部分（随公开提交，通道级）
    tunnelName,
    // vhost 服务走宿主 in-process middleware（st.proxy.resolve），不另起 transport；
    // 例外：portmap/ipv6 的外部入口是 IP:port（不经 vhost middleware），库需要真实
    // transport 才能建映射/直连——startTransport:false 会让这两模式在
    // transportPort=0 检查处必然报错并回滚（M3 只放开了参数/UI，此选项漏改）。
    ...(opts.mode === "portmap" || opts.mode === "ipv6" ? {} : { startTransport: false }),
  });
  // 记录该通道的注入配置（只在这个通道的页面注入列出的源）。
  // name 与库的记录键一致：隧道名，或 proxy 模式的 `proxy:port:label`。
  const name = res.tunnel || `proxy:${port}:${res.label ?? ""}`;
  setExposeInject(name, opts.inject);
  // Record when this expose was created (detail modal 开启时间). The library
  // keys exposes the same way: tunnel name, or `proxy:port:label` for proxy.
  exposeStartedAt.set(name, Date.now());
  return res;
}

/** pi-web's OWN UI under site "pi-web" — separate users from dev services. */
export interface SelfExposeOptions {
  /** M3 对齐（与 exposeService 同域）：mode 放开库全联合——tunnel/proxy/both/
   *  portmap（路由器映射）/ipv6（公网 IPv6 直连）。缺省 proxy。 */
  mode?: "tunnel" | "proxy" | "both" | "portmap" | "ipv6";
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
  /** mode "portmap" 路由器映射参数（白名单透传，深度 1——api.ts 已过滤）。 */
  portmap?: Record<string, unknown>;
  /** mode "ipv6" 直连入口地址（可选；缺省自动检测 global）。 */
  ipv6?: { address?: string };
  /** 本通道要注入的源 id 列表（注入是公开配置的一部分）。 */
  inject?: string[];
  /** Pre-provision an auth user (basic/portal). */
  user?: { name: string; password: string };
  /** Override pi-web's own port (default PORT ?? 3000). */
  port?: number;
  /** Direct local access gate: false → only authenticated forwards pass. */
  allowlocal?: boolean;
  /** pi-web 自身服务的 base path(默认 = 实例部署 basePath,转发映射用)。 */
  serviceBasePath?: string;
}

export async function exposeSelf(opts: SelfExposeOptions = {}) {
  const st = getServiceTunnels();
  const port = opts.port ?? getPiWebPort();
  const authNone = opts.auth === "none";
  const provider = opts.auth && opts.auth !== "auto" && !authNone ? opts.auth : "portal";
  const mode = opts.mode ?? "proxy";
  const wantsTunnel = mode === "tunnel" || mode === "both";
  // 库 ipv6 侧无「同 key 防重」（activeIpv6.set 直接覆盖旧 handle → 旧 transport /
  // 防火墙规则泄漏；portmap 侧有 M1 防重，见 portmap/index.ts）。宿主兜底：self
  // 改用 ipv6 重新暴露前，先停同 port+label 的旧 transport（self label 恒 "pi-web"）。
  // 常规端口页的常规暴露仍受库侧缺口影响（待库修）。
  if (mode === "ipv6") {
    try {
      const suffix = `:${port}:pi-web`;
      const old = st.ipv6.list().find((t) => t.key.endsWith(suffix));
      if (old) await st.ipv6.stop(old.key).catch(() => { /* best effort */ });
    } catch { /* registry 读取失败不阻断暴露 */ }
  }
  // 幂等短路只对“已存在的同模式通道”（热重载/重复调用复用）：
  //   - tunnel/both → 已有运行中的 expose-self 隧道（记录带 url）
  //   - proxy      → 无隧道进程；重入 st.auth.expose(mode=proxy) 天然幂等
  //                  （binding 覆盖写 + 记录覆盖写），不短路
  // 关键：不同模式请求（已有 tunnel 再点 proxy / 已有 proxy 再点 tunnel）
  // 绝不静默吞掉——否则 UI 表现为“点了没反应、无任何错误”。
  const existingTunnel = st.exposes().find((e) => e.site === "pi-web" && e.port === port && e.running && !!e.url);
  if (wantsTunnel && existingTunnel) return existingTunnel;
  // 所有模式都注册 labeled 绑定(label "pi-web"):pi-web 是 basePath 应用,
  // labeled vhost 走 pipe 保留完整路径(裸 open vhost 会 strip /dev → 404),
  // 且 auth=none 时 provider="" 由 resolveSite 短路开放。隧道域经 middleware
  // 映射回该 vhost 统一认证,无白名单后门。
  // 失败回滚判断：预注册前是否已有同 label 通道（只回滚本次新建的）。
  const hadPriorBinding = (() => {
    try { return st.proxy.bindings().some((b) => b.port === port && b.label === "pi-web"); } catch { return false; }
  })();
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
  // self 暴露的注入配置（公开配置的一部分，随 self-expose 提交）
  setExposeInject(`expose-self-${port}`, opts.inject);
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
    providerParams: normalizeProviderParams(opts.providerParams),
    user: opts.user,
    // M3 对齐：portmap/ipv6 参数透传（与 exposeService 同规则；缺省空对象不传）。
    ...(opts.portmap && Object.keys(opts.portmap).length ? { portmap: opts.portmap } : {}),
    ...(opts.ipv6?.address ? { ipv6: { address: opts.ipv6.address } } : {}),
    // 同 exposeService：portmap/ipv6 需要真实 transport（IP:port 直连不经 vhost
    // middleware），其余模式由宿主 in-process middleware 服务（不另起监听）。
    ...(mode === "portmap" || mode === "ipv6" ? {} : { startTransport: false }),
  });
  // 暴露失败（res.error）：回滚本次预注册的 binding——否则 binding 残留会让
  // getSelfExposeState 误报 exposing=true（实例：ipv6 在「地址检测」阶段早退，
  // 库侧回滚发生在 proxyExpose 之后，覆盖不到 self 的预注册 binding；portmap
  // 的 transport 失败路径自带回滚所以未中招）。仅回滚本次新建的（不清既有通道）。
  // 成功路径的 binding 由库管理（stop 时由 stopSelf/stopExposeWithResources 清）。
  if (res.error && !hadPriorBinding) {
    try { st.proxy.removeBinding(port, "pi-web"); } catch { /* best effort */ }
  }
  // 自暴露同样记录时间 + basePath 选项(详情弹窗 开启时间 / vhost 链接)。
  // 失败不记（避免脏 startedAt）。
  if (!res.error) {
    const name = res.tunnel || `proxy:${port}:${res.label ?? ""}`;
    exposeStartedAt.set(name, Date.now());
  }
  return res;
}

/**
 * 停止一个 expose 记录，**先撤销宿主机侧资源**（portmap 路由器映射 / ipv6
 * 独立 transport + 防火墙），再走库的 tunnels.stop（清 binding / 记录 / 隧道进程）。
 *
 * 为什么需要：库的 in-process 语义下 `tunnels.stop(name)` 对非隧道记录只做
 * `removeBinding + 删记录`——portmap/ipv6 记录的宿主侧资源（路由器映射、独立
 * transport，均为模块级 registry）不在其中；库自带 daemon/ui-api 的停止路径都会
 * 显式调用 `st.portmap.stop(key)` / `st.ipv6.stop(key)`（ui-api.ts `expose-stop`
 * 同规则）。宿主此前缺失这一环 → 停止 portmap 后映射残留（租约内；ssh-router
 * 静态规则不续期也不释放）、停止 ipv6 后 transport + 防火墙残留（至进程退出）。
 *
 * 匹配规则与库 ui-api 相同：registry key 形如 `<configDir>:portmap|ipv6:<port>:<label>`，
 * 按后缀 `:<port>:<label>` 匹配（端口+label 是暴露记录的身份，跨模式唯一）。
 * 读取失败/未命中一律跳过（不阻断停止主流程）。
 */
export async function stopExposeWithResources(name: string): Promise<void> {
  const st = getServiceTunnels();
  try {
    const ex = st.exposes().find((e) => e.name === name) as
      | { port?: number; label?: string; mode?: string | null }
      | undefined;
    // mode 门控（对齐库 daemon 停止语义）：仅 portmap/ipv6 记录才做 registry
    // 撤销——隧道记录无 label（suffix 退化为 :<port>:），若不做门控会误停同端口
    // 空 label（auth=none）的 portmap/ipv6 资源（其记录/binding 仍在，URL 静默失效）。
    if (ex && (ex.mode === "portmap" || ex.mode === "ipv6")) {
      const suffix = `:${ex.port}:${ex.label ?? ""}`;
      const pm = st.portmap.list().find((m) => m.key.endsWith(suffix));
      if (pm) await st.portmap.stop(pm.key).catch(() => { /* best effort */ });
      const v6 = st.ipv6.list().find((t) => t.key.endsWith(suffix));
      if (v6) await st.ipv6.stop(v6.key).catch(() => { /* best effort */ });
    }
  } catch { /* registry 读取失败不阻断停止 */ }
  await st.tunnels.stop(name);
}

/** Stop pi-web's own exposure: tunnel processes + proxy enrollment. */
export async function stopSelf(): Promise<void> {
  const st = getServiceTunnels();
  const port = getPiWebPort();
  const selfs = st.exposes().filter((e) => e.port === port && (e.site === "pi-web" || e.name?.startsWith("expose-self-")));
  for (const e of selfs) {
    try {
      await stopExposeWithResources(e.name);
    } catch {
      // not a tunnel expose
    }
  }
  // Drop every binding for pi-web's own port (open "" and labeled "pi-web")
  // — an auth="none" self-expose registers an open binding that the
  // site/label filter above would miss. 只删自暴露拥有的 label：同端口上其他
  // 用户服务（label 不同）的 binding 不受影响。
  for (const b of st.proxy.bindings()) {
    if (b.port === port && (b.label === "" || b.label === "pi-web")) {
      try {
        st.proxy.removeBinding(b.port, b.label);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * 敏感参数键集——以库的 ParamSpec 标记（type: "password"）为准：隧道 schema
 * （ngrok/frpc/natapp/bore 的 token 等）+ 内置认证 provider schema
 * （oauth2-proxy 的 oidc.clientSecret / oidc.cookieSecret 等）。同步、零 IO
 * （tunnelParamSchemas 只读 process.env 的自定义隧道模板）。
 */
const SENSITIVE_PARAM_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const specs of Object.values(tunnelParamSchemas())) {
    for (const s of specs) if (s.type === "password") keys.add(s.key);
  }
  for (const specs of Object.values(AUTH_PARAM_SCHEMAS)) {
    for (const s of specs) if (s.type === "password") keys.add(s.key);
  }
  return keys;
})();

/** 叶键名启发式兜底：末段命中即视为秘密。覆盖 schema 外的敏感值——oauth2
 *  变体 schema 的 clientSecret/cookieSecret、自定义 provider 插件、以及
 *  PI_WEB_EXPOSE 顶层 ngrokAuthtoken 与 user.password。不匹配非秘密键
 *  （server/domain/port/allowToolDownload 等）。 */
const SENSITIVE_LEAF_RE = /token|secret|password|passwd|authtoken|apikey|api[_-]?key|credential|private[_-]?key/i;

/** 参数键是否敏感（库 ParamSpec password 标记 + 叶键名启发式）——公开方案
 *  持久化（lib/expose-presets.ts）用它决定哪些值需要加密存储。 */
export function isSensitiveExposeParam(key: string): boolean {
  return SENSITIVE_PARAM_KEYS.has(key) || SENSITIVE_LEAF_RE.test(key);
}

function maskSecret(v: string): string {
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}

/** 深拷贝并掩码 __piWebExposeConfig 的敏感值（以库的 ParamSpec type:
 *  "password" 标记为准，叶键名启发式兜底）。config 只作状态查询/展示，
 *  绝不原样下发明文凭据——与 GET /api/service-tunnels 的 exposeParams 掩码一致。 */
export function sanitizeExposeConfig(cfg: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!cfg) return null;
  const seen = new Set<object>();
  const walk = (node: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (SENSITIVE_PARAM_KEYS.has(path) || SENSITIVE_LEAF_RE.test(k)) {
        out[k] = typeof v === "string" ? maskSecret(v) : "••••";
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v) && !seen.has(v as object)) {
        seen.add(v as object);
        out[k] = walk(v as Record<string, unknown>, path);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return walk(cfg, "");
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
    // mode 以运行时记录为准（库 exposes() 运行时对象带 mode；对外类型声明未含
    // 该字段，这里按结构化子集读取）：portmap/ipv6/proxy 都能正确回显；旧记录
    // 无 mode 时沿用 label→proxy 推断。
    mode: ((first as { mode?: string | null } | undefined)?.mode ?? undefined)
      ?? (first?.label ? "proxy" : undefined)
      ?? globalThis.__piWebExposeConfig?.mode ?? null,
    auth: first?.provider ?? globalThis.__piWebExposeConfig?.auth ?? null,
    tunnel: first?.tunnelType ?? null,
    config: sanitizeExposeConfig(globalThis.__piWebExposeConfig ?? null),
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
    // url 行分两类：真隧道（记录名 expose-self-<port>，停止走 self-stop-tunnel）与
    // 直连入口（portmap/ipv6 记录名 proxy:<port>:<label>，只有 url 无隧道进程——
    // 若仍按 tunnel 下发，SelfTab 的停止按钮会调 self-stop-tunnel 被 400 拒绝；
    // 改 exposeName 走 vhost 停止（tunnel-stop → stopExposeWithResources））。
    if (e.url) {
      const isTunnel = (e.name ?? "").startsWith("expose-self-");
      out.push({
        label: isTunnel ? "隧道公网" : "直连（IP:端口 / IPv6）",
        labelKey: isTunnel ? "services.selfUrl.tunnel" : "services.selfUrl.ipDirect",
        url: e.url,
        authEntry: true,
        ...(isTunnel ? { tunnel: e.name } : { exposeName: e.name }),
        noAuth,
      });
    }
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

