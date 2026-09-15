import { createAgentEventStream, createPendingAgentSessionHandle } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, waitForRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, resolveAttachBySessionId, attachIfBridged, resolvePlaceholderSession, resolveExternalCompositeSession } from "@/lib/session";

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
  } else if (filePath) {
    // 站位 uuid（外部 agent 会话的 pi 持久锚点）：路由真实后端，绝不给站位文件
    // 起本地 runtime（那会把它当空壳 pi 会话跑起来）。
    const ph = await resolvePlaceholderSession(id).catch(() => undefined);
    if (ph?.isAlive()) {
      sessionPromise = Promise.resolve(ph);
    } else {
      // 惰性建 runtime（2026-09-15）：打开会话页不再冷启动完整 agent——只读浏览/
      // 统计面板（get_session_stats 已可离线应答）无需 runtime；真实交互（发送/
      // steer 等）触发 startRpcSession 后，经 running 广播唤醒本流自动附着。
      // 先以「空闲」形态就绪发 connected，避免客户端 60s 就绪超时误判。
      sessionPromise = Promise.resolve(createPendingAgentSessionHandle(
        (onReady) => waitForRpcSession(id, (wrapper) => onReady(wrapper)),
      ));
    }
  } else if (/^[a-z][\w-]*:/.test(id) && !id.startsWith("pi:")) {
    // 复合外部 id（zcode:sess_x 等）无站位文件可查：进程重启/扩展 reload 后
    // handle 注册表为空的窗口里不 404——直接冷恢复后端。SSE 立即打开，失败经
    // startup_error 把真实原因送达前端（60s 就绪超时足够覆盖 app-server 拉起）。
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = resolveExternalCompositeSession(id).then((s) => {
      if (!s?.isAlive()) {
        throw new Error(`会话后端不可用：${id}（服务可能刚重启，agent provider 未就绪，或会话已无法续接）`);
      }
      return s;
    });
  } else {
    return new Response("Session not found", { status: 404 });
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
