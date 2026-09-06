import { NextResponse } from "next/server";
import { scanInterruptedSessions } from "@/lib/restart-recovery";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/recovery/interrupted
 *
 * 重启恢复清单：上次进程中断的运行中会话（running-journal interrupted 集），
 * 附每会话排队消息数/中断 prompt 预览/可恢复性校验。轻量：不创建 AgentSession。
 */
export async function GET() {
  try {
    const report = await scanInterruptedSessions();
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
