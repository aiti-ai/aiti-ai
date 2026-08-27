import { NextResponse } from "next/server";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getRunningHandleIds } from "@/lib/session/handle-store";

export const dynamic = "force-dynamic";

/** 运行中集 = 本地 rpc + handle（attach/spawn 等后端）合并（文档 attach-rpc-session-running-sync §2.2）。
 *  注意不可 export——Next route 文件只允许导出 HTTP 方法/配置，多余导出会被 .next/types 校验拒绝。 */
function runningSessionIds(): string[] {
  return [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds()])];
}

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return NextResponse.json(
    {
      runningSessionIds: runningSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
