import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getHandleSessionInfos, readBridgeRegistry } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // Extension-triggered mutations (e.g. session-manager archive) change the
    // on-disk list out from under the 5s TTL cache — let callers force a
    // fresh scan instead of waiting for the cache to expire.
    if (new URL(req.url).searchParams.get("refresh") === "1") {
      invalidateSessionListCache();
    }
    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    // Live backend sessions (attach/spawn/extension handles) — transient rows
    // so the sidebar lists them and ?session=<composite-id> restore works.
    const backendRows = await attachSessionProjectInfo(getHandleSessionInfos());

    // TUI 桥占用标记：注册表命中的会话文件行打 agent="tui-bridge"（侧栏徽标）。
    // 路径键的 attach handle 行跳过——真实文件行已带标，避免同一会话双行。
    const bridgeReg = await readBridgeRegistry();
    const markBridged = <T extends { path?: string; id: string; agent?: string }>(rows: T[]): T[] =>
      rows.map((r) =>
        r.path && bridgeReg[r.path] && !r.agent ? { ...r, agent: "tui-bridge" } : r,
      );
    const pathKeyedHandles = backendRows.filter((r) => !r.id.startsWith("/"));
    const markedPersisted = markBridged(persistedSessions as never[]);

    const sessions = mergeSessionLists(
      mergeSessionLists(markedPersisted, runtimeSessions),
      [...pathKeyedHandles, ...backendRows.filter((r) => r.id.startsWith("/"))].map((r) => ({ ...r, agent: r.agent ?? undefined })),
    );
    return NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
