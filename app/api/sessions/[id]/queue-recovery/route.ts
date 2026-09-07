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
      // 外部 agent 复合 id（`zcode:sess_xxx`、`cursor:<sid>` 等）没有 pi 的 JSONL
      // 队列文件，本就没有 pi 队列待恢复；返回空列表而非 404。否则 useAgentSession
      // 挂载任意会话时无条件拉取该端点，会让所有带前缀的外部 agent 会话刷出 404
      // 噪音（语义上「无队列」本身就是正确答案，且能区分真不存在的本地 id）。
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
