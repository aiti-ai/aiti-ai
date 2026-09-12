import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getHandleSessionInfos, getRunningHandleIds, getHandle } from "@/lib/session";
import { getBridgeRunningIds } from "@/lib/session/bridge-running";
import { getRegistry } from "@/lib/ext/registry";
import { stampExternalSessions } from "@/lib/session/placeholder";

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
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
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
    // 站位行标注：磁盘扫描出的外部会话站位不携带 header 扩展字段——按注册表补
    // agent 标签（前端徽标/外部模型目录路由依赖它）。
    stampExternalSessions(sessions);
    // 外部会话占位行活动时间：占位文件是静态锚点（无 message 行），modified 冻结在
    // 创建时间——续聊不自动更新。handle 存活（用户已打开会话）时以 handle 最后活动
    // 时间覆盖，侧栏「xxx前/刚刚」随对话实时刷新。
    let refreshPatched = false;
    for (const s of sessions) {
      const h = getHandle(s.id);
      const act = h?.alive() ? h.getLastActivity?.() : undefined;
      if (typeof act === "number" && act > 0) {
        s.modified = new Date(act).toISOString();
        refreshPatched = true;
      }
    }
    if (refreshPatched) sessions.sort((a, b) => b.modified.localeCompare(a.modified));
    // 会话标注 slot：扩展（如 aiti-attach-agent 的 TUI 桥占用标记）追加自有字段。
    // 数据所有权在扩展——核心不感知桥注册表等具体格式。
    try {
      await getRegistry().dispatchSessionAnnotations(sessions);
    } catch (e) {
      console.error("[sessions] annotate failed:", e instanceof Error ? e.message : e);
    }
    // ETag/304：首载多触发点（running 回灌/SSE 帧/恢复流程）重复拉全量时，
    // 列表与运行集未变 → 304 空传输（客户端带 If-None-Match）。
    // sha1 对 ~250KB JSON 为毫秒级，远小于网络传输与客户端解析。
    const payload = {
      sessions,
      sessionListVersion,
      // 运行中 = 本地 runtime + 存活且正在执行的后端会话 + TUI 桥（未认领也可见）
      runningSessionIds: [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])],
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    };
    const body = JSON.stringify(payload);
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
    // 大列表走 gzip（上游 jsonResponse）；ETag 用未压缩体计算，与客户端 If-None-Match 对齐。
    return jsonResponse(req, payload, {
      headers: { ETag: etag, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
