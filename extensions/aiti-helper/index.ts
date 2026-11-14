/**
 * aiti-helper · pi-web AI 助手扩展（M2）
 *
 * 职责（docs/aiti-ai-helper-plan.md）：
 *   - invoke 帮助点：全功能 AI 调用（新建 agent session，带系统提示词/工具/文件访问）→ 结果预览 → 回填
 *   - 全局弹窗 AI 按钮（§4.4）：dialog 关闭按钮左边自动插 🤖
 *   - 会话观察小窗（§4.7）：后续
 *   - suggest 联想 → 归 aiti-ai-input（本扩展不重复做）
 *
 * invoke 架构（用户要求全功能，非简陋 invokeAI）：
 *   client → POST /invoke { cwd, system?, message } → POST /api/agent/new { cwd, type:"prompt", message }
 *   → 新建完整 agent session（系统提示词 + 工具 + 文件访问）→ onAgentSettled 回调拿结果 → 返回 text
 */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createResultStore, type InvokeEntry, type InvokeOrigin, type ResultStore } from "./result-store.ts";

let configDir = "";

// 帮助点注册表：按 pi skills 标准组织——每个扩展一个 skills/ 目录，
// skills/index.json 只列 skill 名字（避免全目录扫描），每个 skill 一个 skills/<name>/SKILL.md
// （frontmatter=元数据 title/placeholder/action/outputs；正文=给 AI 读的手册）。
// ai-helper 聚合时遍历 ext.ai.skills 目录 → index → 各 SKILL.md frontmatter 组装。
const helpers = new Map<string, any>();

// 各扩展 agent 工具统计（collectHelpers 时刷新）：extId → { names, total, pending }
// pending = 当前默认未注入（需启用）的工具数——整组门关 = 全部；无整组门按 per-tool 声明逐个算。
const extTools = new Map<string, { names: string[]; total: number; pending: number }>();

/** 计算一个扩展的 agent 工具统计（语义对齐 core collectExtAgentTools 门控）。 */
function collectExtToolsStat(ext: any): { names: string[]; total: number; pending: number } {
  const id = String(ext?.id || "");
  let names: string[] = [];
  try {
    const at = ext?.ext?.server?.agent?.agentTools;
    if (typeof at === "function") {
      const defs = at({ sessionId: "", cwd: "" }) || [];
      names = (Array.isArray(defs) ? defs : []).map((d: any) => String(d?.name || "")).filter(Boolean);
    }
  } catch { /* agentTools 抛错 → 退回声明 */ }
  if (!names.length) {
    // 兑底：features 里 tool.* 声明（扩展没实现 agentTools / 抛错时）
    names = (ext?.ext?.features || []).map((f: any) => f?.id).filter((fid: any) => typeof fid === "string" && fid.startsWith("tool.")).map((fid: string) => fid.slice(5));
  }
  const feats: Array<{ id?: string; type?: string }> = ext?.ext?.features || [];
  const hasWholeGate = feats.some((f) => f?.id === "agentTools.enabled" && f?.type !== "string");
  const reg = (globalThis as Record<string, any>).__piWebExt;
  const fe = (fid: string) => { try { return !!reg?.featureEnabled?.(id, fid); } catch { return true; } };
  let pending = 0;
  if (hasWholeGate) {
    pending = fe("agentTools.enabled") ? 0 : names.length;
  } else {
    for (const n of names) {
      if (feats.some((f) => f?.id === "tool." + n) && !fe("tool." + n)) pending++;
    }
  }
  return { names, total: names.length, pending };
}

// ---------- 极简 YAML 子集解析（frontmatter 用：嵌套对象 + 对象数组 + 标量） ----------
function yamlScalar(v: string): any {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
// 解析 YAML 子集：支持 `key: value`、`key:`（对象）、`- item`/`- key: v`（数组）。
// 数组容器用内部 `_items` 标记，结束时转回真实数组（finalizeYaml）。不处理多行块/锚点。
function finalizeYaml(o: any): any {
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) o[i] = finalizeYaml(o[i]); return o; }
  if (o && typeof o === "object") {
    if (Array.isArray(o._items)) {
      const arr = o._items; for (let i = 0; i < arr.length; i++) arr[i] = finalizeYaml(arr[i]);
      return arr;
    }
    for (const k of Object.keys(o)) o[k] = finalizeYaml(o[k]);
    return o;
  }
  return o;
}
function parseYamlSubset(src: string): any {
  const lines = src.split("\n");
  const root: Record<string, any> = {};
  // 栈：{ indent, parent(容器对象) }——数组项挂在 parent._items
  const stack: Array<{ indent: number; parent: any }> = [{ indent: -1, parent: root }];
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = (raw.match(/^\s*/) || [""])[0].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    if (line.startsWith("- ")) {
      const rest = line.slice(2).trim();
      if (!top.parent._items) top.parent._items = [];
      if (rest === "") { const item: any = {}; top.parent._items.push(item); stack.push({ indent, parent: item }); continue; }
      const ci = rest.indexOf(":");
      if (ci >= 0) {
        const k = rest.slice(0, ci).trim(); const v = rest.slice(ci + 1).trim();
        const item: any = {}; top.parent._items.push(item);
        if (v === "") stack.push({ indent, parent: item });
        else { item[k] = yamlScalar(v); stack.push({ indent, parent: item }); }
      } else top.parent._items.push(yamlScalar(rest));
      continue;
    }
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const k = line.slice(0, ci).trim(); const v = line.slice(ci + 1).trim();
    if (v === "") { const child: any = {}; top.parent[k] = child; stack.push({ indent, parent: child }); }
    else top.parent[k] = yamlScalar(v);
  }
  return finalizeYaml(root);
}
// 解析 SKILL.md frontmatter：`---\n yaml \n---\n body`
function parseSkillFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  return { meta: parseYamlSubset(m[1]), body: m[2].trim() };
}

// 从扩展注册表（globalThis.__piWebExt）聚合所有扩展的 ai.skills 帮助点。
// 扩展声明：export default { ..., ai: { manage, intro, skills: "skills"（目录，缺省 "skills"） } }
// skills/index.json 列 skill 名；每个 skill = skills/<name>/SKILL.md（frontmatter=元数据 + 正文）。
function collectHelpers(): number {
  let n = 0;
  try {
    const reg = (globalThis as Record<string, any>).__piWebExt;
    const all = reg && typeof reg.all === "function" ? reg.all() : [];
    for (const ext of all) {
      const ai = ext?.ext?.ai;
      if (!ai || !ai.manage) continue;
      const extDir = (ext as any)?.dir ? String((ext as any).dir) : "";
      if (!extDir) continue;
      const ownerId = String((ext as any)?.id || "");
      extTools.set(ownerId, collectExtToolsStat(ext as any));
      const skillsDir = join(extDir, ai.skills ? String(ai.skills) : "skills");
      const idxPath = join(skillsDir, "index.json");
      let names: string[] = [];
      try { if (existsSync(idxPath)) {
        const idx = JSON.parse(readFileSync(idxPath, "utf8"));
        names = Array.isArray(idx) ? idx : (Array.isArray(idx?.skills) ? idx.skills : []);
      } } catch (e) { console.warn("[aiti-helper] skills/index.json 读取失败:", ext.id, (e as Error).message); }
      for (const name of names) {
        const id = String(name); if (!id) continue;
        const skillFile = join(skillsDir, id, "SKILL.md");
        let meta: Record<string, any> = {}; let body = "";
        try { if (existsSync(skillFile)) {
          const fm = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
          meta = fm.meta || {}; body = fm.body;
        } } catch (e) { console.warn("[aiti-helper] SKILL.md 读取失败:", id, (e as Error).message); }
        const exists = helpers.has(id);
        const ot = extTools.get(ownerId);
        helpers.set(id, {
          id,
          title: String(meta.title || meta.name || id),
          summary: meta.summary ? String(meta.summary) : undefined,
          placeholder: meta.placeholder ? String(meta.placeholder) : undefined,
          outputs: meta.outputs || undefined,
          action: meta.action || undefined,
          skillPath: skillFile,
          owner: ownerId,   // 归属扩展 id（用户自定义 skill 用 user:true + owner）
          ownerTools: ot && ot.total > 0 ? { total: ot.total, pending: ot.pending } : undefined,
        });
        if (!exists) { n++; if (!body) console.warn("[aiti-helper] 帮助点缺正文: ", id, skillFile); }
      }
    }
  } catch (e) {
    console.error("[aiti-helper] collectHelpers 失败:", e instanceof Error ? e.message : e);
  }
  // 合并用户自定义 skills（data 目录可写；owner 标记归属扩展，不指定归 aiti-helper）
  collectUserSkills();
  return n;
}

// ---------- 用户自定义 skills（data 目录维护；用户自己加，不属于任何扩展的部署产物） ----------
// 存储：<configDir>/aiti-helper/user-skills/
//   index.json         [{ id, name, owner, title, summary, at, updatedAt }]
//   <id>/SKILL.md      user skill 手册（frontmatter + 正文）
const userSkills = new Map<string, { id: string; name: string; owner: string; title: string; summary?: string; at: number; updatedAt: number }>();
let userSkillsLoaded = false;

function userSkillsDir(): string {
  return join(configDir, "user-skills");
}
function loadUserSkills(): void {
  if (!configDir) return;
  userSkills.clear();
  const idx = join(userSkillsDir(), "index.json");
  try {
    if (existsSync(idx)) {
      const arr = JSON.parse(readFileSync(idx, "utf8"));
      if (Array.isArray(arr)) for (const s of arr) {
        if (s && s.name) userSkills.set(String(s.name), { id: String(s.name), name: String(s.name), owner: String(s.owner || "aiti-helper"), title: String(s.title || s.name), summary: s.summary ? String(s.summary) : undefined, at: Number(s.at || Date.now()), updatedAt: Number(s.updatedAt || s.at || Date.now()) });
      }
    }
  } catch (e) { console.warn("[aiti-helper] user-skills index 读取失败:", (e as Error).message); }
  userSkillsLoaded = true;
}
function saveUserSkillsIndex(): void {
  if (!configDir) return;
  const dir = userSkillsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify([...userSkills.values()], null, 2));
}
// 用户自定义 skills 合并进 helpers Map（skillPath → data 目录 SKILL.md；user:true + owner 标记）
function collectUserSkills(): void {
  if (!configDir) return;
  if (!userSkillsLoaded) loadUserSkills();
  const dir = userSkillsDir();
  for (const [name, s] of userSkills) {
    const skillFile = join(dir, name, "SKILL.md");
    let meta: Record<string, any> = {}; let body = "";
    try { if (existsSync(skillFile)) { const fm = parseSkillFrontmatter(readFileSync(skillFile, "utf8")); meta = fm.meta || {}; body = fm.body; } } catch {}
    helpers.set(name, {
      id: name,
      title: String(meta.title || s.title || name),
      summary: meta.summary ? String(meta.summary) : (s.summary || undefined),
      placeholder: meta.placeholder ? String(meta.placeholder) : undefined,
      outputs: meta.outputs || undefined,
      action: meta.action || undefined,
      skillPath: skillFile,
      user: true,          // 用户自定义（非扩展声明）
      owner: s.owner,      // 归属扩展 id（缺省 aiti-helper）
    });
  }
}

// 结果状态机（纯逻辑模块；方案 docs/aiti-helper-result-event-bus-plan.md）。
//   结果交付走 event-bus `result` 帧（带全文），HTTP /result 仅做快照（永不持连接）。
//   宽限到点仍未结算的零产出/失败轮次 → onGraceExpire 发 `result{ok:false,code:"no_result"}` 帧。
const store: ResultStore = createResultStore({
  onGraceExpire: (sessionId: string, entry: InvokeEntry) => {
    busPublish("helper-" + sessionId, {
      evt: "result", ok: false, turn: entry.origin.turn,
      code: "no_result", error: entry.failedError || "本轮未产生结果（模型报错或中止）——请重试",
      at: Date.now(),
    });
  },
});

// 活动 agent 会话注册表（vestigial：onAgentSession 记录 steer 句柄）。
//   注：/followup 已改走 POST /api/agent/<id>（回收会话会 startRpcSession 重建 + 重发 onAgentSession），
//   不再依赖此句柄；保留仅避免改动 hook 签名。
const agentSessions = new Map<string, { steer: (t: string) => Promise<void> }>();

// ── 流式进度 + 结果 → aiti-event-bus topics（方案 aiti-helper-stream-event-bus-migration-plan.md §3.1
//    + 结果交付方案 docs/aiti-helper-result-event-bus-plan.md）──
// 帧契约 { type: "helper-<sessionId>", evt, ... }：进度帧替代旧「client 直连宿主 per-session SSE」；
// 结果帧（evt:"result"，带全文）替代旧「/result long-poll 等 deferred」——弹窗订阅总线即可拿结果，
// HTTP /result 降级为纯快照（永不持连接；被 nginx 60s proxy_read_timeout 掐断的旧链路已废）。
// busPublish 惰性现取（aiti-cmd 同款范式）：event-bus 晚加载/缺席/异常均静默 no-op。
let busCtx: { services?: { get?: (n: string) => { publish?: (t: string, d: Record<string, unknown>) => void } | undefined } } | null = null;
function busPublish(type: string, data: Record<string, unknown>): void {
  try {
    const svc = busCtx?.services;
    (svc?.get?.("aiti-event-bus.publish-local") ?? svc?.get?.("aiti-event-bus.publish"))?.publish?.(type, data);
  } catch { /* 总线缺席/坏帧：静默（弹窗降级无实时进度，/result 照常） */ }
}

// 宿主 agent 事件 → 弹窗帧投影（语义对齐宿主 SSE 出口 lib/agent-event-wire.ts 的
// toClientAgentEvent：toolcall_start/delta 从 partial.content 抽 id/toolName、剥 partial 大对象；
// turn_start/turn_end 及弹窗不消费的类型不发）。返回 null = 不发帧。
function projectAgentEvent(e: { type: string } & Record<string, unknown>): Record<string, unknown> | null {
  const t = e.type;
  if (t === "message_start") return { evt: "message_start", message: e.message };
  if (t === "message_update") {
    const ae = e.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!ae || typeof ae !== "object") return null;
    if (!("partial" in ae)) return { evt: "message_update", assistantMessageEvent: ae };
    const { partial, ...rest } = ae as { partial?: { content?: unknown } };
    const content = partial && Array.isArray(partial.content) ? partial.content : null;
    const idx = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
    const block = content && idx >= 0 && idx < content.length ? content[idx] as Record<string, unknown> | undefined : undefined;
    if (block && block.type === "toolCall") {
      const meta: Record<string, unknown> = {};
      if (typeof block.id === "string") meta.id = block.id;
      else if (typeof block.toolCallId === "string") meta.id = block.toolCallId;
      if (typeof block.name === "string") meta.toolName = block.name;
      else if (typeof block.toolName === "string") meta.toolName = block.toolName;
      return { evt: "message_update", assistantMessageEvent: { ...rest, ...meta } };
    }
    return { evt: "message_update", assistantMessageEvent: rest };
  }
  if (t === "tool_execution_update") {
    return { evt: "tool_execution_update", toolCallId: e.toolCallId, toolName: e.toolName, partialResult: e.partialResult };
  }
  if (t === "agent_start") return { evt: "agent_start" };
  if (t === "agent_end") return { evt: "agent_end" };
  // run 真正终态（retry/压缩/队列续跑都排除后）——弹窗据此收结果；
  // 比 agent_end 可靠（零产出/中止轮次可能无 agent_end 后续事件）
  if (t === "agent_settled") return { evt: "agent_settled" };
  return null; // turn_start/turn_end/file_changed… 弹窗不消费，不发
}

// 会话事件订阅表：sessionId → 退订函数（onAgentSession 建，onAgentSessionEnd 退）。
// 同 sid 重建（idle GC → wrapper 重建重发 onAgentSession）时先退旧再订新。
const agentSubs = new Map<string, () => void>();

// invoke 历史（内存 + JSONL 持久化；关闭不丢，可查看/恢复/补落地）
interface HelperHistory {
  id: string; at: number; message: string; system?: string; contextLabel?: string;
  result: string; model?: string | null; sourceSession?: string | null; helperId?: string | null;
  landed?: boolean; landDetail?: string | null; turn?: number; agentSessionId?: string | null;
  placeholder?: string | null;
}
const history: HelperHistory[] = [];
let historyFile = "";
const HISTORY_MAX = 200; // 内存上限

function loadHistory() {
  try {
    const txt = readFileSync(historyFile, "utf8");
    for (const line of txt.split("\n").filter(Boolean)) {
      try { history.push(JSON.parse(line)); } catch {}
    }
  } catch {}
}
function saveHistory(h: HelperHistory) {
  history.push(h);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  try {
    mkdirSync(dirname(historyFile), { recursive: true });
    appendFileSync(historyFile, JSON.stringify(h) + "\n");
  } catch {}
}
function touchHistory(id: string, patch: Partial<HelperHistory>) {
  const h = history.find((x) => x.id === id);
  if (!h) return null;
  Object.assign(h, patch);
  return h;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function audit(line: Record<string, unknown>) {
  try {
    mkdirSync(configDir, { recursive: true });
    appendFileSync(join(dirname(configDir), "cache", "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
  } catch { /* ignore */ }
}

// 推断 server 端自请求的 API base：必须走本机端口（127.0.0.1），不能用 host header 的外部域名
// （nginx 反代外部域名到 dev server，但 /api/agent/new 的转发规则可能 405）。basePath 供帮助点 system
// 里的 <basePath> 占位符替换。优先从 referer 取（浏览器场景），否则从 req.url 路径推。
function resolveApiBase(req: Request): { localOrigin: string; basePath: string; apiBase: string } {
  const reqUrl0 = new URL(req.url, "http://127.0.0.1:3001");
  const localOrigin = "http://127.0.0.1:" + reqUrl0.port;
  const referer = req.headers.get("referer") || "";
  let basePath = "";
  if (referer) {
    try {
      const refPath = new URL(referer).pathname;
      const m = refPath.match(/^(\/[^/]+)(?:\/api\/|\/|$)/);
      if (m) basePath = m[1] || "";
    } catch {}
  }
  if (!basePath) {
    const m = reqUrl0.pathname.match(/^(\/[^/]+)?\/api\/extensions\//);
    if (m) basePath = m[1] || "";
  }
  return { localOrigin, basePath, apiBase: localOrigin + basePath };
}


export default {
  id: "aiti-helper",
  name: "AI Helper（扩展的一句话 AI 能力）",
  icon: "icons/sparkles.svg",   // 单源星星（_shared/icons 库；deploy copyIcons 拷入，不再有根 icon.svg）
  client: "dist/aiti-helper-client.mjs",

  // AI 自管理清单：AI 能帮我整理/清理 invoke 历史
  ai: {
    manage: true,
    intro: "AI 能帮我查看/整理 AI Helper 的历史记录",
    skills: "skills",
  },

  ui: {
    // [懒加载 v2 拆包] 薄 entry（全局接线：invoke 入口/弹窗 AI 按钮注入器/services）即时加载；
    // 重 UI（弹窗本体 ~60K+）由 entry 首次 invoke 时动态 import（见 client/src/entry.tsx）。
    clientImmediately: true,
    // 懒加载 v2 M3批②：icon 补齐；移除错放在 toolbar 的「aiti-helper-dialog」陈旧声明
    //（它实为 client 的 pages 条目——留在 toolbar 里会变成幻影静态按钮）
    toolbar: [
      { id: "aiti-helper-open", label: "AI", title: "aiti-helper：一句话唤起 AI（帮助点/自由发挥；独立置顶弹窗，可拖拽，有历史）", icon: "icons/sparkles.svg" },
    ],
  },

  server: {
    startup(ctx) {
      configDir = ctx.configDir || "";
      historyFile = join(dirname(configDir), "state", "history.jsonl"); // 数据分层：历史记录（不可再生）→ <extRoot>/state/
      busCtx = ctx; // 流式进度发布出口（惰性现取 services；见 busPublish）
      try { mkdirSync(configDir, { recursive: true }); } catch {}
      loadHistory();
      collectHelpers();
      console.log("[aiti-helper] v0.5 就绪 · configDir=" + configDir + " · 历史 " + history.length + " 条 · 帮助点 " + helpers.size + " 个 · 进度+结果走 aiti-event-bus topics helper-<sid>");
    },
    shutdown() {
      store.dispose();   // 结果状态机：清全部计时器与账本（无 deferred/长等待可清）
      for (const off of agentSubs.values()) { try { off(); } catch { /* ignore */ } }
      agentSubs.clear();
      busCtx = null;
      configDir = "";
    },

    /** 全功能 AI 调用：新建 agent session → 总线 result 帧交付结果（/result 仅快照） */
    async api(req, ctx) {
      const p = ctx.path || [];
      if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      // POST /invoke → 新建全功能 session → 等 onAgentSettled → 返回 text
      if (p[0] === "invoke" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.message) return json({ ok: false, error: "需要 message" }, 400);

        const sessionCtx = body.sessionCtx || {};
        const cwd = sessionCtx.cwd || body.cwd;
        if (!cwd) return json({ ok: false, error: "无法确定工作目录：当前页面没有活跃会话，且默认工作目录（/api/default-cwd）也获取失败。请先打开一个会话或工作目录后重试。" }, 400);

        // 推断 API base（server 端自请求走本机端口 + basePath）：详见 resolveApiBase
        const { localOrigin, basePath } = resolveApiBase(req);

        // ---- 组装上下文提示词（只告诉新 session 来源 ID/环境，不读历史——AI 自己用工具读）----
        const ctxLines = [
          "[发起上下文]",
          sessionCtx.sessionId ? "来源会话 ID: " + sessionCtx.sessionId : "",
          sessionCtx.sessionName ? "来源会话名: " + sessionCtx.sessionName : "",
          "工作目录: " + cwd,
          // 发起方来源标注：pageId（如 xxx/ai）——AI 操作页面时知道用户从哪个窗口发起
          body.sourcePageId ? "发自: " + body.sourcePageId + (body.sourceIsAiWin ? "（AI 主窗口）" : "") : "",
          sessionCtx.model ? "来源模型: " + (sessionCtx.model.provider || "?") + "/" + (sessionCtx.model.modelId || "?") : "",
          sessionCtx.isStreaming ? "来源会话状态: 正在运行中（streaming）" : "",
          body.contextLabel ? "触发场景: " + body.contextLabel : "",
        ].filter(Boolean);

        // 安全网（对标 etckeeper Pre-Invoke）：AI 即将操作（可能改配置/扩展），先让 aiti-configs 固化现场——
        // 改坏可回滚。fire-and-forget 不阻塞 invoke。basePath/localOrigin 已在上方推断。
        try {
          const snapUrl = localOrigin + basePath + "/api/extensions/aiti-configs/snapshot";
          fetch(snapUrl, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "chore(configs): ai-helper invoke 前固化现场" }), cache: "no-store",
          }).then((r) => r.json().catch(() => null))
            .then((d) => { if (d && d.hash) audit({ action: "configs_snapshot", hash: d.hash, noop: !!d.noop }); })
            .catch(() => {});
        } catch {}

        // 多轮追问上下文：prevTurns = [{ message, result, system? }] 之前几轮的要求与回复
        const prevTurns = Array.isArray(body.prevTurns) ? body.prevTurns.slice(-5) : [];
        let prevTurnsText = "";
        if (prevTurns.length) {
          prevTurnsText = prevTurns.map((t, i) =>
            "第" + (i + 1) + "轮\n用户要求：" + (t.message || "") + "\nAI 回复：" + String(t.result || "").slice(0, 4000)
          ).join("\n\n");
        }

        const systemPrompt = (body.system || "你是 pi-web 扩展的 AI 助手。根据用户要求完成任务，可以读写文件、执行命令、调用工具。如果上下文给了来源会话 ID，你可以用工具读取该会话的历史消息来理解当前对话内容。" +
          "\n\n[与用户交互] 你可以用 aiti_user_* 工具与用户交互：aiti_user_choose（给候选项让用户选）、aiti_user_input（请用户输入文本）、aiti_user_confirm（向用户确认是/否）、aiti_user_pick_element（请用户点选页面元素）、aiti_user_notify（非阻塞通知）。当用户请求信息不足（如只说『列出所有 session 让我选择』却没给具体条件/范围）、需要在候选项中做选择、或需要用户确认时，主动调用这些工具向用户继续收集信息，而不是猜测或直接放弃——先读出候选列表（如 session 列表），再用 aiti_user_choose 把选项列给用户选。") +
          "\n\n" + ctxLines.join("\n") +
          (prevTurnsText ? "\n\n[之前的对话历史]（用户对结果不满意时追加要求，请延续这些要求调整你的输出）\n" + prevTurnsText : "");
        // 帮助点手册：优先 skill 文件（只注入一行绝对路径，AI 用 read 工具按需阅读，不内联长 system）；
        // 无 skill 文件时回退内联 system。三部分注入：手册位置一句话 + 上下文(cwd/sessionId) + 用户要求。
        if (body.helperId) collectHelpers();  // 兜底：确保其他扩展的 ai.helpers 已聚合（reload 后扩展加载顺序不定）
        const helper = body.helperId ? helpers.get(String(body.helperId)) : undefined;
        let helperIntro = "";
        if (helper && helper.skillPath) {
          helperIntro = "\n\n[帮助点手册]\n本次帮助点：" + (helper.title || helper.id) +
            "\n手册文件：" + helper.skillPath +
            "\n请先用 read 工具完整阅读该手册文件，严格按其中定义的任务、输出格式、落地动作完成用户请求（若手册要求先调用某个 API 读取数据，务必照做）。";
        }
        const finalSystem = (systemPrompt + helperIntro).split("<basePath>").join(basePath || "");
        const fullMessage = finalSystem + "\n\n---\n[用户请求]\n" + body.message;

        // fill 帮助点：注入回填工作流提示词（指导 AI 用 self_ui + form_fill 把结果直接操作到扩展弹窗表单）
        let fillGuide = "";
        if (body.helperId) {
          const helper2 = helpers.get(String(body.helperId));
          if (helper2 && helper2.action && helper2.action.type === "fill") {
            const fieldNames = Array.isArray(helper.action.fields)
              ? helper.action.fields.map((f) => (typeof f === "object" ? (f.label || f.key) : f)).join("、")
              : "";
            fillGuide = "\n\n[回填工作流——把 AI 结果直接操作到扩展弹窗表单]\n" +
              "目标：你的结果要直接落在用户打开的弹窗表单里（不是只给 JSON 让用户自己贴），用户肉眼可见、可再改。\n" +
              "步骤：\n" +
              "1. 先调工具 self_ui 扫描当前打开的弹窗，拿到弹窗标题与字段清单（label/selector/type/当前值）——确认弹窗确实开着、字段名与你将输出的一致。注意：self_ui 缺省目标是 AI 主窗口 xxx/ai；若目标弹窗在宿主页/其它页面（不在 AI 主窗口），先用 aiti_bridge_status 或 aiti_page_snapshot 找到宿主页的 pageId 并传给 self_ui 的 pageId 参数。\n" +
              "2. 按用户要求确定各字段的值" + (fieldNames ? "（本弹窗字段：" + fieldNames + "）" : "") + "。\n" +
              "3. 调工具 form_fill 把值填入弹窗表单：fields 传 [{selector 或 label, value}]（能用 label 就用 self_ui 返回的 label，selector 更准就用 selector）；一次填完或分多次都行。\n" +
              "4. 返回里的 filled 表示填成功几个字段；若 missed>0，说明有字段没定位到，再 self_ui 确认实际字段名/选择器后重试。\n" +
              "5. 需要提交时调 form_fill 的 button 参数（如『保存』『确定』）点击，或 page_exec 点按钮。\n" +
              "6. 完成后用 self_ui 或 page_exec 抽查确认值已填入（可选，确保填上了）。\n" +
              "输出格式（务必遵守）：无论工具是否成功，最后一行输出 JSON：{ \"filled\": {\"字段名\": \"实际填入的值\"}, \"note\": \"一两句过程说明（中文）\" }。filled 是真正写入弹窗的字段名→值；若工具链不可用未填入，filled 传空对象 {} 并在 note 说明，让前端用本地回填兜底。不要输出 JSON 代码块之外的无关文本。";
          }
        }
        const promptToAgent = fullMessage + fillGuide;

        // 帮助点预绑（通用契约）：扩展自有帮助点（owner=其他扩展）可能在建会前需要预备资源——
        // 如 aiti-git-review 的预审帮助点需在建会窗口绑定任务（工具只在建会时注入）。
        // POST /api/extensions/<owner>/ai-prebind { cwd }；404/失败静默忽略（不是所有帮助点都需要）。
        if (helper && helper.owner && helper.owner !== "aiti-helper" && !helper.user) {
          try {
            const pbUrl = localOrigin + basePath + "/api/extensions/" + helper.owner + "/ai-prebind";
            const pbResp = await fetch(pbUrl, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ cwd }),
            }).catch(() => null);
            const pb = pbResp ? await pbResp.json().catch(() => null) : null;
            if (pb && pb.ok) console.log("[aiti-helper] ai-prebind ok:", helper.owner, "task=" + (pb.taskId || ""));
          } catch {}
        }

        // ---- Option A：按需开目标扩展的 agent 工具（helper 会话自带）----
        // 帮助点归属扩展（helper.owner = ext.id）→ 在本次 helper 会话里注入其 aiti_* 工具。
        // 用「会话级强制启用」：建会话时传 enableExtTools=[owner]，core 收集时对该扩展无视 feature 门控全部放行。
        // 不改全局 feature 状态（无 features.json 写、无竞态、无失败残留）——纯会话级作用域。
        const enableExtTools = helper && helper.owner
          ? [helper.owner]
          : undefined;

        const apiBase = localOrigin + basePath;
        const fetchUrl = apiBase + "/api/agent/new";
        try {
          // 1) 新建全功能 agent session 并发送 prompt
          const createResp = await fetch(fetchUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              cwd,
              type: "prompt",
              message: promptToAgent,
              ...(enableExtTools?.length ? { enableExtTools } : {}),
              ...(body.modelId ? { modelId: body.modelId, provider: body.provider } : {}),
              ...(sessionCtx.model?.modelId ? { modelId: sessionCtx.model.modelId, provider: sessionCtx.model.provider } : {}),
            }),
          });
          const createText = await createResp.text();
          // ⚠ 此处不再引用裸 referer（作用域内无此变量，server→server 无 referer 调用时会 ReferenceError）
          let createData; try { createData = JSON.parse(createText); } catch { return json({ ok: false, error: "agent/new 返回非 JSON", debug: { fetchUrl, status: createResp.status, refererHeader: req.headers.get("referer") || "", hostHeader: req.headers.get("host") || "", basePath, body: createText.slice(0, 150) } }, 502); }
          if (!createData.success && !createData.sessionId) {
            return json({ ok: false, error: createData.error || "创建 session 失败" }, 500);
          }
          const sessionId = createData.sessionId;

          // 绑定发起方页面为 agent 默认目标页（boundPageId）：agent 调 user_* 交互工具时 pageId 未指定
          // → 桥用 boundPageId 定向到该页面（真实场景 = 发起时所在 AI 主窗口 xxx/ai——交互卡渲染在那、回执也经它回桥，闭环）
          if (body.sourcePageId && sessionId) {
            try {
              const g = globalThis as Record<string, any>;
              const bridges = g.__aitiBridges || {};
              const keys = Object.keys(bridges);
              const b: any = keys.length ? bridges[keys[0]] : null;
              if (b && typeof b.bindAgentPage === "function") b.bindAgentPage("pi-web/" + String(sessionId), String(body.sourcePageId));
            } catch (e) { /* 绑定失败不影响 invoke 主流程 */ }
          }

          // 3) 非阻塞：登记 origin + pendingTurn，立即返回 sessionId（client 订阅总线 helper-<sid> 收进度与结果；
          //    onAgentSettled 到达时写历史 → 发 result 帧（带全文）；/result 仅做快照，不再长等待）
          store.begin(sessionId, {
            message: body.message, helperId: body.helperId ? String(body.helperId) : null,
            placeholder: (body as any).placeholder || null, contextLabel: body.contextLabel || null,
            system: body.system || null, turn: prevTurns.length + 1,
            model: createData.model?.modelId || null, sourceSession: sessionCtx.sessionId || null,
            startedAt: Date.now(),
          });
          audit({ action: "invoke", sessionId, sourceSession: sessionCtx.sessionId || null, model: createData.model?.modelId || null });
          return json({ ok: true, sessionId, model: createData.model }, 202);
        } catch (e) {
          audit({ action: "invoke_error", identity: body.identity || null, error: String(e) });
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // POST /followup { sessionId, message } → 同一 agent 会话 steer 继续（上下文完整延续）
      // 不再新建 session：在同一 agent 会话上 steer/继续（AI 记得前几轮要求与输出）。
      // 关键：不再依赖进程内 steer 句柄（agentSessions）——会话被闲置回收后句柄会丢，旧逻辑会 404→新建会话，
      // 丢掉上下文。改为 POST /api/agent/<id> {type:prompt}：活会话直接续、已回收则 startRpcSession 从持久化
      // 文件重建（onAgentSession 重发→重注册句柄），始终在「原会话」上追问。onAgentSettled 到达时写历史 + 发 result 帧。
      if (p[0] === "followup" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.sessionId || !body.message) return json({ ok: false, error: "需要 sessionId + message" }, 400);
        const sessionId = String(body.sessionId);
        const { apiBase } = resolveApiBase(req);
        try {
          // 轮数：同会话历史里最新一条 +1
          const last = [...history].reverse().find((x) => x.agentSessionId === sessionId);
          const turn = (last?.turn || 1) + 1;
          // 确保 store 有表项（onAgentSettled 写历史/发 result 帧用）。
          //   从历史恢复（表项可能不在：扩展重载/会话已回收后重开）→ 从历史记录补全 origin。
          const existing = store.get(sessionId);
          store.begin(sessionId, existing
            ? { ...existing.origin, message: body.message, contextLabel: body.contextLabel || existing.origin.contextLabel, turn }
            : {
                message: body.message, helperId: last?.helperId || null, placeholder: last?.placeholder || null,
                contextLabel: body.contextLabel || last?.contextLabel || null, system: last?.system || null,
                turn, model: last?.model || null, sourceSession: last?.sourceSession || null, startedAt: Date.now(),
              });
          // 续原会话：POST /api/agent/<id> {type:prompt}——活会话续、回收重建续（不新建）。
          //   streamingBehavior:followUp 防止会话仍流式时报错（排队而非拒）。预检后立返，不阻塞。
          const resp = await fetch(apiBase + "/api/agent/" + encodeURIComponent(sessionId), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "prompt", message: body.message, streamingBehavior: "followUp" }),
          });
          if (resp.status === 404) {
            // 会话文件已删（超 7 天）→ 确实无法续，报错让 client 回退新建
            store.markFailed(sessionId, "原会话已被清理，无法继续追问（请重新生成）");
            return json({ ok: false, error: "原会话已被清理，无法继续追问（请重新生成）", code: "session_gone" }, 404);
          }
          if (!resp.ok) {
            const t = await resp.text().catch(() => "");
            store.markFailed(sessionId, "续原会话失败：" + (t.slice(0, 120) || resp.status));
            return json({ ok: false, error: "续原会话失败：" + (t.slice(0, 120) || resp.status) }, 500);
          }
          audit({ action: "followup", sessionId, turn });
          return json({ ok: true, sessionId, turn, continued: true }, 202);
        } catch (e) {
          store.markFailed(sessionId, e instanceof Error ? e.message : String(e));
          audit({ action: "followup_error", sessionId, error: String(e) });
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // GET /invoke/<id>/result → **快照，永不持连接**（方案 docs/aiti-helper-result-event-bus-plan.md）
      //    结果交付走总线 result 帧；本端点只用于：订阅就绪后对齐、重连/丢帧兜底、重开弹窗恢复、降级。
      //    命中 store → 结果/失败/运行中；未命中 → 回落 history（按 agentSessionId 查最新一条）。
      if (p[0] === "invoke" && p.length === 3 && p[2] === "result" && req.method === "GET") {
        const sessionId = String(p[1]);
        const snap = store.snapshot(sessionId);
        if (snap.ok) return json(snap);
        if (snap.code === "no_result") return json({ ...snap, settled: true });
        if (snap.code === "running") return json({ ...snap, running: true });
        // not_found → history 回落（会话已被回收/扩展重载后重开弹窗）
        const rec = [...history].reverse().find((x) => x.agentSessionId === sessionId);
        if (rec) {
          return json({ ok: true, text: rec.result, historyId: rec.id, turn: rec.turn || 1, settled: true, fromHistory: true });
        }
        return json(snap, 404);
      }

      // GET /active → 列出未结算的 helper 后台会话（client 重开弹窗时提示「N 个后台任务」）
      if (p[0] === "active" && p.length === 1 && req.method === "GET") {
        const list = [];
        for (const { sessionId: sid, entry: a } of store.listActive()) {
          if (a.settled) continue;
          list.push({
            sessionId: sid, message: a.origin.message, helperId: a.origin.helperId || null,
            turn: a.origin.turn, startedAt: a.origin.startedAt,
            sourceSession: a.origin.sourceSession || null, contextLabel: a.origin.contextLabel || null,
          });
        }
        return json({ ok: true, active: list });
      }

      // GET /origin/<id> → 恢复用：返回该会话的发起上下文（从 store 或历史）
      //    client 打开弹窗时若 currentSession.id 命中 → 预填输入/选中帮助点/接回总线监听
      if (p[0] === "origin" && p.length === 2 && req.method === "GET") {
        const sessionId = String(p[1]);
        const a = store.get(sessionId);
        if (a) {
          return json({
            ok: true, sessionId, status: a.settled ? "settled" : "running",
            origin: { message: a.origin.message, helperId: a.origin.helperId || null,
              placeholder: a.origin.placeholder || null, contextLabel: a.origin.contextLabel || null,
              turn: a.origin.turn, model: a.origin.model || null },
            result: a.settled && a.lastResult ? { text: a.lastResult.text, historyId: a.lastResult.historyId } : null,
            failedError: a.failedError || null,
          });
        }
        // 已回收但历史里有：取该会话最新一条
        const rec = [...history].reverse().find((x) => x.agentSessionId === sessionId);
        if (rec) {
          return json({
            ok: true, sessionId, status: "settled",
            origin: { message: rec.message, helperId: rec.helperId || null,
              placeholder: rec.placeholder || null, contextLabel: rec.contextLabel || null,
              turn: rec.turn || 1, model: rec.model || null },
            result: { text: rec.result, historyId: rec.id },
          });
        }
        return json({ ok: false, code: "not_found" }, 404);
      }

      // GET /health
      if (p[0] === "health" && p.length === 1) {
        return json({ ok: true, helpers: [...helpers.keys()], active: store.listActive().length });
      }

      // POST /helpers → 注册帮助点（扩展声明完整 helper：id/title/summary/system/action）
      if (p[0] === "helpers" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.id || !body.title) return json({ ok: false, error: "需要 id + title" }, 400);
        const h = { id: String(body.id), title: String(body.title), summary: body.summary ? String(body.summary) : undefined, system: body.system ? String(body.system) : undefined, action: body.action || undefined };
        helpers.set(h.id, h);
        audit({ action: "helper_register", id: h.id, hasAction: !!h.action });
        return json({ ok: true, helper: h }, 201);
      }
      // GET /helpers → 主动聚合所有扩展声明的 ai.skills（扩展只需声明，无需注册）
      if (p[0] === "helpers" && p.length === 1 && req.method === "GET") {
        collectHelpers();
        return json({ ok: true, helpers: [...helpers.values()] });
      }

      // GET /skill/<id> → 查看某帮助点（skill）的说明：返回 frontmatter 元数据 + SKILL.md 正文
      if (p[0] === "skill" && p.length === 2 && req.method === "GET") {
        collectHelpers();
        const id = String(p[1]);
        const helper = helpers.get(id);
        if (!helper) return json({ ok: false, error: "帮助点不存在: " + id }, 404);
        let body = ""; let meta: Record<string, any> = {};
        try {
          if (helper.skillPath && existsSync(helper.skillPath)) {
            const fm = parseSkillFrontmatter(readFileSync(helper.skillPath, "utf8"));
            meta = fm.meta || {}; body = fm.body;
          }
        } catch (e) { console.warn("[aiti-helper] 读 SKILL.md 失败:", id, (e as Error).message); }
        return json({ ok: true, helper: { id: helper.id, title: helper.title, summary: helper.summary, placeholder: helper.placeholder, action: helper.action }, meta, body, tools: helper.owner ? (extTools.get(helper.owner) || null) : null });
      }

      // ---- 用户自定义 skills（data 目录维护；用户自己给扩展加 skill） ----
      // GET /user-skills → 列表（含 owner 归属扩展；不指定归 aiti-helper）
      if (p[0] === "user-skills" && p.length === 1 && req.method === "GET") {
        if (!userSkillsLoaded) loadUserSkills();
        return json({ ok: true, skills: [...userSkills.values()].sort((a, b) => b.updatedAt - a.updatedAt) });
      }
      // POST /user-skills → 新建 { name, owner?, title?, summary?, body? }
      if (p[0] === "user-skills" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const name = body && body.name ? String(body.name).trim() : "";
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return json({ ok: false, error: "skill 名必须为字母/数字/下划线/连字符" }, 400);
        if (!userSkillsLoaded) loadUserSkills();
        if (userSkills.has(name)) return json({ ok: false, error: "同名 skill 已存在: " + name }, 409);
        const owner = body.owner && String(body.owner).trim() ? String(body.owner).trim() : "aiti-helper";
        const title = body.title && String(body.title).trim() ? String(body.title).trim() : name;
        const summary = body.summary ? String(body.summary) : undefined;
        const skillBody = body.body ? String(body.body) : "";
        const at = Date.now();
        const dir = join(userSkillsDir(), name);
        mkdirSync(dir, { recursive: true });
        const meta = { name, title, summary: summary || undefined };
        const yaml = Object.entries(meta).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
        const content = "---\n" + yaml + "\n---\n\n" + (skillBody || (title + "\n\n（用户自定义 skill，正文待完善——可让 AI 帮你写，见「AI 帮我新增/修改 skill」帮助点）"));
        writeFileSync(join(dir, "SKILL.md"), content);
        userSkills.set(name, { id: name, name, owner, title, summary, at, updatedAt: at });
        saveUserSkillsIndex();
        collectHelpers();
        audit({ action: "user_skill_create", name, owner });
        return json({ ok: true, skill: userSkills.get(name) }, 201);
      }
      // PUT /user-skills/<name> → 修改 { title?, summary?, body?, owner? }
      if (p[0] === "user-skills" && p.length === 2 && req.method === "PUT") {
        const name = String(p[1]);
        const s = userSkills.get(name);
        if (!s) return json({ ok: false, error: "skill 不存在: " + name }, 404);
        const body = await req.json().catch(() => null) || {};
        if (body.owner && String(body.owner).trim()) s.owner = String(body.owner).trim();
        if (body.title && String(body.title).trim()) s.title = String(body.title).trim();
        if (body.summary !== undefined) s.summary = body.summary ? String(body.summary) : undefined;
        s.updatedAt = Date.now();
        const dir = join(userSkillsDir(), name);
        let fm: { meta: Record<string, any>; body: string } = { meta: { name, title: s.title, summary: s.summary }, body: "" };
        try { if (existsSync(join(dir, "SKILL.md"))) fm = parseSkillFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8")); } catch {}
        const yaml = Object.entries({ name, title: s.title, summary: s.summary || undefined }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
        writeFileSync(join(dir, "SKILL.md"), "---\n" + yaml + "\n---\n\n" + (body.body !== undefined ? String(body.body) : fm.body));
        saveUserSkillsIndex();
        collectHelpers();
        audit({ action: "user_skill_update", name });
        return json({ ok: true, skill: s });
      }
      // DELETE /user-skills/<name> → 删除
      if (p[0] === "user-skills" && p.length === 2 && req.method === "DELETE") {
        const name = String(p[1]);
        if (!userSkills.has(name)) return json({ ok: false, error: "skill 不存在: " + name }, 404);
        userSkills.delete(name);
        try { rmSync(join(userSkillsDir(), name), { recursive: true, force: true }); } catch {}
        saveUserSkillsIndex();
        collectHelpers();
        audit({ action: "user_skill_delete", name });
        return json({ ok: true });
      }

      // GET /history?limit=<n> → invoke 历史（最新在前；含结果，可恢复/补落地）
      if (p[0] === "history" && p.length === 1 && req.method === "GET") {
        const limit = Math.min(Math.max(parseInt(String(ctx.searchParams.get("limit") || "50"), 10) || 50, 1), 200);
        return json({ ok: true, history: [...history].reverse().slice(0, limit) });
      }
      // POST /history/<id>/land → 标记已落地（client 补落地后回调；detail 为落地摘要）
      if (p[0] === "history" && p.length === 3 && p[2] === "land" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const h = touchHistory(String(p[1]), { landed: true, landDetail: body && body.detail ? String(body.detail) : null });
        if (!h) return json({ ok: false, error: "历史不存在: " + p[1] }, 404);
        audit({ action: "history_land", id: h.id });
        return json({ ok: true, history: h });
      }
      // DELETE /history → 清空历史
      if (p[0] === "history" && p.length === 1 && req.method === "DELETE") {
        history.length = 0;
        try { writeFileSync(historyFile, ""); } catch {}
        return json({ ok: true });
      }

      return json({ ok: false, error: "not found" }, 404);
    },

    async middleware() {
      return { handled: false };
    },

    agent: {
      /** 会话启动：记录 steer 句柄 + 建立总线流式进度订阅（helper-<sid> 帧，方案 §3.1） */
      onAgentSession(info: { sessionId: string; steer: (t: string) => Promise<void> } & Record<string, any>) {
        agentSessions.set(info.sessionId, { steer: info.steer });
        // 总线订阅：进程内全量 agent 事件 → 投影 publish。旧订阅先退（wrapper 重建重发场景）。
        const prev = agentSubs.get(info.sessionId);
        if (prev) { try { prev(); } catch { /* ignore */ } agentSubs.delete(info.sessionId); }
        if (typeof info.subscribeEvent !== "function") {
          // 宿主无 subscribeEvent（旧 pi-web）→ 告知客户端降级（立刻走 /result 等 finalize，无实时进度）
          busPublish("helper-" + info.sessionId, { evt: "unsupported" });
          return;
        }
        try {
          const topic = "helper-" + info.sessionId;
          const off = info.subscribeEvent((event: { type: string } & Record<string, unknown>) => {
            const frame = projectAgentEvent(event);
            if (frame) busPublish(topic, frame);
            // 原始事件流守门（不依赖宿主 dispatch）：agent_start/agent_settled 是 run 真实边界。
            // 宿主对「零产出/失败」轮次不分发 onAgentSettled（无文本）——store 在这里起 3s 宽限，
            // 到点仍未结算 → store 标失败 + onGraceExpire 发 result{ok:false} 帧（不再依赖 /result 长等待）。
            if (event.type === "agent_start") store.onAgentStart(info.sessionId);
            else if (event.type === "agent_settled") store.onAgentSettled(info.sessionId);
          });
          agentSubs.set(info.sessionId, off);
        } catch { /* 订阅失败 = 无实时进度（降级），不影响会话本身 */ }
      },
      /** 会话销毁/回收：发 end 帧 + 退订 + store 收尾
       *  （已结算条目保留供快照恢复；历史已持久化，/origin 回落历史恢复） */
      onAgentSessionEnd(info: { sessionId: string }) {
        busPublish("helper-" + info.sessionId, { evt: "end" });
        const off = agentSubs.get(info.sessionId);
        if (off) { try { off(); } catch { /* ignore */ } agentSubs.delete(info.sessionId); }
        agentSessions.delete(info.sessionId);
        store.endSession(info.sessionId);
      },
      /** agent 一轮执行完（agent_settled）——仅 helper 发起的轮次（pendingTurn）才写历史/发结果帧，
       *  避免用户在 AI 窗口直接聊该 helper 会话时产生伪历史记录 */
      onAgentSettled(info: { sessionId: string; text: string }) {
        if (!store.isPendingHelperTurn(info.sessionId)) return;   // 非 helper 发起 / 已处理过 → 不写
        const a = store.get(info.sessionId)!;
        const text = info.text || "";
        const historyId = "h_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const o = a.origin;
        saveHistory({
          id: historyId, at: Date.now(),
          message: o.message, system: o.system || undefined, contextLabel: o.contextLabel || undefined,
          result: text, model: o.model || null, sourceSession: o.sourceSession || null,
          helperId: o.helperId || null, landed: false,
          turn: o.turn, agentSessionId: info.sessionId, placeholder: o.placeholder || null,
        });
        // 标记结算 + 总线推结果帧（带全文；弹窗直接落地，不再回拉 /result）
        store.markSettled(info.sessionId, text, historyId);
        busPublish("helper-" + info.sessionId, {
          evt: "result", ok: true, turn: o.turn, text, historyId, at: Date.now(),
        });
        audit({ action: "result_published", sessionId: info.sessionId, turn: o.turn, textLen: text.length });
      },
    },
  },
};