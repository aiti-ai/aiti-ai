/**
 * session-recycle — shared implementation of the session recycle API (debt D8).
 *
 * Upgrades existing handles to the current extension code without restarting the pi-web process
 * (extension hot-reload only swaps modules; handle instances already in the core handle store
 * (globalThis.__sessionHandles) keep running the old code).
 * Template: the local implementations of aiti-zcode-agent / aiti-codebuddy-agent (precedent); this
 * layer extracts the common skeleton, and each extension plugs in via the two closures
 * "isOwn + parseId".
 *
 *   GET  /session/recycle               -> list of existing sessions (id/running/alive)
 *   POST /session/recycle {id, force?}  -> idle check (a running session requires force:true, which
 *       interrupts the current turn)
 *       -> dispose the old handle -> self-fetch POST /api/session-backends (loopback always passes the gate)
 *       -> the core revival branch creates a new handle (current code) -> putHandle overwrites it.
 *   Placeholder ids (empty sessions that never sent a message) are only disposed — the front end
 *   rebuilds on demand at next access.
 *
 * ⚠ Authoritative source: pi-web-ext/_shared/session-recycle.ts. Copied into each extension
 *   directory at deploy time (same precedent as backend-queue) — changes must sync all copies, and
 *   this header comment is preserved.
 */

export interface RecycleHandleLike {
  id: string;
  isRunning(): boolean;
  alive(): boolean;
  dispose(): unknown;
  cwd?: string;
}

export interface SessionRecycleOpts {
  /** GET list filter + POST id ownership check (extension self-claims: id prefix or handle traits). */
  isOwn(handle: RecycleHandleLike): boolean;
  /**
   * id -> rebuild params. Returning null = invalid id (400);
   * an empty sessionId = placeholder session (dispose only, no rebuild); providerType = the extension's registered full type name.
   * The handle arg = the old handle currently mapped to that id (providerType can be refined by handle traits, e.g. pi's dual forks).
   */
  parseId(id: string, handle: RecycleHandleLike): { sessionId: string; providerType: string } | null;
}

/** The server's own base URL (loopback; 127.0.0.1 direct connections bypass nginx/Authelia; requests arriving via a domain fall back to argv parsing). */
export function selfBaseFromRequest(req: Request): string {
  try {
    const u = new URL(req.url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      return u.origin;
    }
  } catch { /* fallthrough */ }
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}`;
}

export function createSessionRecycleApi(opts: SessionRecycleOpts): (
  req: Request,
  ctx: { path: string[]; method: string },
) => Promise<Response | null> {
  return async (req, ctx) => {
    if (ctx.path[0] !== "session" || ctx.path[1] !== "recycle") return null;
    const store = (globalThis as { __sessionHandles?: Map<string, RecycleHandleLike> }).__sessionHandles;
    if (ctx.method === "GET") {
      const sessions = [...(store?.values() ?? [])]
        .filter((h) => opts.isOwn(h))
        .map((h) => ({ id: h.id, running: h.isRunning(), alive: h.alive() }));
      return Response.json({ sessions });
    }
    if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
    let body: { id?: unknown; force?: unknown } = {};
    try { body = await req.json() as typeof body; } catch { /* empty body treated as defaults */ }
    const id = typeof body.id === "string" ? body.id : "";
    const old = store?.get(id);
    if (!old || !opts.isOwn(old)) {
      return Response.json({ error: `no live handle: ${id}` }, { status: 404 });
    }
    const parsed = opts.parseId(id, old);
    if (!parsed) return Response.json({ error: `id does not belong to this extension (or cannot be parsed): ${id}` }, { status: 400 });
    if (old.isRunning() && !body.force) {
      return Response.json(
        { error: "session is running — retry after this turn settles; to interrupt it for sure pass force:true (the current turn is voided and queued messages are cleared with it)", running: true },
        { status: 409 },
      );
    }
    const cwd = typeof old.cwd === "string" ? old.cwd : "";
    try { await old.dispose(); } catch { /* already dead, tolerated */ }
    if (!parsed.sessionId) {
      return Response.json({ recycled: true, recreated: false, id, note: "placeholder session released (an empty session that never sent a message); the front end rebuilds on demand at next access" });
    }
    const base = selfBaseFromRequest(req);
    try {
      const res = await fetch(`${base}/api/session-backends`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerType: parsed.providerType, sessionId: parsed.sessionId, ...(cwd ? { cwd } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return Response.json({
          recycled: true, recreated: false, id,
          error: `rebuild request HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
          note: "the old handle is released — refreshing the session in the front end takes the revival path and rebuilds with the current code",
        });
      }
      return Response.json({ recycled: true, recreated: true, id, session: data });
    } catch (e) {
      return Response.json({
        recycled: true, recreated: false, id,
        error: `rebuild request failed: ${e instanceof Error ? e.message : String(e)}`,
        note: "the old handle is released — refreshing the session in the front end takes the revival path and rebuilds with the current code",
      });
    }
  };
}
