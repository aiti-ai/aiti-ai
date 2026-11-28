import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";
import { resolveSessionPath } from "@/lib/session-reader";
import { getPlaceholder } from "@/lib/session/placeholder";
import { waitForHostingSwitch } from "@/lib/session/hosting-lock";
import { waitSessionReady } from "@/lib/session/ready";
import { cachedSessionHistory } from "@/lib/session/history-cache";
import { getRegistry } from "@/lib/ext/registry";
import { applyQueuedFlag } from "@/lib/compact-queue";
import { mergeHandleState } from "@/lib/session/handle-state";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // A hosting switch stops the old process before starting the new one;
    // answer after the switch settles instead of 404ing mid-swap.
    await waitForHostingSwitch(id);
    // Bridged-session detection first (same as above)
    {
      const fp = await resolveSessionPath(id);
      if (fp) {
        let bridged;
        try {
          // Opening a session is a read: attach live processes only, never spawn.
          bridged = await attachIfBridged(fp, { create: false });
        } catch (e) {
          if ((e as { name?: string }).name !== "BridgeOccupiedError") throw e;
          // Another web instance drives this detached (single-client) wrapper. Live state is
          // not ours to read — answer the disk view (idle) instead of a 409 console error;
          // sends still fail loud on the write path.
          console.warn(`[sessions/state] ${id}: ${(e as Error).message} — answering from the disk view`);
          bridged = undefined;
        }
        if (bridged?.isAlive()) {
          const state = (await bridged.send({ type: "get_state" }).catch(() => null)) as Record<string, unknown> | null;
          // Parked-compaction flag (lib/compact-queue) — pending indicator survives reload.
          applyQueuedFlag(id, state);
          // Handle-backed adapters (attach/spawn recovery double-key) also flow through
          // here — their capability declaration must ride *inside* `state`: the frontend
          // reads liveState.capabilities/backendSource (AgentStateResponse), so a
          // top-level copy left spawn sessions without capabilities and edit-from-here
          // fell back to navigate_tree (rejected by the pi spawn backend).
          const handleCapabilities = (bridged as { handle?: { capabilities?: unknown } }).handle
            ?.capabilities ?? (bridged as unknown as { capabilities?: unknown }).capabilities;
          return NextResponse.json({
            running: true,
            state: mergeHandleState(state, handleCapabilities, bridged.source),
            bridged: true,
            // Kept at the top level for diagnostics/non-frontend readers.
            capabilities: handleCapabilities,
            backendSource: bridged.source,
          });
        }
      }
    }
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = (await rpc.send({ type: "get_state" })) as Record<string, unknown>;
      applyQueuedFlag(id, state);
      return NextResponse.json({ running: true, state });
    }

    // Backend (provider-handle) sessions: state via the wrapper adapter.
    const wrapped = resolveAnySession(id);
    if (wrapped?.isAlive()) {
      await waitSessionReady(wrapped);
      const state = (await wrapped.send({ type: "get_state" })) as Record<string, unknown> | null;
      applyQueuedFlag(id, state);
      const wrappedId = (wrapped as { sessionId?: string }).sessionId;
      const cached = cachedSessionHistory([id, wrappedId ?? ""]);
      if (state && cached && cached.length > Number(state.messageCount ?? 0)) state.messageCount = cached.length;
      return NextResponse.json({
        running: true,
        // Pass capability declarations through to the frontend (capability-aware control rendering)
        state: mergeHandleState(
          state,
          (wrapped as { handle?: { capabilities?: unknown } }).handle
            ?.capabilities ?? (wrapped as unknown as { capabilities?: unknown }).capabilities,
          wrapped.source,
        ),
      });
    }

    // Dormant fallback (read-only snapshots such as task lists) — placed before the
    // 404: backend composite ids ("<agentKey>:<sid>") have no local session path, so
    // the 404 guard always fires for them; the fallback must run before it. Backend
    // extensions may provide "<extId>.sessionDormantState" (compositeId) =>
    // Promise<{tasks?: ...} | null> (field names aligned with the AgentStateResponse
    // wire format; the zcode agent extension implementation = a recent task snapshot
    // at <stateDir>/task-lists/<sid>.json). The first non-empty response is merged
    // into state; when all are absent → fall through to the usual 404/running:false.
    let dormantState: Record<string, unknown> | null = null;
    try {
      const services = getRegistry().services;
      for (const entry of services.list()) {
        if (!entry.key.endsWith(".sessionDormantState")) continue;
        const impl = services.get<(compositeId: string) => Promise<Record<string, unknown> | null>>(entry.key);
        if (typeof impl !== "function") continue;
        const res = await impl(id).catch(() => null);
        if (res && typeof res === "object") { dormantState = res; break; }
      }
    } catch { /* registry not bootstrapped etc.: degrade to no data */ }
    if (dormantState) {
      return NextResponse.json({ running: false, state: dormantState });
    }
    if (!await resolveSessionPath(id)) {
      // External placeholder sessions can be momentarily absent while the
      // hosting switch rewrites their anchor file; the registry still knows
      // them, so this is "idle", not a missing session.
      let placeholderKnown = false;
      try {
        placeholderKnown = id.includes(":") && !!getPlaceholder(id);
      } catch { /* registry unavailable → normal 404 */ }
      if (!placeholderKnown) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
