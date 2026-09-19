import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import {
  loadQueue,
  type PendingRecoveryItem,
  type QueueEntry,
} from "@/lib/queue-store";

function toPublicView(entry: QueueEntry): PendingRecoveryItem {
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    hasImages: Boolean(entry.images?.length),
    queuedAt: entry.queuedAt,
  };
}

/**
 * GET /api/sessions/[id]/queue-recovery
 *
 * Lists queued messages that survived a server restart and were never
 * processed (the "pending recovery" list). Deliberately lightweight: it reads
 * the sidecar file directly and does NOT create an AgentSession.
 *
 * When a live wrapper exists, its in-memory recovery list is authoritative
 * (it excludes messages currently in the live queue).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      // External-agent composite ids (`zcode:sess_xxx`, `cursor:<sid>` etc.) have no pi JSONL
      // queue file and by definition have no pending pi queue to recover; return an empty list
      // rather than 404. Otherwise useAgentSession unconditionally fetches this endpoint when
      // mounting any session, making every prefixed external-agent session emit 404 noise
      // (semantically "no queue" is itself the correct answer, and it still distinguishes
      // genuinely nonexistent local ids).
      if (id.indexOf(":") > 0) {
        return NextResponse.json({ items: [] });
      }
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" }) as { pendingRecovery?: PendingRecoveryItem[] };
      return NextResponse.json({ items: state.pendingRecovery ?? [] });
    }

    const items = loadQueue(filePath).map(toPublicView);
    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
