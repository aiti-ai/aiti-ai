import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";

// GET /api/extensions/status — load status per extension (errors included) +
// enabled flags (persisted disabled list).
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const registry = getRegistry();
  const status = registry.status();
  for (const id of Object.keys(status)) {
    (status[id] as { enabled?: boolean }).enabled = registry.isEnabled(id);
  }
  return NextResponse.json({
    loaded: registry.isLoaded(),
    extensionsRoot: registry.extensionsRoot(),
    extraExtensionsRoots: registry.extraExtensionsRoots(),
    bundledExtensionsRoot: registry.bundledExtensionsRoot(),
    dataRoot: registry.dataRoot(),
    extensions: status,
  }, { headers: { "cache-control": "no-store" } });
}

// POST /api/extensions/status — enable/disable an extension (persisted), then
// hot-reload so the change takes effect. Body: { action: "enable"|"disable", id }.
export async function POST(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
    const registry = getRegistry();
    if (body.action === "enable" || body.action === "disable") {
      if (!body.id) return NextResponse.json({ error: "missing id" }, { status: 400 });
      registry.setEnabled(body.id, body.action === "enable");
      await registry.reload();
      return NextResponse.json({ ok: true, enabled: registry.isEnabled(body.id) });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
