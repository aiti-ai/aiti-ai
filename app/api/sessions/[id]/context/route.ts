import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAttachBySessionId, attachIfBridged, handleModelToClient } from "@/lib/session";
import { normalizeRawMessages } from "@/lib/normalize";

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
          const r = (await bridgedEarly.send({ type: "get_messages" }).catch(() => null)) as { entries?: unknown[] } | null;
          return NextResponse.json({
            context: {
              messages: normalizeRawMessages(r?.entries ?? []) as never[],
              entryIds: [],
              oldestEntryId: null,
              hasMore: false,
              model: handleModelToClient(bridgedEarly.getModel?.()),
              thinkingLevel: "off",
            },
            tail,
            before: before ?? null,
          });
        }
      }
    }
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    // attach 会话（含空会话/文件未落盘）：socket 优先——上下文经桥 get_messages +
    // 连接时快照的 model 返回；否则（local 索引外）404。
    let attachHandle: { send(c: unknown): Promise<unknown>; getModel?(): { id: string; provider: string } | undefined } | undefined;
    if (!liveRpc && !filePath) {
      attachHandle = await resolveAttachBySessionId(id);
      if (!attachHandle) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
    }
    if (attachHandle) {
      const r = (await attachHandle.send({ type: "get_messages" }).catch(() => null)) as { entries?: unknown[] } | null;
      return NextResponse.json({
        context: {
          // 桥端 SDK 原始形状 → 归一化（同 sessions/[id] 桥路径；否则 toolCall 块渲染为空）
          messages: normalizeRawMessages(r?.entries ?? []) as never[],
          entryIds: [],
          oldestEntryId: null,
          hasMore: false,
          model: handleModelToClient(attachHandle.getModel?.()),
          thinkingLevel: "off",
        },
        tail,
        before: before ?? null,
      });
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

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

