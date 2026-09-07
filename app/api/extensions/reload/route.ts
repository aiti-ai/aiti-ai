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
    // 扩展代码已替换：dispose 全部后端 handle（旧类实例残留于 globalThis store），
    // 下次访问按需以新代码重建（zcode respawn+resume 无损 / attach 断线重连语义）
    const reloadedHandles = await disposeAllHandles();
    return NextResponse.json({ ok: true, graph: getRegistry().bootGraph(), reloadedHandles });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
