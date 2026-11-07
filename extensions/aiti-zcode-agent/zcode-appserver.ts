/**
 * zcode-appserver —— ZCode Protocol v1 长驻客户端（`zcode.cjs app-server` stdio NDJSON）。
 *
 * 驱动方式与 ZCode 桌面端一致（docs/zcode-desktop-cli-agent-analysis.md §7，2026-09-07 源码逆向 + 直连 E2E）：
 *   spawn app-server → session/create|resume → session/subscribe{deliveryKind:"desktop-continuous"}
 *   → session/send（异步受理）→ session/event 通知流
 *   ⚠ 运行中 steer 不走 session/send（v1 路径实测只入 runtime 延迟队列且不投递，2026-09-10 探针），
 *   走 desktop 同款 v4/command sendText{requestedDelivery:"guide"}（见 steerViaCommand）。
 *
 * 事件映射（桌面端消费形态 → pi-web wire）：
 *   model.streaming text_*     → message_update text_start/delta/end（打字机）
 *   model.streaming reasoning_*→ message_update thinking_start/delta/end
 *   model.streaming tool_input_* / tool_call → message_update toolcall_start/delta/end
 *   tool.updated scheduled/started → tool_execution_start（此前封口当前流式消息段）
 *   tool.updated progress      → tool_execution_update（stdoutTail → partialResult 文本）
 *   tool.updated result/error  → tool_execution_end + message_end{role:"toolResult"}（工具结果卡）
 *   tool.updated (TodoWrite 族) → onTaskList 任务列表镜像（桌面端同款派生，协议无专门 todo 事件）
 *   turn.completed / failed    → 流式消息封口 message_end{assistant} + agent_end + agent_settled
 *
 * 反向请求（server→client，必须应答）：session/requestRuntimePreferences（桌面端同款应答）、
 *   interaction/requestPermission（backend 语义自动放行）、interaction/requestUserInput（★ 交互元语桥接）。
 *
 * 交互元语（2026-09-10，协议逆向 + 会话记录实证）：
 *   zcode 的「问题模式 / plan 审批」由两个工具发起，均经 interaction/requestUserInput 反向请求决策：
 *   - AskUserQuestion（kind=ask_user）：questions=[{question,header,multiSelect,options}] →
 *     应答 {action:"accept",content:{answers:{<question文本>:<label|label[]>}}}；拒绝 → deny。
 *   - ExitPlanMode（kind=plan_approval，schema.interaction="plan_approval"）：plan 全文在 input.plan →
 *     批准应答 {action:"accept",content:{answer:"approve"}}；带反馈拒绝应答
 *     {action:"accept",content:{answer:"<反馈>"}}（zcode 端归一为 deny+reason=反馈，agent 收到继续改方案）；
 *     直接拒绝 {action:"decline"}。
 *   桥接方式：emit interaction_request 事件给 pi-web 前端（统一审批/问题卡），用户作答经
 *   respondInteraction() 回填；zcode 端无总超时（reannounce 重发同 requestId，handler 幂等），
 *   turn 收口/ dispose 时未决请求一律 decline + interaction_expired 清理。
 *   权限类（interaction/requestPermission）保持自动放行（backend 语义，应用户 yolo 要求）。
 *
 *
 * 进程模型：一个连接一个 app-server 子进程；进程退出 → waiter 拒绝 + 标记失效，
 *   下一轮 prompt 重新 spawn + session/resume（sess_xxx 持久于 ~/.zcode，跨进程复活）。
 */

import { spawn, type ChildProcess } from "node:child_process";
// P1' 启动包装（docs/aiti-custom-agent-plan.md）：launch 解析走共享层
import { spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// 任务列表（TodoWrite 族工具事件派生）解析/更新语义走共享层（权威源 _shared/task-list.ts）
import { createTaskListMirror, type TaskEntry } from "@aiti-ai/ext-shared/task-list";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 图片附件（与 index.ts 侧 TurnImage 结构同形；data 为无 data: 前缀的 base64）。 */
export interface TurnImageLike { data: string; mimeType: string; filename?: string }

/** app-server 启动重试参数：send 受理前的启动段（spawn→upsert→resume→subscribe）传输层中断时清理重拉。 */
const STARTUP_ATTEMPTS = 3;
const STARTUP_BACKOFF_MS = 1200;

type JsonRecord = Record<string, unknown>;
type Listener = (event: JsonRecord) => void;

/** 桌面端同款 runtime preferences 应答（probe 实测可通过；modelContextBudgetStrategy 取 CLI 默认 preflight-v1）。 */
export const RUNTIME_PREFERENCES_ANSWER: JsonRecord = {
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
};

/** "bigmodel/GLM-5.3" → {providerId, modelId}（session/create|setModel 的 model 字段）；非法返回 null。 */
export function toProtocolModel(modelRef: string): { providerId: string; modelId: string } | null {
  const i = modelRef.indexOf("/");
  if (i <= 0 || i === modelRef.length - 1) return null;
  return { providerId: modelRef.slice(0, i), modelId: modelRef.slice(i + 1) };
}

/** 3.17+ object 形态 setModel 声明了 reasoningLevel 档位的模型必带 options.reasoningLevel
 *  （缺省 -32603 "Reasoning level is required"；personal provider config 的模型卡声明
 *  disabled/enabled 两档）。GLM-5 系 agent 走 enabled（思考开，桌面同款）。 */
const ZCODE_REASONING_LEVEL = "enabled";

/** UI 五档权限模式 → ZCode mode 枚举（plan/build/edit/yolo/auto）。 */
export function toProtocolMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case "plan": return "plan";
    case "default": case "build": return "build";
    case "acceptEdits": case "edit": return "edit";
    case "bypassPermissions": case "yolo": return "yolo";
    default: return undefined;
  }
}

// ============================================================================
// 连接层：一个 app-server 子进程 + NDJSON 编解码 + 双向 RPC
// ============================================================================

export class ZcodeAppServerConnection {
  private child: ChildProcess | null = null;
  private buffer = "";
  private exited = true;
  private nextId = 1;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | undefined;
  }>();
  private reverse = new Map<string, (params: JsonRecord) => unknown | Promise<unknown>>();
  private notificationListeners = new Set<(method: string, params: JsonRecord) => void>();
  private exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  /** app-server stderr 最近 8KB 环形缓冲（exit≠0 / spawn 失败时落盘用，替代原先的 stderr 全丢弃）。 */
  private stderrTail = "";

  private opts: {
    nodeBin: string;
    runtimePath: string;
    cwd: string;
    env: Record<string, string>;
    /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
    launchOverride?: LaunchOverride;
    log?: (msg: string) => void;
  };

  constructor(opts: {
    nodeBin: string;
    runtimePath: string;
    cwd: string;
    env: Record<string, string>;
    launchOverride?: LaunchOverride;
    log?: (msg: string) => void;
  }) {
    this.opts = opts;
  }

  isAlive(): boolean {
    return !this.exited && this.child !== null;
  }

  start(): void {
    if (this.isAlive()) return;
    // extman spawn.command/spawn.argsPrefix 启动包装，缺省 = 行为不变；P2 launchOverride 优先
    const ov = this.opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: this.opts.nodeBin,
      command: ov?.command?.trim() || spawnCommand("aiti-zcode-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-zcode-agent")).args,
      driverArgs: [this.opts.runtimePath, "app-server", "--surface", "desktop"],
      env: this.opts.env,
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: this.opts.cwd,
      warn: (m) => console.log(`[aiti-zcode-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    this.child = child;
    this.exited = false;
    this.buffer = "";
    this.stderrTail = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.feed(chunk));
    // 三个流必须挂 error 监听（加固 A2）：ECONNRESET/EPIPE 无监听器会崩宿主进程。
    child.stdout?.on("error", (err: Error) => {
      // stdout 是协议流，断即死：exit 流程 failAllPending
      this.opts.log?.(`[aiti-zcode-agent] app-server stdout error: ${err.message}`);
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    });
    child.stderr?.on("error", (err: Error) => this.opts.log?.(`[aiti-zcode-agent] app-server stderr error: ${err.message}`));
    child.stdin?.on("error", (err: Error) => this.opts.log?.(`[aiti-zcode-agent] app-server stdin error: ${err.message}`));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
      if (process.env.AITI_ZCODE_DEBUG_STDERR) {
        process.stderr.write(`[aiti-zcode-agent][app-server] ${chunk.toString()}`);
      }
    });
    child.once("exit", (code, signal) => {
      // 代际检查：reset/重拉后旧子进程的迟到退出不得覆盖新子进程状态
      if (this.child !== child) return;
      this.exited = true;
      this.child = null;
      const reason = `app-server 进程退出（code=${code}${signal ? ` signal=${signal}` : ""}）`;
      // stderr 落盘：异常退出（非零码 / SIGKILL 等强杀信号）才记；dispose 的 SIGTERM 正常收尾不刷屏
      const abnormal = (code !== null && code !== 0) || (signal != null && signal !== "SIGTERM" && signal !== "SIGINT");
      if (abnormal) {
        this.opts.log?.(`[aiti-zcode-agent] ${reason}\n--- app-server stderr tail ---\n${this.stderrTail || "(empty)"}\n--- end ---`);
      }
      this.failAllPending(new Error(reason));
      for (const fn of [...this.exitListeners]) fn({ code, signal });
    });
    child.once("error", (err) => {
      if (this.child !== child) return;
      this.exited = true;
      this.child = null;
      this.opts.log?.(`[aiti-zcode-agent] app-server 进程启动失败: ${err.message}\n--- stderr tail ---\n${this.stderrTail || "(empty)"}\n--- end ---`);
      this.failAllPending(new Error(`app-server 进程启动失败: ${err.message}`));
      for (const fn of [...this.exitListeners]) fn({ code: null, signal: null });
    });
    this.opts.log?.(`[aiti-zcode-agent] app-server spawned (pid ${child.pid})`);
  }

  /** 最近一次子进程 stderr（尾部 8KB；启动失败时随错误上抛落盘，替代原先的 stderr 全丢弃）。 */
  get stderrTailText(): string {
    return this.stderrTail;
  }

  /** 注册 server→client 反向请求处理器（必须应答；未注册的方法不回，server 端超时自决）。 */
  handleReverseRequest(method: string, handler: (params: JsonRecord) => unknown | Promise<unknown>): void {
    this.reverse.set(method, handler);
  }

  onNotification(fn: (method: string, params: JsonRecord) => void): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  onExit(fn: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.isAlive()) return Promise.reject(new Error("app-server 进程未运行"));
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const entry = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: timeoutMs > 0
          ? setTimeout(() => {
            this.pending.delete(String(id));
            reject(new Error(`${method} 超时（${timeoutMs}ms）`));
          }, timeoutMs)
          : undefined,
      };
      this.pending.set(String(id), entry);
      this.write({ id, method, params });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    try { this.child?.kill(signal); } catch { /* already dead */ }
  }

  private write(obj: JsonRecord): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      // 写失败（子进程刚死）：exit 事件会收尾 failAllPending
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: JsonRecord;
      try { msg = JSON.parse(line) as JsonRecord; } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRecord): void {
    const id = msg.id;
    if (id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(String(id));
      if (!entry) return;
      this.pending.delete(String(id));
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error !== undefined && msg.result === undefined) {
        const e = msg.error as { code?: number; message?: string; data?: unknown };
        const err = new Error(`zcode rpc ${e.code ?? ""}: ${e.message ?? "unknown"}`);
        (err as Error & { code?: number; data?: unknown }).code = e.code;
        (err as Error & { code?: number; data?: unknown }).data = e.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method !== "string") return;
    const params = (msg.params ?? {}) as JsonRecord;
    if (id !== undefined) {
      // 反向请求：异步执行 handler 并应答（同 id 回 {id, result|error}）
      const handler = this.reverse.get(msg.method);
      if (!handler) return; // 桌面端对未知反查容忍不答（probe 实测 requestOfficialMcpAuthHeaders 不答可继续）
      void Promise.resolve()
        .then(() => handler(params))
        .then((result) => this.write({ id, result: result ?? {} }))
        .catch((e) => this.write({ id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }));
      return;
    }
    for (const fn of [...this.notificationListeners]) fn(msg.method, params);
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// ============================================================================
// 会话层：一个 zcode 会话（create/resume/subscribe/send/stop/setModel/setMode）
// + session/event → pi 事件状态机（桌面端同款消费形态）
// ============================================================================

/** turn.completed 的 usage（真实 provider 口径；无字段 = 服务端未报该项）。
 *  ⚠ tokenCount 在引擎缺 baseline 时是 chars/4 字符估算（把 base64 图片/大文本全算进去，
 *  内容重的会话可达数百万）——上下文占用必须优先取这里的真实 usage，tokenCount 只兜底。 */
export interface TurnUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TurnOutcome {
  cancelled: boolean;
  errorMessage?: string;
  /** turn.completed 的 tokenCount（引擎投影；有 usage 时 ≈ totalTokens，缺 baseline 时为字符估算）。 */
  tokenCount?: number | null;
  /** turn.completed 的 usage（真实 provider 用量；上下文占用/统计面板的权威来源）。 */
  usage?: TurnUsageSnapshot;
  durationMs?: number | null;
  cacheReadTokens?: number | null;
  resultType?: string;
}

/** turn.completed payload.usage → 快照（schema 是 t.unknown()，逐字段宽数值提取）。 */
function parseUsageSnapshot(v: unknown): TurnUsageSnapshot | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const p = v as JsonRecord;
  const out: TurnUsageSnapshot = {};
  const inputTokens = num(p.inputTokens);
  const outputTokens = num(p.outputTokens);
  const totalTokens = num(p.totalTokens);
  const reasoningTokens = num(p.reasoningTokens);
  const cacheReadTokens = num(p.cacheReadTokens);
  const cacheWriteTokens = num(p.cacheWriteTokens);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** interaction/requestUserInput 反向请求 params（runtime 0.16.5 schema 摘要）。 */
interface UserInputRequestParams {
  requestId?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  prompt?: unknown;
  questions?: unknown;
  input?: unknown;
  schema?: unknown;
}

/** 用户对交互请求的回答（pi-web InteractionAnswer 同构，避免跨包类型依赖）。 */
export interface InteractionAnswerInput {
  action: "accept" | "decline";
  answers?: Record<string, string | string[]>;
  message?: string;
}

/** 挂起中的交互请求：共享 promise（reannounce 重发复用）+ 事件负载 + resolver。 */
interface PendingInteraction {
  kind: "plan_approval" | "ask_user" | "generic";
  requestId: string;
  promise: Promise<JsonRecord>;
  resolve: (answer: JsonRecord) => void;
  /** interaction_request 事件负载（reannounce 重发时原样重新 emit）。 */
  event: JsonRecord;
}

/** plan 审批问题的固定答案值（zcode 常量，runtime 逆向实测：approve 才是真批准）。 */
const PLAN_APPROVE_ANSWER = "approve";

export interface AppServerSessionOpts {
  connection: ZcodeAppServerConnection;
  cwd: string;
  /** create 时的权限模式（UI 五档或 zcode 档名均可，内部归一）。 */
  mode?: string;
  /** create 时的模型 ref（"provider/model"）。 */
  modelRef?: string;
  /** 已知 zcode 会话 id → 走 session/resume（All Sessions 复活 / 进程重启复活）。 */
  sessId?: string;
  /**
   * provider 注入（桌面端同款 workspace/upsertModelProvider 通道）：凭据与模型目录
   * 纯内存注册（apiKey inline → 内存 secrets，不落 config.json）。resume 场景必需——
   * 服务端恢复会话时校验历史模型在 provider registry 中，缺席则设 restoreWarning（-32031 拒 send）。
   * 同时用于构造 runtimeModel（resume/send 携带 → 服务端 xse 路径直接应用模型并清 restoreWarning，
   * 2026-09-09 实测：upsert 后 resume 仍会触发 deferred_model_adapter（restoreWarning）的会话，
   * 必须带 runtimeModel 才能绕开 -32031；详见 docs/zcode-desktop-cli-agent-analysis.md §7.3.1）。
   */
  provider?: {
    providerId: string;
    baseURL: string;
    apiKey: string;
    models: Array<{ modelId: string; label?: string; contextWindow?: number }>;
    /** 随 provider 提交的额外请求头（start-plan 验证码回填：`x-aliyun-captcha-verify-param` 等；analysis §9）。 */
    headers?: Record<string, string>;
  };
  log?: (msg: string) => void;
  /** pi 事件出口（message_*、tool_*、agent_*）。 */
  onEvent: (ev: JsonRecord) => void;
  /** zcode 真实会话 id 捕获（首轮 create 后回调一次）。 */
  onSessionId?: (sid: string) => void;
  /** 服务端 steer 队列镜像变化（已交给 zcode、尚未 drain 的输入；全量快照）。 */
  onSteerQueue?: (items: Array<{ pendingInputId: string; input: string }>) => void;
  /** 任务列表镜像变化（TodoWrite working plan 只读；全量快照，跨轮持续）。 */
  onTaskList?: (todos: TaskEntry[]) => void;
  /**
   * start-plan 验证码求解器插槽（`interaction/requestProviderRuntimeHeaders` 反向请求的数据源）。
   * 返回 {captchaVerifyParam, region?} → 内部以 provider headers 重 upsert 后应答 {headersApplied:true}；
   * 返回 {ok:false, errorMessage?} 或超时/未配置 → 应答 {headersApplied:false, errorMessage}（轮次人话失败）。
   * 缺省 = 不配置求解器（start-plan 通道轮次将以「验证码求解器未配置」失败）。
   */
  onProviderHeadersRequest?: (req: { requestId: string; providerId: string; modelRef: string; reason: string }) => Promise<
    { ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }
  >;
}

/** 等待验证码求解的时限（覆盖无感 + 用户滑块；超时按 headersApplied:false 收口）。 */
const PROVIDER_HEADERS_WAIT_MS = 180_000;

type StreamBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; toolCallId: string; toolName: string; input: JsonRecord };
interface WaiterEntry { resolve: (o: TurnOutcome) => void; reject: (e: Error) => void }

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ----------------------------------------------------------------------------
// 任务列表派生（TodoWrite working plan 只读镜像）——解析/更新语义已上收共享层
// @aiti-ai/ext-shared/task-list（CC 族各家共用；测试 _shared/task-list.test.mjs）。
// 本文件只保留出口：工具事件 → mirror.fromToolEvent，resume 快照 → mirror.seed。
// ----------------------------------------------------------------------------

export class AppServerSession {
  /** 真实 zcode 会话 id（sess_xxx）。 */
  zcodeSid: string | null;
  private ready = false;
  private subscribed = false;
  private opts: AppServerSessionOpts;
  private conn: ZcodeAppServerConnection;
  private turnWaiters = new Set<WaiterEntry>();
  /** 服务端 steer 队列镜像（turn.steerQueued 入 / steerDrained·steerDiscarded 出）。 */
  private steerQueue: Array<{ pendingInputId: string; input: string }> = [];
  /** 任务列表镜像（TodoWrite 族工具事件派生 + resume 快照种子；跨轮持续，finishTurn 不清空）。 */
  private tasks = createTaskListMirror((todos) => this.opts.onTaskList?.(todos));
  /** v4 steer 命令序号（commandId 唯一性）。 */
  private v4SteerSeq = 0;
  private wired = false;
  private offNotification: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  /** dispose 置位：ensureReady 的重拉循环见到即停（不再 respawn 子进程）。 */
  private disposedFlag = false;
  /** 挂起中的交互元语请求（interaction_request 已 emit，等用户作答；requestId 寻址）。 */
  private pendingInteractions = new Map<string, PendingInteraction>();
  /** 当前轮已收口（turn.completed/failed 已处理）：此后到达的反向请求不再挂起，直接 decline（防泄漏）。 */
  private turnSettled = true;

  // ---- 流式状态机（一次开一条 assistant 消息；桌面端同款粒度）----
  private stream: {
    assistantMessageId: string;
    blocks: StreamBlock[];
    /** 显式 partId → contentIndex。 */
    index: Map<string, number>;
    acc: Map<number, { kind: "text"; text: string } | { kind: "thinking"; thinking: string } | { kind: "tool"; rawInput: string; toolCallId: string; toolName: string }>;
    /** toolCallId → contentIndex（真机 wire 的 tool 帧可能不带 partId，靠 callId 定位）。 */
    toolByCallId: Map<string, number>;
    /** 无 partId 时按 kind 隐式续块（真机 wire 无 *_start 起始帧也能落块）。 */
    implicit: { text?: number; reasoning?: number; tool?: number };
  } | null = null;
  private seenToolStarts = new Set<string>();
  /** toolCallId → toolName（跨流式/事件帧反查；result 帧可能不带 toolName）。 */
  private toolNameByCallId = new Map<string, string>();

  constructor(opts: AppServerSessionOpts) {
    this.opts = opts;
    this.conn = opts.connection;
    this.zcodeSid = opts.sessId ?? null;
  }

  private get log(): (msg: string) => void {
    return this.opts.log ?? (() => {});
  }

  private emit(ev: JsonRecord): void {
    this.opts.onEvent(ev);
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  /** 确保 app-server 进程 + 会话 + 订阅就绪（prompt 前调用；幂等）。 */
  async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.wire();
    // 正确拉起：进程被 kill / 启动秒退后，内存遗留已由 exit 回调复位（ready/subscribed、
    // 重新 start 重清 buffer/stderrTail），这里完整重走 spawn→upsert→resume→subscribe 恢复常态——
    // 替代原先把「app-server 进程未运行」直接抛给用户卡死会话。重试只覆盖 send 受理前的启动段；
    // send 已受理后的进程退出仍由 onExit → failWaiters 拒绝本轮，下轮 prompt 走到这里重拉。
    for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt++) {
      try {
        if (!this.conn.isAlive()) this.conn.start();
        await this.ensureProtocolReady();
        this.ready = true;
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const transportDown = /进程退出|进程未运行|启动失败|连接复位/.test(msg);
        if (!transportDown) throw e; // 业务错误原样抛（如 -32031 历史模型校验拒 send）
        if (attempt >= STARTUP_ATTEMPTS || this.disposedFlag) {
          throw new Error(`app-server 启动失败（已重试 ${attempt} 次）：${msg}；stderr: ${this.conn.stderrTailText || "(empty)"}`);
        }
        this.log(`[aiti-zcode-agent] app-server 启动序列中断（attempt ${attempt}/${STARTUP_ATTEMPTS}），清理内存遗留后重拉：${msg}`);
        await sleep(STARTUP_BACKOFF_MS * attempt);
      }
    }
  }

  /** 启动序列（ensureReady 的可重试主体）：provider 注入 → create|resume → subscribe。 */
  private async ensureProtocolReady(): Promise<void> {
    // provider 注入（桌面端同款）：在 create/resume 之前——resume 校验历史模型在
    // provider registry 中，缺席触发 restoreWarning（-32031 拒 send，实测）
    if (this.opts.provider) {
      await this.upsertProvider();
    }
    if (!this.zcodeSid) {
      // 注：create 不带 model 参数——显式 model 会触发「persist model selection → config.json」
      // 报 -32603（真机验证）。ZCODE_MODEL env 只有 --prompt/oneshot 面认（判别探针实测生效），
      // app-server 面不读 env：create 的默认模型 = workspace 注册表首个可用模型（upsert 后即
      // bigmodel-coding-plan/GLM-5.3，桌面注册表序；runtime 侧 zcode_protocol.session_model 体系）。
      // 所以 create 后、首轮 send 前必须 setModel 对齐所选模型，否则新会话从首轮起就跑在
      // runtime 默认模型上（夜间免费窗口只认 Flash）。
      const snap = await this.conn.request<JsonRecord>("session/create", {
        workspace: { workspacePath: this.opts.cwd, workspaceKey: this.opts.cwd },
        persistence: "immediate",
        ...(toProtocolMode(this.opts.mode) ? { mode: toProtocolMode(this.opts.mode) } : {}),
      }, { timeoutMs: 120_000 });
      const sid = (snap?.session as JsonRecord | undefined)?.sessionId;
      if (typeof sid !== "string" || !sid) throw new Error("session/create 未返回 sessionId");
      this.zcodeSid = sid;
      this.opts.onSessionId?.(sid);
      this.log(`[aiti-zcode-agent] app-server session created: ${sid}`);
      // 无条件对齐模型（所选即所得，无显式/隐式之分）；persistAsWorkspaceLastUsed:false 与
      // resume 分支同款（persist 会 -32603）。失败不阻断启动：本轮回落 runtime 默认模型，
      // 下轮 resume 仍带 runtimeModel 再对齐。
      const createModel = this.opts.modelRef ? toProtocolModel(this.opts.modelRef) : null;
      if (createModel) {
        await this.setModelCompat(createModel, false).catch((e) =>
          this.log(`[aiti-zcode-agent] create 后 setModel 失败（本轮用 runtime 默认模型）: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (!this.subscribed) {
      // 跨进程复活：sess_xxx 持久于 ~/.zcode，resume 后重放历史。
      // 带 runtimeModel —— 服务端 xse 路径直接应用当前模型并清 restoreWarning；
      // 不带时历史模型若不在 catalog（env-only 通道常见）会设 restoreWarning → send 被 -32031 拒（2026-09-09 实测）。
      const runtimeModel = this.buildRuntimeModel();
      // 3.17+ 移除 resume 的 runtimeModel 键（strict schema 拒 unknown key 直接 -32603）
      // → 先带（旧 CLI 绕 -32031 restoreWarning 必需），命中 ZodError 形态失败再不带重试。
      let resumedWithoutRuntimeModel = false;
      const resumed = await this.conn.request<JsonRecord>("session/resume", {
        sessionId: this.zcodeSid,
        ...(runtimeModel ? { runtimeModel } : {}),
      }, { timeoutMs: 120_000 }).catch(async (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!runtimeModel || !/ZodError|unrecognized|Invalid input/i.test(msg)) throw e;
        this.log(`[aiti-zcode-agent] resume 带 runtimeModel 被拒（3.17+ 已移除该键），无 runtimeModel 重试: ${msg.slice(0, 120)}`);
        resumedWithoutRuntimeModel = true;
        return this.conn.request<JsonRecord>("session/resume", { sessionId: this.zcodeSid }, { timeoutMs: 120_000 });
      });
      // resume 响应即快照同构（真机实证含 todos）→ 任务列表种子（跨进程复活/刷新恢复）
      this.seedTaskListFromSnapshot(resumed?.todos);
      if (!runtimeModel || resumedWithoutRuntimeModel) {
        // 无 provider 信息（runtimeModel 构造不出 → 旧 CLI setModel 兜底）或 3.17+ 重试路径（
        // runtimeModel 通道已废 → 显式 setModel 对齐模型，配套 personal provider config 的 registry 注册）
        const model = this.opts.modelRef ? toProtocolModel(this.opts.modelRef) : null;
        if (model) {
          // persistAsWorkspaceLastUsed:false —— env-only 模式无 config.json，持久化会报错（真机验证）
          await this.setModelCompat(model, false).catch((e) =>
            this.log(`[aiti-zcode-agent] resume 后 setModel 失败（不影响本轮）: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      this.log(`[aiti-zcode-agent] app-server session resumed: ${this.zcodeSid}`);
    }
    if (!this.subscribed) {
      await this.conn.request("session/subscribe", {
        sessionId: this.zcodeSid,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      }, { timeoutMs: 30_000 });
      this.subscribed = true;
    }
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.conn.handleReverseRequest("session/requestRuntimePreferences", () => RUNTIME_PREFERENCES_ANSWER);
    this.conn.handleReverseRequest("interaction/requestPermission", (p) => {
      this.log(`[aiti-zcode-agent] 权限自动放行（backend 语义）: ${String(p.toolName ?? "?")}`);
      return { decision: "allow" };
    });
    this.conn.handleReverseRequest("interaction/requestUserInput", (p) => this.onUserInputRequest(p));
    this.conn.handleReverseRequest("interaction/requestProviderRuntimeHeaders", (p) => this.onProviderHeadersRequest(p));
    this.offNotification = this.conn.onNotification((method, params) => {
      if (method === "session/event") this.onSessionEvent(params);
    });
    this.offExit = this.conn.onExit(() => {
      this.ready = false;
      this.subscribed = false;
      this.failWaiters(new Error("app-server 进程退出，本轮中断"));
    });
  }

  /**
   * provider 注入（桌面端同款 workspace/upsertModelProvider）：凭据与模型目录纯内存注册。
   * `headers` 供 start-plan 验证码回填（`x-aliyun-captcha-verify-param` 等）——桌面端同机制
   * （解验后带 headers 重 upsert，providerRevision 前进，CLI 请求即携带）。
   */
  private async upsertProvider(headers?: Record<string, string>): Promise<void> {
    const p = this.opts.provider;
    if (!p) return;
    const cleanHeaders = headers && Object.keys(headers).length > 0 ? headers : undefined;
    await this.conn.request("workspace/upsertModelProvider", {
      workspace: { workspacePath: this.opts.cwd, workspaceKey: this.opts.cwd },
      provider: {
        providerId: p.providerId,
        kind: "anthropic",
        source: "workspace",
        label: "BigModel",
        baseURL: p.baseURL,
        apiKey: { source: "inline", value: p.apiKey },
        models: p.models.map((m) => ({ modelId: m.modelId, ...(m.label ? { label: m.label } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })),
        ...(cleanHeaders ? { headers: cleanHeaders } : {}),
      },
    }, { timeoutMs: 30_000 }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // 3.17+ 已移除该 RPC（-32601 Method not found）→ 常态静默（personal provider config 接管模型注册）
      if (/Method not found/i.test(msg)) return;
      this.log(`[aiti-zcode-agent] upsertModelProvider 失败（继续，env 通道兜底）: ${msg}`);
    });
  }

  /**
   * `interaction/requestProviderRuntimeHeaders`（start-plan 验证码协议，analysis §9.2）：
   * 调求解器取 captchaVerifyParam → 带 headers 重 upsert provider → 应答 `{headersApplied:true}`；
   * 未配置求解器 / 求解失败 / 超时 → `{headersApplied:false, errorMessage}`（result schema 是 strict zod，
   * 只允许 headersApplied/errorMessage/providerRevision 三键）。
   */
  private async onProviderHeadersRequest(p: JsonRecord): Promise<JsonRecord> {
    const requestId = String(p.requestId ?? "");
    const providerId = String(p.providerId ?? "");
    const reason = String(p.reason ?? "model-request");
    const solver = this.opts.onProviderHeadersRequest;
    if (!solver || !this.opts.provider) {
      return { headersApplied: false, errorMessage: "验证码求解器未配置（start-plan 桥接未启用）" };
    }
    try {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        solver({ requestId, providerId, modelRef: String(p.modelRef ?? ""), reason }),
        new Promise<{ ok: false; errorMessage: string }>((resolve) => {
          waitTimer = setTimeout(() => resolve({ ok: false, errorMessage: `等待验证码求解超时（${PROVIDER_HEADERS_WAIT_MS / 1000}s）` }), PROVIDER_HEADERS_WAIT_MS);
        }),
      ]);
      clearTimeout(waitTimer); // race 输者不再拖着事件循环（测试进程退出依赖此项）
      if (!answer.ok) {
        this.log(`[aiti-zcode-agent] provider headers 求解失败（${reason}）: ${answer.errorMessage}`);
        return { headersApplied: false, errorMessage: answer.errorMessage };
      }
      const headers: Record<string, string> = { "x-aliyun-captcha-verify-param": answer.captchaVerifyParam };
      if (answer.region) headers["x-aliyun-captcha-verify-region"] = answer.region;
      await this.upsertProvider(headers);
      this.log(`[aiti-zcode-agent] provider headers 已回填（${providerId}，reason=${reason}，param ${answer.captchaVerifyParam.length}B）`);
      return { headersApplied: true };
    } catch (e) {
      return { headersApplied: false, errorMessage: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * setModel 双版本兼容发送：先裸发（旧 CLI 3.16- 无 options 即成功）；命中
   * "Reasoning level is required"（3.17+ registry 模型声明档位）再补 options 重试。
   * 注意 options 挂在 model 对象内（Nl = {providerId, modelId, options?}），不是请求顶层。
   * 反向顺序（先带 options）在旧 CLI 上会被 strict schema 拒 unknown key，不可取。
   */
  private async setModelCompat(model: { providerId: string; modelId: string }, persistAsWorkspaceLastUsed: boolean): Promise<void> {
    const base = { sessionId: this.zcodeSid, model, persistAsWorkspaceLastUsed };
    try {
      await this.conn.request("session/setModel", base, { timeoutMs: 30_000 });
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Reasoning level is required/i.test(msg)) throw e;
    }
    await this.conn.request("session/setModel", {
      sessionId: this.zcodeSid,
      model: { ...model, options: { reasoningLevel: ZCODE_REASONING_LEVEL } },
      persistAsWorkspaceLastUsed,
    }, { timeoutMs: 30_000 });
  }

  /** 存储被外部改动（如 oneshot --attach 轮次写入同一会话）后，强制下次冷 resume 重读历史。 */
  async refreshFromStorage(): Promise<void> {
    if (!this.ready || !this.zcodeSid || !this.conn.isAlive()) return;
    await this.conn.request("session/close", { sessionId: this.zcodeSid }, { timeoutMs: 15_000 }).catch(() => {});
    this.ready = false;
    this.subscribed = false;
  }

  /** 热切模型（session/setModel，桌面端同款即时生效；不落 config.json —— env-only 合规约束）。 */
  async setModel(modelRef: string): Promise<void> {
    const model = toProtocolModel(modelRef);
    if (!model) throw new Error(`非法模型 ref "${modelRef}"`);
    if (!this.ready || !this.zcodeSid) return; // 未就绪：仅记录，create/resume 时生效
    await this.setModelCompat(model, false);
  }

  /**
   * 构造 runtimeModel（v1 协议 `session/resume` / `session/send` 的 runtimeModel 字段）：
   * 携带后服务端走 xse 路径直接应用模型 + 清 restoreWarning（-32031 拒 send 的唯一出口，2026-09-09 实测）。
   * 无 provider 或 modelRef 时返回 undefined（调用方回退原路径）。
   */
  private buildRuntimeModel(): JsonRecord | undefined {
    const { provider, modelRef } = this.opts;
    if (!provider || !modelRef) return undefined;
    const model = toProtocolModel(modelRef);
    if (!model) return undefined;
    return {
      revision: "0",
      generatedAt: Date.now(),
      model,
      provider: {
        providerId: provider.providerId,
        kind: "anthropic",
        source: "workspace",
        ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
        apiKey: { source: "inline", value: provider.apiKey },
        models: provider.models.map((m) => ({
          modelId: m.modelId,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        })),
      },
    };
  }

  /** 热切权限模式（session/setMode，即时生效）。 */
  async setMode(mode: string): Promise<void> {
    const m = toProtocolMode(mode);
    if (!m) return;
    if (!this.ready || !this.zcodeSid) return;
    await this.conn.request("session/setMode", { sessionId: this.zcodeSid, mode: m }, { timeoutMs: 30_000 });
  }

  /** abort：session/stop（桌面端同款）；turn 以 resultType=cancelled 收口。
   *  超时从 15s 缩到 5s：abort() 已 fire-and-forget 调本方法，RPC 不快回即视为失步，
   *  由 abort 看门狗（6s 上限）强杀兜底——不再让 stop 卡满 15s。 */
  async stop(): Promise<void> {
    if (!this.ready || !this.zcodeSid || this.turnWaiters.size === 0) return;
    await this.conn.request("session/stop", { sessionId: this.zcodeSid }, { timeoutMs: 5_000 })
      .catch((e) => this.log(`[aiti-zcode-agent] session/stop 失败（abort 看门狗将兜底）: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** abort 看门狗强杀入口：SIGTERM 杀 app-server 子进程 → onExit → failWaiters 收口本轮。
   *  兜底场景：zcode 端 turn 挂死且协议层 hadActivePrompt 失步，session/stop 永远 no-op（2026-09-09 实测）。 */
  kill(): void {
    this.conn.kill();
  }

  /**
   * session/fork（桌面端同款）：从第 turnIndex 轮（0-based，按 user 消息计）的 assistant
   * 回复处分叉出子会话——子会话历史 = 该回复及之前全部，之后的文件快照按 zcode 自有
   * checkpoint 语义回退。服务端限制：prompt 运行中拒绝（"Cannot fork while a prompt is
   * running"，映射为人话上抛）。分叉不本会话就地生效——调用方拿 forkedSessionId 自行
   * 重建通道（dispose 本 session → 下轮 prompt 以新 sid resume）。
   */
  async forkFromTurn(turnIndex: number): Promise<string> {
    if (!this.zcodeSid) throw new Error("fork unavailable (zcode session not established)");
    await this.ensureReady();
    let r: JsonRecord;
    try {
      r = await this.conn.request<Record<string, unknown>>("session/fork", {
        sessionId: this.zcodeSid,
        target: { kind: "turn", turnIndex },
      }, { timeoutMs: 120_000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Cannot fork while/i.test(msg)) throw new Error("运行中不允许分叉（zcode 限制）：请先停止当前轮再编辑/分叉");
      throw e;
    }
    const forked = r?.forkedSessionId;
    if (typeof forked !== "string" || !forked) throw new Error("session/fork 未返回 forkedSessionId");
    return forked;
  }

  /**
   * v4/command sendText{requestedDelivery:"guide"} —— desktop 同款 steer（2026-09-10 协议逆向 + 真机实测）：
   * 运行中注入当前轮，runtime 在下一模型/工具间隙 drain（turn.steerDrained 出队），模型同轮即答。
   * 空闲调用会被 v4 网关拒绝（sessionNotFound / FK）——仅 running 时调用；任何非 accepted
   * ack 都 throw → 共享层 R9 降级本地 followUp 队列（消息不丢）。
   */
  async steerViaCommand(text: string): Promise<void> {
    if (!this.ready || !this.zcodeSid) throw new Error("steer unavailable (app-server not ready)");
    const ack = (await this.conn.request("v4/command", {
      commandId: `aiti-steer-${Date.now()}-${++this.v4SteerSeq}`,
      clientId: "aiti-zcode-agent",
      sessionId: this.zcodeSid,
      issuedAt: Date.now(),
      type: "sendText",
      payload: { text, requestedDelivery: "guide" },
    }, { timeoutMs: 20_000 })) as JsonRecord;
    const status = String(ack.status ?? "");
    if (status !== "accepted") {
      throw new Error(`v4 steer ${status || "no-ack"}: ${String(ack.reasonCode ?? ack.message ?? "unknown")}`);
    }
  }

  /**
   * 发一轮（空闲调用；运行中由 handle 队列层拦截，不走到这）。resolve 于本轮收口。
   * 带图时随 send 内联 attachments——v1 面的形状是 {kind:"image",dataBase64,mimeType,filename,sizeBytes}
   * （runtime SLi 映射；缺 dataBase64 会被静默过滤掉图，桌面 v4 面的 {ref,...} 形状在本面不适用）。
   */
  async prompt(content: string, images?: TurnImageLike[]): Promise<TurnOutcome> {
    await this.ensureReady();
    this.turnSettled = false;
    const outcome = this.registerWaiter();
    const sessionId = this.zcodeSid;
    if (!sessionId) {
      this.turnWaiters.delete(outcome.entry);
      throw new Error("session/send unavailable (no sessionId)");
    }
    const attachments = images?.length
      ? images.map((img, i) => ({
          kind: "image",
          dataBase64: img.data,
          mimeType: img.mimeType,
          filename: img.filename || `image-${i + 1}.${(img.mimeType.split("/")[1] || "png").replace(/[^a-z0-9.+-]/gi, "")}`,
          sizeBytes: Buffer.from(img.data, "base64").length,
        }))
      : undefined;
    const sendParams: JsonRecord = { sessionId, content, ...(attachments ? { attachments } : {}) };
    try {
      await this.conn.request("session/send", sendParams, { timeoutMs: 20_000 });
    } catch (e) {
      this.turnWaiters.delete(outcome.entry);
      const err = e instanceof Error ? e : new Error(String(e));
      // -32031（历史模型在校验时不在 registry，restoreWarning 拒 send）：带 runtimeModel 重发一次——
      // 服务端走 xse 路径应用模型并清 restoreWarning（resume 已带 runtimeModel 时理论不到这，双保险；2026-09-09 实测双向可行）
      const rm = this.buildRuntimeModel();
      if (err.message.includes("-32031") && rm) {
        this.log(`[aiti-zcode-agent] send 遇 -32031（历史模型不可用），携带 runtimeModel 重试`);
        const retryOutcome = this.registerWaiter();
        try {
          await this.conn.request("session/send", { ...sendParams, runtimeModel: rm }, { timeoutMs: 20_000 });
          return await retryOutcome.promise;
        } catch (e2) {
          this.turnWaiters.delete(retryOutcome.entry);
          throw e2 instanceof Error ? e2 : new Error(String(e2));
        }
      }
      throw err;
    }
    return await outcome.promise;
  }

  async dispose(): Promise<void> {
    this.disposedFlag = true;
    this.turnSettled = true;
    this.failPendingInteractions("session disposed");
    if (this.ready && this.zcodeSid && this.conn.isAlive()) {
      await this.conn.request("session/close", { sessionId: this.zcodeSid }, { timeoutMs: 5_000 }).catch(() => {});
    }
    this.ready = false;
    this.failWaiters(new Error("session disposed"));
    this.conn.kill();
    this.offNotification?.();
    this.offExit?.();
    this.offNotification = null;
    this.offExit = null;
    this.wired = false;
  }

  // ------------------------------------------------------------------
  // 交互元语桥接（interaction/requestUserInput → pi-web 前端审批/问题卡）
  // ------------------------------------------------------------------

  /**
   * interaction/requestUserInput 反向请求入口（wire 注册；reannounce 重发同 requestId → 幂等）。
   * zcode 端无总超时（持续 reannounce 直到应答/turn 结束），挂起等 respondInteraction。
   */
  private onUserInputRequest(p: UserInputRequestParams): Promise<JsonRecord> | JsonRecord {
    const requestId = typeof p.requestId === "string" && p.requestId ? p.requestId : "";
    if (!requestId) return { action: "decline", reason: "missing requestId" };
    // 幂等：reannounce 重发（同 requestId）→ 返回同一挂起 promise，并重新 emit 事件
    // （前端 SSE 重连/刷新后卡片丢失，靠 ≤10s 一次的 reannounce 重发把卡片带回来）
    const existing = this.pendingInteractions.get(requestId);
    if (existing) {
      this.emit(existing.event);
      return existing.promise;
    }
    // turn 已收口（反向请求与收口帧竞态到达）：不挂起不 emit，直接 decline（否则永远无人应答）
    if (this.turnSettled) return { action: "decline", reason: "turn already ended" };

    const schema = (p.schema ?? {}) as JsonRecord;
    const toolName = typeof p.toolName === "string" ? p.toolName : "";
    const kind: PendingInteraction["kind"] =
      schema.interaction === "plan_approval" ? "plan_approval"
        : toolName === "AskUserQuestion" ? "ask_user"
          : "generic";

    // 事件负载：plan 全文 / 问题组归一化（options 只留 label/description）
    const input = (p.input ?? {}) as JsonRecord;
    const plan = typeof input.plan === "string" ? input.plan : "";
    const questions = normalizeQuestions(p.questions);

    let resolve!: (answer: JsonRecord) => void;
    const promise = new Promise<JsonRecord>((r) => { resolve = r; });
    const event: JsonRecord = {
      type: "interaction_request",
      requestId,
      kind,
      ...(toolName ? { toolName } : {}),
      ...(typeof p.prompt === "string" && p.prompt ? { prompt: p.prompt } : {}),
      ...(kind === "plan_approval" && plan ? { plan } : {}),
      ...(questions.length > 0 ? { questions } : {}),
      ...(kind === "generic" ? { input } : {}),
    };
    this.pendingInteractions.set(requestId, { kind, requestId, promise, resolve, event });
    this.emit(event);
    this.log(`[aiti-zcode-agent] 交互请求已桥接前端: kind=${kind} tool=${toolName || "?"} requestId=${requestId}`);
    return promise;
  }

  /**
   * 用户作答回填（pi-web handle.respondInteraction 落点）。
   * 返回 false = 请求不存在/已失效（turn 收口清理、未知 id）。
   */
  respondInteraction(requestId: string, answer: InteractionAnswerInput): boolean {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) return false;
    this.pendingInteractions.delete(requestId);
    pending.resolve(buildUserInputAnswer(pending.kind, answer));
    // 广播失效帧：多端（多标签页）同步清卡
    this.emit({ type: "interaction_expired", requestId, reason: "resolved" });
    return true;
  }

  /** turn 收口 / dispose：未决交互一律 decline（zcode 端 agent 收到拒绝继续/收尾），并广播失效帧。 */
  private failPendingInteractions(reason: string): void {
    for (const [requestId, pending] of this.pendingInteractions) {
      pending.resolve({ action: "decline", reason });
      this.emit({ type: "interaction_expired", requestId, reason });
    }
    this.pendingInteractions.clear();
  }

  // ------------------------------------------------------------------
  // 轮次等待
  // ------------------------------------------------------------------

  private registerWaiter(): { promise: Promise<TurnOutcome>; entry: WaiterEntry } {
    let entry!: WaiterEntry;
    const promise = new Promise<TurnOutcome>((resolve, reject) => {
      entry = { resolve, reject };
    });
    this.turnWaiters.add(entry);
    return { promise, entry };
 }

  private failWaiters(err: Error): void {
    for (const fn of this.turnWaiters) fn.reject(err);
    this.turnWaiters.clear();
  }

  private notifySteerQueue(): void {
    this.opts.onSteerQueue?.(this.steerQueue.map((s) => ({ ...s })));
  }

  /** TodoWrite 族工具事件派生（input 优先、output 兜底；共享层去重后回调）。 */
  private maybeUpdateTaskList(toolName: string, ...values: unknown[]): void {
    this.tasks.fromToolEvent(toolName, ...values);
  }

  /** resume 快照种子（`todos` wire 同构；防御式逐条解析，空/失败静默保持现状）。 */
  private seedTaskListFromSnapshot(raw: unknown): void {
    this.tasks.seed(raw);
  }

  private finishTurn(o: TurnOutcome): void {
    this.closeStream();
    this.seenToolStarts.clear();
    this.turnSettled = true;
    this.failPendingInteractions("turn ended");
    if (this.steerQueue.length > 0) {
      this.steerQueue = [];
      this.notifySteerQueue();
    }
    this.emit({ type: "agent_end" });
    if (o.errorMessage) {
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: o.errorMessage,
          ...(this.opts.modelRef ? { model: this.opts.modelRef } : {}),
          provider: "zcode",
        },
      });
      this.emit({ type: "agent_settled_error", error: o.errorMessage });
      this.emit({ type: "agent_settled", stopReason: "error", error: o.errorMessage });
    } else {
      this.emit({ type: "agent_settled", stopReason: o.cancelled ? "aborted" : "end_turn" });
    }
    for (const fn of this.turnWaiters) fn.resolve(o);
    this.turnWaiters.clear();
  }

  // ------------------------------------------------------------------
  // session/event → pi 事件
  // ------------------------------------------------------------------

  private onSessionEvent(env: JsonRecord): void {
    // 防御过滤：单连接单会话设计下恒等；防未来共享连接时串扰
    if (this.zcodeSid && typeof env.sessionId === "string" && env.sessionId && env.sessionId !== this.zcodeSid) return;
    const type = env.type;
    const p = (env.payload ?? {}) as JsonRecord;
    switch (type) {
      case "model.streaming": this.onModelStreaming(p); break;
      case "tool.updated": this.onToolUpdated(p); break;
      case "turn.completed": {
        const cache = (p.cacheStats ?? {}) as JsonRecord;
        this.finishTurn({
          cancelled: p.resultType === "cancelled",
          resultType: typeof p.resultType === "string" ? p.resultType : undefined,
          tokenCount: num(p.tokenCount) ?? null,
          usage: parseUsageSnapshot(p.usage),
          durationMs: num(p.duration) ?? null,
          cacheReadTokens: num(cache.cacheReadTokens) ?? null,
        });
        break;
      }
      case "turn.failed": {
        const err = (p.error ?? {}) as JsonRecord;
        this.finishTurn({ cancelled: false, errorMessage: String(err.message ?? "zcode turn failed") });
        break;
      }
      case "turn.steerQueued": {
        const id = String(p.pendingInputId ?? "");
        const input = String(p.input ?? "");
        if (id && input && !this.steerQueue.some((s) => s.pendingInputId === id)) {
          this.steerQueue.push({ pendingInputId: id, input });
          this.notifySteerQueue();
        }
        break;
      }
      case "turn.steerDrained":
      case "turn.steerDiscarded": {
        const ids = Array.isArray(p.pendingInputIds) ? p.pendingInputIds.map(String) : [];
        if (ids.length > 0) {
          this.steerQueue = this.steerQueue.filter((s) => !ids.includes(s.pendingInputId));
          this.notifySteerQueue();
        }
        break;
      }
      default: break; // session.updated / titleUpdated / steer* / usage 等：P1 不消费
    }
  }

  // ---- model.streaming → pi text/thinking/toolcall 三线 ----
  // 真机 wire（2026-09-07 实测）：帧可能不带 partId、可能缺 *_start 起始帧、tool 帧靠 toolCallId
  // 定位 —— 桌面端同款「追加 + 容忍缺失」：显式 partId 优先，无则按 kind 隐式续块；
  // 缺 assistantMessageId 的帧视为「延续当前消息」。

  private onModelStreaming(p: JsonRecord): void {
    const kind = String(p.kind ?? "");
    const partId = typeof p.partId === "string" && p.partId ? p.partId : null;
    // 缺 assistantMessageId → 延续当前开着的消息（真机部分帧不带）
    const assistantMessageId = typeof p.assistantMessageId === "string" && p.assistantMessageId
      ? p.assistantMessageId
      : this.stream?.assistantMessageId ?? "assistant";
    switch (kind) {
      case "text_start":
      case "reasoning_start":
      case "tool_input_start": {
        this.ensureOpen(assistantMessageId);
        // 显式 partId 已映射 → 幂等；否则建块（ensureBlock 内发 *_start）
        if (partId && this.streamIndex(partId) !== null) break;
        this.ensureBlock(kind === "text_start" ? "text" : kind === "reasoning_start" ? "reasoning" : "tool", partId, p);
        break;
      }
      case "text_delta":
      case "reasoning_delta":
      case "tool_input_delta": {
        this.ensureOpen(assistantMessageId);
        const idx = this.locateBlock(kind, partId, p);
        if (idx === null) break;
        const delta = String(p.delta ?? "");
        const acc = this.stream!.acc.get(idx);
        if (!acc) break;
        if (kind === "text_delta" && acc.kind === "text") {
          acc.text += delta;
          this.emitDelta({ type: "text_delta", contentIndex: idx, delta });
        } else if (kind === "reasoning_delta" && acc.kind === "thinking") {
          acc.thinking += delta;
          this.emitDelta({ type: "thinking_delta", contentIndex: idx, delta });
        } else if (kind === "tool_input_delta" && acc.kind === "tool") {
          acc.rawInput += delta;
          this.emitDelta({ type: "toolcall_delta", contentIndex: idx, id: acc.toolCallId, toolName: acc.toolName, delta });
        }
        break;
      }
      case "text_end":
      case "reasoning_end": {
        const idx = this.locateBlock(kind, partId, p);
        if (idx === null || !this.stream) break;
        const acc = this.stream.acc.get(idx);
        if (!acc) break;
        if (kind === "text_end" && acc.kind === "text") {
          this.emitDelta({ type: "text_end", contentIndex: idx, content: acc.text });
        } else if (kind === "reasoning_end" && acc.kind === "thinking") {
          this.emitDelta({ type: "thinking_end", contentIndex: idx, content: acc.thinking });
        }
        break;
      }
      case "tool_input_end":
        break; // 等待 tool_call（arguments 定型）
      case "tool_call": {
        if (!this.stream) break;
        const callId = String(p.toolCallId ?? "");
        const idx = (callId ? this.stream.toolByCallId.get(callId) : undefined) ?? (partId ? this.streamIndex(partId) : null);
        if (idx === null || idx === undefined) break;
        const acc = this.stream.acc.get(idx);
        if (!acc || acc.kind !== "tool") break;
        const block = this.stream.blocks[idx];
        if (block?.type === "toolCall") block.input = parseJsonInput(acc.rawInput);
        this.emitDelta({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: { id: acc.toolCallId, name: block?.type === "toolCall" ? block.toolName : acc.toolName, arguments: block?.type === "toolCall" ? block.input : {} },
        });
        // 流式输入定型的第一时间派生任务列表（真机 wire：scheduled 事件的 input 会被
        // 剥掉——inputOmitted/inputRef:"model_stream"（runtime wLi），此帧是唯一带全量
        // 参数的实时源）
        this.maybeUpdateTaskList(acc.toolName, block?.type === "toolCall" ? block.input : acc.rawInput);
        break;
      }
      default: break; // start/finish/error：控制帧，不映射
    }
  }

  private ensureOpen(assistantMessageId: string): void {
    if (this.stream && this.stream.assistantMessageId !== assistantMessageId) this.closeStream();
    if (!this.stream) {
      this.stream = { assistantMessageId, blocks: [], index: new Map(), acc: new Map(), toolByCallId: new Map(), implicit: {} };
      this.emit({
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          ...(this.opts.modelRef ? { model: this.opts.modelRef } : {}),
          provider: "zcode",
        },
      });
    }
  }

  /** delta/end 帧定位块：显式 partId → 隐式指针/toolCallId；块缺失时自动建块（含 *_start 发射）。 */
  private locateBlock(kind: string, partId: string | null, p: JsonRecord): number | null {
    if (!this.stream) return null;
    if (partId) {
      const mapped = this.streamIndex(partId);
      if (mapped !== null) return mapped;
      return this.ensureBlock(kind.startsWith("text") ? "text" : kind.startsWith("reasoning") ? "reasoning" : "tool", partId, p);
    }
    if (kind.startsWith("tool")) {
      const callId = String(p.toolCallId ?? "");
      if (callId) {
        const hit = this.stream.toolByCallId.get(callId);
        if (hit !== undefined) return hit;
        return this.ensureBlock("tool", null, { ...p, toolCallId: callId });
      }
      const implicitTool = this.stream.implicit.tool;
      return implicitTool ?? this.ensureBlock("tool", null, p);
    }
    const isText = kind.startsWith("text");
    const implicit = isText ? this.stream.implicit.text : this.stream.implicit.reasoning;
    return implicit ?? this.ensureBlock(isText ? "text" : "reasoning", null, p);
  }

  /** 建新块（占位 + acc 播种 + 隐式指针/toolCallId 登记 + 对应 *_start 发射）。partId 已映射时返回 null。 */
  private ensureBlock(kind: "text" | "reasoning" | "tool", partId: string | null, p: JsonRecord): number | null {
    const s = this.stream!;
    if (partId && s.index.has(partId)) return null;
    const idx = s.blocks.length;
    s.blocks.push({ type: "text", text: "" }); // 占位，下方立即覆写
    if (partId) s.index.set(partId, idx);
    if (kind === "text") {
      s.blocks[idx] = { type: "text", text: "" };
      s.acc.set(idx, { kind: "text", text: "" });
      s.implicit.text = idx;
      this.emitDelta({ type: "text_start", contentIndex: idx });
    } else if (kind === "reasoning") {
      s.blocks[idx] = { type: "thinking", thinking: "" };
      s.acc.set(idx, { kind: "thinking", thinking: "" });
      s.implicit.reasoning = idx;
      this.emitDelta({ type: "thinking_start", contentIndex: idx });
    } else {
      const toolCallId = String(p.toolCallId ?? `call_${idx}`);
      const toolName = String(p.toolName ?? "tool");
      s.blocks[idx] = { type: "toolCall", toolCallId, toolName, input: {} };
      s.acc.set(idx, { kind: "tool", rawInput: "", toolCallId, toolName });
      s.toolByCallId.set(toolCallId, idx);
      s.implicit.tool = idx;
      this.toolNameByCallId.set(toolCallId, toolName);
      this.emitDelta({ type: "toolcall_start", contentIndex: idx, id: toolCallId, toolName });
    }
    return idx;
  }

  private streamIndex(partId: string): number | null {
    return this.stream?.index.get(partId) ?? null;
  }

  private emitDelta(assistantMessageEvent: JsonRecord): void {
    this.emit({ type: "message_update", assistantMessageEvent });
  }

  /** 封口当前流式 assistant 消息（message_end + 最终 content 块）。 */
  private closeStream(): void {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    // 最终块从 acc 取终值（增量累积在 acc；blocks 只定顺序/类型）
    const content: StreamBlock[] = [];
    for (let i = 0; i < s.blocks.length; i++) {
      const block = s.blocks[i];
      const acc = s.acc.get(i);
      if (!block) continue;
      if (block.type === "text") content.push({ type: "text", text: acc?.kind === "text" ? acc.text : block.text });
      else if (block.type === "thinking") content.push({ type: "thinking", thinking: acc?.kind === "thinking" ? acc.thinking : block.thinking });
      else if (block.type === "toolCall") content.push({ ...block });
    }
    // 全空（无有效文本/思考/工具块）不落空泡
    const meaningful = content.some((b) =>
      b.type === "toolCall"
      || (b.type === "thinking" && b.thinking.length > 0)
      || (b.type === "text" && b.text.length > 0));
    if (!meaningful) return;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content,
        ...(this.opts.modelRef ? { model: this.opts.modelRef } : {}),
        provider: "zcode",
      },
    });
  }

  // ---- tool.updated：执行面事件 + 工具结果卡 ----

  private onToolUpdated(p: JsonRecord): void {
    const kind = String(p.kind ?? "");
    const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
    const toolName = typeof p.toolName === "string" ? p.toolName : "";
    switch (kind) {
      case "scheduled":
      case "started": {
        if (!toolCallId || this.seenToolStarts.has(toolCallId)) break;
        this.seenToolStarts.add(toolCallId);
        if (toolName) this.toolNameByCallId.set(toolCallId, toolName);
        // TodoWrite 族：input 已带全量任务列表（真机 wire 常被剥 input——见 tool_call 帧兜底）
        this.maybeUpdateTaskList(toolName, p.input);
        // pi 原生时序：工具执行前封口当前流式消息段（assistant 消息含 toolCall 块）
        this.closeStream();
        this.emit({ type: "tool_execution_start", toolCallId, toolName });
        break;
      }
      case "progress": {
        const text = toolProgressText(p);
        if (!text) break;
        this.emit({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          partialResult: { content: [{ type: "text", text }] },
        });
        break;
      }
      case "result": {
        const result = (p.result ?? {}) as JsonRecord;
        // MCP todo_write/update_plan 变体的列表可能在 output（桌面 CPt 兜底路）；
        // toolName 缺帧时按 callId 反查（流式/tool 帧登记）
        this.maybeUpdateTaskList(toolName || this.toolNameByCallId.get(toolCallId) || "", result.output, result.content);
        const output = typeof result.output === "string" && result.output
          ? result.output
          : typeof result.content === "string" ? result.content : "(工具执行完成，无文本输出)";
        this.emit({ type: "tool_execution_end", toolCallId });
        this.emit({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId,
            ...(toolName ? { toolName } : {}),
            content: [{ type: "text", text: output }],
            isError: false,
            timestamp: Date.now(),
          },
        });
        break;
      }
      case "error": {
        const err = (p.error ?? {}) as JsonRecord;
        this.emit({ type: "tool_execution_end", toolCallId });
        this.emit({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId,
            ...(toolName ? { toolName } : {}),
            content: [{ type: "text", text: String(err.message ?? "工具执行失败") }],
            isError: true,
            timestamp: Date.now(),
          },
        });
        break;
      }
      default: break; // batch/raw：不映射
    }
  }
}

function parseJsonInput(raw: string): JsonRecord {
  const s = raw.trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as JsonRecord : { _raw: s };
  } catch {
    return { _raw: s };
  }
}

/**
 * 反向请求 questions → 事件负载归一化（防御式：非法条目跳过）。
 * question 文本是答案寻址键（zcode 端 ONi 按 input.questions[].question 匹配 answers），必须原样保留。
 */
function normalizeQuestions(raw: unknown): Array<{
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ header?: string; question: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as JsonRecord;
    const question = typeof q.question === "string" ? q.question : "";
    if (!question) continue;
    const options: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (!o || typeof o !== "object") continue;
        const label = typeof (o as JsonRecord).label === "string" ? (o as JsonRecord).label as string : "";
        if (!label) continue;
        const description = typeof (o as JsonRecord).description === "string" ? (o as JsonRecord).description as string : undefined;
        options.push(description ? { label, description } : { label });
      }
    }
    out.push({
      question,
      ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

/**
 * 用户回答 → zcode 应答帧（runtime 0.16.5 逆向契约，实测语义见文件头注释）：
 * - plan_approval：批准 = accept+answer:"approve"；带反馈 = accept+answer:"<反馈>"（zcode 归一为 deny+reason，agent 继续改方案）；直接拒绝 = decline。
 * - ask_user：accept+answers（key=问题文本，值=label 或 label[]）；前端「附加说明」文本经
 *   answer.message 传入 → annotations（每道已答题挂 {notes}——zcode 契约的自由文本注记，
 *   schema: annotations: Record<问题文本,{notes?}>，随 tool result 回给模型）；拒绝 = decline。
 * - generic：accept 空 content / decline。
 */
function buildUserInputAnswer(kind: PendingInteraction["kind"], answer: InteractionAnswerInput): JsonRecord {
  if (answer.action !== "accept") {
    return { action: "decline", ...(answer.message ? { reason: answer.message } : {}) };
  }
  if (kind === "plan_approval") {
    return { action: "accept", content: { answer: answer.message?.trim() || PLAN_APPROVE_ANSWER } };
  }
  if (kind === "ask_user" && answer.answers) {
    const note = answer.message?.trim();
    const annotations = note
      ? Object.fromEntries(Object.keys(answer.answers).map((q) => [q, { notes: note }]))
      : undefined;
    return { action: "accept", content: { answers: answer.answers, ...(annotations ? { annotations } : {}) } };
  }
  return { action: "accept", content: {} };
}

function toolProgressText(p: JsonRecord): string {
  const stdoutTail = typeof p.stdoutTail === "string" ? p.stdoutTail.trim() : "";
  if (stdoutTail) return stdoutTail.split("\n").pop()?.slice(0, 400) || stdoutTail.slice(-400);
  const stderrTail = typeof p.stderrTail === "string" ? p.stderrTail.trim() : "";
  if (stderrTail) return stderrTail.split("\n").pop()?.slice(0, 400) || stderrTail.slice(-400);
  const elapsed = num(p.elapsedMs);
  if (elapsed !== undefined) return `运行中 ${elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`}`;
  return "";
}
