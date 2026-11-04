/**
 * aiti-cursor-agent — 会话后端扩展：驱动 Cursor Agent CLI（`cursor agent`）会话。
 *
 * 打通 all-sessions 的跨 agent 链路：agentKey "cursor"（fork takeover 映射
 * cursor-agent / cursor-agent-writer → cursor）。pi-web 会话宇宙里的 Cursor
 * 子代理：落盘、Fleet 面板、前端打开 attach 全套复用。
 *
 * CLI 形态（cursor 3.17 实测 --help）：
 *   cursor agent -p <prompt> --output-format stream-json [--stream-partial-output]
 *                [--resume <chatId>] [--model <m>] [--mode plan|ask]
 *   - 一次进程 = 一轮（print 模式）；多轮会话靠 --resume <chatId> 重新 spawn。
 *   - stream-json 行格式官方文档缺位：解析器宽松自适应（实测 3.17：init/user/
 *     thinking/assistant 增量词帧/完整帧/result；文本帧一律当增量累积，result
 *     帧唯一收尾；未识别行忽略）。
 *   - resume 历史播种：首次 getMessages 从落盘（store.db/jsonl，经共享
 *     cursor-cli-store.ts）读既往轮次，接管历史会话不再空白。
 *
 * 能力面（fail-loud）：prompt/abort/getMessages ✅；steer（CLI 无交互通道）/
 * fork/rename/compact/respondPermission ❌。权限：print 模式无审批流，工具
 * 访问由用户 cursor 配置决定（需要收紧时调用方经 extraArgs 传 --mode plan）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fetchCursorQuota, readCursorToken } from "./cursor-quota.ts";
import { existsSync, mkdirSync } from "node:fs";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { agentSpawnEnv, spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readCursorCliChat, type CursorCliMessage } from "@aiti-ai/ext-shared/cursor-cli-store";
import {
  readExtModelState, readAgentLastUsedModel, readPiModels, renameExtModelState, writeExtModelState,
  mergeModelCatalogs, withCurrentFirst, withLastUsedFirst, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";
// 受控登录共享层（权威源 pi-web-ext/_shared/controlled-login.mjs，副本随扩展部署——改动须双向同步）
import { cleanEnv, createControlledLogin, mountControlledLoginApi, tailLine } from "@aiti-ai/ext-shared/controlled-login";
// 队列共享实现层（权威源 pi-web-ext/_shared/backend-queue.ts，副本随扩展部署——改动须双向同步）
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar } from "@aiti-ai/ext-shared/backend-queue";

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

/**
 * 模型目录核心（handle 方法与注册级静态 listModels 共用）：
 * cursor 内置（auto）+ pi 目录（实时扁平化）。当前模型置顶。
 */
async function cursorCatalog(current?: { id: string; provider: string }): Promise<ExtModelEntry[]> {
  const builtin: ExtModelEntry[] = [
    { id: "auto", label: "Auto", provider: "cursor", source: "ext" },
  ];
  const piModels = await readPiModels();
  return withCurrentFirst(
    mergeModelCatalogs(builtin, piModels),
    current,
  );
}

/**
 * cursor 模型族上下文窗口（getContextUsage 换算用）：模型目录含 "auto" 等无法
 * 判族的值——未命中返回 undefined（空轨态，不编数字）。
 */
export function cursorContextWindow(modelId?: string): number | undefined {
  if (typeof modelId !== "string" || !modelId) return undefined;
  const m = modelId.toLowerCase();
  if (m === "auto") return undefined;
  if (m.includes("gpt-5")) return 272_000;
  if (m.includes("gpt-4")) return 128_000;
  if (/\bo[134]\b|o[134]-/.test(m)) return 200_000;
  if (m.includes("claude")) return m.includes("[1m]") ? 1_000_000 : 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("grok")) return 256_000;
  return undefined; // composer 等自研模型窗口未公开 → 不猜
}

const CURSOR_CAPABILITIES: SessionCapabilitiesLike = {
  prompt: true,
  followUp: true, // 排队：共享层 backend-queue（运行中入队，settle 后自动续轮，queue_update 同步前端）
  queueManage: true, // 队列 keeper 全 CRUD（共享层 backend-queue；docs/backend-queue-manager-plan.md M3）
  abort: true,
  getMessages: true,
  // 目录 = 内置（auto 等）+ pi 目录；切换 = 下一轮 spawn 的 --model（每轮单发进程，天然生效）
  listModels: true,
  respondPermission: false,
  getUsage: false,
  fileAttachments: false,
  contextUsage: false,
  setModel: true,
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
  // 2026-09-06 取证 cursor-agent --help：--mode plan|ask + --yolo；spawn 参数下轮生效
  setPermissionMode: true,
  steer: false,
};

// ============================================================================
// CursorHandle
// ============================================================================

class CursorHandle {
  readonly source = "aiti-cursor-agent/cursor";
  readonly capabilities: SessionCapabilitiesLike = CURSOR_CAPABILITIES;
  /** 复合 id（"cursor:<chatId>"；首轮未定前用占位，chatId 到手后换绑）。 */
  id: string;
  readonly cwd: string;

  private child: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  private chatId: string | undefined;
  /** 恢复模式：创建时给定 chatId（All Sessions 历史/URL 恢复）——首轮 spawn 即 --resume。 */
  private resumeChatId: string | undefined;
  private model: { id: string; provider: string } | undefined;
  /** 最近一轮 usage（result 帧机会式提取；wire 未定稿，可能恒缺） */
  private lastUsage: {
    model?: string; inputTokens?: number; outputTokens?: number;
    cacheReadTokens?: number; cacheWriteTokens?: number;
  } | undefined;
  /** 会话累计用量（有 usage 帧才累加；getUsageTotals 数据源） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  /** 本 handle 生命周期内的消息（user prompt + assistant 文本/工具块）。 */
  private history: unknown[] = [];
  /** resume/恢复场景：首次 getMessages 时从 CLI 落盘（store.db/jsonl）读既往轮次
   *  （只读一次；null=未读，[]=已读但无）。对齐 claude-code-agent 的 prelude 模式。 */
  private prelude: unknown[] | null = null;
  private lastText = "";
  /** 本轮是否已收尾（result 帧 / 进程退出二选一，防重复 message_end/入史）。 */
  private turnEnded = false;
  /**
   * 队列支持（共享层 backend-queue，docs/backend-queue-manager-plan.md §3）：print 模式无
   * 实时输入通道（无 steer）——运行中发送一律本地 followUp 队列（可撤回/排序），settle 后自动续轮。
   */
  private q = createBackendQueueSupport({
    isRunning: () => this.running,
    alive: () => this.aliveFlag,
    dispatch: (text) => this.prompt(text),
    onEvent: (ev) => this.emit(ev),
    log: (m) => console.warn(m),
    // 队列崩溃恢复 sidecar（docs/aiti-remote-queue-and-sidecar-plan.md §3）
    persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
  });
  /** setPermissionMode 的期望模式（每轮 spawn 参数；下轮生效，同 setModel 语义）。 */
  private desiredMode: string | undefined;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
  }

  private emit(event: Record<string, unknown>): void {
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧、不得沿流回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-cursor-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 宽松提取 chatId（cursor stream-json 字段名未定稿，多候选探测）。 */
  private extractChatId(msg: Record<string, unknown>): void {
    if (this.chatId) return;
    for (const key of ["chatId", "chat_id", "sessionId", "session_id", "conversationId"]) {
      const v = msg[key];
      if (typeof v === "string" && v) {
        this.chatId = v;
        const oldId = this.id;
        this.id = `cursor:${v}`;
        this.emit({ type: "session_backend_ready", oldId, id: this.id });
        // 状态文件跟随换绑（模型选择持久化到真实 chat id 名下）
        renameExtModelState("cursor", oldId, this.id).then(() => this.persistModelState());
        // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则换绑前排队的条目崩溃后不可恢复）
        migrateQueueSidecar(queueStateDir, oldId, this.id, (m) => console.warn(m));
        return;
      }
    }
  }

  /** 宽松提取 assistant 文本增量/完整文本（兼容 claude 形态与扁平形态）。 */
  private consumeLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.extractChatId(msg);
    // result 帧已收尾后忽略晚到的文本帧（防重复帧产生永不结束的悬空流）；
    // extractChatId 仍执行，保留 id 绑定机会。
    if (this.turnEnded) return;
    const type = String(msg.type ?? "");

    if (type === "thinking") return; // thinking 不进正文流（cursor 独立事件类型）

    // init 帧：model 感知（"Auto" 等；变化时广播 model_select）
    if (type === "system" && msg.subtype === "init") {
      const m = typeof msg.model === "string" ? msg.model : undefined;
      if (m) this.trackModel(m, "restore");
      return;
    }

    // claude stream-json 兼容形态（增量）
    if (type === "stream_event") {
      const ev = (msg.event ?? {}) as Record<string, unknown>;
      const delta = (ev.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        this.appendDelta(delta.text);
      }
      return;
    }
    // cursor stream-json（3.17 实测）：--stream-partial-output 下 assistant 帧
    // 是增量词帧（"one"/" two"/…），结尾另有完整帧 + result 帧（同全文）。
    // 无稳定的帧型判别字段 —— 一律当增量累积，message_end 只在 result
    // （兑底：进程退出）时发一次，否则每个词/每种帧都会变成独立消息。
    if (type === "assistant") {
      const message = (msg.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      // 后台模型感知：assistant 帧自带实际服务的 model
      if (typeof message.model === "string" && message.model) this.trackModel(message.model, "set");
      const text = content
        .map((b) => (b as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string")
        .join("");
      if (text) this.appendDelta(text);
      return;
    }
    if (type === "result") {
      const result = typeof msg.result === "string" ? msg.result : "";
      this.extractUsage(msg);
      this.finishTurn(result || this.lastText, msg.is_error === true ? "cursor agent reported is_error" : undefined);
      return;
    }

    // 扁平/未知形态兜底：任何带非空 text/content 文本的行都当作增量
    const flatText = typeof msg.text === "string" ? msg.text
      : typeof msg.content === "string" ? msg.content : "";
    if (flatText) this.appendDelta(flatText);
  }

  /** 流式增量：累积全文 + 发 message_update（适配层补 assistantMessageEvent）。 */
  private appendDelta(text: string): void {
    this.lastText += text;
    this.emit({ type: "message_update", delta: text });
  }

  /** 轮次收尾（幂等）：入史一条完整 assistant + 一次 message_end + agent_settled。 */
  private finishTurn(text: string, error?: string): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    // result 帧即本轮语义结束 —— 立即放行下一轮。print 模式一轮一进程，
    // CLI 进程本身可能因 stdin 管道未关而残活，不能等 exit 才清 running
    // （否则后续 prompt 全部被「上一轮仍在运行」拒绝）；残活进程由下轮
    // runTurn 收割。
    this.running = false;
    if (text) {
      this.lastText = text;
      this.pushAssistant(text, {});
      this.emit({ type: "message_end", role: "assistant", text });
    }
    this.emit({ type: "agent_settled", ...(error ? { error } : {}), result: text || undefined });
    // 排队续轮：微任务让 agent_settled 先到达前端（流式状态复位）再开新一轮（共享层幂等）
    this.q.scheduleDrain();
  }

  private pushAssistant(text: string, message: Record<string, unknown>): void {
    if (!text) return;
    this.history.push({
      role: "assistant",
      content: [{ type: "text", text }],
      model: typeof message.model === "string" ? message.model : this.model?.id ?? "",
      provider: "aiti-cursor-agent",
    });
  }

  /** spawn 一轮（print 模式；多轮经 --resume）。 */
  private runTurn(text: string): void {
    // 上一轮子进程若仍残活（CLI 打完 result 后可能因 stdin 未关而挂着）——
    // 结果已入库（finishTurn 已收尾），直接收割避免进程堆积。
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    const args = [
      "agent",
      "-p", text,
      "--output-format", "stream-json",
      "--stream-partial-output",
      "--trust", // workspace trust：非交互模式不信任目录会直接失败（cwd 均为用户项目目录）
      // 权限模式（desiredMode 下轮生效）：plan→--mode plan；default/未切→--yolo
      // （2026-09-06 默认改最大权限：headless 下权限询问无法应答，不给 --yolo 会因权限失败）；
      // bypassPermissions→--yolo 同款。acceptEdits/dontAsk 在 setPermissionMode 已拒（cursor 无对应档）。
      ...(this.desiredMode === "plan" ? ["--mode", "plan"] : []),
      ...(!this.desiredMode || this.desiredMode === "default" || this.desiredMode === "bypassPermissions" ? ["--yolo"] : []),
      ...(this.chatId ? ["--resume", this.chatId] : this.resumeChatId ? ["--resume", this.resumeChatId] : []),
      ...(this.model?.id ? ["--model", this.model.id] : []),
    ];
    // P1' 启动包装（docs/aiti-custom-agent-plan.md）：extman spawn.command/spawn.argsPrefix，缺省 = 行为不变
    // P2：launchOverride（custom-agent 委托路径）优先于 extman feature
    const ov = this.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: "cursor",
      command: ov?.command?.trim() || spawnCommand("aiti-cursor-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-cursor-agent")).args,
      driverArgs: args,
      env: agentSpawnEnv({ extId: "aiti-cursor-agent", envList: spawnEnvList("aiti-cursor-agent") }),
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: this.cwd || process.cwd(),
      warn: (m) => console.log(`[aiti-cursor-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: this.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    this.child = child;
    this.lastText = "";
    this.turnEnded = false;
    this.running = true;
    this.emit({ type: "agent_start", sessionId: this.id, model: this.model });

    this.detachReader?.();
    this.detachReader = lineReader(child.stdout, (line) => this.consumeLine(line), {
      onOverflow: () => {
        if (!superseded()) this.finishTurn(this.lastText, "cursor agent stdout line overflow");
      },
    });
    // 三个流必须挂 error 监听（加固 A2）：ECONNRESET/EPIPE 无监听器会崩宿主进程。
    child.stdout?.on("error", (err) => {
      if (superseded()) return;
      this.finishTurn(this.lastText, `cursor agent stdout error: ${err.message}`);
    });
    child.stderr?.on("error", (err) => console.log(`[aiti-cursor-agent:${this.id.slice(0, 20)}] stderr error: ${err.message}`));
    child.stdin?.on("error", (err) => console.log(`[aiti-cursor-agent:${this.id.slice(0, 20)}] stdin error: ${err.message}`));
    child.stderr?.on("data", (c: Buffer | string) => {
      const text = String(c).trim();
      if (text) console.log(`[aiti-cursor-agent:${this.id.slice(0, 20)}] ${text.slice(0, 300)}`);
    });
    // 被换代（新一轮已 spawn）的旧子进程事件一律忽略 —— 否则 SIGTERM 残活时
    // 其晚到的 exit 会把新轮次当成自己的收尾（running 清零 / turnEnded 置位 /
    // 重复入史），导致新轮 result 丢失。
    const superseded = () => this.child !== child;
    child.once("error", (err) => {
      if (superseded()) return;
      this.running = false;
      this.aliveFlag = false;
      this.emit({ type: "session_backend_dead", reason: `process error: ${err.message}` });
    });
    child.once("exit", (code) => {
      if (superseded()) return;
      this.running = false;
      // result 帧已收尾则此处幂等空转；未收到 result（崩溃/被杀）时用累积文本兑底
      this.finishTurn(this.lastText, code !== 0 ? `cursor agent exited (${code ?? "signal"})` : undefined);
    });
  }

  // ---- SessionHandle mandatory core ----------------------------------------

  async prompt(text: string, opts?: { streamingBehavior?: string }): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-cursor-agent] session dead");
    if (this.running) {
      // [共享层 backend-queue] 运行中分流：followUp/缺省一律本地队列（可撤回/排序），
      // settle 后自动续轮；cursor print 模式无实时输入通道，不存在 steer 注入分支。
      await this.q.routePrompt(text, opts?.streamingBehavior ? { streamingBehavior: opts.streamingBehavior } : undefined);
      return;
    }
    this.history.push({ role: "user", content: text });
    this.runTurn(text);
  }

  /** @capability followUp —— 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage —— queue keeper 队列操作原语（共享层全 CRUD；steering 组
   * 恒空——cursor 无运行中注入能力）。clear 返回清空前文本（pi clearQueue 契约，
   * 前端「全部编辑」回填输入框）。
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

  async abort(): Promise<void> {
    if (!this.running || !this.child) return;
    this.child.kill("SIGTERM");
  }

  /**
   * 运行时切换权限模式（每轮 spawn 参数：下轮生效，同 setModel 语义）。
   * 2026-09-06 对 cursor-agent --help 取证：--mode plan|ask、--yolo（--force 别名）。
   * UI 五档映射：default→无 flag、plan→--mode plan、bypassPermissions→--yolo；
   * acceptEdits/dontAsk 无对应档 fail-loud（print 模式无逐项确认通道，勿静默错映射）。
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    const supported = ["default", "plan", "bypassPermissions"];
    if (!supported.includes(mode)) {
      throw new Error(`[aiti-cursor-agent] 非法权限模式 "${mode}"（cursor 可选：${supported.join("/")}；acceptEdits/dontAsk 无对应档）`);
    }
    this.desiredMode = mode;
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.child && this.running) {
      this.child.kill("SIGTERM");
    }
    this.child = null;
    this.aliveFlag = false;
    this.q.dispose();
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

  /**
   * 模型感知（后台切了我们能感知到）：init/assistant 帧模型变化时广播
   * model_select（pi 原生 ModelSelectEvent 形状）。首轮初始化不广播。
   */
  private trackModel(id: string, source: "set" | "restore"): void {
    const next = { id, provider: "aiti-cursor-agent" };
    const prev = this.model;
    if (prev && prev.id === id) return;
    this.model = next;
    if (prev) {
      this.emit({ type: "model_select", model: next, previousModel: prev, source });
      this.persistModelState();
    }
  }

  /**
   * 机会式 usage 提取（result 帧）：cursor stream-json wire 官方未定稿，不假设
   * usage 一定在——claude 形态字段（input_tokens/cache_read_input_tokens/
   * cache_creation_input_tokens）逐个探测，数值齐才记账；拿不到不编数据。
   */
  private extractUsage(msg: Record<string, unknown>): void {
    const u = (msg.usage ?? null) as Record<string, unknown> | null;
    if (!u || typeof u !== "object") return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const inputTokens = n(u.input_tokens);
    const outputTokens = n(u.output_tokens);
    const cacheReadTokens = n(u.cache_read_input_tokens);
    const cacheWriteTokens = n(u.cache_creation_input_tokens);
    if (inputTokens === undefined && outputTokens === undefined) return;
    this.lastUsage = {
      model: this.model?.id,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    };
    this.usageTotals.inputTokens += inputTokens ?? 0;
    this.usageTotals.outputTokens += outputTokens ?? 0;
    this.usageTotals.cacheReadTokens += cacheReadTokens ?? 0;
    this.usageTotals.cacheWriteTokens += cacheWriteTokens ?? 0;
    this.usageTotals.turns += 1;
  }

  /**
   * @capability contextUsage（机会式）——最近 result 帧 usage 齐全且模型族窗口
   * 可判才报；wire 未定稿/模型未知 → undefined（前端空轨态）。
   */
  getContextUsage(): { percent: number; contextWindow: number; tokens: number } | undefined {
    const u = this.lastUsage;
    if (!u) return undefined;
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (!(tokens > 0)) return undefined;
    const contextWindow = cursorContextWindow(this.model?.id ?? u.model);
    if (!contextWindow) return undefined;
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }

  /** @capability getUsageTotals —— 会话累计（宿主 get_session_stats 真实口径；无 usage 帧 → 全 0）。 */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  /**
   * 切换模型（每轮单发进程模型：记录 desired model，下一轮 spawn 带 --model 即生效）。
   */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    const prev = this.model;
    this.model = { id: model.id, provider: "aiti-cursor-agent" };
    this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
    this.persistModelState();
    return true;
  }

  /**
   * 模型目录：cursor 内置（auto）+ pi 目录（models.json 实时扁平化，"pi" 分组）。
   * 当前模型置顶；CLI 不认识的模型名在轮次时报错（fail-loud）。
   */
  async getAvailableModels(): Promise<ExtModelEntry[]> {
    return cursorCatalog(this.model);
  }

  /** 临时模型状态文件（启动/切换时写：selected + pi 目录快照，引导 spawn --model 与重开恢复）。 */
  persistModelState(): void {
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: "cursor",
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models,
        updatedAt: "",
      }));
  }

  /** 落盘历史 → handle 消息形状（与 runTurn 的入史形状一致）。 */
  private toPrelude(msgs: CursorCliMessage[]): unknown[] {
    return msgs.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.text }
        : { role: "assistant", content: [{ type: "text", text: m.text }], model: this.model?.id ?? "", provider: "aiti-cursor-agent" },
    );
  }

  async getMessages(): Promise<unknown[]> {
    // resume 场景：首次调用时从 CLI 落盘读既往轮次（只读一次）。
    // 必须在 liveHistory 为空时读 — 此时 live 轮次尚未入 store.db，拼接不重复；
    // live 已有轮次时跳过（与 claude-code-agent 同一去重权衡）。
    if (this.prelude === null) {
      this.prelude = [];
      const sid = this.chatId ?? this.resumeChatId;
      if (sid && !this.history.length) {
        try {
          const s = readCursorCliChat(sid);
          if (s) this.prelude = this.toPrelude(s.messages);
        } catch { /* 落盘不可读 — 历史为空，fail-soft */ }
      }
    }
    return [...this.prelude, ...this.history];
  }
}

// ============================================================================
// 受控登录 driver（外部 Agent 受控登录标准，共享层 _shared/controlled-login.mjs）
// 模式 A url-only：spawn `cursor login` + NO_OPEN_BROWSER=1（官方无浏览器通道，URL 抓取实测）。
// ============================================================================

/** login URL 抓取（官方打印格式实测：stdout `navigate to this link: <url>`）。 */
export function extractCursorLoginUrl(text: string): string | null {
  const m = /navigate to this link:\s*(https?:\/\/\S+)/.exec(text);
  return m ? m[1] : null;
}

/** 结果判定：退出码 0 → success；其余 failed（尾行透出）。 */
export function interpretCursorLogin(code: number | null, stdout: string, stderr: string): { state: "success" | "failed"; error?: string } {
  if (code === 0) return { state: "success" };
  return { state: "failed", error: tailLine(stderr) || tailLine(stdout) || `cursor login 异常退出（code=${code ?? "signal"}）` };
}

export const cursorLoginDriver = {
  agentId: "cursor",
  mode: "url" as const,
  loginTimeoutMs: 330_000,
  buildLogin: ({ runtime }: { runtime: string }) => ({
    cmd: runtime || "cursor",
    args: ["login"],
    env: cleanEnv({ NO_OPEN_BROWSER: "1" }),
  }),
  extractUrl: extractCursorLoginUrl,
  interpret: interpretCursorLogin,
};

// ============================================================================
// 扩展入口
// ============================================================================

/** 受控登录 API（startup 里挂载；/login/* 命中返回 Response，其余 null 放行）。 */
let loginApi: ((req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) => Promise<Response | null>) | null = null;
/** 受控登录控制器引用（shutdown 时终止进行中的登录进程）。 */
let loginCtl: { dispose(): void } | null = null;

/** 队列崩溃恢复 sidecar 根（startup 捕获 <stateDir>；undefined/空 = 不持久化）。 */
let queueStateDir: string | undefined;

/** configDir 兑底（宿主 serverContext 恒带 configDir；按 demo 约定自拼，仅防御性）。 */
function extDataDir(): string {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return join(root, "aiti-cursor-agent", "config");
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
  const creds = (() => { const tok = readCursorToken(); return tok ? { token: tok } : null; })();
  if (!creds) return fail("no-auth", "未找到 Cursor 登录凭据（~/.config/cursor/auth.json）");
  try {
    const v = await fetchCursorQuota({ token: (creds as { token: string }).token });
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

export default {
  id: "aiti-cursor-agent",
  name: "Cursor Agent",
  version: "0.1.0",
  // 受控登录统一弹窗（零构建原生 h() client；client/ 下两文件随 deploy 拷贝）
  // 静态插入点声明（与 client registerItems 的 id 一一对应）
  // 登录 UI 已统一到 aiti-agent-manager（受控登录弹窗退役，2026-09-13）：不再声明
  // client/ui —— 服务端 /login/* 与 .agent 描述符保留（manager 代理消费）。

  features: [spawnEnvFeature("Cursor"), spawnCommandFeature("Cursor"), spawnArgsPrefixFeature("Cursor")],

  server: {
    startup(ctx: {
      /** 扩展数据目录（宿主 serverContext 恒提供；类型上按需声明）。 */
      configDir?: string;
      /** 不可再生持久数据目录（数据分层；旧宿主缺省回退 <configDir>/state）。 */
      stateDir?: string;
      /** 跨扩展服务 slot（P2 协议委托；缺省=旧宿主降级）。 */
      services?: { provide<T>(key: string, impl: T): () => void };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          createSession(options: {
            cwd?: string;
            sessionId?: string;
            model?: { provider: string; id: string };
            listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          }): Promise<CursorHandle>;
        }): string;
      };
    }) {
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json；docs/aiti-remote-queue-and-sidecar-plan.md §3）
      queueStateDir = (ctx as { stateDir?: string }).stateDir ?? join((ctx as { configDir?: string }).configDir ?? "", "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // 受控登录（工具条 🔑）：spawn `cursor login` + NO_OPEN_BROWSER=1
      const login = createControlledLogin({
        driver: cursorLoginDriver,
        configDir: (ctx as { configDir?: string }).configDir ?? extDataDir(),
        resolveRuntime: async () => {
          const bin = process.env.CURSOR_CLI_PATH || "cursor";
          if (!bin.includes("/") && !whichBin(bin)) {
            throw new Error(
              `未找到 cursor CLI（PATH 上无 "${bin}"，也未设置 CURSOR_CLI_PATH）——请先安装 Cursor Agent CLI；` +
              "或在有浏览器的机器上运行 `cursor login` 完成授权",
            );
          }
          return bin;
        },
        log: (m) => console.log(`[aiti-cursor-agent] ${m}`),
      });
      loginApi = mountControlledLoginApi(login);
      loginCtl = login;
      // P2 协议委托：createSession 主体抽出供 launch 服务复用（cwd 解析/模型种子/状态文件同链路）
      const createCursorSession = async (
        options: { cwd?: string; sessionId?: string; model?: { provider: string; id: string } },
        launchOverride?: LaunchOverride,
      ) => {
        // sessionId = cursor chatId（All Sessions 历史行 / ?session= URL 恢复）
        const resume = typeof options.sessionId === "string" && options.sessionId ? options.sessionId : undefined;
        const id = resume ? `cursor:${resume}` : `cursor:new-${randomUUID()}`;
        // 尊重会话原 cwd：resume 优先用会话自己落盘的工作区（CLI 按工作区隔离
        // 历史 —— 用页面 cwd 会把续轮分叉到新 workspaceKey 目录）。
        let cwd = "";
        let savedModel: string | undefined;
        if (resume) {
          try {
            const saved = readCursorCliChat(resume);
            cwd = saved?.cwd ?? "";
            // 会话真实模型（store.meta.lastUsedModel）：接管时选择器直接展示，
            // cursor print 模式无 init 帧，这是唯一真实模型源
            savedModel = typeof saved?.model === "string" && saved.model ? saved.model : undefined;
          } catch { /* 落盘不可读 */ }
        }
        if (!cwd) cwd = options.cwd || "";
        const handle = new CursorHandle(id, cwd || process.cwd());
        handle.launchOverride = launchOverride;
        handle.resumeChatId = resume;
        handle.chatId = resume;
        // 种子模型：显式指定 > 状态文件恢复 > store 真实模型（优先级递减，zcode 同序）
        if (options.model?.id) {
          handle.model = { id: options.model.id, provider: "aiti-cursor-agent" };
        } else if (resume) {
          const restored = await readExtModelState("cursor", `cursor:${resume}`);
          if (restored?.selected?.id) handle.model = { id: restored.selected.id, provider: "aiti-cursor-agent" };
          else if (savedModel) handle.model = { id: savedModel, provider: "aiti-cursor-agent" };
        }
        // 新会话（无显式模型/无同会话恢复/无 store 真实模型）→ 该 agent 上次使用的模型
        // ⚠ 仅新会话：resume 会话模型以 store/CLI 自身为准，不用 agent 级默认覆盖
        if (!handle.model && !resume) {
          const lastUsed = await readAgentLastUsedModel("cursor");
          if (lastUsed?.id) handle.model = { id: lastUsed.id, provider: "aiti-cursor-agent" };
        }
        // 启动即写状态文件（pi 目录快照 + selected），引导外部 agent
        handle.persistModelState();
        return handle;
      };
      ctx.sessionProviders.register({
        type: "cursor-agent",
        label: "Cursor Agent CLI",
        agentKey: "cursor",
        priority: 10,
        maxCapabilities: CURSOR_CAPABILITIES,
        // 静态目录（新建页选后端时给选择器供数据；无会话即可取）——上次使用的模型置顶
        listModels: async () => withLastUsedFirst(await cursorCatalog(), (await readAgentLastUsedModel("cursor"))?.id),
        createSession: async (options) => createCursorSession(options),
      });
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用——manager 不写死各家
      ctx.services?.provide?.("aiti-cursor-agent.agent", {
        agent: "cursor",
        label: "Cursor Agent CLI",
        modes: ["url"],
        accountQuota: true, // 支持账号额度查询（agent-manager 聚合 GET /login/quota）
        dependencyHint: "cursor-agent CLI",
        auth: [
          { kind: "file", path: [".config", "cursor", "auth.json"], label: "~/.config/cursor/auth.json" },
          { kind: "file", path: [".cursor", "auth.json"], label: "~/.cursor/auth.json（旧路径）" },
        ],
        accountSlots: (c: { home: string }) => {
          // Linux 实测 ~/.config/cursor/auth.json；mac/win 旧路径兜底 ~/.cursor/auth.json
          const primary = join(c.home, ".config", "cursor", "auth.json");
          const legacy = join(c.home, ".cursor", "auth.json");
          return [{ key: "cursor-auth", label: "OAuth 凭据", path: !existsSync(primary) && existsSync(legacy) ? legacy : primary }];
        },
      });
      ctx.services?.provide?.("aiti-cursor-agent.launch", {
        agentKey: "cursor",
        capabilities: CURSOR_CAPABILITIES,
        listModels: async () => withLastUsedFirst(await cursorCatalog(), (await readAgentLastUsedModel("cursor"))?.id),
        createSessionFromLaunch: (launch: LaunchOverride, options: { cwd?: string; sessionId?: string; model?: { provider: string; id: string } }) =>
          createCursorSession(options, launch),
      });
      console.log("[aiti-cursor-agent] registered session provider: cursor-agent (agentKey: cursor) + launch service");
    },

    /** 受控登录 API：POST /login/start · GET /login/status · POST /login/cancel · POST /login/submit。 */
    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const quota = quotaRoute(req, ctx);
      if (quota) return quota;
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
