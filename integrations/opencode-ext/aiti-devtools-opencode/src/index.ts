/**
 * @aiti-ai/aiti-devtools-opencode · OpenCode 宿主 adapter（opencode 插件）
 *
 * 形态：单文件插件（dist/aiti-devtools-opencode.js），放 ~/.config/opencode/plugins/ 或项目 .opencode/plugins/
 *       由 opencode 启动时自动加载；@opencode-ai/plugin 运行时由宿主解析（external），其余全打包。
 *
 * 职责（对齐 pi-web 方案 M / DSH Cordis 插件）：
 *   1. 连独立桥（AgentBridgeClient，默认 http://127.0.0.1:8777/aiti，AITI_BRIDGE_URL 可覆盖）
 *   2. 桥 MCP tools/list 拉工具清单 → JSON Schema→Zod → tool() 进程内注册 16 个 aiti_*（不走 MCP）
 *   3. 会话接线：首次工具调用惰性 register + SSE 流；桥推送 → client.session.prompt 注入模型；
 *      session.idle 事件 → 取最后 assistant 文本 → bridge.answer 回桥
 *   4. 桥不可达时不拖垮 opencode：插件静默降级（工具报「桥不可达」），不影响其他工具
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { AgentBridgeClient, wrapToolResult, type BridgeTool } from "@aiti-ai/aiti-devtools-agent";
import { registerAitiShim, resolveShimPathAuto, rewriteMessage } from "@aiti-ai/aiti-devtools-core";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 宿主 zod 实例（@opencode-ai/plugin 的 tool.schema 就是 opencode 内部的 zod v4）。
 *  ⚠ 不能自己 bundle zod：双实例会让 opencode 的 zod→JSON Schema 转换崩溃（schema._zod.def undefined）。 */
const z = tool.schema;
type ZodTypeAny = ReturnType<(typeof tool.schema)["string"]>;
type ZodRawShape = Parameters<(typeof tool.schema)["object"]>[0];

// ---- 配置 ----
const BRIDGE_BASE = (process.env.AITI_BRIDGE_URL || "http://127.0.0.1:8777").replace(/\/+$/, "") + "/aiti";
const AGENT_ID = "opencode";
const PREFIX = "aiti_";
const DESCRIPTION_SUFFIX = "（aiti-devtools 直连，OpenCode 会话）";

// ---- JSON Schema → Zod（覆盖桥 16 工具的实际形状：string/number/boolean/object/array(object) + description/required）----
function schemaToZod(s: unknown): ZodTypeAny {
  const sch = (s || {}) as Record<string, any>;
  const d = (zod: ZodTypeAny) => (typeof sch.description === "string" && sch.description ? zod.describe(sch.description) : zod);
  switch (sch.type) {
    case "string": return d(z.string());
    case "number": return d(z.number());
    case "boolean": return d(z.boolean());
    case "object": {
      if (sch.properties && typeof sch.properties === "object") {
        const shape: ZodRawShape = {};
        const req = new Set(Array.isArray(sch.required) ? sch.required : []);
        for (const [k, v] of Object.entries(sch.properties)) {
          shape[k] = req.has(k) ? schemaToZod(v) : schemaToZod(v).optional();
        }
        return d(z.object(shape));
      }
      return d(z.record(z.string(), z.any())); // 自由对象（如 page_exec 的 args）
    }
    case "array": return d(z.array(schemaToZod(sch.items)));
    default: return z.any();
  }
}

function schemaToShape(schema: Record<string, unknown>): ZodRawShape {
  const out: ZodRawShape = {};
  const props = (schema?.properties || {}) as Record<string, unknown>;
  const req = new Set(Array.isArray(schema?.required as unknown) ? (schema.required as string[]) : []);
  for (const [k, v] of Object.entries(props)) {
    out[k] = req.has(k) ? schemaToZod(v) : schemaToZod(v).optional();
  }
  return out;
}

// ---- 桥工具清单：stateless MCP POST /mcp tools/list（桥 case "tools/list" 无需 initialize）----
async function fetchBridgeTools(base: string): Promise<BridgeTool[]> {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  const tools = (body as any)?.result?.tools;
  return Array.isArray(tools) ? tools : [];
}

// ---- 启动自注册（统一行为：opencode 新启动即带 aiti MCP 工具，env AITI_BRIDGE_URL 指桥）----
// 委托 core resolveShimPathAuto + registerAitiShim（仅写已存在的 opencode.json；任何失败静默跳过）。

function autoRegisterShimInline(): void {
  try {
    // 复用 core 解析（0.3.7：安装态 ~/.pi/web*/node_modules 优先，仓库检出兜底）与注册
    // （opencode 目标条目 = type local + command 数组 + enabled + environment 版本标记，幂等 + 版本守卫）。
    // 不再内联旧解析——旧版只认仓库检出路径，会把已安装态化的条目改回去。
    const found = resolveShimPathAuto();
    if (!found) return;
    const cfgPath = join(homedir(), ".config", "opencode", "opencode.json");
    if (!existsSync(cfgPath)) return; // 无配置不新建（用户装过 opencode 配置才注册）
    registerAitiShim({ shimPath: found.shimPath, version: found.version, configPaths: [cfgPath], log: () => {} });
  } catch {} // 最佳努力：绝不影响插件加载
}

export const AitiDevtoolsPlugin: Plugin = async (input) => {
  const { client, directory: ctxDirectory } = input;
  autoRegisterShimInline();
  const bridge = new AgentBridgeClient(BRIDGE_BASE);
  const log = (msg: string) => { void client.app.log({ body: { service: "aiti-devtools-opencode", level: "info", message: msg } }).catch(() => {}); };

  // ---- 会话接线：sessionID → { agentKey, cwd, stopStream } ----
  interface Sess { agentKey: string; cwd: string; stopStream: () => void }
  const sessions = new Map<string, Sess>();

  async function registerAndStream(sessionID: string, directory: string): Promise<Sess | null> {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const reg = await bridge.register({
      agentId: AGENT_ID,
      sessionId: sessionID,
      name: "OpenCode",
      cwd: directory,
      source: "plugin",
      subEvents: ["page_error"],
    });
    if (!reg || !reg.agentKey) return null;
    const sess: Sess = { agentKey: reg.agentKey, cwd: directory, stopStream: () => {} };
    sessions.set(sessionID, sess);
    // SSE 持久流：桥推送（人发消息/页面事件）→ 注入 session（模型立即看到并行动）
    sess.stopStream = bridge.connectAgentStream(
      async () => {
        const r = await bridge.register({ agentId: AGENT_ID, sessionId: sessionID, name: "OpenCode", cwd: directory, source: "plugin", subEvents: ["page_error"] });
        return r?.agentKey ?? null;
      },
      (m) => {
        const text = (typeof m.text === "string" && m.text) || (m.payload && typeof m.payload.text === "string" ? m.payload.text : "") || JSON.stringify(m);
        log("push → session.prompt: " + text.slice(0, 80));
        void client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }).catch((e: unknown) => {
          log("session.prompt failed: " + (e instanceof Error ? e.message : String(e)));
        });
      },
    );
    log("session registered: " + sessionID + " (cwd " + directory + ")");
    return sess;
  }

  // ---- 拉工具清单并注册 ----
  const bridgeTools = await fetchBridgeTools(BRIDGE_BASE);
  const hooks: Hooks = { event: undefined, tool: {} };

  if (!bridgeTools.length) {
    // 桥未启动：注册两个占位探测工具（模型可见、调用时给出清晰指引），不拖垮 opencode
    log("bridge not reachable at " + BRIDGE_BASE + " — placeholder tools registered");
    const errText = "桥不可达：" + BRIDGE_BASE + "。请先启动独立桥：node ~/workspace/pi-work/packages/aiti-bridge/bin/aiti-bridge.mjs（默认 127.0.0.1:8777），然后重启 opencode。";
    hooks.tool = {
      [PREFIX + "bridge_status"]: tool({
        description: "查询 aiti-devtools 已连接页面（sessions/pageId/url/title）。当前桥未启动。" + DESCRIPTION_SUFFIX,
        args: {},
        async execute() { return errText; },
      }),
      [PREFIX + "page_exec"]: tool({
        description: "在已连接页面执行类 CDP 命令。当前桥未启动。" + DESCRIPTION_SUFFIX,
        args: { cmd: z.string().describe("CDP 命令，如 Runtime.evaluate"), args: z.record(z.string(), z.any()).optional() },
        async execute() { return errText; },
      }),
    };
    return hooks;
  }

  for (const t of bridgeTools) {
    hooks.tool![PREFIX + t.name] = tool({
      description: (t.description || t.name) + DESCRIPTION_SUFFIX,
      args: schemaToShape(t.inputSchema || { type: "object", properties: {} }),
      async execute(args, ctx) {
        const sess = await registerAndStream(ctx.sessionID, ctx.directory);
        if (!sess) return "桥注册失败：" + BRIDGE_BASE + "（桥可能刚重启，重试即可）";
        const r = await bridge.callTool(
          t.name,
          (args || {}) as Record<string, unknown>,
          { agentId: AGENT_ID, sessionId: ctx.sessionID, cwd: ctx.directory, cancelId: ctx.callID },
          ctx.abort,
        );
        const wrapped = wrapToolResult(r);
        return wrapped.content[0]?.text ?? JSON.stringify(wrapped);
      },
    });
  }
  log("registered " + bridgeTools.length + " aiti_* tools from " + BRIDGE_BASE);

  // ---- 事件接线：session.idle → 回答回桥（消息流落盘供 AI 窗展示）----
  hooks.event = async ({ event }) => {
    if (event.type === "session.idle") {
      const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID;
      const sess = sessionID ? sessions.get(sessionID) : null;
      if (!sess) return;
      try {
        const res = await client.session.messages({ path: { id: sessionID } });
        const msgs = res.data ?? [];
        const last = [...msgs].reverse().find((m) => m.info.role === "assistant");
        const text = (last?.parts ?? []).filter((p) => p.type === "text").map((p: any) => p.text).join("\n").trim();
        if (text) await bridge.answer(sess.agentKey, text);
      } catch { /* 回答失败不影响会话 */ }
    }
  };

  // ---- 主动注册：用户在会话发第一条消息即注册 + SSE（不等首次工具调用，桥推送随时可达）----
  hooks["chat.message"] = async (input) => {
    const sessionID = input.sessionID;
    if (sessionID && !sessions.has(sessionID)) {
      void registerAndStream(sessionID, input.directory || ctxDirectory).catch(() => {});
    }
  };

  // ---- 占位符改写（发送方式无关）：experimental.chat.messages.transform 在消息进 LLM 前回调，
  //     把用户消息里的 [元素N]/[回答N]/[错误N] 替换成完整 describe + [发自: pageId · url]，
  //     改写算法 = core send-rewrite 公共库（与 pi-web preSend / DSH agent/pre-step 逐条对齐）。
  //     候选数据来源 = AI 窗（opencode web UI 注入的 aiti-client-opencode.js）POST /bridge/picked。
  //     替换成功 → POST /bridge/ai/event {event:'aiti_consumed'} → AI 窗清候选（权威信号携 tags）。----
  const PLACEHOLDER_EXISTS = /\[(?:元素|回答|错误|选择)\d+\]/;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function fetchPicked(): Promise<Array<{ tag: string; describe: string; pageId?: string }>> {
    try {
      const res = await fetch(BRIDGE_BASE + "/bridge/picked", { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const b = await res.json().catch(() => null);
      return Array.isArray(b?.candidates) ? b.candidates : [];
    } catch { return []; }
  }
  hooks["experimental.chat.messages.transform"] = async (_input, output) => {
    const msgs = output.messages || [];
    if (!msgs.length) return;
    // 是否含占位符（只有含占位符才拉候选；纯文本发自分支看 picked 非空）
    const hasTag = msgs.some((m) => m?.info?.role === "user" && (m.parts || []).some((p: any) => p?.type === "text" && PLACEHOLDER_EXISTS.test(String(p.text || ""))));
    if (!hasTag) return; // 纯文本发自：桥 pushToAgents 已给推送消息拼 [发自:]；本钩子只管占位符替换
    // 竞态兑底：AI 窗上报 150ms 防抖+POST 在途 → 轮询等待（≤800ms）
    let picked: Array<{ tag: string; describe: string; pageId?: string }> = [];
    for (let i = 0; i < 9; i++) { picked = await fetchPicked(); if (picked.length) break; await sleep(100); }
    const pid = picked.find((c) => c.pageId)?.pageId || null;
    let pageUrl: string | null = null;
    if (pid) {
      try {
        const res = await fetch(BRIDGE_BASE + "/bridge/sessions", { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const rows = await res.json().catch(() => []);
          pageUrl = (Array.isArray(rows) ? rows : []).find((r: any) => r?.pageId === pid)?.url || null;
        }
      } catch { /* sessions 不可用：发自退化为无 URL（pid 仍有效） */ }
    }
    const cands: RewriteCandidate[] = picked.map((c) => ({ tag: c.tag, describe: c.describe, pageId: c.pageId }));
    const rwOpts = { pid, pageUrl };
    const usedTagsAll: string[] = [];
    // ⚠ 只改写【最后一条 user 消息】：transform 每轮都会跑，历史 user 消息里的旧占位符
    //   （会话存储保留原文）若被孤儿兑底/再次展开，会每轮污染 LLM 输入的历史上下文。
    // ⚠ 1.1.x 官方实现（prompt.ts:601）传给钩子的是 sessionMessages 数组本体，处理后直接用原引用构建模型消息
    //   （processor.process({ messages: MessageV2.toModelMessages(sessionMessages …) }))。
    //   所以必须【原地修改】：不能替换 output.messages 数组/元素对象（新引用会被丢弃），只改 part.text 本身。
    let lastUser: (typeof msgs)[number] | null = null;
    for (const m of msgs) {
      if (m && m.info?.role === "user" && Array.isArray(m.parts)) lastUser = m; // 不 break：取最后一条
    }
    if (!lastUser) return;
    for (const p of lastUser.parts) {
      if (!p || p.type !== "text" || typeof (p as any).text !== "string" || !(p as any).text) continue;
      if (!PLACEHOLDER_EXISTS.test((p as any).text)) continue;
      const r = rewriteMessage((p as any).text, cands, rwOpts);
      if (r.text === (p as any).text) continue;
      (p as any).text = r.text; // 原位改写（仅本轮 LLM 输入；会话存储保留原占位符）
      if (r.usedAny) usedTagsAll.push(...r.usedTags);
    }
    // 替换成功（消费了占位符）→ 推 aiti_consumed → AI 窗清候选（REST 触发桥 pushAiEvent）
    const used = [...new Set(usedTagsAll)];
    if (used.length) {
      log("placeholder consumed: " + used.join(","));
      void fetch(BRIDGE_BASE + "/bridge/ai/event", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(4000),
        body: JSON.stringify({ event: "aiti_consumed", payload: { tags: used, pid, at: Date.now() } }),
      }).catch(() => {});
    }
  };

  return hooks;
};

export default AitiDevtoolsPlugin;
