import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getRunningHandleIds } from "@/lib/session/handle-store";
import { getBridgeRunningIds } from "@/lib/session/bridge-running";
import { ensureRunningBroadcast } from "@/lib/running-broadcast";

export const dynamic = "force-dynamic";

/** 运行中集 = 本地 rpc + handle（attach/spawn 等后端）+ TUI 桥（未认领也可见）合并
 *  （文档 attach-rpc-session-running-sync §2.2；桥侧缺口 2026-08-28 实测补）。
 *  注意不可 export——Next route 文件只允许导出 HTTP 方法/配置，多余导出会被 .next/types 校验拒绝。 */
function runningSessionIds(): string[] {
  return [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])];
}

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  // 保底激活运行集广播（三路变化 → 总线 running 帧；正常由 instrumentation 启动段
  // 完成注册，此处防部署形态差异——幂等 O(1)。见 lib/running-broadcast.ts）
  ensureRunningBroadcast();
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: runningSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
