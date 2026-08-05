import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  getServiceTunnels,
  listPiServices,
  exposeService,
  ensureSites,
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
      default:
        return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
