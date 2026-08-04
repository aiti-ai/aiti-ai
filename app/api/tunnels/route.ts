import { NextRequest, NextResponse } from "next/server";
import {
  startTunnel,
  stopTunnel,
  startPortTunnel,
  getTunnelInfos,
  getPortTunnelTemplates,
} from "@/lib/tunnels";
import { isApiRequestAllowed } from "@/lib/request-security";

// GET /api/tunnels?port=8901
//   Per-port tunnel command templates + full tunnel list (configured + one-off).
// POST /api/tunnels  body:
//   { action: "start", port, tool }  — start a one-off tunnel for a service port
//   { action: "start", name }        — start a configured tunnel
//   { action: "stop",  name }        — stop any tunnel
// Returns the full tunnel list for immediate re-render.
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const port = Number(request.nextUrl.searchParams.get("port"));
  return NextResponse.json({
    templates: Number.isInteger(port) && port > 0 ? getPortTunnelTemplates(port) : [],
    tunnels: getTunnelInfos(),
  });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; name?: unknown; port?: unknown; tool?: unknown }
    | null;
  const action = body?.action;

  if (action === "start") {
    const port = typeof body?.port === "number" ? body.port : Number(body?.port);
    const tool = typeof body?.tool === "string" ? body.tool : "";
    if (Number.isInteger(port) && port > 0 && tool) {
      const ok = startPortTunnel(port, tool);
      if (!ok) {
        return NextResponse.json({ error: `Unknown tunnel tool: ${tool}` }, { status: 404 });
      }
      return NextResponse.json({ tunnels: getTunnelInfos() });
    }
    const name = typeof body?.name === "string" ? body.name : "";
    if (name) {
      const ok = startTunnel(name);
      if (!ok) {
        return NextResponse.json({ error: `Unknown tunnel: ${name}` }, { status: 404 });
      }
      return NextResponse.json({ tunnels: getTunnelInfos() });
    }
    return NextResponse.json({ error: "start needs {name} or {port, tool}" }, { status: 400 });
  }

  if (action === "stop") {
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name) {
      return NextResponse.json({ error: "stop needs {name}" }, { status: 400 });
    }
    const ok = stopTunnel(name);
    if (!ok) {
      return NextResponse.json({ error: `Unknown tunnel: ${name}` }, { status: 404 });
    }
    return NextResponse.json({ tunnels: getTunnelInfos() });
  }

  return NextResponse.json({ error: "action must be start|stop" }, { status: 400 });
}
