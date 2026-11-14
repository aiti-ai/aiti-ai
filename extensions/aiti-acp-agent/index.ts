/**
 * aiti-acp-agent — 会话后端扩展：ACP（Agent Client Protocol）通用驱动。
 *
 * ACP 是 Zed 主导的 agent↔编辑器 JSON-RPC stdio 标准。一个驱动覆盖所有
 * ACP 兼容 agent，无需逐个适配：
 *
 *   已知后端（启动时探测 PATH，装了才注册——装机才接原则，25 家，
 *   对齐 xenodium/agent-shell 全量清单 + 自有接入）：
 *     claude-code  claude-agent-acp          agentKey "claude"（0.16 旧包名 claude-code-acp 兜底）
 *     gemini       gemini --experimental-acp agentKey "gemini"
 *     opencode     opencode acp              agentKey "opencode"
 *     codex        codex-acp                 agentKey "codex"（官方 npm 桥 @agentclientprotocol/codex-acp）
 *     cursor       cursor-agent acp          agentKey "cursor"
 *     antigravity/grok/auggie/deepseek/droid/hermes/junie/kiro/mistral/
 *     omp/openclaw/pi/qoder — 命令详见下方 ACP_AGENTS 注释（agent-shell 同款）
 *
 * 协议面（v1，2026-08 经 claude-code-acp 0.16 实测；2026-11-05 复测
 * @agentclientprotocol/claude-agent-acp 0.100.0 全握手通过——initialize
 * image=true、session/new modes、agent_message_chunk/end_turn/usage 同形）：
 *   client→agent: initialize / session/new / session/prompt / session/cancel
 *   agent→client: session/update(update.sessionUpdate="agent_message_chunk")
 *                 session/request_permission（工具授权，client 必须应答）
 *   prompt 终结：id 响应 {stopReason:"end_turn"|"cancelled"...}
 *
 * 注意：session/new 可能耗时数十秒（agent 冷启 MCP），createSession 宽限 150s。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, accessSync, constants } from "node:fs";

/** 队列崩溃恢复 sidecar 根（startup 捕获 <stateDir>；undefined/空 = 不持久化）。 */
let queueStateDir: string | undefined;
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { governanceEnv } from "./external-governance.ts";
import { agentSpawnEnv, spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { readAgentLastUsedModel, withLastUsedFirst, writeExtModelState, type ExtModelEntry } from "@aiti-ai/ext-shared/ext-model-state";
// 队列共享实现层（权威源 pi-web-ext/_shared/backend-queue.ts，副本随扩展部署——改动须双向同步）
import { createBackendQueueSupport, createQueueFilePersistence, type BackendQueue } from "@aiti-ai/ext-shared/backend-queue";
// 工具结果空白占位（权威源 pi-web-ext/_shared/seed-tool.ts；D18 各家同口径——卡片不裸奔）
import { EMPTY_TOOL_ERROR, EMPTY_TOOL_OUTPUT } from "@aiti-ai/ext-shared/seed-tool";
import { probeCbcCatalog, runCliCapture } from "@aiti-ai/ext-shared/cbc-model-catalog";
import {
  ModelCatalogStore, createCatalogRefresher, parseOpenCodeModels,
  type CatalogEntry, type AgentProbeDesc, type CatalogRefresher,
} from "./model-catalog.ts";
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";
import {
  chooseTrustMode, extractToolAskInfo, normalizeAskTimeoutSec, normalizePolicy,
  permissionCancelledLine, permissionSelectedLine, pickPermissionOptions, summarizeToolInput,
  type AcpPermissionOptionLike,
} from "./permission-policy.ts";

/**
 * session/cancel 无应答兜底（ms）：ACP 契约是 cancel 后让在途 session/prompt 以
 * cancelled 返回；cbc 2.150 实测 cancel 已生效但 result 帧可能丢失 → running 永久
 * true。到期强制收口；进程保留（下一轮照常可用）。
 */
const ACP_CANCEL_SETTLE_FALLBACK_MS = 6_000;

// ============================================================================
// 结构化契约（out-of-tree）
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

/** 功能管理（extman）：startup 捕获 ctx.features；热重载后重新捕获。 */
let hostFeatures: { get?(extId: string, fid: string): unknown } | null = null;
function featureString(fid: string): string {
  const v = hostFeatures?.get?.("aiti-acp-agent", fid);
  return typeof v === "string" ? v : "";
}
/** 工具授权策略：allow（默认，信任 agent）| ask（转前端人工审批）。 */
function permissionPolicy(): "allow" | "ask" {
  return normalizePolicy(featureString("acp.permissionPolicy"));
}
/** ask 模式人工审批超时（ms；0=无限）。 */
function permissionAskTimeoutMs(): number {
  return normalizeAskTimeoutSec(featureString("acp.permissionTimeoutSec")) * 1000;
}

/** 已知 ACP 后端注册表：name → 启动配置。resolve 缺省 = which(bin)；非 PATH 直装后端可自带解析器。 */
export const ACP_AGENTS: Array<{
  name: string;
  bin: string;
  args: string[];
  agentKey?: string;
  resolve?: () => { bin: string; args: string[] } | null;
}> = [
  // Claude Code ACP：@agentclientprotocol/claude-agent-acp（0.100.0 全握手实证
  // 2026-11-05：initialize image=true / session/new modes / prompt chunk+end_turn）。
  // 包已由 @zed-industries/claude-code-acp 更名（bin claude-code-acp → claude-agent-acp），
  // 新 bin 优先、旧 bin 兜底（旧包未卸的机器照常可接）。
  { name: "claude-code", bin: "claude-agent-acp", args: [], agentKey: "claude", resolve: resolveClaudeCodeAcp },
  { name: "gemini", bin: "gemini", args: ["--experimental-acp"], agentKey: "gemini" },
  { name: "copilot", bin: "copilot", args: ["--acp"], agentKey: "copilot" },
  { name: "opencode", bin: "opencode", args: ["acp"], agentKey: "opencode" },
  // CodeBuddy Code（腾讯 cbc）：--acp 原生支持（ndJsonStream；2.150.0 实测 initialize/
  // session/new/prompt 全通，含模型目录/思维流/usage/available_commands 更新）。
  // PATH 直装（npm i -g / brew）优先，否则 npx 兜底（node + npx-cli.js）。
  { name: "codebuddy", bin: "cbc", args: ["--acp"], agentKey: "codebuddy", resolve: resolveCodebuddyAcp },
  // Qwen Code（阿里，gemini-cli 系，npm @qwen-code/qwen-code；2026-09-16 接入）：
  // `qwen --acp` 原生 ACP（0.23.4 握手实证 initialize/session/new 通；未登录时
  // session/new 报 Authentication required——需先 `qwen` 登录 Qwen OAuth 免费额度）。
  { name: "qwen", bin: "qwen", args: ["--acp"], agentKey: "qwen" },
  // iFlow CLI（阿里心流，npm @iflow-ai/iflow-cli；2026-09-16 接入）：
  // `iflow --experimental-acp` 完整握手实证（未登录 session/new 亦返回 sessionId；
  // auth 三通道 = IFLOW 登录 / iFlow API key / OpenAI Compatible）。
  { name: "iflow", bin: "iflow", args: ["--experimental-acp"], agentKey: "iflow" },
  // Kimi Code CLI（月之暗面，npm @moonshot-ai/kimi-code；2026-09-16 接入）：
  // `kimi acp` 子命令完整握手实证（未登录 session/new 亦返回 sessionId；
  // auth = Kimi 账号登录。注意 acp 是子命令非 flag）。
  { name: "kimi", bin: "kimi", args: ["acp"], agentKey: "kimi" },
  // Goose（Block 开源，curl 脚本装机 ~/.local/bin/goose；2026-09-16 接入）：
  // `goose acp` initialize ✓（session/new 需先 `goose configure` 配 provider，
  // 未配置报 Internal error）；凭据走 goose 自身 provider 配置（非 ACP auth 流）。
  { name: "goose", bin: "goose", args: ["acp"], agentKey: "goose" },
  // Cline CLI（npm cline 3.0.62，需官方源安装；2026-09-16 接入）：
  // `cline --acp` initialize ✓（session/new 需先 authenticate——cline login 账号登录）。
  { name: "cline", bin: "cline", args: ["--acp"], agentKey: "cline" },
  // Codex ACP 适配器（OpenAI，npm @agentclientprotocol/codex-acp；2026-11-08 接入）：
  // codex CLI 0.166 无原生 acp 子命令——经官方 codex-acp 桥（2.6.0 裸握手实证
  // initialize/session/new 全通：loadSession:true、image=true、session/new 返回
  // availableModels）。auth 走 codex 自身网关（openrouter 等，非 ACP auth 流）；
  // `_auth/status_update` 非标通知（无 id）被通知分支安全忽略。PATH 直装优先，npx 兜底。
  { name: "codex", bin: "codex-acp", args: [], agentKey: "codex", resolve: resolveCodexAcp },
  // Cursor CLI（cursor-agent；2026-11-08 接入）：`cursor-agent acp` 原生 ACP server
  // （2026.10.22 裸握手实证 initialize 通：loadSession:true、image=true；未登录时
  // session/new 报 Authentication required——需先 `cursor-agent login` 浏览器 OAuth，
  // 与 qwen 同款装机才接 + 用户自登录模式）。
  { name: "cursor", bin: "cursor-agent", args: ["acp"], agentKey: "cursor" },
  // ── 以下 13 家对齐 agent-shell（xenodium/agent-shell，Emacs ACP 客户端）2026-11-08 全量清单 ──
  // Antigravity（Google）：`agy acp`（登录 `agy acp --login`）。antigravity.google
  { name: "antigravity", bin: "agy", args: ["acp"], agentKey: "antigravity" },
  // Grok Build（xAI）：`grok agent stdio`；CLI 登录一次存 ~/.grok/auth.json。docs.x.ai
  { name: "grok", bin: "grok", args: ["agent", "stdio"], agentKey: "grok" },
  // Auggie（Augment Code）：`auggie --acp`（npm @augmentcode/auggie）。docs.augmentcode.com
  { name: "auggie", bin: "auggie", args: ["--acp"], agentKey: "auggie" },
  // DeepSeek Harness：`dsh --profile acp`（npm @deepseek-ai/dsh；DEEPSEEK_API_KEY）。
  { name: "deepseek", bin: "dsh", args: ["--profile", "acp"], agentKey: "deepseek" },
  // Factory Droid：`droid exec --output-format acp`（app.factory.ai 装机脚本）。
  { name: "droid", bin: "droid", args: ["exec", "--output-format", "acp"], agentKey: "droid" },
  // Hermes（Nous Research）：`hermes acp`（npm hermes-agent）。
  { name: "hermes", bin: "hermes", args: ["acp"], agentKey: "hermes" },
  // Junie（JetBrains）：`junie --acp true`（junie.jetbrains.com；注意 true 是参数非 flag）。
  { name: "junie", bin: "junie", args: ["--acp", "true"], agentKey: "junie" },
  // Kiro（AWS）：`kiro-cli acp`（cli.kiro.dev 装机脚本）。kiro.dev/docs/cli/acp
  { name: "kiro", bin: "kiro-cli", args: ["acp"], agentKey: "kiro" },
  // Mistral Vibe：`vibe-acp`（mistralai/vibe-acp，Python/uv 装机；bin 无参数）。
  { name: "mistral", bin: "vibe-acp", args: [], agentKey: "mistral" },
  // Oh My Pi（omp，pi 最大 fork）：`omp acp` 子命令（本机 18.16；native aiti-omp-agent 并存同 claude 先例）。
  { name: "omp", bin: "omp", args: ["acp"], agentKey: "omp" },
  // OpenClaw：`openclaw acp`（npm openclaw；gateway 未起时握手/会话行为见 README）。
  { name: "openclaw", bin: "openclaw", args: ["acp"], agentKey: "openclaw" },
  // Pi（pi-mono coding-agent）：`pi-acp` 适配器（npm pi-acp——pi CLI 本体无 acp 子命令，
  // 适配器包一层；native aiti-pi-agent 并存）。
  { name: "pi", bin: "pi-acp", args: [], agentKey: "pi" },
  // Qoder CLI（国际版）：`qoder --acp`（native aiti-qoder-agent 双区域并存；CN 版可经
  // 自定义后端面板自行加 qoder-cn 条目）。
  { name: "qoder", bin: "qoder", args: ["--acp"], agentKey: "qoder", installHint: "Qoder standalone CLI (qodercli)" },
];

/** npm 的 npx-cli.js：nvm/unix 布局 <node目录>/../lib/node_modules/npm/bin/npx-cli.js；
 *  Windows 布局 <node目录>/node_modules/npm/bin/npx-cli.js。CODEBUDDY_NPX_PATH 可覆盖。 */
function npxCliJsPath(): string {
  if (process.env.CODEBUDDY_NPX_PATH) return process.env.CODEBUDDY_NPX_PATH;
  const binDir = dirname(process.execPath);
  return process.platform === "win32"
    ? join(binDir, "node_modules", "npm", "bin", "npx-cli.js")
    : join(binDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
}

/** cbc ACP 解析：PATH 上的 cbc/codebuddy → npx 兜底（零安装；首用有下载延迟）。 */
function resolveCodebuddyAcp(): { bin: string; args: string[] } | null {
  const direct = which("cbc") ?? which("codebuddy");
  if (direct) return { bin: direct, args: ["--acp"] };
  const npxCli = npxCliJsPath();
  if (existsSync(npxCli)) {
    return { bin: process.execPath, args: [npxCli, "-y", "@tencent-ai/codebuddy-code", "--acp"] };
  }
  return null;
}

/** Claude Code ACP 解析：新包名 claude-agent-acp 优先，旧包名 claude-code-acp 兜底。 */
function resolveClaudeCodeAcp(): { bin: string; args: string[] } | null {
  const next = which("claude-agent-acp");
  if (next) return { bin: next, args: [] };
  const legacy = which("claude-code-acp");
  return legacy ? { bin: legacy, args: [] } : null;
}

/** Codex ACP 解析：PATH 上的 codex-acp → npx 兜底（零安装；首用有下载延迟）。 */
export function resolveCodexAcp(): { bin: string; args: string[] } | null {
  const direct = which("codex-acp");
  if (direct) return { bin: direct, args: [] };
  const npxCli = npxCliJsPath();
  if (existsSync(npxCli)) {
    return { bin: process.execPath, args: [npxCli, "-y", "@agentclientprotocol/codex-acp"] };
  }
  return null;
}

interface UserAcpAgent {
  name: string;
  bin: string;
  args: string[];
  agentKey?: string;
}

/** 用户自定义 ACP 后端持久化文件 */
function userAgentsFile(configDir: string): string {
  return join(configDir, "acp-agents.json");
}

function loadUserAgents(configDir: string): UserAcpAgent[] {
  try {
    return JSON.parse(readFileSync(userAgentsFile(configDir), "utf8")) as UserAcpAgent[];
  } catch { return []; }
}

function saveUserAgents(configDir: string, agents: UserAcpAgent[]): void {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(userAgentsFile(configDir), JSON.stringify(agents, null, 2));
}

/** PATH 探测 + 常见用户级 bin 目录兑底（systemd 服务 PATH 通常缺 ~/.npm-global/bin 等）。 */
const EXTRA_BIN_DIRS = [
  process.env.HOME ? join(process.env.HOME, ".npm-global", "bin") : "",
  process.env.HOME ? join(process.env.HOME, ".local", "bin") : "",
  "/usr/local/bin",
].filter(Boolean);

function which(bin: string): string | null {
  {
    const p = whichBin(bin);
    if (p) return p;
  }
  // 存在性检查（毫秒级）：发现语义与旧实现完全一致——旧实现对每个候选实跑 `--version`，
  // 但失败时本就走 test -x 存在性兑底照样返回（见下注释），即 --version 从不是过滤门槛，
  // 只是被低效地当存在性探测用（gemini 1.4s / copilot 0.6s / opencode 0.55s，4 个后端
  // 合计 ~3s，每次扩展 reload 都阻塞全局 startAll）。accessSync(X_OK) = 文件存在 + 可执
  // 行位（与 test -x 等价；跟随符号链接，断链抛异常 = 缺失）。「真能不能跑」的验证仍在
  // createSession 的 spawn + ACP initialize 握手，不在发现阶段。
  for (const dir of EXTRA_BIN_DIRS) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* 不在该目录 / 无执行权限 / 断链 → 视为缺失 */ }
  }
  return null;
}

const ACP_CAPABILITIES: SessionCapabilitiesLike = {
  steer: false,
  followUp: true, // D3：本地 followUp 队列（backend-queue 共享层，settle 后自动续轮，可撤回）
  getMessages: true,
  contextUsage: true, // usage_update 帧（used/size → getContextUsage）；帧未到时空态 undefined
  // ACP 协议含 session/set_model（qodercli 内嵌 ACP SDK method 表可证）；各宿主
  // CLI 支持度不一 —— 调用时 method-not-found 捕获回 false（fail-loud）。
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
  getCommands: true, // available_commands_update 帧；帧未到时空数组（合法空态）
  respondPermission: true,
  getUsage: true, // usage_update 帧；帧未到时空态 undefined
  queueManage: true, // D3：backend-queue 共享层全 CRUD（followUp 组；无 steer 组——协议无注入面）
  listModels: true,
  // 发图：ACP 协议标准能力，实现已在（prompt image blocks）；handle 级按宿主宣告
  // 收敛（initialize promptCapabilities.image !== true → 实例 capabilities 置 false）。
  // 2026-09-06 claude-code-acp 0.16.1 真机验证：图达模型（模型自证 attachment）、end_turn。
  fileAttachments: true,
  // 权限模式：ACP 原生 session/set_mode + current_mode_update 通知回显；
  // 白名单按宿主宣告动态收敛（claude-code-acp 五档与 UI 同名，真机验证通过）
  setPermissionMode: true,
};

// ============================================================================
// AcpHandle
// ============================================================================

/** 导出仅供单测直接驱动（宿主 loader 只消费 default 导出）。 */
export class AcpHandle {
  readonly source: string;
  /** 实例级拷贝（initialize 后按宿主宣告收敛：promptCapabilities.image 不支持 → fileAttachments=false） */
  readonly capabilities: SessionCapabilitiesLike = { ...ACP_CAPABILITIES };
  id = "";

  readonly agentName: string;
  readonly agentKey: string;
  readonly cwd: string;
  /** 本进程内累积的对话（prompt 记 user；settled 时把流式缓冲落为 assistant） */
  private liveHistory: unknown[] = [];
  private partialText = "";
  private readonly bin: string;
  private readonly binArgs: string[];
  private child: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private listeners = new Set<Listener>();
  private pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private aliveFlag = false;
  private running = false;
  /** 轮次代数（每轮 prompt 自增；abort 兜底/迟到 result 防重收口用）。 */
  private turnSeq = 0;
  /** 已收口的轮次代数（>= 当前轮 = 已 settle，迟到帧不再重复发终态）。 */
  private settledTurn = 0;
  /** 在途 session/prompt RPC 标记（状态判定用；真正的等待在 prompt() 内）。 */
  private turnInflight = false;
  /** 本轮已请求取消（result 到达时以 aborted 收口）。 */
  private abortRequested = false;
  /** cancel 无应答兜底定时器（见 ACP_CANCEL_SETTLE_FALLBACK_MS）。 */
  private abortFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次收口原因（迟到失败静默/上抛的依据：aborted|cancelled 为静默）。 */
  private lastStopReason: string | null = null;
  /** session/load 历史回放窗口（期间 update 不发 live 增量，静默采集进 liveHistory）。 */
  private loading = false;
  private replayAssistant = "";
  private model: { id: string; provider: string } | undefined;
  /** 宿主宣告的权限模式（session/new modes；2026-09-06 claude-code-acp 0.16.1 实测五档与 UI 同名） */
  private availableModes: Array<{ id: string; name?: string }> = [];
  private currentModeId: string | undefined;
  private rpcSeq = 0;
  /** D16：最近一次 usage_update（used/size = 上下文占用/窗口）。 */
  private lastUsage: { contextTokens: number; contextWindow: number } | undefined;
  /** D16：available_commands_update 收到的 slash 命令目录。 */
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  /**
   * D3：队列支持（共享层 docs/backend-queue-manager-plan.md §3）。ACP 协议无运行中
   * 注入面（session/prompt 之外无 steer 通道）→ 不提供 steer 闭包，运行中输入一律入
   * 本地 followUp 队列（可撤回，settle 后自动续轮）；dispatch 闭包回 prompt() 全簿记
   * （liveHistory/running/finishTurn/scheduleDrain）。
   */
  private q = createBackendQueueSupport({
    isRunning: () => this.running || !this.aliveFlag,
    alive: () => this.aliveFlag,
    dispatch: (text, images) => this.prompt(text, { images }),
    onEvent: (ev) => this.emit(ev),
    log: (m) => console.warn(`[acp:${this.agentName}] ${m}`),
    // 队列崩溃恢复 sidecar（docs/aiti-remote-queue-and-sidecar-plan.md §3）
    persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
  });
  /** 目录探测句柄（session 元数据不回填缓存，由探测方以 acp 源落盘）。 */
  private readonly probe = false;

  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;

  constructor(agentName: string, bin: string, binArgs: string[], agentKey: string, cwd = "", probe = false) {
    this.agentName = agentName;
    this.bin = bin;
    this.binArgs = binArgs;
    this.agentKey = agentKey;
    this.cwd = cwd;
    this.probe = probe;
    this.source = `aiti-acp-agent/${agentName}`;
  }

  // ---- 进程与初始化 ----------------------------------------------------------

  async start(cwd: string): Promise<void> {
    const resolvedBin = which(this.bin) ?? this.bin;
    // P1' 启动包装（docs/aiti-custom-agent-plan.md）：extman spawn.command/spawn.argsPrefix，缺省 = 行为不变
    // P2：launchOverride（custom-agent 委托路径）优先于 extman feature
    const ov = this.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: resolvedBin,
      command: ov?.command?.trim() || spawnCommand("aiti-acp-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-acp-agent")).args,
      driverArgs: this.binArgs,
      env: agentSpawnEnv({ cli: governanceCliFor(this.agentName), governance: governanceEnv, extId: "aiti-acp-agent", envList: spawnEnvList("aiti-acp-agent") }),
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd,
      warn: (m) => console.log(`[aiti-acp-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    this.child = child;
    this.aliveFlag = true;
    this.detachReader = lineReader(child.stdout, (l) => this.onLine(l), {
      onOverflow: (size) => this.markDead(`stdout line overflow (${size} bytes)`),
    });
    // 三个流必须挂 error 监听（加固 A2）：ECONNRESET/EPIPE 无监听器会崩宿主进程。
    child.stdout?.on("error", (err) => this.markDead(`stdout error: ${err.message}`));
    child.stderr?.on("error", (err) => console.log(`[acp:${this.agentName}] stderr error: ${err.message}`));
    child.stdin?.on("error", (err) => console.log(`[acp:${this.agentName}] stdin error: ${err.message}`));
    child.stderr?.on("data", (c: Buffer | string) => {
      const t = String(c).trim();
      if (t) console.log(`[acp:${this.agentName}] ${t.slice(0, 200)}`);
    });
    child.once("exit", (code) => {
      // ⚠ 不先置 running=false：留给 markDead 收口在途轮次（agent_settled），
      // 否则进程死亡时 UI 卡「运行中/停止中」（与 prompt 超时同一类缺陷）。
      this.markDead(`process exited (${code ?? "signal"})`);
    });
    child.once("error", (err) => this.markDead(`spawn error: ${err.message}`));

    // initialize（宽限 30s）：按宿主宣告收敛发图能力（ACP 协议级 image 是标准能力，
    // 但逐宿主以 promptCapabilities.image 为准；claude-code-acp 0.16.1 实测 = true）
    const initResult = await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, 30_000) as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } };
    if (initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      (this.capabilities as { fileAttachments: boolean }).fileAttachments = false;
    }
  }

  /** session/new|load 共用的会话元数据应用（models/modes/currentModel）。 */
  private applySessionMeta(result: {
    models?: { availableModels?: Array<{ modelId: string; name?: string }>; currentModelId?: string };
    modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> };
  }): void {
    const avail = result.models?.availableModels ?? [];
    this.models = avail.map((m) => ({
      id: m.modelId,
      provider: this.agentName,
      ...(m.name ? { label: m.name } : {}),
    }));
    // 权限模式（ACP 原生）：availableModes + currentModeId 存档供 setPermissionMode/白名单用
    this.availableModes = result.modes?.availableModes ?? [];
    this.currentModeId = result.modes?.currentModeId;
    // agent 侧当前模型（currentModelId 时种子，供选择器回显）
    const currentModelId = result.models?.currentModelId;
    if (typeof currentModelId === "string" && currentModelId) {
      this.model = { id: currentModelId, provider: this.agentName };
    }
    // 运行期回填目录缓存（D15：session 源优先级最高；探测句柄除外——探测方自落 acp 源）
    if (!this.probe) {
      noteSessionCatalog(this.agentName, this.models, this.model?.id);
    }
  }

  async newSession(cwd: string): Promise<void> {
    // agent 冷启（MCP 加载）可能数十秒——150s 宽限
    const result = (await this.rpc("session/new", { cwd, mcpServers: [] }, 150_000)) as {
      sessionId?: string;
      models?: { availableModels?: Array<{ modelId: string; name?: string }>; currentModelId?: string };
      modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> };
    };
    if (!result?.sessionId) throw new Error("[acp] session/new returned no sessionId");
    this.id = `${this.agentKey}:${result.sessionId}`;
    this.applySessionMeta(result);
    await this.applyTrustMode();
    this.emit({ type: "agent_start", sessionId: this.id, backend: this.agentName });
  }

  /**
   * session/load：接管既有 ACP 会话（cbc --acp initialize 宣告 loadSession:true；
   * 2.150.0 真机实测）。agent 随后以 session/update 回放全量历史（user_message_chunk /
   * agent_message_chunk / agent_thought_chunk）——回放期间不发 live 增量，静默采集进
   * liveHistory（getMessages 历史面），避免把旧历史当流式打字机上屏。
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.loading = true;
    this.replayAssistant = "";
    try {
      const result = (await this.rpc("session/load", { sessionId, cwd, mcpServers: [] }, 150_000)) as {
        models?: { availableModels?: Array<{ modelId: string; name?: string }>; currentModelId?: string };
        modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> };
      } | null;
      this.id = `${this.agentKey}:${sessionId}`;
      if (result) this.applySessionMeta(result);
      this.flushReplayAssistant();
      await this.applyTrustMode();
      this.emit({ type: "agent_start", sessionId: this.id, backend: this.agentName });
    } finally {
      this.loading = false;
    }
  }

  /** 回放 assistant 文本冲刷（下一条 user 回放或加载收口时落 liveHistory）。 */
  private flushReplayAssistant(): void {
    if (this.replayAssistant.trim()) {
      // 带 model 戳（与实时帧一致）：缺 model 的 assistant 消息曾把前端整页打崩
      // （MessageView 元信息行读 model.toLowerCase；2026-09-12 事故）。
      this.liveHistory.push({
        role: "assistant",
        content: [{ type: "text", text: this.replayAssistant }],
        ...(this.model?.id ? { model: this.model.id } : {}),
        provider: this.source,
      });
    }
    this.replayAssistant = "";
  }

  private markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.detachReader?.();
    this.detachReader = null;
    this.child = null;
    // 进程退出/被杀/dispose 时在途轮次必须收口（含 running 失步状态）：
    // finishTurn 幂等；即便已收口过也强制复位 running。
    if (this.running) {
      this.finishTurn(this.turnSeq, this.abortRequested ? "aborted" : "error", new Error(`[acp] dead: ${reason}`));
      this.running = false;
    }
    for (const entry of this.permissionRequests.values()) if (entry.timer) clearTimeout(entry.timer);
    this.permissionRequests.clear();
    this.clearAbortFallback();
    for (const p of this.pending.values()) p.reject(new Error(`[acp] dead: ${reason}`));
    this.pending.clear();
    this.q.dispose(); // D3：清 pending 队列 + 停未决续轮（进程死了队列没有未来）
    this.emit({ type: "session_backend_dead", reason });
  }

  private emit(event: Record<string, unknown>): void {
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧、不得沿流回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-acp-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // ACP 反向请求（session/request_permission 等）：必须应答
    if (typeof msg.method === "string" && typeof msg.id !== "undefined") {
      if (msg.method === "session/request_permission") {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const options = (params.options ?? []) as AcpPermissionOptionLike[];
        const picked = pickPermissionOptions(options);
        const key = String(msg.id);
        const { toolName, input } = extractToolAskInfo(params.toolCall);
        const entry = { allowOpt: picked.allowOpt, denyOpt: picked.denyOpt, rawId: msg.id, toolName, input, rawOptions: options };
        this.permissionRequests.set(key, entry);
        if (permissionPolicy() === "allow" && picked.allowOpt) {
          // 信任策略：自动放行（allow_always 优先），不向前端发卡（零打扰）；仅在被问时留痕
          entry.autoResolved = true;
          this.writePermissionSelected(msg.id, picked.allowOpt);
          this.permissionRequests.delete(key);
          this.recordPermissionCustom(toolName, input, "allow", true, key);
        } else {
          // ask（或 allow 但无允许选项 → fail-safe 转人工）：前端卡等待人工；超时兜底
          this.emit({ type: "permission_request", requestId: key, toolName, input, options });
          this.recordPermissionCustom(toolName, input, "pending", false, key);
          this.armPermissionTimeout(key, entry);
        }
        return;
      }
      // 其他反向通知忽略
      return;
    }

    if (typeof msg.id === "undefined") {
      // 通知
      if (msg.method === "session/update") {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const update = (params.update ?? {}) as Record<string, unknown>;
        const kind = String(update.sessionUpdate ?? "");
        // 字段名兼容：ACP 新 spec 用 contentBlock，claude-code-acp 0.16 用 content
        const block = ((update.contentBlock ?? update.content) ?? {}) as Record<string, unknown>;
        if (kind === "agent_message_chunk") {
          if (typeof block.text === "string") {
            if (this.loading) {
              // session/load 历史回放：静默采集（不发 live 增量）
              this.replayAssistant += block.text;
            } else {
              // 只跟随在途轮次；晚到帧不得复活已收口轮次（否则 running 永久 true）
              if (this.turnInflight) this.running = true;
              this.partialText += block.text;
              this.emit({ type: "message_update", delta: block.text });
            }
          }
        } else if (kind === "user_message_chunk") {
          // cbc session/load 回放包含用户轮（2.150.0 实测）——采集进历史
          if (this.loading) {
            this.flushReplayAssistant();
            if (typeof block.text === "string" && block.text) this.liveHistory.push({ role: "user", content: block.text });
          }
        } else if (kind === "agent_thought_chunk") {
          if (!this.loading && typeof block.text === "string") this.emit({ type: "message_update", delta: block.text });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          // 方案 X：工具调用 → pi 原生条目（调用一条 + 结果一条；回放期只入 liveHistory）
          this.onToolCallUpdate(update);
        } else if (kind === "usage_update") {
          // D16：上下文用量帧（cbc 2.150 实测 {used,size}，工具轮后多次）——存档供
          // getUsage/getContextUsage；帧到达即协议面真实存在（实例级能力已声明）。
          const used = Number(update.used ?? params.used);
          const size = Number(update.size ?? params.size);
          if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
            this.lastUsage = { contextTokens: used, contextWindow: size };
          }
        } else if (kind === "available_commands_update") {
          // D16：slash 命令目录帧 → getCommands 出口（前端命令菜单）
          const cmds = (update.availableCommands ?? params.availableCommands) as
            | Array<Record<string, unknown>>
            | undefined;
          if (Array.isArray(cmds)) {
            this.commands = cmds.flatMap((c) => {
              const name = typeof c?.name === "string" ? c.name : "";
              if (!name) return [];
              return [{
                name,
                ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
                source: "agent",
              }];
            });
          }
        }
      } else if (msg.method === "session/current_mode_update") {
        // 宿主侧模式变更回显（如 set_mode 生效）：对齐 CC permission_mode_changed 事件
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const modeId = String(params.currentModeId ?? "");
        if (modeId && modeId !== this.currentModeId) {
          this.currentModeId = modeId;
          this.emit({ type: "permission_mode_changed", mode: modeId });
        }
      }
      return;
    }

    // RPC 响应
    const pending = this.pending.get(msg.id as string | number);
    if (!pending) return;
    this.pending.delete(msg.id as string | number);
    if (msg.error) pending.reject(new Error(String((msg.error as Record<string, unknown>).message ?? "rpc error")));
    else pending.resolve(msg.result);
  }

  /**
   * 待决权限请求表：request_id(String) → 原始 id/选项/计时器（respondPermission 消费）。
   * rawId 必须原样回写：cbc 首个请求 id=数字 0，经 String/Number 转换会变字符串 "0" 致挂死。
   */
  private permissionRequests = new Map<string, {
    allowOpt?: AcpPermissionOptionLike;
    denyOpt?: AcpPermissionOptionLike;
    rawId?: string | number;
    autoResolved?: boolean;
    timer?: ReturnType<typeof setTimeout>;
    toolName?: string;
    input?: unknown;
    /** 宿主完整选项表（D17：前端按 optionId 精确应答，如「总是允许」）。 */
    rawOptions?: AcpPermissionOptionLike[];
  }>();
  /** 工具调用状态跟踪：已开始/已结束集合 + 最近一次有效工具名/入参（多帧更新时补齐首帧缺的信息）。 */
  private toolCallSeen = new Set<string>();
  private toolCallDone = new Set<string>();
  private toolCallMeta = new Map<string, { toolName?: string; input?: unknown; block?: Record<string, unknown> }>();

  /** 信任策略（allow）：会话建立后切到 no-ask 模式（有则切，失败静默降级到自动应答）。 */
  private async applyTrustMode(): Promise<void> {
    if (permissionPolicy() !== "allow" || !this.sessionId) return;
    const mode = chooseTrustMode(this.availableModes);
    if (!mode || mode === this.currentModeId) return;
    try {
      await this.rpc("session/set_mode", { sessionId: this.sessionId, modeId: mode }, 30_000);
      this.currentModeId = mode;
      console.log(`[acp:${this.agentName}] trust mode applied: ${mode}`);
    } catch (e) {
      console.warn(`[acp:${this.agentName}] set_mode(${mode}) failed（降级到自动应答）:`, e instanceof Error ? e.message : e);
    }
  }

  /** 会话消息流记录（custom 消息）：liveHistory 恒记录；非回放期再发 message_end 直播。 */
  private pushOrEmitCustom(opts: { customType: string; content: string; details?: unknown; display?: boolean }): void {
    const message = {
      role: "custom",
      customType: opts.customType,
      content: opts.content,
      display: opts.display !== false,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    if (!this.loading) this.emit({ type: "message_end", message });
  }

  /** 原生条目（toolCall/toolResult）同门控：回放期只入历史，活轮才直播。 */
  private pushOrEmitNative(message: Record<string, unknown>): void {
    this.liveHistory.push(message);
    if (!this.loading) this.emit({ type: "message_end", message });
  }

  /** 权限请求/决策写进会话消息流（可回放）。 */
  private recordPermissionCustom(
    toolName: string,
    input: unknown,
    decision: "pending" | "allow" | "deny" | "cancelled",
    auto: boolean,
    requestId: string,
  ): void {
    const label = decision === "pending" ? "等待授权"
      : decision === "allow" ? (auto ? "已自动允许（信任策略）" : "已人工允许")
      : decision === "deny" ? "⛔ 已拒绝"
      : "已取消（回合中止）";
    const inputStr = summarizeToolInput(input);
    this.pushOrEmitCustom({
      customType: "工具授权",
      content: `${toolName}${inputStr ? ` — ${inputStr}` : ""}\n\n${label}`,
      details: { requestId, toolName, input, decision, auto },
    });
  }

  /** ask 超时兜底：超时自动允许（信任优先）并记录；0=无限等待。 */
  private armPermissionTimeout(key: string, entry: { timer?: ReturnType<typeof setTimeout> }): void {
    const ms = permissionAskTimeoutMs();
    if (!(ms > 0)) return;
    entry.timer = setTimeout(() => {
      const cur = this.permissionRequests.get(key);
      if (!cur || cur.autoResolved) return;
      cur.autoResolved = true;
      if (cur.allowOpt) this.writePermissionSelected(cur.rawId ?? key, cur.allowOpt);
      else this.writePermissionCancelled(cur.rawId ?? key);
      this.permissionRequests.delete(key);
      this.emit({ type: "permission_expired", requestId: key });
      this.recordPermissionCustom(cur.toolName ?? "tool", cur.input, cur.allowOpt ? "allow" : "cancelled", true, key);
    }, ms);
    (entry.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * 方案 X：工具调用进会话消息流走 pi 原生条目——首帧一条 assistant.toolCall，
   * completed/failed 一条 toolResult（同 toolCallId，宿主 ToolCallBlock 折叠成一张卡）。
   * 不再发 🛠/✅❌ custom 卡：与其余后端（zcode/qoder/codebuddy/claude-code）同一形态，
   * 也让「接管后继续对话」与「冷恢复回放」不再是两种卡片。
   */
  private onToolCallUpdate(update: Record<string, unknown>): void {
    const id = String(update.toolCallId ?? "");
    if (!id) return;
    const status = String(update.status ?? "");
    const { toolName, input } = extractToolAskInfo(update);
    const meta = this.toolCallMeta.get(id) ?? {};
    if (toolName && toolName !== "tool") meta.toolName = toolName;
    if (input !== undefined && input !== null && !(typeof input === "object" && Object.keys(input as object).length === 0)) meta.input = input;
    this.toolCallMeta.set(id, meta);
    const name = meta.toolName ?? "tool";
    const args = meta.input && typeof meta.input === "object" && !Array.isArray(meta.input)
      ? { ...(meta.input as Record<string, unknown>) }
      : (meta.input === undefined ? {} : { input: meta.input });
    if (!this.toolCallSeen.has(id)) {
      this.toolCallSeen.add(id);
      const block = { type: "toolCall", toolCallId: id, toolName: name, input: args };
      meta.block = block;
      this.pushOrEmitNative({
        role: "assistant",
        content: [block],
        ...(this.model?.id ? { model: this.model.id } : {}),
        provider: this.source,
        timestamp: Date.now(),
      });
    } else if (meta.block && Object.keys(args).length && !Object.keys((meta.block.input ?? {}) as object).length) {
      // ACP 允许首帧只有 title、rawInput 后到：就地补齐已入账的调用块（直播帧已发出，
      // 不重发——同 id 再发一条 toolCall 宿主会渲成第二张卡）。
      meta.block.input = args;
    }
    if ((status === "completed" || status === "failed") && !this.toolCallDone.has(id)) {
      this.toolCallDone.add(id);
      const outRaw = update.rawOutput ?? update.output;
      const outText = typeof outRaw === "string"
        ? outRaw
        : (outRaw && typeof outRaw === "object"
          ? (typeof (outRaw as { text?: unknown }).text === "string" ? String((outRaw as { text: string }).text) : JSON.stringify(outRaw))
          : "");
      const isError = status === "failed";
      this.pushOrEmitNative({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: outText.trim().slice(0, 4000) || (isError ? EMPTY_TOOL_ERROR : EMPTY_TOOL_OUTPUT) }],
        ...(isError ? { isError: true } : {}),
        timestamp: Date.now(),
      });
      this.toolCallMeta.delete(id);
    }
  }

  private rpc<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.aliveFlag || !this.child?.stdin?.writable) {
      return Promise.reject(new Error("[acp] not running"));
    }
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[acp] ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n");
    });
  }

  // ---- SessionHandle 核心 ----------------------------------------------------

  async prompt(text: string, options?: {
    images?: Array<{ data: string; mimeType: string }>;
    /** 运行中排队语义（core 透传）：followUp=本地队列续轮；steer/缺省=同入本地队列（ACP 无注入面）。 */
    streamingBehavior?: "steer" | "followUp";
  }): Promise<void> {
    if (!this.aliveFlag) throw new Error("[acp] not running");
    if (this.running) {
      // D3：分流归共享层——运行中输入入本地 followUp 队列（可撤回，settle 后自动续轮）。
      // running 中 routePrompt 不会 dispatch（dispatch 回本方法，空闲时走下方执行路径）。
      await this.q.routePrompt(text, {
        images: options?.images,
        streamingBehavior: options?.streamingBehavior,
      });
      return;
    }
    const turn = ++this.turnSeq;
    this.turnInflight = true;
    this.abortRequested = false;
    this.lastStopReason = null;
    this.clearAbortFallback();
    this.running = true;
    this.partialText = "";
    this.liveHistory.push({ role: "user", content: text });
    const blocks: Array<Record<string, unknown>> = [];
    for (const img of options?.images ?? []) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    blocks.push({ type: "text", text });
    // session/prompt 的 result 到达即本轮终结（end_turn/refusal...）
    try {
      const result = (await this.rpc(
        "session/prompt",
        { sessionId: this.sessionId!, prompt: blocks },
        600_000,
      )) as { stopReason?: string } | null;
      this.finishTurn(turn, result?.stopReason ?? "end_turn");
    } catch (e) {
      // rpc 超时 / 进程死亡：必须收口。旧实现只 throw 不复位 running → 该句柄永久
      // 「运行中」、「停止」也无效（2026-09-12 codebuddy:01a0959c 线上事故）。
      const aborted = this.abortRequested;
      const settledNow = this.finishTurn(turn, aborted ? "aborted" : "error", e);
      if (!settledNow) {
        // 已收口（abort 兜底/agent 已应答 cancelled/进程死亡）的迟到失败：
        // 用户主动停止类（aborted|cancelled）静默吞，免得停止 10 分钟后又被弹超时错误；
        // 其余（如进程死亡）保留 prompt_error 通道，错误照常上抛给 pi-web。
        const quiet = this.lastStopReason === "aborted" || this.lastStopReason === "cancelled";
        if (quiet) {
          console.warn(`[acp:${this.agentName}] 轮次已收口（${this.lastStopReason}），忽略晚到失败：`, e instanceof Error ? e.message : e);
          return;
        }
      }
      throw e;
    } finally {
      if (turn === this.turnSeq) this.turnInflight = false;
      // D3：settle 后自动续轮（共享层幂等——running 中 no-op；微任务让 agent_settled
      // 先到达前端再开新一轮，zcode 实测模式）。进程死亡时 alive 已 false，no-op。
      this.q.scheduleDrain();
    }
  }

  get sessionId(): string | undefined {
    return this.id.includes(":") ? this.id.slice(this.id.indexOf(":") + 1) : undefined;
  }

  /**
   * 运行时切换权限模式：ACP 原生 session/set_mode。
   * 2026-09-06 对 claude-code-acp 0.16.1 实测：session/new 宣告五档（与 pi-web UI
   * PERMISSION_MODES 同名：default/acceptEdits/plan/dontAsk/bypassPermissions），
   * set_mode 空对象响应 = 成功；白名单按宿主宣告动态收敛，未宣告 modes 的宿主 fail-loud。
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.aliveFlag || !this.sessionId) throw new Error("[acp] not running");
    if (!this.availableModes.length) {
      throw new Error(`[acp:${this.agentName}] 宿主未宣告权限模式（session/new 无 modes），无法切换`);
    }
    if (!this.availableModes.some((m) => m.id === mode)) {
      throw new Error(`[acp:${this.agentName}] 非法权限模式 "${mode}"（宿主可选：${this.availableModes.map((m) => m.id).join("/")}）`);
    }
    await this.rpc("session/set_mode", { sessionId: this.sessionId, modeId: mode }, 30_000);
    this.currentModeId = mode;
    this.emit({ type: "permission_mode_changed", mode });
    return true;
  }

  async abort(): Promise<void> {
    if (!this.aliveFlag || !this.sessionId) return;
    // ACP 规范 MUST：cancel 时对所有待决授权请求回 cancelled
    this.cancelPendingPermissions("turn cancelled");
    if (!this.running) {
      // 失步兜底（aiti-codebuddy-agent stream 同款）：无在途轮次（result 丢失/已超时
      // 收口）仍按停止处理——幂等补发终态让前端「停止中」复位（真空闲多一帧无害）。
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    this.abortRequested = true;
    // cancel 是通知（无响应）；prompt 的 id 请求会以 cancelled stopReason 返回
    this.child?.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } }) + "\n",
    );
    // 兜底：agent 可能吞掉 result 帧（cbc 2.150 实测 cancel 生效但不回 result）——
    // 到期仍无收口则强制复位，否则 running 永久 true（用户症状：无法停止）。
    // 进程保留（cancel 已让 agent 停轮），下一轮照常可用。
    const turn = this.turnSeq;
    this.clearAbortFallback();
    this.abortFallbackTimer = setTimeout(() => {
      this.abortFallbackTimer = null;
      if (this.running && turn === this.turnSeq) {
        console.warn(`[acp:${this.agentName}] session/cancel 无应答，强制收口（aborted）`);
        this.finishTurn(turn, "aborted");
      }
    }, ACP_CANCEL_SETTLE_FALLBACK_MS);
  }

  /** cancel 无应答兜底定时器清理（收口/进程死亡/dispose 共用）。 */
  private clearAbortFallback(): void {
    if (this.abortFallbackTimer) clearTimeout(this.abortFallbackTimer);
    this.abortFallbackTimer = null;
  }

  /**
   * 轮次收口（单点）：复位 running、冲刷 partial 文本、发唯一 agent_settled。
   * 幂等——同轮重复调用 / 迟到 result（abort 兜底或超时已收口）直接忽略，
   * 防双终态帧（前端「停止中」按 agent_settled 复位）。
   * 返回 true = 本次调用完成收口；false = 该轮已收口过。
   */
  private finishTurn(turn: number, stopReason: string, error?: unknown): boolean {
    if (turn !== this.turnSeq || this.settledTurn >= turn) return false;
    this.settledTurn = turn;
    this.clearAbortFallback();
    this.running = false;
    this.abortRequested = false;
    this.lastStopReason = stopReason;
    if (this.partialText) {
      this.liveHistory.push({
        role: "assistant",
        content: [{ type: "text", text: this.partialText }],
        // 同 flushReplayAssistant：始终尝试带 model 戳（缺省会触发前端元信息行崩溃）
        ...(this.model?.id ? { model: this.model.id } : {}),
        provider: this.source,
      });
      this.partialText = "";
    }
    const errorMessage = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
    this.emit({ type: "agent_settled", stopReason, ...(errorMessage ? { errorMessage } : {}) });
    return true;
  }

  /** 取消所有待决授权（回 cancelled + 清表 + 会话消息流记录）。 */
  private cancelPendingPermissions(reason: string): void {
    for (const [key, entry] of this.permissionRequests) {
      if (entry.timer) clearTimeout(entry.timer);
      if (!entry.autoResolved) {
        this.writePermissionCancelled(entry.rawId ?? key);
        this.emit({ type: "permission_expired", requestId: key });
        this.recordPermissionCustom(entry.toolName ?? "tool", entry.input, "cancelled", false, key);
      }
    }
    this.permissionRequests.clear();
    if (reason) console.log(`[acp:${this.agentName}] pending permissions cancelled: ${reason}`);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (!this.aliveFlag) return;
    this.child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child?.kill("SIGKILL");
        resolve();
      }, 1000);
      this.child?.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.markDead("disposed");
  }

  alive(): boolean {
    return this.aliveFlag && (!this.child || this.child.exitCode === null);
  }

  isRunning(): boolean {
    return this.running;
  }

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  /**
   * 运行时切换模型：session/set_model RPC（ACP 协议方法；宿主 CLI 不支持时
   * method-not-found/超时 → false，fail-loud）。
   */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    if (!this.aliveFlag || !this.sessionId) return false;
    try {
      await this.rpc("session/set_model", { sessionId: this.sessionId, modelId: model.id }, 30_000);
    } catch (e) {
      console.warn(`[acp:${this.agentName}] set_model(${model.id}) failed:`, e instanceof Error ? e.message : e);
      return false;
    }
    const prev = this.model;
    this.model = { id: model.id, provider: this.agentName };
    this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
    this.persistModelState();
    return true;
  }

  /**
   * 模型目录：session/new availableModels（ACP 自有模型宇宙，不并 pi ——
   * set_model 只收 ACP 会话认识的 modelId，混入 pi 条目只会制造必错选项）。
   */
  async getAvailableModels(): Promise<ExtModelEntry[]> {
    return this.models.map((m) => ({ ...m, source: "ext" as const }));
  }

  /** 临时模型状态文件（启动/切换时写：selected + 目录快照，供重开恢复与 pi 目录共享）。 */
  persistModelState(): void {
    if (!this.id) return;
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: `acp-${this.agentKey}`,
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models,
        updatedAt: "",
      }));
  }

  // ---- 能力方法 ----------------------------------------------------------------

  models: Array<{ id: string; provider: string; label?: string }> = [];


  async getMessages(): Promise<unknown[]> {
    return [...this.liveHistory];
  }

  /** @capability followUp —— 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[acp] not running");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage —— queue keeper 队列操作原语转发共享层。
   * followUp 组全 CRUD（move/convert/remove/recall/requeue/clear）；steer 组恒空
   * （ACP 协议无运行中注入面，共享层 mirror 永不填充）。
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

  /** @capability getUsage —— 最近一次 usage_update（上下文占用；帧未到 undefined）。 */
  getUsage() {
    return this.lastUsage;
  }

  /** @capability contextUsage —— 上下文占比（usage_update 的 used/size）。 */
  getContextUsage(): { percent: number; contextWindow: number; tokens: number } | undefined {
    if (!this.lastUsage) return undefined;
    return {
      percent: Math.min(100, (this.lastUsage.contextTokens / this.lastUsage.contextWindow) * 100),
      contextWindow: this.lastUsage.contextWindow,
      tokens: this.lastUsage.contextTokens,
    };
  }

  /** @capability getCommands —— available_commands_update 收到的 slash 命令（帧未到空数组）。 */
  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    return [...this.commands];
  }

  /**
   * 应答 ACP 反向授权请求。
   * - decision.optionId（D17）：按宿主选项表精确应答（前端按钮直传，如 allow_always=「总是允许」）；
   * - 无 optionId：allow → allow_always/allow_once（信任选项）；deny → reject_once（旧行为）。
   * id 原样回写（rawId）；已自动/超时放行者幂等返回 true。
   */
  async respondPermission(requestId: string, decision: { behavior: "allow" | "deny"; optionId?: string; message?: string }): Promise<boolean> {
    const entry = this.permissionRequests.get(requestId);
    if (!entry) return false;
    // 已（自动/超时）放行的请求：幂等返回 true，不重复写回同一 id（重复响应对端会报错）
    if (entry.autoResolved) return true;
    let chosen: AcpPermissionOptionLike | undefined;
    if (decision.optionId) {
      chosen = entry.rawOptions?.find((o) => String(o.optionId ?? "") === decision.optionId);
      if (!chosen) return false; // 前端传了未知 optionId：fail-loud 不乱应答
    } else {
      chosen = decision.behavior === "allow"
        ? entry.allowOpt
        : entry.denyOpt ?? entry.allowOpt;
    }
    if (!chosen) return false;
    // 记录用的行为语义按实际应答的选项定性（optionId 可能与 behavior 不同，如 allow_always）
    const effectiveBehavior: "allow" | "deny" = String(chosen.kind ?? "").startsWith("allow") ? "allow" : "deny";
    if (entry.timer) clearTimeout(entry.timer);
    this.writePermissionSelected(entry.rawId ?? requestId, chosen);
    entry.autoResolved = true;
    this.permissionRequests.delete(requestId);
    this.emit({ type: "permission_expired", requestId });
    this.recordPermissionCustom(entry.toolName ?? "tool", entry.input, effectiveBehavior, false, requestId);
    return true;
  }

  /** 写回 ACP 授权应答（selected）：id 原样回写（number 0 保真）。 */
  private writePermissionSelected(id: string | number, option: AcpPermissionOptionLike): void {
    this.child?.stdin?.write(`${permissionSelectedLine(id, String(option.optionId ?? ""))}\n`);
  }

  /** 写回 ACP 授权应答（cancelled）。 */
  private writePermissionCancelled(id: string | number): void {
    this.child?.stdin?.write(`${permissionCancelledLine(id)}\n`);
  }

  // fail-loud stubs
  steer(): never {
    throw new Error('Capability "steer" is not supported by session backend "' + this.source + '"');
  }
}

// ============================================================================
// Extension entry —— 探测 PATH 上可用的 ACP 后端并逐个注册
// ============================================================================

let registered: string[] = [];
let currentAgents: Array<{ name: string; bin: string; args: string[]; agentKey?: string; isBuiltin: boolean; registered?: boolean }> = [];
let builtinNames = new Set<string>();

// ── Backend scan (shared by startup + rescanBackends) ─────────────────────
// Probe + register pass over builtin + user ACP agents — unconditional
// registration: a missing CLI still registers the entry (available:false +
// installHint, the dropdown greys it out); re-running the scan flips the
// snapshot (POST /api/session-backends/rescan, host-invoked after boot).
type AcpScanSlot = {
  register(provider: {
    type: string;
    label: string;
    agentKey?: string;
    priority?: number;
    maxCapabilities: SessionCapabilitiesLike;
    available?: boolean;
    installHint?: string;
    listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
    refreshModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
    createSession(options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }): Promise<AcpHandle>;
  }): string;
};

function scanAcpBackends(
  slot: AcpScanSlot,
  provide: (<T>(key: string, impl: T) => () => void) | undefined,
  configDir: string,
): { registered: string[]; unavailable: string[] } {
  const nowRegistered: string[] = [];
  const unavailable: string[] = [];
  const userAgents = loadUserAgents(configDir);
  const allAgents = [
    ...ACP_AGENTS.map((a) => ({ ...a, isBuiltin: true })),
    ...userAgents.map((a) => ({ ...a, isBuiltin: false })),
  ];
  for (const agent of allAgents) {
    const resolved = agent.resolve
      ? agent.resolve()
      : (() => { const p = which(agent.bin); return p ? { bin: p, args: agent.args } : null; })();
    const key = slot.register({
      type: agent.name,
      label: `ACP: ${agent.name}`,
      agentKey: agent.agentKey,
      // claude-code 保持 Backend 下拉第一位（方案 aiti-pi-family-multi-fork-rpc-plan §3.2）
      ...(agent.name === "claude-code" ? { order: 10 } : {}),
      maxCapabilities: ACP_CAPABILITIES,
      // Availability snapshot: false = CLI missing → dropdown entry greyed out;
      // refreshed on rescan. installHint comes from the agent catalog.
      ...(resolved ? {} : { available: false as const, ...(agent.installHint ? { installHint: agent.installHint } : {}) }),
      // 模型目录（D15）：缓存条目（启动后台真实获取 + 会话回填）；空 = 跟随 agent 默认；
      // 上次使用的模型置顶（新建页默认项）
      listModels: () => catalogListModels(agent.name, agent.agentKey ?? agent.name),
      refreshModels: () => catalogRefreshModels(agent.name, agent.agentKey ?? agent.name),
      async createSession(options) {
        // 接管既有会话：以原 cwd 优先（session/load）；新会话用宿主 cwd。
        // cwd 先算后构造：handle 信息面（/api/sessions info.cwd）在 start 完成前的
        // 观察窗口也能拿到真实 cwd（2026-11-09 接管/URL 恢复拆除根因之一）。
        const restored = options.sessionId ? await restoreCwdFn?.(agent.agentKey ?? agent.name, options.sessionId) : undefined;
        const cwd = restored ?? options.cwd ?? process.cwd();
        const handle = new AcpHandle(agent.name, resolved.bin, resolved.args, agent.agentKey ?? agent.name, cwd);
        await handle.start(cwd);
        if (options.sessionId) await handle.loadSession(options.sessionId, cwd);
        else await handle.newSession(cwd);
        await applyAcpSeedModel(handle, options.model, { sessionId: options.sessionId });
        return handle as unknown as AcpHandle;
      },
    });
    if (resolved) {
      nowRegistered.push(key);
    } else {
      unavailable.push(key); // 未安装 → 条目常驻但灰显（装机后 rescan 自动点亮）
    }
  }
  registered = nowRegistered;
  currentAgents = allAgents.map((a) => ({
    ...a,
    registered: nowRegistered.includes(`aiti-acp-agent/${a.name}`),
  }));
  builtinNames = new Set(ACP_AGENTS.map((a) => a.name));
  // P2 协议委托：launch 服务（多成员家族——launch.target 选成员，缺省 claude-code 优先）
  const launchAgents = allAgents
    .map((agent) => {
      const resolved = agent.resolve
        ? agent.resolve()
        : (() => { const p = which(agent.bin); return p ? { bin: p, args: agent.args } : null; })();
      return resolved ? { agent, resolved } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const pickDefault = launchAgents.find((x) => x.agent.name === "claude-code") ?? launchAgents[0];
  if (pickDefault) {
    provide?.("aiti-acp-agent.launch", {
      agentKey: pickDefault.agent.agentKey ?? pickDefault.agent.name,
      capabilities: ACP_CAPABILITIES,
      members: allAgents.map((a) => ({ name: a.name, agentKey: a.agentKey ?? a.name, label: `ACP: ${a.name}` })),
      createSessionFromLaunch: async (
        launch: LaunchOverride,
        options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } },
      ) => {
        const hit = (launch.target && launchAgents.find((x) => x.agent.name === launch.target)) || pickDefault;
        if (!hit) throw new Error("[aiti-acp-agent] launch 委托：无可委托成员（agent 未安装）");
        const restored = options.sessionId ? await restoreCwdFn?.(hit.agent.agentKey ?? hit.agent.name, options.sessionId) : undefined;
        const cwd = restored ?? options.cwd ?? process.cwd();
        const handle = new AcpHandle(hit.agent.name, hit.resolved.bin, hit.resolved.args, hit.agent.agentKey ?? hit.agent.name, cwd);
        handle.launchOverride = launch;
        await handle.start(cwd);
        if (options.sessionId) await handle.loadSession(options.sessionId, cwd);
        else await handle.newSession(cwd);
        await applyAcpSeedModel(handle, options.model, { sessionId: options.sessionId });
        return handle;
      },
    });
    // A25-2：agent 账号契约描述符（家族级：各 CLI 凭据目录槽位；仅列已验证路径）
    provide?.("aiti-acp-agent.agent", {
      agent: "acp",
      label: "ACP 家族",
      modes: ["tui"],
      dependencyHint: "各 ACP CLI 随用随装（装机才接原则）",
      accountSlots: (c: { home: string }) => [
        { key: "qwen-oauth", label: "Qwen Code OAuth", path: join(c.home, ".qwen", "oauth_creds.json") },
        { key: "gemini-oauth", label: "Gemini CLI OAuth", path: join(c.home, ".gemini", "oauth_creds.json") },
        { key: "copilot-hosts", label: "GitHub Copilot hosts", path: join(c.home, ".config", "github-copilot", "hosts.json") },
      ],
    });
    console.log(`[aiti-acp-agent] registered: ${nowRegistered.join(", ") || "(none)"} + launch service`);
  } else {
    console.log(`[aiti-acp-agent] registered: ${nowRegistered.join(", ") || "(none)"}`);
  }
  return { registered: nowRegistered, unavailable };
}

/** 会话 recycle（D8，共享层 session-recycle.ts）：存量 AcpHandle 升级到当前扩展代码。 */
const recycleApi = createSessionRecycleApi({
  isOwn: (h) => typeof (h as { agentName?: unknown }).agentName === "string",
  parseId: (id) => {
    const i = id.indexOf(":");
    if (i <= 0) return null;
    const agentKey = id.slice(0, i);
    const sessionId = id.slice(i + 1);
    const agent = currentAgents.find((a) => (a.agentKey ?? a.name) === agentKey && a.registered !== false);
    if (!agent) return null;
    return { sessionId, providerType: `aiti-acp-agent/${agent.name}` };
  },
});
/** sessionId 接管时的原 cwd 解析（startup 注入 session-manager 服务；未就绪返回 undefined）。 */
let restoreCwdFn: ((agentKey: string, sid: string) => Promise<string | undefined>) | null = null;

/** createSession 收尾：种子模型（显式 options.model 且非当前 → set_model）+ 状态文件落盘。
 *  新会话（无 sessionId）且无显式模型 → 该 ACP agent 上次使用的模型（per-agent last used）。
 *  KV 由共享层 writeExtModelState 每次写入时顺手维护，扩展内零记录代码。 */
async function applyAcpSeedModel(handle: AcpHandle, model?: { provider: string; id: string }, opts?: { sessionId?: string }): Promise<void> {
  let seed = model;
  // 仅新会话用 agent 级默认；resume 会话模型以 ACP 会话自身（currentModelId）为准
  if (!seed?.id && !opts?.sessionId) {
    seed = (await readAgentLastUsedModel(`acp-${handle.agentKey}`)) ?? undefined;
  }
  try {
    if (seed?.id && handle.getModel()?.id !== seed.id) {
      await handle.setModel({ id: seed.id, provider: handle.agentName });
    }
  } catch (e) {
    console.warn(`[acp:${handle.agentName}] seed model failed:`, e instanceof Error ? e.message : e);
  }
  handle.persistModelState();
}

// ============================================================================
// 模型目录（D15）：缓存 + 分层探测 + 启动后台刷新
// ============================================================================

let catalogStore: ModelCatalogStore | null = null;
let catalogRefresher: CatalogRefresher | null = null;
/** ACP 预启动探测的集中临时 cwd（cache 层，可整体清理）。 */
let catalogProbeCwd = "";

/** cbc CLI 三元组（--help 探测用；不带 --acp 参数）。 */
function cbcCliCommand(): { cmd: string; baseArgs: string[] } | null {
  const direct = which("cbc") ?? which("codebuddy");
  if (direct) return { cmd: direct, baseArgs: [] };
  const npxCli = npxCliJsPath();
  if (existsSync(npxCli)) return { cmd: process.execPath, baseArgs: [npxCli, "-y", "@tencent-ai/codebuddy-code"] };
  return null;
}

function probeSpawnEnv(): Record<string, string> {
  return agentSpawnEnv({ cli: "acp", governance: governanceEnv, extId: "aiti-acp-agent", envList: spawnEnvList("aiti-acp-agent") });
}

/**
 * 治理键按后端映射（env 白名单选择）：家族缺省 "acp"（仅 ACP_* 前缀 + 基础键）；
 * codex 例外——codex-acp 走 ~/.codex/config.toml 自定义 provider（openrouter 等），
 * 缺 OPENROUTER_API_KEY 轮次直接失败（2026-11-08 实测），映射到 governanceEnv 的
 * "codex" 白名单（native aiti-codex-agent 同款）。
 */
function governanceCliFor(agentName: string): string {
  return agentName === "codex" ? "codex" : "acp";
}

type ProbeAgentDesc = { name: string; bin: string; args: string[]; agentKey?: string };

/** CLI 目录探测：cbc --help（共享解析器）/ opencode models。 */
async function probeCliCatalog(agent: ProbeAgentDesc): Promise<CatalogEntry | null> {
  if (agent.name === "codebuddy") {
    const cli = cbcCliCommand();
    if (!cli) return null;
    const r = await probeCbcCatalog(cli, { timeoutMs: 60_000, env: probeSpawnEnv() });
    if (!r.models.length) return null;
    return { models: r.models, source: "cli", fetchedAt: Date.now(), ...(r.cliVersion ? { cliVersion: r.cliVersion } : {}) };
  }
  if (agent.name === "opencode") {
    const bin = which("opencode");
    if (!bin) return null;
    const r = await runCliCapture(bin, ["models"], { timeoutMs: 60_000, env: probeSpawnEnv() });
    const models = parseOpenCodeModels(r.stdout);
    if (!models.length) return null;
    return { models, source: "cli", fetchedAt: Date.now() };
  }
  return null;
}

/** ACP 预启动探测：spawn → initialize → session/new（临时 cwd）→ 取目录 → 关闭。 */
async function probeAcpCatalog(agent: ProbeAgentDesc & {
  resolve?: () => { bin: string; args: string[] } | null;
}): Promise<CatalogEntry | null> {
  const resolved = agent.resolve
    ? agent.resolve()
    : (() => { const p = which(agent.bin); return p ? { bin: p, args: agent.args } : null; })();
  if (!resolved) return null;
  const cwd = join(catalogProbeCwd, agent.name);
  try { mkdirSync(cwd, { recursive: true }); } catch { /* 沿用缺省 */ }
  const handle = new AcpHandle(agent.name, resolved.bin, resolved.args, agent.agentKey ?? agent.name, cwd, true);
  try {
    await handle.start(cwd);
    // 单探测 60s 上限（session/new 内部宽限 150s；超时即弃，失败静默）
    const ok = await Promise.race([
      handle.newSession(cwd).then(() => true as const),
      new Promise<false>((r) => setTimeout(() => r(false), 60_000).unref?.()),
    ]);
    if (!ok) return null;
    const current = handle.getModel()?.id;
    return {
      models: handle.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })),
      ...(current ? { currentModelId: current } : {}),
      source: "acp",
      fetchedAt: Date.now(),
    };
  } finally {
    try { await handle.dispose(); } catch { /* 已死 */ }
  }
}

/** 运行期回填：任何真实会话的 availableModels/currentModelId（source:"session" 优先级最高）。 */
function noteSessionCatalog(agentName: string, models: Array<{ id: string; label?: string }>, currentModelId?: string): void {
  if (!catalogStore || !models.length) return;
  catalogStore.put(agentName, {
    models,
    ...(currentModelId ? { currentModelId } : {}),
    source: "session",
    fetchedAt: Date.now(),
  });
}

const CATALOG_LAZY_WAIT_MS = 15_000;

/**
 * provider listModels 出口：缓存条目 → `{id, provider: agentName, label}`。
 * 缺失/过期：in-flight 探测则限时 await；否则返回现有并触发后台刷新（不阻塞新建页）。
 * 始终不回退 pi 本地目录（provider 错配；空 = 前端「跟随 agent 默认」）。
 */
async function catalogListModels(agentName: string, agentKey?: string): Promise<Array<{ id: string; provider: string; label?: string }>> {
  const store = catalogStore;
  if (!store) return [];
  const entry = store.get(agentName);
  if (!entry || !store.isFresh(agentName)) {
    if (catalogRefresher?.inFlight(agentName)) {
      await Promise.race([
        catalogRefresher.refresh(agentName).catch(() => null),
        new Promise((r) => setTimeout(r, CATALOG_LAZY_WAIT_MS)),
      ]);
    } else {
      void catalogRefresher?.refresh(agentName).catch(() => null);
    }
  }
  const cur = store.get(agentName);
  const list = (cur?.models ?? []).map((m) => ({ id: m.id, provider: agentName, ...(m.label ? { label: m.label } : {}) }));
  // 上次使用的模型置顶（新建页默认项 = list[0]，默认即该 agent 上次使用；KV 缺/未命中不合成）
  const lastUsed = agentKey ? await readAgentLastUsedModel(`acp-${agentKey}`) : null;
  return withLastUsedFirst(list, lastUsed?.id);
}

/** 手动刷新出口（新建页「刷新模型列表」）：跳过 TTL 强制探测（与启动/惰性探测共用单飞）。 */
async function catalogRefreshModels(agentName: string, agentKey?: string): Promise<Array<{ id: string; provider: string; label?: string }>> {
  const store = catalogStore;
  if (!store) return [];
  const entry = await catalogRefresher?.refreshForce(agentName).catch(() => null);
  const cur = entry ?? store.get(agentName);
  const list = (cur?.models ?? []).map((m) => ({ id: m.id, provider: agentName, ...(m.label ? { label: m.label } : {}) }));
  const lastUsed = agentKey ? await readAgentLastUsedModel(`acp-${agentKey}`) : null;
  return withLastUsedFirst(list, lastUsed?.id);
}

/** 启动目录：cache 层缓存 + 分层探测刷新器（探测描述按注册表动态解析）。 */
function initModelCatalog(ctx: { configDir: string; cacheDir?: string }): void {
  const cacheDir = ctx.cacheDir || join(dirname(ctx.configDir), "cache");
  catalogProbeCwd = join(cacheDir, "acp-probe");
  catalogStore = new ModelCatalogStore(cacheDir);
  catalogRefresher = createCatalogRefresher(catalogStore, () => {
    const descs: AgentProbeDesc[] = currentAgents
      .filter((a) => a.registered !== false)
      .map((a) => {
        const desc: ProbeAgentDesc & { resolve?: () => { bin: string; args: string[] } | null } = {
          name: a.name, bin: a.bin, args: a.args, agentKey: a.agentKey,
        };
        if (a.name === "codebuddy") desc.resolve = resolveCodebuddyAcp;
        return {
          name: a.name,
          probeCli: () => probeCliCatalog(desc),
          // 仅对无 CLI 源的 agent 走 ACP 预启动（重探测，产生空会话——集中在 cacheDir/acp-probe/）
          probeAcp: a.name === "codebuddy" || a.name === "opencode"
            ? undefined
            : () => probeAcpCatalog(desc),
          ...(a.name === "codebuddy" ? { cliVersion: async () => probeCbcCatalog(cbcCliCommand() ?? { cmd: "", baseArgs: [] }, { timeoutMs: 15_000 }).then((r) => r.cliVersion) } : {}),
        } satisfies AgentProbeDesc;
      });
    return descs;
  });
  // 启动后台刷新（不阻塞 startup；失败静默）
  void catalogRefresher.refreshAll().catch((e) =>
    console.warn("[acp-catalog] refreshAll failed:", e instanceof Error ? e.message : e));
}

export default {
  id: "aiti-acp-agent",
  name: "ACP Agents (通用 ACP 驱动)",
  icon: "🔌",
  client: "dist/acp-manager.mjs",
  ui: {
    clientImmediately: true,
    // 各入口默认不渲染——client 按 feature 门控（behavior.showAcpManager）。
    // 入口只负责打开统一弹窗（dialogs 插槽），设置全部集中在弹窗内。
    // feature 门控静态化：关 → 宿主不渲染静态按钮（懒加载 v2 ExtUiItem.feature）
    toolbar: [{ id: "aiti-acp-manage-open", label: "ACP", title: "Manage ACP backend agents", icon: "icons/plug.svg", feature: "behavior.showAcpManager" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    sidebarExplorerDock: [{ id: "manage", label: "ACP" }],
    rightFileDock: [{ id: "manage", label: "ACP" }],
    dialogs: [{ id: "acp-manage-dialog", label: "ACP Backend Agents" }],
    newSessionBackendOptions: [{ id: "acp-manage-option", label: "Manage ACP Agents…" }],
  },

  // AI 自管理清单：AI 能帮我接入新的 ACP 后端 agent / 排查为什么没注册上
  ai: {
    manage: true,
    intro: "AI 能帮我添加 ACP 兼容后端 agent（claude-code/gemini/opencode 之外的），并排查为什么没出现在后端列表",
    skills: "skills",
  },

  // 功能管理：入口默认隐藏，用户在 extman 里打开后显示
  features: [
    spawnEnvFeature("ACP"),
    spawnCommandFeature("ACP"),
    spawnArgsPrefixFeature("ACP"),
    { id: "acp.permissionPolicy",
      type: "string" as const,
      label: "工具授权策略",
      group: "ACP",
      description: "allow（默认，信任 agent：优先切 bypass 模式 + 自动放行，不打扰）| ask（转前端授权卡人工审批，请求与决策写入会话消息）",
      value: "allow",
      placeholder: "allow | ask",
    },
    { id: "acp.permissionTimeoutSec",
      type: "string" as const,
      label: "人工审批超时（秒）",
      group: "ACP",
      description: "ask 模式下人工未回应时的兑底：超时自动允许（信任优先），默认 300；0 = 无限等待",
      value: "300",
      placeholder: "300",
    },
    { id: "behavior.showAcpManager",
      label: "显示「ACP Agents」工具条按钮",
      group: "UI",
      description: "默认隐藏。打开后在顶部工具栏显示 ACP 管理入口（弹窗）；新会话页 Backend 下拉里的「Manage ACP Agents…」选项不受此开关影响，始终显示",
      default: false,
    },
  ],

  server: {
    startup(ctx: {
      id: string;
      configDir: string;
      cacheDir?: string;
      features?: { get(extId: string, fid: string): unknown };
      /** 跨扩展服务 slot（P2 协议委托；缺省=旧宿主降级）。 */
      services?: { provide<T>(key: string, impl: T): () => void };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          refreshModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          createSession(options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }): Promise<AcpHandle>;
        }): string;
      };
    }) {
      registered = [];
      hostFeatures = (ctx as { features?: { get(extId: string, fid: string): unknown } }).features ?? null;
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json；docs/aiti-remote-queue-and-sidecar-plan.md §3）
      queueStateDir = (ctx as { stateDir?: string }).stateDir ?? join(ctx.configDir, "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // 恢复 cwd 辅助（sessionId 接管路径）：session-manager 是外部 agent 存储唯一读取实现；
      // ACP 会话的 cwd 必须以原会话归属为准（cbc session/load 按项目目录查找）。
      // ⚠ 服务必须按调用时动态解析：扩展 startup 顺序不保证 session-manager 已注册
      //（在 startup 缓存 get 结果会拿到 undefined → 恢复永远失败）。
      const hostServices = (ctx as { services?: { get(key: string): unknown } })?.services;
      restoreCwdFn = async (agentKey: string, sid: string): Promise<string | undefined> => {
        try {
          const reg = (globalThis as { __piWebExt?: { byId?(id: string): { ext?: { services?: Record<string, unknown> } } } }).__piWebExt;
          const svc = (hostServices?.get?.("session-manager.sessions")
            ?? reg?.byId?.("session-manager")?.ext?.services?.sessions) as
            { parseSession?(id: string): Promise<{ meta?: { cwd?: unknown } } | null> } | undefined;
          if (typeof svc?.parseSession !== "function") return undefined;
          const parsed = await svc.parseSession(`${agentKey}:${sid}`);
          const cwd = parsed?.meta?.cwd;
          return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
        } catch { return undefined; }
      };

      // builtin+user agents 探测+注册+launch 服务（可重入；装机后无需重启，经 rescanBackends 重扫）
      const acpScan = scanAcpBackends(ctx.sessionProviders, ctx.services?.provide, ctx.configDir);
      if (acpScan.unavailable.length) {
        console.log(`[aiti-acp-agent] startup scan: ${acpScan.unavailable.length} agent(s) not installed (greyed out in the dropdown)`);
      }
      // 模型目录（D15）：cache 层缓存 + 启动后台真实获取（不阻塞 startup）
      initModelCatalog(ctx);
    },

    /** Backend rescan (POST /api/session-backends/rescan): re-run the probe pass —
     *  ACP CLIs installed after host boot light up without a restart; missing ones
     *  stay greyed out with the install hint. */
    rescanBackends(ctx: {
      configDir: string;
      sessionProviders: AcpScanSlot;
      services?: { provide<T>(key: string, impl: T): () => void };
    }) {
      const r = scanAcpBackends(ctx.sessionProviders, ctx.services?.provide, ctx.configDir);
      console.log(`[aiti-acp-agent] rescan: ${r.registered.length} available / ${r.unavailable.length} not installed`);
      return r;
    },

    async api(req: Request, ctx: {
      path: string[]; method: string; configDir: string;
      sessionProviders: {
        register(provider: { type: string; label: string; agentKey?: string; priority?: number; maxCapabilities: SessionCapabilitiesLike;
          listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          refreshModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          createSession(options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }): Promise<AcpHandle>; }): string;
        remove(type: string): boolean;
      };
    }) {
      const recycled = await recycleApi(req, ctx);
      if (recycled) return recycled;
      const [action] = ctx.path;
      if (action === "agents") {
        if (req.method === "GET") {
          return Response.json({
            agents: (currentAgents ?? []).map(({ isBuiltin: _, ...rest }) => rest),
            builtinNames: [...builtinNames],
          });
        }
        if (req.method === "POST") {
          const body = await req.json() as UserAcpAgent;
          if (!body.name || !body.bin) return Response.json({ error: "name and bin required" }, { status: 400 });
          const agents = loadUserAgents(ctx.configDir);
          if (agents.some((a) => a.name === body.name)) return Response.json({ error: "duplicate name" }, { status: 409 });
          agents.push({ name: body.name, bin: body.bin, args: body.args ?? [], agentKey: body.agentKey });
          saveUserAgents(ctx.configDir, agents);
          // 热注册：立即可用，无需 reload
          const binPath = which(body.bin);
          if (binPath) {
            ctx.sessionProviders.register({
              type: body.name,
              label: `ACP: ${body.name}`,
              agentKey: body.agentKey,
              maxCapabilities: ACP_CAPABILITIES,
              listModels: () => catalogListModels(body.name, body.agentKey ?? body.name),
              refreshModels: () => catalogRefreshModels(body.name, body.agentKey ?? body.name),
              createSession: async (opts) => {
                const handle = new AcpHandle(body.name, binPath, body.args ?? [], body.agentKey ?? body.name);
                const restored = opts.sessionId ? await restoreCwdFn?.(body.agentKey ?? body.name, opts.sessionId) : undefined;
                const cwd = restored ?? opts.cwd ?? process.cwd();
                await handle.start(cwd);
                if (opts.sessionId) await handle.loadSession(opts.sessionId, cwd);
                else await handle.newSession(cwd);
                await applyAcpSeedModel(handle, opts.model, { sessionId: opts.sessionId });
                return handle as unknown as AcpHandle;
              },
            });
            // 更新 currentAgents 供 GET 查询
            currentAgents.push({ name: body.name, bin: body.bin, args: body.args ?? [], agentKey: body.agentKey, isBuiltin: false, registered: true });
          }
          return Response.json({ ok: true, hotRegistered: Boolean(binPath) });
        }
        if (req.method === "DELETE") {
          const name = new URL(req.url).searchParams.get("name");
          if (!name) return Response.json({ error: "name required" }, { status: 400 });
          const agents = loadUserAgents(ctx.configDir);
          saveUserAgents(ctx.configDir, agents.filter((a) => a.name !== name));
          ctx.sessionProviders.remove(`aiti-acp-agent/${name}`);
          currentAgents = (currentAgents ?? []).filter((a) => a.name !== name);
          return Response.json({ ok: true });
        }
      }
      return null;
    },
  },
};
