import { NextResponse } from "next/server";
import { resolveInterruptedSession } from "@/lib/restart-recovery";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/recovery/resolve
 *
 * Dispose of one interrupted session:
 * - { dismiss: true }                        → ignore (no longer prompted, state persisted)
 * - { keep, discard, continueRun }           → recover: open session + re-queue selected entries
 *                                              + (continueRun) start a run with "continue"
 *
 * Recovery semantics in lib/restart-recovery.ts: the original prompt is not replayed
 * (it may be a dangerous command); resuming always sends "continue"; queue entries
 * are consumed sequentially by pi.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      sessionId?: string;
      sessionFile?: string;
      keep?: string[];
      discard?: string[];
      continueRun?: boolean;
      continueText?: string;
      dismiss?: boolean;
    };
    if (!body.sessionId || !body.sessionFile) {
      return NextResponse.json({ error: "sessionId and sessionFile are required" }, { status: 400 });
    }
    const result = await resolveInterruptedSession({
      sessionId: body.sessionId,
      sessionFile: body.sessionFile,
      keep: Array.isArray(body.keep) ? body.keep : [],
      discard: Array.isArray(body.discard) ? body.discard : [],
      continueRun: body.continueRun === true,
      continueText: typeof body.continueText === "string" ? body.continueText : undefined,
      dismiss: body.dismiss === true,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
