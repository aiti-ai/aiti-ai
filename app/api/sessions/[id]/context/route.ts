import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAttachBySessionId } from "@/lib/session";

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
          messages: (r?.entries ?? []) as never[],
          entryIds: [],
          oldestEntryId: null,
          hasMore: false,
          model: attachHandle.getModel?.() ?? null,
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

