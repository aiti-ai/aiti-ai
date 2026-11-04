/**
 * aiti-opencode-agent — 会话后端扩展：OpenCode CLI 专属驱动。
 *
 * 协议：`opencode run -s <sid> --format json <prompt>`（stdout NDJSON part 事件：
 * step_start / text / tool / step_finish，sessionID 随行；实测 1.1.51）。
 * 进程模型：每轮一个单发进程 + `-s` 续接（同 aiti-zcode-agent oneshot 通道）。
 *
 * 冷恢复（2026-09-16，与 aiti-zcode-agent 同语义）：
 *   - cwd 以会话真实 directory 为准（session-manager services.sessions.parseSession
 *     → meta.cwd）——opencode run 的工作目录决定会话归属/权限根，错目录 resume 不成立；
 *   - 历史经 parseSession 种子回填（IndexedMessage → pi 形状），首轮 getMessages 即全量。
 * 本扩展只驱动；会话**读取**的权威实现仍在 session-manager（opencode adapter，勿在他处重写）。
 *
 * v1 能力面（刻意收窄）：核心四件套 + getMessages；模型走 opencode 配置默认（无 setModel /
 * listModels，选择器隐藏）；steer/followUp/图片附件后续项。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// 会话 recycle 共享层（权威源 pi-web-ext/_shared/session-recycle.ts，副本随部署——改动须双向同步）
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
// 冷恢复工具行回放共享口径（权威源 pi-web-ext/_shared/seed-tool.ts；D18 四家归一）
import { createSeedToolReplay } from "@aiti-ai/ext-shared/seed-tool";

// ============================================================================
// 结构化契约（out-of-tree，无宿主导入）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

let hostSvc: any = null; // DI：startup 捕获 ctx.services（session-manager.sessions 消费）

let counter = 0;

/**
 * 跨 provider 模型族上下文窗口表（getContextUsage 换算用；opencode 侧无窗口
 * 元数据，按 modelID 子串猜族）。未命中返回 undefined——调用方保持空轨态
 * （不编数字；tooltip 展示窗口数值可核对）。
 */
export function guessOcContextWindow(modelId?: string): number | undefined {
  if (typeof modelId !== "string" || !modelId) return undefined;
  const m = modelId.toLowerCase();
  if (m.includes("gpt-5")) return 272_000;
  if (m.includes("gpt-4")) return 128_000;
  if (/\bo[134]\b|o[134]-/.test(m)) return 200_000;
  if (m.includes("claude")) return m.includes("[1m]") ? 1_000_000 : 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("deepseek")) return 128_000;
  if (m.includes("kimi")) return 256_000;
  if (m.includes("grok")) return 256_000;
  if (m.includes("glm")) return 200_000;
  if (m.includes("qwen")) return /qwen-long|qwen-turbo/.test(m) ? 1_000_000 : 128_000;
  return undefined;
}

const OC_CAPABILITIES: SessionCapabilitiesLike = {
  steer: false,
  followUp: false, // 每轮一个新进程 + -s，天然顺序；队列原语未接（P2）
  // 上下文用量（2026-09-19）：step_finish tokens（input+cache.read+cache.write）+
  // 机会式捕获 modelID 的族窗口表；模型未捕获/未命中 → getContextUsage 返回
  // undefined（前端空轨态，不编数字）。
  contextUsage: true,
  setModel: false, // 模型走 opencode 配置默认；-m 透传为后续项
  setThinkingLevel: false,
  fork: false,
  renameSession: false,
  compact: false,
  executeBash: false,
  listTools: false,
  setActiveTools: false,
  navigateTree: false,
  deleteSession: false,
  getCommands: false,
  respondPermission: false,
  getUsage: false,
  listModels: false,
  fileAttachments: false, // -f 附件透传为后续项
  getMessages: true,
};

/** opencode CLI 解析：env 显式 > PATH > 官方安装位 ~/.opencode/bin/opencode。 */
function resolveOcBin(): string {
  const env = process.env.OPENCODE_CLI_PATH;
  if (env && existsSync(env)) return env;
  // whichBin：PATH 按平台分隔符切 + PATHEXT 探测 + isFile 过滤（win32 下 `PATH.split(":")`
  // 会把整条 `D:\...\;C:\...` 当成一个畸形目录，永远找不到——lessons §1「外部 CLI 统一走 whichBin」）
  return whichBin("opencode") ?? join(homedir(), ".opencode", "bin", "opencode");
}

/**
 * CLI 派生形态分派：脚本入口（.mjs/.cjs/.js，如测试桩）经 node 直跑（win32 无 shebang
 * 执行能力）；`.cmd/.bat` shim 必须 shell:true（Node ≥18.20 直 spawn 即 EINVAL，lessons §0.1）。
 */
function ocLaunch(bin: string): { cmd: string; prefix: string[]; shell: boolean } {
  if (/\.(?:m|c)?js$/i.test(bin)) return { cmd: process.execPath, prefix: [bin], shell: false };
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin)) return { cmd: bin, prefix: [], shell: true };
  return { cmd: bin, prefix: [], shell: false };
}

/** 字节累积按 \n 切行（加固 A1：跨 chunk 多字节字符安全；单行上限保护）。 */
function lineReader(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void, maxLineBytes = 10 * 1024 * 1024): void {
  if (!stream) return;
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxLineBytes) buffer = buffer.subarray(buffer.length - maxLineBytes); // 恶意超长行截断兜底
    for (;;) {
      const i = buffer.indexOf(0x0a);
      if (i < 0) break;
      const line = buffer.subarray(0, i).toString("utf8");
      buffer = buffer.subarray(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/** stderr 环形缓冲（exit≠0 时落人话错误）。 */
function stderrTail(stream: NodeJS.ReadableStream | null, cap = 8 * 1024): { text(): string } {
  let buf = "";
  stream?.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    if (buf.length > cap) buf = buf.slice(buf.length - cap);
  });
  return { text: () => buf.trim() };
}

interface TurnTool { callID: string; name: string; input?: Record<string, unknown>; output?: string; isError?: boolean }

/** 工具结果进 liveHistory 的文本上限（防内存膨胀；回放展示截断可接受）。 */
const TOOL_OUTPUT_CAP = 8000;

// ============================================================================
// OpencodeHandle — 单发进程驱动的 SessionHandle
// ============================================================================

class OpencodeHandle {
  /** 复合 id（opencode:sess_* / opencode:new-*）；新会话首轮捕获 sid 后换绑。 */
  id: string;
  readonly source = "aiti-opencode-agent/opencode";
  readonly capabilities = OC_CAPABILITIES;
  cwd: string;

  private listeners = new Set<Listener>();
  private liveHistory: Array<Record<string, unknown>> = [];
  private running = false;
  private disposed = false;
  private child: ChildProcess | null = null;
  private abortRequested = false;

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
  }

  private emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) {
      try { l(event); } catch { /* 单个订阅者异常不阻断其余 */ }
    }
  }

  private get sessId(): string {
    return this.id.startsWith("opencode:") && this.id.slice(9).startsWith("ses_") ? this.id.slice(9) : "";
  }

  /** 复活路径：已知真实 sid（不再从事件流捕获换绑）。 */
  setKnownSessionId(sid: string): void {
    if (sid.startsWith("ses_")) this.id = `opencode:${sid}`;
  }

  /** 新会话首轮：从事件流捕获 sid → 换绑复合 id（宿主监听 session_backend_ready 重挂注册表）。 */
  private rebindSessionId(sid: string): void {
    if (!sid.startsWith("ses_") || sid === this.sessId) return;
    const oldId = this.id;
    this.id = `opencode:${sid}`;
    this.emit({ type: "session_backend_ready", oldId, id: this.id });
  }

  /** 历史种子回填（resume 冷恢复；IndexedMessage → pi 形状，zcode seedHistory 同款）。 */
  seedHistory(messages: Array<{ role?: unknown; text?: unknown; model?: unknown; provider?: unknown; tool?: unknown }>): void {
    const replay = createSeedToolReplay("oc-tool");
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const tool = role === "assistant"
        ? replay.entries(m.tool, { model: typeof m.model === "string" && m.model ? m.model : undefined })
        : null;
      if (tool) {
        this.liveHistory.push(...tool);
        continue;
      }
      const text = typeof m.text === "string" ? m.text : "";
      if (!text.trim()) continue;
      this.liveHistory.push({
        role,
        content: [{ type: "text", text }],
        ...(role === "assistant" && typeof m.model === "string" && m.model ? { model: m.model } : {}),
      });
    }
  }

  /** 执行一轮：受理即发 agent_start/prompt_done（spinner 立现），进程退出收口 settled。 */
  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this.running) throw new Error("opencode agent is single-turn: wait for settled");
    this.running = true;
    this.abortRequested = false;

    this.emit({ type: "agent_start" });
    // 契约对齐 pi：受理即发 prompt_done（否则前端 rpcPromptPending 恒 true → spinner 永挂）
    this.emit({ type: "prompt_done" });
    const userMessage = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    this.liveHistory.push(userMessage);
    this.emit({ type: "message_end", message: userMessage });

    try {
      await this.runTurn(text);
    } catch (e) {
      if (!this.abortRequested) {
        this.turnFailed(e instanceof Error ? e.message : String(e));
        return;
      }
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
    } finally {
      this.running = false;
      this.child = null;
    }
  }

  private async runTurn(promptText: string): Promise<void> {
    const sid = this.sessId;
    const args = ["run", "--format", "json", ...(sid ? ["-s", sid] : []), promptText];
    const bin = resolveOcBin();

    // 流式解析态：text part 快照（per-part 前缀差分出 delta；Map 按首现顺序保序）、工具行、末次 tokens
    const seenParts = new Map<string, string>();
    const tools: TurnTool[] = [];
    let lastTokens: Record<string, unknown> | null = null;
    let exitCode: number | null = null;
    let killedByAbort = false;

    await new Promise<void>((resolve, reject) => {
      const launch = ocLaunch(bin);
      const child = spawn(launch.cmd, [...launch.prefix, ...args], {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        shell: launch.shell,
      });
      this.child = child;
      const errTail = stderrTail(child.stderr);
      this.errTailRef = errTail;
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      child.on("error", (err) => done(() => reject(err)));
      child.on("close", (code) => {
        exitCode = code;
        if (this.abortRequested) killedByAbort = true;
        done(() => resolve());
      });

      lineReader(child.stdout, (line) => {
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        // 新会话：任一事件携带 sessionID → 换绑（只发生一次）
        if (typeof ev.sessionID === "string") this.rebindSessionId(ev.sessionID);
        const part = (ev.part ?? {}) as Record<string, unknown>;
        // 机会式捕获模型 id（assistant part.modelID 随行；getContextUsage 窗口族判据）
        if (typeof part.modelID === "string" && part.modelID) this.lastModelId = part.modelID;
        if (ev.type === "text" && typeof part.text === "string" && part.text) {
          const pid = typeof part.id === "string" ? part.id : `p${seenParts.size}`;
          const prev = seenParts.get(pid);
          const snap = part.text;
          // 快照语义：增长 → 前缀差分；异常替换 → 全量重发（可接受的极端兜底）
          const delta = prev !== undefined && snap.startsWith(prev) ? snap.slice(prev.length) : snap;
          seenParts.set(pid, snap);
          if (delta) this.emit({ type: "message_update", delta });
        } else if (ev.type === "tool") {
          const name = typeof part.tool === "string" ? part.tool : "tool";
          const state = (part.state ?? {}) as Record<string, unknown>;
          const input = state.input && typeof state.input === "object" ? state.input as Record<string, unknown> : undefined;
          const rawOutput = typeof state.output === "string" ? state.output : undefined;
          tools.push({
            callID: typeof part.callID === "string" && part.callID ? part.callID : `oc-tool-${tools.length + 1}`,
            name,
            ...(input ? { input } : {}),
            ...(rawOutput !== undefined ? { output: rawOutput.slice(0, TOOL_OUTPUT_CAP) } : {}),
            ...(state.status === "error" ? { isError: true } : {}),
          });
        } else if (ev.type === "step_finish") {
          const tokens = part.tokens;
          if (tokens && typeof tokens === "object") {
            lastTokens = tokens as Record<string, unknown>;
            // 逐轮累计（getUsageTotals 数据源）：input / cache.read / cache.write 分开记，
            // reasoning 不记（AI SDK 口径下 ⊆ output，避免双计）
            const t = tokens as Record<string, any>;
            const cache = (t.cache ?? {}) as Record<string, unknown>;
            const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
            this.usageTotals.inputTokens += n(t.input);
            this.usageTotals.outputTokens += n(t.output);
            this.usageTotals.cacheReadTokens += n(cache.read);
            this.usageTotals.cacheWriteTokens += n(cache.write);
            this.usageTotals.turns += 1;
          }
        }
      });
    });

    if (killedByAbort) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    if (exitCode !== 0) {
      const tail = this.errTailRef?.text() ?? "";
      throw new Error(tail
        ? `opencode CLI 异常退出（code=${exitCode}）：${tail.slice(-400)}`
        : `opencode CLI 异常退出（code=${exitCode}）`);
    }

    // 收口：文本 part 按 Map 首现顺序 join；assistant（text+toolCall）+ toolResult 落 liveHistory
    const text = [...seenParts.values()].filter((t) => t.trim()).join("\n\n");
    const content: Array<Record<string, unknown>> = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const t of tools) {
      content.push({ type: "toolCall", toolCallId: t.callID, toolName: t.name, input: t.input ?? {} });
    }
    if (content.length > 0) {
      this.liveHistory.push({ role: "assistant", content });
      for (const t of tools) {
        if (t.output === undefined) continue;
        this.liveHistory.push({
          role: "toolResult",
          toolCallId: t.callID,
          toolName: t.name,
          content: [{ type: "text", text: t.output }],
          ...(t.isError ? { isError: true } : {}),
        });
      }
    }
    this.lastUsage = lastTokens as OpencodeHandle["lastUsage"];
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", stopReason: "end_turn" });
  }

  private errTailRef: { text(): string } | null = null;
  private lastUsage: Record<string, unknown> | null = null;
  /** 机会式捕获的模型 id（assistant part.modelID；getContextUsage 窗口族判据） */
  private lastModelId: string | undefined;
  /** 会话累计用量（本 handle 存活期逐轮累加；getUsageTotals 数据源，进程重启归零） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };

  /**
   * @capability contextUsage —— 当前上下文占用（最近 step_finish：input+cache.read+
   * cache.write；opencode/AI SDK 口径 input 不含 cache，三项相加即发往模型的全量）。
   * 无 token 帧、全零、或模型 id 未捕获/未命中窗口表 → undefined（空轨态，不编数字）。
   */
  getContextUsage(): { percent: number; contextWindow: number; tokens: number } | undefined {
    const t = this.lastUsage as Record<string, any> | null;
    if (!t || typeof t !== "object") return undefined;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cache = (t.cache ?? {}) as Record<string, unknown>;
    const tokens = n(t.input) + n(cache.read) + n(cache.write);
    if (!(tokens > 0)) return undefined;
    const contextWindow = guessOcContextWindow(this.lastModelId);
    if (!contextWindow) return undefined;
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }

  /** @capability getUsageTotals —— 会话累计（宿主 get_session_stats 真实口径）。 */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  private turnFailed(errMsg: string): void {
    const errorMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: errMsg,
    };
    this.liveHistory.push(errorMessage);
    this.emit({ type: "message_end", message: errorMessage });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled_error", error: errMsg });
    this.emit({ type: "agent_settled", stopReason: "error", error: errMsg });
  }

  async abort(): Promise<void> {
    if (!this.running) return;
    this.abortRequested = true;
    const child = this.child;
    if (child?.pid) {
      try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
      setTimeout(() => {
        try { if (child.pid && !child.killed) child.kill("SIGKILL"); } catch { /* 已退出 */ }
      }, 5000).unref();
    } else {
      // 无进程可杀（极端窗口）：直接收口，防 spinner 永挂
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      this.running = false;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.child?.pid) {
      try { this.child.kill("SIGTERM"); } catch { /* 已退出 */ }
    }
    this.listeners.clear();
  }

  alive(): boolean {
    return !this.disposed;
  }

  isRunning(): boolean {
    return this.running;
  }

  getModel(): undefined {
    return undefined; // setModel=false：模型由 opencode 配置决定，选择器隐藏
  }

  async getMessages(): Promise<unknown[]> {
    return [...this.liveHistory];
  }
}

// ============================================================================
// 冷恢复（cwd/历史）+ Extension entry
// ============================================================================

/** 会话 recycle（D8，共享层 session-recycle.ts）：存量 OpencodeHandle 升级到当前扩展代码。 */
const recycleApi = createSessionRecycleApi({
  isOwn: (h) => h.id.startsWith("opencode:"),
  parseId: (id) => {
    if (!id.startsWith("opencode:")) return null;
    return { sessionId: id.slice("opencode:".length), providerType: "aiti-opencode-agent/opencode" };
  },
});

/** All Sessions 服务出口读取（唯一权威实现 = session-manager AgentAdapter 实时 parse）。
 *  与 createOpencodeSession 冷恢复共用同一出口；缺席 fail-silent。 */
function parseSessionSvc(sid: string): Promise<{ meta?: Record<string, unknown>; messages?: unknown[] } | null> {
  const reg = (globalThis as any).__piWebExt;
  const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
  return typeof svc?.parseSession === "function" ? svc.parseSession(`opencode:${sid}`) : Promise.resolve(null);
}

async function createOpencodeSession(
  options: { sessionId?: string; cwd?: string },
): Promise<OpencodeHandle> {
  const rawSid = options.sessionId ?? "";
  // All Sessions 历史行复活：composite id "opencode:ses_xxx" → sid 即真实 opencode 会话 id
  const isRealSid = rawSid.startsWith("ses_");
  const id = rawSid ? `opencode:${rawSid}` : `opencode:new-${++counter}-${Date.now()}`;

  // 冷恢复先读 opencode 会话存储：cwd 必须以会话原 directory 为准（run 的工作目录决定
  // 会话归属/权限根）；URL ?session= 恢复路径的 options.cwd 常为空 → 不能落 process.cwd()。
  let restoredParsed: { meta?: Record<string, unknown>; messages?: unknown[] } | null = null;
  if (isRealSid) {
    try { restoredParsed = await parseSessionSvc(rawSid); } catch { /* 回放失败不阻断接管（fail-silent） */ }
  }
  const restoredCwd = typeof restoredParsed?.meta?.cwd === "string" && restoredParsed.meta.cwd.trim()
    ? restoredParsed.meta.cwd.trim()
    : "";
  const handle = new OpencodeHandle(id, restoredCwd || options.cwd || process.cwd());
  if (isRealSid) {
    handle.setKnownSessionId(rawSid);
    if (restoredParsed?.messages?.length) handle.seedHistory(restoredParsed.messages as never[]);
  }
  return handle;
}

export default {
  id: "aiti-opencode-agent",
  name: "OpenCode (resume)",
  version: "0.1.0",
  icon: "🟠",

  server: {
    startup(ctx: {
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          createSession(options: { sessionId?: string; cwd?: string }): Promise<OpencodeHandle>;
        }): string;
      };
      services?: {
        provide<T>(key: string, impl: T): () => void;
        get?(name: string): unknown;
      };
    }) {
      hostSvc = (ctx as { services?: { get?(name: string): unknown } }).services ?? null;
      const bin = resolveOcBin();
      if (!existsSync(bin)) {
        console.log("[aiti-opencode-agent] opencode CLI 未找到（PATH / ~/.opencode/bin），provider 不注册");
        return;
      }
      const key = ctx.sessionProviders.register({
        type: "opencode",
        label: "OpenCode",
        agentKey: "opencode",
        priority: 10,
        maxCapabilities: OC_CAPABILITIES,
        createSession: (options) => createOpencodeSession(options),
      });
      console.log(`[aiti-opencode-agent] session provider registered: ${key} (bin=${bin})`);
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用
      ctx.services?.provide?.("aiti-opencode-agent.agent", {
        agent: "opencode",
        label: "OpenCode",
        modes: ["url"],
        accountQuota: false,
        dependencyHint: "opencode CLI（curl -fsSL https://opencode.ai/install | bash）",
        auth: [
          { kind: "file", path: [".local", "share", "opencode", "auth.json"], label: "~/.local/share/opencode/auth.json" },
        ],
      });
    },

    /** 会话 recycle API（/session/recycle）。 */
    async api(req: Request, ctx: { path: string[]; method: string }) {
      return recycleApi(req, ctx);
    },
  },
};
