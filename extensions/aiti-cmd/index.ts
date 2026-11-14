/**
 * aiti-cmd · pi-web 命令管理器扩展（真 TTY 终端 + 常用命令 + 消息识别命令）
 *
 * 能力：
 *   - 执行引擎：node-pty 真 PTY（实时增量帧走 aiti-event-bus 主题 cmd-<id> 唯一下行；
 *     初始回放/大消息走 REST 快照；POST 上行 input/resize/kill。旧 per-session SSE 已删——
 *     订阅 topics 唯一，禁止兑底，2026-09-09 拍板）
 *   - 常用命令：CRUD + 参数化占位符 {xxx}
 *   - 消息识别：/commands/check 异步校验（与 /api/files 同模式）
 *   - 审计：所有执行 append-only JSONL 落盘（logs/<date>.jsonl）
 *
 * 用法：部署到 ~/.pi/web/extensions/aiti-cmd/（tools/deploy.mjs）后 reload。
 */
import { createAudit } from "./audit.js";
import { createStore, normSandbox } from "./store.js";
import { checkCommand, COMMAND_DICT, describeCommand, extractCommandsFromText, loadUserDict, saveUserDict } from "./recognize.js";
import { createRunner, type RunOptions } from "./runner.js";
import { createPiCommands } from "./pi-commands.js";
import { randomBytes } from "node:crypto";

let audit: ReturnType<typeof createAudit> | null = null;
let store: ReturnType<typeof createStore> | null = null;
let runner: ReturnType<typeof createRunner> | null = null;
let piCommands: ReturnType<typeof createPiCommands> | null = null;
// 数据目录（startup 捕获，api 处统一引用，不裸读 ctx.*）——新旧 core 双轨（过渡期）：
// 新 core = configDir（持久）+ cacheDir（可重建）；旧 core（如 prod 未同步）只有 dataDir。
// 取值序 configDir → dataDir：新 core 上 dataDir 属性「访问即抛」，configDir 在前短路绝不触它。
let dirCfg = "";
let dirCache = "";

// 终端流订阅保活（停推）：type → 最后心跳时刻。前端 15s POST /alive；超 45s 未刷新的
// type 在 publish 包装里停推（页面/面板关闭后源头即断）。未报活过的 type 乐观推。
const aliveMap = new Map<string, number>();
const ALIVE_TIMEOUT_MS = 45_000;

// 词库分类展示（/commands/dict）
function COMMAND_DICT_GROUPS() {
  return COMMAND_DICT.map((g) => ({ group: g.group, names: g.names, phrases: g.phrases.slice(0, 30) }));
}

// 危险命令一次性确认 token（用后即弃 + 3s 过期，防重放）
const confirmTokens = new Map<string, number>(); // token -> expires
export function issueConfirmToken(): string {
  const t = "ct_" + randomBytes(16).toString("hex");
  confirmTokens.set(t, Date.now() + 3000);
  return t;
}
export function consumeConfirmToken(t: string): boolean {
  const exp = confirmTokens.get(t);
  if (!exp) return false;
  confirmTokens.delete(t);
  return Date.now() < exp;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// source 规范收口（aiti-cmd-exec-integration-plan.md §3.1）：枚举开放语义，这里只列基线值——
// POST /run 传基线外的新值照记（开放），传未知值归 "unknown"（防拼错不可归因）；缺 source 兜底
// manual + 审计标 sourceDefaulted（不再静默吞）。
const KNOWN_SOURCES = new Set([
  "manual", "message", "shell", "favorite", "asr-selfheal",
  "schedule", "suggest", "ai-helper", "codebuddy", "service", "unknown",
]);

// ---------- suggest 静态 provider（处理器：ai-input 进程内聚合优先；HTTP 端点同逻辑兑底） ----------
// 后端扩展点：本扩展启动时把查询处理器注册进 globalThis 注册表，ai-input /suggest 免 HTTP 自环直接调用
try {
  const g = globalThis as Record<string, unknown>;
  const reg = (g.__aitiSuggestHandlers ?? (g.__aitiSuggestHandlers = new Map())) as Map<
    string, (q: string, limit: number) => Promise<unknown[]> | unknown[]>;
  reg.set("aiti-cmd", (q: string, limit: number) => commandSuggest(store, q, limit));
} catch { /* 注册失败不影响主流程 */ }

// 命令 suggest 查询（api /commands/suggest 与进程内聚合共用）
// 排序：匹配度（name 前缀>name 子串>cmd/tags） > runCount > lastRunAt > 名称
function commandSuggest(store: ReturnType<typeof createStore> | null, q: string, limit: number): unknown[] {
  if (!store) return [];
  // 关闭了智能提示（suggest:false）的命令不参与联想（aiti-ai-input L0 本地层 / /suggest 聚合 / HTTP 端点同一函数全覆盖）
  let items = store.list().filter((c) => c.suggest !== false);
  const lq = q.trim().toLowerCase();
  if (lq) items = items.filter((c) =>
    c.name.toLowerCase().includes(lq) || c.cmd.toLowerCase().includes(lq) ||
    (c.tags || []).some((t) => t.toLowerCase().includes(lq)));
  const rank = (c: (typeof items)[number]): number => {
    if (!lq) return 0;
    if (c.name.toLowerCase().startsWith(lq)) return 3;
    if (c.name.toLowerCase().includes(lq)) return 2;
    if (c.cmd.toLowerCase().includes(lq) || (c.tags || []).some((t) => t.toLowerCase().includes(lq))) return 1;
    return 0;
  };
  items.sort((a, b) => {
    const d = rank(b) - rank(a); if (d) return d;
    const du = (b.runCount || 0) - (a.runCount || 0); if (du) return du;
    const dt = (b.lastRunAt || 0) - (a.lastRunAt || 0); if (dt) return dt;
    return a.name.localeCompare(b.name, "zh");
  });
  return items.slice(0, Math.max(1, Math.min(limit || 6, 20))).map((c) => ({
    id: c.id, kind: "cmd", name: c.name, cmd: c.cmd,
    params: c.params || [], groupId: c.groupId || null, confirm: !!c.confirm,
    runCount: c.runCount || 0, lastRunAt: c.lastRunAt || null,
  }));
}

export default {
  id: "aiti-cmd",
  name: "aiti 命令管理器（真 TTY 终端 + 常用命令）",
  icon: "icon.svg",
  client: "dist/aiti-cmd-client.mjs",

  // 声明本扩展是 suggest 静态 provider（ai-input 聚合；命中命令直接填/执行，不走 AI——docs/aiti-ai-helper-plan.md §3.5）
  suggest: { label: "命令", rank: 0, path: "commands/suggest" },

  // AI 自管理清单（docs/aiti-ai-helper-plan.md §3.2）：告诉 AI 怎么管理本扩展
  ai: {
    manage: true,
    intro: "AI 能帮我写命令（描述需求 → JSON → 校验 → 入库）",
    skills: "skills",
  },

  // 功能管理（extman 逐项启停）：agent 工具门控——core per-tool 约定 feature.id = "tool.<注入后的工具名>"
  features: [
    { id: "tool.aiti_cmd_run", label: "agent 工具：aiti_cmd_run（AI 会话内经后端 runner 执行命令；危险命令二次确认）", group: "agent-tools", default: true, description: "关闭后新 agent 会话不再注入该工具（已注入会话即时拒绝）。" },
  ],

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    // 懒加载 v2 M3批②：静态条目与 client 注册 id/icon 对齐
    toolbar: [{ id: "aiti-cmd-open", label: "命令", title: "aiti-cmd：运行总览 / 常用命令 / 执行记录", icon: "icons/terminal.svg" }],
    dialogs: [{ id: "aiti-cmd-panel", label: "aiti-cmd 命令面板" }, { id: "aiti-cmd-detail", label: "aiti-cmd 命令详情" }],
    // terminalDock 槽位声明（懒加载适配修复 2026-09-09）：declaredSlots 收集自 ui 的键——
    // 缺此声明时 pendingForSlot("terminalDock") 恒空，TerminalPanelBridge 查槽不触发本扩展
    // 物化 → fallback 再查 __aitiCmd 也无（client 未加载）→ 误报「未检测到 aiti-cmd 扩展」。
    // id 与 client registerItems("terminalDock",[{id:"workspace-terminal",…}]) 对齐；
    // 静态条目无 render，接管判定 hasExtRender 自动跳过，物化后同 id 覆盖（同 aiti-editor fileViewer 模式）。
    terminalDock: [{ id: "workspace-terminal", label: "工作区终端", title: "aiti-cmd：工作区终端页签接管（xterm）" }],
  },

  server: {
    startup(ctx) {
      dirCfg = (ctx.configDir as string) || "";
      dirCache = (ctx.cacheDir as string) || (dirCfg ? dirCfg + "/cache" : "");
      audit = createAudit(dirCache);
      store = createStore(dirCfg);
      // aiti-event-bus 发布出口（aiti-cmd 自管理是否发送；惰性现取——event-bus 晚加载/缺席均安全）。
      // 终端帧是高频大流量 → 走 publish-local（直连总线，不双喂 core route）；
      // local 缺席（旧版 event-bus）时退回全局 publish 出口。
      const publish = (type: string, data: Record<string, unknown>) => {
        try {
          const last = aliveMap.get(type);
          if (last !== undefined && Date.now() - last > ALIVE_TIMEOUT_MS) return; // 订阅已停止：停推
          const svc = (ctx.services as { get?: (n: string) => { publish?: (t: string, d: Record<string, unknown>) => void } | undefined } | undefined);
          (svc?.get?.("aiti-event-bus.publish-local") ?? svc?.get?.("aiti-event-bus.publish"))?.publish?.(type, data);
        } catch {}
      };
      runner = createRunner(audit, store, dirCache, publish);
      piCommands = createPiCommands(publish);
      piCommands.lateCatchUp(); // 扩展加载晚于 wrapper 创建：扫 registry 补订阅存量会话

      // 统一集成锚点（aiti-cmd-exec-integration-plan.md §3.2，对齐 codebuddy §9.3）：进程内共享
      // runner——跨扩展「后端建会话」的唯一出口（消费方：aiti-ai-input ASR 自愈 / aiti-codebuddy-agent
      // 登录 PTY 等）。services 版返回纯数据（非 REST 的 Response）；REST 端点保持原样作前端本体通道。
      // 方法集 = runner.ts 返回值；惰性引模块级 runner（reload 后自然指向新实例）。
      try {
        const unwrap = async (r: unknown) => {
          if (!(r instanceof Response)) return r;
          const b = await r.json().catch(() => ({}));
          return { status: r.status, ...b };
        };
        (ctx.services as { provide?: (n: string, s: unknown) => void } | undefined)?.provide?.("aiti-cmd.runner", {
          // services 通道缺省 source="service"（§3.6：services 会话同进审计）；消费方显式传值优先
          run: (opts: Partial<RunOptions> = {}) => {
            const r = runner!.run({ ...opts, source: opts.source || "service" });
            // queued/position 透传（ASR 自愈等消费方依赖排队语义，行为等价）
            return r.ok ? { ok: true, sessionId: r.sessionId, queued: r.queued === true, position: r.position } : r;
          },
          input: (id: string, data: string) => unwrap(runner!.input(id, data)),
          resize: (id: string, cols: number, rows: number) => unwrap(runner!.resize(id, cols, rows)),
          kill: (id: string) => unwrap(runner!.kill(id)),
          list: () => runner!.list(),
          getInfo: (id: string) => runner!.getInfo(id),
          diag: () => runner!.diag(),
          buffered: (id: string) => runner!.buffered(id),
          sessions: () => runner!.list(), // 与 list 同源（codebuddy 清单二者并列，保持兼容）
        });
        console.log("[aiti-cmd] services 已注册：aiti-cmd.runner（跨扩展后端建会话统一出口）");
      } catch (e) {
        console.warn("[aiti-cmd] services.provide(aiti-cmd.runner) 失败（旧 core 无 services？）", e);
      }

      // 事件总线侧注册回放数据源？不需要——终端大消息（初始回放）不走总线，
      // 客户端直接 REST 拉 /sessions/{id}/buffered 与 /pi-commands/{id}（见下方端点）。

      // 保留策略：启动清理一次 + 每日清理（按天分片超期删除）
      try { const removed = audit.cleanupRetention(); if (removed) console.log("[aiti-cmd] 清理超期日志 " + removed + " 个"); } catch {}
      const daily = setInterval(() => { try { audit?.cleanupRetention(); } catch {} }, 24 * 3600 * 1000);
      (daily as unknown as { unref?: () => void }).unref?.();
      console.log("[aiti-cmd] 就绪：node-pty=" + (runner.diag().nodePty ? "可用" : "降级 script") + " · 保留 " + audit.retentionDays + " 天 · configDir=" + dirCfg);
    },
    shutdown() {
      try { piCommands?.dispose(); } catch {}
      audit = null; store = null; runner = null; piCommands = null;
    },

    // 方案 M agent 会话钩子：新会话即订阅（官方 subscribeEvent；旧 pi-web 自动兑底 globalThis）
    agent: {
      onAgentSession(info) {
        try { piCommands?.attach(info as { sessionId: string; cwd?: string; subscribeEvent?: (l: (e: unknown) => void) => () => void; abortBash?: () => void }); } catch {}
      },
      onAgentSessionEnd({ sessionId }) {
        try { piCommands?.detach(sessionId); } catch {}
      },
      // M4b「执行命令」agent 工具（aiti-cmd-exec-integration-plan.md §4-M4/§3.5）：AI 会话内
      // 构造的命令走 §3.2 services 同款进程内 runner 执行——命令不落前端（符合 §0 判据
      // 「命令在后端不传前端」）；危险命令（checkCommand 命中）二次确认：AI 必须先向用户展示
      // 命令原文并获明确同意，才能 confirm:true 重调。门控：feature tool.aiti_cmd_run（默认开）。
      agentTools(info) {
        const sessionId = (info as { sessionId?: string } | undefined)?.sessionId;
        return [{
          name: "aiti_cmd_run",
          label: "aiti_cmd_run",
          description:
            "在 aiti-cmd 后端 PTY runner 执行一条 shell 命令，创建常驻可交互会话（输出实时进 ⚡命令 面板，全程审计）。" +
            "适合长驻/交互式/需要用户在面板围观的任务（如 dev server、watch、登录 PTY）；需要立刻拿输出的一次性命令请用自带 bash。" +
            "危险命令必须先向用户展示命令原文、获得明确同意后才可置 confirm:true 重调。",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "要执行的 shell 命令（必填）" },
              cwd: { type: "string", description: "工作目录（可选）" },
              name: { type: "string", description: "会话显示名（可选，默认取命令前缀）" },
              ttlMs: { type: "number", description: "会话保留时长毫秒（可选，默认 1h；长驻任务可传 86400000）" },
              confirm: { type: "boolean", description: "危险命令二次确认：仅在用户明确同意后置 true" },
            },
            required: ["command"],
          },
          async execute(_toolCallId: unknown, params: Record<string, unknown>) {
            const p = params || {};
            const command = String(p.command || "").trim();
            if (!command) {
              return { content: [{ type: "text", text: "缺少 command" }], isError: true } as never;
            }
            let danger: string[] = [];
            try { danger = (await checkCommand(command)).danger || []; } catch { /* 词库异常按非危险放行 */ }
            if (danger.length && p.confirm !== true) {
              return {
                content: [{ type: "text", text: "危险命令需二次确认：命中 " + danger.join(" / ") + "。请把命令原文完整展示给用户，获得明确同意后以 confirm:true 重调本次调用；未获同意则停止执行。" }],
              } as never;
            }
            if (!runner) {
              return { content: [{ type: "text", text: "runner 未初始化" }], isError: true } as never;
            }
            const r = runner.run({
              command,
              cwd: p.cwd ? String(p.cwd) : undefined,
              name: p.name ? String(p.name) : undefined,
              source: "ai-helper",
              piSessionId: sessionId ? String(sessionId) : undefined,
              danger: danger.length ? danger : undefined,
              confirm: danger.length > 0,
              ttlMs: Number.isFinite(Number(p.ttlMs)) && Number(p.ttlMs) > 0 ? Number(p.ttlMs) : undefined,
            });
            if (!r.ok) {
              return { content: [{ type: "text", text: "执行失败：" + (r.error || "未知错误") }], isError: true } as never;
            }
            return {
              content: [{ type: "text", text: "已创建会话 " + r.sessionId + (r.queued ? "（并发已满，排队中 位置 " + r.position + "）" : "") + "。输出实时进 ⚡命令 面板；快照接口 GET /api/extensions/aiti-cmd/sessions/" + r.sessionId + "/buffered 可拉取当前回放。" }],
            } as never;
          },
        }];
      },
    },

    async api(req, ctx) {
      const p = ctx.path || [];
      if (!runner || !store || !audit) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      // POST /alive {types:["cmd-s_x", ...]} —— 终端流订阅保活（前端 15s 一次；
      // 45s 未刷新的 type 在发布侧停推）。全量语义：仅刷新所列 type，缺失项交给超时判定
      //（多 tab 并存时各 tab 全量心跳互不干扰）。
      if (p[0] === "alive" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !Array.isArray(body.types)) return json({ ok: false, error: "types 必须是数组" }, 400);
        const now = Date.now();
        let n = 0;
        for (const t of body.types) {
          if (typeof t !== "string" || t.length <= 4 || !t.startsWith("cmd-")) continue; // 拒绝非 cmd- 前缀与空 id
          aliveMap.set(t, now);
          n++;
        }
        // 顺带回收：超时 1h 的陈旧条目（会话早已结束/页面早已关闭）
        for (const [t, ts] of aliveMap) if (now - ts > 3600_000) aliveMap.delete(t);
        return json({ ok: true, count: n });
      }

      // ---------- 执行引擎 ----------
      // POST /run { command, cwd?, env?, name?, source?, piSessionId?, params?, danger?, confirm?, confirmToken?, commandId?, ttlMs? }
      if (p[0] === "run" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.command) return json({ ok: false, error: "缺少 command" }, 400);
        const cmd = String(body.command);
        // 危险命令强制确认（服务端兜底）：check 命中危险模式 或 命令标记 confirm:true
        const danger = (await checkCommand(cmd)).danger;
        const isDanger = danger.length > 0 || body.confirm === true;
        const confirmToken = body.confirmToken ? String(body.confirmToken) : null;
        if (isDanger && !confirmToken) {
          return json({ ok: false, needConfirm: true, confirmToken: issueConfirmToken(), danger, reason: "危险命令需确认" }, 403);
        }
        if (confirmToken && !consumeConfirmToken(confirmToken)) {
          return json({ ok: false, error: "确认 token 无效或已过期，请重新确认" }, 403);
        }
        // source 收口（§3.1）：未知归 unknown；缺省兜底 manual + sourceDefaulted 审计标记
        const rawSource = body.source ? String(body.source) : "";
        const source = rawSource ? (KNOWN_SOURCES.has(rawSource) ? rawSource : "unknown") : "manual";
        const r = runner.run({
          command: cmd,
          cwd: body.cwd ? String(body.cwd) : undefined,
          env: body.env && typeof body.env === "object" ? body.env : undefined,
          name: body.name ? String(body.name) : undefined,
          source,
          sourceDefaulted: rawSource ? undefined : true,
          piSessionId: body.piSessionId ? String(body.piSessionId) : undefined,
          danger: danger.length ? danger : undefined,
          confirm: isDanger,
          commandId: body.commandId ? String(body.commandId) : undefined,
          ttlMs: body.ttlMs ? Number(body.ttlMs) : undefined,
          sandbox: normSandbox(body.sandbox),
        });
        if (!r.ok) return json(r, 400);
        return json({ ok: true, sessionId: r.sessionId });
      }

      // POST /shell { cwd?, name?, source? } —— 后端建交互 shell 会话（§3.3 前端「打开终端」下沉：
      // core 侧栏/工作区页签/folder·editor 查看窗/本体面板统一走这里拿 sid 渲染，命令文本不落前端；
      // "$SHELL" 与本体面板「＋ 新终端」同语义：win32 映射默认 shell 交互启动，POSIX 经 -c 内层交互）
      if (p[0] === "shell" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const rawSource = body.source ? String(body.source) : "shell";
        const ttl = Number(body.ttlMs);
        const r = runner.run({
          command: "$SHELL",
          cwd: body.cwd ? String(body.cwd) : undefined,
          name: body.name ? String(body.name) : "终端",
          source: KNOWN_SOURCES.has(rawSource) ? rawSource : "unknown",
          ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
          sandbox: "none",
        });
        if (!r.ok) return json(r, 400);
        return json({ ok: true, sessionId: r.sessionId, name: body.name ? String(body.name) : "终端" });
      }

      // GET /sessions
      if (p[0] === "sessions" && p.length === 1 && req.method === "GET") {
        return json({ ok: true, sessions: runner.list() });
      }

      // GET /sessions/{id}
      if (p[0] === "sessions" && p.length === 2 && req.method === "GET") {
        const info = runner.getInfo(p[1]);
        if (!info) return json({ ok: false, error: "unknown session" }, 404);
        return json({ ok: true, ...info });
      }

      // GET /sessions/{id}/buffered → 初始快照（大消息不走 event-bus：订阅方先订阅
      // 总线 cmd-<id>，再拉这个；seq 去重衔接实时流）
      if (p[0] === "sessions" && p.length === 3 && p[2] === "buffered" && req.method === "GET") {
        const snap = runner.buffered(p[1]);
        if (!snap) return json({ ok: false, error: "unknown session" }, 404);
        return json({ ok: true, ...snap });
      }
      // GET /sessions/{id}/cwd → shell 实时目录（Linux/macOS 读交互 shell 进程当前 pwd；
      // win32 不支持 / 会话未运行 → 404，前端降级会话创建时 cwd）。「＋ 新建」/「新 pi-web 会话」用它
      if (p[0] === "sessions" && p.length === 3 && p[2] === "cwd" && req.method === "GET") {
        const cwd = runner.liveCwd(p[1]);
        if (!cwd) return json({ ok: false, error: "cwd 不可用（会话未运行 / 平台不支持）" }, 404);
        return json({ ok: true, cwd });
      }
      // POST /sessions/{id}/input { data }
      if (p[0] === "sessions" && p.length === 3 && p[2] === "input" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.data !== "string") return json({ ok: false, error: "缺少 data" }, 400);
        return runner.input(p[1], body.data);
      }
      // POST /sessions/{id}/resize { cols, rows }
      if (p[0] === "sessions" && p.length === 3 && p[2] === "resize" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        return runner.resize(p[1], Number(body.cols), Number(body.rows));
      }
      // POST /sessions/{id}/kill
      if (p[0] === "sessions" && p.length === 3 && p[2] === "kill" && req.method === "POST") {
        return runner.kill(p[1]);
      }

      // ---------- agent 运行中命令（pi-web 会话 bash 实时视图） ----------
      // GET /pi-commands → 列表（running + 近期 done）
      if (p[0] === "pi-commands" && p.length === 1 && req.method === "GET") {
        if (!piCommands) return json({ ok: false, error: "扩展未初始化" }, 500);
        piCommands.lateCatchUp();
        return json({ ok: true, commands: piCommands.list() });
      }
      // GET /pi-commands/{id} → 初始快照（大消息不走 event-bus：text=publishedText + seq）；
      // ?meta=1 → 轻量摘要（无 text）——状态定案用，已结束命令免拉全量文本
      if (p[0] === "pi-commands" && p.length === 2 && req.method === "GET") {
        const snap = piCommands.get(p[1], ctx.searchParams.get("meta") === "1");
        if (!snap) return json({ ok: false, error: "unknown pi-command" }, 404);
        return json({ ok: true, ...snap });
      }
      // POST /pi-commands/{id}/kill → abortBash（只杀命令，不 abort turn）
      if (p[0] === "pi-commands" && p.length === 3 && p[2] === "kill" && req.method === "POST") {
        if (!piCommands) return json({ ok: false, error: "扩展未初始化" }, 500);
        return piCommands.kill(p[1]);
      }

      // ---------- 常用命令 ----------
      // GET /commands → { commands, groups }（含分组树）
      if (p[0] === "commands" && p.length === 1 && req.method === "GET") {
        return json({ ok: true, commands: store.list(), groups: store.listGroups() });
      }
      // GET /commands/suggest?q=<前缀>&limit=n → 输入联想静态 provider（契约：供 ai-helper 聚合；排序：匹配度 > 运行频次 > 最近运行 > 名称）
      if (p[0] === "commands" && p[1] === "suggest" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, q: ctx.searchParams.get("q") || "", results: commandSuggest(store, ctx.searchParams.get("q") || "", parseInt(String(ctx.searchParams.get("limit") || "6"), 10)) });
      }
      // POST /commands
      if (p[0] === "commands" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        // name 可选（UI「名称（默认=命令）」；store.create 已支持缺省用 cmd）——只校验命令内容
        if (!body || !body.cmd || !String(body.cmd).trim()) return json({ ok: false, error: "缺少命令内容（cmd）" }, 400);
        return json({ ok: true, command: store.create({
          name: body.name ? String(body.name) : undefined,
          cmd: String(body.cmd),
          cwd: body.cwd ? String(body.cwd) : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          env: body.env && typeof body.env === "object" ? body.env : undefined,
          confirm: body.confirm === true,
          groupId: body.groupId ? String(body.groupId) : null,
          sandbox: normSandbox(body.sandbox),
          // suggest 缺省按 source 判定（store：manual 开 / ai-message·clipboard 关）；显式传才覆盖
          suggest: body.suggest === undefined ? undefined : (body.suggest === true || body.suggest === "true"),
          source: body.source || "manual",
        }) }, 201);
      }
      // POST /commands/check {text, cwd?} （消息识别：词库全文扫描 + 有效性校验 → 命中命令）
      if (p[0] === "commands" && p[1] === "check" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const text = String(body.text || "");
        const cwd = body.cwd ? String(body.cwd) : undefined;
        if (!text.trim()) return json({ ok: false, error: "缺少 text" }, 400);
        const commands = await extractCommandsFromText(dirCfg, text, cwd);
        return json({ ok: true, commands, single: commands.length === 1 ? commands[0] : null });
      }
      // GET /commands/describe?text=…  （命令管理面板：识别首命令 → 分类/描述/相关短语）
      if (p[0] === "commands" && p[1] === "describe" && p.length === 2 && req.method === "GET") {
        const text = ctx.searchParams.get("text") || "";
        if (!text.trim()) return json({ ok: false, error: "缺少 text" }, 400);
        return json({ ok: true, ...describeCommand(text) });
      }
      // GET /commands/dict  → 查看词库（内置类别 + 用户自定义）
      if (p[0] === "commands" && p[1] === "dict" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, groups: COMMAND_DICT_GROUPS(), user: loadUserDict(dirCfg) });
      }
      // PUT /commands/dict { extra: ["mytool", ...] }  → 保存用户自定义词库
      if (p[0] === "commands" && p[1] === "dict" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body || !Array.isArray(body.extra)) return json({ ok: false, error: "需要 extra 数组" }, 400);
        return json({ ok: true, user: saveUserDict(dirCfg, body.extra.map(String)) });
      }
      // ---- 分组管理 ----
      // POST /commands/groups { name, parentId? }
      if (p[0] === "commands" && p[1] === "groups" && p.length === 2 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.name) return json({ ok: false, error: "缺少 name" }, 400);
        return json({ ok: true, group: store.createGroup(String(body.name), body.parentId ? String(body.parentId) : null) }, 201);
      }
      // PUT /commands/groups/{id} { name?, parentId? }
      if (p[0] === "commands" && p[1] === "groups" && p.length === 3 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        const updated = store.updateGroup(p[2], {
          name: body.name !== undefined ? String(body.name) : undefined,
          parentId: body.parentId !== undefined ? (body.parentId ? String(body.parentId) : null) : undefined,
        });
        if (!updated) return json({ ok: false, error: "unknown group" }, 404);
        return json({ ok: true, group: updated });
      }
      // DELETE /commands/groups/{id}（级联删子孙，命令移入未分组）
      if (p[0] === "commands" && p[1] === "groups" && p.length === 3 && req.method === "DELETE") {
        return json({ ok: store.removeGroup(p[2]) });
      }
      // PUT/DELETE /commands/{id}
      if (p[0] === "commands" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        // suggest 规范化布尔（防字符串 "false" 穿透存储）
        if (body.suggest !== undefined) body.suggest = body.suggest === true || body.suggest === "true";
        const updated = store.update(p[1], body);
        if (!updated) return json({ ok: false, error: "unknown command" }, 404);
        return json({ ok: true, command: updated });
      }
      if (p[0] === "commands" && p.length === 2 && req.method === "DELETE") {
        return json({ ok: store.remove(p[1]) });
      }

      // ---------- 审计历史 ----------
      // GET /history?from&to&source&exit&cmd&limit | groupBy=source（按来源汇总：数量/最近/失败率，§3.1）
      if (p[0] === "history" && p.length === 1 && req.method === "GET") {
        if (ctx.searchParams.get("groupBy") === "source") {
          return json({ ok: true, groupBy: "source", groups: audit.summarizeBySource() });
        }
        return json({ ok: true, records: audit.query({
          from: ctx.searchParams.get("from") ? Number(ctx.searchParams.get("from")) : undefined,
          to: ctx.searchParams.get("to") ? Number(ctx.searchParams.get("to")) : undefined,
          source: ctx.searchParams.get("source") || undefined,
          exit: ctx.searchParams.get("exit") || undefined,
          cmd: ctx.searchParams.get("cmd") || undefined,
          limit: ctx.searchParams.get("limit") ? Number(ctx.searchParams.get("limit")) : undefined,
        }) });
      }
      // GET /history/verify（哈希链校验——防篡改）——必须在 /{id} 之前
      if (p[0] === "history" && p[1] === "verify" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, ...audit.verify() });
      }
      // GET /history/{id}（含输出）
      if (p[0] === "history" && p.length === 2 && req.method === "GET") {
        const rec = audit.getById(p[1]);
        if (!rec) return json({ ok: false, error: "unknown record" }, 404);
        const output = audit.readOutput(p[1]);
        return json({ ok: true, record: rec, output });
      }

      // ---------- 诊断 ----------
      // GET /diag
      if (p[0] === "diag") {
        return json({ ok: true, ...runner.diag(), pi: piCommands?.diag() ?? null, retentionDays: audit.retentionDays, configDir: dirCfg });
      }

      return json({ ok: false, error: "not found: " + p.join("/") }, 404);
    },
  },
};
