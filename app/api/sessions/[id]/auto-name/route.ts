import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { attachIfBridged } from "@/lib/session";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Detect bridge occupation first (same as agent/[id] POST): a session claimed by a TUI bridge must not
    // start a local runtime for the naming turn (it would double-write the file); attachIfBridged also
    // cleans up the race window (kills the twin).
    try {
      const bridged = await attachIfBridged(filePath);
      if (bridged?.isAlive()) {
        return NextResponse.json({ error: "session bridged; auto-name skipped" }, { status: 409 });
      }
    } catch (e) {
      if ((e as { name?: string }).name === "BridgeOccupiedError") {
        return NextResponse.json({ error: "session bridged; auto-name skipped" }, { status: 409 });
      }
      throw e;
    }

    const existing = getRpcSession(id);
    let session: NonNullable<typeof existing>;
    if (existing?.isAlive()) {
      session = existing;
    } else {
      try {
        ({ session } = await startRpcSession(id, filePath, undefined));
      } catch (e) {
        // A bridge-occupied session cannot start a local runtime — fall back to skipping auto-naming
        // (the TUI side can name the session itself)
        if ((e as { name?: string }).name === "BridgeOccupiedError") {
          return NextResponse.json({ error: "session bridged; auto-name skipped" }, { status: 409 });
        }
        throw e;
      }
    }

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
