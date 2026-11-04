/**
 * aiti-codex-agent — 会话后端扩展：OpenAI Codex CLI 驱动。
 *
 * 协议：`codex exec --json`（2026-08 对 codex-cli 0.149 实测）
 *   → {"type":"thread.started","thread_id":uuid}
 *   → {"type":"item.completed","item":{type:"agent_message",text} |
 *                                    {type:"command_execution",...} | ...}
 *   → {"type":"turn.started"} / {"type":"turn.completed","usage":{...}}
 *   → {"type":"turn.failed","error":{message}}
 *
 * 进程模型：每轮一个 codex exec 进程（单发），续接用 `codex exec resume <id>`。
 * 与 CC print 模式同款懒持久化：thread_id 首轮后可知，session_backend_ready 换绑。
 * 事件契约：受理即发 agent_start，exit 前 agent_end（前端流式态只认这对；wire 层丢弃
 * turn_started）；运行中 prompt 进 pending 队列，settle 后微任务续轮（queue_update 同步前端）。
 * abort：SIGTERM→1s→SIGKILL 两阶段杀当前轮进程，exit 收尾归为 aborted（会话文件已含已完成部分）。
 *
 * 认证：透传环境变量（如 OPENROUTER_API_KEY，按用户 ~/.codex/config.toml 的 provider）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fetchCodexQuota, readCodexCreds } from "./codex-quota.ts";
import { readFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { accessSync, constants as fsConstants } from "node:fs";

/** PATH 探测 + 用户级 bin 目录兑底（systemd 服务 PATH 缺 ~/.npm-global/bin）。 */
const EXTRA_BIN_DIRS = [
  process.env.HOME ? join(process.env.HOME, ".npm-global", "bin") : "",
  process.env.HOME ? join(process.env.HOME, ".local", "bin") : "",
  "/usr/local/bin",
].filter(Boolean);

function resolveCodexBin(): string {
  const name = process.env.CODEX_CLI_PATH || "codex";
  if (name.includes("/")) return name;
  const onPath = whichBin(name);
  if (onPath) return onPath;
  for (const dir of EXTRA_BIN_DIRS) {
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return join(dir, name);
    } catch { /* next */ }
  }
  return name;
}
import { homedir, tmpdir } from "node:os";
import { governanceEnv } from "./external-governance.ts";
import { agentSpawnEnv, spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// 队列共享实现层（权威源 pi-web-ext/_shared/backend-queue.ts，副本随扩展部署——改动须双向同步）
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar } from "@aiti-ai/ext-shared/backend-queue";
import {
  readExtModelState, readAgentLastUsedModel, readPiModels, renameExtModelState, writeExtModelState,
  mergeModelCatalogs, withCurrentFirst, withLastUsedFirst, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";
// 冷恢复工具行回放共享口径（权威源 pi-web-ext/_shared/seed-tool.ts；D18 各家归一）——
// 空/失败输出的占位文案直播路径同源，直播卡与回放卡才不会一个有字一个空。
import { createSeedToolReplay, EMPTY_TOOL_ERROR, EMPTY_TOOL_OUTPUT } from "@aiti-ai/ext-shared/seed-tool";
// 受控登录共享层（权威源 pi-web-ext/_shared/controlled-login.mjs，副本随扩展部署——改动须双向同步）
import { cleanEnv, createControlledLogin, mountControlledLoginApi, tailLine } from "@aiti-ai/ext-shared/controlled-login";

/** 队列崩溃恢复 sidecar 根（startup 捕获 <stateDir>；undefined/空 = 不持久化）。 */
let queueStateDir: string | undefined;

let hostSvc: any = null; // DI 方案 P1：startup 捕获 ctx.services（session-manager.sessions 消费）

// ============================================================================
// 结构化契约（out-of-tree）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

/** ~/.codex/config.toml 的 model 键（CLI 不带 -m 时的真实默认；读不到→null）。 */
function codexConfiguredDefault(): string | null {
  try {
    const cfg = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * 模型目录核心（handle 方法与注册级静态 listModels 共用）：
 * codex 内置常用模型 + pi 目录（实时扁平化）。当前模型置顶。
 * 配置默认模型置顶：新建页默认档取目录首项（list[0]），首项与 CLI 真实默认错位会误导（zcode 同款问题，2026-09-06）。
 */
async function codexCatalog(current?: { id: string; provider: string }): Promise<ExtModelEntry[]> {
  const configured = codexConfiguredDefault();
  const builtin: ExtModelEntry[] = [
    ...(configured && !configured.startsWith("gpt-5.1")
      ? [{ id: configured, label: `${configured}（config 默认）`, provider: "codex", source: "ext" as const }]
      : []),
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", provider: "codex", source: "ext" },
    { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", provider: "codex", source: "ext" },
    { id: "gpt-5.1", label: "GPT-5.1", provider: "codex", source: "ext" },
  ];
  const piModels = await readPiModels();
  return withCurrentFirst(
    mergeModelCatalogs(builtin, piModels),
    current,
  );
}

// 工具类 item（item.started/item.completed）——方案 X：直播走 pi 原生条目（与冷恢复回放同形）
const TOOL_ITEM_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/** 结果文本上限（同 session-manager codex adapter 的 TOOL_RESULT_MAX，直播/回放一致口径）。 */
const TOOL_RESULT_TEXT_CAP = 4000;

/**
 * 工具 item → 原生 toolCall 的 {toolName, input}。命名与入参键形对齐 rollout 的 function_call
 * （exec_command 的 `{cmd}` / apply_patch），冷回放与直播才是同一张卡；宿主 getToolPreview
 * 按 command/path/query 等键取预览，键名错了就只剩空串。
 */
function codexToolCallOf(item: Record<string, unknown>): { toolName: string; input: Record<string, unknown> } {
  const type = String(item.type ?? "");
  if (type === "command_execution") return { toolName: "exec_command", input: { cmd: String(item.command ?? "") } };
  if (type === "file_change") {
    const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
    return { toolName: "apply_patch", input: { changes: changes.map((c) => String(c?.path ?? "")).filter(Boolean).join(", ") } };
  }
  if (type === "web_search") return { toolName: "web_search", input: { query: String(item.query ?? "") } };
  if (type === "mcp_tool_call") {
    const args = item.arguments;
    return {
      toolName: typeof item.tool === "string" && item.tool ? item.tool : "mcp_tool",
      input: args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {},
    };
  }
  return { toolName: type || "tool", input: {} };
}

/** 失败判定：status=failed 或退出码非 0（exec 型 item 两者都给）。 */
function codexToolFailed(item: Record<string, unknown>): boolean {
  return String(item.status ?? "") === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
}

/** 结果文本：非字符串输出（mcp result 等）序列化；空白按成败给占位（seed-tool 同口径，卡片不裸奔）。 */
function codexToolResultText(item: Record<string, unknown>, isError: boolean): string {
  const raw = item.aggregated_output ?? item.result ?? item.output ?? "";
  const text = typeof raw === "string"
    ? raw
    : (raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw ?? ""));
  return text.trim().slice(0, TOOL_RESULT_TEXT_CAP) || (isError ? EMPTY_TOOL_ERROR : EMPTY_TOOL_OUTPUT);
}

/**
 * codex 模型族上下文窗口（getContextUsage 换算用）：GPT-5 系（gpt-5/gpt-5-codex/
 * gpt-5.1…，codex 默认族）272K；GPT-4 系 128K；未知回 272K（当前缺省族，宁近似
 * 不空——tooltip 展示窗口数值可核对）。OpenAI 语义 `input_tokens` 已含
 * `cached_input_tokens`（cached 是 input 的子集口径）。
 */
export function codexContextWindow(modelId?: string): number {
  if (typeof modelId === "string" && /gpt-4/.test(modelId)) return 128_000;
  return 272_000;
}

const CODEX_CAPABILITIES: SessionCapabilitiesLike = {
  steer: false,
  followUp: true, // 自建排队：运行中入队，settle 后自动续轮（共享层 queue_update → 前端）
  queueManage: true, // [T3] 队列 keeper 全 CRUD（共享层 backend-queue；pi-web-ext backend-queue-manager-plan M3）
  // 上下文用量（2026-09-19，推翻 D2 收敛）：turn.completed usage 三项够算当前占用
  // （input+output，cached ⊆ input），窗口按模型族 map（codexContextWindow）——D2 时
  // 「无窗口数据」的前提由静态 map 补齐，percent 供 ctx-meter/底栏 chip。
  contextUsage: true,
  // 每轮单发进程模型：模型即下一轮 spawn 的 -m 参数——切换天然「下轮生效」
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
  respondPermission: false,
  getUsage: true,
  // 目录 = 内置 codex 常用模型 + pi 目录（临时状态文件引导，见 ext-model-state.ts）
  listModels: true,
  fileAttachments: true, // -i --image（图片经临时文件传递）
  getMessages: true,
};

// ============================================================================
// CodexHandle —— 单发进程 × 轮次模型
// ============================================================================

class CodexHandle {
  readonly source = "aiti-codex-agent/codex";
  readonly capabilities = CODEX_CAPABILITIES;
  readonly cwd: string;
  id: string;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;

  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  private threadId: string | undefined;
  private lastUsage: Record<string, unknown> | undefined;
  /** 会话累计用量（本 handle 存活期逐轮累加；getUsageTotals 数据源，进程重启归零） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 };
  /** 当前模型（public：createSession 种子/状态恢复从外部赋值）。 */
  model: { id: string; provider: string } | undefined;
  /** 待决轮次终结器（当前 prompt 的 resolver） */
  private turnWaiter: ((stopReason: string) => void) | null = null;
  /** 当前轮次错误（turn.failed 填充，agent_settled 随行） */
  private turnError: string | undefined;
  /** 当前轮子进程（abort 真 kill 用；runTurn 期间非 null）。 */
  private child: ChildProcess | null = null;
  /** 用户主动 abort 标记：exit 收尾时归为 aborted 而非 process_exit。 */
  private abortRequested = false;
  /**
   * 队列支持（共享层 docs/backend-queue-manager-plan.md.md §3；T3 通用性验证实例——
   * 无 steer 注入能力的后端形态）：运行中发送一律本地 followUp 队列（带图片 R4 闭环，
   * queue keeper 可见可撤回），settle 后自动续轮。
   */
  private q = createBackendQueueSupport({
    isRunning: () => this.running || !this.aliveFlag,
    alive: () => this.aliveFlag,
    dispatch: (text, images) => this.prompt(text, { images }),
    onEvent: (ev) => this.emit(ev),
    log: (m) => console.warn(m),
    // 队列崩溃恢复 sidecar（docs/aiti-remote-queue-and-sidecar-plan.md §3）
    persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
  });

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
        console.error(`[aiti-codex-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 执行一轮：spawn codex exec [--json] [-m <model>] [resume <sid>] "<prompt>"，
   * 流式解析事件直到 turn.completed/failed。
   */
  private async runTurn(promptText: string, opts?: {
    images?: Array<{ data: string; mimeType: string; filename?: string }>;
    signal?: "resume";
  }): Promise<string> {
    const cli = resolveCodexBin();
    // -m/--model 是官方 exec/resume 全局参数：set_model 后下一轮即用新模型
    const argv: string[] = [
      "exec", "--json", "--skip-git-repo-check",
      // 默认最大权限：exec 非交互 approval 本就 never，但 sandbox 默认 read-only 会把写文件/网络全部拒掉
      "--dangerously-bypass-approvals-and-sandbox",
      ...(this.model?.id ? ["-m", this.model.id] : []),
    ];
    const imagePaths: string[] = [];
    // 附件目录：UUID 后缀防同毫秒碰撞；turn 收口统一清理（加固：曾泄漏 /tmp）
    let attachDir: string | undefined;
    if (opts?.images?.length) {
      attachDir = join(tmpdir(), `codex-att-${randomUUID()}`);
      const { mkdirSync } = await import("node:fs");
      try { mkdirSync(attachDir, { recursive: true }); } catch { /* exists */ }
      let i = 0;
      for (const img of opts.images) {
        const ext = img.mimeType.split("/")[1] || "png";
        const p = join(attachDir, `att-${++i}.${ext}`);
        await writeFile(p, Buffer.from(img.data, "base64"));
        imagePaths.push(p);
      }
    }
    for (const p of imagePaths) argv.push("-i", p);

    // P1' 启动包装（docs/aiti-custom-agent-plan.md）：extman spawn.command/spawn.argsPrefix，
    // 缺省 = 行为不变；fresh/resume 两分支共用一次解析；P2 launchOverride（委托路径）优先
    const codexEnv = agentSpawnEnv({ cli: "codex", governance: governanceEnv, extId: "aiti-codex-agent", envList: spawnEnvList("aiti-codex-agent") });
    const ov = this.launchOverride;
    const codexLaunch = (driverArgs: string[]) => resolveCliLaunch({
      defaultCommand: cli,
      command: ov?.command?.trim() || spawnCommand("aiti-codex-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-codex-agent")).args,
      driverArgs,
      env: codexEnv,
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: this.cwd,
      warn: (m) => console.log(`[aiti-codex-agent] ${m}`),
    });

    // prompt 走 stdin（codex `-` 契约，0.149.1 help 实证）：文本不进 argv——
    // 进程列表不可见（隐私），`-` 开头的 prompt 也不会被 CLI 当 flag 误解析（加固 P2）。
    const PROMPT_STDIN = "-";
    let child: ChildProcess;
    if (opts?.signal === "resume" && this.threadId) {
      const l = codexLaunch([...argv, "resume", this.threadId, PROMPT_STDIN]);
      child = spawn(l.command, l.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: l.env });
    } else {
      const l = codexLaunch([...argv, PROMPT_STDIN]);
      child = spawn(l.command, l.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: l.env });
    }
    this.child = child;
    child.stdin?.on("error", () => { /* 子进程提前退出 EPIPE 属正常 */ });
    child.stdin?.end(promptText);
    // 三个流必须挂 error 监听（加固 A2）：ECONNRESET/EPIPE 无监听器会崩宿主进程。
    child.stdout?.on("error", (err) => {
      console.error(`[aiti-codex-agent] stdout error: ${err.message}`);
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    });
    child.stderr?.on("error", (err) => console.log(`[aiti-codex-agent] stderr error: ${err.message}`));

    const turnPromise = new Promise<string>((resolve, reject) => {
      let buffer = "";
      let finalText = "";
      let settledStop = "";
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let m: Record<string, unknown>;
        try { m = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        const t = String(m.type ?? "");
        if (t === "thread.started") {
          const tid = String(m.thread_id ?? "");
          if (tid && !this.threadId) {
            this.threadId = tid;
            const oldId = this.id;
            this.id = `codex:${tid}`;
            this.emit({ type: "session_backend_ready", oldId, id: this.id });
            // 状态文件跟随换绑（模型选择持久化到真实 thread id 名下）
            renameExtModelState("codex", oldId, this.id).then(() => this.persistModelState());
            // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则换绑前排队的条目崩溃后不可恢复）
            migrateQueueSidecar(queueStateDir, oldId, this.id, (m) => console.warn(m));
          }
          return;
        }
        if (t === "item.started") {
          // 方案 X：工具项开始 → 原生 assistant.toolCall（liveHistory + 直播；宿主按 toolCallId
          // 折叠随后的 toolResult）。不再发 🛠 custom 卡——冷回放（seedHistory）已是原生卡，
          // 直播出 custom 卡会让同一会话出现两种形态。
          const item = (m.item ?? {}) as Record<string, unknown>;
          if (TOOL_ITEM_TYPES.has(String(item.type ?? ""))) this.recordToolCallStart(item);
          return;
        }
        if (t === "item.completed") {
          const item = (m.item ?? {}) as Record<string, unknown>;
          const itemType = String(item.type ?? "");
          if (itemType === "agent_message") {
            const text = String(item.text ?? "");
            if (text) {
              finalText += (finalText ? "\n" : "") + text;
              this.emit({ type: "message_update", delta: text });
            }
          } else if (TOOL_ITEM_TYPES.has(itemType)) {
            const output = this.recordToolCallEnd(item);
            this.emit({
              type: "tool_execution_end",
              toolName: itemType === "command_execution" ? "bash" : codexToolCallOf(item).toolName,
              summary: output.slice(0, 200),
            });
          }
          return;
        }
        if (t === "turn.completed") {
          const usage = (m.usage ?? {}) as Record<string, number>;
          this.lastUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cached_input_tokens,
          };
          this.usageTotals.inputTokens += usage.input_tokens ?? 0;
          this.usageTotals.outputTokens += usage.output_tokens ?? 0;
          this.usageTotals.cacheReadTokens += usage.cached_input_tokens ?? 0;
          this.usageTotals.turns += 1;
          settledStop = "end_turn";
        }
        if (t === "turn.failed") {
          const err = (m.error ?? {}) as Record<string, unknown>;
          settledStop = "error";
          const errMsg = String(err.message ?? "turn failed");
          this.turnError = errMsg;
          // 错误必须以 pi 词汇 assistant 消息（stopReason:"error" + errorMessage）送达前端：
          // MessageView 渲染红色 alert；否则用户只见「转完没下文」。同时进 liveHistory（重开可见）。
          const errorMessage = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: errMsg,
            ...(this.model?.id ? { model: this.model.id } : {}),
            provider: "codex",
          };
          this.liveHistory.push(errorMessage);
          this.emit({ type: "message_end", message: errorMessage });
          this.emit({ type: "agent_settled_error", error: errMsg });
        }
        if (t === "error" && !settledStop) {
          console.warn(`[aiti-codex-agent] error frame: ${String(m.message ?? "").slice(0, 150)}`);
        }
      };
      const detach = attachLines(child.stdout, onLine);
      child.stderr?.on("data", () => {});
      child.once("exit", () => {
        detach();
        this.child = null;
        this.running = false;
        if (this.abortRequested) {
          // 用户主动 abort（SIGTERM）：安静收尾，归为 aborted（非错误非正常结束）
          settledStop = "aborted";
          this.abortRequested = false;
        } else if (!settledStop) {
          settledStop = "process_exit";
        }
        if (finalText) {
          // 带 model/provider：前端消息模型标签（与 seedHistory/turnFailed 形状一致）
          this.liveHistory.push({
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            ...(this.model?.id ? { model: this.model.id } : {}),
            provider: "codex",
          });
        }
        // error 字段对齐 aiti-claude-code-agent：前端/扩展可从 settled 读到失败原因。
        // agent_end 先于 agent_settled（zcode 同序：前端流式态先复位再收敛）。
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: settledStop, ...(this.turnError ? { error: this.turnError } : {}) });
        this.turnError = undefined;
        resolve(settledStop);
      });
      child.once("error", (err) => {
        reject(new Error(`[aiti-codex-agent] spawn failed: ${err.message}`));
      });
    });

    // turn 收口（exit 后）清理附件临时目录（加固：曾泄漏 /tmp）
    if (attachDir) {
      const { rmSync } = await import("node:fs");
      void turnPromise.finally(() => {
        try { rmSync(attachDir, { recursive: true, force: true }); } catch { /* 清理失败不致命 */ }
      });
    }
    return turnPromise;

    function attachLines(stream: NodeJS.ReadableStream | null, cb: (line: string) => void): () => void {
      if (!stream) return () => {};
      // 字节累积、整行 utf8 解码（加固 A1）+ 行长上限（超限杀进程走 exit 收口）
      let buf: Buffer = Buffer.alloc(0);
      let overflowed = false;
      const onData = (chunk: Buffer | string) => {
        if (overflowed) return;
        const c = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        buf = buf.length === 0 ? c : Buffer.concat([buf, c]);
        for (;;) {
          const i = buf.indexOf(0x0a);
          if (i === -1) return;
          const line = buf.subarray(0, i).toString("utf8");
          buf = buf.subarray(i + 1);
          cb(line);
        }
      };
      stream.on("data", onData);
      return () => stream.off("data", onData);
    }
  }

  private liveHistory: unknown[] = [];
  /** 已发出原生 toolCall 条目的 item id（started 帧可能缺席/重复——completed 据此补发或跳过）。 */
  private toolCallSeen = new Set<string>();

  /**
   * 工具项开始 → 原生 assistant.toolCall（liveHistory + message_end）。liveHistory 也要记：
   * 宿主 settle 后 refetch 走 getMessages()，只有调用条目在场，ToolCallBlock 才配得上结果。
   */
  private recordToolCallStart(item: Record<string, unknown>): void {
    const callId = String(item.id ?? "");
    if (callId && this.toolCallSeen.has(callId)) return;
    if (callId) this.toolCallSeen.add(callId);
    const { toolName, input } = codexToolCallOf(item);
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", ...(callId ? { toolCallId: callId } : {}), toolName, input }],
      ...(this.model?.id ? { model: this.model.id } : {}),
      provider: "codex",
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  /**
   * 工具项完成 → 原生 toolResult（与调用条同 toolCallId，宿主折叠成一张卡）。
   * 返回结果文本供 tool_execution_end 摘要。
   */
  private recordToolCallEnd(item: Record<string, unknown>): string {
    const callId = String(item.id ?? "");
    if (callId && !this.toolCallSeen.has(callId)) this.recordToolCallStart(item);
    const { toolName } = codexToolCallOf(item);
    const isError = codexToolFailed(item);
    const text = codexToolResultText(item, isError);
    const message = {
      role: "toolResult",
      ...(callId ? { toolCallId: callId } : {}),
      toolName,
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
    return text;
  }

  async prompt(text: string, options?: {
    images?: Array<{ data: string; mimeType: string; filename?: string }>;
    files?: Array<{ data: string; mimeType: string; filename?: string }>;
  }): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codex-agent] stdin closed");
    if (this.running) {
      // [T3 共享层] 运行中分流归 backend-queue：本地 followUp 队列（带图片，可撤回），
      // settle 后自动续轮；codex 无运行中注入能力（exec 单发）→ 不存在 steer 分支。
      await this.q.routePrompt(text, { images: options?.images });
      return;
    }
    this.running = true;
    this.liveHistory.push({ role: "user", content: text });
    // 受理即发：前端 spinner「等待模型」立刻出现（CLI 冷启动可能数秒）。
    // wire 层丢弃 turn_started，前端流式态只认 agent_start/agent_end 对。
    this.emit({ type: "agent_start" });
    try {
      await this.runTurn(text, {
        ...(options?.images ? { images: options.images } : {}),
        ...(this.threadId ? { signal: "resume" as const } : {}),
      });
    } catch (e) {
      // spawn 失败等异常：转 error 帧收敛（前端红色 alert 可见，不静默），防 spinner 挂死
      this.turnFailed(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
    // 排队续轮：微任务让 agent_settled 先到达前端（流式状态复位）再开新一轮（共享层幂等）
    this.q.scheduleDrain();
  }

  /** 错误以 pi 词汇 assistant 消息（stopReason:"error"）送达前端（MessageView 红色 alert），并进 liveHistory。 */
  private turnFailed(errMsg: string): void {
    const errorMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: errMsg,
      ...(this.model?.id ? { model: this.model.id } : {}),
      provider: "codex",
    };
    this.liveHistory.push(errorMessage);
    this.emit({ type: "message_end", message: errorMessage });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled_error", error: errMsg });
    this.emit({ type: "agent_settled", stopReason: "error", error: errMsg });
  }

  // emitQueue 已由共享层 q.emitUpdate() 承担（queue_update 契约：steering 恒空 + followUp）

  /** @capability followUp —— 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-codex-agent] stdin closed");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage —— queue keeper 队列操作原语（共享层全 CRUD；steering 组恒空——
   * codex 无运行中注入能力，不存在该组）。followUp 组带图片（R4 同款闭环）。
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
    // 失步兜底：前端运行态与 handle 状态失步（如收口帧竞态丢失）时补发一帧 aborted
    // 收口让前端复位——静默 return 会让停止按钮永久悬挂（幂等，真空闲时多一帧无害）。
    if (!this.running || !this.child) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    // 单发进程模型：无取消协议——SIGTERM 杀当前轮进程即中止本轮（会话文件已含已完成部分）。
    // 两阶段：SIGTERM 宽限 1s → SIGKILL（zcode 同款）；exit 收尾归为 aborted。
    this.abortRequested = true;
    const child = this.child;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, 1000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    this.aliveFlag = false;
    this.q.dispose();
    this.listeners.clear();
    return Promise.resolve();
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
   * 切换模型（每轮单发进程模型：记录 desired model，下一轮 spawn 带 -m 即生效）。
   * 同步返回 true——无运行中进程可拒绝；选错模型在下一轮报错（fail-loud）。
   */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    const prev = this.model;
    this.model = { id: model.id, provider: "codex" };
    this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
    this.persistModelState();
    return true;
  }

  /**
   * 模型目录：codex 内置常用模型 + pi 目录（models.json 实时扁平化）。
   * 当前模型置顶；选错模型在轮次时报错（fail-loud）。
   */
  async getAvailableModels(): Promise<ExtModelEntry[]> {
    return codexCatalog(this.model);
  }

  /** 临时模型状态文件（启动/切换时写：selected + pi 目录快照，引导 spawn -m 与重开恢复）。 */
  persistModelState(): void {
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: "codex",
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models,
        updatedAt: "",
      }));
  }

  getUsage() {
    return this.lastUsage as never;
  }

  /**
   * @capability contextUsage —— 当前上下文占用（最近 turn.completed：input+output；
   * OpenAI 语义 cached_input_tokens ⊆ input_tokens，不重复相加）。首轮未完成返回
   * undefined（前端「暂无数据」空轨态）。
   */
  getContextUsage(): { percent: number; contextWindow: number; tokens: number } | undefined {
    const u = this.lastUsage as { inputTokens?: number; outputTokens?: number } | undefined;
    if (!u) return undefined;
    const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    if (!(tokens > 0)) return undefined;
    const contextWindow = codexContextWindow(this.model?.id);
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }

  /** @capability getUsageTotals —— 会话累计（宿主 get_session_stats 真实口径）。 */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  /** 内存对话日志（单发进程模型：本 handle 生命周期内的全部轮次）。 */
  async getMessages(): Promise<unknown[]> {
    return [...this.liveHistory];
  }

  /**
   * 历史回填（All Sessions 服务出口读取的落点）：IndexedMessage[] → liveHistory 形状。
   * 结构化工具行（codex adapter 的 function_call/function_call_output 配对结果）→ pi 原生
   * assistant toolCall + toolResult（按 callID 配对，宿主 ToolCallBlock 渲成工具卡片）；
   * 🛠 文本行只作结构化缺席时的兜底（交棒上下文语义：老索引不丢内容）。
   * assistant 消息带 model/provider（前端消息模型标签渲染依赖这两字段）。
   */
  seedHistory(messages: Array<{ role?: unknown; text?: unknown; model?: unknown; provider?: unknown; tool?: unknown }>): void {
    const replay = createSeedToolReplay("codex-tool");
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const tool = role === "assistant"
        ? replay.entries(m.tool, {
          model: typeof m.model === "string" && m.model ? m.model : undefined,
          provider: typeof m.provider === "string" && m.provider ? m.provider : undefined,
        })
        : null;
      if (tool) {
        this.liveHistory.push(...tool);
        continue;
      }
      const text = typeof m.text === "string" ? m.text : "";
      if (!text.trim()) continue;
      this.liveHistory.push({
        role,
        // user 内容为 string（与 prompt 的 push 形状一致）；assistant 为 text block 数组
        ...(role === "assistant" ? { content: [{ type: "text", text }] } : { content: text }),
        ...(typeof m.model === "string" && m.model ? { model: m.model } : {}),
        ...(typeof m.provider === "string" && m.provider ? { provider: m.provider } : {}),
      });
    }
  }
}

// ============================================================================
// Extension entry
// ============================================================================

let lastKey: string | null = null;
let counter = 0;

// ============================================================================
// 受控登录 driver（外部 Agent 受控登录标准，共享层 _shared/controlled-login.mjs）
// 模式 A url-only：spawn `codex login --device-auth`（官方设备码模式，远程/headless 官方推荐）。
// ⚠ TODO(155 校准)：本机无 OpenAI 网络，输出格式未实测——URL 正则先按通用 https 抓取，
// 155 代理出网首跑校准（docs/ext-controlled-login-standard.md §1 codex 行）。
// ============================================================================

/** login URL 抓取（TODO 校准档：通用 https URL，含 deviceauth/usercode 设备码页）。
 *  剥尾标点：错误行形如 `... for url (https://…/usercode)`，正则会把右括号带进来
 *  （agent-manager 面板直显此 URL，点开即 404）。 */
export function extractCodexLoginUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'`]+/.exec(text.replace(/(?:^|\s)https?:\/\/[^\s"'`]*localhost[^\s"'`]*/g, " "));
  return m ? m[0].replace(/[)\]},.;:!?]+$/, "") : null;
}

/** 结果判定：退出码 0 → success；其余 failed（尾行透出）。 */
export function interpretCodexLogin(code: number | null, stdout: string, stderr: string): { state: "success" | "failed"; error?: string } {
  if (code === 0) return { state: "success" };
  return { state: "failed", error: tailLine(stderr) || tailLine(stdout) || `codex login 异常退出（code=${code ?? "signal"}）` };
}

export const codexLoginDriver = {
  agentId: "codex",
  mode: "url" as const,
  loginTimeoutMs: 330_000,
  buildLogin: ({ runtime }: { runtime: string }) => ({
    cmd: runtime || "codex",
    args: ["login", "--device-auth"],
    env: cleanEnv(),
  }),
  extractUrl: extractCodexLoginUrl,
  interpret: interpretCodexLogin,
};

/** 受控登录 API（startup 里挂载；/login/* 命中返回 Response，其余 null 放行）。 */
let loginApi: ((req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) => Promise<Response | null>) | null = null;
/** 受控登录控制器引用（shutdown 时终止进行中的登录进程）。 */
let loginCtl: { dispose(): void } | null = null;

/** configDir 兑底（宿主 serverContext 恒带 configDir；按 demo 约定自拼，仅防御性）。 */
function extDataDir(): string {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return join(root, "aiti-codex-agent", "config");
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
  const creds = readCodexCreds();
  if (!creds) return fail("no-auth", "未找到 Codex 登录凭据（~/.codex/auth.json）");
  try {
    const v = await fetchCodexQuota({ token: (creds as { token: string }).token, ...((creds as { accountId?: string }).accountId ? { accountId: (creds as { accountId?: string }).accountId } : {}) });
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
  id: "aiti-codex-agent",
  name: "Codex CLI",
  version: "0.1.0",
  icon: "🌀",
  // 受控登录统一弹窗（零构建原生 h() client；client/ 下两文件随 deploy 拷贝）
  // 静态插入点声明（与 client registerItems 的 id 一一对应）
  // 登录 UI 已统一到 aiti-agent-manager（受控登录弹窗退役，2026-09-13）：不再声明
  // client/ui —— 服务端 /login/* 与 .agent 描述符保留（manager 代理消费）。

  features: [spawnEnvFeature("Codex"), spawnCommandFeature("Codex"), spawnArgsPrefixFeature("Codex")],

  server: {
    startup(ctx: {
      /** 扩展数据目录（宿主 serverContext 恒提供；类型上按需声明）。 */
      configDir?: string;
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
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
            listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          }): Promise<CodexHandle>;
        }): string;
      };
    }) {
      hostSvc = (ctx as any)?.services ?? null; // DI 方案 P1
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json；docs/aiti-remote-queue-and-sidecar-plan.md §3）
      queueStateDir = (ctx as { stateDir?: string }).stateDir ?? join((ctx as { configDir?: string }).configDir ?? extDataDir(), "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // 受控登录（工具条 🔑）：spawn `codex login --device-auth`（设备码模式，远程/headless 官方推荐）
      const login = createControlledLogin({
        driver: codexLoginDriver,
        configDir: (ctx as { configDir?: string }).configDir ?? extDataDir(),
        resolveRuntime: async () => {
          const bin = resolveCodexBin();
          // 裸名 = PATH 未命中（resolveCodexBin 兜底返回原名）——再核一次给 fail-loud 人话
          if (!bin.includes("/")) {
            if (!whichBin(bin)) {
              throw new Error(
                `未找到 codex CLI（PATH 上无 "${bin}"，也未设置 CODEX_CLI_PATH）——请先安装 Codex CLI；` +
                "或在有浏览器的机器上运行 `codex login --device-auth` 完成授权",
              );
            }
          }
          return bin;
        },
        log: (m) => console.log(`[aiti-codex-agent] ${m}`),
      });
      loginApi = mountControlledLoginApi(login);
      loginCtl = login;
      lastKey = ctx.sessionProviders.register({
        type: "codex",
        label: "OpenAI Codex CLI",
        agentKey: "codex",
        maxCapabilities: CODEX_CAPABILITIES,
        // 静态目录（新建页选后端时给选择器供数据；无会话即可取）
        // 静态目录（新建页选后端时给选择器供数据；无会话即可取）——上次使用的模型置顶
        listModels: async () => withLastUsedFirst(await codexCatalog(), (await readAgentLastUsedModel("codex"))?.id),
        createSession: async (options) => {
          const rawSid = options.sessionId ?? "";
          // All Sessions 历史行复活：composite id "codex:<threadId>" → sid 即真实 codex thread id
          const id = rawSid ? `codex:${rawSid}` : `codex:new-${++counter}-${Date.now()}`;
          const handle = new CodexHandle(id, options.cwd ?? process.cwd());
          // 种子模型：显式指定 > 状态文件恢复 > 会话回放真实模型（优先级递减，zcode 同序）
          if (typeof options.model?.id === "string" && options.model.id) {
            handle.model = { id: options.model.id, provider: "codex" };
          } else if (options.sessionId) {
            const restored = await readExtModelState("codex", `codex:${options.sessionId}`);
            if (restored?.selected?.id) handle.model = { id: restored.selected.id, provider: "codex" };
          }
          if (rawSid) {
            // 历史回放 + 会话真实模型恢复：经 All Sessions（session-manager）的服务出口读取——
            // codex rollout 存储的唯一权威实现在那（lib/agents/codex.ts），此处不重写读取。
            // codex 无 init 帧，rollout turn_context 的 model 是接管时唯一真实模型源。缺席 fail-silent。
            try {
              // 双轨（DI 方案 P1）：ctx.services 优先，byId 穿透兜底
              const reg = (globalThis as any).__piWebExt;
              const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
              if (typeof svc?.parseSession === "function") {
                const parsed = await svc.parseSession(`codex:${rawSid}`);
                if (parsed) {
                  if (parsed.messages?.length) handle.seedHistory(parsed.messages);
                  // 会话真实模型恢复（CC init 帧 restore 同语义：初始化不广播，选择器直接展示）：
                  // rollout turn_context 的 model；仅在无更优先来源时生效
                  if (!handle.model && typeof parsed.meta?.model === "string" && parsed.meta.model) {
                    handle.model = { id: parsed.meta.model, provider: "codex" };
                  }
                }
              }
            } catch { /* 回放失败不阻断接管 */ }
          }
          // 新会话（无显式模型/无同会话恢复/无回放）→ 该 agent 上次使用的模型（per-agent last used）
          // ⚠ 仅新会话：resume 会话模型以 rollout/CLI 自身为准，不用 agent 级默认覆盖
          if (!handle.model && !options.sessionId) {
            const lastUsed = await readAgentLastUsedModel("codex");
            if (lastUsed?.id) handle.model = { id: lastUsed.id, provider: "codex" };
          }
          // 启动即写状态文件（pi 目录快照 + selected），引导外部 agent
          handle.persistModelState();
          return handle;
        },
      });
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用——manager 不写死各家
      ctx.services?.provide?.("aiti-codex-agent.agent", {
        agent: "codex",
        label: "Codex CLI",
        modes: ["url"],
        accountQuota: true, // 支持账号额度查询（agent-manager 聚合 GET /login/quota）
        dependencyHint: "codex CLI",
        auth: [
          { kind: "file", path: [".codex", "auth.json"], label: "~/.codex/auth.json" },
          { kind: "env", path: ["OPENAI_API_KEY"], label: "env OPENAI_API_KEY" },
          // 2026-11-05：auth.json 之外的常见用法——config.toml 指向 openrouter 等
          // 第三方 provider（requires_openai_auth=false），key 走 env_key 指定的环境变量。
          // openrouter.ai 与 OpenAI 域不同，连通性独立，命中即 ready。
          { kind: "env", path: ["OPENROUTER_API_KEY"], label: "env OPENROUTER_API_KEY（openrouter provider）" },
        ],
        accountSlots: (c: { home: string }) => [
          { key: "codex-auth", label: "OAuth 凭据", path: join(c.home, ".codex", "auth.json") },
        ],
      });
      // P2 协议委托：launch 服务（成员的启动包装 → 本扩展完整协议会话）
      ctx.services?.provide?.("aiti-codex-agent.launch", {
        agentKey: "codex",
        capabilities: CODEX_CAPABILITIES,
        listModels: async () => withLastUsedFirst(await codexCatalog(), (await readAgentLastUsedModel("codex"))?.id),
        createSessionFromLaunch: async (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }) => {
          const rawSid = options.sessionId ?? "";
          const id = rawSid ? `codex:${rawSid}` : `codex:new-${++counter}-${Date.now()}`;
          const handle = new CodexHandle(id, options.cwd ?? process.cwd());
          handle.launchOverride = launch;
          if (typeof options.model?.id === "string" && options.model.id) {
            handle.model = { id: options.model.id, provider: "codex" };
          }
          handle.persistModelState();
          return handle;
        },
      });
      console.log(`[aiti-codex-agent] registered: ${lastKey} + launch service`);
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
