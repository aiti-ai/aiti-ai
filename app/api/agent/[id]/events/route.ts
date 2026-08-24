import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // 桥占用识别最先（同 agent/[id] POST）
  {
    const fp = await resolveSessionPath(id);
    if (fp) {
      const bridged = await attachIfBridged(fp);
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
  }

  // Fast path: already-running session (local registry, then provider handles)
  const session = getRpcSession(id);
  let sessionPromise;
  const live = session?.isAlive() ? session : resolveAnySession(id);
  if (live?.isAlive()) {
    sessionPromise = Promise.resolve(live);
  } else {
    const filePath = await resolveSessionPath(id);
    // 桥占用识别：TUI 桥持有的会话 → 附着事件流而非本地起 runtime
    if (filePath) {
      let bridged;
      try {
        bridged = await attachIfBridged(filePath);
      } catch (e) {
        if ((e as { name?: string }).name === "BridgeOccupiedError") {
          return new Response(JSON.stringify({ error: String(e), code: "session_bridged_unreachable" }), {
            status: 409, headers: { "content-type": "application/json" },
          });
        }
        throw e;
      }
      if (bridged?.isAlive()) {
        sessionPromise = Promise.resolve(bridged);
        return new Response(createAgentEventStream(req, id, sessionPromise), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }
    }
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
