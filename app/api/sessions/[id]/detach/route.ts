import { NextResponse } from "next/server";
import { resolveSessionPath, readSessionHeader } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  createSessionHandle,
  detachSupport,
  findProvidersForAgent,
  resolveAnySession,
} from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sessions/[id]/detach — reopen a cold session as a DETACHED session.
 *
 * "Detach" means the agent process is hosted in a wrapper (agent-starter) that
 * outlives pi-web, so an in-flight turn survives a restart / extension reload
 * and the session is reattached on the next open. Detach is fixed at spawn time
 * (no fd handover), so this only applies to sessions that are not running:
 *
 *   - already live → { ok, already: true } (the running process keeps its mode)
 *   - no detachable backend for the session's agent family → 400 with the reason
 *   - host without a runner (no systemd user manager, PI_WEB_AGENT_DETACH=0) → 409
 *
 * The provider is picked by the session's agent family and the `detachable`
 * opt-in, never by name: the core does not know which backend ships a wrapper.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Running sessions cannot switch hosting (documented boundary).
    if (getRpcSession(id)?.isAlive() || resolveAnySession(id)?.isAlive()) {
      return NextResponse.json({ ok: true, already: true, detached: false });
    }
    const support = await detachSupport();
    if (!support.available) {
      return NextResponse.json(
        { error: "detached hosting is not available on this host", reason: support.reason },
        { status: 409 },
      );
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      // No session file = nothing to resume (and the id would spawn a brand-new
      // agent under it). Refuse instead of creating a phantom session.
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const header = readSessionHeader(filePath) as { extId?: string; cwd?: string } | null;
    // External agent sessions carry their backend in the placeholder header
    // (extId "claude:<sid>"); plain pi sessions have neither.
    const composite = typeof header?.extId === "string" && header.extId.includes(":") ? header.extId : undefined;
    const agentKey = composite ? composite.slice(0, composite.indexOf(":")) : "pi";
    const sessionId = composite ? composite.slice(composite.indexOf(":") + 1) : id;

    const provider = findProvidersForAgent(agentKey).find((p) => p.detachable === true);
    if (!provider) {
      return NextResponse.json(
        { error: `no detachable backend is installed for agent "${agentKey}"` },
        { status: 400 },
      );
    }

    const handle = await createSessionHandle({
      providerType: provider.type,
      sessionId,
      ...(filePath ? { sessionFile: filePath } : {}),
      ...(header?.cwd ? { cwd: header.cwd } : {}),
      detach: true,
    });
    return NextResponse.json({
      ok: true,
      already: false,
      detached: true,
      runner: support.runner,
      provider: provider.type,
      sessionId: handle.id,
      source: handle.source,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
