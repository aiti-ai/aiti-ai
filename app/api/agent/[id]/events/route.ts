import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, resolveAttachBySessionId, attachIfBridged } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const filePath = await resolveSessionPath(id);

  // ── 桥占用识别（单写者红线，最先执行；同 agent/[id] POST）──────────
  if (filePath) {
    let bridged;
    try {
      bridged = await attachIfBridged(filePath);
    } catch (e) {
      if ((e as { name?: string }).name === "BridgeOccupiedError") {
        return new Response(JSON.stringify({ error: String(e), code: "bridge_occupied" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      throw e;
    }
    if (bridged?.isAlive()) {
      return new Response(createAgentEventStream(req, id, Promise.resolve(bridged)), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }
  }

  // Fast path: already-running session (local registry, then provider handles).
  // 空会话/未索引：socket 优先——registry 反查 attach（不依赖文件落盘）
  const liveResolved = !filePath ? await resolveAttachBySessionId(id) : undefined;
  const session = getRpcSession(id);
  let sessionPromise;
  const live = (session?.isAlive() ? session : null)
    ?? liveResolved
    ?? resolveAnySession(id);
  if (live?.isAlive()) {
    sessionPromise = Promise.resolve(live);
  } else {
    // startRpcSession 内部仍有 ownsFile 总闸兜底
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
