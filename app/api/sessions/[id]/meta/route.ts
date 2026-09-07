import { NextResponse } from "next/server";
import { getSessionMeta, attachSessionProjectInfo } from "@/lib/session-reader";
import { getRpcSessionInfos } from "@/lib/rpc-manager";
import { getHandleSessionInfos } from "@/lib/session";

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
    let info = await getSessionMeta(id);
    if (!info) {
      // 内存态形态兜底（与 /api/sessions 列表同源拼装，零磁盘）：桥/RPC 会话、
      // attach/spawn/扩展 handle 会话均不在磁盘扫描范围——此前一律 404，消费方
      // （AppShell ?session= 恢复/open-session）被迫回退全量 refresh=1 重拉
      //（首载一次 404 即 ~257KB 全量 + 服务端强制重扫，高频浪费源）。
      const rows = await attachSessionProjectInfo([...getRpcSessionInfos(), ...getHandleSessionInfos()]);
      info = rows.find((s) => s.id === id) ?? null;
    }
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
