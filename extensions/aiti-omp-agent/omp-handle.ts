/**
 * omp-handle.ts — omp（oh-my-pi）fork 的 SessionHandle 实现（aiti-omp-agent 专一后端）。
 *
 * 拆分自旧 pi-rpc-spawn.ts 的 PCliSpawnHandle。omp 是 pi 的超集 fork，本文件保留 omp
 * 特有语义：ready 握手帧 / get_state（contextUsage·dumpTools·sessionId·sessionFile）/
 * get_messages / branch / host tools（set_host_tools·host_tool_call） / login（get_login_providers·login）。
 * 线协议载体无关层来自共享层 fork-rpc/（副本同步自 _shared/pi-fork-rpc）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { RpcChildHost, toInteractionRequest, toExtensionUIResponse, UI_METHODS_NEEDING_ANSWER, shutdownChild, RPC_CTRL_TIMEOUT_MS, type ExtensionUIRequest } from "./fork-rpc/wire.ts";
// 远端 pi 协议队列 queueManage 适配（共享层 _shared/pi-fork-rpc/remote-queue.ts，副本随扩展部署——改动须双向同步）
import { createRemotePiQueueSupport } from "./fork-rpc/remote-queue.ts";
import { capabilitiesFor, type HostToolDefinition, type PiForkCommands, type PiForkSpec } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";
import { agentSpawnEnv, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { governanceEnv } from "./external-governance.ts";

const READY_TIMEOUT_MS = 15_000;

const OMP_COMMANDS: PiForkCommands = {
  fork: "branch",
  getForkMessages: "get_branch_messages",
  getCommands: "get_available_commands",
  hasGetEntries: false,
  hasReadyFrame: true,
  hasContextUsage: true,
  hasDumpTools: true,
  hasHostTools: true,
  hasLogin: true,
  hasSubagents: true, // A09：subagent RPC 面（实测 18.x：level ∈ off|progress|events）
};

/** omp fork 声明（唯一成员）。 */
export const OMP_SPEC: PiForkSpec = {
  id: "omp",
  label: "Oh My Pi (omp.sh) — pi 最大 fork",
  order: 30,
  // omp 会话落 ~/.omp/agent/sessions，与 pi 历史不互认——不设 agentKey。
  runtime: "bun",
  pathBin: "omp",
  cliEnvVar: "OMP_CLI",
  commands: OMP_COMMANDS,
};

/** omp get_messages → pi entry 形状归一化。 */
export function normalizeOmpMessages(messages: unknown[]): unknown[] {
  return (Array.isArray(messages) ? messages : []).map((m, i) => ({
    id: `omp-m${i}`,
    type: "message",
    message: m,
  }));
}

/** pendingUI 封顶：超过即自动取消最老一条（防子进程刷 UI 请求撑爆内存）。 */
const MAX_PENDING_UI = 32;

/** omp fork 会话 handle。 */
export class OmpSpawnHandle extends RpcChildHost {
  readonly source: string;
  readonly capabilities: Record<string, boolean>;
  readonly id: string;
  readonly spec: PiForkSpec;
  readonly cwd: string;

  private running = false;
  private model: { id: string; provider: string } | undefined;
  private pendingUI = new Map<string, ExtensionUIRequest>();
  private syntheticUI = new Map<string, (answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string }) => void>();
  private syntheticSeq = 0;
  private readyResolve: (() => void) | null = null;
  private hostTools = new Map<string, HostToolDefinition>();
  private hostToolAborts = new Map<string, AbortController>();
  private lastContextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | undefined;
  private deathReason: string | undefined;
  /** omp 进程侧会话 id（get_state.sessionId 读回；pi-web 记档 id 仍用传入值）。 */
  rpcSessionId?: string;
  /** omp 会话落盘路径（get_state.sessionFile；branch entry-id 反查用）。 */
  private sessionFilePath?: string;
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
    this.source = "aiti-omp-agent/omp-spawn";
    this.capabilities = capabilitiesFor(spec);
    this.id = id;
    this.cwd = cwd;
    this.subscribe((e) => {
      if (e.type !== "session_backend_dead") return;
      this.deathReason = String(e.reason ?? "unknown");
      // 加固 P1-5：ready 前死亡也放行 whenReady，start() 随即 fail-loud（替代白等 15s）
      this.readyResolve?.();
    });
    // omp 有 ready 握手帧；超时兜底（ready 不来也放行，首个 request 自带失败面）
    this.whenReady = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, READY_TIMEOUT_MS);
      this.readyResolve = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  static async start(
    opts: {
      sessionId?: string;
      cwd?: string;
      model?: { provider: string; id: string };
      env?: Record<string, string>;
      launchOverride?: LaunchOverride;
    },
    spec: PiForkSpec = OMP_SPEC,
  ): Promise<OmpSpawnHandle> {
    const resolved = resolveForkCli(spec);
    if (!resolved) {
      throw new Error("[aiti-omp-agent] Oh My Pi CLI 未找到。安装：`bun install -g @oh-my-pi/pi-coding-agent`（bun ≥1.3.14），或设 OMP_CLI 指向 cli.js。");
    }
    const argv = [...resolved.args, "--mode", "rpc"];
    // omp 无 --session-id（id 由进程生成、get_state.sessionId 读回），记档仍用该 UUID 占位。
    const recordId = opts.sessionId?.trim() || randomUUID();
    if (opts.model?.provider) argv.push("--provider", opts.model.provider);
    if (opts.model?.id) argv.push("--model", opts.model.id);

    const ov = opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: resolved.runner,
      command: ov?.command?.trim() || spawnCommand("aiti-omp-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-omp-agent")).args,
      driverArgs: argv,
      env: agentSpawnEnv({
        cli: spec.pathBin,
        governance: governanceEnv,
        extra: opts.env,
        extId: "aiti-omp-agent",
        envList: spawnEnvList("aiti-omp-agent"),
      }),
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: opts.cwd || process.cwd(),
      warn: (m) => console.log(`[aiti-omp-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: opts.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    const handle = new OmpSpawnHandle(spec, recordId, child, opts.cwd || process.cwd());
    await handle.whenReady;
    if (!handle.alive()) {
      // fail-loud（加固 P1-5）：进程在 ready 前死亡时给清晰错误（替代静默死 handle）
      throw new Error(`[aiti-omp-agent] omp 进程在就绪前退出：${handle.deathReason ?? "unknown"}`);
    }
    // omp 新会话 id 由进程生成：ready 后读 get_state.sessionId 回填（信息性）
    void handle.refreshStateUsage().catch(() => {});
    return handle;
  }

  /** 覆写：非 response 帧的 omp 语义分发。 */
  protected override onFrame(msg: Record<string, unknown>): void {
    if (msg.type === "ready") {
      this.readyResolve?.();
      if (this.spec.commands.hasContextUsage) void this.refreshStateUsage().catch(() => {});
      return; // 握手帧不外发
    }
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
    if (msg.type === "host_tool_call" && typeof msg.id === "string" && typeof msg.toolName === "string") {
      void this.onHostToolCall({
        id: msg.id,
        toolName: msg.toolName,
        args: (msg.arguments && typeof msg.arguments === "object" && !Array.isArray(msg.arguments)
          ? msg.arguments
          : {}) as Record<string, unknown>,
      }).catch(() => {});
      return;
    }
    if (msg.type === "host_tool_cancel" && typeof msg.targetId === "string") {
      this.hostToolAborts.get(msg.targetId)?.abort();
      return;
    }
    if (msg.type === "agent_start" || msg.type === "turn_start") this.running = true;
    if (msg.type === "agent_settled" || msg.type === "agent_end") {
      this.running = false;
      if (this.spec.commands.hasContextUsage) void this.refreshStateUsage().catch(() => {});
    }
    if (msg.type === "model_select" && msg.model) {
      this.model = msg.model as { id: string; provider: string };
    }
    this.rq.observeFrame(msg); // queue_update 帧 → 镜像（原帧照常 emit 给前端）
    this.emit(msg);
  }

  async prompt(text: string, options?: { images?: unknown[]; streamingBehavior?: string }): Promise<void> {
    const trimmed = text.trim();
    if (this.spec.commands.hasLogin && !this.running && trimmed.startsWith("/login")) {
      await this.handleLoginCommand(trimmed);
      return;
    }
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
    for (const ac of this.hostToolAborts.values()) ac.abort();
    this.hostToolAborts.clear();
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

  async steer(text: string): Promise<void> {
    await this.request({ type: "steer", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  async followUp(text: string): Promise<void> {
    await this.request({ type: "follow_up", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /**
   * @capability queueManage —— 远端队列 keeper 全 CRUD（remote-queue 共享层：list=镜像；
   * clear=协议原生 clear_queue 返回清空前文本；move/remove/recall/requeue/convert=clear+重注入）。
   * omp 为 pi 超集 fork，clear_queue 应在；不支持的上游版本 fail-loud。
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

  /** omp → get_messages（包装为 pi entry 形状）。 */
  async getMessages(): Promise<unknown[]> {
    const d = (await this.request({ type: "get_messages" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { messages?: unknown[] };
    return normalizeOmpMessages(d.messages ?? []);
  }

  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    await this.request({ type: "set_model", provider: model.provider, modelId: model.id }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    this.model = model;
    return true;
  }

  setThinkingLevel(level: string): void {
    void this.request({ type: "set_thinking_level", level }, { timeoutMs: RPC_CTRL_TIMEOUT_MS }).catch(() => {});
  }

  /** omp → branch（{text,cancelled}）；合成 id `omp-m<N>` 反查真实 entry id。 */
  async fork(entryId: string): Promise<{ cancelled: boolean }> {
    let target = entryId;
    const m = /^omp-m(\d+)$/.exec(entryId);
    if (m) {
      const real = await this.resolveOmpEntryId(Number(m[1]));
      if (!real) throw new Error(`[aiti-omp-agent] omp branch: 无法从会话文件反查 entry #${m[1]}（会话文件未就绪或索引越界）`);
      target = real;
    }
    const d = await this.request<{ cancelled?: boolean }>({ type: "branch", entryId: target }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    return { cancelled: Boolean(d?.cancelled) };
  }

  /** 从 sessionFile JSONL 反查第 n 条（0 基）message entry 的真实 entry id。 */
  private async resolveOmpEntryId(n: number): Promise<string | undefined> {
    const file = this.sessionFilePath;
    if (!file) return undefined;
    const { readFile } = await import("node:fs/promises");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    let count = -1;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { id?: unknown; type?: unknown };
        if (e?.type === "message") {
          count++;
          if (count === n) return typeof e.id === "string" ? e.id : undefined;
        }
      } catch {
        // 跳过坏行
      }
    }
    return undefined;
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
    const d = (await this.request({ type: "get_available_commands" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { commands?: Array<Record<string, unknown>> };
    return (d.commands ?? []).map((c) => ({
      name: String(c.name ?? ""),
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      source: String(c.source ?? "unknown"),
    }));
  }

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

  /** omp get_state.contextUsage → 契约同形状（同步读 → 返回最近缓存；未预热时 undefined）。 */
  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    return this.lastContextUsage;
  }

  /** 异步拉取并缓存 get_state（contextUsage 缓存源 + omp 进程侧 sessionId 回填）。 */
  private async refreshStateUsage(): Promise<void> {
    const d = (await this.request({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as {
      sessionId?: unknown;
      sessionFile?: unknown;
      contextUsage?: { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
    };
    if (typeof d?.sessionId === "string" && d.sessionId) {
      this.rpcSessionId = d.sessionId;
    }
    if (typeof d?.sessionFile === "string" && d.sessionFile) {
      this.sessionFilePath = d.sessionFile;
    }
    const c = d?.contextUsage;
    if (!c) {
      this.lastContextUsage = { percent: null, contextWindow: 0, tokens: null };
      return;
    }
    this.lastContextUsage = {
      percent: typeof c.percent === "number" ? c.percent : null,
      contextWindow: typeof c.contextWindow === "number" ? c.contextWindow : 0,
      tokens: typeof c.tokens === "number" ? c.tokens : null,
    };
  }

  // ── A09：subagent RPC 面（协议 2026-09-19 实测钉死：level ∈ off|progress|events）──

  /** 当前 subagent 实例清单（get_subagents.subagents）。 */
  async getSubagents(): Promise<unknown> {
    const d = (await this.request({ type: "get_subagents" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { subagents?: unknown };
    return d?.subagents ?? [];
  }

  /** 订阅 subagent 事件（level: "off" | "progress" | "events"）。
   *  events 级帧：subagent_lifecycle / subagent_progress / subagent_event（原样 emit 进事件流）。 */
  async setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
    await this.request({ type: "set_subagent_subscription", level }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /** 拉取一个 subagent 的消息（subagentId 或 sessionFile 定位）。 */
  async getSubagentMessages(subagentId: string, fromByte?: number): Promise<unknown> {
    return await this.request(
      { type: "get_subagent_messages", subagentId, ...(fromByte !== undefined ? { fromByte } : {}) },
      { timeoutMs: RPC_CTRL_TIMEOUT_MS },
    );
  }

  /** omp get_state.dumpTools → [{name, description}]。 */
  async getAllTools(): Promise<Array<{ name: string; description: string }>> {
    const d = (await this.request({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { dumpTools?: Array<Record<string, unknown>> };
    return (d?.dumpTools ?? []).map((t) => ({
      name: String(t.name ?? ""),
      description: typeof t.description === "string" ? t.description : "",
    }));
  }

  /** 注册宿主工具并下发 set_host_tools；成功返回 omp 已接受的工具名清单。 */
  async setHostTools(tools: HostToolDefinition[]): Promise<string[]> {
    for (const tool of tools) this.hostTools.set(tool.name, tool);
    const data = await this.request<{ toolNames?: string[] }>({
      type: "set_host_tools",
      tools: tools.map(({ name, label, description, parameters }) => ({ name, ...(label ? { label } : {}), description, parameters })),
    }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    return Array.isArray(data?.toolNames) ? data.toolNames : [];
  }

  private async onHostToolCall(frame: { id: string; toolName: string; args: Record<string, unknown> }): Promise<void> {
    const tool = this.hostTools.get(frame.toolName);
    const ac = new AbortController();
    this.hostToolAborts.set(frame.id, ac);
    let result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    if (!tool) {
      result = { content: [{ type: "text", text: `Unknown host tool: ${frame.toolName}` }], isError: true };
    } else {
      try {
        const text = await tool.execute(frame.args, ac.signal);
        result = { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }] };
      } catch (caught) {
        result = { content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }], isError: true };
      }
    }
    this.hostToolAborts.delete(frame.id);
    this.writeRaw({ type: "host_tool_result", id: frame.id, result });
  }

  /** 合成 assistant 通知（完整 turn 生命周期——前端 message_end 有 agentRunning 守卫）。 */
  private emitNotice(text: string): void {
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", stopReason: "end_turn" });
  }

  /** /login 触发面：get_login_providers/login RPC → open_url extension_ui 帧 → 前端登录专用卡。 */
  private async handleLoginCommand(raw: string): Promise<void> {
    const arg = raw.slice("/login".length).trim();
    try {
      const d = await this.request<{ providers?: Array<{ id: string; name?: string; available?: boolean; authenticated?: boolean }> }>({
        type: "get_login_providers",
      });
      const providers = d?.providers ?? [];
      const plabel = (p: { id: string; name?: string }) => `${p.name || p.id}（${p.id}）`;
      if (arg) {
        const p = providers.find((x) => x.id === arg || x.name === arg);
        if (!p) {
          this.emitNotice(`没有名为「${arg}」的可登录 provider。可用：${providers.map(plabel).join("、") || "（无）"}`);
          return;
        }
        this.startLogin(p);
        return;
      }
      const candidates = providers.filter((p) => p.available !== false && !p.authenticated);
      if (candidates.length === 0) {
        this.emitNotice(
          providers.length
            ? "所有 OAuth provider 均已登录，无需再登录。"
            : "当前 omp 没有 OAuth 登录项（api-key 型 provider 走配置，不需要 /login）。",
        );
        return;
      }
      if (candidates.length === 1) {
        this.startLogin(candidates[0]);
        return;
      }
      if (candidates.length <= 8) {
        const q = "选择要登录的 OAuth provider";
        const id = `slogin-${++this.syntheticSeq}`;
        const options = candidates.map(plabel);
        const byLabel = new Map(options.map((o, i) => [o, candidates[i].id]));
        this.syntheticUI.set(id, (answer) => {
          if (answer.action === "decline") return;
          const v = answer.answers?.[q];
          const picked = (Array.isArray(v) ? v[0] : v) ?? "";
          const pid = byLabel.get(picked);
          const p = candidates.find((c) => c.id === pid);
          if (p) this.startLogin(p);
        });
        this.emit(toInteractionRequest({ type: "extension_ui_request", id, method: "select", title: q, options } as unknown as ExtensionUIRequest));
        return;
      }
      this.emitNotice(
        `当前有 ${candidates.length} 个 OAuth provider 可登录。请用 /login <providerId> 指定，如：` +
          candidates.slice(0, 6).map((p) => p.id).join("、") + " …",
      );
    } catch (e) {
      this.emitNotice(`登录查询失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private startLogin(p: { id: string; name?: string }): void {
    const name = p.name || p.id;
    this.emitNotice(
      `已发起 ${name} 的 OAuth 登录——请在弹出的登录页完成授权，agent 检测到后会自动继续；若浏览器未打开，用登录卡上的「复制链接」手动打开。`,
    );
    void this.request({ type: "login", providerId: p.id })
      .then(() => this.emitNotice(`${name} 登录完成。`))
      .catch((e) => this.emitNotice(`${name} 登录未完成：${e instanceof Error ? e.message : String(e)}`));
  }

  /** 取消一条挂起 UI 请求（回发 cancelled 帧 + 过期事件；容量封顶/异常清理共用）。 */
  private expirePendingUI(requestId: string, reason: string): void {
    const req = this.pendingUI.get(requestId);
    if (!req) return;
    this.pendingUI.delete(requestId);
    this.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
    this.emit({ type: "interaction_expired", requestId, reason });
  }

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

  // fail-loud stubs（omp RPC 无这些能力；显式 false，前端降级）
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
export function createHandleForTest(spec: PiForkSpec, id: string, fakeChild: ChildProcess, cwd = ""): OmpSpawnHandle {
  return new OmpSpawnHandle(spec, id, fakeChild, cwd);
}
