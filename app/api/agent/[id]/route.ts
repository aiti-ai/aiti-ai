import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { getOfflineSessionStats, startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { cwdMissingBody, missingCwdFromBody } from "@/lib/missing-cwd";
import { applyQueuedFlag, cancelCompactQueue, parkCompactIfBusy, type CompactQueueWrapper } from "@/lib/compact-queue";
import { resolveAnySession, resolveAttachBySessionId, resolveDetachedSession, attachIfBridged, resolvePlaceholderSession, resolveExternalCompositeSession, openDetachedPreferred, prefersDetached, resolveProviderOwnedSession } from "@/lib/session";
import { HandleSessionAdapter } from "@/lib/session";
import { sendWithAcceptWindow, PROMPT_FAMILY_TYPES } from "@/lib/agent-command-accept";
import { EXTENSION_REPORTED_CODE } from "@/lib/agent-client";
import { errorMessage } from "@/lib/errors";

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
  /** Which resolution path answered (forensics: a prompt answered by a non-standard session object = the twin/steer-loss bug class). */
  via?: string,
): Promise<NextResponse> {
  const outcome = await sendWithAcceptWindow(wrapper, body as Record<string, unknown>);
  const type = String(body.type ?? "");
  if (PROMPT_FAMILY_TYPES.has(type)) {
    // Forensics anchor (2026-11-22 steer-loss): one line per prompt-family send,
    // recording which resolution path answered — a non-standard `via` on a
    // session whose events never reach the page = the twin bug class.
    console.log(`[agent-send] ${type} via=${via || "unknown"} settled=${outcome.settled}`);
  }
  if (!outcome.settled) {
    onAccepted();
    return NextResponse.json({ success: true, accepted: true, pending: true, ...(via ? { via } : {}) }, { status: 202 });
  }
  if ("error" in outcome) throw outcome.error;
  onAccepted();
  return NextResponse.json({ success: true, data: outcome.result, ...(via ? { via } : {}) });
}

/**
 * Compact-queue intercept (lib/compact-queue): answers a NextResponse when the
 * command is compact/cancel_compact_queue and a live wrapper is available —
 * busy sessions get their compaction parked server-side (survives page reloads
 * and session switches, which the old client-only queue lost); idle sessions
 * fall through to the ordinary blocking execute path. Null = not handled.
 */
async function compactQueueResponse(
  id: string,
  wrapper: CompactQueueWrapper,
  body: { type?: unknown; queueIfBusy?: unknown; customInstructions?: unknown },
): Promise<NextResponse | null> {
  if (body.type === "cancel_compact_queue") {
    return NextResponse.json({ success: true, data: { cleared: cancelCompactQueue(id) } });
  }
  if (body.type === "compact" && body.queueIfBusy === true) {
    const parked = await parkCompactIfBusy(id, wrapper, {
      customInstructions: typeof body.customInstructions === "string" ? body.customInstructions : undefined,
    });
    if (parked) {
      return NextResponse.json({ success: true, data: { queued: true, queuedAt: parked.queuedAt } });
    }
  }
  return null;
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;
  // Which resolution path answered (forensics, 2026-11-22 steer-loss): a
  // prompt-family command answered by anything other than the standard
  // session object for this backend = the twin bug class — surface it in the
  // response body ("via") and the server log.
  let via = "";
  const viaTag = (tag: string) => { via = tag; return tag; };

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
        const queued = await compactQueueResponse(id, bridged, body);
        if (queued) return queued;
        return await sendAccepted(bridged, body, () => { promptAccepted = body.type === "prompt"; }, viaTag("bridge"));
      }
    }

    // Fast path: already-running session (local registry, then provider handles)
    const localWrapper = getRpcSession(id);
    let existing = localWrapper?.isAlive() ? localWrapper : resolveAnySession(id);
    if (existing?.isAlive()) viaTag(localWrapper?.isAlive() ? "local-registry" : "handle-store");
    // Placeholder uuid (the persistent pi anchor for external agent sessions): on a registry miss,
    // route to the real backend via the placeholder file — never start a local runtime for a
    // placeholder file (that would run it as an empty-shell pi session).
    if (!existing?.isAlive()) {
      const ph = await resolvePlaceholderSession(id).catch(() => undefined);
      if (ph?.isAlive()) { existing = ph; viaTag("placeholder"); }
    }
    // Detached wrapper (file-less backends included): the agent outlived a
    // restart/reload, so drive the live process instead of starting a new one.
    if (!existing?.isAlive()) {
      const detached = await resolveDetachedSession(id).catch(() => undefined);
      if (detached?.isAlive()) { existing = detached; viaTag("detached-attach"); }
    }
    // Spawn/attach-owned session files must never fall through to the local
    // runtime below: startRpcSession would open a SECOND writer on the same
    // file (the "twin"), whose events and replies bypass the chat page — the
    // steer-loss bug class (2026-11-22 forensics). Hand the file back to its
    // claiming provider: adopt the live wrapper, or resume a fresh subprocess
    // with the native id.
    if (!existing?.isAlive() && filePath) {
      const owned = await resolveProviderOwnedSession(id, filePath).catch(() => undefined);
      if (owned?.isAlive()) { existing = owned; viaTag("provider-resume"); }
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
      // get_state short-circuit: OR in the parked-compaction flag (registry-owned,
      // not part of the wrapper state) so pending-state mirrors see server truth.
      if (body.type === "get_state") {
        const state = await existing.send({ type: "get_state" }) as Record<string, unknown>;
        applyQueuedFlag(id, state);
        return NextResponse.json({ success: true, data: state });
      }
      const queued = await compactQueueResponse(id, existing, body);
      if (queued) return queued;
      return await sendAccepted(existing, body, () => { promptAccepted = body.type === "prompt"; }, via || "fast-path");
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
          viaTag("external-composite");
          return await sendAccepted(ext, body, () => { promptAccepted = body.type === "prompt"; }, via);
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

    // Survive-restart preference: this cold pi session was last hosted detached
    // ("Start · survive restarts"), so re-host it the same way instead of
    // silently downgrading to a local child. Spawn failure falls through to the
    // local path — the marker is a preference, never a lock.
    if (!id.includes(":") && prefersDetached(id)) {
      const hosted = await openDetachedPreferred(id, filePath).catch(() => undefined);
      const adapter = hosted ? new HandleSessionAdapter(hosted) : undefined;
      if (adapter?.isAlive()) {
        return await sendAccepted(adapter, body, () => { promptAccepted = body.type === "prompt"; }, viaTag("detached-preferred"));
      }
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    viaTag("local-runtime");
    return await sendAccepted(session, body, () => { promptAccepted = body.type === "prompt"; }, via);
  } catch (error) {
    // Read by its fields: the wrapper that threw may come from another route's bundle.
    const missingCwd = missingCwdFromBody(error);
    const status = (error as { status?: number })?.status;
    // single-writer hard rule: an occupancy rejection is a semantic conflict, not a server fault
    if ((error as { name?: string }).name === "BridgeOccupiedError") {
      return NextResponse.json({
        error: error instanceof Error ? error.message : String(error),
        code: "bridge_occupied",
        ...(commandType === "prompt" && !promptAccepted ? { accepted: false } : {}),
      }, { status: 409 });
    }
    return NextResponse.json({
      error: errorMessage(error),
      ...(missingCwd ? cwdMissingBody(missingCwd) : {}),
      ...((error as { code?: unknown } | null)?.code === EXTENSION_REPORTED_CODE ? { code: EXTENSION_REPORTED_CODE } : {}),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: status === 404 ? status : 500 });
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
        // Read path (state probe): attach only live sessions; a cold provider-owned
        // session is answered as idle instead of being spawned just for a status poll.
        const bridged = await attachIfBridged(bridgedFile, { create: false });
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
    // Parked-compaction flag (lib/compact-queue): lets a reopened page restore the
    // pending indicator that the old client-only queue lost on reload.
    applyQueuedFlag(id, state);
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
