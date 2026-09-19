import { NextResponse } from "next/server";
import { scanInterruptedSessions } from "@/lib/restart-recovery";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/recovery/interrupted
 *
 * Restart recovery list: sessions that were running when the previous process was
 * interrupted (running-journal interrupted set), with per-session queued message
 * counts / interrupted prompt previews / recoverability checks. Lightweight: does
 * not create an AgentSession.
 */
export async function GET() {
  try {
    const report = await scanInterruptedSessions();
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
