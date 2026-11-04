/**
 * codebuddy-handles —— aiti-codebuddy-agent 会话 handle 实现（长连接 stream + 单发 exec 双模式）。
 *
 * 进程模型（2026-09-12 起默认 stream，参照 aiti-claude-code-agent 常驻实现）：
 *   stream：`cbc -p --input-format stream-json --output-format stream-json
 *            --include-partial-messages --verbose [--model M]
 *            [--permission-mode X] [--resume sid]` 单进程多轮：
 *     stdin  ← {"type":"user","message":{...}}                  用户消息（空闲时）
 *     stdin  ← {"type":"control_request",...}                   interrupt / set_model / set_permission_mode
 *     stdout → system/init | stream_event | assistant | result | control_response
 *   2.150.0 真机实测（2026-09-12 probe）：多轮同进程、resume 正常、control_request 三通道全支持
 *   （set_permission_mode/set_model 回 control_response{success}；interrupt 回 {interrupted:true}）。
 *   exec（兼容档，feature codebuddy.connectionMode=exec）：每轮 spawn + --resume（原单发实现）。
 *
 * 两模式共享：帧解析（codebuddy-core）、模型状态持久化、历史（liveHistory + seedHistory 回填）、
 * backend-queue 队列语义、会话 id 换绑（system/init → session_backend_ready）。
 * handle 侧不读功能配置（feature）：一切经 CodebuddyRuntime 注入，便于测试与复用。
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  CBC_MODELS, DEFAULT_MODEL, getCachedCbcModels,
  buildStreamArgs, buildTurnArgs, buildTurnEnv, controlRequestLine,
  deltaFromStreamEvent, execCbcTurn, extractTurnError, isSwallowedResult, parseAssistantFrame,
  toolResultsFromUserFrame, usageFromResult, userLine,
  type CbcCredentials, type CbcFrame, type CbcToolResult, type ResolvedCli, type TurnUsage,
} from "./codebuddy-core.ts";
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar, type BackendQueue, type QueueTurnImageLike } from "@aiti-ai/ext-shared/backend-queue";
import { spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// 冷恢复工具行回放共享口径（权威源 pi-web-ext/_shared/seed-tool.ts；D18 四家归一）
import { createSeedToolReplay } from "@aiti-ai/ext-shared/seed-tool";
import { join } from "node:path";

/** 队列崩溃恢复 sidecar 根（aiti-codebuddy-agent startup 捕获 <stateDir>；undefined/空 = 不持久化）。 */
let queueStateDir: string | undefined;
/** startup 注入 sidecar 根（index.ts 调用）。 */
export function setCodebuddyQueueStateDir(dir: string | undefined): void { queueStateDir = dir; }
import {
  mergeModelCatalogs, readExtModelState, readPiModels, renameExtModelState, withCurrentFirst,
  writeExtModelState, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

/** UUID 会话 id（cbc session_id 形态：01a08c07-5d59-73f3-97da-3dad574bea28）。 */
export const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// turn-ack（2026-09-12）：cbc stream-json + MCP 连通时，result 后极短窗口内写入会被吞
//（CLI 复读上一轮 result 且不启动新轮；延迟非单调、纯延时规避不可靠）——靠门控 + 活动确认 + 有界重写。
/** result 后写入前的最小静默窗（ms）。 */
const TURN_READY_DELAY_MS = 400;
/** 判定吞输入后的重写延迟（ms）。 */
const TURN_SWALLOW_RETRY_MS = 600;
/** 写入后既无活动也无 result 的静默看门狗（ms）。 */
const TURN_SILENCE_MS = 20_000;
/** 单轮最大重写次数（超限按错误收口，避免风暴）。 */
const MAX_TURN_RETRIES = 3;

/** 工具结果进 liveHistory 的文本上限（与 seedHistory/CLI jsonl 回填口径一致，防内存膨胀）。 */
const TOOL_RESULT_TEXT_CAP = 4000;

/** handle 侧运行环境（index.ts 以 feature/env 闭包实现；测试可注入桩）。 */
export interface CodebuddyRuntime {
  resolveCli(): ResolvedCli;
  effectiveCred(): CbcCredentials | null;
  bridgeUrl(): string;
  /** feature 默认模型（可能为空） */
  defaultModel(): string | undefined;
  /** feature 权限模式（default/acceptEdits/bypassPermissions/plan/dontAsk/auto） */
  permissionMode(): string;
}

export interface CodebuddyHandleInit {
  /** cbc 原生会话 id（resume 语义；空 = 全新会话，首轮 init 后换绑） */
  sessionId?: string;
  cwd: string;
  model?: { id: string; provider: string };
  runtime: CodebuddyRuntime;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;
}

/** 能力表（stream：长连接，control 三通道实测可用 → 运行中切换模型/权限、可应答工具授权）。 */
export const CBC_CAPABILITIES: SessionCapabilitiesLike = {
  steer: false, // 运行中注入无面（control_request 无 steer 通道）；输入一律入本地 followUp 队列
  followUp: true, // 长连接：轮间 stdin 续写 + 本地队列（settle 后自动续轮）
  contextUsage: true, // result.usage + modelUsage.contextWindow
  setModel: true, // 运行中 control_request set_model（实测支持）
  setThinkingLevel: false,
  fork: false,
  renameSession: false,
  compact: false,
  executeBash: false,
  listTools: true, // system/init 帧 tools 清单
  setActiveTools: false,
  navigateTree: false,
  deleteSession: false,
  getCommands: true, // system/init 帧 slash_commands
  respondPermission: true, // can_use_tool 控制请求 → 前端批准/拒绝
  getUsage: true,
  listModels: true,
  fileAttachments: false, // stdin 文本通道；图片附件 P1 评估
  setPermissionMode: true, // 运行中 control_request set_permission_mode（实测支持）
  queueManage: true, // backend-queue 共享层全 CRUD
  respondInteraction: false,
};

/** 兼容档 capability（exec：每轮单发，模型/权限切换下轮 spawn 生效；无交互审批面）。 */
export const CBC_EXEC_CAPABILITIES: SessionCapabilitiesLike = {
  ...CBC_CAPABILITIES,
  respondPermission: false,
};

/** stdout 行读取（跨 chunk 缓冲；与 aiti-claude-code-agent 同实现）。 */
/** 工具入参单行摘要（权限卡用；优选 command/path/url 等关键字段，超长截断）。 */
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > 120 ? `${input.slice(0, 120)}…` : input;
  try {
    const rec = input as Record<string, unknown>;
    const preferred = ["command", "path", "file_path", "url", "pattern", "query", "description"]
      .filter((k) => typeof rec[k] === "string" && rec[k])
      .map((k) => `${k}=${String(rec[k])}`);
    const s2 = preferred.length ? preferred.join(" ") : JSON.stringify(input);
    return s2.length > 120 ? `${s2.slice(0, 120)}…` : s2;
  } catch {
    return "";
  }
}

function lineReader(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
  opts?: { maxLineBytes?: number; onOverflow?: (size: number) => void },
): () => void {
  if (!stream) return () => {};
  // 字节累积、按 \n 切 Buffer 后整行 utf8 解码（加固 A1）——逐 chunk toString 会把
  // 跨 chunk 的多字节字符（中文）解码成 U+FFFD。
  const maxLineBytes = opts?.maxLineBytes ?? 10 * 1024 * 1024;
  let buffer: Buffer = Buffer.alloc(0);
  let overflowed = false;
  const onData = (chunk: Buffer | string) => {
    if (overflowed) return;
    const c = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffer = buffer.length === 0 ? c : Buffer.concat([buffer, c]);
    for (;;) {
      const idx = buffer.indexOf(0x0a);
      if (idx === -1) return;
      const line = buffer.subarray(0, idx).toString("utf8");
      buffer = buffer.subarray(idx + 1);
      if (line.trim()) onLine(line);
    }
  };
  stream.on("data", onData);
  return () => {
    stream.off("data", onData);
  };
}

/** 模型目录（handle 方法与注册级静态 listModels 共用）：cbc 动态清单（--help 探测；
 * 未探测/解析失败回落 CBC_MODELS 兜底）+ pi 目录，当前模型置顶。 */
export async function codebuddyCatalog(current?: { id: string; provider: string }): Promise<Array<ExtModelEntry>> {
  const dyn = getCachedCbcModels();
  const base = dyn
    ? dyn.map((m) => ({ id: m.id, provider: "codebuddy", source: "ext" as const }))
    : CBC_MODELS.map((m) => ({ id: m.id, label: m.label, provider: "codebuddy", source: "ext" as const }));
  const piModels = await readPiModels();
  return withCurrentFirst(mergeModelCatalogs(base, piModels), current);
}

/** 占位 id 计数器（同名会话多实例防撞）。 */
let counter = 0;

// ============================================================================
// CodebuddyHandleBase —— 两模式共享状态/历史/队列/模型持久化
// ============================================================================

export abstract class CodebuddyHandleBase {
  readonly source = "aiti-codebuddy-agent/codebuddy";
  capabilities: SessionCapabilitiesLike;
  id: string;
  readonly cwd: string;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;

  protected readonly runtime: CodebuddyRuntime;
  protected listeners = new Set<Listener>();
  protected aliveFlag = true;
  protected running = false;
  /** 真实 cbc 会话 id（uuid；首轮 init 帧后可知 → 换绑）。 */
  protected sessId: string | undefined;
  /** 当前模型（createSession 种子/状态恢复从外部赋值）。 */
  model: { id: string; provider: string } | undefined;
  /** setPermissionMode 的期望模式（exec：下轮 spawn 生效；stream：control 成功后跟随回显）。 */
  protected desiredMode: string | undefined;
  /** 本进程内累积的消息（user prompt + assistant 完整帧）——活会话历史回放权威。 */
  protected liveHistory: unknown[] = [];
  /** init 帧捕获的 tools / slash_commands（最近一轮）。 */
  protected tools: Array<{ name: string; description: string }> = [];
  protected commands: Array<{ name: string; description?: string; source: string }> = [];
  /** 最近一轮 usage（result 帧）。 */
  protected lastUsage: TurnUsage | null = null;
  /** 直播期工具调用账本：toolCallId → 工具/入参（user 帧 tool_result 回填 toolName/折叠配对用）。 */
  protected readonly toolCallOpen = new Map<string, { name: string; input: unknown }>();
  /** 最后活动时间戳（epoch ms）：/api/sessions 修正侧栏占位行 modified。 */
  protected lastActivityTs: number | null = null;
  /** 队列支持（共享层）：本地 followUp 队列 + settle 自动续轮 + steer 降级入队。 */
  protected readonly q: BackendQueue;

  constructor(id: string, cwd: string, runtime: CodebuddyRuntime, caps: SessionCapabilitiesLike) {
    this.id = id;
    this.cwd = cwd;
    this.runtime = runtime;
    this.capabilities = { ...caps };
    this.q = createBackendQueueSupport({
      isRunning: () => this.running || !this.aliveFlag,
      alive: () => this.aliveFlag,
      dispatch: (text, images) => this.prompt(text, { images }),
      steer: async () => {
        throw new Error("steer unavailable（运行中无注入面，输入入本地 followUp 队列）"); // → 共享层降级入队
      },
      onEvent: (ev) => this.emit(ev),
      log: (m) => console.warn(m),
      // 队列崩溃恢复 sidecar（docs/aiti-remote-queue-and-sidecar-plan.md §3）
      persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
    });
  }

  /**
   * 会话消息流记录（custom 消息，规范 §6 范式 / ACP 样板）：liveHistory 恒记录（刷新可回放）；
   * liveOnly=true 只发 message_end 直播卡（历史里已有原生记录时不双记）。
   */
  protected pushOrEmitCustom(opts: { customType: string; content: string; details?: unknown; liveOnly?: boolean }): void {
    const message = {
      role: "custom",
      customType: opts.customType,
      content: opts.content,
      display: true,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
      timestamp: Date.now(),
    };
    if (!opts.liveOnly) this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  /**
   * 工具调用登记 + 原生直播条目（方案 X）：assistant 帧 tool_use →
   * ①toolCallOpen 记账（结果到达时回填 toolName）②liveHistory 原生 toolCall 消息 ③message_end 直播。
   * 宿主 ToolCallBlock 按 toolCallId 与后续 toolResult 折叠——直播/refetch 同形无双记。
   */
  protected recordToolCalls(toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>, model?: string): void {
    if (!toolCalls.length) return;
    for (const t of toolCalls) if (t.id) this.toolCallOpen.set(t.id, { name: t.name, input: t.input });
    const message = {
      role: "assistant",
      content: toolCalls.map((t) => ({ type: "toolCall", toolCallId: t.id, toolName: t.name, input: t.input })),
      ...(model ? { model } : this.model ? { model: this.model.id } : {}),
      provider: "codebuddy",
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  /**
   * user 帧 tool_result → 原生 toolResult 条目（方案 X）：liveHistory（refetch 后折叠配对）
   * + message_end 直播（直播即时折叠进工具卡）；文本截 TOOL_RESULT_TEXT_CAP。
   */
  protected ingestToolResults(results: CbcToolResult[]): void {
    for (const r of results) {
      const open = r.callId ? this.toolCallOpen.get(r.callId) : undefined;
      if (r.callId) this.toolCallOpen.delete(r.callId);
      const message = {
        role: "toolResult",
        ...(r.callId ? { toolCallId: r.callId } : {}),
        ...(open?.name ? { toolName: open.name } : {}),
        content: [{ type: "text", text: r.text.slice(0, TOOL_RESULT_TEXT_CAP) }],
        ...(r.isError ? { isError: true } : {}),
        timestamp: Date.now(),
      };
      this.liveHistory.push(message);
      this.emit({ type: "message_end", message });
    }
  }

  /** 权限请求/决策写进会话消息流（D4：ask 模式有卡有记录；allow 静默放行也留痕）。 */
  protected recordPermissionCustom(
    toolName: string | undefined,
    input: unknown,
    decision: "pending" | "allow" | "deny" | "cancelled",
    requestId: string,
    note?: string,
  ): void {
    const label = decision === "pending" ? "⏳ 等待授权"
      : decision === "allow" ? `✅ 已允许${note ? `（${note}）` : ""}`
        : decision === "deny" ? `⛔ 已拒绝${note ? `（${note}）` : ""}`
          : "🚫 已取消（回合结束）";
    const inputStr = summarizeToolInput(input);
    this.pushOrEmitCustom({
      customType: "🔐 工具授权",
      content: `${toolName || "tool"}${inputStr ? ` — ${inputStr}` : ""}\n\n${label}`,
      details: { requestId, toolName, input, decision },
    });
  }

  /** 测试/恢复路径：直接设定真实 sess id（All Sessions 历史行复活）。 */
  setKnownSessionId(sid: string): void {
    this.sessId = sid;
  }

  protected emit(event: Record<string, unknown>): void {
    if (event.type === "message_end" || event.type === "message_update" || event.type === "agent_end" || event.type === "agent_settled") {
      this.lastActivityTs = Date.now();
    }
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧、不得沿流回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-codebuddy-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 进程/连接死亡（子类经 cleanupOnDead 做模式特有清理）。 */
  protected markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.cleanupOnDead();
    this.emit({ type: "session_backend_dead", reason });
  }

  protected cleanupOnDead(): void {}

  /** assistant 帧模型感知（CLI 实际服务的模型；变化才广播）。 */
  protected trackModel(id: string): void {
    if (this.model?.id === id) return;
    const prev = this.model;
    this.model = { id, provider: "codebuddy" };
    if (prev) {
      this.emit({ type: "model_select", model: this.model, previousModel: prev, source: "set" });
      this.persistModelState();
    }
  }

  /** 真实会话 id 捕获 → 换绑（session_backend_ready，懒持久化模式）。 */
  protected rebindSessionId(sid: string): void {
    if (this.sessId === sid) return;
    const oldId = this.id;
    this.sessId = sid;
    this.id = `codebuddy:${sid}`;
    this.emit({ type: "session_backend_ready", oldId, id: this.id });
    void renameExtModelState("codebuddy", oldId, this.id).then(() => this.persistModelState());
    // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则换绑前排队的条目崩溃后不可恢复）
    migrateQueueSidecar(queueStateDir, oldId, this.id, (m) => console.warn(m));
  }

  /** 轮次失败收口（exec 进程异常 / stream result.is_error）：错误消息 + 三层收尾事件。 */
  protected turnFailed(errMsg: string): void {
    const errorMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: errMsg,
      ...(this.model ? { model: this.model.id } : {}),
      provider: "codebuddy",
    };
    this.liveHistory.push(errorMessage);
    this.emit({ type: "message_end", message: errorMessage });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled_error", error: errMsg });
    this.emit({ type: "agent_settled", stopReason: "error", error: errMsg });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  alive(): boolean {
    return this.aliveFlag;
  }

  isRunning(): boolean {
    return this.running;
  }

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  async getAvailableModels(): Promise<Array<ExtModelEntry>> {
    return codebuddyCatalog(this.model);
  }

  /** 临时模型状态文件（启动/切换/换绑时写：selected + 目录快照）。 */
  persistModelState(): void {
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: "codebuddy",
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models,
        updatedAt: "",
      }));
  }

  getUsage() {
    return this.lastUsage as never;
  }

  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    if (!this.lastUsage) return undefined;
    const u = this.lastUsage;
    const contextWindow = u.contextWindow ?? 0;
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0)
      || null; // 全 0（如未登录 stub 轮）视作未知
    return {
      percent: contextWindow > 0 && tokens !== null ? Math.min(100, (tokens / contextWindow) * 100) : null,
      contextWindow,
      tokens,
    };
  }

  async getMessages(): Promise<unknown[]> {
    return [...this.liveHistory];
  }

  async getAllTools(): Promise<Array<{ name: string; description: string }>> {
    return this.tools;
  }

  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    return this.commands;
  }

  /** 最后活动时间（epoch ms；无活动返回 undefined）。供 /api/sessions 修正占位行 modified。 */
  getLastActivity(): number | undefined {
    return this.lastActivityTs ?? undefined;
  }

  /** @capability queueManage —— 队列操作原语转发共享层（followUp 组全 CRUD）。 */
  queueManage = (req: {
    action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
    kind?: "steer" | "followUp";
    from?: number;
    to?: number;
    index?: number;
    targetKind?: "steer" | "followUp";
    text?: string;
  }) => this.q.queueManage(req);

  /** 组装每轮 spawn env（凭据 + 桥 URL 透传）。 */
  protected turnEnv(): Record<string, string> {
    const bridgeUrl = this.runtime.bridgeUrl().trim();
    return buildTurnEnv(this.runtime.effectiveCred(), bridgeUrl ? { AITI_BRIDGE_URL: bridgeUrl } : undefined);
  }

  /**
   * 历史回填（All Sessions 服务出口读取的落点）：IndexedMessage[] → liveHistory。
   * 结构化工具行 → pi 原生形状（assistant.toolCall 块 + toolResult 消息配对），
   * 前端按原生工具卡片渲染；解析失败回退 🛠 文本行（与 session-manager 导入语义一致）。
   */
  seedHistory(messages: Array<{ role?: unknown; text?: unknown; model?: unknown; tool?: unknown }>): void {
    const replay = createSeedToolReplay("cbc-tool");
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const tool = role === "assistant"
        ? replay.entries(m.tool, {
          model: typeof m.model === "string" ? m.model : undefined,
          provider: "codebuddy",
        })
        : null;
      if (tool) {
        this.liveHistory.push(...tool);
        continue;
      }
      const text = typeof m.text === "string" ? m.text : "";
      if (!text.trim()) continue;
      const model = role === "assistant" && typeof m.model === "string" ? m.model : undefined;
      this.liveHistory.push({
        role,
        content: [{ type: "text", text }],
        ...(model ? { model, provider: "codebuddy" } : {}),
      });
    }
  }

  // ---- SessionHandle 强制核心（两模式各自实现） ----
  abstract prompt(text: string, options?: {
    images?: QueueTurnImageLike[];
    files?: QueueTurnImageLike[];
    streamingBehavior?: "steer" | "followUp";
  }): Promise<void>;
  abstract abort(): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract setModel(model: { id: string; provider: string }): Promise<boolean>;
  abstract setPermissionMode(mode: string): Promise<boolean>;
}

// ============================================================================
// CodebuddyStreamHandle —— 长连接（默认档）
// ============================================================================

export class CodebuddyStreamHandle extends CodebuddyHandleBase {
  private child: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private stdinSeq = 0;
  /** control_request 应答等待（request_id → resolve）。 */
  private controlWaiters = new Map<string, (ok: boolean) => void>();
  /** 待决工具授权请求（can_use_tool，result 帧清理）。 */
  private permissionPending = new Set<string>();
  /** 待决授权元数据（requestId → 工具/入参）——决策/过期记录进会话消息流用（D4）。 */
  private permissionMeta = new Map<string, { toolName?: string; input?: unknown }>();
  /** 本轮已发出 interrupt（result 到达时以 aborted 收口）。 */
  private abortRequested = false;
  /** turn-ack：上一轮 result 文本/时间（吞输入判定 + 写入门控）。 */
  private lastResultText: string | null = null;
  private lastResultAt = 0;
  /** turn-ack：当前轮记账（活动确认/重写/看门狗）。 */
  private turn: {
    text: string;
    writtenAt: number;
    activity: boolean;
    retries: number;
    watchdog: ReturnType<typeof setTimeout> | null;
  } | null = null;

  private constructor(id: string, cwd: string, runtime: CodebuddyRuntime) {
    super(id, cwd, runtime, CBC_CAPABILITIES);
  }

  static async start(init: CodebuddyHandleInit): Promise<CodebuddyStreamHandle> {
    const cli = init.runtime.resolveCli();
    const args = buildStreamArgs({
      model: init.model?.id && init.model.id !== DEFAULT_MODEL ? init.model.id : undefined,
      permissionMode: init.runtime.permissionMode(),
      resumeSid: init.sessionId,
    });
    const provisionalId = init.sessionId ? `codebuddy:${init.sessionId}` : `codebuddy:new-${++counter}-${Date.now()}`;
    const handle = new CodebuddyStreamHandle(provisionalId, init.cwd, init.runtime);
    handle.sessId = init.sessionId;
    if (init.model?.id) handle.model = { id: init.model.id, provider: "codebuddy" };

    const env = handle.turnEnv();
    // P2/P1' 启动包装：launchOverride（委托路径）> extman spawn.command/spawn.argsPrefix > 缺省
    const ov = init.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: cli.cmd,
      command: ov?.command?.trim() || spawnCommand("aiti-codebuddy-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-codebuddy-agent")).args,
      driverArgs: [...cli.baseArgs, ...args],
      env,
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: init.cwd || process.cwd(),
      warn: (m) => console.log(`[aiti-codebuddy-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: init.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    handle.child = child;
    handle.detachReader = lineReader(child.stdout, (line) => handle.onLine(line), {
      onOverflow: (size) => handle.markDead(`stdout line overflow (${size} bytes)`),
    });
    // 三个流必须挂 error 监听（加固 A2）：ECONNRESET/EPIPE 无监听器会崩宿主进程。
    child.stdout?.on("error", (err) => handle.markDead(`stdout error: ${err.message}`));
    child.stderr?.on("error", (err) => console.log(`[aiti-codebuddy-agent] stderr error: ${err.message}`));
    child.stdin?.on("error", (err) => console.log(`[aiti-codebuddy-agent] stdin error: ${err.message}`));
    child.stderr?.on("data", (c: Buffer | string) => {
      const text = String(c).trim();
      if (text) console.log(`[aiti-codebuddy-agent] ${text.slice(0, 300)}`);
    });
    child.once("exit", (code) => {
      handle.running = false;
      handle.markDead(`process exited (${code ?? "signal"})`);
    });
    child.once("error", (err) => handle.markDead(`process error: ${err.message}`));
    handle.persistModelState();
    return handle;
  }

  protected cleanupOnDead(): void {
    this.detachReader?.();
    this.detachReader = null;
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    this.turn = null;
    for (const w of this.controlWaiters.values()) w(false);
    this.controlWaiters.clear();
    this.permissionPending.clear();
  }

  alive(): boolean {
    return this.aliveFlag && (!this.child || this.child.exitCode === null);
  }

  /** 背压修正（加固 A4）：write() 返回 false 仅表示帧入缓冲（>16KB 必返 false），不是失败。 */
  private writeRaw(line: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return false;
    try {
      stdin.write(line + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** control_request 应答往返（control_response.request_id 关联；超时/断流 false）。 */
  private controlRoundTrip(requestId: string, request: Record<string, unknown>, timeoutMs = 15_000): Promise<boolean> {
    if (!this.aliveFlag) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.controlWaiters.delete(requestId)) resolve(false);
      }, timeoutMs);
      this.controlWaiters.set(requestId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      if (!this.writeRaw(controlRequestLine(requestId, request))) {
        clearTimeout(timer);
        this.controlWaiters.delete(requestId);
        resolve(false);
      }
    });
  }

  /**
   * turn-ack 写入：result 后静默门控 → 写 stdin → 记账（活动确认 + 静默看门狗）。
   * 重写（retries>0）只重写 stdin，不重复发 user 气泡/agent_start。
   */
  private async writeTurn(text: string, retries = 0): Promise<void> {
    const wait = Math.max(0, this.lastResultAt + TURN_READY_DELAY_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    if (!this.writeRaw(userLine(text))) throw new Error("[aiti-codebuddy-agent] stdin closed");
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    const turn = { text, writtenAt: Date.now(), activity: false, retries, watchdog: null as ReturnType<typeof setTimeout> | null };
    turn.watchdog = setTimeout(() => this.onTurnSilence(turn), TURN_SILENCE_MS);
    (turn.watchdog as unknown as { unref?: () => void }).unref?.();
    this.turn = turn;
  }

  /** 静默看门狗：写入后既无活动也无 result → 视为丢失（abort 中则直接以 aborted 收口）。 */
  private onTurnSilence(turn = this.turn): void {
    if (!turn || this.turn !== turn || turn.activity) return;
    if (this.abortRequested) {
      this.settleAborted();
      return;
    }
    this.retrySwallowedTurn(turn, "静默超时（无活动/无 result）");
  }

  /** 吞输入重写（有界）：不 settle、不结束轮；超限按错误收口。 */
  private retrySwallowedTurn(turn: NonNullable<CodebuddyStreamHandle["turn"]>, reason: string): void {
    if (this.turn !== turn) return;
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.retries += 1;
    if (turn.retries > MAX_TURN_RETRIES) {
      this.turn = null;
      this.running = false;
      this.turnFailed(`CodeBuddy CLI 未接受输入（已重写 ${MAX_TURN_RETRIES} 次：${reason}）`);
      this.q.scheduleDrain();
      return;
    }
    console.warn(`[aiti-codebuddy-agent] 输入疑似被 CLI 吞掉（${reason}），第 ${turn.retries} 次重写`);
    setTimeout(() => {
      if (this.turn !== turn || !this.aliveFlag) return;
      void this.writeTurn(turn.text, turn.retries).catch((e) => {
        this.turn = null;
        this.running = false;
        this.turnFailed(e instanceof Error ? e.message : String(e));
        this.q.scheduleDrain();
      });
    }, TURN_SWALLOW_RETRY_MS);
  }

  /** abort 收口（单发清理点）：结束轮 + 队列续轮。 */
  private settleAborted(): void {
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    this.turn = null;
    this.running = false;
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", stopReason: "aborted" });
    this.q.scheduleDrain();
  }

  /** stdout 帧分发（长连接：init 幂等、stream_event 增量、assistant 完整帧、result 轮终结、control 往返）。 */
  private onLine(line: string): void {
    let frame: CbcFrame;
    try {
      frame = JSON.parse(line) as CbcFrame;
    } catch {
      return;
    }
    const type = String(frame.type ?? "");

    if (type === "system" && frame.subtype === "init") {
      // init 每轮可能复报（实测）——全部幂等处理；此处不发 agent_start（每轮由 prompt 发出）
      const sid = typeof frame.session_id === "string" ? frame.session_id : "";
      if (sid && SID_RE.test(sid)) this.rebindSessionId(sid);
      const m = typeof frame.model === "string" ? frame.model : "";
      if (m && !this.model) this.trackModel(m); // restore 语义不广播
      if (Array.isArray(frame.tools)) {
        this.tools = (frame.tools as unknown[]).map((name) => ({ name: String(name), description: "" }));
      }
      if (Array.isArray(frame.slash_commands)) {
        this.commands = (frame.slash_commands as unknown[]).map((name) => ({ name: String(name), source: "skill" as const }));
      }
      return;
    }

    if (type === "stream_event") {
      if (this.turn) this.turn.activity = true; // turn-ack：模型活动=该轮已真正启动
      const delta = deltaFromStreamEvent(frame);
      if (delta) this.emit({ type: "message_update", delta });
      return;
    }

    if (type === "assistant") {
      if (this.turn) this.turn.activity = true; // turn-ack：完整帧亦为活动
      const parsed = parseAssistantFrame(frame);
      if (!parsed) return;
      if (parsed.model) this.trackModel(parsed.model);
      if (parsed.toolCalls.length > 0) this.recordToolCalls(parsed.toolCalls, parsed.model);
      if (parsed.text) {
        this.liveHistory.push({
          role: "assistant",
          content: [{ type: "text", text: parsed.text }],
          ...(parsed.model ? { model: parsed.model } : this.model ? { model: this.model.id } : {}),
          provider: "codebuddy",
        });
        this.emit({ type: "message_end", role: "assistant", text: parsed.text });
      }
      return;
    }

    if (type === "user") {
      // 工具结果帧（stream-json 与 CC 同形：message.content[].tool_result）→ 原生 toolResult
      // 条目：liveHistory（refetch 后折叠配对）+ message_end 直播（直播即时折叠进工具卡）。
      // 非 tool_result 的 user 帧（消息回显等）忽略——用户消息由 prompt() 自行入流。
      const results = toolResultsFromUserFrame(frame);
      if (results.length > 0) this.ingestToolResults(results);
      return;
    }

    if (type === "control_request") {
      const req = (frame.request ?? {}) as Record<string, unknown>;
      if (String(req.subtype ?? "") === "can_use_tool") {
        const reqId = String(frame.request_id ?? "");
        this.permissionPending.add(reqId);
        this.permissionMeta.set(reqId, { toolName: req.tool_name, input: req.input });
        this.emit({
          type: "permission_request",
          requestId: reqId,
          toolName: req.tool_name,
          input: req.input,
        });
        // D4：请求写进会话消息流（ask 模式有卡有记录，刷新可回放）
        this.recordPermissionCustom(req.tool_name, req.input, "pending", reqId);
      }
      return;
    }

    if (type === "control_response") {
      const resp = (frame.response ?? {}) as Record<string, unknown>;
      const ok = resp.subtype === "success";
      const reqId = String(resp.request_id ?? "");
      const waiter = this.controlWaiters.get(reqId);
      if (waiter) {
        this.controlWaiters.delete(reqId);
        waiter(ok);
      }
      if (ok && typeof resp.mode === "string") {
        this.emit({ type: "permission_mode_changed", mode: resp.mode });
      }
      return;
    }

    if (type === "result") {
      const resultText = typeof frame.result === "string" ? frame.result : "";
      const t = this.turn;
      // turn-ack：无活动且（复读上轮文本 / 距写入极短）→ CLI 吞了输入，重写而非收口
      const swallowed = Boolean(t) && !this.abortRequested && isSwallowedResult({
        activity: t!.activity,
        resultText,
        lastResultText: this.lastResultText,
        sinceWriteMs: Date.now() - t!.writtenAt,
        isError: frame.is_error === true,
      });
      if (swallowed && t) {
        this.retrySwallowedTurn(t, "重复 result");
        return;
      }
      this.running = false;
      this.lastUsage = usageFromResult(frame);
      const wasAbort = this.abortRequested;
      this.abortRequested = false;
      if (t?.watchdog) clearTimeout(t.watchdog);
      this.turn = null;
      this.lastResultText = resultText;
      this.lastResultAt = Date.now();
      // 结果帧终结所有未决授权（轮次已结束）——D4：取消记录进会话消息流
      for (const rid of this.permissionPending) {
        const m = this.permissionMeta.get(rid);
        this.recordPermissionCustom(m?.toolName, m?.input, "cancelled", rid);
        this.emit({ type: "permission_expired", requestId: rid });
      }
      this.permissionPending.clear();
      this.permissionMeta.clear();
      if (frame.is_error === true) {
        this.turnFailed(extractTurnError({
          resultError: typeof frame.result === "string" ? frame.result : undefined,
          errors: frame.errors,
          fallback: `CodeBuddy 轮次错误（${String(frame.subtype ?? "result")}）`,
        }));
      } else {
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: wasAbort ? "aborted" : "end_turn" });
      }
      this.q.scheduleDrain();
      return;
    }
  }

  async prompt(
    text: string,
    options?: {
      images?: QueueTurnImageLike[];
      files?: QueueTurnImageLike[];
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    if (options?.images?.length || options?.files?.length) {
      console.warn("[aiti-codebuddy-agent] 图片/文件附件暂不支持（stdin 文本通道）——已忽略附件");
    }
    if (this.running) {
      await this.q.routePrompt(text, {
        streamingBehavior: options?.streamingBehavior,
        ...(options?.images ? { images: options.images } : {}),
      });
      return;
    }
    this.running = true;
    this.abortRequested = false;
    this.liveHistory.push({ role: "user", content: text });
    this.emit({ type: "agent_start" });
    this.emit({ type: "prompt_done" });
    this.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    });
    try {
      await this.writeTurn(text);
    } catch (e) {
      this.running = false;
      this.turn = null;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** @capability followUp —— 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同普通 prompt。
   *  D2：CBC_CAPABILITIES 早已声明 true 但 stream 档缺方法（适配层 follow_up 即 TypeError），本方法补齐。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  async abort(): Promise<void> {
    if (!this.running) {
      // 失步兜底：补发一帧 aborted 收口让前端复位（幂等，真空闲时多一帧无害）
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    this.abortRequested = true;
    const ok = await this.controlRoundTrip(`int-${++this.stdinSeq}`, { subtype: "interrupt" });
    if (!ok) {
      // 保留 abortRequested：吞输入场景下 interrupt 可能无应答，交给静默看门狗以 aborted 收口
      console.warn("[aiti-codebuddy-agent] interrupt not acknowledged（进程可能已收口，等看门狗/result 收口）");
    }
  }

  async dispose(): Promise<void> {
    this.aliveFlag = false;
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    this.turn = null;
    this.q.dispose();
    const child = this.child;
    if (child && child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
          resolve();
        }, 1000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.detachReader?.();
    this.detachReader = null;
    this.listeners.clear();
  }

  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    const ok = await this.controlRoundTrip(`sm-${++this.stdinSeq}`, { subtype: "set_model", model: model.id });
    if (ok) {
      const prev = this.model;
      this.model = { id: model.id, provider: "codebuddy" };
      this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
      this.persistModelState();
    }
    return ok;
  }

  async setPermissionMode(mode: string): Promise<boolean> {
    if (!(CBC_MODES as readonly string[]).includes(mode)) {
      throw new Error(`[aiti-codebuddy-agent] 非法权限模式 "${mode}"（可选：${CBC_MODES.join("/")}）`);
    }
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    const ok = await this.controlRoundTrip(`pm-${++this.stdinSeq}`, { subtype: "set_permission_mode", mode });
    if (ok) this.desiredMode = mode; // permission_mode_changed 由 control_response 回显帧广播
    return ok;
  }

  /** 工具授权应答（can_use_tool → control_response，CC 同形协议）。 */
  async respondPermission(requestId: string, decision: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    const response: Record<string, unknown> = decision.behavior === "allow"
      ? { behavior: "allow", ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) }
      : { behavior: "deny", message: decision.message ?? "denied by user" };
    const ok = this.writeRaw(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    }));
    // D4：决策写进会话消息流（deny 理由 / allow 备注）
    const meta = this.permissionMeta.get(requestId);
    this.recordPermissionCustom(meta?.toolName, meta?.input, decision.behavior, requestId,
      decision.behavior === "deny" ? (decision.message ?? undefined) : (decision.updatedInput ? "入参已修正" : undefined));
    this.permissionPending.delete(requestId);
    this.permissionMeta.delete(requestId);
    return ok;
  }
}

/** 权限模式白名单（cbc --permission-mode choices，2026-09-10 --help 实测）。 */
const CBC_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;

// ============================================================================
// CodebuddyExecHandle —— 每轮单发 + --resume（兼容档；原单发实现）
// ============================================================================

export class CodebuddyExecHandle extends CodebuddyHandleBase {
  /** 当前轮子进程（abort 用）。 */
  private child: ChildProcess | null = null;
  private turnAbort = new AbortController();
  /** 当前轮 result 帧是否已收口（exit 时校验错误轮）。 */
  private lastResultError: { error?: string; errors?: unknown } | null = null;

  private constructor(id: string, cwd: string, runtime: CodebuddyRuntime) {
    super(id, cwd, runtime, CBC_EXEC_CAPABILITIES);
  }

  static async start(init: CodebuddyHandleInit): Promise<CodebuddyExecHandle> {
    const provisionalId = init.sessionId ? `codebuddy:${init.sessionId}` : `codebuddy:new-${++counter}-${Date.now()}`;
    const handle = new CodebuddyExecHandle(provisionalId, init.cwd, init.runtime);
    handle.launchOverride = init.launchOverride;
    handle.sessId = init.sessionId;
    if (init.model?.id) handle.model = { id: init.model.id, provider: "codebuddy" };
    handle.persistModelState();
    return handle;
  }

  protected cleanupOnDead(): void {
    try { this.turnAbort.abort(); } catch { /* already aborted */ }
    this.child = null;
  }

  /**
   * 执行一轮：受理即发 agent_start/prompt_done/user 气泡（zcode 同款前端语义），
   * spawn 单发 cbc 进程，帧级转发。
   */
  private async runTurn(promptText: string): Promise<string> {
    this.emit({ type: "agent_start" });
    this.emit({ type: "prompt_done" });
    this.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() },
    });

    // spawn 前检查点：CLI 解析（npx 首用可能下载）期间已 abort → 安静收尾
    if (this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    let cli: ResolvedCli;
    try {
      cli = this.runtime.resolveCli();
    } catch (e) {
      this.turnFailed(e instanceof Error ? e.message : String(e));
      return "error";
    }
    if (this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    const env = this.turnEnv();
    const turnArgs = buildTurnArgs({
      prompt: promptText,
      sessId: this.sessId,
      model: this.model?.id && this.model.id !== DEFAULT_MODEL ? this.model.id : undefined,
      permissionMode: this.desiredMode ?? this.runtime.permissionMode(),
    });

    this.lastResultError = null;
    let outcome;
    try {
      outcome = await execCbcTurn({
        cli,
        turnArgs,
        cwd: this.cwd || process.cwd(),
        env,
        launchOverride: this.launchOverride,
        onChild: (c) => { this.child = c; },
        onFrame: (frame) => this.onFrame(frame),
      });
    } catch (e) {
      this.child = null;
      if (this.turnAbort.signal.aborted) {
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: "aborted" });
        return "aborted";
      }
      this.turnFailed(e instanceof Error ? e.message : String(e));
      return "error";
    }
    this.child = null;

    // 用户主动 abort（SIGTERM）：不进错误帧，安静收尾
    if (outcome.killed || this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    // result 帧已在 onFrame 记账 usage / 错误；exit 无 result = 进程异常（CLI 崩溃/断流）
    if (!outcome.sawResult || this.lastResultError) {
      this.turnFailed(extractTurnError({
        resultError: this.lastResultError?.error,
        errors: this.lastResultError?.errors,
        stderrTail: outcome.stderrTail,
        fallback: `CodeBuddy CLI 异常退出（code=${outcome.exitCode}${outcome.signal ? ` signal=${outcome.signal}` : ""}，无 result 帧）`,
      }));
      return "error";
    }

    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", stopReason: "end_turn" });
    return "end_turn";
  }

  /** 帧分发：init（sid/模型/工具/命令）、stream_event（增量）、assistant（完整消息）、result（usage/错误）。 */
  private onFrame(frame: CbcFrame): void {
    const type = String(frame.type ?? "");

    if (type === "system" && frame.subtype === "init") {
      // init 可能双发（实测）——全部幂等处理
      const sid = typeof frame.session_id === "string" ? frame.session_id : "";
      if (sid && SID_RE.test(sid)) this.rebindSessionId(sid);
      const m = typeof frame.model === "string" ? frame.model : "";
      if (m && !this.model) this.model = { id: m, provider: "codebuddy" }; // restore 语义不广播
      if (Array.isArray(frame.tools)) {
        this.tools = (frame.tools as unknown[]).map((name) => ({ name: String(name), description: "" }));
      }
      if (Array.isArray(frame.slash_commands)) {
        this.commands = (frame.slash_commands as unknown[]).map((name) => ({ name: String(name), source: "skill" as const }));
      }
      return;
    }

    if (type === "stream_event") {
      const delta = deltaFromStreamEvent(frame);
      if (delta) this.emit({ type: "message_update", delta });
      return;
    }

    if (type === "assistant") {
      const parsed = parseAssistantFrame(frame);
      if (!parsed) return;
      if (parsed.model) this.trackModel(parsed.model);
      if (parsed.toolCalls.length > 0) this.recordToolCalls(parsed.toolCalls, parsed.model);
      if (parsed.text) {
        this.liveHistory.push({
          role: "assistant",
          content: [{ type: "text", text: parsed.text }],
          ...(parsed.model ? { model: parsed.model } : this.model ? { model: this.model.id } : {}),
          provider: "codebuddy",
        });
        this.emit({ type: "message_end", role: "assistant", text: parsed.text });
      }
      return;
    }

    if (type === "user") {
      // 同 stream 档：tool_result → 原生 toolResult 条目（liveHistory + 直播折叠，方案 X）
      const results = toolResultsFromUserFrame(frame);
      if (results.length > 0) this.ingestToolResults(results);
      return;
    }

    if (type === "result") {
      this.lastUsage = usageFromResult(frame);
      if (frame.is_error === true) {
        this.lastResultError = {
          error: typeof frame.result === "string" ? frame.result : undefined,
          errors: Array.isArray(frame.errors) ? frame.errors : undefined,
        };
      }
      return;
    }
  }

  async prompt(
    text: string,
    options?: {
      images?: QueueTurnImageLike[];
      files?: QueueTurnImageLike[];
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    if (options?.images?.length || options?.files?.length) {
      console.warn("[aiti-codebuddy-agent] 图片/文件附件暂不支持（-p argv 文本通道）——已忽略附件");
    }
    if (this.running) {
      await this.q.routePrompt(text, {
        streamingBehavior: options?.streamingBehavior,
        ...(options?.images ? { images: options.images } : {}),
      });
      return;
    }
    this.running = true;
    this.turnAbort = new AbortController();
    this.liveHistory.push({ role: "user", content: text });
    try {
      await this.runTurn(text);
    } catch (e) {
      if (this.turnAbort.signal.aborted) {
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: "aborted" });
      } else {
        this.turnFailed(e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.running = false;
    }
    this.q.scheduleDrain();
  }

  /** @capability steer（false）——运行中注入无面：降级入本地队列（消息不丢、不打断原轮）。 */
  async steer(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    await this.q.routePrompt(text);
  }

  /** @capability followUp —— 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codebuddy-agent] session disposed");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  async abort(): Promise<void> {
    if (!this.running) {
      // 失步兜底：补发一帧 aborted 收口让前端复位（幂等，真空闲时多一帧无害）
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    console.warn("[aiti-codebuddy-agent] abort: killing current turn process");
    try { this.turnAbort.abort(); } catch { /* already aborted */ }
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }

  async dispose(): Promise<void> {
    this.aliveFlag = false;
    try { this.turnAbort.abort(); } catch { /* already */ }
    const child = this.child;
    if (child && child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
          resolve();
        }, 1000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.q.dispose();
    this.listeners.clear();
  }

  /** 切换模型：下轮 spawn 的 --model 生效（单发模式无运行中切换面）。 */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    this.model = { id: model.id, provider: "codebuddy" };
    this.emit({ type: "model_select", model: this.model, source: "set" });
    this.persistModelState();
    return true;
  }

  /** 切换权限模式：下轮 spawn 的 --permission-mode 生效。 */
  async setPermissionMode(mode: string): Promise<boolean> {
    if (!(CBC_MODES as readonly string[]).includes(mode)) {
      throw new Error(`[aiti-codebuddy-agent] 非法权限模式 "${mode}"（可选：${CBC_MODES.join("/")}）`);
    }
    this.desiredMode = mode;
    return true;
  }
}

/** 工厂：按 feature 连接模式创建 handle（stream 默认）。 */
export async function createCodebuddyHandle(
  mode: "stream" | "exec",
  init: CodebuddyHandleInit,
): Promise<CodebuddyHandleBase> {
  return mode === "exec" ? await CodebuddyExecHandle.start(init) : await CodebuddyStreamHandle.start(init);
}
