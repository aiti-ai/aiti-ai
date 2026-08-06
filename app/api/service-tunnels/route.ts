import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { setAllowLocal, setAllowLocalHosts, setAllowLocalTemporary, confirmAllowLocal, getAllowLocalPending } from "@/lib/service-proxy-shared";
import {
  getServiceTunnels,
  listPiServices,
  exposeService,
  ensureSites,
  exposeSelf,
  stopSelf,
  getSelfExposeState,
  type SelfExposeOptions,
} from "@/lib/service-tunnels-integration";

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
    ensureSites(); // idempotent preset of pi-web + services realms
    const providers = st.auth.providers();
    // ?logs=<exposeName> → read that expose's per-host nginx access/error logs
    const logsName = request.nextUrl.searchParams.get("logs");
    if (logsName) {
      const expose = st.exposes().find((e) => e.name === logsName);
      if (!expose?.accessLog) return NextResponse.json({ error: "expose not found" }, { status: 404 });
      const { readFileSync, existsSync } = await import("node:fs");
      const tail = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").slice(-50).join("\n") : "(no log yet)");
      return NextResponse.json({ access: tail(expose.accessLog), error: tail(expose.errorLog ?? "") });
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
      exposes: st.exposes(),
      providers,
      providerOrder: st.auth.providerOrder(),
      defaultProvider: st.auth.defaultProvider(),
      tunnelSchemas: st.schemas.tunnels(),
      tunnelMetas: st.schemas.metas(),
      totpProviders: st.auth.totpProviders(),
      userManagers: st.auth.userManagers(),
      authProviderSchemas: await st.schemas.authProviders(),
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
      });
      return NextResponse.json(res);
    }
    const st = getServiceTunnels();
    switch (body.action) {
      case "tunnel-start":
        return NextResponse.json(await st.tunnels.start(body.name ?? ""));
      case "tunnel-stop":
        await st.tunnels.stop(body.name ?? "");
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
        const p = body as { name?: string; provider?: string; site?: string };
        if (!p.name) return NextResponse.json({ error: "name required" }, { status: 400 });
        return NextResponse.json(await st.auth.totpEnroll(p.name, p.provider, p.site));
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
