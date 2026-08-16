import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";

// GET /api/extensions/status — framework-level load status per extension
// (loaded/enabled/error + slots/hooks/deps detail) + extension roots.
// 管理操作（启停/安装/卸载/在线注册表）在 aiti-extman 扩展的 API 里：
// /api/extensions/aiti-extman/ops（见 aiti-ai pi-web-ext/aiti-extman）。
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const registry = getRegistry();
  return NextResponse.json(registry.statusPayload(), { headers: { "cache-control": "no-store" } });
}
