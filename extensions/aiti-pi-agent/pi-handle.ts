/**
 * pi-handle.ts — pi fork 的 SessionHandle 实现（aiti-pi-agent 专一后端）。
 *
 * 拆分自旧 pi-rpc-spawn.ts 的 PCliSpawnHandle（PiForkSpec 参数化同时承载 pi/omp）。
 * 现 pi 与 omp 各自独立 handle：本文件只保留 pi 语义（get_entries / fork / get_commands /
 * 无 ready 握手 / 无 contextUsage·dumpTools / 无 host tools / 无 login）。
 * 线协议载体无关层（RpcChildHost / extension_ui 桥接 / CLI 解析 / spawn env / 治理 env）
 * 来自共享层 fork-rpc/（副本同步自 _shared/pi-fork-rpc，见 scripts/sync-pi-fork-rpc.mjs）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { RpcChildHost, toInteractionRequest, toExtensionUIResponse, UI_METHODS_NEEDING_ANSWER, shutdownChild, RPC_CTRL_TIMEOUT_MS, type ExtensionUIRequest } from "./fork-rpc/wire.ts";
// 远端 pi 协议队列 queueManage 适配（共享层 _shared/pi-fork-rpc/remote-queue.ts，副本随扩展部署——改动须双向同步）
import { createRemotePiQueueSupport } from "./fork-rpc/remote-queue.ts";
import { capabilitiesFor, type PiForkCommands, type PiForkSpec } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";
import { agentSpawnEnv, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { governanceEnv } from "./external-governance.ts";

// ============================================================================
// 上下文用量（pi RPC 线协议无 contextUsage 命令字段——从会话文件自行换算，语义对齐
// pi 本地 runtime getContextUsage：tokens = usage.totalTokens || 四项和；跳过
// aborted/error/全零 assistant；压缩边界后无新 usage → tokens/percent null。窗口
// 来自 get_state.data.model.contextWindow，会话文件路径来自 get_state.data.sessionFile。）
// ============================================================================

/** pi 语义 tokens：totalTokens 优先，缺省回退四项和（照抄 pi compaction.calculateContextTokens）。 */
function piContextTokens(usage: Record<string, unknown>): number {
  const t = typeof usage.totalTokens === "number" && usage.totalTokens > 0 ? usage.totalTokens : 0;
  if (t > 0) return t;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(usage.input) + n(usage.output) + n(usage.cacheRead) + n(usage.cacheWrite);
}

/**
 * 从 pi 会话 jsonl 行倒序挑最近有效 assistant usage → contextUsage 契约。
 * 返回 null = 先碰到压缩边界（压缩后无新 usage，pi 语义 tokens 未知）；
 * undefined = 窗口内既无有效 assistant 也无压缩边界（文件过新/窗口太小，不编数据）。
 */
export function pickContextUsageFromLines(
  lines: string[],
  contextWindow: number,
): { percent: number | null; contextWindow: number; tokens: number | null } | null | undefined {
  if (!(contextWindow > 0)) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e.type === "compaction") return { tokens: null, percent: null, contextWindow };
    if (e.type !== "message") continue;
    const m = (e.message ?? {}) as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    const stop = m.stopReason;
    if (stop === "aborted" || stop === "error") continue;
    const usage = m.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") continue;
    const tokens = piContextTokens(usage);
    if (!(tokens > 0)) continue;
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }
  return undefined;
}

/** 异步读文件尾部（≤1MB，整行对齐——首行可能残缺丢弃），供倒序扫描。 */
export async function readSessionTailLines(filePath: string, maxBytes = 1_000_000): Promise<string[]> {
  try {
    const fh = await open(filePath, "r");
    try {
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl === -1) return []; // 窗口内无完整行
        text = text.slice(nl + 1);
      }
      return text.split("\n");
    } finally {
      await fh.close();
    }
  } catch {
    return []; // 文件不存在/不可读（尚未落盘等）——静默，不编数据
  }
}

const PI_SESSION_TAIL_BYTES = 1_000_000;

const PI_COMMANDS: PiForkCommands = {
  fork: "fork",
  getForkMessages: "get_fork_messages",
  getCommands: "get_commands",
  hasGetEntries: true,
  hasReadyFrame: false,
  hasContextUsage: false,
  hasDumpTools: false,
  hasHostTools: false,
  hasLogin: false,
  hasSubagents: false, // pi RPC 无 subagent 面（A09）
};

/** pi fork 声明（唯一成员）。 */
export const PI_SPEC: PiForkSpec = {
  id: "pi",
  label: "New pi subprocess (--mode rpc)",
  order: 20,
  agentKey: "pi",
  runtime: "node",
  pathBin: "pi",
  cliEnvVar: "PI_WEB_PI_CLI",
  bundledCli() {
    const pkgDir = process.env.PI_WEB_PKG_DIR;
    if (pkgDir) {
      const bundled = join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      if (existsSync(bundled)) return bundled;
    }
    return undefined;
  },
  commands: PI_COMMANDS,
};

interface PendingUI {
  id: string;
  requestId: string;
  method: string;
}

/** pendingUI 封顶：超过即自动取消最老一条（防子进程刷 UI 请求撑爆内存）。 */
const MAX_PENDING_UI = 32;

/** pi fork 会话 handle。 */
export class PiSpawnHandle extends RpcChildHost {
  readonly source: string;
  readonly capabilities: Record<string, boolean>;
  readonly id: string;
  readonly spec: PiForkSpec;
  readonly cwd: string;

  private running = false;
  private model: { id: string; provider: string } | undefined;
  /** 上下文用量缓存（refreshContextUsage 异步预热；getContextUsage 同步读） */
  private lastContextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | undefined;
  private ctxSessionFile: string | undefined;
  private ctxWindow: number | undefined;
  private ctxRefreshing = false;
  private pendingUI = new Map<string, ExtensionUIRequest>();
  private syntheticUI = new Map<string, (answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string }) => void>();
  private syntheticSeq = 0;
  private deathReason: string | undefined;
  readonly whenReady: Promise<void>;
  /** 远端队列镜像 + queueManage（remote-queue 共享层；镜像由 onFrame 喂 queue_update 帧）。 */
  private readonly rq = createRemotePiQueueSupport({
    clearRemote: async () => {
      const d = (await this.request({ type: "clear_queue" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { steering?: string[]; followUp?: string[] };
      return { steering: d.steering ?? [], followUp: d.followUp ?? [] };
    },
    reinject: async (text, kind) => {
      await this.request({ type: kind === "steer" ? "steer" : "follow_up", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    },
  });

  constructor(spec: PiForkSpec, id: string, child: ChildProcess, cwd = "") {
    super(child);
    this.spec = spec;
    this.source = "aiti-pi-agent/spawn";
    this.capabilities = capabilitiesFor(spec);
    // 上下文用量：RPC 线协议无该命令字段（hasContextUsage 仅 omp），但扩展侧经
    // get_state（sessionFile/model.contextWindow）+ 会话文件换算自实现了
    // getContextUsage()——presence-based 宿主适配层按方法存在性投影，capability 如实翻 true。
    this.capabilities = { ...this.capabilities, contextUsage: true };
    this.id = id;
    this.cwd = cwd;
    this.subscribe((e) => {
      if (e.type === "session_backend_dead") this.deathReason = String(e.reason ?? "unknown");
      // 轮末预热：usage 落盘在 agent_settled 前后，前端 agent_end 后拉 state 前大多已完成
      if (e.type === "agent_settled" || e.type === "agent_end") void this.refreshContextUsage();
    });
    this.whenReady = new Promise<void>((r) => setTimeout(r, 300)); // pi 无 ready 握手帧 → 兜底
    void this.whenReady.then(() => this.refreshContextUsage()); // 恢复场景启动即预热
  }

  static async start(
    opts: {
      sessionId?: string;
      cwd?: string;
      model?: { provider: string; id: string };
      env?: Record<string, string>;
      launchOverride?: LaunchOverride;
    },
    spec: PiForkSpec = PI_SPEC,
  ): Promise<PiSpawnHandle> {
    const resolved = resolveForkCli(spec);
    if (!resolved) {
      throw new Error(`[aiti-pi-agent] ${spec.pathBin} CLI 未找到（PATH 无 ${spec.pathBin}，且无包内 SDK）。`);
    }
    const argv = [...resolved.args, "--mode", "rpc"];
    // 会话 id 统一（2026-09-13）：pi-web 记档 id = pi 进程落盘 id。
    const recordId = opts.sessionId?.trim() || randomUUID();
    argv.push("--session-id", recordId);
    // cc-switch 语义：pi 系 CLI 原生支持 --provider/--model 启动参数
    if (opts.model?.provider) argv.push("--provider", opts.model.provider);
    if (opts.model?.id) argv.push("--model", opts.model.id);

    const ov = opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: resolved.runner,
      command: ov?.command?.trim() || spawnCommand("aiti-pi-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-pi-agent")).args,
      driverArgs: argv,
      env: agentSpawnEnv({
        cli: spec.pathBin,
        governance: governanceEnv,
        extra: opts.env,
        extId: "aiti-pi-agent",
        envList: spawnEnvList("aiti-pi-agent"),
      }),
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: opts.cwd || process.cwd(),
      warn: (m) => console.log(`[aiti-pi-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: opts.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    const handle = new PiSpawnHandle(spec, recordId, child, opts.cwd || process.cwd());
    await handle.whenReady;
    if (!handle.alive()) {
      // fail-loud（加固 P1-5）：进程启动即崩时给清晰错误，替代静默死 handle
      throw new Error(`[aiti-pi-agent] pi 进程启动即退出：${handle.deathReason ?? "unknown"}`);
    }
    // B3（拆分计划）：pi 消费 --provider/--model 启动参数（实测 get_state.data.model 回显完整
    // 解析模型）——ready 后拉一次 get_state 合成 model 状态，agentRunModelRef 即刻对齐实际
    // 运行模型，不必等 pi 主动发 model_select（setModel 切换仍走既有事件链）。
    void (async () => {
      try {
        // request() 已解包返回 frame.data（wire.ts p.resolve(msg.data)）——此前写成 d.data.model
        // 多剥一层导致启动模型回显从未命中（2026-09-19 顺带修复，随 contextUsage 预热同路径实测）。
        const d = (await handle.request({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as {
          model?: { id?: unknown; provider?: unknown };
        };
        const m = d?.model;
        if (m && typeof m.id === "string" && m.id && !handle.getModel()) {
          handle.adoptStartModel({ id: m.id, provider: typeof m.provider === "string" && m.provider ? m.provider : "pi" });
        }
      } catch { /* 状态读取失败不影响会话（model 待 pi model_select 事件） */ }
    })();
    return handle;
  }

  /** 覆写：非 response 帧的 pi 语义分发。 */
  protected override onFrame(msg: Record<string, unknown>): void {
    if (msg.type === "extension_ui_request" && typeof msg.id === "string" && typeof msg.method === "string") {
      const req = msg as unknown as ExtensionUIRequest;
      if (UI_METHODS_NEEDING_ANSWER.has(req.method)) {
        if (this.pendingUI.size >= MAX_PENDING_UI && !this.pendingUI.has(req.id)) {
          this.expirePendingUI(this.pendingUI.keys().next().value as string, "overflow");
        }
        this.pendingUI.set(req.id, req);
        this.emit(toInteractionRequest(req));
      } else if (req.method === "open_url") {
        this.emit(toInteractionRequest(req));
      }
      return;
    }
    if (msg.type === "agent_start" || msg.type === "turn_start") this.running = true;
    if (msg.type === "agent_settled" || msg.type === "agent_end") this.running = false;
    if (msg.type === "model_select" && msg.model) {
      this.model = msg.model as { id: string; provider: string };
    }
    this.rq.observeFrame(msg); // queue_update 帧 → 镜像（原帧照常 emit 给前端）
    this.emit(msg);
  }

  async prompt(text: string, options?: { images?: unknown[]; streamingBehavior?: string }): Promise<void> {
    await this.request({
      type: "prompt",
      message: text,
      ...(options?.images ? { images: options.images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  async dispose(): Promise<void> {
    if (!this.aliveFlag) return;
    await shutdownChild(this.child, 1000);
    this.markDead("disposed");
  }

  alive(): boolean {
    return this.aliveFlag && this.child.exitCode === null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  /** B3：启动模型合成入口——仅当事件链尚未记到 model 时由 start() 的 get_state 回显调用。 */
  adoptStartModel(model: { id: string; provider: string }): void {
    if (!this.model) this.model = model;
  }

  /**
   * RPC get_state → 缓存 sessionFile + model.contextWindow → 异步读会话文件尾，
   * 倒序挑最近有效 assistant usage（pi 本地语义，含压缩边界）。fire-and-forget：
   * 事件驱动（构造/轮末）+ getContextUsage 每次调用兜底触发，同步读只碰缓存。
   */
  private async refreshContextUsage(): Promise<void> {
    if (this.ctxRefreshing || !this.alive()) return;
    this.ctxRefreshing = true;
    try {
      const d = (await this.request({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as {
        sessionFile?: unknown;
        model?: { contextWindow?: unknown };
      };
      if (typeof d?.sessionFile === "string" && d.sessionFile) this.ctxSessionFile = d.sessionFile;
      const w = d?.model?.contextWindow;
      if (typeof w === "number" && w > 0) this.ctxWindow = w;
      if (!this.ctxSessionFile || !this.ctxWindow) return;
      const lines = await readSessionTailLines(this.ctxSessionFile, PI_SESSION_TAIL_BYTES);
      this.lastContextUsage = pickContextUsageFromLines(lines, this.ctxWindow) ?? undefined;
    } catch {
      // 进程死亡/RPC 失败：缓存保持旧值，下次轮末再试（不抛——get_state 命令路径不能被它带崩）
    } finally {
      this.ctxRefreshing = false;
    }
  }

  /**
   * @capability contextUsage —— 同步读缓存（refreshContextUsage 异步预热：启动/轮末/
   * 本方法调用时 fire-and-forget 触发）。缓存未热返回 undefined（前端「暂无数据」）。
   */
  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    void this.refreshContextUsage(); // 兜底预热（幂等：ctxRefreshing 防重入）
    return this.lastContextUsage;
  }

  async steer(text: string): Promise<void> {
    await this.request({ type: "steer", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  async followUp(text: string): Promise<void> {
    await this.request({ type: "follow_up", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /**
   * @capability queueManage —— 远端队列 keeper 全 CRUD（remote-queue 共享层：list=镜像；
   * clear=协议原生 clear_queue 返回清空前文本；move/remove/recall/requeue/convert=clear+重注入）。
   */
  queueManage = (req: {
    action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
    kind?: "steer" | "followUp";
    from?: number;
    to?: number;
    index?: number;
    targetKind?: "steer" | "followUp";
    text?: string;
  }) => this.rq.queueManage(req);

  /** pi → get_entries（entries 原样）。 */
  async getMessages(): Promise<unknown[]> {
    const d = (await this.request({ type: "get_entries" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { entries?: unknown[] };
    return d.entries ?? [];
  }

  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    await this.request({ type: "set_model", provider: model.provider, modelId: model.id }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    this.model = model;
    return true;
  }

  setThinkingLevel(level: string): void {
    void this.request({ type: "set_thinking_level", level }, { timeoutMs: RPC_CTRL_TIMEOUT_MS }).catch(() => {});
  }

  /** pi → fork（{cancelled}）。 */
  async fork(entryId: string): Promise<{ cancelled: boolean }> {
    const d = await this.request<{ cancelled?: boolean }>({ type: "fork", entryId }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    return { cancelled: Boolean(d?.cancelled) };
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: "set_session_name", name }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /** compact 无超时（压缩是一个完整 agent 轮次，时长不可预估；死亡仍会 reject）。 */
  async compact(customInstructions?: string): Promise<unknown> {
    return this.request({ type: "compact", customInstructions });
  }

  /** bash 无超时（命令时长不可预估；死亡仍会 reject）。 */
  async executeBash(command: string): Promise<{ output: string; exitCode?: number }> {
    return this.request({ type: "bash", command });
  }

  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    const d = (await this.request({ type: "get_commands" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { commands?: Array<Record<string, unknown>> };
    return (d.commands ?? []).map((c) => ({
      name: String(c.name ?? ""),
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      source: String(c.source ?? "unknown"),
    }));
  }

  /** RPC get_available_models → 归一化 HandleModelOption[]（后台异步刷新，轮询至非空/超时；单探 10s 超时）。 */
  async getAvailableModels(): Promise<Array<{ id: string; provider: string; label?: string }>> {
    const deadline = Date.now() + 12_000;
    let models: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      const d = (await this.request({ type: "get_available_models" }, { timeoutMs: 10_000 }).catch(() => null)) as {
        models?: Array<Record<string, unknown>>;
      } | null;
      models = d?.models ?? [];
      if (models.length > 0) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    return models.map((m) => ({
      id: String(m.id ?? ""),
      provider: String(m.provider ?? ""),
      ...(typeof m.name === "string" ? { label: String(m.name) } : {}),
    }));
  }

  /** 取消一条挂起 UI 请求（回发 cancelled 帧 + 过期事件；容量封顶/异常清理共用）。 */
  private expirePendingUI(requestId: string, reason: string): void {
    const req = this.pendingUI.get(requestId);
    if (!req) return;
    this.pendingUI.delete(requestId);
    this.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
    this.emit({ type: "interaction_expired", requestId, reason });
  }

  /** 响应挂起中的 extension_ui 请求（interaction_request 事件 → extension_ui_response 帧）。 */
  async respondInteraction(
    requestId: string,
    answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string },
  ): Promise<boolean> {
    const synthetic = this.syntheticUI.get(requestId);
    if (synthetic) {
      this.syntheticUI.delete(requestId);
      synthetic(answer);
      this.emit({ type: "interaction_expired", requestId, reason: "resolved" });
      return true;
    }
    const req = this.pendingUI.get(requestId);
    if (!req) return false;
    const frame = toExtensionUIResponse(req, answer);
    this.pendingUI.delete(requestId);
    if (!frame) return false;
    this.writeRaw(frame);
    this.emit({ type: "interaction_expired", requestId, reason: "resolved" });
    return true;
  }

  // fail-loud stubs（pi RPC 无这些能力；显式 false，前端降级）
  async getAllTools(): Promise<never> {
    throw new Error(`Capability "listTools" is not supported by session backend "${this.source}"`);
  }
  setActiveTools(): never {
    throw new Error(`Capability "setActiveTools" is not supported by session backend "${this.source}"`);
  }
  navigateTree(): never {
    throw new Error(`Capability "navigateTree" is not supported by session backend "${this.source}"`);
  }
  deleteSession(): never {
    throw new Error(`Capability "deleteSession" is not supported by session backend "${this.source}"`);
  }
}

// 测试工厂：不经 spawn 直接构造 handle（单测驱动线协议）
export function createHandleForTest(spec: PiForkSpec, id: string, fakeChild: ChildProcess, cwd = ""): PiSpawnHandle {
  return new PiSpawnHandle(spec, id, fakeChild, cwd);
}
