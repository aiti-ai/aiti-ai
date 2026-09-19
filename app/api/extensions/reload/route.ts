import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";
import { disposeAllHandles } from "@/lib/session/handle-store";

export const dynamic = "force-dynamic";

// POST /api/extensions/reload — hot reload: shutdown → reload entries → startup.
// Returns the NEW boot graph so the client loader can diff revs and invalidate
// only the changed bundles (precise HMR rollback) instead of a full reset.
export async function POST(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    await getRegistry().reload();
    // Extension code has been replaced: dispose all backend handles (old class instances
    // linger in the globalThis store); the next access rebuilds them on demand with the new
    // code (zcode respawn+resume lossless / attach reconnect semantics)
    const reloadedHandles = await disposeAllHandles();
    return NextResponse.json({ ok: true, graph: getRegistry().bootGraph(), reloadedHandles });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
