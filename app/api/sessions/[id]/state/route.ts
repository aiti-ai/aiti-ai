import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 桥占用识别最先（同上）
    {
      const fp = await resolveSessionPath(id);
      if (fp) {
        let bridged;
        try {
          bridged = await attachIfBridged(fp);
        } catch (e) {
          if ((e as { name?: string }).name === "BridgeOccupiedError") {
            return NextResponse.json({ error: String(e), code: "session_bridged_unreachable" }, { status: 409 });
          }
          throw e;
        }
        if (bridged?.isAlive()) {
          const state = await bridged.send({ type: "get_state" }).catch(() => null);
          return NextResponse.json({ running: true, state, bridged: true });
        }
      }
    }
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    // Backend (provider-handle) sessions: state via the wrapper adapter.
    const wrapped = resolveAnySession(id);
    if (wrapped?.isAlive()) {
      const state = await wrapped.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
