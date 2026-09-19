import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { relayToSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/relay — agent-to-agent message relay (aligned with cc-connect relay send).
 *
 * body: { to: string; message: string; timeoutMs?: number }
 *   → Delivers message to the target live session (any backend), waits for its turn
 *     to finish and returns the reply text.
 *
 * Response: { ok: true, to, reply } | { ok: false, error }
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json() as { to?: string; message?: string; timeoutMs?: number };
    if (!body.to || typeof body.message !== "string") {
      return NextResponse.json({ error: "to and message are required" }, { status: 400 });
    }
    const result = await relayToSession(body.to, body.message, {
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
