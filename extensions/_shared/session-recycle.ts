/**
 * session-recycle —— 会话 recycle API 共享实现（债务 D8）。
 *
 * 把存量 handle 升级到当前扩展代码，无需重启 pi-web 进程（扩展热重载只换模块，
 * core handle store（globalThis.__sessionHandles）里已存在的 handle 实例继续跑老代码）。
 * 样板：aiti-zcode-agent / aiti-codebuddy-agent 的本地实现（先例）；本层抽公共骨架，
 * 各扩展以「isOwn + parseId」两个闭包接入。
 *
 *   GET  /session/recycle               → 存量会话清单（id/running/alive）
 *   POST /session/recycle {id, force?}  → 空闲校验（运行中需 force:true，会打断当前轮）
 *       → dispose 旧 handle → 自 fetch POST /api/session-backends（loopback 恒过门禁）
 *       → core 复活分支建新 handle（当前代码）→ putHandle 覆盖。
 *   占位 id（未发过消息的空会话）仅 dispose——前端下次访问按需重建。
 *
 * ⚠ 权威源：pi-web-ext/_shared/session-recycle.ts。部署时复制进各扩展目录
 *   （同 backend-queue 先例）——改动须同步全部副本，头部保留本注释。
 */

export interface RecycleHandleLike {
  id: string;
  isRunning(): boolean;
  alive(): boolean;
  dispose(): unknown;
  cwd?: string;
}

export interface SessionRecycleOpts {
  /** GET 清单过滤 + POST id 归属校验（扩展自认领：id 前缀或 handle 特征）。 */
  isOwn(handle: RecycleHandleLike): boolean;
  /**
   * id → 重建参数。返回 null = id 不合法（400）；
   * sessionId 为空串 = 占位会话（仅 dispose，不重建）；providerType = 扩展注册 type 全名。
   * handle 参数 = 该 id 当前对应的旧 handle（providerType 可按 handle 特征细分，如 pi 双 fork）。
   */
  parseId(id: string, handle: RecycleHandleLike): { sessionId: string; providerType: string } | null;
}

/** 服务端自基址（loopback；127.0.0.1 直连不走 nginx/Authelia，经域名来的回退 argv 解析）。 */
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
    try { body = await req.json() as typeof body; } catch { /* 空体按缺省 */ }
    const id = typeof body.id === "string" ? body.id : "";
    const old = store?.get(id);
    if (!old || !opts.isOwn(old)) {
      return Response.json({ error: `无存活的 handle：${id}` }, { status: 404 });
    }
    const parsed = opts.parseId(id, old);
    if (!parsed) return Response.json({ error: `id 不属于本扩展（或无法解析）：${id}` }, { status: 400 });
    if (old.isRunning() && !body.force) {
      return Response.json(
        { error: "会话正在运行中——等本轮收口后重试；确认要打断请带 force:true（当前轮作废，已排队消息随之清空）", running: true },
        { status: 409 },
      );
    }
    const cwd = typeof old.cwd === "string" ? old.cwd : "";
    try { await old.dispose(); } catch { /* 已死容错 */ }
    if (!parsed.sessionId) {
      return Response.json({ recycled: true, recreated: false, id, note: "占位会话已释放（未发过消息的空会话），前端下次访问按需重建" });
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
          error: `重建请求 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
          note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
        });
      }
      return Response.json({ recycled: true, recreated: true, id, session: data });
    } catch (e) {
      return Response.json({
        recycled: true, recreated: false, id,
        error: `重建请求失败: ${e instanceof Error ? e.message : String(e)}`,
        note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
      });
    }
  };
}
