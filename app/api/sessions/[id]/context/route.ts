import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAttachBySessionId, attachIfBridged, handleModelToClient, resolveAnySession, resolveExternalCompositeSession } from "@/lib/session";
import { buildExternalPagedContext } from "@/lib/external-session-paging";

type MsgHandle = { send(c: unknown): Promise<unknown>; getModel?(): { id: string; provider: string } | undefined };

/** 外部后端/桥 handle 的分页上下文响应（ext-i 合成 id + tail/before 游标，语义见
 *  lib/external-session-paging.ts；此前这些通道全量返回且 hasMore 恒 false——
 *  千条级外部会话向上翻页 404/不可用）。 */
function externalContextOk(handle: MsgHandle, tail: number, before: string | null) {
  return handle.send({ type: "get_messages" }).catch(() => null)
    .then((r) => {
      const paged = buildExternalPagedContext(((r as { entries?: unknown[] } | null)?.entries ?? []) as unknown[], { tail, before });
      return NextResponse.json({
        context: {
          messages: paged.messages as never[],
          entryIds: paged.entryIds,
          oldestEntryId: paged.oldestEntryId,
          hasMore: paged.hasMore,
          model: handleModelToClient(handle.getModel?.()),
          thinkingLevel: "off",
        },
        tail,
        before: before ?? null,
      });
    });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    // 桥占用识别最先（同 sessions/[id]）：文件被 TUI 桥认领时上下文走桥
    // get_messages——磁盘文件可能落后于 TUI 内存态（正在进行的 turn 尚未 flush）。
    // 否则竞态窗口（桥登记晚于 web 首开）后上下文会永远读本地文件/双胞胎。
    {
      const fpEarly = await resolveSessionPath(id);
      if (fpEarly) {
        let bridgedEarly;
        try {
          bridgedEarly = await attachIfBridged(fpEarly);
        } catch (e) {
          if ((e as { name?: string }).name === "BridgeOccupiedError") {
            return NextResponse.json({ error: String(e), code: "session_bridged_unreachable" }, { status: 409 });
          }
          throw e;
        }
        if (bridgedEarly?.isAlive()) {
          return await externalContextOk(bridgedEarly, tail, before ?? null);
        }
      }
    }
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    // attach 会话（含空会话/文件未落盘）：socket 优先——上下文经桥 get_messages +
    // 连接时快照的 model 返回；否则（local 索引外）走外部后端 handle / 404。
    let attachHandle: MsgHandle | undefined;
    if (!liveRpc && !filePath) {
      attachHandle = await resolveAttachBySessionId(id);
    }
    if (attachHandle) {
      return await externalContextOk(attachHandle, tail, before ?? null);
    }

    // 外部后端会话（zcode:… 等 provider handle / 复合 id 冷恢复）：无本地文件、无
    // 桥 attach——此前直接 404，前端 loadContext 的向上翻页对外部会话不可用。
    if (!liveRpc && !filePath) {
      const wrapped = resolveAnySession(id)?.isAlive() ? resolveAnySession(id)
        : await resolveExternalCompositeSession(id).catch(() => undefined);
      if (wrapped?.isAlive()) {
        return await externalContextOk(wrapped, tail, before ?? null);
      }
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = buildSessionContext(sm.getEntries() as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      sessionId: id,
    });
    // 显示一致性 overlay：与 detail route（8857674）同语义——wrapper 存活时 model/thinkingLevel
    // 以进程内真实状态为准。前端 loadContext 会整体替换 data.context（含 model），不覆盖则
    // navigate/branch 后选择器显示回退旧值（context route 原本无 overlay，是「从这里编辑」
    // 显示错误的直接链路；文件读侧另有 branch 纠偏 + navigate 后补写双保险）。
    if (liveRpc) {
      const liveModel = liveRpc.inner.model;
      if (liveModel && liveModel.provider && liveModel.id) {
        context.model = { provider: liveModel.provider, modelId: liveModel.id };
      }
      const liveThinking = (liveRpc.inner.agent?.state as { thinkingLevel?: string } | undefined)?.thinkingLevel;
      if (liveThinking) context.thinkingLevel = liveThinking;
    }

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
