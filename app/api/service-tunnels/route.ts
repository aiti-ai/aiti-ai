import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { setAllowLocal, setAllowLocalHosts, setAllowLocalTemporary, confirmAllowLocal, getAllowLocalPending, getBaseDomains } from "@/lib/service-proxy-shared";
import {
  getServiceTunnels,
  listPiServices,
  exposeService,
  ensureSites,
  exposeSelf,
  stopSelf,
  getSelfExposeState,
  getExposeStartedAt,
  removeExposeStartedAt,
  type SelfExposeOptions,
} from "@/lib/service-tunnels-integration";

import type { TunnelConfig, ParamSpec } from "service-tunnels";

/** 库端漏翻修复:localizeSpecs 对 zh/en 目录都没有的 key,会把 label/
 *  description/… 替换成 i18n key 本身(translate 最后兑底返回 key)。检测到
 *  字段 === 其 key(漏翻)时,回落 raw(en,未本地化)响应的默认值;默认值
 *  也没有 → 保持原样,客户端再兑底 key 参数名。库端修复后此函数为 no-op。 */
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

/** Expose 详情弹窗的隧道参数:从 TunnelConfig 挑有意义的字段展示。令牌类
 *  值一律掩码(只留末 4 位)。返回扁平 { key: value }。 */
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

/**
 * GET /api/service-tunnels          — service-tunnels 状态（发现/内部端口/隧道/provider/站点）
 * POST /api/service-tunnels/expose  — { port, auth?, tunnel?, mode?, site? } 一键暴露
 * POST /api/service-tunnels/tunnel  — { action: "start"|"stop"|"add", ... }
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const st = getServiceTunnels();
    // ?self-only=1 → 顶栏自暴露告警的轻量单次拉取：只返回 self 状态，不跑
    // ensureSites / 发现 / schemas 本地化等重活（事件驱动，无轮询）。
    if (request.nextUrl.searchParams.get("self-only") === "1") {
      return NextResponse.json({ self: getSelfExposeState() });
    }
    ensureSites(); // idempotent preset of pi-web + services realms
    const providers = st.auth.providers();
    // 多语:?lang= 显式 > Accept-Language 头(浏览器自动带);缺省英文
    const lang = request.nextUrl.searchParams.get("lang") ?? request.headers.get("accept-language")?.split(",")[0] ?? undefined;
    // ?logs=<exposeName> → read that expose's per-host nginx access/error logs
    const logsName = request.nextUrl.searchParams.get("logs");
    if (logsName) {
      const expose = st.exposes().find((e) => e.name === logsName);
      if (!expose?.accessLog) return NextResponse.json({ error: "expose not found" }, { status: 404 });
      const { readFileSync, existsSync } = await import("node:fs");
      const tail = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").slice(-50).join("\n") : "(no log yet)");
      return NextResponse.json({ access: tail(expose.accessLog), error: tail(expose.errorLog ?? "") });
    }
    // ?logs-list=<exposeName> → 该暴露的全部日志文件(access/error × 各 host),
    // 供详情页列出、点开在 pi-web 文件窗口查看。
    const logsListName = request.nextUrl.searchParams.get("logs-list");
    if (logsListName) {
      const expose = st.exposes().find((e) => e.name === logsListName);
      if (!expose) return NextResponse.json({ error: "expose not found" }, { status: 404 });
      const { readdirSync, statSync, existsSync } = await import("node:fs");
      const { resolve, dirname, basename, join } = await import("node:path");
      // 该暴露各公开 URL 的 host(vhost + 隧道域)→ 对应 <host>.access/error.log
      const hosts = new Set<string>();
      for (const u of [expose.url, expose.localUrl, expose.baseUrl, expose.domainUrl, expose.loginUrl]) {
        if (!u) continue;
        try { hosts.add(new URL(u).host); } catch { /* ignore */ }
      }
      const paths = new Set<string>();
      for (const p of [expose.accessLog, expose.errorLog]) if (p) paths.add(p);
      const gatewayDir = expose.accessLog ? dirname(expose.accessLog) : null;
      if (gatewayDir && existsSync(gatewayDir)) {
        for (const host of hosts) {
          for (const suffix of [".access.log", ".error.log"]) paths.add(join(gatewayDir, `${host}${suffix}`));
        }
        // 兜底:该目录下与 expose 名相关的 host 日志(如历史 host 变化)
        for (const f of readdirSync(gatewayDir)) {
          if (f.endsWith(".access.log") || f.endsWith(".error.log")) {
            const host = f.replace(/\.(access|error)\.log$/, "");
            if (hosts.has(host)) paths.add(join(gatewayDir, f));
          }
        }
      }
      const files = [...paths]
        .filter((p) => p && existsSync(p))
        .map((p) => { const stt = statSync(p); return { name: basename(p), path: p, size: stt.size, mtime: stt.mtimeMs }; })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (files.length) {
        // 让 /api/files 能读日志目录(不再需要额外白名单)
        const { allowFileRoot } = await import("@/lib/file-access");
        allowFileRoot(resolve(dirname(files[0]!.path)));
      }
      return NextResponse.json({ files });
    }
    // ?detect=<port> → probe the port's protocol (http/https/tcp) for the UI
    const detectPort = Number(request.nextUrl.searchParams.get("detect"));
    if (Number.isInteger(detectPort) && detectPort >= 1 && detectPort <= 65535) {
      const { detectProtocol } = await import("service-tunnels");
      return NextResponse.json({ port: detectPort, protocol: await detectProtocol(detectPort) });
    }
    return NextResponse.json({
      services: listPiServices(),
      internal: st.internal.list(),
      tunnels: st.tunnels.list(),
      // Detail modal needs the expose's start time (pi-web-side record) and
      // tunnel params (from the tunnel config: domain/server/token/…). Token
      // values are masked; proxy-mode exposes have no tunnel config → null.
      exposes: st.exposes().map((e) => {
        const cfg = st.tunnels.configs().find((c) => c.name === e.name);
        // proxy 模式(pi-web 内进程代理,startTransport:false → localUrl 为空):
        // 库内 running 恒为 false,实际以 binding 是否仍注册为准 —— 否则 proxy
        // 暴露永远不显示在活动列表、也无法从表单切到“停止”。
        let running = e.running;
        if ((e.name ?? "").startsWith("proxy:") && e.label !== undefined) {
          running = Boolean(st.proxy.bindings().some((b) => b.port === e.port && (b.label ?? "") === (e.label ?? "")));
        }
        // baseUrl/localUrl 已由库拼接部署前缀(0.3.13+);隧道 URL 不拼。
        return {
          ...e,
          running,
          startedAt: getExposeStartedAt(e.name) ?? null,
          params: cfg ? exposeParams(cfg) : null,
        };
      }),
      providers,
      providerOrder: st.auth.providerOrder(),
      defaultProvider: st.auth.defaultProvider(),
      tunnelSchemas: st.schemas.tunnels(lang),
      tunnelMetas: st.schemas.metas(),
      totpProviders: st.auth.totpProviders(),
      userManagers: st.auth.userManagers(),
      // 漏翻修复:raw(en)与本地化两份合并——zh/en 目录未收录的 key 回落默认值
      // (库端已修则本地化结果无漏翻,此步 no-op)。
      authProviderSchemas: repairSchemaL10n(
        await st.schemas.authProviders(lang),
        await st.schemas.authProviders("en"),
      ),
      // provider 页面元数据(label/已配置/待填项)——picker 显示友好名称用
      authMetas: st.schemas.authMetas(),
      tunnelTcpSupport: st.tunnels.tcpSupport ? st.tunnels.tcpSupport() : [],
      allowToolDownload: st.tools.allowDownload(),
      toolStatus: st.tools.list(),
      dirs: st.dirs,
      daemon: st.daemon.status(),
      sites: st.sites.list(),
      proxy: st.proxy.status ? st.proxy.status() : null,
      self: getSelfExposeState(),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      port?: number;
      auth?: boolean;
      tunnel?: string;
      provider?: string;
      ngrokAuthtoken?: string;
      policy?: string;
      protocol?: "http" | "https" | "tcp";
      mode?: "tunnel" | "proxy" | "both";
      site?: string;
      allowToolDownload?: boolean;
      tunnelParams?: Record<string, unknown>;
      providerParams?: Record<string, unknown>;
      serviceBasePath?: string;
      name?: string;
      allowDownload?: boolean;
      code?: string;
    };
    // The "command" tunnel type executes a raw shell command — too dangerous
    // for a web UI; reject it fail-closed on every expose path (existing
    // command tunnels keep running, new ones can't be created through this
    // API). The UI also hides it from the tunnel picker (TunnelMeta.dangerous).
    if (body.tunnel === "command") {
      return NextResponse.json({ error: "tunnel type 'command' is not allowed" }, { status: 400 });
    }
    if (body.action === "expose" || (!body.action && body.port)) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return NextResponse.json({ error: "port required (1-65535)" }, { status: 400 });
      }
      const protocol = body.protocol === "http" || body.protocol === "https" || body.protocol === "tcp"
        ? body.protocol
        : undefined;
      const res = await exposeService(port, {
        auth: body.auth,
        protocol,
        mode: body.mode,
        site: body.site,
        tunnel: body.tunnel,
        provider: body.provider,
        ngrokAuthtoken: body.ngrokAuthtoken,
        allowToolDownload: body.allowToolDownload,
        policy: body.policy,
        tunnelParams: body.tunnelParams,
        providerParams: body.providerParams,
        serviceBasePath: body.serviceBasePath,
      });
      return NextResponse.json(res);
    }
    const st = getServiceTunnels();
    switch (body.action) {
      case "tunnel-start":
        return NextResponse.json(await st.tunnels.start(body.name ?? ""));
      case "tunnel-stop":
        await st.tunnels.stop(body.name ?? "");
        removeExposeStartedAt(body.name ?? "");
        return NextResponse.json({ stopped: body.name });
      case "tunnel-stop-all":
        await st.tunnels.stopAll();
        return NextResponse.json({ ok: true });
      case "user-list":
        return NextResponse.json({ users: await st.auth.users((body as { provider?: string; site?: string }).provider, (body as { site?: string }).site) });
      case "user-add": {
        const p = body as { name?: string; password?: string; displayName?: string; provider?: string | string[]; site?: string };
        if (!p.name || !p.password) {
          return NextResponse.json({ error: "name and password required" }, { status: 400 });
        }
        const providers = await st.auth.addUser(p.name, p.password, {
          provider: p.provider,
          site: p.site,
          displayName: p.displayName,
        });
        return NextResponse.json({ added: p.name, providers });
      }
      case "user-set-password": {
        const p = body as { name?: string; password?: string; provider?: string | string[]; site?: string };
        if (!p.name || !p.password) {
          return NextResponse.json({ error: "name and password required" }, { status: 400 });
        }
        const providers = await st.auth.setUserPassword(p.name, p.password, p.provider, p.site);
        return NextResponse.json({ updated: p.name, providers });
      }
      case "user-remove": {
        const p = body as { name?: string; provider?: string | string[]; site?: string };
        const providers = await st.auth.removeUser(p.name ?? "", p.provider, p.site);
        return NextResponse.json({ removed: p.name, providers });
      }
      case "user-managers":
        return NextResponse.json({ providers: st.auth.userManagers() });
      case "totp-enroll": {
        const p = body as { name?: string; provider?: string; site?: string; label?: string };
        if (!p.name) return NextResponse.json({ error: "name required" }, { status: 400 });
        return NextResponse.json(await st.auth.totpEnroll(p.name, p.provider, p.site, p.label));
      }
      case "totp-default-label": {
        const p = body as { name?: string; provider?: string; site?: string };
        if (!p.name) return NextResponse.json({ error: "name required" }, { status: 400 });
        const res = await st.auth.totpDefaultLabel(p.name, p.provider, p.site);
        // pi-web 自身部署域名（PI_WEB_BASE_DOMAIN / PI_WEB_ALLOWED_HOSTS /
        // PI_WEB_HOSTNAME 首个，去端口）：浏览器域名明显是 IP/隧道随机域名时，
        // UI 用此域名拼默认标识的 @host。
        const piWebHost = (getBaseDomains()[0] ?? "").replace(/^\s*\.?/, "").replace(/:\d{1,5}$/, "");
        return NextResponse.json({ ...res, piWebHost });
      }
      case "totp-disable": {
        const p = body as { name?: string; provider?: string; site?: string };
        await st.auth.totpDisable(p.name ?? "", p.provider, p.site);
        return NextResponse.json({ disabled: p.name });
      }
      case "totp-status": {
        const p = body as { name?: string; provider?: string; site?: string };
        return NextResponse.json(await st.auth.totpStatus(p.name ?? "", p.provider, p.site));
      }
      case "totp-activate": {
        const p = body as { name?: string; provider?: string; site?: string; code?: string };
        if (!p.name || !p.code) {
          return NextResponse.json({ error: "name and code required" }, { status: 400 });
        }
        return NextResponse.json(await st.auth.totpActivate(p.name, p.code, p.provider, p.site));
      }
      case "set-allow-tool-download": {
        st.tools.setAllowDownload(!!body.allowDownload);
        return NextResponse.json({ allowToolDownload: st.tools.allowDownload() });
      }
      case "user-summary": {
        // 站点 × 有本地用户库的 provider 矩阵:每格用户数 + TOTP 用户数。
        // 供「用户」页表格一次拿全(避免前端 N×(1+每格用户数) 次请求)。
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
              // 该 provider/site 组合不可用(如 provider 未安装)→ 跳过
            }
          }
        }
        return NextResponse.json({ rows });
      }
      // ---- Pi-web self-exposure (runtime override of PI_WEB_EXPOSE) ----
      case "self-expose": {
        const res = await exposeSelf({
          mode: body.mode as SelfExposeOptions["mode"],
          auth: body.provider as string | undefined,
          tunnel: body.tunnel,
          protocol: body.protocol,
          policy: body.policy as SelfExposeOptions["policy"],
          allowToolDownload: body.allowToolDownload,
          tunnelParams: body.tunnelParams,
          providerParams: body.providerParams,
          serviceBasePath: body.serviceBasePath,
        } as SelfExposeOptions);
        return NextResponse.json({ ok: true, result: res, self: getSelfExposeState() });
      }
      case "self-stop": {
        await stopSelf();
        return NextResponse.json({ ok: true, self: getSelfExposeState() });
      }
      case "self-stop-tunnel": {
        // 单渠道停止:仅停掉该隧道进程(如 localtunnel),保留 vhost 绑定
        const name = (body as { name?: string }).name;
        const st = getServiceTunnels();
        if (typeof name !== "string" || !name.startsWith("expose-self-")) {
          return NextResponse.json({ error: "name required (self tunnel)" }, { status: 400 });
        }
        await st.tunnels.stop(name);
        return NextResponse.json({ ok: true, self: getSelfExposeState() });
      }
      case "self-allowlocal": {
        const v = (body as { allowLocal?: boolean }).allowLocal;
        const confirm = (body as { confirm?: boolean }).confirm === true;
        const ttlMs = (body as { ttlMs?: number }).ttlMs;
        if (typeof v !== "boolean") {
          return NextResponse.json({ error: "allowLocal required (boolean)" }, { status: 400 });
        }
        if (confirm) {
          // 第二阶段:30s 窗口内二次确认 → 永久生效
          confirmAllowLocal(v);
        } else if (v === false) {
          // 第一阶段:临时关闭,ttlMs 后自动恢复(防锁死,Windows 分辨率式)
          if (!Number.isInteger(ttlMs) || (ttlMs as number) <= 0) {
            return NextResponse.json(
              { error: "allowLocal=false 需带 ttlMs 临时关闭,并在窗口内二次确认 (confirm:true)" },
              { status: 400 },
            );
          }
          setAllowLocalTemporary(false, ttlMs as number);
        } else {
          confirmAllowLocal(true); // 开启是安全操作,立即生效
        }
        const st = getSelfExposeState();
        return NextResponse.json({
          allowLocal: st.allowLocal,
          allowHosts: st.allowHosts,
          allowLocalPending: getAllowLocalPending(),
        });
      }
      case "self-allowhosts": {
        const hosts = (body as { hosts?: string[] }).hosts;
        if (!Array.isArray(hosts)) {
          return NextResponse.json({ error: "hosts required (string array)" }, { status: 400 });
        }
        setAllowLocalHosts(hosts);
        return NextResponse.json({ allowHosts: getSelfExposeState().allowHosts });
      }
      default:
        return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
