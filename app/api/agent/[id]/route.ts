import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { getOfflineSessionStats, startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { resolveAnySession, resolveAttachBySessionId, attachIfBridged, resolvePlaceholderSession, resolveExternalCompositeSession } from "@/lib/session";
import { sendWithAcceptWindow } from "@/lib/agent-command-accept";

/**
 * Accept-style sending for prompt-family commands: settles within the window → original-semantics
 * response; still pending at timeout → 202 (result arrives via SSE events). lib/agent-command-accept.ts
 * has the full background (root cause: the nginx 60s gateway timeout). onAccepted fires only on
 * successful acceptance (202 / successful settle) — the catch path relies on promptAccepted staying
 * unset to mark prompt_rejected/accepted:false (the client's "definitely rejected" criterion).
 */
async function sendAccepted(
  wrapper: Parameters<typeof sendWithAcceptWindow>[0],
  body: { type?: unknown; [key: string]: unknown },
  onAccepted: () => void,
): Promise<NextResponse> {
  const outcome = await sendWithAcceptWindow(wrapper, body as Record<string, unknown>);
  if (!outcome.settled) {
    onAccepted();
    return NextResponse.json({ success: true, accepted: true, pending: true }, { status: 202 });
  }
  if ("error" in outcome) throw outcome.error;
  onAccepted();
  return NextResponse.json({ success: true, data: outcome.result });
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    const filePath = await resolveSessionPath(id);

    // ── Bridge-occupancy detection (single-writer hard rule, runs first) ──────────────────────────────
    // Sessions held by the TUI bridge always go through the socket — even when a stale local
    // wrapper exists (the TUI owns the file). Attach failure = single-writer conflict → 409.
    if (filePath) {
      let bridged;
      try {
        bridged = await attachIfBridged(filePath);
      } catch (e) {
        if ((e as { name?: string }).name === "BridgeOccupiedError") {
          return NextResponse.json({
            error: e instanceof Error ? e.message : String(e),
            code: "bridge_occupied",
            ...(commandType === "prompt" ? { accepted: false } : {}),
          }, { status: 409 });
        }
        throw e;
      }
      if (bridged?.isAlive()) {
        return await sendAccepted(bridged, body, () => { promptAccepted = body.type === "prompt"; });
      }
    }

    // Fast path: already-running session (local registry, then provider handles)
    let existing = getRpcSession(id)?.isAlive() ? getRpcSession(id) : resolveAnySession(id);
    // Placeholder uuid (the persistent pi anchor for external agent sessions): on a registry miss,
    // route to the real backend via the placeholder file — never start a local runtime for a
    // placeholder file (that would run it as an empty-shell pi session).
    if (!existing?.isAlive()) {
      const ph = await resolvePlaceholderSession(id).catch(() => undefined);
      if (ph?.isAlive()) existing = ph;
    }

    // Upstream v0.8.10: set_tools hot-updates the tool set (rebuilds from the file path when the session isn't running).
    // Bridge-held sessions were already forwarded via socket above; whatever reaches here is locally managed.
    if (body.type === "set_tools") {
      const targetPath = (existing as { sessionFile?: string } | null | undefined)?.sessionFile || filePath || undefined;
      if (!existing?.isAlive() && !targetPath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, targetPath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      return await sendAccepted(existing, body, () => { promptAccepted = body.type === "prompt"; });
    }

    // Local path: file missing and no live session → 404; file present → start a local runtime
    // (startRpcSession still has the ownsFile master gate as a backstop — guards against another route creating the wrapper first)
    if (!filePath) {
      // Composite external ids (zcode:sess_x etc.): on a handle-registry miss (process restart /
      // extension reload window) don't 404 — cold-recover the backend directly and send;
      // only 404 with the real reason if it can't be opened.
      if (/^[a-z][\w-]*:/.test(id) && !id.startsWith("pi:")) {
        const ext = await resolveExternalCompositeSession(id).catch(() => undefined);
        if (ext?.isAlive()) {
          return await sendAccepted(ext, body, () => { promptAccepted = body.type === "prompt"; });
        }
        return NextResponse.json({
          error: `Session backend unavailable: ${id} (the service may have just restarted, the agent provider is not ready, or the session can no longer be resumed)`,
          ...(commandType === "prompt"
            ? { code: "prompt_rejected", accepted: false }
            : {}),
        }, { status: 404 });
      }
      return NextResponse.json({
        error: "Session not found",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    // Offline answer for read-only commands (2026-09-15): without a wrapper, get_session_stats no
    // longer cold-starts the whole runtime — opening the session page / the stats panel sends this
    // command, and spinning up an agent (extensions/MCP/child processes included) just to "take a
    // peek" is expensive; on an instance not running that session it also leaves a stale in-memory
    // wrapper behind (masking progress made by other ends; a real incident before the 2026-09-15
    // fix took effect). Here we aggregate directly from the session file (same accounting as the
    // online version), only missing the runtime-specific contextUsage; with a wrapper present the
    // online path above has already returned, so this is unaffected.
    if (body.type === "get_session_stats") {
      return NextResponse.json({ success: true, data: getOfflineSessionStats(id, filePath) });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    return await sendAccepted(session, body, () => { promptAccepted = body.type === "prompt"; });
  } catch (error) {
    // single-writer hard rule: an occupancy rejection is a semantic conflict, not a server fault
    if ((error as { name?: string }).name === "BridgeOccupiedError") {
      return NextResponse.json({
        error: error instanceof Error ? error.message : String(error),
        code: "bridge_occupied",
        ...(commandType === "prompt" && !promptAccepted ? { accepted: false } : {}),
      }, { status: 409 });
    }
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
// ?light=1 — for reconciliation fallback requests: strips state.systemPrompt (the only multi-KB
// field; the client already holds a copy and it barely changes within a session), shrinking the
// response from ~15KB to ~1KB.
// Call frequency is intelligently controlled by the frontend: while the SSE channel is active
// (perceivable 30s heartbeat) reconciliation is silently deferred to at most once per 2 minutes;
// high-frequency reconciliation only in suspicious windows such as heartbeat loss / connection
// errors / returning to the foreground.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const light = new URL(req.url).searchParams.get("light") === "1";

  try {
    // Socket first: attach is decided via the registry (hits even for empty/unindexed sessions), with rpc/local handles as fallback.
    // attach must take precedence over the local wrapper (getRpcSession-first would permanently pin
    // the local twin spawned in the race window to the return value — after the bridge registers,
    // state still comes from the local side and the user sees "cannot connect"); also,
    // attachIfBridged closes the twin along the way, so the next poll returns to bridge state
    // (no page refresh needed).
    // Nested workers (fork subagents .../<childUuid>/run-0/session.jsonl) register with the bridge
    // under the full file path, which resolveAttachBySessionId's `_<uuid>.jsonl` suffix derivation
    // cannot hit — attach by id→file path first (same accounting as /api/sessions/[id]/state and
    // events). Otherwise a running worker gets misjudged as idle during reconciliation (?light=1)
    // → the frontend collapses the "running" state.
    let bridgedByPath: Awaited<ReturnType<typeof attachIfBridged>> = undefined;
    const bridgedFile = await resolveSessionPath(id).catch(() => null);
    if (bridgedFile) {
      try {
        const bridged = await attachIfBridged(bridgedFile);
        if (bridged?.isAlive()) bridgedByPath = bridged;
      } catch {
        // bridge claimed it but attach failed (socket unreachable) → fall back to the other resolution paths, consistent with resolveAttachBySessionId's tolerance
      }
    }
    const session = bridgedByPath
      ?? (await resolveAttachBySessionId(id))
      ?? (getRpcSession(id)?.isAlive() ? getRpcSession(id) : resolveAnySession(id));
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" }) as Record<string, unknown>;
    // Status reads leave out the system prompt, most of the reply: fork `?light=1`,
    // upstream `?systemPrompt=0` (agentStatusUrl()). Same field, two spellings.
    const url = new URL(req.url);
    if (url.searchParams.get("systemPrompt") === "0" || url.searchParams.get("light") === "1") {
      delete state.systemPrompt;
    }
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
