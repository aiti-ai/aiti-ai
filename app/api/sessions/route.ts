import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getHandleSessionInfos, getRunningHandleIds } from "@/lib/session";
import { getRegistry } from "@/lib/ext/registry";

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

    const pathKeyedHandles = backendRows.filter((r) => !r.id.startsWith("/"));
    const sessions = mergeSessionLists(
      mergeSessionLists(persistedSessions as never[], runtimeSessions),
      pathKeyedHandles,
    );
    // 会话标注 slot：扩展（如 aiti-attach-agent 的 TUI 桥占用标记）追加自有字段。
    // 数据所有权在扩展——核心不感知桥注册表等具体格式。
    try {
      await getRegistry().dispatchSessionAnnotations(sessions);
    } catch (e) {
      console.error("[sessions] annotate failed:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json(
      {
        sessions,
        // 运行中 = 本地 runtime + 存活且正在执行的后端会话
        runningSessionIds: [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds()])],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
