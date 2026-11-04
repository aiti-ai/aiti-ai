/**
 * aiti-claude-code-agent — 会话后端扩展：驱动 Claude Code CLI 会话。
 *
 * 打通 all-sessions 的跨 agent 链路：面板里的 CC 历史行（"claude:<sid>"）
 * 经 openExternalSession → 本扩展 spawn `claude -p --resume <sid>` 变成 live
 * 会话；全新会话则不带 --resume 启动，从 system/init 帧捕获真实 session_id。
 *
 * 协议（本机 claude 2.x 实测）：
 *   stdin  ← {"type":"user","message":{...}}                        用户消息
 *   stdin  ← {"type":"control_request","request_id","request":{subtype:"interrupt"}}
 *   stdout → {"type":"system","subtype":"init","session_id","model",...}
 *   stdout → {"type":"stream_event","event":{"type":"content_block_delta",
 *              "delta":{"type":"text_delta","text":...}}}           流式增量
 *   stdout → {"type":"assistant","message":{content:[...]}}          完整消息
 *   stdout → {"type":"user","message":{content:[{type:"tool_result",…}]}}  工具结果
 *   stdout → {"type":"result","subtype":"success|error_during_execution",
 *              "is_error", "result"}                                轮次终结
 *
 * 能力面（fail-loud）：prompt/followUp（本地队列，D11 探针证据）/abort/getTools/getCommands/
 * queueManage ✅；steer/fork/rename/compact 等 ❌。
 *
 * 权限提示：print 模式无交互审批。需要自动批准时由调用方经 opts.args 传
 * ["--permission-mode","acceptEdits"] 或 ["--dangerously-skip-permissions"]。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fetchClaudeQuota, readClaudeCreds } from "./claude-quota.ts";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { governanceEnv } from "./external-governance.ts";
import { agentSpawnEnv, spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// 队列共享实现层（权威源 pi-web-ext/_shared/backend-queue.ts，副本随扩展部署——改动须双向同步）
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar, type BackendQueue } from "@aiti-ai/ext-shared/backend-queue";
import {
  readExtModelState, readAgentLastUsedModel, readPiModels, renameExtModelState, writeExtModelState,
  mergeModelCatalogs, withCurrentFirst, withLastUsedFirst, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";
// 受控登录共享层（权威源 pi-web-ext/_shared/controlled-login.mjs，副本随扩展部署——改动须双向同步）
import { cleanEnv, createControlledLogin, mountControlledLoginApi, tailLine } from "@aiti-ai/ext-shared/controlled-login";

/** 队列崩溃恢复 sidecar 根（startup 捕获 <stateDir>；undefined/空 = 不持久化）。 */
let queueStateDir: string | undefined;

// ============================================================================
// 结构化契约 + 线协议工具（out-of-tree，无宿主导入）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

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
      if (idx === -1) break;
      const line = buffer.subarray(0, idx).toString("utf8");
      buffer = buffer.subarray(idx + 1);
      if (line.trim()) onLine(line);
    }
    if (buffer.length > maxLineBytes) {
      overflowed = true;
      opts?.onOverflow?.(buffer.length);
    }
  };
  stream.on("data", onData);
  return () => {
    stream.off("data", onData);
  };
}

/** 工具入参单行摘要（权限/工具卡用；优选 command/path/url 等关键字段，超长截断）。 */
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > 120 ? `${input.slice(0, 120)}…` : input;
  try {
    const rec = input as Record<string, unknown>;
    const preferred = ["command", "path", "file_path", "url", "pattern", "query", "description"]
      .filter((k) => typeof rec[k] === "string" && rec[k])
      .map((k) => `${k}=${String(rec[k])}`);
    const s = preferred.length ? preferred.join(" ") : JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return "";
  }
}

/**
 * 模型目录核心（handle 方法与注册级静态 listModels 共用，防实现漂移）：
 * CC 内置清单 + pi 目录（models.json 实时扁平化，选择器独立 "pi" 分组），
 * 当前模型置顶。pi 模型能否被 CC 实际服务取决于其自身 provider 配置（fail-loud）。
 */
async function claudeCodeCatalog(current?: { id: string; provider: string }): Promise<Array<ExtModelEntry & { alias?: string }>> {
  const builtin: ExtModelEntry[] = [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", alias: "sonnet", provider: "claude-code", source: "ext" },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1", alias: "opus", provider: "claude-code", source: "ext" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", alias: "haiku", provider: "claude-code", source: "ext" },
    { id: "glm-5.2", label: "GLM 5.2", provider: "claude-code", source: "ext" },
    { id: "glm-5.3", label: "GLM 5.3", provider: "claude-code", source: "ext" },
  ];
  const piModels = await readPiModels();
  return withCurrentFirst(
    mergeModelCatalogs(builtin, piModels),
    current,
  ) as Array<ExtModelEntry & { alias?: string }>;
}

/**
 * claude 族上下文窗口（get_context_usage 换算用）：模型 id 带 `[1m]` 后缀（如
 * claude-sonnet-4-5[1m]，CC 的 1M 上下文 beta 变体在模型名里体现）→ 1M；其余
 * claude 模型（含 haiku/sonnet/opus 全系）一律 200K。未知 id 也回 200K（宁近似
 * 不空——tooltip 会展示窗口数值可核对）。
 */
export function claudeContextWindow(modelId?: string): number {
  if (typeof modelId === "string" && modelId.includes("[1m]")) return 1_000_000;
  return 200_000;
}

const CC_CAPABILITIES: SessionCapabilitiesLike = {  steer: false,
  // D11 探针（2026-09-13，claude 2.1.201，带 AITI_BRIDGE_URL 桥连通 + result 后 0ms 写入）：
  // 第二轮正常受理（新 init + 新 result，非复读）——无 codebuddy 同款吞输入病。followUp 经
  // backend-queue 共享层本地队列实现（settle= result 帧，自动续轮，可撤回）。
  followUp: true,
  getMessages: true,
  respondPermission: true,
  getUsage: true,
  listModels: true,
  fileAttachments: true,
  // 上下文用量（2026-09-19）：result 帧 usage 三项 input 侧相加即当前上下文占用，
  // 窗口按模型族 map（claudeContextWindow）——percent 供 ctx-meter/底栏 chip。
  contextUsage: true,
  // 2026-08 对 claude 2.1.201 实证：control_request 支持 subtype "set_model"（同
  // set_permission_mode 通道，响应经 control_response 关联）。
  setModel: true,
  setThinkingLevel: false,
  fork: false,
  renameSession: false,
  compact: false,
  executeBash: false,
  listTools: true, // system/init 携带 tools 清单
  setActiveTools: false,
  navigateTree: false,
  deleteSession: false,
  getCommands: true, // system/init 携带 slash_commands
  queueManage: true, // backend-queue 共享层全 CRUD（followUp 组；无 steer 组——协议无注入面）
};

// ============================================================================
// ClaudeCodeHandle
// ============================================================================

/** 导出仅供单测直接驱动（宿主 loader 只消费 default 导出）。 */
export class ClaudeCodeHandle {
  readonly source = "aiti-claude-code-agent/claude-code";
  readonly capabilities: SessionCapabilitiesLike = CC_CAPABILITIES;
  id: string;

  private child: ChildProcess;
  private detachReader: (() => void) | null = null;
  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  private model: { id: string; provider: string } | undefined;
  private tools: Array<{ name: string; description: string }> = [];
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  /** abort 的 control_request 关联（request_id → resolver） */
  private interruptWaiters: Array<(ok: boolean) => void> = [];
  /** 待决 set_permission_mode 请求：request_id → resolver */
  private pmWaiters = new Map<string, (ok: boolean) => void>();
  /** 待决 set_model 请求：request_id → resolver（2.1.201 实证支持） */
  private smWaiters = new Map<string, (ok: boolean) => void>();
  /** 临时模型状态文件的目录键（agentKey，如 claude） */
  private readonly stateAgentKey: string;
  /** 待决工具授权请求（can_use_tool）：request_id → resolver */
  private permissionPending = new Map<string, (allowed: boolean) => void>();
  /** 待决授权元数据（requestId → 工具/入参）——决策/过期记录进会话消息流用（D4）。 */
  private permissionMeta = new Map<string, { toolName?: string; input?: unknown }>();
  /** 直播期工具调用账本：toolCallId → 工具/入参（user 帧 tool_result 回填 toolName，方案 X）。 */
  private toolCallOpen = new Map<string, { name: string; input: unknown }>();
  /** 最近一轮用量/成本（result 帧提取） */
  private lastUsage: {
    model?: string; inputTokens?: number; outputTokens?: number;
    cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; numTurns?: number;
  } | undefined;
  /** 会话累计用量（本 handle 进程存活期逐轮累加；getUsageTotals 数据源，重启归零） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
  private seq = 0;
  /** 本进程内累积的消息（user prompt + assistant 完整帧）——print 模式 jsonl
   *  只在进程退出时落盘，活会话的历史回放靠这份内存日志。 */
  private liveHistory: unknown[] = [];
  /** resume 场景：进程启动后首次 getMessages 时从 jsonl 读既往轮次（只读一次）。 */
  private prelude: unknown[] | null = null;
  /** --resume 请求的原始 sid：CC resume 后 init 可能报告新 id，历史文件仍以旧 sid 命名 */
  private resumeSourceSid: string | undefined;
  /** 历史回放目录（会话真实原 directory；可能与 spawn cwd 不同——原目录已删时 spawn 落兜底 cwd，jsonl 仍按原目录找）。 */
  historyCwd: string | undefined;
  /** 当前权限模式（init 后由 spawn 参数/运行时切换更新）。 */
  private permissionMode: string | undefined;

  readonly cwd: string;

  /**
   * 队列支持（共享层，D3/D11 同款）：本地 followUp 队列 + settle 自动续轮。D11 探针
   * 证明 claude result 后 0ms 写入被正常受理（无 codebuddy 吞输入病），无需 turn-ack 门控。
   * dispatch 闭包回 prompt() 全簿记；无原生 steer → 运行中输入一律入队（可撤回）。
   */
  private q = createBackendQueueSupport({
    isRunning: () => this.running || !this.aliveFlag,
    alive: () => this.aliveFlag,
    dispatch: (text, images) => this.prompt(text, { images: images as never }),
    onEvent: (ev) => this.emit(ev),
    log: (m) => console.warn(`[aiti-claude-code-agent] ${m}`),
    // 队列崩溃恢复 sidecar（docs/aiti-remote-queue-and-sidecar-plan.md §3）
    persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
  });

  constructor(id: string, child: ChildProcess, cwd = "", capabilities?: SessionCapabilitiesLike, stateAgentKey = "claude") {
    this.id = id;
    this.child = child;
    this.cwd = cwd;
    this.stateAgentKey = stateAgentKey;
    if (capabilities) (this as { capabilities: SessionCapabilitiesLike }).capabilities = capabilities;

    this.detachReader = lineReader(child.stdout, (line) => this.onLine(line), {
      onOverflow: (size) => this.markDead(`stdout line overflow (${size} bytes)`),
    });
    // 三个流必须挂 error 监听（加固 A2）：子进程被杀/管道断裂时流上抛 ECONNRESET/EPIPE，
    // 没有监听器 = unhandled 'error' event = 崩宿主进程。（on?. 防御：测试桩的流可能缺 on）
    child.stdout?.on?.("error", (err) => this.markDead(`stdout error: ${err.message}`));
    child.stderr?.on?.("error", (err) => console.log(`[claude-code:${this.id.slice(0, 20)}] stderr error: ${err.message}`));
    child.stdin?.on?.("error", (err) => console.log(`[claude-code:${this.id.slice(0, 20)}] stdin error: ${err.message}`));
    child.stderr?.on("data", (c: Buffer | string) => {
      const text = String(c).trim();
      if (text) console.log(`[claude-code:${this.id.slice(0, 20)}] ${text.slice(0, 300)}`);
    });
    child.once("exit", (code) => {
      this.running = false;
      this.markDead(`process exited (${code ?? "signal"})`);
    });
    child.once("error", (err) => this.markDead(`process error: ${err.message}`));
  }

  private markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.detachReader?.();
    this.detachReader = null;
    for (const w of this.interruptWaiters) w(false);
    this.interruptWaiters = [];
    // 未决 control 往返一并落定（waiter 自带 clearTimeout），权限表清空
    for (const w of this.pmWaiters.values()) w(false);
    this.pmWaiters.clear();
    for (const w of this.smWaiters.values()) w(false);
    this.smWaiters.clear();
    this.permissionPending.clear();
    this.permissionMeta.clear();
    this.q.dispose(); // 队列清空 + 停未决续轮（进程死了队列没有未来）
    this.emit({ type: "session_backend_dead", reason });
  }

  private emit(event: Record<string, unknown>): void {
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧给其余订阅者、不得沿流回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-claude-code-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 会话消息流记录（custom 消息，规范 §6 范式 / ACP 样板）：liveHistory 恒记录（刷新可回放）；
   * liveOnly=true 只发 message_end 直播卡（历史里已有原生 toolCall 块，不双记）。
   */
  private pushOrEmitCustom(opts: { customType: string; content: string; details?: unknown; liveOnly?: boolean }): void {
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

  /** 权限请求/决策写进会话消息流（规范 §6：ask 模式有卡有记录；allow 静默放行也留痕）。 */
  private recordPermissionCustom(
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

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(msg.type ?? "");

    if (type === "system" && msg.subtype === "init") {
      const sid = String(msg.session_id ?? "");
      if (sid && !this.id.includes(sid)) {
        const oldId = this.id;
        this.id = `claude:${sid}`;
        // 宿主据此把 store 键从占位 id 换成真实复合 id（旧键保留兼容已发出的引用）
        this.emit({ type: "session_backend_ready", oldId, id: this.id });
        // 状态文件跟随换绑（模型选择持久化到新 id 名下）
        renameExtModelState(this.stateAgentKey, oldId, this.id).then(() => this.persistModelState());
        // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则 init 前排队的条目崩溃后不可恢复）
        migrateQueueSidecar(queueStateDir, oldId, this.id, (m) => console.warn(`[aiti-claude-code-agent] ${m}`));
      }
      const m = typeof msg.model === "string" ? msg.model : undefined;
      if (m) this.trackModel(m, "restore");
      if (Array.isArray(msg.tools)) {
        this.tools = (msg.tools as string[]).map((name) => ({ name, description: "" }));
      }
      if (Array.isArray(msg.slash_commands)) {
        this.commands = (msg.slash_commands as string[]).map((name) => ({
          name,
          source: "skill" as const,
        }));
      }
      this.emit({ type: "agent_start", sessionId: this.id, model: this.model });
      return;
    }

    if (type === "stream_event") {
      const ev = (msg.event ?? {}) as Record<string, unknown>;
      const evType = String(ev.type ?? "");
      if (evType === "message_start") {
        this.running = true;
        this.emit({ type: "message_start", role: "assistant" });
      } else if (evType === "content_block_delta") {
        const delta = (ev.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          this.emit({ type: "message_update", delta: delta.text });
        }
      }
      return;
    }

    if (type === "assistant") {
      const message = (msg.message ?? {}) as Record<string, unknown>;
      this.recordAssistant(msg);
      const content = Array.isArray(message.content) ? message.content : [];
      // 方案 X：工具调用直播走原生 assistant toolCall 消息（与 liveHistory 原生块同形；
      // 宿主 ToolCallBlock 按 toolCallId 折叠后续 toolResult——直播/refetch 同形无双记）。
      const toolUseBlocks = (content as Array<Record<string, unknown>>)
        .filter((b) => b && b.type === "tool_use" && typeof b.name === "string");
      if (toolUseBlocks.length > 0) {
        for (const b of toolUseBlocks) this.toolCallOpen.set(String(b.id ?? ""), { name: String(b.name), input: b.input ?? {} });
        this.emit({ type: "message_end", message: {
          role: "assistant",
          content: toolUseBlocks.map((b) => ({
            type: "toolCall",
            toolCallId: String(b.id ?? ""),
            toolName: String(b.name),
            input: (b.input ?? {}) as Record<string, unknown>,
          })),
          model: typeof message.model === "string" ? message.model : this.model?.id ?? "",
          provider: "aiti-claude-code-agent",
          timestamp: Date.now(),
        } });
      }
      const text = content
        .map((b) => (b as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string")
        .join("");
      if (text) this.emit({ type: "message_end", role: "assistant", text });
      return;
    }

    if (type === "user") {
      // 方案 X：工具结果 → 原生 toolResult 条目（liveHistory 折叠配对 + message_end 直播即时折叠）。
      // 历史回放：本进程轮次走 liveHistory；进程外既往轮次走 jsonl prelude（首次读一次）。
      const message = (msg.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const b of content) {
        if (b.type === "tool_result") {
          const id = String(b.tool_use_id ?? "");
          const open = this.toolCallOpen.get(id);
          this.toolCallOpen.delete(id);
          const rc = Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>) : [];
          const outText = rc.map((x) => (typeof x.text === "string" ? x.text : "")).join("").trim();
          const isError = b.is_error === true;
          const resultMsg = {
            role: "toolResult",
            ...(id ? { toolCallId: id } : {}),
            ...(open?.name ? { toolName: open.name } : {}),
            content: [{ type: "text", text: outText.slice(0, 4000) }],
            ...(isError ? { isError: true } : {}),
            timestamp: Date.now(),
          };
          this.liveHistory.push(resultMsg);
          this.emit({ type: "message_end", message: resultMsg });
        }
      }
      return;
    }

    if (type === "control_request" && String((msg.request as Record<string, unknown>)?.subtype ?? "") === "can_use_tool") {
      const reqId = String(msg.request_id ?? "");
      const request = msg.request as Record<string, unknown>;
      // 挂起并广播给客户端（Web 端可渲染批准对话框；超时/断连由 dispose 清理）
      this.permissionPending.set(reqId, () => {});
      this.permissionMeta.set(reqId, { toolName: request.tool_name, input: request.input });
      this.emit({
        type: "permission_request",
        requestId: reqId,
        toolName: request.tool_name,
        input: request.input,
      });
      // D4：请求写进会话消息流（ask 模式有卡有记录，刷新可回放；规范 §6）
      this.recordPermissionCustom(request.tool_name, request.input, "pending", reqId);
      return;
    }

    if (type === "control_response") {
      const resp = (msg.response ?? {}) as Record<string, unknown>;
      const ok = resp.subtype === "success";
      // request_id 关联分发：interrupt / set_permission_mode / set_model 共用 control_response 通道
      if (ok && typeof resp.mode === "string") {
        // set_permission_mode 成功 → 记录当前模式并通知
        this.emit({ type: "permission_mode_changed", mode: resp.mode });
      }
      for (const w of this.interruptWaiters.splice(0)) w(ok);
      for (const [rid, waiter] of this.pmWaiters) {
        if (rid === String(resp.request_id)) { waiter(ok); this.pmWaiters.delete(rid); }
      }
      for (const [rid, waiter] of this.smWaiters) {
        if (rid === String(resp.request_id)) { waiter(ok); this.smWaiters.delete(rid); }
      }
      return;
    }

    if (type === "result") {
      this.running = false;
      const usage = (msg.usage ?? {}) as Record<string, number>;
      const modelUsage = (msg.modelUsage ?? {}) as Record<string, Record<string, number>>;
      const firstModel = Object.entries(modelUsage)[0];
      this.lastUsage = {
        ...(this.model ? { model: this.model.id } : {}),
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
        ...(firstModel ? { inputTokens: firstModel[1].inputTokens, outputTokens: firstModel[1].outputTokens, cacheReadTokens: firstModel[1].cacheReadInputTokens, costUsd: firstModel[1].costUSD } : {}),
      };
      this.accumulateUsage(this.lastUsage);
      // 结果帧终结所有未决授权（轮次已结束）——D4：取消记录进会话消息流
      for (const [rid, meta] of this.permissionPending) {
        const m = this.permissionMeta.get(rid);
        this.recordPermissionCustom(m?.toolName, m?.input, "cancelled", rid);
        this.emit({ type: "permission_expired", requestId: rid });
      }
      this.permissionPending.clear();
      this.permissionMeta.clear();
      const isError = msg.is_error === true;
      this.emit({
        type: "agent_settled",
        ...(isError ? { error: String(msg.result ?? "error_during_execution") } : {}),
        result: typeof msg.result === "string" ? msg.result : undefined,
      });
      // settle（result 帧）后自动续轮（共享层幂等；微任务让 agent_settled 先到达前端）
      this.q.scheduleDrain();
      return;
    }
  }

  private writeLine(obj: Record<string, unknown>): boolean {
    // 背压修正（加固 A4）：write() 返回 false 仅表示帧已入缓冲（单帧 >16KB 高水位必返 false），
    // 不是失败——大图片/长文本 prompt 曾被误判 "stdin closed" 并卡死 running。真失败=不可写或 throw。
    const stdin = this.child.stdin;
    if (!stdin?.writable) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  static async start(opts: {
    sessionId?: string;
    cwd?: string;
    model?: { provider: string; id: string };
    /** cc-switch 档案名（~/.claude/<name>.json）→ --settings 注入 */
    profile?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
    /** 协议族成员二进制（PATH 名或绝对路径）；缺省 claude。 */
    bin?: string;
    permissionMode?: string;
    caps?: SessionCapabilitiesLike;
    /** P2 启动包装覆盖（aiti-custom-agent 委托路径）：成员级 command/argsPrefix/env/bridge，
     *  优先级高于 extman spawn.command/spawn.argsPrefix（缺省全空 = 用 extman/默认）。 */
    launchOverride?: LaunchOverride;
    /** 会话真实原 directory（冷恢复 meta.cwd；仅用于历史 jsonl 定位，spawn cwd 仍走 opts.cwd）。 */
    historyCwd?: string;
  }): Promise<ClaudeCodeHandle> {
    const cli = opts.bin ?? process.env.CLAUDE_CLI_PATH ?? "claude";
    const settingsPath = opts.profile
      ? join(homedir(), ".claude", `${opts.profile}.json`)
      : undefined;
    if (opts.profile && !existsSync(settingsPath!)) {
      throw new Error(`[aiti-claude-code-agent] profile not found: ${opts.profile}`);
    }
    const args = [
      cli,
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      // 无条件必带（回归修复 2026-09-15）：print 模式下 stream-json 必须 --verbose，
      // --include-partial-messages 提供 message_update 增量——曾误当重复 flag 条件化，
      // 直驱 start()（无 member flags）即缺参被 CLI 拒启（冒烟实证）
      "--verbose",
      "--include-partial-messages",
      ...(settingsPath ? ["--settings", settingsPath] : []),
      // cc-switch 语义：模型在会话创建时确定（profile 文件里的 ANTHROPIC_MODEL
      // 未显式指定 model 时由 CLI 从 settings env 解析）
      ...(opts.model?.id ? ["--model", opts.model.id] : []),
      // 默认最大权限：headless 下权限询问无法应答=任务直接失败，未显式指定时全绕过
      ...(opts.permissionMode
        ? ["--permission-mode", opts.permissionMode]
        : ["--dangerously-skip-permissions"]),
      ...(opts.sessionId ? ["--resume", opts.sessionId] : []),
      ...(opts.extraArgs ?? []),
    ];
    // P1' 启动包装（docs/aiti-custom-agent-plan.md）：extman spawn.command/spawn.argsPrefix
    // —— 缺省（两者皆空）= 行为不变；配置后 command 覆盖 CLI、argsPrefix 拼在内置参数前（docker 化等）
    // P2：launchOverride（custom-agent 委托路径）优先于 extman feature
    const launch = resolveCliLaunch({
      defaultCommand: cli,
      command: opts.launchOverride?.command?.trim() || spawnCommand("aiti-claude-code-agent") || undefined,
      argsPrefix: opts.launchOverride?.argsPrefix?.length
        ? opts.launchOverride.argsPrefix
        : parseArgsLines(spawnArgsPrefix("aiti-claude-code-agent")).args,
      driverArgs: args.slice(1),
      env: agentSpawnEnv({ cli: "claude-code", governance: governanceEnv, extra: opts.env, extId: "aiti-claude-code-agent", envList: spawnEnvList("aiti-claude-code-agent") }),
      memberEnv: opts.launchOverride?.env,
      bridge: opts.launchOverride?.bridge,
      cwd: opts.cwd || process.cwd(),
      warn: (m) => console.log(`[aiti-claude-code-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: opts.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });

    // 占位 id：fresh 会话的真实 session_id 在首条消息后的 system/init 帧才出现
    // （CLI 懒初始化）——立即返回；init 到达时发 session_backend_ready，
    // 宿主（createSessionHandle）监听该事件换绑真实复合 id。
    // randomUUID 防并发建会话同毫秒同 id 撞 store 键（加固 P2）
    const provisionalId = opts.sessionId ? `claude:${opts.sessionId}` : `claude:new-${randomUUID()}`;
    const handle = new ClaudeCodeHandle(provisionalId, child, opts.cwd || process.cwd(), opts.caps);
    handle.resumeSourceSid = opts.sessionId;
    handle.historyCwd = opts.historyCwd;
    // 种子模型：显式指定 > 状态文件恢复（重开会话不丢上次切换）> init 帧回报
    if (opts.model?.id) {
      handle.model = { id: opts.model.id, provider: "claude-code" };
    } else if (opts.sessionId) {
      const restored = await readExtModelState("claude", `claude:${opts.sessionId}`);
      if (restored?.selected?.id) handle.model = { id: restored.selected.id, provider: "claude-code" };
    }
    // 新会话（无显式模型/无同会话恢复）→ 该 agent 上次使用的模型（per-agent last used）
    // ⚠ 仅新会话：resume 会话的模型以 CLI/会话自身为准，不得用 agent 级默认覆盖
    if (!handle.model && !opts.sessionId) {
      const lastUsed = await readAgentLastUsedModel("claude");
      if (lastUsed?.id) handle.model = { id: lastUsed.id, provider: "claude-code" };
    }
    // 启动即写状态文件（selected + pi 目录快照）：引导外部 agent + 选择持久化
    handle.persistModelState();
    handle.permissionMode = opts.permissionMode ?? "bypassPermissions";
    return handle;
  }

  // ---- SessionHandle mandatory core ----------------------------------------

  async prompt(
    text: string,
    options?: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      files?: Array<{ data: string; mimeType: string; filename?: string }>;
      /** 运行中排队语义（core 透传）：steer/缺省/followUp 同入本地队列（协议无注入面，settle 后自动续轮）。 */
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-claude-code-agent] stdin closed");
    if (this.running) {
      // 分流归共享层：运行中输入入本地 followUp 队列（可撤回，result 后自动续轮）。
      // running 中 routePrompt 不会 dispatch（dispatch 回本方法，空闲时走下方执行路径）。
      await this.q.routePrompt(text, {
        images: options?.images as never,
        streamingBehavior: options?.streamingBehavior,
      });
      return;
    }
    // 组装内容块：文本 + 图片 + 文件（CC 原生支持 image/document base64 块，2026-08 实测）
    const content: Array<Record<string, unknown>> = [];
    for (const img of options?.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
    }
    for (const f of options?.files ?? []) {
      if (f.mimeType === "application/pdf") {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
      } else if (f.mimeType.startsWith("image/")) {
        content.push({ type: "image", source: { type: "base64", media_type: f.mimeType, data: f.data } });
      } else {
        console.warn(`[aiti-claude-code-agent] unsupported file mime "${f.mimeType}" (${f.filename ?? "?"}) — skipped`);
      }
    }
    if (text || content.length === 0) content.push({ type: "text", text });
    const ok = this.writeLine({
      type: "user",
      message: { role: "user", content },
    });
    if (!ok) throw new Error("[aiti-claude-code-agent] stdin closed");
    // 写成功后才置 running（加固 A4）：写失败抛错时 running 保持 false，队列不会被永久卡住
    this.running = true;
    this.liveHistory.push({ role: "user", content: text });
  }

  async abort(): Promise<void> {
    if (!this.running) return;
    const requestId = `int-${++this.seq}`;
    // 15s 超时（加固：对齐 set_model/set_permission_mode；CLI 忙时不让宿主 abort 永挂）
    const interrupted = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(false); }
      }, 15_000);
      timer.unref?.();
      this.interruptWaiters.push((ok) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(ok); }
      });
      const wrote = this.writeLine({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      });
      if (!wrote && !settled) { settled = true; clearTimeout(timer); resolve(false); }
    });
    if (!interrupted) console.warn("[aiti-claude-code-agent] interrupt not acknowledged");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (!this.aliveFlag) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 1000);
      this.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
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

  /**
   * 模型感知（后台切了我们能感知到）：CLI 侧模型变化（init/assistant 帧）时更新
   * 并广播 model_select（pi 原生 ModelSelectEvent 形状：source "set"|"cycle"|"restore"）。
   * handle-adapter 消费该事件回写 lastModel → context.model / get_state 跟随。
   */
  private trackModel(id: string, source: "set" | "restore"): void {
    const next = { id, provider: "claude-code" };
    const prev = this.model;
    if (prev && prev.id === id) return;
    this.model = next;
    if (prev) {
      // 从一个已知模型切到另一个 —— 后台主动切换，广播给前端
      this.emit({ type: "model_select", model: next, previousModel: prev, source });
      this.persistModelState();
    }
    // prev 为空 = 会话首帧初始化（restore），不广播（选择器直接展示即可）
  }

  /**
   * 运行时切换模型：set_model control_request → control_response。
   * 2026-08 对 claude 2.1.201 二进制取证确认该 subtype 存在（同 set_permission_mode 通道）。
   */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-claude-code-agent] stdin closed");
    const requestId = `sm-${++this.seq}`;
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.smWaiters.has(requestId)) {
          this.smWaiters.delete(requestId);
          console.warn(`[aiti-claude-code-agent] set_model(${model.id}) timed out — CLI may not have initialized yet (send a message first)`);
          resolve(false);
        }
      }, 15_000);
      this.smWaiters.set(requestId, (v) => { clearTimeout(timer); resolve(v); });
      const wrote = this.writeLine({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_model", model: model.id },
      });
      if (!wrote) { clearTimeout(timer); this.smWaiters.delete(requestId); resolve(false); }
    });
    if (ok) {
      const prev = this.model;
      this.model = { id: model.id, provider: "claude-code" };
      this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
      this.persistModelState();
    }
    return ok;
  }

  /** 临时模型状态文件（需求：启动/切换时把模型与 pi 目录存盘，引导外部 agent + 持久化）。 */
  persistModelState(): void {
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: this.stateAgentKey,
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models,
        updatedAt: "",
      }));
  }

  /**
   * 模型目录：CC 内置清单 + pi 目录（models.json 实时扁平化，选择器独立 "pi" 分组）。
   * 当前模型置顶；pi 模型能否被 CC 实际服务取决于其自身 provider 配置（fail-loud）。
   */
  async getAvailableModels(): Promise<Array<ExtModelEntry & { alias?: string }>> {
    return claudeCodeCatalog(this.model);
  }

  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    return this.commands;
  }

  async getAllTools(): Promise<Array<{ name: string; description: string }>> {
    return this.tools;
  }

  /** 从 onLine 的 assistant 完整帧构造消息并记入内存历史。 */
  private recordAssistant(msg: Record<string, unknown>): void {
    const message = (msg.message ?? {}) as Record<string, unknown>;
    const blocks: Array<Record<string, unknown>> = [];
    for (const b of (Array.isArray(message.content) ? message.content : []) as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "toolCall",
          toolCallId: String(b.id ?? ""),
          toolName: String(b.name ?? "tool"),
          input: (b.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    if (blocks.length > 0) {
      this.liveHistory.push({
        role: "assistant",
        content: blocks,
        model: typeof message.model === "string" ? message.model : this.model?.id ?? "",
        provider: "aiti-claude-code-agent",
      });
      // 后台模型感知：assistant 帧自带实际服务的 model（CLI 降级/切换会变）
      if (typeof message.model === "string" && message.model) this.trackModel(message.model, "set");
    }
  }

  /**
   * 历史回放：内存日志（本进程轮次）+ resume 场景的 jsonl 既往轮次（首次调用时读一次）。
   */
  async getMessages(): Promise<unknown[]> {
    // 内存日志优先：活会话期间它是权威（jsonl 可能尚未/同时落盘，避免双计）；
    // 内存为空时读 jsonl 拿既往轮次。
    if (this.liveHistory.length > 0) return [...this.liveHistory];
    if (this.prelude === null) {
      this.prelude = [];
      const sid = this.id.startsWith("claude:") ? this.id.slice(7) : this.id;
      // resume 场景：init 可能换发新 id，而历史 jsonl 仍以请求时的旧 sid 命名——两个都试
      const candidates = [sid, this.resumeSourceSid].filter((v): v is string => Boolean(v));
      // 目录候选：spawn cwd + 会话真实原 directory（冷恢复原目录已删时二者不同）
      const projectDirs = [...new Set([this.cwd, this.historyCwd]
        .filter((v): v is string => Boolean(v))
        .map((c) => c.replaceAll("/", "-")))];
      if (candidates.length > 0 && projectDirs.length > 0) {
        let saved: string | null = null;
        for (const projectDir of projectDirs) {
          for (const cand of candidates) {
            const file = join(homedir(), ".claude", "projects", projectDir, `${cand}.jsonl`);
            try {
              saved = await readFile(file, "utf8");
              break;
            } catch (e) {
              continue; // 该候选无落盘文件
            }
          }
          if (saved !== null) break;
        }
        if (saved !== null) {
          for (const line of saved.split("\n")) {
            if (!line.trim()) continue;
            let rec: Record<string, unknown>;
            try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
            if (rec.isSidechain === true || rec.isMeta === true) continue;
            const type = String(rec.type ?? "");
            if (type !== "user" && type !== "assistant") continue;
            const message = (rec.message ?? {}) as Record<string, unknown>;
            const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) || undefined : undefined;
            if (type === "user") {
              const c = message.content;
              if (Array.isArray(c)) {
                for (const b of c as Array<Record<string, unknown>>) {
                  if (b.type === "tool_result") {
                    const rc = Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>) : [];
                    const text = rc.map((x) => (typeof x.text === "string" ? x.text : "")).join("").trim();
                    this.prelude.push({ role: "toolResult", toolCallId: String(b.tool_use_id ?? ""), content: [{ type: "text", text }], isError: b.is_error === true, timestamp: ts });
                  }
                }
                const userText = (c as Array<Record<string, unknown>>).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
                if (userText) this.prelude.push({ role: "user", content: userText, timestamp: ts });
              } else if (typeof c === "string" && c.trim()) {
                this.prelude.push({ role: "user", content: c, timestamp: ts });
              }
              continue;
            }
            const blocks: Array<Record<string, unknown>> = [];
            for (const b of (Array.isArray(message.content) ? message.content : []) as Array<Record<string, unknown>>) {
              if (b.type === "text" && typeof b.text === "string" && b.text) blocks.push({ type: "text", text: b.text });
              else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) blocks.push({ type: "thinking", thinking: b.thinking });
              else if (b.type === "tool_use") blocks.push({ type: "toolCall", toolCallId: String(b.id ?? ""), toolName: String(b.name ?? "tool"), input: (b.input ?? {}) as Record<string, unknown> });
            }
            if (blocks.length > 0) this.prelude.push({ role: "assistant", content: blocks, model: typeof message.model === "string" ? message.model : "", provider: "aiti-claude-code-agent", timestamp: ts });
          }
        }
      }
    }
    return [...this.prelude, ...this.liveHistory];
  }

  async respondPermission(requestId: string, decision: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-claude-code-agent] stdin closed");
    const response: Record<string, unknown> = decision.behavior === "allow"
      ? { behavior: "allow", ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) }
      : { behavior: "deny", message: decision.message ?? "denied by user" };
    const ok = this.writeLine({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    // D4：决策写进会话消息流（deny 理由 / allow 备注；写失败也记录人工操作轨迹）
    const meta = this.permissionMeta.get(requestId);
    this.recordPermissionCustom(meta?.toolName, meta?.input, decision.behavior, requestId,
      decision.behavior === "deny" ? (decision.message ?? undefined) : (decision.updatedInput ? "入参已修正" : undefined));
    this.permissionPending.delete(requestId);
    this.permissionMeta.delete(requestId);
    return ok;
  }

  getUsage() {
    return this.lastUsage;
  }

  /** result 帧累计记账（getUsageTotals 数据源；字段缺失按 0 计）。 */
  private accumulateUsage(u: {
    inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
    cacheWriteTokens?: number; costUsd?: number;
  }): void {
    this.usageTotals.inputTokens += u.inputTokens ?? 0;
    this.usageTotals.outputTokens += u.outputTokens ?? 0;
    this.usageTotals.cacheReadTokens += u.cacheReadTokens ?? 0;
    this.usageTotals.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    this.usageTotals.costUsd += u.costUsd ?? 0;
    this.usageTotals.turns += 1;
  }

  /**
   * @capability contextUsage —— 当前上下文占用（最近 result 帧的 input 侧三项相加：
   * 非缓存 input + cache 读 + cache 写；CC 协议三者互斥、相加即发往模型的全量 prompt）。
   * 首轮 result 未到返回 undefined（前端「暂无数据」空轨态）。
   */
  getContextUsage(): { percent: number; contextWindow: number; tokens: number } | undefined {
    const u = this.lastUsage;
    if (!u) return undefined;
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (!(tokens > 0)) return undefined;
    const contextWindow = claudeContextWindow(this.model?.id ?? u.model);
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }

  /** @capability getUsageTotals —— 会话累计（宿主 get_session_stats 真实口径）。 */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  /**
   * 运行时切换权限模式：set_permission_mode control_request → control_response。
   * 2026-08 对 claude 2.1.201 实测成功（响应回传 {"mode":"acceptEdits"}）。
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-claude-code-agent] stdin closed");
    const requestId = `pm-${++this.seq}`;
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pmWaiters.has(requestId)) {
          this.pmWaiters.delete(requestId);
          console.warn(`[aiti-claude-code-agent] set_permission_mode(${mode}) timed out — CLI may not have initialized yet (send a message first)`);
          resolve(false);
        }
      }, 15_000);
      this.pmWaiters.set(requestId, (v) => { clearTimeout(timer); resolve(v); });
      const wrote = this.writeLine({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_permission_mode", mode },
      });
      if (!wrote) { clearTimeout(timer); this.pmWaiters.delete(requestId); resolve(false); }
    });
    if (ok) this.permissionMode = mode;
    return ok;
  }

  /** 当前权限模式（spawn 参数或运行时切换后的最新值）。 */
  getPermissionMode(): string | undefined {
    return this.permissionMode;
  }


  // fail-loud stubs
  steer(): never {
    throw new Error('Capability "steer" is not supported by session backend "aiti-claude-code-agent/claude-code"');
  }

  /** @capability followUp —— 运行中入本地队列（result 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-claude-code-agent] stdin closed");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage —— queue keeper 队列操作原语转发共享层。
   * followUp 组全 CRUD；steer 组恒空（stream-json 协议无运行中注入面）。
   */
  queueManage = (req: {
    action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
    kind?: "steer" | "followUp";
    from?: number;
    to?: number;
    index?: number;
    targetKind?: "steer" | "followUp";
    text?: string;
  }) => this.q.queueManage(req);
}

// ============================================================================
// Extension entry —— 协议族注册表：探测 PATH 上的同族 CLI，逐个注册 provider
// ============================================================================

/** claude-stream-json 协议族已知成员。flags 记录各家与 CC 原版的差异。 */
const FAMILY: Array<{
  name: string;
  bin: string;
  agentKey: string;
  label: string;
  /** cc-switch 风格档案目录（相对 home；如 .claude/<name>.json → --settings 注入） */
  profilesDir?: string;
  /** 运行时 set_permission_mode 已实测支持（未实测成员不开——fail-loud） */
  runtimePermissionMode?: boolean;
}> = [
  { name: "claude-code", bin: "claude", agentKey: "claude", label: "Claude Code CLI", runtimePermissionMode: true, profilesDir: ".claude" },
  // qoder/qoder-cn 已移交专属扩展 aiti-qoder-agent（credits/listModels 能力 + 区域路由），
  // 此处不再重复注册（同 agentKey 双注册会在 UI 出现重复后端）。
];

/** 每成员能力：共享基线 + 按实测标记开启运行时权限切换 */
function capsFor(member: (typeof FAMILY)[number]): SessionCapabilitiesLike {
  return { ...CC_CAPABILITIES, setPermissionMode: member.runtimePermissionMode === true };
}

function which(bin: string): string | null {
  // 纯 fs PATH 探测（2026-09-12：原 execFileSync("which") 移除——探针不阻塞事件循环）
  return whichBin(bin);
}

let registered: string[] = [];

/** configDir 兑底（宿主 serverContext 恒带 configDir；按 demo 约定自拼，仅防御性）。 */
function extDataDir(): string {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return join(root, "aiti-claude-code-agent", "config");
}

// ============================================================================
// 受控登录 driver（外部 Agent 受控登录标准，共享层 _shared/controlled-login.mjs）
// 模式 B paste-relay：spawn `claude auth login`，授权完成页显示一次性 code —— 用户粘回
// 前端 → submit 原样喂 login 进程 stdin（`Paste code here if prompted >`；兼容粘完整回调 URL）。
// ============================================================================

/** login URL 抓取（官方打印格式：stdout `…https://claude.com|claude.ai/cai/oauth/authorize?…`）。 */
export function extractClaudeLoginUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'`]*oauth\/authorize\?[^\s"'`]+/.exec(text);
  return m ? m[0] : null;
}

/** 结果判定：退出码 0 → success；其余 failed（尾行透出；code 错误/超时都是该路径）。 */
export function interpretClaudeLogin(code: number | null, stdout: string, stderr: string): { state: "success" | "failed"; error?: string } {
  if (code === 0) return { state: "success" };
  return { state: "failed", error: tailLine(stderr) || tailLine(stdout) || `claude auth login 异常退出（code=${code ?? "signal"}）` };
}

export const claudeLoginDriver = {
  agentId: "claude",
  mode: "paste" as const,
  loginTimeoutMs: 330_000,
  buildLogin: ({ runtime, consoleMode }: { runtime: string; consoleMode?: boolean }) => ({
    cmd: runtime || "claude",
    args: ["auth", "login", ...(consoleMode ? ["--console"] : [])],
    env: cleanEnv(),
  }),
  extractUrl: extractClaudeLoginUrl,
  interpret: interpretClaudeLogin,
};

/** 受控登录 API（startup 里挂载；/login/* 命中返回 Response，其余 null 放行）。 */
let loginApi: ((req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) => Promise<Response | null>) | null = null;
/** 受控登录控制器引用（shutdown 时终止进行中的登录进程）。 */
let loginCtl: { dispose(): void } | null = null;
/** DI：startup 捕获 ctx.services（session-manager.sessions 冷恢复 cwd 消费）。 */
let hostSvc: any = null;

/**
 * 冷恢复 cwd 修复（2026-09-16）：resume 场景 options.cwd 常缺省 → 曾落 process.cwd()
 * （= pi-web 服务端目录），而 claude 历史 jsonl 按会话真实目录存于
 * ~/.claude/projects/<cwd-encoded>/<sid>.jsonl —— 路径错 → getMessages 的 prelude
 * 回放读不到文件，打开历史会话恒空白。经 session-manager parseSession 取 meta.cwd
 * （同 aiti-zcode-agent 恢复语义）；缺席/读失败 → null（调用方走旧兜底）。
 */
async function restoredCwdFor(sessionId?: string): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const svc = hostSvc?.get?.("session-manager.sessions");
    if (typeof svc?.parseSession !== "function") return null;
    const parsed = await svc.parseSession(`claude:${sessionId}`);
    const cwd = typeof parsed?.meta?.cwd === "string" ? parsed.meta.cwd.trim() : "";
    return cwd || null;
  } catch {
    return null;
  }
}

// ============================================================================
// 会话 recycle API（zcode/codebuddy 同款，D8）：存量 handle 升级到当前扩展代码，无需重启 pi-web。
//   GET  /session/recycle               → 存量 claude-code 会话清单
//   POST /session/recycle {id, force?}  → dispose 旧 handle → loopback 重建（当前代码）
// ============================================================================

type RecycleHandleLike = { id: string; isRunning(): boolean; alive(): boolean; dispose(): unknown; cwd?: string };

function recycleSelfBase(req: Request): string {
  try {
    const u = new URL(req.url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      return u.origin;
    }
  } catch { /* fallthrough */ }
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}`;
}

async function recycleApi(req: Request, ctx: { path: string[]; method: string }): Promise<Response | null> {
  if (ctx.path[0] !== "session" || ctx.path[1] !== "recycle") return null;
  const store = (globalThis as { __sessionHandles?: Map<string, RecycleHandleLike> }).__sessionHandles;
  if (ctx.method === "GET") {
    const sessions = [...(store?.values() ?? [])]
      .filter((h) => h.id.startsWith("claude:"))
      .map((h) => ({ id: h.id, running: h.isRunning(), alive: h.alive() }));
    return Response.json({ sessions });
  }
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  let body: { id?: unknown; force?: unknown } = {};
  try { body = await req.json() as typeof body; } catch { /* 空体按缺省 */ }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id.startsWith("claude:")) return Response.json({ error: "id 必须是 claude: 复合 id" }, { status: 400 });
  const old = store?.get(id);
  if (!old) return Response.json({ error: `无存活的 handle：${id}` }, { status: 404 });
  if (old.isRunning() && !body.force) {
    return Response.json(
      { error: "会话正在运行中——等本轮收口后重试；确认要打断请带 force:true（当前轮作废，已排队消息随之清空）", running: true },
      { status: 409 },
    );
  }
  const realSid = id.startsWith("claude:sess_") || /^claude:[0-9a-f-]{36}$/.test(id) ? id.slice("claude:".length) : "";
  const cwd = typeof old.cwd === "string" ? old.cwd : "";
  try { await old.dispose(); } catch { /* 已死容错 */ }
  if (!realSid) {
    return Response.json({ recycled: true, recreated: false, id, note: "占位会话已释放（未发过消息的空会话），前端下次访问按需重建" });
  }
  const base = recycleSelfBase(req);
  try {
    const res = await fetch(`${base}/api/session-backends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerType: "aiti-claude-code-agent/claude-code", sessionId: realSid, ...(cwd ? { cwd } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return Response.json({
        recycled: true, recreated: false, id,
        error: `重建请求 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
        note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
      });
    }
    return Response.json({ recycled: true, recreated: true, id, session: data });
  } catch (e) {
    return Response.json({
      recycled: true, recreated: false, id,
      error: `重建请求失败: ${e instanceof Error ? e.message : String(e)}`,
      note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
    });
  }
}

// ============================================================================
// 账号额度（agent-manager 统一「账号额度」行；令牌仅服务端使用）
// ============================================================================

/** 额度缓存（成功 60s / 失败 10s；?force=1 绕过）。 */
let quotaCache: { at: number; ttl: number; value: Record<string, unknown> } | null = null;
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 10_000;

/** GET /login/quota[?force=1] → 归一化额度视图（凭据缺失/接口失败回落 available:false）。 */
async function quotaView(force: boolean): Promise<Response> {
  if (!force && quotaCache && Date.now() - quotaCache.at < quotaCache.ttl) return Response.json(quotaCache.value);
  const fail = (reason: string, note?: string): Response => {
    const v = { available: false, reason, ...(note ? { note } : {}), fetchedAt: Date.now() };
    quotaCache = { at: Date.now(), ttl: QUOTA_ERROR_TTL_MS, value: v };
    return Response.json(v);
  };
  const creds = readClaudeCreds();
  if (!creds) {
    // 2.1.318 起凭据迁 keyring（auth 有效但无文件可读）——区分「真没登录」与「登录了但额度查询拿不到 token」
    const loggedIn = await claudeAuthReady();
    return fail(
      "no-auth",
      loggedIn
        ? "已登录但凭据在系统 keyring（2.1.318+），额度查询无可读 token——跑一次 `claude setup-token` 导出后自愈"
        : "未找到 Claude 登录凭据（~/.claude/.credentials.json）",
    );
  }
  try {
    const v = await fetchClaudeQuota({ token: (creds as { token: string }).token, ...((creds as { expiresAt?: number }).expiresAt !== undefined ? { expiresAt: (creds as { expiresAt?: number }).expiresAt } : {}) });
    quotaCache = { at: Date.now(), ttl: QUOTA_TTL_MS, value: v };
    return Response.json(v);
  } catch (e) {
    return fail("fetch-failed", e instanceof Error ? e.message : String(e));
  }
}

/** 额度路由（先于受控登录层：该层对未知 /login/* 会返回 404 吞掉本路由）。 */
function quotaRoute(req: Request, ctx: { path: string[]; method: string; searchParams?: URLSearchParams }): Promise<Response> | null {
  const segs = Array.isArray(ctx?.path) ? ctx.path : [];
  if (segs[0] !== "login" || segs[1] !== "quota") return null;
  if (String(ctx?.method ?? "GET").toUpperCase() !== "GET") return null;
  let force = ctx?.searchParams?.get("force") === "1";
  if (!force) {
    try { force = new URL(req.url).searchParams.get("force") === "1"; } catch { /* 相对 URL 兜底 */ }
  }
  return quotaView(force);
}

/** GET /login/status 的登录态裁决（agent-manager extReportsAuthState 语义）。
 *  三级：凭据文件 / env token / `claude auth status`（2.1.318 起凭据迁 keyring，
 *  文件探测失效——CLI 是唯一可信源；60s 缓存防 manager 扫描放大 spawn）。 */
let authStatusCache: { at: number; ready: boolean } | null = null;
async function claudeAuthReady(): Promise<boolean> {
  if (readClaudeCreds()) return true;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
  if (authStatusCache && Date.now() - authStatusCache.at < 60_000) return authStatusCache.ready;
  let ready = false;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("claude", ["auth", "status"], { timeout: 8_000 })
      .then((r: { stdout: string }) => String(r.stdout || ""))
      .catch((e: { stdout?: string }) => String(e?.stdout || ""));
    let parsed: { loggedIn?: unknown } | null = null;
    try { parsed = JSON.parse(out) as { loggedIn?: unknown }; } catch { /* 非 JSON 输出走正则 */ }
    ready = parsed?.loggedIn === true || /\bloggedIn"?\s*[:=]\s*true\b/i.test(out);
  } catch { /* CLI 缺席/异常 = missing */ }
  authStatusCache = { at: Date.now(), ready };
  return ready;
}

export default {
  id: "aiti-claude-code-agent",
  name: "Claude Code (resume)",
  version: "0.1.0",
  icon: "🟣",
  // 受控登录统一弹窗（零构建原生 h() client；client/ 下两文件随 deploy 拷贝）
  // 静态插入点声明（与 client registerItems 的 id 一一对应）
  // 登录 UI 已统一到 aiti-agent-manager（受控登录弹窗退役，2026-09-13）：不再声明
  // client/ui —— 服务端 /login/* 与 .agent 描述符保留（manager 代理消费）。

  features: [spawnEnvFeature("Claude Code"), spawnCommandFeature("Claude Code"), spawnArgsPrefixFeature("Claude Code")],

  server: {
    startup(ctx: {
      /** 扩展数据目录（宿主 serverContext 恒提供；类型上按需声明）。 */
      configDir?: string;
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            extraArgs?: string[];
            env?: Record<string, string>;
            bin?: string;
            permissionMode?: string;
            listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          }): Promise<ClaudeCodeHandle>;
        }): string;
      };
      /** 跨扩展服务 slot（P2 协议委托：<extId>.launch 提供给 aiti-custom-agent；缺省=旧宿主降级）。 */
      services?: {
        provide<T>(key: string, impl: T): () => void;
        get?(name: string): unknown;
      };
    }) {
      registered = [];
      hostSvc = (ctx as { services?: { get?(name: string): unknown } }).services ?? null;
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json；docs/aiti-remote-queue-and-sidecar-plan.md §3）
      queueStateDir = (ctx as { stateDir?: string }).stateDir ?? join((ctx as { configDir?: string }).configDir ?? extDataDir(), "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // 受控登录（工具条 🔑，paste 模式）：spawn `claude auth login`，code 由前端回填 stdin。
      // consoleMode 档（API 计费）经 start body {consoleMode:true} 传入。
      const login = createControlledLogin({
        driver: claudeLoginDriver,
        configDir: (ctx as { configDir?: string }).configDir ?? extDataDir(),
        resolveRuntime: async () => {
          const bin = process.env.CLAUDE_CLI_PATH || "claude";
          if (!bin.includes("/") && !which(bin)) {
            throw new Error(
              `未找到 claude CLI（PATH 上无 "${bin}"，也未设置 CLAUDE_CLI_PATH）——请先安装 Claude Code；` +
              "或在有浏览器的机器上运行 `claude /login` 完成授权",
            );
          }
          return bin;
        },
        log: (m) => console.log(`[aiti-claude-code-agent] ${m}`),
      });
      loginApi = mountControlledLoginApi(login);
      loginCtl = login;
      for (const member of FAMILY) {
        if (!which(member.bin)) continue; // 未安装 → 不注册（装机才接）
        const key = ctx.sessionProviders.register({
          type: member.name,
          label: member.label,
          agentKey: member.agentKey,
          priority: 10,
          maxCapabilities: capsFor(member),
          // 静态目录（新建页选后端时给选择器供数据；无会话即可取）——上次使用的模型置顶，
          // 前端默认选中它（list[0]），新建会话即默认该 agent 上次使用的模型
          listModels: async () => withLastUsedFirst(await claudeCodeCatalog(), (await readAgentLastUsedModel("claude"))?.id),
          // cc-switch 档案清单（~/.claude/<name>.json；内容含凭证不出服务端）
          ...(member.profilesDir
            ? {
                listProfiles: async () => {
                  const RESERVED = new Set([
                    "settings.json", "auth.json", ".credentials.json", "backup.json",
                    "stats-cache.json", "config.json", "statsig.json", "usage.json",
                    "todos.json", "ide-lock.json",
                  ]);
                  const dir = `${process.env.HOME ?? process.env.USERPROFILE}/${member.profilesDir}`;
                  try {
                    const files = await (await import("node:fs/promises")).readdir(dir);
                    return files
                      .filter((f) => f.endsWith(".json") && !f.startsWith(".") && !RESERVED.has(f))
                      .map((f) => ({ name: f.replace(/\.json$/, ""), path: `${dir}/${f}` }));
                  } catch {
                    return [];
                  }
                },
              }
            : {}),
          // 冷恢复 cwd（2026-09-16）：真实历史 jsonl 按会话原 directory 存放，resume 的
          // cwd 也应回到原目录。但原目录可能已删（项目清理）——spawn cwd 必须存在（否则
          // ENOENT 打不开会话，比空白更糟），此时 spawn 落显式/兜底 cwd，历史回放仍按
          // 原目录找 jsonl（historyCwd 与 spawn cwd 解耦）。
          createSession: async (options) => {
            let cwd = options.cwd;
            let historyCwd: string | undefined;
            if (!cwd && options.sessionId) {
              const restored = await restoredCwdFor(options.sessionId);
              if (restored) {
                if (existsSync(restored)) cwd = restored;
                else historyCwd = restored;
              }
            }
            return ClaudeCodeHandle.start({
              ...options,
              ...(cwd ? { cwd } : {}),
              ...(historyCwd ? { historyCwd } : {}),
              bin: member.bin,
              caps: capsFor(member),
            });
          },
        });
        registered.push(key);
      }
      console.log(`[aiti-claude-code-agent] registered family members: ${registered.join(", ") || "(none on PATH)"}`);
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用——manager 不写死各家
      ctx.services?.provide?.("aiti-claude-code-agent.agent", {
        agent: "claude",
        label: "Claude Code",
        modes: ["paste"],
        accountQuota: true, // 支持账号额度查询（agent-manager 聚合 GET /login/quota）
        // 2026-11-05 claude 2.1.318：凭据迁出明文文件（keyring 域，路径不可 stat）——
        // fs 探测表会误报 missing；改由本扩展 /login/status 端点裁决（claude auth status 兜底）。
        extReportsAuthState: true,
        dependencyHint: "claude CLI（npm i -g @anthropic-ai/claude-code）",
        auth: [
          { kind: "file", path: [".claude", ".credentials.json"], label: "~/.claude/.credentials.json" },
          { kind: "env", path: ["CLAUDE_CODE_OAUTH_TOKEN"], label: "env CLAUDE_CODE_OAUTH_TOKEN" },
          { kind: "env", path: ["ANTHROPIC_AUTH_TOKEN"], label: "env ANTHROPIC_AUTH_TOKEN" },
        ],
        accountSlots: (c: { home: string }) => [
          { key: "claude-oauth", label: "OAuth 凭据", path: join(c.home, ".claude", ".credentials.json") },
        ],
      });
      // P2 协议委托：向 aiti-custom-agent 暴露 launch 服务（成员的启动包装 → 本扩展完整协议会话）。
      // 契约最小化：agentKey + capabilities + listModels + createSessionFromLaunch(launch, options)。
      const primary = FAMILY.find((m) => which(m.bin)) ?? FAMILY[0];
      ctx.services?.provide?.("aiti-claude-code-agent.launch", {
        agentKey: primary.agentKey,
        capabilities: capsFor(primary),
        listModels: async () => withLastUsedFirst(await claudeCodeCatalog(), (await readAgentLastUsedModel("claude"))?.id),
        createSessionFromLaunch: (launch: LaunchOverride, options: Record<string, unknown>) =>
          ClaudeCodeHandle.start({
            ...(options as Parameters<typeof ClaudeCodeHandle.start>[0]),
            launchOverride: launch,
            caps: capsFor(primary),
          }),
      });
      console.log("[aiti-claude-code-agent] launch service provided: aiti-claude-code-agent.launch");
    },

    /** 受控登录 API：POST /login/start · GET /login/status · POST /login/cancel · POST /login/submit（paste 模式）+ 会话 recycle。 */
    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const recycled = await recycleApi(req, ctx);
      if (recycled) return recycled;
      const quota = quotaRoute(req, ctx);
      if (quota) return quota;
      // agent-manager 优先语义（extReportsAuthState）：先于 loginApi（其对未知 /login/* 返 404）
      if (ctx?.path?.[0] === "login" && ctx?.path?.[1] === "status" && String(ctx.method ?? "GET").toUpperCase() === "GET") {
        return Response.json({ state: (await claudeAuthReady()) ? "ready" : "missing" });
      }
      return loginApi ? await loginApi(req, ctx) : null;
    },

    /** 扩展停卸/reload：终止进行中的登录进程（状态文件留档，下次 status reconcile 为 failed）。 */
    shutdown() {
      loginCtl?.dispose();
      loginCtl = null;
      loginApi = null;
    },
  },
};
