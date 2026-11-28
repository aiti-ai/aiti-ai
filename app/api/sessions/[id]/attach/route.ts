import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, resolveDetachedSession } from "@/lib/session";
import { clearDetachedPreference } from "@/lib/agent-starter/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sessions/[id]/attach — "Start in process": convert a session that
 * was previously hosted detached (survive-restart wrapper) back to the plain
 * in-process hosting (a local RPC child owned by pi-web).
 *
 *   - clears the survive-restart preference marker (the session stops re-hosting
 *     detached on future opens)
 *   - starts the local runtime immediately, so the session is usable right away
 *
 * Guards:
 *   - pi sessions only (composite external ids keep their own hosting)
 *   - already live → { ok, already: true } (the running process keeps its mode)
 *   - unknown id → 404; bridge-claimed file → 409 via BridgeOccupiedError
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (id.includes(":")) {
      return NextResponse.json(
        { error: "in-process hosting applies to pi sessions only" },
        { status: 400 },
      );
    }
    if (getRpcSession(id)?.isAlive() || resolveAnySession(id)?.isAlive()) {
      return NextResponse.json({ ok: true, already: true, started: false });
    }
    // A live detached wrapper keeps its mode (same boundary as /detach).
    const detached = await resolveDetachedSession(id).catch(() => undefined);
    if (detached?.isAlive()) {
      return NextResponse.json({ ok: true, already: true, started: false });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // From here on the session stops re-hosting detached: clear the marker
    // BEFORE spawning so a concurrent open cannot pick the stale preference up.
    clearDetachedPreference(id);
    await startRpcSession(id, filePath, undefined, {});
    return NextResponse.json({ ok: true, already: false, started: true });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "BridgeOccupiedError") {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err), code: "bridge_occupied" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
