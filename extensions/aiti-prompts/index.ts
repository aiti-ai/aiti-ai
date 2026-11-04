/**
 * aiti-prompts · pi-web prompt 片段收藏扩展
 *
 * 能力：
 *   - 收藏库：prompt CRUD + 树形分组（照 aiti-cmd 命令管理）
 *   - 会话提取：core.readSession → user 消息列表 → 多选批量入库
 *   - 发送：走前端共同通道（ctx.sendChatMessage，见 client bundle）——本服务端不参与发送
 *   - 收藏输入：chatInputTop slot 按钮（client）把当前输入内容存库（POST /prompts）
 *
 * 用法：部署到 ~/.pi/web/extensions/aiti-prompts/（tools/deploy.mjs）后 reload。
 */
import { createStore, firstLine } from "./store.js";
import type { PromptStore } from "./store.js";

let store: PromptStore | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// ---------- 会话消息文本提取（AgentMessage.content: string | block[]） ----------
function textOf(message: { content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

// ---------- suggest 静态 provider（处理器：ai-input 进程内聚合优先；HTTP 端点同逻辑兑底） ----------
// 后端扩展点：本扩展启动时把查询处理器注册进 globalThis 注册表，ai-input /suggest 免 HTTP 自环直接调用
try {
  const g = globalThis as Record<string, unknown>;
  const reg = (g.__aitiSuggestHandlers ?? (g.__aitiSuggestHandlers = new Map())) as Map<
    string, (q: string, limit: number) => Promise<unknown[]> | unknown[]>;
  reg.set("aiti-prompts", (q: string, limit: number) => promptSuggest(store, q, limit));
} catch { /* 注册失败不影响主流程 */ }

// prompt suggest 查询（api /prompts/suggest 与进程内聚合共用）
// 排序：匹配度（name 前缀>name 子串>text/tags） > useCount > lastUsedAt > 名称
function promptSuggest(store: PromptStore | null, q: string, limit: number): unknown[] {
  if (!store) return [];
  // 关闭了智能提示（suggest:false）的 prompt 不参与联想（aiti-ai-input L0 本地层 / /suggest 聚合 / HTTP 端点同一函数全覆盖）
  let items = store.list().filter((it) => it.suggest !== false);
  const lq = q.trim().toLowerCase();
  if (lq) items = items.filter((it) =>
    it.name.toLowerCase().includes(lq) || it.text.toLowerCase().includes(lq) ||
    (it.tags || []).some((t) => t.toLowerCase().includes(lq)));
  const rank = (it: (typeof items)[number]): number => {
    if (!lq) return 0;
    if (it.name.toLowerCase().startsWith(lq)) return 3;
    if (it.name.toLowerCase().includes(lq)) return 2;
    if (it.text.toLowerCase().includes(lq) || (it.tags || []).some((t) => t.toLowerCase().includes(lq))) return 1;
    return 0;
  };
  items.sort((a, b) => {
    const d = rank(b) - rank(a); if (d) return d;
    const du = (b.useCount || 0) - (a.useCount || 0); if (du) return du;
    const dt = (b.lastUsedAt || 0) - (a.lastUsedAt || 0); if (dt) return dt;
    return a.name.localeCompare(b.name, "zh");
  });
  return items.slice(0, Math.max(1, Math.min(limit || 6, 20))).map((it) => ({
    id: it.id, kind: "prompt", name: it.name, text: it.text,
    groupId: it.groupId || null, useCount: it.useCount || 0, lastUsedAt: it.lastUsedAt || null, source: it.source || null,
  }));
}

export default {
  id: "aiti-prompts",
  name: "aiti prompt 片段收藏库",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-prompts-client.mjs",

  // 声明本扩展是 suggest 静态 provider（ai-input 聚合；命中 prompt 填充，优先于 AI 自由发挥——docs/aiti-ai-helper-plan.md §3.5）
  suggest: { label: "Prompt", rank: 1, path: "prompts/suggest" },

  // AI 自管理清单（docs/aiti-ai-helper-plan.md §3.2）：AI 能帮我写 prompt / 整理收藏
  ai: {
    manage: true,
    intro: "AI 能帮我写 prompt（描述场景 → AI 生成 → 校验 → 入库）",
    skills: "skills",
  },

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    toolbar: [{ id: "aiti-prompts-open", label: "Prompt", title: "aiti-prompts：收藏库 / 会话提取 / 一键插队排队", icon: "icons/bookmark.svg" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    sidebarExplorerDock: [{ id: "panel", label: "收藏库" }],
    rightFileDock: [{ id: "panel", label: "收藏库" }],
    dialogs: [
      { id: "aiti-prompts-panel", label: "aiti-prompts 收藏库" },
      { id: "aiti-prompts-save", label: "aiti-prompts 保存 prompt" },
      { id: "aiti-prompts-export", label: "aiti-prompts 导出 Prompts" },
    ],
    toolbar: [{ id: "aiti-prompts-export", label: "导出 Prompts", title: "aiti-prompts：导出本会话 Prompts（md/json）", icon: "icons/import.svg" }],
    i18n: {
      en: {
        "pp.title": "aiti-prompts",
        "exportPrompts.title": "Export prompts",
        "exportPrompts.dateFrom": "From",
        "exportPrompts.dateTo": "To",
        "exportPrompts.selectAll": "Select all",
        "exportPrompts.selectInvert": "Invert",
        "exportPrompts.loading": "Loading…",
        "exportPrompts.empty": "Nothing to export",
        "exportPrompts.perPage": "Per page",
        "exportPrompts.selected": "{count} selected",
        "exportPrompts.button": "Export {count}",
        "exportPrompts.busy": "Exporting…",
        "exportPrompts.done": "Exported {count} items",
        "exportPrompts.noneSelected": "Select items to export first",
        "exportPrompts.close": "Close",
      },
      "zh-CN": {
        "pp.title": "提示词收藏",
        "exportPrompts.title": "导出 Prompts",
        "exportPrompts.dateFrom": "开始",
        "exportPrompts.dateTo": "结束",
        "exportPrompts.selectAll": "全选本页",
        "exportPrompts.selectInvert": "反选本页",
        "exportPrompts.loading": "加载中…",
        "exportPrompts.empty": "没有可导出的内容",
        "exportPrompts.perPage": "每页",
        "exportPrompts.selected": "已选 {count} 条",
        "exportPrompts.button": "导出 {count} 条",
        "exportPrompts.busy": "导出中…",
        "exportPrompts.done": "已导出 {count} 条",
        "exportPrompts.noneSelected": "请先选择要导出的条目",
        "exportPrompts.close": "关闭",
      },
      "zh-TW": {
        "pp.title": "提示詞收藏",
        "exportPrompts.title": "匯出 Prompts",
        "exportPrompts.dateFrom": "開始",
        "exportPrompts.dateTo": "結束",
        "exportPrompts.selectAll": "全選本頁",
        "exportPrompts.selectInvert": "反選本頁",
        "exportPrompts.loading": "載入中…",
        "exportPrompts.empty": "沒有可匯出的內容",
        "exportPrompts.perPage": "每頁",
        "exportPrompts.selected": "已選 {count} 條",
        "exportPrompts.button": "匯出 {count} 條",
        "exportPrompts.busy": "匯出中…",
        "exportPrompts.done": "已匯出 {count} 條",
        "exportPrompts.noneSelected": "請先選擇要匯出的條目",
        "exportPrompts.close": "關閉",
      },
    },
  },

  server: {
    startup(ctx) {
      store = createStore(ctx.configDir);
      console.log("[aiti-prompts] 就绪 · configDir=" + ctx.configDir);
    },
    shutdown() {
      store = null;
    },

    async api(req, ctx) {
      const p = ctx.path || [];
      if (!store) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      // ---------- 收藏库 ----------
      // GET /prompts → { prompts, groups }（含分组树）
      if (p[0] === "prompts" && p.length === 1 && req.method === "GET") {
        return json({ ok: true, prompts: store.list(), groups: store.listGroups() });
      }
      // GET /prompts/suggest?q=<前缀>&limit=n → 输入联想静态 provider（契约：供 ai-input 聚合；排序：匹配度 > 使用频次 > 最近使用 > 名称）
      if (p[0] === "prompts" && p[1] === "suggest" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, q: ctx.searchParams.get("q") || "", results: promptSuggest(store, ctx.searchParams.get("q") || "", parseInt(String(ctx.searchParams.get("limit") || "6"), 10)) });
      }
      // POST /prompts
      if (p[0] === "prompts" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.text) return json({ ok: false, error: "缺少 text" }, 400);
        const text = String(body.text).trim();
        if (!text) return json({ ok: false, error: "text 不能为空" }, 400);
        return json({ ok: true, prompt: store.create({
          name: body.name !== undefined ? String(body.name) : firstLine(text),
          text,
          groupId: body.groupId ? String(body.groupId) : null,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          // suggest 缺省按 source 判定（store：manual/input 开 / session 关）；显式传才覆盖
          suggest: body.suggest === undefined ? undefined : (body.suggest === true || body.suggest === "true"),
          source: body.source || "manual",
          meta: body.meta && typeof body.meta === "object" ? body.meta : undefined,
        }) }, 201);
      }
      // POST /prompts/{id}/touch（记使用——客户端发送成功后调，不参与发送本身）
      if (p[0] === "prompts" && p.length === 3 && p[1] === "touch" && req.method === "POST") {
        store.touchUse(p[2]);
        return json({ ok: true });
      }
      // PUT/DELETE /prompts/{id}
      if (p[0] === "prompts" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        const updated = store.update(p[1], {
          name: body.name !== undefined ? String(body.name) : undefined,
          text: body.text !== undefined ? String(body.text) : undefined,
          groupId: body.groupId !== undefined ? (body.groupId ? String(body.groupId) : null) : undefined,
          tags: body.tags !== undefined ? body.tags.map(String) : undefined,
          suggest: body.suggest !== undefined ? body.suggest === true || body.suggest === "true" : undefined,
        });
        if (!updated) return json({ ok: false, error: "unknown prompt" }, 404);
        return json({ ok: true, prompt: updated });
      }
      if (p[0] === "prompts" && p.length === 2 && req.method === "DELETE") {
        return json({ ok: store.remove(p[1]) });
      }

      // ---------- 分组管理 ----------
      // POST /groups { name, parentId? }
      if (p[0] === "groups" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.name) return json({ ok: false, error: "缺少 name" }, 400);
        return json({ ok: true, group: store.createGroup(String(body.name), body.parentId ? String(body.parentId) : null) }, 201);
      }
      // PUT /groups/{id} { name?, parentId? }
      if (p[0] === "groups" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        const updated = store.updateGroup(p[1], {
          name: body.name !== undefined ? String(body.name) : undefined,
          parentId: body.parentId !== undefined ? (body.parentId ? String(body.parentId) : null) : undefined,
        });
        if (!updated) return json({ ok: false, error: "unknown group" }, 404);
        return json({ ok: true, group: updated });
      }
      // DELETE /groups/{id}（级联删子孙，prompt 移入未分组）
      if (p[0] === "groups" && p.length === 2 && req.method === "DELETE") {
        return json({ ok: store.removeGroup(p[1]) });
      }

      // ---------- 会话提取 ----------
      // GET /sessions → 会话列表（含 running 标记）
      if (p[0] === "sessions" && p.length === 1 && req.method === "GET") {
        const sessions = await ctx.core.listSessions();
        const running = new Set(await ctx.core.getRunningSessionIds());
        return json({ ok: true, sessions: sessions.map((s) => ({ ...s, running: running.has(s.id) })) });
      }
      // GET /sessions/{id}/messages → 仅 user 消息 { entryId, text, ts, preview }
      if (p[0] === "sessions" && p.length === 3 && p[2] === "messages" && req.method === "GET") {
        const sessionCtx = await ctx.core.readSession(p[1]);
        if (!sessionCtx) return json({ ok: false, error: "unknown session" }, 404);
        const out: Array<{ entryId: string; text: string; ts?: number; preview: string }> = [];
        const messages = sessionCtx.messages as Array<{ role?: string; content?: unknown; timestamp?: number }>;
        const entryIds = sessionCtx.entryIds || [];
        messages.forEach((m, i) => {
          if (m.role !== "user") return;
          const text = textOf(m).trim();
          if (!text) return;
          out.push({
            entryId: entryIds[i] ?? "",
            text,
            ts: typeof m.timestamp === "number" ? m.timestamp : undefined,
            preview: firstLine(text),
          });
        });
        return json({ ok: true, messages: out });
      }
      // POST /extract { sessionId, entryIds: string[] } → 逐条入库（去重：同文本同组不重复存）
      if (p[0] === "extract" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.sessionId || !Array.isArray(body.entryIds)) return json({ ok: false, error: "需要 sessionId + entryIds 数组" }, 400);
        const sessionCtx = await ctx.core.readSession(String(body.sessionId));
        if (!sessionCtx) return json({ ok: false, error: "unknown session" }, 404);
        const groupId = body.groupId ? String(body.groupId) : null;
        const messages = sessionCtx.messages as Array<{ role?: string; content?: unknown }>;
        const entryIds = sessionCtx.entryIds || [];
        const byEntry = new Map<string, string>();
        messages.forEach((m, i) => {
          if (m.role !== "user") return;
          const text = textOf(m).trim();
          if (text) byEntry.set(entryIds[i] ?? "", text);
        });
        // 去重：同文本同组不重复存（名字不同也算重复——内容为准）
        const existing = new Set(store.list().filter((p) => (p.groupId || null) === groupId).map((p) => p.text.trim()));
        const added: unknown[] = [];
        let skipped = 0;
        for (const entryId of body.entryIds.map(String)) {
          const text = byEntry.get(entryId);
          if (!text) { skipped++; continue; }
          if (existing.has(text)) { skipped++; continue; }
          existing.add(text);
          added.push(store.create({ name: firstLine(text), text, groupId, source: "session", meta: { sessionId: String(body.sessionId), entryId } }));
        }
        return json({ ok: true, added, skipped });
      }

      // ---------- 导入导出 ----------
      // POST /import { data: { groups?, prompts? }, mode?: "merge"|"replace" }
      if (p[0] === "import" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.data) return json({ ok: false, error: "缺少 data" }, 400);
        const mode = body.mode === "replace" ? "replace" : "merge";
        const result = store.importData(body.data, mode);
        return json({ ok: true, ...result });
      }

      // ---------- 诊断 ----------
      // GET /diag
      if (p[0] === "diag") {
        const all = store.list();
        return json({ ok: true, promptCount: all.length, groupCount: store.listGroups().length, configDir: ctx.configDir });
      }

      return json({ ok: false, error: "not found: " + p.join("/") }, 404);
    },
  },
};
