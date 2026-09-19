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

  // ── Bridge-occupancy detection (single-writer invariant, runs first; same as the agent/[id] POST) ──────────
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
  // Empty/unindexed session: socket path first — attach via a registry reverse lookup (does not depend on the file having been written)
  const liveResolved = !filePath ? await resolveAttachBySessionId(id) : undefined;
  const session = getRpcSession(id);
  let sessionPromise;
  const live = (session?.isAlive() ? session : null)
    ?? liveResolved
    ?? resolveAnySession(id);
  if (live?.isAlive()) {
    sessionPromise = Promise.resolve(live);
  } else if (filePath) {
    // Placeholder uuid (the pi persistence anchor for external agent sessions): route to the real backend; never
    // start a local runtime for the placeholder file (that would run it as an empty-shell pi session).
    const ph = await resolvePlaceholderSession(id).catch(() => undefined);
    if (ph?.isAlive()) {
      sessionPromise = Promise.resolve(ph);
    } else {
      // Lazy runtime creation (2026-09-15): opening a session page no longer cold-starts a full agent —
      // read-only browsing/stats panels (get_session_stats can already answer offline) need no runtime;
      // real interaction (send/steer etc.) triggers startRpcSession, and the running broadcast wakes this
      // stream to attach automatically. Ready as "idle" and send connected first, so the client's 60s
      // readiness timeout does not misfire.
      sessionPromise = Promise.resolve(createPendingAgentSessionHandle(
        (onReady) => waitForRpcSession(id, (wrapper) => onReady(wrapper)),
      ));
    }
  } else if (/^[a-z][\w-]*:/.test(id) && !id.startsWith("pi:")) {
    // Composite external ids (zcode:sess_x etc.) have no placeholder file to look up: in the window after a
    // process restart / extension reload where the handle registry is empty, don't 404 — cold-recover the
    // backend directly. The SSE opens immediately; on failure the real reason reaches the frontend via
    // startup_error (the 60s readiness timeout is enough to cover the app-server spin-up).
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = resolveExternalCompositeSession(id).then((s) => {
      if (!s?.isAlive()) {
        throw new Error(`Session backend unavailable: ${id} (the service may have just restarted, the agent provider is not ready, or the session can no longer be resumed)`);
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
