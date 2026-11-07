/**
 * aiti-quickstart — server API（/api/extensions/aiti-quickstart/...，宿主 [...path] 代理）。
 *
 * 工作区获取（v2 Workspace Hub，方案 docs/aiti-quickstart-hub-plan.md）：
 *   POST workspace/clone    {url, dir?, branch?, depth?} → git clone → {ok, root, name, jobId}
 *   GET  workspace/history  → {ok, workspaces: WorkspaceRecord[]}（记录 + ~/workspace 扫描合并）
 *   POST workspace/forget   {id} → 从记录中移除
 *
 * clone 本体与历史存取在 ./clone.ts；本文件只做路由 + body 解析（api() 拦截在 bodyJson
 * 之前不必要——clone body 是小 JSON；对齐 session-manager api() 形状）。
 */
import type { ExtApiCtx } from "./types.ts";
import { handleClone, handleHistory, handleForget, handleRecord } from "./clone.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function api(req: Request, ctx: ExtApiCtx): Promise<Response | null> {
  const [action, sub] = ctx.path;
  if (action !== "workspace") return null;
  let body: Record<string, unknown> | null = null;
  if (req.method === "POST" || req.method === "PUT") {
    try { body = (await req.json()) as Record<string, unknown>; } catch { body = null; }
  }
  try {
    if (req.method === "POST" && sub === "clone") return await handleClone(body, ctx);
    if (req.method === "GET" && sub === "history") return await handleHistory(ctx);
    if (req.method === "POST" && sub === "forget") return await handleForget(body, ctx);
    // 客户端补记（local/new；scan/clone 由服务端自身写入）——source 白名单校验在 handleRecord
    if (req.method === "PUT" && sub === "history") return await handleRecord(body, ctx);
    return json({ ok: false, error: "unknown workspace action" }, 404);
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message ?? String(e) }, 500);
  }
}
