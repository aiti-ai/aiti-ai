import { NextResponse } from "next/server";
import { resolveSessionPath, openSessionManager, buildSessionContext, preferDiskHistory } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAttachBySessionId, attachIfBridged, handleModelToClient, resolveAnySession, resolveExternalCompositeSession } from "@/lib/session";
import { buildExternalPagedContext } from "@/lib/external-session-paging";
import { attachTranscriptNotices, readSessionTranscriptNotices } from "@/lib/transcript-notices-server";
import type { SessionEntry } from "@/lib/types";
import { waitSessionReady } from "@/lib/session/ready";

type MsgHandle = { send(c: unknown): Promise<unknown>; getModel?(): { id: string; provider: string } | undefined };

/** Paged context response for external backend/bridge handles (ext-i composite id +
 *  tail/before cursors; semantics in lib/external-session-paging.ts. Previously these
 *  channels returned everything at once with hasMore always false -- upward paging for
 *  external sessions with thousands of entries was 404/unusable). */
async function externalContextOk(handle: MsgHandle, tail: number, before: string | null) {
  // A cold-opened backend handle answers get_messages before its bootstrap finishes:
  // an adopted ACP session returns the wrapper-journal replay tail (often empty) while
  // the persisted history is still being seeded — the page then renders an empty
  // transcript and never re-reads (observed 2026-11-23, qoder: history showed, then
  // vanished / stayed empty on reopen). Wait for the handle's readiness seam first
  // (no-op for handles without one).
  await waitSessionReady(handle);
  return handle.send({ type: "get_messages" }).catch(() => null)
    .then((r) => {
      if (r === null) return null; // dead handle: let the caller fall back to the file
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
    // Oversized local files skip this entirely: a get_messages full dump is a single
    // JSONL line sized like the whole session (>8MB kills the wrapper client / wire
    // reader) — the disk branch below serves upward-paged history without spawning
    // an agent just to scroll (2026-11-22 blank-history incident).
    {
      const fpEarly = await resolveSessionPath(id);
      if (fpEarly && !preferDiskHistory(fpEarly)) {
        let bridgedEarly;
        try {
          // Read path: attach live sessions only (no process creation on open).
          bridgedEarly = await attachIfBridged(fpEarly, { create: false });
        } catch (e) {
          if ((e as { name?: string }).name !== "BridgeOccupiedError") throw e;
          // Another web instance drives this detached (single-client) wrapper. History on
          // disk is safe to read; paging must keep working instead of a 409 console error.
          console.warn(`[sessions/context] ${id}: ${(e as Error).message} — serving the disk view`);
          bridgedEarly = undefined;
        }
        if (bridgedEarly?.isAlive()) {
          // A dead/empty handle must not shadow the file: fall through to the disk read
          // (the handle's get_messages can fail right after an attach, e.g. when the
          // wrapper reaped the agent — an empty transcript with real history on disk).
          const handled = await externalContextOk(bridgedEarly, tail, before ?? null);
          if (handled) return handled;
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
      const handled = await externalContextOk(attachHandle, tail, before ?? null);
      if (handled) return handled;
    }

    // External backend sessions (provider handles like zcode:... / composite-id cold
    // recovery): no local file, no bridge attach -- this used to 404 outright, making
    // upward paging in the frontend loadContext unavailable for external sessions.
    if (!liveRpc && !filePath) {
      const wrapped = resolveAnySession(id)?.isAlive() ? resolveAnySession(id)
        : await resolveExternalCompositeSession(id).catch(() => undefined);
      if (wrapped?.isAlive()) {
        const handled = await externalContextOk(wrapped, tail, before ?? null);
        if (handled) return handled;
      }
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const entries = sm.getEntries();
    // Without a leaf, pi's own, as the full read walks from: the reply names it.
    const branchLeafId = leafId ?? sm.getLeafId();
    const transcriptNotices = readSessionTranscriptNotices({
      entries: entries as unknown as SessionEntry[],
      cwd: sm.getHeader()?.cwd ?? "",
      leafId: branchLeafId,
      models: liveRpc?.inner.modelRuntime,
    });
    const context = attachTranscriptNotices(buildSessionContext(entries as never, before ?? branchLeafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      sessionId: id,
    }), transcriptNotices);
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

    return NextResponse.json({ context, tail, before: before ?? null, leafId: branchLeafId });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
