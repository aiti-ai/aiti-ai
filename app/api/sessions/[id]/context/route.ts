import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAttachBySessionId, attachIfBridged, handleModelToClient, resolveAnySession, resolveExternalCompositeSession } from "@/lib/session";
import { buildExternalPagedContext } from "@/lib/external-session-paging";

type MsgHandle = { send(c: unknown): Promise<unknown>; getModel?(): { id: string; provider: string } | undefined };

/** Paged context response for external backend/bridge handles (ext-i composite id +
 *  tail/before cursors; semantics in lib/external-session-paging.ts. Previously these
 *  channels returned everything at once with hasMore always false -- upward paging for
 *  external sessions with thousands of entries was 404/unusable). */
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
    // Bridge-occupancy detection comes first (same as sessions/[id]): when the file is
    // claimed by a TUI bridge the context goes through the bridge's get_messages -- the
    // disk file may lag the bridge's in-memory state (an in-progress turn not yet
    // flushed). Otherwise, past the race window (the bridge registering later than the
    // web's first open) the context would forever read the local file/twin.
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
    // Attach sessions (including empty sessions / files not yet on disk): socket first --
    // context is returned via the bridge's get_messages plus the model snapshotted at
    // connect time; otherwise (outside the local index) go through the external backend
    // handle / 404.
    let attachHandle: MsgHandle | undefined;
    if (!liveRpc && !filePath) {
      attachHandle = await resolveAttachBySessionId(id);
    }
    if (attachHandle) {
      return await externalContextOk(attachHandle, tail, before ?? null);
    }

    // External backend sessions (provider handles like zcode:... / composite-id cold
    // recovery): no local file, no bridge attach -- this used to 404 outright, making
    // upward paging in the frontend loadContext unavailable for external sessions.
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
    // Display-consistency overlay: same semantics as the detail route (8857674) -- while
    // the wrapper is alive, model/thinkingLevel come from the real in-process state. The
    // frontend loadContext replaces data.context wholesale (including model), so without
    // this override the selector shows a stale fallback after navigate/branch (the
    // context route originally had no overlay and was the direct path to the "edit from
    // here" display bug; the file-read side additionally has branch correction plus a
    // post-navigate write-back as double insurance).
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
