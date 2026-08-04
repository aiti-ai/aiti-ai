import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  getServiceTunnels,
  listPiServices,
  exposeService,
} from "@/lib/service-tunnels-integration";

/**
 * GET /api/service-tunnels          — service-tunnels 状态（发现/内部端口/隧道/provider）
 * POST /api/service-tunnels/expose  — { port, auth?, tunnel? } 一键暴露
 * POST /api/service-tunnels/tunnel  — { action: "start"|"stop"|"add", ... }
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const st = getServiceTunnels();
    return NextResponse.json({
      services: listPiServices(),
      internal: st.internal.list(),
      tunnels: st.tunnels.list(),
      providers: st.auth.providers(),
      dirs: st.dirs,
      daemon: st.daemon.status(),
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
      name?: string;
    };
    if (body.action === "expose" || (!body.action && body.port)) {
      const port = Number(body.port);
      if (!Number.isFinite(port) || port <= 0) {
        return NextResponse.json({ error: "port required" }, { status: 400 });
      }
      const res = await exposeService(port, { auth: body.auth, tunnel: body.tunnel });
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
      default:
        return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
