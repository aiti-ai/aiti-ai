/**
 * service-tunnels extension · API 处理器。
 *
 * 宿主经 /api/extensions/service-tunnels/<path> 分发（catch-all 路由已做
 * DNS-rebinding 门禁）。映射原 pi-web 的 app/api/service-tunnels 与
 * app/api/services 两个路由的语义到 path 段：
 *
 *   GET  /status            — service-tunnels 状态（发现/内部端口/隧道/provider/站点/self）
 *   GET  /services          — 端口候选列表（原 /api/services 语义）
 *   GET  /status?self-only=1 / ?logs=<name> / ?logs-list=<name> / ?detect=<port>
 *   POST /<action>          — expose / tunnel-* / user-* / totp-* / site-* / self-* / preset-*
 *
 * 性能：tools 探测（which 子进程逐个 spawn）很贵（~700ms）——10s TTL 缓存，
 * 工具安装状态变化频率极低，避免每次打开对话框/轮询都全量重扫。
 */
import {
  getServiceTunnels,
  listPiServices,
  exposeService,
  ensureSites,
  isProtectedSite,
  PROTECTED_SITES,
  exposeSelf,
  stopSelf,
  stopExposeWithResources,
  getSelfExposeState,
  getExposeStartedAt,
  removeExposeStartedAt,
  removeExposeInject,
  type SelfExposeOptions,
} from "./integration.ts";

/**
 * portmap 参数白名单（深度 1：只收标量键；sshRouter.* 复杂参数走 CLI——
 * 方案 §5 M3「portmap/ipv6 参数白名单透传（深度 1）」）。expose / self-expose 共用。
 */
const PM_KEYS = ["method", "gateway", "externalPort", "leaseSeconds", "controlUrl", "serviceType", "ssdpTimeoutMs"] as const;
function pickPortmapParams(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(([k, val]) =>
      (PM_KEYS as readonly string[]).includes(k) && (typeof val === "string" || typeof val === "number") && val !== ""),
  );
  return Object.keys(out).length ? out : undefined;
}

// tools 探测缓存（进程级；TTL 5min——工具安装状态变化极低频）
let toolStatusCache: { at: number; allowDownload: boolean; toolStatus: unknown } | null = null;
function cachedToolStatus(st: { tools: { allowDownload(): boolean; list(): unknown } }) {
  const now = Date.now();
  if (toolStatusCache && now - toolStatusCache.at < 300_000) return toolStatusCache;
  // startup 预热缓存（globalThis，跨 reload 保留）
  const pre = (globalThis as Record<string, unknown>).__stToolCache as { at: number; allowDownload: boolean; toolStatus: unknown } | undefined;
  if (pre && now - pre.at < 300_000) { toolStatusCache = pre; return pre; }
  toolStatusCache = { at: now, allowDownload: st.tools.allowDownload(), toolStatus: st.tools.list() };
  return toolStatusCache;
}
import {
  getServicePorts,
  getServiceHostSuffix,
  getServiceHostSuffixes,
} from "./ports.ts";
import { getTunnelInfos } from "./tunnels.ts";
import {
  listExposePresets,
  loadExposePreset,
  saveExposePreset,
  deleteExposePreset,
  saveLastUsedExpose,
  type ExposePresetConfig,
} from "./expose-presets.ts";
import {
  setAllowLocalHosts,
  setAllowLocalTemporary,
  confirmAllowLocal,
  getAllowLocalPending,
  getBaseDomains,
  getLocalhostVhostUrls,
} from "./proxy-shared.ts";
import { detectProtocol, type TunnelConfig, type ParamSpec } from "service-tunnels";
import { getInjectRegistry } from "./inject-registry.ts";
// M3 分域：新功能域（先于遗留 if 链尝试；null = 非本域 → 继续遗留路由）
import { handleExtrasApi } from "./api/extras.ts";
import { handleDdnsApi } from "./api/ddns.ts";
import { handleDoctorApi, doctorMockEnabled } from "./api/doctor.ts";
import { cachedCapabilities, detectCapabilities } from "./capabilities.ts";

/** enrolled 列表：优先库 0.3.41+ 的 enrolled()，旧实例回退 bindings() 过滤
 *  （单例跨 reload 复用——旧实例没有新方法）。 */
function enrolledPorts(st: { proxy: { enrolled?: () => Array<{ port: number; serviceBasePath?: string }>; bindings: () => Array<{ port: number; label: string; site: string; provider: string; serviceBasePath?: string }> } }): Array<{ port: number; serviceBasePath?: string }> {
  if (typeof st.proxy.enrolled === "function") return st.proxy.enrolled();
  return st.proxy.bindings()
    .filter((b) => b.label === "" && b.site === "default" && b.provider === "")
    .map((b) => ({ port: b.port, ...(b.serviceBasePath !== undefined ? { serviceBasePath: b.serviceBasePath } : {}) }));
}

/** 宿主分发上下文（/api/extensions/<id>/<path> 的 path/searchParams + core）。 */
export interface ExtApiContextLike {
  method: string;
  path: string[];
  searchParams: URLSearchParams;
  configDir?: string;
  core?: {
    fileAccess?: { allowRoot(root: string): void };
  };
}

/** 库端漏翻修复（原 app/api/service-tunnels/route.ts 同款）。 */
function repairSchemaL10n(
  localized: Record<string, ParamSpec[]>,
  raw: Record<string, ParamSpec[]>,
): Record<string, ParamSpec[]> {
  const out: Record<string, ParamSpec[]> = {};
  for (const [type, specs] of Object.entries(localized)) {
    const rawSpecs = raw[type] ?? [];
    out[type] = specs.map((s, i) => {
      const r = rawSpecs[i];
      if (!r) return s;
      const fixed: ParamSpec = { ...s };
      for (const f of ["label", "description", "placeholder", "linkTitle"] as const) {
        const keyName = (s as unknown as Record<string, unknown>)[`${f}Key`] as string | undefined;
        if (keyName && (s as unknown as Record<string, unknown>)[f] === keyName && r[f] !== undefined) {
          (fixed as unknown as Record<string, unknown>)[f] = r[f];
        }
      }
      if (s.options && r.options) {
        fixed.options = s.options.map((o, j) => {
          const ro = r.options?.[j];
          if (ro && o.labelKey && o.label === o.labelKey && ro.label !== undefined) {
            return { ...o, label: ro.label };
          }
          return o;
        });
      }
      return fixed;
    });
  }
  return out;
}

/** portal biometrics 默认开（表单默认勾选；用户可取消 = 显式关）。
 * 仅改 portal 的 biometrics 字段 default，其余 schema 不动。 */
function patchBiometricsDefault(schemas: Record<string, ParamSpec[]>): Record<string, ParamSpec[]> {
  const out: Record<string, ParamSpec[]> = { ...schemas };
  out.portal = (out.portal ?? []).map((s) => (s.key === "biometrics" ? { ...s, default: true } : s));
  return out;
}

/** Expose 详情弹窗的隧道参数（掩码敏感值）——原 route.ts 同款。 */
function exposeParams(cfg: TunnelConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const mask = (v: string) => `••••${v.slice(-4)}`;
  if (cfg.domain) out.domain = cfg.domain;
  if (cfg.server) out.server = cfg.server;
  if (cfg.host) out.host = cfg.host;
  if (cfg.user) out.user = cfg.user;
  if (cfg.port) out.port = String(cfg.port);
  if (cfg.remotePort) out.remotePort = String(cfg.remotePort);
  if (cfg.token) out.token = mask(cfg.token);
  if (cfg.args?.length) out.args = cfg.args.join(" ");
  if (cfg.cmd) out.cmd = cfg.cmd;
  if (cfg.env) {
    for (const [k, v] of Object.entries(cfg.env)) {
      out[k] = /token|secret|password|key/i.test(k) ? mask(v) : v;
    }
  }
  return out;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** 从 req.url 提取扩展 API 基址（含部署 basePath，如 /dev/api/extensions/service-tunnels）。
 *  浏览器加载 face-assets 用绝对路径。 */
function apiBase(ctx: { path?: string[] }): string {
  try {
    const u = new URL((globalThis as unknown as { __lastReqUrl?: string }).__lastReqUrl ?? "http://x/api/extensions/service-tunnels");
    const m = u.pathname.match(/^(.*\/api\/extensions\/service-tunnels)/);
    return m?.[1] ?? "/api/extensions/service-tunnels";
  } catch {
    return "/api/extensions/service-tunnels";
  }
}

export async function handleApi(req: Request, ctx: ExtApiContextLike): Promise<Response | null> {
  (globalThis as unknown as { __lastReqUrl?: string }).__lastReqUrl = req.url;
  const p = ctx.path || [];
  const search = ctx.searchParams;

  // ---- M3 分域路由：新功能域优先（extras / ddns / doctor）----
  for (const domain of [handleExtrasApi, handleDdnsApi, handleDoctorApi]) {
    const viaDomain = await domain(req, ctx);
    if (viaDomain) return viaDomain;
  }

  // ---- GET /services（原 /api/services 语义：端口候选 + 后缀 + 隧道 + 平台） ----
  if (req.method === "GET" && (p[0] === "services" || (p.length === 0 && p[0] === undefined))) {
    const refresh = search.get("refresh") === "1";
    // P2 identity+labels：库 enrichWithIdentity（缓存 5min/30s 兜底，轮询零外呼）
    // + 用户 label 合并（label > title 主行规则由共享层 identityView 消费端执行）。
    // 旧库无子路径模块 → 恒 undefined，客户端回落 cmdline（探测式降级）。
    let services: unknown[] | null = null;
    try {
      // 动态 import + 物理兜底（importLib）：静态根导入在「宿主 exports 解析缓存旧视图」下会炸扩展加载
      const { importLib } = await import("./lib-import.ts");
      const idMod = await importLib<{ enrichWithIdentity?: (ports: unknown[]) => Promise<unknown[]> }>("port-identity");
      if (!idMod || typeof idMod.enrichWithIdentity !== "function") throw new Error("enrich unavailable");
      const st = getServiceTunnels() as unknown as { state(): { serviceLabels?: Record<string, string> } };
      const labels = st.state?.()?.serviceLabels ?? {};
      const ports = getServicePorts(refresh) as Array<{ port: number } & Record<string, unknown>>;
      services = (await enrichWithIdentity(ports)).map((s: { port: number; identity?: Record<string, unknown> }) => {
        const label = labels[String(s.port)];
        return label ? { ...s, identity: { ...(s.identity ?? {}), label } } : s;
      });
    } catch { services = null; }
    return json({
      services: services ?? getServicePorts(refresh),
      serviceHostSuffix: getServiceHostSuffix(),
      serviceHostSuffixes: getServiceHostSuffixes(),
      tunnels: getTunnelInfos(),
      platform: process.platform,
    });
  }

  // ---- GET /enroll —— open 端口登记（数据源=库 binding，无第二文件） ----
  if (req.method === "GET" && p[0] === "enroll") {
    return json({ ports: enrolledPorts(getServiceTunnels()) });
  }

  // ---- PATCH /enroll { port, basePath?, remove? } —— 增量更新单个端口 ----
  // Base Path 保存 / 单端口登记开关：不触发全量同步，避免客户端陈旧列表覆盖
  // 其它端口（多卡片/并行会话操作时不互相干扰）。
  if (req.method === "PATCH" && p[0] === "enroll") {
    try {
      const body = (await req.json().catch(() => ({}))) as { port?: unknown; basePath?: string; remove?: boolean };
      const port = Number(body.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return json({ error: "invalid port" }, 400);
      const st = getServiceTunnels() as { proxy: { enroll?: (p: number, o?: { serviceBasePath?: string }) => void; unenroll?: (p: number) => void; addBinding: (b: Record<string, unknown>) => void; removeBinding: (p: number, l: string) => void } };
      if (body.remove) {
        if (typeof st.proxy.unenroll === "function") st.proxy.unenroll(port);
        else st.proxy.removeBinding(port, "");
      } else if (typeof st.proxy.enroll === "function") {
        // basePath 缺省 = 保留现值；空串 = 清除；值 = 覆盖（纯配置语义）
        const bp = body.basePath !== undefined ? body.basePath : undefined;
        st.proxy.enroll(port, bp === undefined ? {} : { serviceBasePath: bp });
      } else {
        const bp = body.basePath;
        st.proxy.addBinding({ port, label: "", site: "default", provider: "", ...(bp ? { serviceBasePath: bp } : {}) });
      }
      return json({ ok: true, ports: enrolledPorts(st) });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // ---- PUT /enroll { ports: [{port, basePath?}] } —— 全量登记/取消 ----
  // 不在列表中的端口 unenroll；serviceBasePath 缺省保留现值、空串清除。
  if (req.method === "PUT" && p[0] === "enroll") {
    try {
      const body = (await req.json().catch(() => ({}))) as { ports?: Array<{ port: number; basePath?: string }> };
      const entries = Array.isArray(body.ports) ? body.ports.filter((e) => Number.isInteger(e?.port) && e.port > 0 && e.port <= 65535) : [];
      const st = getServiceTunnels() as { proxy: { enrolled?: () => Array<{ port: number; serviceBasePath?: string }>; bindings: () => Array<{ port: number; label: string; site: string; provider: string; serviceBasePath?: string }>; enroll?: (p: number, o?: { serviceBasePath?: string }) => void; unenroll?: (p: number) => void; addBinding: (b: Record<string, unknown>) => void; removeBinding: (p: number, l: string) => void } };
      const cur = new Set(enrolledPorts(st).map((e) => e.port));
      const wanted = new Set(entries.map((e) => e.port));
      for (const port of cur) {
        if (!wanted.has(port)) {
          if (typeof st.proxy.unenroll === "function") st.proxy.unenroll(port);
          else st.proxy.removeBinding(port, "");
        }
      }
      for (const e of entries) {
        if (typeof st.proxy.enroll === "function") st.proxy.enroll(e.port, { serviceBasePath: e.basePath });
        else {
          const existing = st.proxy.bindings().find((b) => b.port === e.port && b.label === "");
          const bp = e.basePath !== undefined ? e.basePath : existing?.serviceBasePath;
          st.proxy.addBinding({ port: e.port, label: "", site: "default", provider: "", ...(bp ? { serviceBasePath: bp } : {}) });
        }
      }
      return json({ ok: true, ports: enrolledPorts(st) });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // ---- GET /detect?port=<n> —— 外部登记端口按需识别 ----
  // 外部端口（进程树看不到）展开时调：强制刷新一次进程发现 + 库 port-identity
  // HTTP 探测（title/favicon/协议，带缓存），合并返回供卡片展示。
  if (req.method === "GET" && p[0] === "detect") {
    const port = Number(search.get("port"));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return json({ error: "invalid port" }, 400);
    let service: ReturnType<typeof getServicePorts>[number] | null = null;
    try { service = getServicePorts(true).find((s) => s.port === port) ?? null; } catch { service = null; }
    let identity: Record<string, unknown> | null = null;
    try {
      const { importLib } = await import("./lib-import.ts");
      const idMod = await importLib<{ identifyPort?: (port: number) => Promise<Record<string, unknown>> }>("port-identity");
      if (idMod && typeof idMod.identifyPort === "function") identity = await idMod.identifyPort(port);
    } catch { identity = null; }
    return json({ port, service, identity });
  }

  // ---- GET /status（原 /api/service-tunnels 语义） ----
  if (req.method === "GET" && (p[0] === "status" || p[0] === undefined || p.length === 0)) {
    try {
      const st = getServiceTunnels();
      if (search.get("self-only") === "1") {
        return json({ self: getSelfExposeState() });
      }
      ensureSites();
      const providers = st.auth.providers();
      const lang = search.get("lang") ?? req.headers.get("accept-language")?.split(",")[0] ?? undefined;
      const logsName = search.get("logs");
      if (logsName) {
        const expose = st.exposes().find((e) => e.name === logsName);
        if (!expose?.accessLog) return json({ error: "expose not found" }, 404);
        const { readFileSync, existsSync } = await import("node:fs");
        const tail = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").slice(-50).join("\n") : "(no log yet)");
        return json({ access: tail(expose.accessLog), error: tail(expose.errorLog ?? "") });
      }
      const logsListName = search.get("logs-list");
      if (logsListName) {
        const expose = st.exposes().find((e) => e.name === logsListName);
        if (!expose) return json({ error: "expose not found" }, 404);
        const { readdirSync, statSync, existsSync } = await import("node:fs");
        const { resolve, dirname, basename, join } = await import("node:path");
        const hosts = new Set<string>();
        for (const u of [expose.url, expose.localUrl, expose.baseUrl, expose.domainUrl, expose.loginUrl]) {
          if (!u) continue;
          try { hosts.add(new URL(u).host); } catch { /* ignore */ }
        }
        const paths = new Set<string>();
        for (const pp of [expose.accessLog, expose.errorLog]) if (pp) paths.add(pp);
        const gatewayDir = expose.accessLog ? dirname(expose.accessLog) : null;
        if (gatewayDir && existsSync(gatewayDir)) {
          for (const host of hosts) {
            for (const suffix of [".access.log", ".error.log"]) paths.add(join(gatewayDir, `${host}${suffix}`));
          }
          for (const f of readdirSync(gatewayDir)) {
            if (f.endsWith(".access.log") || f.endsWith(".error.log")) {
              const host = f.replace(/\.(access|error)\.log$/, "");
              if (hosts.has(host)) paths.add(join(gatewayDir, f));
            }
          }
        }
        const files = [...paths]
          .filter((pp) => pp && existsSync(pp))
          .map((pp) => { const s = statSync(pp); return { name: basename(pp), path: pp, size: s.size, mtime: s.mtimeMs }; })
          .sort((a, b) => a.name.localeCompare(b.name));
        if (files.length) {
          // 让宿主 /api/files 能读日志目录
          ctx.core?.fileAccess?.allowRoot(resolve(dirname(files[0]!.path)));
        }
        return json({ files });
      }
      const detectPort = Number(search.get("detect"));
      if (Number.isInteger(detectPort) && detectPort >= 1 && detectPort <= 65535) {
        return json({ port: detectPort, protocol: await detectProtocol(detectPort) });
      }
      const p0 = { services: listPiServices() };
      const p1 = {
        internal: st.internal.list(),
        tunnels: st.tunnels.list(),
      };
      const p2 = {
        exposes: st.exposes().map((e) => {
          const cfg = st.tunnels.configs().find((c) => c.name === e.name);
          let running = e.running;
          if ((e.name ?? "").startsWith("proxy:") && e.label !== undefined) {
            running = Boolean(st.proxy.bindings().some((b) => b.port === e.port && (b.label ?? "") === (e.label ?? "")));
          }
          // 当前 binding 的 serviceBasePath（vhost 剥部署前缀后接回的服务前缀，
          // 详情弹窗展示；proxy/both 模式才有，open 绑定可能为空字符串）
          const binding = st.proxy.bindings().find((b) => b.port === e.port && (b.label ?? "") === (e.label ?? ""));
          return {
            ...e,
            running,
            startedAt: getExposeStartedAt(e.name) ?? null,
            params: cfg ? exposeParams(cfg) : null,
            serviceBasePath: binding?.serviceBasePath ?? null,
            // 回环域名(*.localhost)的 vhost URL——必须带 pi-web 真实端口才可点
            // (库端 baseUrl 只输出首个部署域,localhost 域名被漏掉)。
            altUrls: (e.mode === "proxy" || e.mode === "both") && running
              ? getLocalhostVhostUrls(e.port, e.label)
              : [],
          };
        }),
      };
      const p3 = {
        providers,
        providerOrder: st.auth.providerOrder(),
        defaultProvider: st.auth.defaultProvider(),
        tunnelSchemas: st.schemas.tunnels(lang),
        tunnelMetas: st.schemas.metas(),
      };
      const p4 = {
        totpProviders: st.auth.totpProviders(),
        // 生物 2FA（人脸/语音）可管理的 provider（UI 显示门槛；portal）
        biometricProviders: (st.auth as unknown as { biometricProviders?: () => string[] }).biometricProviders?.() ?? [],
        userManagers: st.auth.userManagers(),
        authProviderSchemas: patchBiometricsDefault(repairSchemaL10n(
          await st.schemas.authProviders(lang),
          await st.schemas.authProviders("en"),
        )),
        authMetas: st.schemas.authMetas(),
        tunnelTcpSupport: st.tunnels.tcpSupport ? st.tunnels.tcpSupport() : [],
      };
      const _tools = cachedToolStatus(st);
      const p5 = {
        allowToolDownload: _tools.allowDownload,
        toolStatus: _tools.toolStatus,
        dirs: st.dirs,
        daemon: st.daemon.status(),
      };
      const p6 = {
        sites: st.sites.list(),
        protectedSites: [...PROTECTED_SITES],
        proxy: st.proxy.status ? st.proxy.status() : null,
        self: getSelfExposeState(),
        exposePresets: listExposePresets(),
      };
      const p7 = {
        // 注入源清单（__stInjectRegistry 注册者；软依赖：无注册者 → 空数组）
        injectSources: [...getInjectRegistry().providers().entries()]
          .filter(([id, p]) => id !== "aiti-devtools" || typeof p.label === "string")
          .map(([id, p]) => ({ id, label: p.label ?? id, ...(p.description ? { description: p.description } : {}) })),
      };
      // M1 capabilities（探测式；startup 已缓存，冷路径（测试）现场探测一次）
      const p8 = {
        capabilities: cachedCapabilities() ?? await detectCapabilities(st),
        ...(doctorMockEnabled() ? { doctorMock: true } : {}),
      };
      return json({
        ...p0, ...p1, ...p2, ...p3, ...p4, ...p5, ...p6, ...p7, ...p8,
      });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // ---- POST actions ----
  if (req.method === "POST") {
    // 兼容两种形态：POST /api/extensions/service-tunnels/<action>（path 段）或
    // POST /api/extensions/service-tunnels/status（body.action，老 client 形态）。
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = (p[0] && p[0] !== "status" ? p[0] : "") || String(body.action ?? "");
    try {
      const b = body as {
        action?: string;
        port?: number;
        auth?: boolean;
        tunnel?: string;
        provider?: string;
        ngrokAuthtoken?: string;
        policy?: string;
        protocol?: "http" | "https" | "tcp";
        // M3: mode 放开库全联合（portmap/ipv6 表单直开）
        mode?: "tunnel" | "proxy" | "both" | "portmap" | "ipv6";
        site?: string;
        allowToolDownload?: boolean;
        tunnelParams?: Record<string, unknown>;
        providerParams?: Record<string, unknown>;
        serviceBasePath?: string;
        name?: string;
        allowDownload?: boolean;
        code?: string;
        /** 本通道注入源 id 列表（公开配置的一部分）。 */
        inject?: string[];
        /** 注入「登录信息按钮」。 */
        loginInfoButton?: boolean;
        /** mode portmap 路由器映射参数（白名单过滤后进 exposeService）。 */
        portmap?: Record<string, unknown>;
        /** mode ipv6 直连入口地址。 */
        ipv6?: { address?: string };
      };
      if (b.tunnel === "command") {
        return json({ error: "tunnel type 'command' is not allowed" }, 400);
      }
      if (action === "expose" || (!action && b.port)) {
        const port = Number(b.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return json({ error: "port required (1-65535)" }, 400);
        }
        const protocol = b.protocol === "http" || b.protocol === "https" || b.protocol === "tcp"
          ? b.protocol
          : undefined;
        // portmap 参数白名单（深度 1：只收标量键；sshRouter.* 复杂参数走 CLI——
        // 方案 §5 M3「portmap/ipv6 参数白名单透传（深度 1）」）
        const portmap = pickPortmapParams(b.portmap);
        const res = await exposeService(port, {
          auth: b.auth,
          protocol,
          mode: b.mode,
          site: b.site,
          tunnel: b.tunnel,
          provider: b.provider,
          ngrokAuthtoken: b.ngrokAuthtoken,
          allowToolDownload: b.allowToolDownload,
          policy: b.policy,
          tunnelParams: b.tunnelParams,
          providerParams: b.providerParams,
          ...(portmap && Object.keys(portmap).length ? { portmap } : {}),
          ...(b.ipv6 && typeof b.ipv6.address === "string" ? { ipv6: { address: b.ipv6.address } } : {}),
          serviceBasePath: b.serviceBasePath,
          inject: b.inject,
          loginInfoButton: b.loginInfoButton === true,
        });
        saveLastUsedExpose({
          provider: b.provider ?? null,
          tunnel: b.tunnel ?? "cloudflared",
          protocol: protocol ?? "http",
          mode: b.mode ?? "tunnel",
          site: b.site ?? "",
          serviceBasePath: typeof b.serviceBasePath === "string" ? b.serviceBasePath : "",
          inject: Array.isArray(b.inject) ? b.inject.filter((s) => typeof s === "string") : undefined,
          loginInfoButton: b.loginInfoButton === true,
          tunnelParams: (b.tunnelParams ?? {}) as Record<string, string>,
          providerParams: (b.providerParams ?? {}) as Record<string, string>,
        } as ExposePresetConfig);
        // 与 /status 一致：proxy/both 模式附 localhost 域名 vhost URL（带真实端口）
        if (res && !res.error && (res.mode === "proxy" || res.mode === "both")) {
          (res as Record<string, unknown>).altUrls = getLocalhostVhostUrls(port, res.label);
        }
        return json(res);
      }
      const st = getServiceTunnels();
      switch (action) {
        case "tunnel-start":
          return json(await st.tunnels.start(b.name ?? ""));
        case "tunnel-stop":
          // 带宿主侧资源撤销的停止（portmap 映射 / ipv6 transport——库 in-process
          // 语义下 tunnels.stop 不覆盖这两类，见 stopExposeWithResources 注释）。
          await stopExposeWithResources(b.name ?? "");
          removeExposeStartedAt(b.name ?? "");
          removeExposeInject(String(b.name ?? ""));
          return json({ stopped: b.name });
        case "tunnel-stop-all": {
          // 库的 stopAll 只停隧道进程 + 注销 host——proxy 模式暴露的 binding 与记录
          // 不清（残留“历史端口”，重新公开后与新记录叠加）。逐条 tunnels.stop：
          // proxy 记录 → removeBinding + 删记录 + persist（彻底清理）；隧道 → 停进程。
          for (const e of st.exposes()) {
            try {
              await stopExposeWithResources(e.name ?? "");
              removeExposeStartedAt(e.name ?? "");
              removeExposeInject(String(e.name ?? ""));
            } catch {
              // 单条失败不阻断其余（未运行隧道名等）
            }
          }
          await st.tunnels.stopAll(); // 兕底停漏网隧道（无记录的）
          return json({ ok: true });
        }
        case "user-list": {
          // 附加生物 2FA 状态（active/pending）——UI 显示“已开/待验证”徽标
          const provider = (body as { provider?: string }).provider;
          const site = (body as { site?: string }).site;
          const list = await st.auth.users(provider, site);
          const bioProviders = (st.auth as unknown as { biometricProviders?: () => string[] }).biometricProviders?.() ?? [];
          const out = [];
          for (const entry of list) {
            if (bioProviders.includes(entry.provider)) {
              const withBio = await Promise.all((entry.users ?? []).map(async (u: { name: string }) => {
                try {
                  const bio = await (st.auth as unknown as { biometricStatus: (n: string, pr?: string, s?: string) => Promise<{ face: boolean; facePending: boolean; voice: boolean; voicePending: boolean }> })
                    .biometricStatus(u.name, entry.provider, site);
                  return { ...u, biometrics: bio };
                } catch {
                  return u;
                }
              }));
              out.push({ ...entry, users: withBio });
            } else {
              out.push(entry);
            }
          }
          return json({ users: out });
        }
        case "user-add": {
          const p = body as { name?: string; password?: string; displayName?: string; provider?: string | string[]; site?: string };
          if (!p.name || !p.password) {
            return json({ error: "name and password required" }, 400);
          }
          const providers = await st.auth.addUser(p.name, p.password, {
            provider: p.provider,
            site: p.site,
            displayName: p.displayName,
          });
          return json({ added: p.name, providers });
        }
        case "user-set-password": {
          const p = body as { name?: string; password?: string; provider?: string | string[]; site?: string };
          if (!p.name || !p.password) {
            return json({ error: "name and password required" }, 400);
          }
          const providers = await st.auth.setUserPassword(p.name, p.password, p.provider, p.site);
          return json({ updated: p.name, providers });
        }
        case "user-set-displayname": {
          const p = body as { name?: string; displayName?: string; provider?: string | string[]; site?: string };
          if (!p.name || !p.displayName || !p.displayName.trim()) {
            return json({ error: "name and displayName required" }, 400);
          }
          try {
            const providers = await (st.auth as unknown as { setDisplayName: (n: string, d: string, pr?: string | string[], s?: string) => Promise<string[]> })
              .setDisplayName(p.name, p.displayName.trim(), p.provider, p.site);
            return json({ updated: p.name, providers });
          } catch (err) {
            return json({ error: String(err) }, 502);
          }
        }
        case "user-remove": {
          const p = body as { name?: string; provider?: string | string[]; site?: string };
          const providers = await st.auth.removeUser(p.name ?? "", p.provider, p.site);
          return json({ removed: p.name, providers });
        }
        case "user-managers":
          return json({ providers: st.auth.userManagers() });
        case "totp-enroll": {
          const p = body as { name?: string; provider?: string; site?: string; label?: string };
          if (!p.name) return json({ error: "name required" }, 400);
          return json(await st.auth.totpEnroll(p.name, p.provider, p.site, p.label));
        }
        case "totp-default-label": {
          const p = body as { name?: string; provider?: string; site?: string };
          if (!p.name) return json({ error: "name required" }, 400);
          const res = await st.auth.totpDefaultLabel(p.name, p.provider, p.site);
          const piWebHost = (getBaseDomains()[0] ?? "").replace(/^\s*\.?/, "").replace(/:\d{1,5}$/, "");
          return json({ ...res, piWebHost });
        }
        case "totp-disable": {
          const p = body as { name?: string; provider?: string; site?: string };
          await st.auth.totpDisable(p.name ?? "", p.provider, p.site);
          return json({ disabled: p.name });
        }
        case "totp-status": {
          const p = body as { name?: string; provider?: string; site?: string };
          return json(await st.auth.totpStatus(p.name ?? "", p.provider, p.site));
        }
        case "biometric-providers": {
          // Provider types supporting biometric 2FA management (portal；UI 显示门槛)
          return json({ providers: (st.auth as unknown as { biometricProviders?: () => string[] }).biometricProviders?.() ?? [] });
        }
        case "biometric-enroll-url": {
          // 签票 + 拼采集页完整 URL（管理 UI 直接开窗；浏览器本地采集，模型不进管理 UI）
          const p = body as { name?: string; method?: "face" | "voice"; provider?: string; site?: string };
          if (!p.name || (p.method !== "face" && p.method !== "voice")) {
            return json({ error: "name and method (face|voice) required" }, 400);
          }
          try {
            const res = await (st.auth as unknown as { biometricEnrollUrl: (n: string, m: "face" | "voice", pr?: string, s?: string) => Promise<{ token: string; method: string; expiresInMs: number; url: string }> })
              .biometricEnrollUrl(p.name, p.method, p.provider, p.site);
            return json(res);
          } catch (err) {
            return json({ error: String(err) }, 502);
          }
        }
        case "biometric-enroll-face": {
          // 管理端直接采集：浏览器 face-api 提取的 128d 描述子（3 帧张嘴校验）
          // 直写模板（pending）——不启动门户进程，纯数据层操作。
          const p = body as { name?: string; samples?: number[][]; provider?: string; site?: string };
          if (!p.name || !Array.isArray(p.samples)) {
            return json({ error: "name and samples required" }, 400);
          }
          try {
            const res = await (st.auth as unknown as { biometricEnrollFace: (n: string, s: number[][], pr?: string, si?: string) => Promise<{ pending: boolean }> })
              .biometricEnrollFace(p.name, p.samples, p.provider, p.site);
            return json(res);
          } catch (err) {
            return json({ error: String(err) }, 400);
          }
        }
        case "biometric-verify-face": {
          // 管理端“现在验证”：浏览器采集描述子 → 与模板比对；pending 首验通过即转 active
          const p = body as { name?: string; samples?: number[][]; provider?: string; site?: string };
          if (!p.name || !Array.isArray(p.samples)) {
            return json({ error: "name and samples required" }, 400);
          }
          try {
            const res = await (st.auth as unknown as { biometricVerifyFace: (n: string, s: number[][], pr?: string, si?: string) => Promise<{ matched: boolean; distance: number }> })
              .biometricVerifyFace(p.name, p.samples, p.provider, p.site);
            return json(res);
          } catch (err) {
            return json({ error: String(err) }, 400);
          }
        }
        case "biometric-assets-ensure": {
          // 确保 face 浏览器资产已下载（首次 ~8.4MB）；返回扩展侧资产 serve 的 URL 基址
          try {
            const res = await (st.auth as unknown as { biometricAssetsEnsure: () => Promise<{ dir: string; files: string[] }> }).biometricAssetsEnsure();
            // 补充 face_expression_model（eyesOpen 眨眼通道）——库 FACE_ASSETS 清单未含，
            // 扩展侧直接下载到同一 cache 目录（与库文件平铺共存）
            await ensureFaceExpressionAssets(res.dir);
            return json({ ok: true, dir: res.dir, files: [...res.files, "face_expression_model-weights_manifest.json", "face_expression_model.bin"], base: `${apiBase(ctx)}/face-assets/` });
          } catch (err) {
            return json({ error: String(err) }, 502);
          }
        }
        case "biometric-disable": {
          const p = body as { name?: string; method?: "face" | "voice"; provider?: string; site?: string };
          if (!p.name || (p.method !== "face" && p.method !== "voice")) {
            return json({ error: "name and method (face|voice) required" }, 400);
          }
          await (st.auth as unknown as { biometricDisable: (n: string, m: "face" | "voice", pr?: string, s?: string) => Promise<void> })
            .biometricDisable(p.name, p.method, p.provider, p.site);
          return json({ disabled: p.name, method: p.method });
        }
        case "totp-activate": {
          const p = body as { name?: string; provider?: string; site?: string; code?: string };
          if (!p.name || !p.code) {
            return json({ error: "name and code required" }, 400);
          }
          return json(await st.auth.totpActivate(p.name, p.code, p.provider, p.site));
        }
        case "set-allow-tool-download": {
          st.tools.setAllowDownload(!!b.allowDownload);
          return json({ allowToolDownload: st.tools.allowDownload() });
        }
        case "user-summary": {
          const siteNames = ["default", ...st.sites.list().map((s) => s.name).filter((n) => n !== "default")];
          const managers = st.auth.userManagers();
          const totpProviders = st.auth.totpProviders();
          const rows: { site: string; provider: string; count: number; totp: number }[] = [];
          for (const site of siteNames) {
            for (const provider of managers) {
              try {
                const res = await st.auth.users(provider, site);
                const users = res.find((x) => x.provider === provider)?.users ?? [];
                let totp = 0;
                if (totpProviders.includes(provider)) {
                  for (const u of users) {
                    try {
                      if ((await st.auth.totpStatus(u.name, provider, site)).enrolled) totp++;
                    } catch {
                      // 单用户 totp 状态查询失败 —— 忽略该用户
                    }
                  }
                }
                rows.push({ site, provider, count: users.length, totp });
              } catch {
                // 该 provider/site 组合不可用 → 跳过
              }
            }
          }
          return json({ rows });
        }
        // ---- 站点（认证域）管理：列表在 GET /status（sites/protectedSites），
        // 增删走这两个动作。受保护站点（default / pi-web self 页默认域）拒改拒删。
        case "site-add": {
          const p = body as { name?: string; provider?: string; policy?: string; domain?: string };
          const name = String(p.name ?? "").trim().toLowerCase();
          if (!name) return json({ error: "name required" }, 400);
          if (isProtectedSite(name)) {
            return json({ error: `site "${name}" is protected (built-in config, cannot be replaced)` }, 400);
          }
          const cfg: { provider?: string; policy?: "one_factor" | "two_factor" | "deny"; domain?: string } = {};
          if (p.provider && p.provider !== "auto") cfg.provider = p.provider;
          if (p.policy === "one_factor" || p.policy === "two_factor" || p.policy === "deny") cfg.policy = p.policy;
          if (p.domain) cfg.domain = String(p.domain).trim().toLowerCase();
          try {
            st.sites.add(name, cfg);
            return json({ ok: true, sites: st.sites.list(), protectedSites: [...PROTECTED_SITES] });
          } catch (err) {
            return json({ error: String(err) }, 400);
          }
        }
        case "site-remove": {
          const p = body as { name?: string };
          const name = String(p.name ?? "").trim().toLowerCase();
          if (!name) return json({ error: "name required" }, 400);
          if (isProtectedSite(name)) {
            return json({ error: `site "${name}" is protected and cannot be removed` }, 400);
          }
          try {
            st.sites.remove(name);
            return json({ ok: true, sites: st.sites.list(), protectedSites: [...PROTECTED_SITES] });
          } catch (err) {
            return json({ error: String(err) }, 400);
          }
        }
        // ---- Pi-web self-exposure (runtime override of PI_WEB_EXPOSE) ----
        case "self-expose": {
          // M3 对齐：portmap 参数白名单（与 expose case 同规则）+ ipv6.address
          const selfPortmap = pickPortmapParams(b.portmap);
          const res = await exposeSelf({
            mode: b.mode as SelfExposeOptions["mode"],
            auth: b.provider as string | undefined,
            tunnel: b.tunnel,
            protocol: b.protocol,
            policy: b.policy as SelfExposeOptions["policy"],
            allowToolDownload: b.allowToolDownload,
            tunnelParams: b.tunnelParams,
            providerParams: b.providerParams,
            serviceBasePath: b.serviceBasePath,
            inject: Array.isArray(b.inject) ? b.inject.filter((s) => typeof s === "string") : undefined,
            ...(selfPortmap ? { portmap: selfPortmap } : {}),
            ...(b.ipv6 && typeof b.ipv6.address === "string" && b.ipv6.address ? { ipv6: { address: b.ipv6.address } } : {}),
          } as SelfExposeOptions);
          return json({ ok: true, result: res, self: getSelfExposeState() });
        }
        case "self-stop":
          await stopSelf();
          return json({ ok: true, self: getSelfExposeState() });
        case "self-stop-tunnel": {
          const name = (body as { name?: string }).name;
          if (typeof name !== "string" || !name.startsWith("expose-self-")) {
            return json({ error: "name required (self tunnel)" }, 400);
          }
          await stopExposeWithResources(name);
          return json({ ok: true, self: getSelfExposeState() });
        }
        case "self-allowlocal": {
          const v = (body as { allowLocal?: boolean }).allowLocal;
          const confirm = (body as { confirm?: boolean }).confirm === true;
          const ttlMs = (body as { ttlMs?: number }).ttlMs;
          if (typeof v !== "boolean") {
            return json({ error: "allowLocal required (boolean)" }, 400);
          }
          if (confirm) {
            confirmAllowLocal(v);
          } else if (v === false) {
            if (!Number.isInteger(ttlMs) || (ttlMs as number) <= 0) {
              return json(
                { error: "allowLocal=false 需带 ttlMs 临时关闭,并在窗口内二次确认 (confirm:true)" },
                400,
              );
            }
            setAllowLocalTemporary(false, ttlMs as number);
          } else {
            confirmAllowLocal(true);
          }
          const s = getSelfExposeState();
          return json({
            allowLocal: s.allowLocal,
            allowHosts: s.allowHosts,
            allowLocalPending: getAllowLocalPending(),
          });
        }
        case "self-allowhosts": {
          const hosts = (body as { hosts?: string[] }).hosts;
          if (!Array.isArray(hosts)) {
            return json({ error: "hosts required (string array)" }, 400);
          }
          setAllowLocalHosts(hosts);
          return json({ allowHosts: getSelfExposeState().allowHosts });
        }
        // ---- 公开方案（preset） ----
        case "preset-save": {
          const p = body as { name?: string; presetConfig?: ExposePresetConfig };
          if (!p.name || !p.name.trim()) {
            return json({ error: "name required" }, 400);
          }
          if (!p.presetConfig) {
            return json({ error: "presetConfig required" }, 400);
          }
          try {
            const saved = await saveExposePreset(p.name, p.presetConfig);
            return json({ saved, presets: listExposePresets() });
          } catch (e) {
            return json({ error: String(e) }, 400);
          }
        }
        case "preset-load": {
          const id = (body as { id?: string }).id ?? "";
          if (!id) return json({ error: "id required" }, 400);
          const config = loadExposePreset(id);
          if (!config) return json({ error: "preset not found" }, 404);
          return json({ config });
        }
        case "preset-delete": {
          const id = (body as { id?: string }).id ?? "";
          if (!id) return json({ error: "id required" }, 400);
          return json({ deleted: deleteExposePreset(id), presets: listExposePresets() });
        }
        default:
          return json({ error: `unknown action: ${action}` }, 400);
      }
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  return null; // 未匹配 → 宿主 404
}

/**
 * 补充下载 face_expression_model（eyesOpen 眨眼通道）。
 * 库的 FACE_ASSETS 清单不含此模型；@vladmandic/face-api@1.7.15 的
 * model/face_expression_model.{bin,json}（bin 329,468B / manifest 6,980B）。
 * 下载到与库同一 cache 目录（dir = face-models/1.7.15，平铺），扩展 serve
 * 剥 models/ 前缀即可读。URL：jsdelivr → unpkg（Gitee 镜像无此文件）。
 */
async function ensureFaceExpressionAssets(dir: string): Promise<void> {
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files: Array<{ file: string; size: number; urls: string[] }> = [
    {
      file: "face_expression_model-weights_manifest.json",
      size: 6_980,
      urls: [
        "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/face_expression_model-weights_manifest.json",
        "https://unpkg.com/@vladmandic/face-api@1.7.15/model/face_expression_model-weights_manifest.json",
      ],
    },
    {
      file: "face_expression_model.bin",
      size: 329_468,
      urls: [
        "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/face_expression_model.bin",
        "https://unpkg.com/@vladmandic/face-api@1.7.15/model/face_expression_model.bin",
      ],
    },
  ];
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const dest = join(dir, f.file);
    if (existsSync(dest)) {
      try {
        const { statSync } = await import("node:fs");
        if (statSync(dest).size === f.size) continue;
      } catch { /* 重下 */ }
    }
    let done = false;
    let lastErr: unknown = null;
    for (const url of f.urls) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== f.size) throw new Error(`size mismatch ${buf.length} != ${f.size}`);
        writeFileSync(dest, buf);
        done = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!done) throw new Error(`download ${f.file} failed: ${String(lastErr)}`);
  }
}
