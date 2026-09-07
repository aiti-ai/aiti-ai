import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * P0-A 轻量单条元数据端点（aiti-web-sessions-payload-plan.md §3 P0-A）：
 * 返回单条 SessionInfo（与列表同源拼装，含 projectKey/relation），不含
 * messages/context/tree——替代 AppShell 的 `?refresh=1` 全量重拉（原每次 1.49MB）。
 *
 * 覆盖：本地磁盘 pi 会话（增量扫描缓存命中时近零磁盘成本）。
 * 不覆盖：桥/RPC/复合 id 会话 → 404；消费方（AppShell）404 时回退原全量拉，
 * 保证渐进迁移零功能损失。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const info = await getSessionMeta(id);
    if (!info) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json(
      { session: info },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
