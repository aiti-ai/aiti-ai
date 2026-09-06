import { NextResponse } from "next/server";
import { resolveInterruptedSession } from "@/lib/restart-recovery";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/recovery/resolve
 *
 * 处置一条中断会话：
 * - { dismiss: true }                        → 忽略（不再提示，状态持久化）
 * - { keep, discard, continueRun }           → 恢复：打开会话 + re-queue 选中条目
 *                                              +（continueRun）以「继续」启动 run
 *
 * 恢复语义见 lib/restart-recovery.ts：不重放原 prompt（可能是危险命令），续跑
 * 统一发「继续」；队列条目由 pi 顺序消化。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      sessionId?: string;
      sessionFile?: string;
      keep?: string[];
      discard?: string[];
      continueRun?: boolean;
      continueText?: string;
      dismiss?: boolean;
    };
    if (!body.sessionId || !body.sessionFile) {
      return NextResponse.json({ error: "sessionId and sessionFile are required" }, { status: 400 });
    }
    const result = await resolveInterruptedSession({
      sessionId: body.sessionId,
      sessionFile: body.sessionFile,
      keep: Array.isArray(body.keep) ? body.keep : [],
      discard: Array.isArray(body.discard) ? body.discard : [],
      continueRun: body.continueRun === true,
      continueText: typeof body.continueText === "string" ? body.continueText : undefined,
      dismiss: body.dismiss === true,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
