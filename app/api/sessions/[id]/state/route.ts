import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRegistry } from "@/lib/ext/registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Bridged-session detection first (same as above)
    {
      const fp = await resolveSessionPath(id);
      if (fp) {
        let bridged;
        try {
          bridged = await attachIfBridged(fp);
        } catch (e) {
          if ((e as { name?: string }).name === "BridgeOccupiedError") {
            return NextResponse.json({ error: String(e), code: "session_bridged_unreachable" }, { status: 409 });
          }
          throw e;
        }
        if (bridged?.isAlive()) {
          const state = await bridged.send({ type: "get_state" }).catch(() => null);
          return NextResponse.json({ running: true, state, bridged: true });
        }
      }
    }
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    // Backend (provider-handle) sessions: state via the wrapper adapter.
    const wrapped = resolveAnySession(id);
    if (wrapped?.isAlive()) {
      const state = (await wrapped.send({ type: "get_state" })) as Record<string, unknown> | null;
      return NextResponse.json({
        running: true,
        state: {
          ...(state ?? {}),
          // Pass capability declarations through to the frontend (capability-aware control rendering)
          capabilities: (wrapped as { handle?: { capabilities?: unknown } }).handle
            ?.capabilities ?? (wrapped as unknown as { capabilities?: unknown }).capabilities,
          backendSource: wrapped.source,
        },
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
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
