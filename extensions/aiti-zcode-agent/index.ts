/**
 * aiti-zcode-agent —— 会话后端扩展：智谱 ZCode（桌面端内嵌 CLI runtime）驱动。
 *
 * 协议：`node zcode.cjs --json --mode build [--resume sess_xxx] --prompt <text>`
 *   （runtime 0.16.5 实测：--json 为单个 pretty JSON 对象，exit 0 全量打印）
 *   → { sessionId, traceId, turnId, response, usage{inputTokens,...}, projection{contextWindow} }
 *
 * 进程模型：每轮一个单发进程（同 aiti-codex-agent 的 exec 模式），续接用 --resume。
 * 与 CC print 模式同款懒持久化：sess_xxx 首轮后可知，session_backend_ready 换绑。
 *
 * 认证：官方 env 注入通道（ZCODE_MODEL/ZCODE_BASE_URL/ZCODE_API_KEY，不写 config.json）；
 *       key 由桌面端凭据静默换取（官方 login 同路径，幂等），详见 zcode-core.ts §注释。
 *
 * 合规定位：编程套餐额度仅限官方工具白名单（Claude Code/Codex/ZCode/...），
 * 借道官方 CLI 本体驱动 = 合规吃套餐；所有 HTTP 调用由官方 CLI 构造，无风控面。
 *
 * 调研底稿：docs/zcode-desktop-cli-agent-analysis.md
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { governanceEnv } from "./external-governance.ts";
import { agentSpawnEnv, spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// 队列共享实现层（权威源 pi-web-ext/_shared/backend-queue.ts，副本随扩展部署——改动须双向同步）
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar } from "@aiti-ai/ext-shared/backend-queue";

/** 队列崩溃恢复 sidecar 根（startup 捕获 <stateDir>；undefined/空 = 不持久化）。 */
let queueStateDir: string | undefined;
/** 任务列表快照根（<stateDir>/task-lists/<zcodeSid>.json；休眠会话面板兜底数据源，§7.5）。 */
let taskListDir: string | undefined;
import {
  readExtModelState, readAgentLastUsedModel, renameExtModelState, writeExtModelState,
  withCurrentFirst, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";
import { AppServerSession, type TaskEntry, type TurnOutcome, type TurnUsageSnapshot } from "./zcode-appserver.ts";
import {
  DEFAULT_MODEL_REF, START_PLAN_BASE_URL, ZCODE_CONTEXT_WINDOW, ZCODE_MODES, ZCODE_PLATFORM_BASE_URL,
  baseUrlFor, buildCliArgs, buildTurnEnv, buildZcodeCatalogRefs, channelFamily, detectPlanProvider, ensureCredential, ensureStartPlanCredential, execZcodeTurn, fetchCaptchaConfig,
  extractCliError, isChannelDriveable, parseModelRef, parseTurnOutput, resolveNodeBin, resolveRuntime,
  isStartPlanChannel, planQuotaView, readPlanStatus, usageToReport, wireProviderId, writeProviderConfigFile, zcodeHome, zcodeLoginDriver, humanizeZcodeError,
} from "./zcode-core.ts";
// 冷恢复工具行回放共享口径（权威源 pi-web-ext/_shared/seed-tool.ts；D18 四家归一）
import { createSeedToolReplay } from "@aiti-ai/ext-shared/seed-tool";

// 受控登录共享层（权威源 pi-web-ext/_shared/controlled-login.mjs，副本随扩展部署——改动须双向同步）
import { createControlledLogin, mountControlledLoginApi } from "@aiti-ai/ext-shared/controlled-login";

// ============================================================================
// 结构化契约（out-of-tree）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

/** zcode 会话存储只读探测（WAL 并发读安全，与 session-manager zcode adapter 同源契约）。
 *  返回该会话的 time_updated（epoch ms）作为「外部写入水位」；db 缺失/写锁/读失败 → null
 *  （调用方跳过同步、保持现状，下轮再试）。 */
function readZcodeSessionUpdatedMs(sid: string): number | null {
  try {
    const dbPath = join(zcodeHome(), "cli", "db", "db.sqlite");
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db.prepare("SELECT time_updated FROM session WHERE id = ?").get(sid) as { time_updated?: number } | undefined;
      return typeof row?.time_updated === "number" && row.time_updated > 0 ? row.time_updated : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * 模型目录（注册级静态 + handle 实例共用）：CLI 只认自己 provider 表的 ref，不并 pi 目录。
 * 动态发现（不写死）：通道/模型来自桌面端 v2/config.json 注册表 + coding-plan-cache.json
 * available 条目（buildZcodeCatalogRefs；静态 seed 仅兜底）。
 * 通道级可用裁决在 buildZcodeCatalogRefs（isChannelDriveable，2026-09-15：套餐通道须自身
 * available）；此处再按已认证套餐家族过滤（detectPlanProvider；apiKeyOverride 存在/探测不出时全列）——
 * 防止用户切到无凭据通道的模型（实测：zai 未登录选 zai/Flash → 每轮凭据人话报错）。
 * start-plan（ZCode 套餐）通道不再从目录排除：照常列出并带「暂不支持」提示（buildZcodeCatalogRefs 标签），
 * 选中/新建/发消息三处人话拦截（验证码只能桌面 GUI 产生，pi-web 不可驱动，见 START_PLAN_UNSUPPORTED）。
 * 当前选中模型即使跨通道也保留（选择器需展示现状）。
 */
function zcodeCatalog(current?: { id: string; provider: string }): ExtModelEntry[] {
  const planFamily = detectPlanProvider();
  const override = featureApiKeyOverride();
  let builtin: ExtModelEntry[] = buildZcodeCatalogRefs().map((m) => ({ id: m.id, label: m.label, provider: "zcode", source: "ext" as const }));
  if (!override && planFamily) {
    builtin = builtin.filter((m) => channelFamily(m.id.split("/")[0]) === planFamily);
  }
  // 目录内命中 → 前移并保留目录 label；不在目录（旧套餐 ref、恢复的 start-plan 会话等）→ 合成条目也带
  // 可读标签（`模型id (通道)`，与目录同格式）并补「暂不支持」提示——避免选择器出现裸 ref 行（2026-09-14）。
  const cur = current?.id
    ? {
        ...current,
        label: refDisplayLabel(current.id) + (isStartPlanChannel(current.id.split("/")[0]) ? " · 暂不支持" : ""),
      }
    : undefined;
  return withCurrentFirst(builtin, cur);
}

/** ref → 展示标签（`channel/modelId` → `modelId (channel)`，与目录同格式；无斜杠原样返回）。 */
function refDisplayLabel(ref: string): string {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return ref;
  return `${ref.slice(i + 1)} (${ref.slice(0, i)})`;
}

/**
 * 该 agent 上次使用的模型（状态文件里 mtime 最新的 selected；带通道合法性校验）——
 * 新建会话未显式指定模型时的默认来源（per-agent last used，对齐 pi 的 defaultModel 语义）。
 * 校验规则与 createSession 一致（channelUsable）：start-plan 不驱动 + 套餐通道须自身
 * available（2026-09-15 通道级收紧）+ 不跨未认证家族——上次用过的死通道不再作默认。
 */
async function lastUsedModelRef(): Promise<{ id: string; provider: string } | undefined> {
  const last = await readAgentLastUsedModel("zcode");
  if (!last?.id || !parseModelRef(last.id)) return undefined;
  if (!channelUsable(last.id.split("/")[0])) return undefined;
  return { id: last.id, provider: "zcode" };
}

/** abort 看门狗：session/stop 发出后未收口的强杀宽限期（zcode 端 turn 挂死时 stop 是 no-op）。
 *  从 abort() 入口起算（不再叠加 session/stop 的 RPC 等待）——总收口上限 = 本时长。 */
const ZCODE_ABORT_WATCHDOG_MS = 6_000;

const ZCODE_CAPABILITIES_BASE: SessionCapabilitiesLike = {
  // 原生 steer（desktop 同款）：运行中 v4/command sendText{requestedDelivery:"guide"} 注入当前轮，
  // runtime 在下一模型/工具间隙 drain（turn.steerDrained 出队）+ 模型同轮即答（2026-09-10 真机实测）。
  // ⚠ 必须走 v4 网关——v1 session/send 运行中路径实测只入延迟队列且永不投递（黑洞，见 analysis §7.6）。
  // oneshot 通道无 v4 面 → 注入失败自动降级本地 followUp 队列（R9）。
  steer: true,
  followUp: true, // 每轮一个新进程 + --resume，天然顺序语义
  contextUsage: true, // turn.completed 真实 usage（totalTokens/input 优先）+ ZCODE_CONTEXT_WINDOW（1M）；估算 tokenCount 仅兜底
  setModel: true, // app-server：session/setModel 即时生效；oneshot：下轮 spawn 的 ZCODE_MODEL
  setThinkingLevel: false,
  renameSession: false,
  compact: false,
  executeBash: false,
  listTools: false, // 内置工具集固定
  setActiveTools: false,
  navigateTree: false, // zcode 无会话树——「编辑从此处」走 fork 语义（见 zcodeCapabilities fork 注）
  deleteSession: false,
  getCommands: false, // 可用 `zcode.cjs commands list` 读，P2
  respondPermission: false, // app-server 反向请求自动放行（backend 语义）；权限 UI 双向桥接是后续项
  getUsage: true,
  listModels: true,
  fileAttachments: true, // images → v4 attachment begin/chunk/commit 上传 + session/send attachments（app-server 桌面端同款，2026-09-17）
  getMessages: true,
  setPermissionMode: true, // app-server：session/setMode 即时生效（桌面端同款）；oneshot：下轮 spawn 的 --mode
  queueManage: true, // 队列 keeper 适配：followUp 本地队列全 CRUD + steer 镜像只读（见 queueManage）
  respondInteraction: true, // 交互元语桥接：zcode ExitPlanMode/AskUserQuestion 反向请求 → 前端审批/问题卡（oneshot 通道无反向请求面，运行时降级）
  respondProviderHeaders: true, // start-plan 验证码桥：provider_runtime_headers_request → 前端 AliyunCaptcha SDK → respond_provider_headers
};

/**
 * fork 能力按通道判定：session/fork 协议面只有 app-server 常驻连接可用（oneshot 每轮
 * 单发进程，fork 出的子会话无法续跑）。fork=true 同时点亮两个前端能力——消息「分支」
 * 按钮（fork 新会话不换绑）与「编辑从此处」（fork + handle 换绑就地续跑，reset 语义）。
 * 服务端限制「运行中不许 fork」原样上抛为提示（能力保留、时机受限），不静默。
 */
function zcodeCapabilities(): SessionCapabilitiesLike {
  return featureTransport() === "app-server" ? { ...ZCODE_CAPABILITIES_BASE, fork: true } : ZCODE_CAPABILITIES_BASE;
}

// ============================================================================
// feature 读取（extman 功能管理）——DI 方案 P1：ctx.features 优先，__piWebExt 直调兜底
// ============================================================================

let hostFeatures: any = null; // startup 捕获 ctx.features
let hostSvc: any = null; // startup 捕获 ctx.services（session-manager.sessions 消费用）
type FeatureRegistry = { featureValue?: (extId: string, fid: string) => boolean | string };
function featureRegistry(): FeatureRegistry | undefined {
  return (globalThis as Record<string, unknown>).__piWebExt as FeatureRegistry | undefined;
}
function featureString(fid: string): string {
  const v = hostFeatures?.get?.("aiti-zcode-agent", fid);
  if (typeof v === "string") return v;
  const reg = featureRegistry();
  const v2 = reg?.featureValue ? reg.featureValue("aiti-zcode-agent", fid) : "";
  return typeof v2 === "string" ? v2 : "";
}
function featureBool(fid: string, fallback: boolean): boolean {
  const v0 = hostFeatures?.get?.("aiti-zcode-agent", fid);
  if (typeof v0 === "boolean") return v0;
  if (v0 === "true") return true;
  if (v0 === "false") return false;
  const reg = featureRegistry();
  const v = reg?.featureValue ? reg.featureValue("aiti-zcode-agent", fid) : fallback;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function featureRuntimePath(): string | undefined {
  const v = featureString("zcode.runtimePath").trim();
  return v || undefined;
}
function featureAutoDownload(): boolean {
  return featureBool("zcode.autoDownload", true);
}
function featureMode(): string | undefined {
  const v = featureString("zcode.mode").trim();
  return v || undefined;
}
function featureApiKeyOverride(): string | undefined {
  const v = featureString("zcode.apiKeyOverride").trim();
  return v || undefined;
}

/** start-plan（ZCode 套餐）通道不可驱动的人话提示（选择/新建/发消息三处拦截共用）。 */
const START_PLAN_UNSUPPORTED =
  "ZCode 套餐通道（start-plan）需要阿里云验证码验证，验证码只能由 ZCode 桌面端产生，pi-web 暂不支持。请改用 bigmodel/zai 通道模型（如 GLM-5.3），或到 ZCode 桌面端继续使用该套餐。";

/** start-plan 已知会话（All Sessions 复活/已存在的会话）的拦截提示——明确告知会话是 start-plan 加载的。 */
const START_PLAN_UNSUPPORTED_KNOWN =
  "该会话是由 start-plan（ZCode 套餐）通道加载的已知会话：套餐通道需要阿里云验证码验证，验证码只能由 ZCode 桌面端产生，pi-web 暂不支持驱动。请先在模型选择器中切换到 bigmodel/zai 通道模型（如 GLM-5.3）后继续，或到 ZCode 桌面端使用该套餐。";

/**
 * 通道可驱动校验（createSession 种子/恢复 + lastUsedModelRef 共用）：
 * start-plan 不驱动；apiKeyOverride 直通；其余按套餐缓存通道级裁决
 * （isChannelDriveable：套餐通道须自身 available——2026-09-15 收紧，家族级连带放行
 * 会种出「选中即每轮 429/1113」的死通道）；探测不出（无套餐数据）回落旧家族匹配。
 */
function channelUsable(providerId: string): boolean {
  if (isStartPlanChannel(providerId)) return false;
  if (featureApiKeyOverride()) return true;
  const driveable = isChannelDriveable(providerId);
  if (driveable !== null) return driveable;
  const plan = detectPlanProvider();
  return plan === null || channelFamily(providerId) === plan;
}

/** 传输通道：app-server（默认，桌面端同款长驻流式）| oneshot（每轮单发进程兜底）。 */
function featureTransport(): "app-server" | "oneshot" {
  const v = featureString("zcode.transport").trim();
  return v === "oneshot" ? "oneshot" : "app-server";
}

/**
 * spawn env（共享机制，_shared/agent-spawn-env.ts）：治理白名单 + 自动 AITI_BRIDGE_URL
 * （pi-web 自身实例，zcode 的 MCP shim 子进程继承 → 自动连 spawn 自己的这个实例的桥）
 * + extman spawn.env 用户列表（KEY=VALUE / -NAME 排除 / $VAR 引用，可覆盖自动值）。
 */
function zcodeSpawnEnv(): Record<string, string> {
	return agentSpawnEnv({
		cli: "zcode",
		governance: governanceEnv,
		extId: "aiti-zcode-agent",
		envList: featureString("spawn.env"),
		warn: (m) => console.log(`[aiti-zcode-agent] ${m}`),
	});
}

/** 新会话默认模型 ref：feature 显式配置 > 套餐通道探测（coding-plan-cache，轻量明文）> bigmodel 默认。 */
function seedModelRef(): string {
  const configured = featureString("zcode.model").trim();
  if (configured && parseModelRef(configured)) return configured;
  const plan = detectPlanProvider();
  const providerId = plan ?? DEFAULT_MODEL_REF.split("/")[0];
  const modelId = DEFAULT_MODEL_REF.split("/")[1];
  return `${providerId}/${modelId}`;
}

// ============================================================================
// 任务列表快照（休眠会话兜底：get_state 只对活 handle 有 tasks，handle 空闲 GC /
// 进程重启后打开历史会话时由 core state 路由经 sessionDormantState 服务读这里。
// docs/aiti-zcode-agent-task-list-plan.md §7.5）
// ============================================================================

/** zcode 会话 id 白名单（防路径穿越：文件名只允许 sess_ + 安全字符）。 */
const TASK_SNAPSHOT_SID_RE = /^sess_[A-Za-z0-9._-]+$/;

function taskSnapshotPath(sid: string): string | undefined {
  if (!taskListDir || !TASK_SNAPSHOT_SID_RE.test(sid)) return undefined;
  return join(taskListDir, `${sid}.json`);
}

/** 任务列表快照落盘（每次 task_update 全量覆写；原子写 = tmp + rename，Windows 兼容 §0）。 */
function persistTaskSnapshot(sid: string, todos: TaskEntry[]): void {
  const fp = taskSnapshotPath(sid);
  if (!fp) return;
  try {
    mkdirSync(taskListDir!, { recursive: true });
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sid, todos, updatedAt: Date.now() }));
    renameSync(tmp, fp);
  } catch (e) {
    console.warn("[aiti-zcode-agent] 任务快照落盘失败（不影响实时链路）:", e instanceof Error ? e.message : e);
  }
}

/** 复合会话 id → zcode sid（仅认 zcode: 前缀 / 裸 sess_；new-* 未落库返回 null）。 */
function zcodeSidOf(compositeId: string): string | null {
  if (typeof compositeId !== "string") return null;
  const raw = compositeId.startsWith("zcode:") ? compositeId.slice("zcode:".length) : compositeId;
  return TASK_SNAPSHOT_SID_RE.test(raw) ? raw : null;
}

/**
 * sessionDormantState 服务实现（core state 路由休眠分支消费）：休眠会话最近任务快照。
 * 应答字段与 AgentStateResponse.wire 对齐 = `{tasks}`（区别于 handle 契约 taskList() 的 `{todos}`）；
 * 无数据/非本扩展会话 → null（core 继续扫下一个提供方）。
 */
async function readTaskSnapshot(compositeId: string): Promise<{ tasks: TaskEntry[] } | null> {
  const todos = await readTaskSnapshotTodos(compositeId);
  return todos ? { tasks: todos } : null;
}

/** 快照读取（id 兼容复合/裸 sid；无文件/损坏 → null）。 */
async function readTaskSnapshotTodos(compositeId: string): Promise<TaskEntry[] | null> {
  const sid = zcodeSidOf(compositeId);
  const fp = sid ? taskSnapshotPath(sid) : undefined;
  if (!fp || !existsSync(fp)) return null;
  try {
    const data = JSON.parse(readFileSync(fp, "utf8")) as { todos?: TaskEntry[] };
    return Array.isArray(data.todos) ? data.todos : null;
  } catch {
    return null;
  }
}

// ============================================================================
// ZcodeHandle —— 单发进程 × 轮次模型
// ============================================================================

interface TurnImage { data: string; mimeType: string; filename?: string }

class ZcodeHandle {
  readonly source = "aiti-zcode-agent/zcode";
  /** fork 按通道判定（getter：feature 读取在 startup 捕获后才可用，且每次读实时）。 */
  get capabilities(): SessionCapabilitiesLike {
    return zcodeCapabilities();
  }
  /** 会话工作目录；All Sessions 复活路径会以 zcode 会话存储的 directory 对齐（upsert/resume workspace 一致性依赖此值）。 */
  cwd: string;
  id: string;

  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  /** 真实 zcode 会话 id（sess_xxx；首轮后可知 → 换绑）。 */
  private sessId: string | undefined;
  private lastUsage: Record<string, unknown> | undefined;
  private lastContextTokens: number | null = null;
  /** 当前模型（public：createSession 种子/状态恢复从外部赋值；id = "bigmodel/GLM-5.3" ref）。 */
  model: { id: string; provider: string } | undefined;
  /** 当前轮子进程（abort 用）。 */
  private child: ChildProcess | null = null;
  /** 当前轮取消源（runtime 解析/下载阶段的 abort；每轮新建）。 */
  private turnAbort = new AbortController();
  /**
   * 队列支持（共享层 docs/backend-queue-manager-plan.md §3）：本地 followUp 队列（带图片，
   * R4 闭环）+ steer 镜像 + queueManage 全 action + settle 自动续轮 + steer 失败降级（R9）。
   * dispatch 闭包回 prompt() 全簿记（liveHistory/running/runTurn/scheduleDrain）；
   * steer 闭包走 v4 网关 desktop 同款注入（失败 throw → 共享层降级入队）；oneshot 无 steer →
   * 运行中一律排队（面板可见可撤回）。 */
  private q = createBackendQueueSupport({
    isRunning: () => this.running || !this.aliveFlag,
    alive: () => this.aliveFlag,
    dispatch: (text, images) => this.prompt(text, { images }),
    steer: (text) => this.steerViaAppServer(text),
    onEvent: (ev) => this.emit(ev),
    log: (m) => console.warn(m),
    // 队列崩溃恢复 sidecar（docs/aiti-remote-queue-and-sidecar-plan.md §3）
    persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
  });
  /** steer 镜像 id 跟踪（onSteerQueue 全量快照 diff 出队用；输入本体在共享层镜像里）。 */
  private lastSteerIds: string[] = [];
  /** setPermissionMode 的期望模式（每轮 spawn 的 --mode；下轮生效）。 */
  private desiredMode: string | undefined;

  private liveHistory: unknown[] = [];
  /** liveHistory 的上次「源回填」水位（zcode session.time_updated；0 = 未锚定）。
   *  外部写入（zcode 桌面端/CLI 另起进程写同一会话）水位前进时，getMessages 前从源重读重建。 */
  private historySeedRevMs = 0;
  /** 外部同步单飞锁（并发 getMessages 不重复 parse）。 */
  private historySyncInflight: Promise<void> | null = null;
  /** 最后活动时间戳（epoch ms）：/api/sessions 用它修正侧栏占位行的冻结 modified。 */
  private lastActivityTs: number | null = null;

  private configDir: string;
  /** app-server 长驻会话（feature zcode.transport=app-server 时懒建，跨轮复用）。 */
  private as: AppServerSession | null = null;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride: LaunchOverride | undefined;
  /** 已交给 zcode 服务端的 steer 输入镜像（只读：协议无撤回入口；steerQueued 入 / steerDrained 出）。 */
  private steerMirror: Array<{ pendingInputId: string; input: string }> = [];
  /** 任务列表快照（onTaskList 回调维护；taskList() 契约出口用。⚠ 刻意另名 taskListMirror，避免与同名方法字段撞名互覆）。 */
  private taskListMirror: TaskEntry[] = [];
  /** start-plan 验证码：待前端求解的反向请求（requestId → resolver；appserver 层另有 180s 超时兜底）。 */
  private providerHeadersPending = new Map<string, (answer: { ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }) => void>();
  /** captchaVerifyParam 缓存（providerId → param；TTL 5min——3007 再来即 captcha-retry 重跑 SDK）。 */
  private providerHeadersCache = new Map<string, { param: string; region?: string; at: number }>();
  /** 验证码 SDK 三元组缓存（client/configs 拉取；TTL 1h）。 */
  private captchaConfigCache: { config: { sceneId: string; prefix: string; region: string }; at: number } | null = null;
  /** abort 收口看门狗定时器（app-server 通道；session/stop 后限时未收口强杀兜底）。 */
  private abortWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, cwd: string, configDir: string) {
    this.id = id;
    this.cwd = cwd;
    this.configDir = configDir;
  }

  /** 测试/恢复路径：直接设定真实 sess id（All Sessions 历史行复活）。 */
  setKnownSessionId(sid: string): void {
    this.sessId = sid;
  }

  /**
   * 历史回填（All Sessions 服务出口读取的落点）：IndexedMessage[] → liveHistory 形状。
   * 结构化工具行（IndexedMessage.tool，opencode-family 携带）→ pi 原生形状：
   *   assistant.toolCall 块 + toolResult 消息（按 toolCallId 配对）——前端 MessageView /
   *   ToolCallBlock 按 pi 自家工具卡片渲染（工具名/输入预览/输出折叠），不再退化为 🛠 {json} 文本；
   *   解析失败回退 🛠 文本行（交棒上下文兑底，与 session-manager 导入语义一致）。
   * images → content image block（前端 MessageView 原生渲染）；
   * assistant 消息带 model/provider——原样透传源库 modelID/providerID（不归一不改写），
   * 消息上的模型标签渲染依赖这两字段。
   */
  seedHistory(messages: Array<{ role?: unknown; text?: unknown; model?: unknown; provider?: unknown; images?: Array<{ mime?: unknown; dataUrl?: unknown }> | unknown[]; tool?: unknown }>): void {
    const replay = createSeedToolReplay("zcode-tool");
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      // 结构化工具行优先（callID 缺席时合成稳定 id，仅用于前端结果配对）
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
      const images = Array.isArray(m.images) ? m.images : [];
      if (!text.trim() && images.length === 0) continue;
      const content: Array<Record<string, unknown>> = [];
      if (text.trim()) content.push({ type: "text", text });
      for (const img of images) {
        const dataUrl = typeof img.dataUrl === "string" ? img.dataUrl : "";
        const mMatch = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
        if (!mMatch) continue;
        content.push({ type: "image", source: { type: "base64", media_type: mMatch[1], data: mMatch[2] } });
      }
      // 消息级模型标签（仅 assistant；model/provider 原样透传源库字段，不归一不改写）
      const model = role === "assistant" && typeof m.model === "string" ? m.model : undefined;
      const provider = role === "assistant" && typeof m.provider === "string" ? m.provider : undefined;
      this.liveHistory.push({
        role,
        content,
        ...(model ? { model, ...(provider ? { provider } : {}) } : {}),
      });
    }
  }

  private emit(event: Record<string, unknown>): void {
    // 用户可见活动（消息落定/增量/轮次收口）→ 记录活动时间；控制类事件（queue_update 等）不更新。
    if (event.type === "message_end" || event.type === "message_update" || event.type === "agent_end" || event.type === "agent_settled") {
      this.lastActivityTs = Date.now();
    }
    // 轮次收口 → 清未决验证码请求（expire 帧让各端同步清卡；appserver 层的 180s 超时兜底 resolve）
    if (event.type === "agent_settled" && this.providerHeadersPending.size > 0) {
      for (const [requestId, resolve] of this.providerHeadersPending) {
        resolve({ ok: false, errorMessage: "轮次已收口，验证码请求失效" });
        this.emit({ type: "provider_headers_expired", requestId });
      }
      this.providerHeadersPending.clear();
    }
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧、不得沿流回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-zcode-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 执行一轮（双通道分发，见文件头）：受理即发 agent_start（前端 spinner「等待模型」立刻出现）。
   */
  private async runTurn(promptText: string, images?: TurnImage[]): Promise<string> {
    this.emit({ type: "agent_start" });
    // 契约对齐 pi：prompt 指令受理即发 prompt_done（前端清 pending 标记，spinner 由
    // agent_settled 收尾）。缺失时前端 rpcPromptPending 恒 true → settled 被守卫跳过 →
    // 运行结束 spinner 永挂（2026-09-10 小屏 S6 验收实证）。
    this.emit({ type: "prompt_done" });
    // user 气泡落定（pi 同款 message_end{role:"user"}）：自动续轮无 optimistic 气泡，
    // 手动发送的 optimistic 由前端 userMessageKey 去重（同文本替换不重复）
    this.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          ...(promptText ? [{ type: "text", text: promptText }] : []),
          ...(images ?? []).map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.data },
          })),
        ],
        timestamp: Date.now(),
      },
    });
    // start-plan（ZCode 套餐）拦截：验证码只能桌面端产生、pi-web 不可驱动。当前模型为 start-plan 时
    // 直接人话失败（含恢复的 start-plan 已知会话），不进 app-server 验证码 180s 黑洞 / oneshot 通道。
    // 有 sessId = 已知/已存在会话（restore 复活或首轮后换绑）→ 用「start 加载的已知会话」专用文案。
    const gateRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    if (isStartPlanChannel(gateRef.split("/")[0])) {
      this.turnFailed(this.sessId ? START_PLAN_UNSUPPORTED_KNOWN : START_PLAN_UNSUPPORTED);
      return "error";
    }
    if (featureTransport() === "app-server") {
      try {
        // 图片轮同样走 app-server（v4 attachment begin→chunk→commit + session/send attachments，
        // 桌面端同款；2026-09-17 起 oneshot --attach 分流退役——oneshot 面不认 setModel 的会话模型，
        // 是默认模型漂移/夜间免费窗口漏钱的口子）。
        return await this.runTurnAppServer(promptText, images);
      } catch (e) {
        // 传输层失败（spawn/rpc/进程退出）：abort 引发的中止归为 aborted，其余走 error 帧
        if (this.turnAbort.signal.aborted) {
          this.emit({ type: "agent_end" });
          this.emit({ type: "agent_settled", stopReason: "aborted" });
          return "aborted";
        }
        this.turnFailed(e instanceof Error ? e.message : String(e));
        return "error";
      }
    }
    return this.runTurnOneshot(promptText, images);
  }

  /** runtime + 凭据（双通道共用；各自带缓存；失败抛人话错误）。 */
  private async resolveTurnRuntime(providerId: string): Promise<{
    runtime: Awaited<ReturnType<typeof resolveRuntime>>;
    cred: Awaited<ReturnType<typeof ensureCredential>>;
  }> {
    const log = (msg: string) => console.log(msg);
    let runtime, cred;
    try {
      runtime = await resolveRuntime({
        featurePath: featureRuntimePath(),
        configDir: this.configDir,
        autoDownload: featureAutoDownload(),
        signal: this.turnAbort.signal,
        log,
      });
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    try {
      cred = isStartPlanChannel(providerId)
        // 桌面同款：套餐通道不换 key，直接用凭据库 zcodejwttoken（analysis §9.1）
        ? await ensureStartPlanCredential({ log })
        : await ensureCredential({
          providerId,
          configDir: this.configDir,
          override: featureApiKeyOverride(),
          log,
        });
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    return { runtime, cred };
  }

  /** 附件（图片 → 临时文件；oneshot --attach 通道用）。
   *  返回 cleanup：caller 在本轮收口后调用（加固：曾用 Date.now 目录名且不清理——泄漏 + 同毫秒碰撞）。 */
  private async writeAttachments(images: TurnImage[]): Promise<{ paths: string[]; cleanup: () => void }> {
    const { randomUUID } = await import("node:crypto");
    const { rmSync } = await import("node:fs") as typeof import("node:fs");
    const dir = join(tmpdir(), `zcode-att-${randomUUID()}`);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const attachPaths: string[] = [];
    let i = 0;
    for (const img of images) {
      const ext = img.mimeType.split("/")[1] || "png";
      const p = join(dir, `att-${++i}.${ext}`);
      await writeFile(p, Buffer.from(img.data, "base64"));
      attachPaths.push(p);
    }
    return {
      paths: attachPaths,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不致命 */ } },
    };
  }

  /** 真实会话 id 捕获 → 换绑（session_backend_ready，同 CC 懒持久化模式；双通道共用）。 */
  private rebindSessionId(sid: string): void {
    if (this.sessId === sid) return;
    const oldId = this.id;
    this.sessId = sid;
    this.id = `zcode:${sid}`;
    this.emit({ type: "session_backend_ready", oldId, id: this.id });
    void renameExtModelState("zcode", oldId, this.id).then(() => this.persistModelState());
    // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则换绑前排队的条目崩溃后不可恢复）
    migrateQueueSidecar(queueStateDir, oldId, this.id, (m) => console.warn(m));
  }

  /** app-server 事件出口：liveHistory 记账 + 透传前端。 */
  private onAppServerEvent(ev: Record<string, unknown>): void {
    // D4：交互元语请求（plan 审批/提问卡）写进会话消息流（刷新可回放；决策在 respondInteraction 记录）
    if (ev.type === "interaction_request") {
      this.recordInteractionCustom(ev, "pending");
    }
    if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
      const msg = ev.message as { role?: string; stopReason?: string; content?: unknown; model?: string; errorMessage?: string };
      if (msg.role === "assistant") {
        // 错误帧必须保留 stopReason/errorMessage——前端 getAssistantErrorMessage 靠这两字段
        // 渲染红色错误条；丢失则「空回复、无任何提示」（2026-09-14 用户实测修复）。
        const errText = typeof msg.errorMessage === "string" && msg.errorMessage.trim()
          ? humanizeZcodeError(msg.errorMessage)
          : "";
        this.liveHistory.push({
          role: "assistant",
          content: msg.content ?? [],
          ...(msg.stopReason ? { stopReason: msg.stopReason } : {}),
          ...(errText ? { errorMessage: errText } : {}),
          ...(msg.model ?? this.model?.id ? { model: msg.model ?? this.model?.id } : {}),
          provider: "zcode",
        });
      } else if (msg.role === "toolResult") {
        this.liveHistory.push(ev.message);
      }
    }
    this.emit(ev);
  }

  /** turn.completed → usage。优先真实 provider usage（input/output/cache/total）；
   *  usage 缺席时兜底 totalTokens=tokenCount（引擎投影，2026-09-07 探针实测新会话 ≈ 真值）。 */
  private usageFromTurnOutcome(outcome: TurnOutcome, modelRef: string): Record<string, unknown> {
    const out: Record<string, unknown> = { provider: "zcode", ...(modelRef ? { model: modelRef } : {}) };
    const u = outcome.usage;
    if (u) {
      if (u.inputTokens !== undefined) out.inputTokens = u.inputTokens;
      if (u.outputTokens !== undefined) out.outputTokens = u.outputTokens;
      if (u.cacheReadTokens !== undefined) out.cacheReadTokens = u.cacheReadTokens;
      if (u.cacheWriteTokens !== undefined) out.cacheWriteTokens = u.cacheWriteTokens;
      if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens;
    } else {
      const total = outcome.tokenCount ?? undefined;
      if (total !== undefined) out.totalTokens = total;
      if (outcome.cacheReadTokens != null) out.cacheReadTokens = outcome.cacheReadTokens;
    }
    return Object.keys(out).length > (modelRef ? 2 : 1) ? out : {};
  }

  /** 上下文占用取数（getContextUsage 数据源）：usage.totalTokens（=input+output，引擎
   *  contextUsed 同口径）→ usage.inputTokens(+output) → tokenCount 兜底。
   *  ⚠ tokenCount 在引擎缺 usage baseline 时是 chars/4 字符估算（base64 图片/大文本全计入，
   *  内容重的会话可达数百万）——曾直接拿它算百分比，大会话误显示 100%（2026-09-20 用户实测）。 */
  private contextTokensFromOutcome(outcome: TurnOutcome): number | null {
    const u = outcome.usage;
    if (u?.totalTokens !== undefined) return u.totalTokens;
    if (u?.inputTokens !== undefined) return u.inputTokens + (u.outputTokens ?? 0);
    return outcome.tokenCount ?? null;
  }

  /** 会话累计用量（getUsageTotals 数据源；handle 存活期逐轮累加，重启归零）。 */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };

  /** 轮收口累计记账（真实 usage 优先；oneshot 传入的是宽松 Record，逐字段清洗，缺失/非法按 0 计）。 */
  private accumulateUsage(u: TurnUsageSnapshot | Record<string, unknown> | undefined): void {
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    this.usageTotals.inputTokens += n(u?.inputTokens);
    this.usageTotals.outputTokens += n(u?.outputTokens);
    this.usageTotals.cacheReadTokens += n(u?.cacheReadTokens);
    this.usageTotals.cacheWriteTokens += n(u?.cacheWriteTokens);
    this.usageTotals.turns += 1;
  }

  /** 确保 app-server 常驻通道就绪（按需 spawn + runtime/凭据解析；runTurn 与 fork 共用）。 */
  private async ensureAppServer(): Promise<AppServerSession> {
    if (this.as) return this.as;
    const modelRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    const { providerId } = parseModelRef(modelRef)!;
    const { runtime, cred } = await this.resolveTurnRuntime(providerId);
    // desktop 同款：ZCODE_BASE_URL=平台根 → 引擎拉 configs 读 proxyEndpoint.mapping，
    // 动态路由 provider 直连请求到 ultra 网关 + 在 provider 域握手签名（与桌面完全一致）。
    // 【3.17.2 起默认关】ultra 网关在独立 spawn 下对 api-key 型 personal registry provider
    // 持续 server_error 重试循环（2026-11-07 真机实测；直连 open.bigmodel.cn 全链路通）。
    // feature zcode.ultraGateway=true 可手动回到网关模式（ZCODE_BASE_URL=平台根，做 mapping）。
    const gateway = featureBool("zcode.ultraGateway", false);
    const protoModels = buildZcodeCatalogRefs()
      .filter((m) => m.id.split("/")[0] === providerId)
      .map((m) => ({ modelId: m.id.split("/")[1], label: m.label, contextWindow: ZCODE_CONTEXT_WINDOW }));
    // 3.17+ registry 模型注册：自建 personal provider config（合并桌面配置；providerId 用 wire 形态
    // ——app-server setModel 的 model.providerId 即 wireProviderId（start-plan 带 builtin: 前缀））
    const wireId = wireProviderId(providerId);
    const providerCfgFile = writeProviderConfigFile({
      cacheDir: join(dirname(this.configDir), "cache"),
      providerId: wireId,
      baseURL: gateway ? ZCODE_PLATFORM_BASE_URL : (baseUrlFor(providerId) ?? START_PLAN_BASE_URL),
      apiKey: cred.apiKey,
      models: protoModels,
      defaultModelRef: modelRef,
    });
    const env = buildTurnEnv({
      modelRef,
      providerId,
      apiKey: cred.apiKey,
      appVersion: runtime.appVersion,
      passthroughEnv: zcodeSpawnEnv(),
      runtimeCjsPath: runtime.cjsPath,
      personalProviderConfigFile: providerCfgFile,
      ...(gateway ? { baseURL: ZCODE_PLATFORM_BASE_URL } : {}),
    });
    this.as = new AppServerSession({
      connection: new (await import("./zcode-appserver.ts")).ZcodeAppServerConnection({
        nodeBin: resolveNodeBin(),
        runtimePath: runtime.cjsPath,
        cwd: this.cwd,
        env,
        launchOverride: this.launchOverride,
        log: (m) => console.log(m),
      }),
      cwd: this.cwd,
      mode: this.desiredMode ?? featureMode(),
      // start-plan 协议 ref 带 builtin: 前缀（触发 runtime-headers 反向请求；目录/状态文件仍用裸 id）
      modelRef: `${wireProviderId(providerId)}/${modelRef.split("/")[1] ?? ""}`,
      sessId: this.sessId,
      provider: {
        providerId: wireProviderId(providerId),
        baseURL: baseUrlFor(providerId) ?? (isStartPlanChannel(providerId) ? START_PLAN_BASE_URL : ""),
        apiKey: cred.apiKey,
        models: protoModels.length > 0 ? protoModels : [{ modelId: modelRef.split("/")[1], contextWindow: ZCODE_CONTEXT_WINDOW }],
      },
      onProviderHeadersRequest: (req) => this.solveProviderHeaders(req),
      log: (m) => console.log(m),
      onEvent: (ev) => this.onAppServerEvent(ev),
      onSessionId: (sid) => this.rebindSessionId(sid),
      onSteerQueue: (items) => {
        // 新增条目 → 聊天流落 user 气泡（steer 不走 runTurn；用户需要「已发出/已上屏」的确定感）
        const prevIds = new Set(this.lastSteerIds);
        for (const item of items) {
          if (!prevIds.has(item.pendingInputId)) {
            this.emit({
              type: "message_end",
              message: { role: "user", content: [{ type: "text", text: item.input }], timestamp: Date.now() },
            });
          }
          this.q.registerSteer(item.pendingInputId, item.input); // 共享层镜像（幂等，跳过已知 id）
        }
        this.lastSteerIds = items.map((s) => s.pendingInputId);
        // 全量快照 diff：服务端已消费/丢弃的条目从镜像出队
        this.q.drainSteer([...prevIds].filter((id) => !items.some((s) => s.pendingInputId === id)));
      },
      onTaskList: (todos) => {
        // appserver 层已做变化检测（JSON 对比），这里只透传广播
        this.taskListMirror = todos;
        this.emit({ type: "task_update", todos });
        // 休眠兜底快照（每次更新全量覆写；sessId 未定时跳过——下轮更新会补写）
        if (this.sessId) persistTaskSnapshot(this.sessId, todos);
      },
    });
    return this.as;
  }

  /** app-server 通道：长驻会话（跨轮复用；进程退出后下轮自动 respawn + resume）。 */
  private async runTurnAppServer(promptText: string, images?: TurnImage[]): Promise<string> {
    const modelRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    const as = await this.ensureAppServer();
    // spawn 后检查点：runtime/凭据解析（可能含 300MB 下载）+ spawn 期间已 abort → 安静收尾
    //（进程已起但未发 prompt：闲置复用无害，看门狗强杀路径/下轮 prompt 兜底）
    if (this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    // 全轮次（含图片轮）长驻流式：图片经 v4 attachment 上传后随 session/send 带 attachments
    // （桌面端同款；运行中不会走到这里——prompt() 已分流 v4 steer / 本地队列）
    const outcome = await as.prompt(promptText, images);
    this.lastUsage = this.usageFromTurnOutcome(outcome, modelRef);
    this.lastContextTokens = this.contextTokensFromOutcome(outcome);
    if (!outcome.errorMessage && !outcome.cancelled) this.accumulateUsage(outcome.usage);
    if (outcome.errorMessage) return "error";
    if (outcome.cancelled) return "aborted";
    return "end_turn";
  }

  /** oneshot 通道：每轮单发进程（原有路径，兜底）。 */
  private async runTurnOneshot(promptText: string, images?: TurnImage[]): Promise<string> {
    const modelRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    const { providerId } = parseModelRef(modelRef)!;
    if (isStartPlanChannel(providerId)) {
      // oneshot 无反向请求面（analysis §9.2：3007 直接失败）——套餐通道仅 app-server 传输可适配
      this.turnFailed("ZCode 套餐通道（start-plan）仅支持 app-server 传输通道（oneshot 无验证码反向请求面）。请在 扩展管理器 → aiti-zcode-agent → 功能管理 将 zcode.transport 设为 app-server（缺省即 app-server）。");
      return "error";
    }
    const { runtime, cred } = await this.resolveTurnRuntime(providerId);
    // spawn 前检查点：runtime/凭据阶段（可能含 300MB 下载）中已 abort → 安静收尾
    if (this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    const attach = images?.length ? await this.writeAttachments(images) : { paths: [], cleanup: () => {} };
    const attachPaths = attach.paths;

    const cliArgs = buildCliArgs({ mode: this.desiredMode ?? featureMode(), sessId: this.sessId, prompt: promptText, attachPaths });
    const oneshotModels = buildZcodeCatalogRefs()
      .filter((m) => m.id.split("/")[0] === providerId)
      .map((m) => ({ modelId: m.id.split("/")[1], contextWindow: ZCODE_CONTEXT_WINDOW }));
    const providerCfgFile = writeProviderConfigFile({
      cacheDir: join(dirname(this.configDir), "cache"),
      providerId: wireProviderId(providerId),
      baseURL: baseUrlFor(providerId) ?? START_PLAN_BASE_URL,
      apiKey: cred.apiKey,
      models: oneshotModels,
      defaultModelRef: modelRef,
    });
    const env = buildTurnEnv({
      modelRef,
      providerId,
      apiKey: cred.apiKey,
      appVersion: runtime.appVersion,
      passthroughEnv: zcodeSpawnEnv(),
      runtimeCjsPath: runtime.cjsPath,
      personalProviderConfigFile: providerCfgFile,
    });

    try {
    const outcome = await execZcodeTurn({
      nodeBin: resolveNodeBin(),
      runtimePath: runtime.cjsPath,
      cliArgs,
      cwd: this.cwd,
      env,
      launchOverride: this.launchOverride,
      onChild: (c) => { this.child = c; },
    });
    this.child = null;

    // 用户主动 abort（SIGTERM）：不进错误帧，安静收尾
    if (outcome.killed) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    const parsed = parseTurnOutput(outcome.stdout);
    const ok = outcome.exitCode === 0 && parsed?.response !== undefined;
    if (!ok) {
      if (process.env.AITI_ZCODE_DEBUG_STDERR) console.error("[aiti-zcode-agent][stderr]", outcome.stderrTail);
      const detail = extractCliError(
        outcome.stderrTail,
        `zcode CLI 异常退出（code=${outcome.exitCode}${outcome.signal ? ` signal=${outcome.signal}` : ""}）`,
      );
      this.turnFailed(detail);
      return "error";
    }

    // 真实会话 id：首轮捕获 → 换绑（session_backend_ready，同 CC 懒持久化模式）
    if (parsed?.sessionId) this.rebindSessionId(parsed.sessionId);

    // usage / context
    this.lastUsage = usageToReport(parsed?.usage, modelRef);
    const total = parsed?.usage && typeof parsed.usage.totalTokens === "number" ? parsed.usage.totalTokens : undefined;
    this.lastContextTokens = typeof total === "number" ? total : null;
    this.accumulateUsage(parsed?.usage);

    // 回答（一次性；--json 无增量流）
    const text = parsed?.response ?? "";
    if (text) {
      this.liveHistory.push({ role: "assistant", content: [{ type: "text", text }] });
      this.emit({ type: "message_update", delta: text });
    }
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", stopReason: "end_turn" });
    return "end_turn";
    } finally {
      attach.cleanup();
    }
  }

  /** 错误以 pi 词汇 assistant 消息（stopReason:"error"）送达前端（MessageView 红色 alert），并进 liveHistory。 */
  private turnFailed(errMsg: string): void {
    const humanized = humanizeZcodeError(errMsg);
    const errorMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: humanized,
      ...(this.model?.id ? { model: this.model.id } : {}),
      provider: "zcode",
    };
    this.liveHistory.push(errorMessage);
    this.emit({ type: "message_end", message: errorMessage });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled_error", error: errMsg });
    this.emit({ type: "agent_settled", stopReason: "error", error: errMsg });
  }

  async prompt(text: string, options?: {
    images?: TurnImage[];
    files?: Array<{ data: string; mimeType: string; filename?: string }>;
    /** 运行中排队语义（core 透传）：steer=注入当前轮（原生 steer）；followUp=本地持有 settle 后续轮。缺省=steer（桌面端同款）。 */
    streamingBehavior?: "steer" | "followUp";
  }): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-zcode-agent] session disposed");
    if (this.running) {
      // 分流归共享层：followUp → 本地队列（带图片，可撤回）；steer/缺省 → app-server 原生注入
      //（失败降级入队）；oneshot 无 steer → 自动排队。running 中 routePrompt 不会 dispatch。
      await this.q.routePrompt(text, { images: options?.images, streamingBehavior: options?.streamingBehavior });
      return;
    }
    this.running = true;
    this.liveHistory.push({
      role: "user",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...(options?.images ?? []).map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.data },
        })),
      ],
    });
    this.turnAbort = new AbortController();
    try {
      await this.runTurn(text, options?.images);
    } catch (e) {
      // runtime/凭据/下载层失败：abort 引发的中止归为 aborted，其余走 error 帧（前端可见，不静默）
      if (this.turnAbort.signal.aborted) {
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: "aborted" });
      } else {
        this.turnFailed(e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.running = false;
      this.disarmAbortWatchdog();
    }
    // 排队续轮：微任务让 agent_settled 先到达前端（流式状态复位）再开新一轮（共享层幂等）
    this.q.scheduleDrain();
  }

  /** app-server 原生 steer（共享层 steer 闭包）：运行中经 v4 网关注入当前轮（desktop 同款
   *  sendText{requestedDelivery:"guide"}，下一模型/工具间隙 drain）。失败 throw → 共享层
   *  降级入本地 followUp 队列（R9：消息不丢、不打断原轮、不产生双 settled）。 */
  private async steerViaAppServer(text: string): Promise<void> {
    if (!(featureTransport() === "app-server" && this.as && this.running)) {
      throw new Error("steer unavailable (idle or oneshot transport)");
    }
    this.liveHistory.push({ role: "user", content: text });
    await this.as.steerViaCommand(text);
  }

  /** @capability steer —— 运行中注入当前轮（v4 原生 steer，desktop 同款）；空闲等同普通 prompt。
   *  分流归共享层：oneshot/空闲走 dispatch（=prompt），注入失败降级入本地队列。 */
  async steer(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-zcode-agent] session disposed");
    await this.q.routePrompt(text);
  }

  /** @capability followUp —— 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-zcode-agent] session disposed");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage —— queue keeper 队列操作原语（adapter 队列命令族转发至此）。
   * 全 CRUD 归共享层：followUp 组（本地持有，带图片）move/convert/remove/recall/requeue/clear；
   * steering 组（已交 v4 网关、待间隙 drain）：只读镜像——v4 队列项 id 与 steerQueued 的
   * pendingInputId 尚无映射，撤回/重排暂不支持（stop 取消本轮连带清空）。
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

  /**
   * 任务列表快照（TodoWrite working plan 只读镜像；docs/aiti-zcode-agent-task-list-plan.md）。
   * get_state 真实化数据源（handle-adapter 以方法存在性探测，同 queueManage 范式）；
   * 协议无 todo 写方法 → 只读，无操作原语。
   * 冷 handle 回落：复活未 prompt（镜像未种子）时读持久化快照——打开休眠会话即见列表。
   */
  taskList = async (): Promise<{ todos: TaskEntry[] }> => {
    if (this.taskListMirror.length > 0) return { todos: this.taskListMirror.map((t) => ({ ...t })) };
    const todos = this.sessId ? await readTaskSnapshotTodos(this.sessId) : null;
    return { todos: todos ?? [] };
  };

  /**
   * @capability respondInteraction —— 交互元语回填（zcode ExitPlanMode 审批 / AskUserQuestion 问题）。
   * 寻址 interaction_request 事件里的 requestId；oneshot 通道无反向请求面（fail-loud）。
   */
  /**
   * start-plan 验证码求解插槽（appserver `interaction/requestProviderRuntimeHeaders` 数据源）：
   * 缓存命中（TTL 5min）直接回 param；否则 emit `provider_runtime_headers_request` 到前端
   * （验证卡：无感优先/滑块兜底），等 `respondProviderHeaders` 回填。前端未实现（P2 前）→
   * appserver 层 180s 超时 → {headersApplied:false} → 轮次人话失败。
   */
  private async solveProviderHeaders(req: { requestId: string; providerId: string; modelRef: string; reason: string }): Promise<
    { ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }
  > {
    const cached = this.providerHeadersCache.get(req.providerId);
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      return { ok: true, captchaVerifyParam: cached.param, ...(cached.region ? { region: cached.region } : {}) };
    }
    // SDK 初始化三元组（服务端 client/configs，1h 缓存）——前端验证卡 init 用；取不到直接人话失败
    let captchaConfig: { sceneId: string; prefix: string; region: string } | null = null;
    if (this.captchaConfigCache && Date.now() - this.captchaConfigCache.at < 3600_000) {
      captchaConfig = this.captchaConfigCache.config;
    } else {
      try {
        const cred = await ensureStartPlanCredential({ log: (m) => console.log(m) });
        const cfg = await fetchCaptchaConfig(cred.apiKey);
        if (cfg) {
          captchaConfig = cfg;
          this.captchaConfigCache = { config: cfg, at: Date.now() };
        }
      } catch (e) {
        console.warn("[aiti-zcode-agent] 验证码配置拉取失败:", e instanceof Error ? e.message : e);
      }
    }
    if (!captchaConfig) {
      return { ok: false, errorMessage: "验证码桥未就绪：服务端 captcha 配置（sceneId/prefix/region）不可用" };
    }
    this.emit({
      type: "provider_runtime_headers_request",
      requestId: req.requestId,
      providerId: req.providerId,
      modelRef: req.modelRef,
      reason: req.reason,
      captchaConfig,
    });
    const answer = await new Promise<{ ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }>((resolve) => {
      this.providerHeadersPending.set(req.requestId, resolve);
    });
    this.providerHeadersPending.delete(req.requestId);
    if (answer.ok) {
      this.providerHeadersCache.set(req.providerId, { param: answer.captchaVerifyParam, ...(answer.region ? { region: answer.region } : {}), at: Date.now() });
    }
    return answer;
  }

  /** 验证卡应答入口（@capability respondProviderHeaders；超时/取消传 {error} 或 {cancel:true}）。 */
  async respondProviderHeaders(requestId: string, answer: { captchaVerifyParam?: string; region?: string; error?: string; cancel?: boolean }): Promise<boolean> {
    const resolve = this.providerHeadersPending.get(requestId);
    if (!resolve) return false;
    const param = typeof answer.captchaVerifyParam === "string" ? answer.captchaVerifyParam.trim() : "";
    // 防御：全空 payload（无 cancel/error/有效 param）多半是前端 SDK 回调取值失败（如签名不匹配），
    // 不应解释为用户取消——拒绝命令、保持挂起（180s/收口兜底），留日志便于排查。
    if (!answer.cancel && !answer.error && !param) {
      console.warn(`[aiti-zcode-agent] respond_provider_headers 收到空 payload（requestId=${requestId}）：验证参数缺失，保持挂起等超时/收口`);
      return false;
    }
    if (answer.cancel || (!param && !answer.error)) {
      resolve({ ok: false, errorMessage: answer.error || "用户取消了验证码" });
    } else if (answer.error) {
      resolve({ ok: false, errorMessage: answer.error });
    } else {
      resolve({ ok: true, captchaVerifyParam: param, ...(answer.region ? { region: answer.region } : {}) });
    }
    return true;
  }

  async respondInteraction(requestId: string, answer: {
    action: "accept" | "decline";
    answers?: Record<string, string | string[]>;
    message?: string;
  }): Promise<boolean> {
    if (featureTransport() !== "app-server" || !this.as) {
      throw new Error("[aiti-zcode-agent] 交互回填仅 app-server 通道可用（oneshot 无反向请求面）");
    }
    const ok = await this.as.respondInteraction(requestId, answer);
    // D4：决策写进会话消息流（accept/decline + 答案摘要）
    const pending = this.pendingInteractionMeta.get(requestId);
    this.recordInteractionCustom(
      { requestId, ...(pending ?? {}) },
      answer.action === "accept" ? "accept" : "decline",
      answer,
    );
    this.pendingInteractionMeta.delete(requestId);
    return ok;
  }

  /** 待决交互元数据（interaction_request → 简报），决策记录用（D4）。 */
  private pendingInteractionMeta = new Map<string, { kind?: string; toolName?: string; prompt?: string }>();

  /** 交互请求/决策写进会话消息流（custom 消息；规范 §6 范式 / ACP 样板）。 */
  private recordInteractionCustom(ev: Record<string, unknown>, decision: "pending" | "accept" | "decline", answer?: { answers?: Record<string, string | string[]>; message?: string }): void {
    const kind = String(ev.kind ?? "generic");
    const toolName = typeof ev.toolName === "string" ? ev.toolName : "";
    const title = kind === "plan_approval" ? "方案审批" : kind === "ask_user" ? "提问" : `交互请求${toolName ? `（${toolName}）` : ""}`;
    const label = decision === "pending" ? "等待处理"
      : decision === "accept" ? `已同意${answer?.message ? `（${answer.message}）` : ""}`
        : `⛔ 已拒绝${answer?.message ? `（${answer.message}）` : ""}`;
    const answers = answer?.answers && Object.keys(answer.answers).length
      ? `\n回答: ${JSON.stringify(answer.answers).slice(0, 200)}`
      : "";
    const requestId = String(ev.requestId ?? "");
    let brief = typeof ev.prompt === "string" && ev.prompt ? ` — ${ev.prompt.slice(0, 120)}` : "";
    if (decision === "pending" && requestId) {
      this.pendingInteractionMeta.set(requestId, {
        kind,
        ...(toolName ? { toolName } : {}),
        ...(brief ? { prompt: brief.slice(3) } : {}),
      });
    } else if (decision !== "pending" && !brief) {
      const p = this.pendingInteractionMeta.get(requestId);
      brief = p?.prompt ? ` — ${p.prompt}` : "";
    }
    const message = {
      role: "custom",
      customType: title,
      content: `${title}${brief}\n\n${label}${answers}`,
      display: true,
      details: { requestId, kind, toolName, decision, ...(answer ?? {}) },
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  async abort(): Promise<void> {
    if (!this.running) {
      // 失步兜底：前端运行态与 handle 状态失步（如错误轮 settled 帧竞态丢失）时，
      // 静默 return 会让停止按钮永久悬挂（实测：模型下架 -32031 错误轮后 UI 卡「停止」）。
      // 补发一帧 aborted 收口让前端复位；幂等，真空闲时多一帧无害。
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    console.warn("[aiti-zcode-agent] abort: cancelling current turn");
    // 人工中止标记先行置位：后续看门狗强杀引发的 waiter reject / runTurn 抛错归 aborted（非 error 帧）
    try { this.turnAbort.abort(); } catch { /* already aborted */ }
    // app-server：session/stop（桌面端同款；turn 以 cancelled 收口）。
    // 看门狗先行 + stop fire-and-forget：abort() 立即返回，前端 stop 不再干等 RPC
    //（session/stop 挂死时原最长 15s 超时 + 8s 看门狗 = 23s，实测慢感的主要来源）；
    // 收口靠 turn.completed(cancelled) 自然到达（秒级）或看门狗限时强杀兜底。
    if (featureTransport() === "app-server" && this.as) {
      // 收口看门狗：zcode 端 turn 挂死时协议层 hadActivePrompt 失步、session/stop 是 no-op
      //（实测 2026-09-09：turn 循环卡死后 stop 三连全部无效，用户只能重启整个 pi-web）——
      // 限时未收口即强杀 app-server：进程退出 → onExit → failWaiters → 本轮 aborted 收口；
      // 下轮 prompt 自动 respawn + session/resume（存储 WAL 即时持久化，无损）。
      this.armAbortWatchdog();
      void this.as.stop(); // stop() 内部自带 catch 记日志，此处不再吞错
      return;
    }
    // oneshot：阶段二 SIGTERM 杀本轮子进程
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }

  /** abort 收口看门狗（app-server 通道）：session/stop 后限时未收口 → 强杀连接进程兜底。 */
  private armAbortWatchdog(): void {
    this.disarmAbortWatchdog();
    this.abortWatchdog = setTimeout(() => {
      this.abortWatchdog = null;
      if (!this.running) return; // 已自然收口
      console.warn(`[aiti-zcode-agent] abort 看门狗：session/stop 后 ${ZCODE_ABORT_WATCHDOG_MS / 1000}s 未收口（zcode 端 turn 挂死/失步），强杀 app-server 兜底`);
      try { this.as?.kill(); } catch { /* already dead */ }
    }, ZCODE_ABORT_WATCHDOG_MS);
  }

  private disarmAbortWatchdog(): void {
    if (this.abortWatchdog) {
      clearTimeout(this.abortWatchdog);
      this.abortWatchdog = null;
    }
  }

  /**
   * session/fork 接线（SessionHandle.fork 契约；capability fork=true 才会被调）。
   *
   * entryId = UI 消息列表里分支点消息的位置 id（"ext-N"，与 liveHistory 严格 1:1 对位：
   * get_messages → normalizeHandleMessages 直传 + buildExternalPagedContext 绝对索引）；
   * 分支点 = 被编辑/分叉消息的上一条 assistant 消息。""（或解析不出 user 前缀）= 根重建
   * （编辑首条消息场景）。
   *
   * 两种语义（opts.reset 区分，pi-web handle-adapter 透传）：
   *  - reset（「编辑从此处」）：fork 子会话后 handle 换绑到子会话（rebindSessionId →
   *    session_backend_ready，宿主注册表/站位/队列 sidecar 全链路换绑），就地续跑——
   *    等价 pi 的 navigate_tree 回退。zcode 无 truncate，fork-at-turn 是唯一协议面；
   *    首条消息场景 fork 会带上原消息，故走「丢弃当前 app-server + 下轮全新 create」。
   *  - 非 reset（消息「分支」按钮）：纯 fork，当前会话不动，返回子会话复合 id 供前端跳转。
   *
   * fork-at-turn 目标解析（zcode e8i）：turnIndex 按 user 消息序计数，目标=该轮 assistant
   * 回复；子会话历史含该回复、不含其后消息。已知局限：steer 注入的 user 气泡若服务端
   * 未持久化为独立 user 行，turnIndex 计数会偏移（e8i 解析失败会显式报错，不会静默错位）。
   * 文件回滚：fork 自带 zcode checkpoint 语义（分支点后快照回退），无需 git-trace 门介入。
   */
  async fork(entryId: string, opts?: { reset?: boolean }): Promise<{ cancelled: boolean; newSessionFile?: string }> {
    if (featureTransport() !== "app-server") throw new Error("当前通道不支持分叉/编辑从此处（仅 app-server 常驻传输）");
    if (this.running) throw new Error("运行中不允许分叉（zcode 限制）：请先停止当前轮");
    const reset = opts?.reset === true;

    // 根重建仅认显式空分支点（编辑首条消息，MessageView 无上一条 assistant → leafId=null）。
    // entryId 非空但解析失败/越界 → 显式报错，绝不静默降级根重建（那会丢弃当前视图全部历史）。
    if (reset && entryId === "") {
      await this.resetToForkPoint();
      return { cancelled: false };
    }
    const turnIndex = this.turnIndexForBranchPoint(entryId);
    if (!this.sessId || !this.sessId.startsWith("sess_")) {
      throw new Error("会话尚未建立（真实会话 id 未知），无法分叉");
    }
    if (turnIndex === null) {
      throw new Error(`无法解析分支点位置（entryId=${entryId || "空"}）：消息列表可能已变化，请刷新后重试`);
    }

    const as = await this.ensureAppServer();
    const forkedSid = await as.forkFromTurn(turnIndex);
    if (reset) {
      // 编辑从此处：换绑到子会话 + 历史重建为分支点前缀（fork-at-turn 后子会话即该前缀）
      await this.resetToForkPoint(forkedSid);
      return { cancelled: false, newSessionFile: this.id };
    }
    // 分支按钮：当前会话原样不动；子会话交给前端按复合 id 打开（冷 resume 恢复路径）
    return { cancelled: false, newSessionFile: `zcode:${forkedSid}` };
  }

  /**
   * 就地切换到分支点状态：丢当前 app-server 通道（旧进程里的旧会话已持久化，进程无
   * 保留价值）→ 下轮 prompt 以新 sid resume / 全新 create。历史同步重建：forkedSid
   * 给定 = 从源存储回放子会话（分支点前缀全量）；缺省 = 清空（根重建，等下轮 create）。
   * 注意不能走 syncExternalHistoryIfChanged——锚点清 0 后它首轮只锚定不回放。
   */
  private async resetToForkPoint(forkedSid?: string): Promise<void> {
    if (this.as) {
      try { this.as.kill(); } catch { /* already dead */ }
      this.as = null;
    }
    if (forkedSid) {
      this.rebindSessionId(forkedSid);
    } else {
      // 根重建：清掉真实 sid——下轮 prompt 走 session/create 全新建会话（而非 resume 旧会话），
      // create 返回新 id 时 onSessionId → rebindSessionId 完成换绑。
      this.sessId = undefined;
    }
    this.liveHistory = [];
    this.historySeedRevMs = 0;
    if (forkedSid) {
      try {
        const parsed = await this.parseSessionSvc();
        if (parsed?.messages?.length) {
          this.seedHistory(parsed.messages as never[]);
        }
        const rev = readZcodeSessionUpdatedMs(this.sessId!);
        if (rev !== null) this.historySeedRevMs = rev; // 锚定当前水位（后续外部写入仍可感知）
      } catch { /* 回放失败不阻断 fork（fail-silent，getMessages 时 sync 会再试） */ }
    }
  }

  /**
   * UI 位置 id（"ext-N"）→ zcode turnIndex：统计 liveHistory[0..=N] 里 user 消息数 K，
   * 分支点轮号 = K-1（分支点是某轮的 assistant 回复，该轮的 user 消息计入前缀）。
   * 与 pi-web EXTERNAL_ENTRY_ID_PREFIX（"ext-"）硬约定；解析失败/越界返回 null。
   */
  private turnIndexForBranchPoint(entryId: string): number | null {
    if (typeof entryId !== "string" || !entryId.startsWith("ext-")) return null;
    const idx = Number(entryId.slice(4));
    if (!Number.isInteger(idx) || idx < 0) return null;
    if (idx >= this.liveHistory.length) return null; // 越界（UI 快照晚于 handle 重建）→ 显式报错而非静默错位
    let users = 0;
    for (let i = 0; i <= idx; i++) {
      const m = this.liveHistory[i] as { role?: unknown } | undefined;
      if (m?.role === "user") users++;
    }
    return users > 0 ? users - 1 : null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    this.aliveFlag = false;
    this.disarmAbortWatchdog();
    this.q.dispose();
    this.listeners.clear();
    void this.as?.dispose().catch(() => {});
    this.as = null;
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

  /** 切换模型：app-server 即时生效（session/setModel，桌面端同款）；oneshot 下轮 spawn 生效。id 必须是 "provider/model" ref。 */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    const parsed = parseModelRef(model.id);
    if (!parsed) {
      throw new Error(`[aiti-zcode-agent] 非法模型 ref "${model.id}"（需为 bigmodel/<model> 或 zai/<model>）`);
    }
    // 切到 start-plan → 人话拒绝（验证码只能桌面端产生、pi-web 不可驱动）；从 start-plan 切走不拦。
    if (isStartPlanChannel(parsed.providerId)) {
      throw new Error(START_PLAN_UNSUPPORTED);
    }
    const prev = this.model;
    this.model = { id: model.id, provider: "zcode" };
    this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
    this.persistModelState();
    if (this.as) {
      const parsed = parseModelRef(model.id);
      await this.as.setModel(`${wireProviderId(parsed?.providerId ?? "")}/${parsed?.modelId ?? ""}`).catch((e) =>
        console.warn("[aiti-zcode-agent] setModel 即时生效失败（不阻塞切换，下轮重试）:", e instanceof Error ? e.message : e));
    }
    return true;
  }

  /**
   * 切换权限模式：app-server 即时生效（session/setMode，桌面端同款）；oneshot 存 desiredMode 下轮 spawn 生效。
   * UI 标准五档 → zcode mode 映射：default→build、acceptEdits→edit、bypassPermissions→yolo；dontAsk 无对应档 fail-loud。
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    const MODE_MAP: Record<string, typeof ZCODE_MODES[number]> = {
      default: "build",
      acceptEdits: "edit",
      plan: "plan",
      bypassPermissions: "yolo",
    };
    const zcodeMode = MODE_MAP[mode];
    if (!zcodeMode) {
      throw new Error(`[aiti-zcode-agent] 非法权限模式 "${mode}"（可选：${Object.keys(MODE_MAP).join("/")}；dontAsk 无对应档）`);
    }
    this.desiredMode = zcodeMode;
    if (this.as) {
      await this.as.setMode(zcodeMode).catch((e) =>
        console.warn("[aiti-zcode-agent] setMode 即时生效失败（不阻塞切换，下轮重试）:", e instanceof Error ? e.message : e));
    }
    return true;
  }

  async getAvailableModels(): Promise<ExtModelEntry[]> {
    return zcodeCatalog(this.model);
  }

  /** 临时模型状态文件（启动/切换/换绑时写：selected + 目录快照）。 */
  persistModelState(): void {
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: "zcode",
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
    const tokens = this.lastContextTokens;
    return {
      // 无值/零值 → percent null（前端显示「?」空轨）——绝不拿缺失数据编 100%
      percent: tokens !== null && tokens > 0 ? Math.min(100, (tokens / ZCODE_CONTEXT_WINDOW) * 100) : null,
      contextWindow: ZCODE_CONTEXT_WINDOW,
      tokens,
    };
  }

  /** @capability getUsageTotals —— 会话累计用量（宿主 get_session_stats 真实口径）。
   *  此前未实现：统计面板 Token 区恒显 0/0/0（宿主兜底），与 context 行自相矛盾。 */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  /** All Sessions 服务出口读取（唯一权威实现 = session-manager AgentAdapter 实时 parse）。
   *  与 createZcodeSession 复活回放共用同一出口；缺席 fail-silent。 */
  private parseSessionSvc(): Promise<{ meta?: Record<string, unknown>; messages?: unknown[] } | null> {
    if (!this.sessId) return Promise.resolve(null);
    const reg = (globalThis as any).__piWebExt;
    const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
    return typeof svc?.parseSession === "function" ? svc.parseSession(`zcode:${this.sessId}`) : Promise.resolve(null);
  }

  /** getMessages 前置的「外部写入感知」（2026-09-15 用户实测「点击会话不加载最新内容」）。
   *
   * 根因：openExternalSession 对存活 handle 直接复用（不重建），get_messages 返回的是
   * handle 内存 liveHistory——它只含 handle 建立时刻的源快照 + 本 handle 自己驱动的轮次；
   * zcode 桌面端/CLI 在 handle 存活期间往同一会话写入的新消息不会推给本 handle
   * （不同 app-server 进程、无共享订阅），于是复用打开时消息停在旧位置（列表却实时）。
   *
   * 修法：handle 空闲时探测源 db 会话 time_updated（一次轻量 WAL 只读 SELECT），
   * 水位超过上次回填锚点 → 经 session-manager 服务出口从源重读全量历史重建 liveHistory。
   * 运行中跳过（实时流在推，重建会打断 streaming）；水位不变零开销；读失败 fail-silent。 */
  private async syncExternalHistoryIfChanged(): Promise<void> {
    if (this.running || !this.sessId || !this.sessId.startsWith("sess_")) return;
    if (this.historySyncInflight) { await this.historySyncInflight; return; }
    const task = (async () => {
      try {
        const rev = readZcodeSessionUpdatedMs(this.sessId!);
        if (rev === null) return; // db 不可读（缺存储/写锁瞬间）→ 跳过，下轮再试
        if (this.historySeedRevMs === 0) { this.historySeedRevMs = rev; return; } // 首轮锚定（handle 建立时 seed 的即当时最新）
        if (rev <= this.historySeedRevMs) return; // 无外部推进
        const parsed = await this.parseSessionSvc();
        if (parsed?.messages?.length) {
          this.liveHistory = [];
          this.seedHistory(parsed.messages as never[]);
        }
        this.historySeedRevMs = rev;
      } catch { /* fail-silent：读失败不动 liveHistory */ }
    })();
    this.historySyncInflight = task;
    try { await task; } finally { if (this.historySyncInflight === task) this.historySyncInflight = null; }
  }

  /** 内存对话日志（本 handle 生命周期内的全部轮次；返回前先补外部写入同步，见
   *  syncExternalHistoryIfChanged——保证「点击会话」读到的是源库最新而非 handle 旧快照）。 */
  async getMessages(): Promise<unknown[]> {
    await this.syncExternalHistoryIfChanged();
    return [...this.liveHistory];
  }

  /** 最后活动时间（epoch ms；无活动返回 undefined）。供 /api/sessions 修正占位行 modified。 */
  getLastActivity(): number | undefined {
    return this.lastActivityTs ?? undefined;
  }
}

// ============================================================================
// Extension entry
// ============================================================================

let counter = 0;
/** 受控登录 API（startup 里挂载；/login/* 命中返回 Response，其余 null 放行）。 */
let loginApi: ((req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) => Promise<Response | null>) | null = null;
/** 受控登录控制器引用（shutdown 时终止进行中的登录进程）。 */
let loginCtl: { dispose(): void } | null = null;

/**
 * 会话 recycle API（2026-09-10）：把存量 handle 升级到当前扩展代码，无需重启 pi-web 进程。
 *
 * 背景：扩展热重载只换模块，core handle store（globalThis.__sessionHandles）里已存在的
 * handle 实例继续跑老代码——部署新逻辑后老会话不生效（steer v4 化时实测咬人）。
 *
 *   GET  /session/recycle               → 存量 zcode 会话清单（id/running/alive）
 *   POST /session/recycle {id, force?}  → 空闲校验（运行中需 force:true，会打断当前轮）
 *       → dispose 旧 handle → 自 fetch POST /api/session-backends（loopback 恒过门禁）
 *       → core 复活分支建新 handle（当前代码）→ putHandle 覆盖 + watcher/站位全接线。
 *   new- 占位会话（无真实 sid）仅 dispose——前端下次访问按需重建全新会话。
 */
type RecycleHandleLike = { id: string; isRunning(): boolean; alive(): boolean; dispose(): unknown; cwd?: string };

function recycleSelfBase(req: Request): string {
  // 服务端绑定 127.0.0.1（unit ExecStart --hostname 127.0.0.1）；端口在 argv（--port），
  // 不在 env。请求本身来自 loopback 时直接用其 origin；经 nginx 域名来的回退 argv 解析。
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
      .filter((h) => h.id.startsWith("zcode:"))
      .map((h) => ({ id: h.id, running: h.isRunning(), alive: h.alive() }));
    return Response.json({ sessions });
  }
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  let body: { id?: unknown; force?: unknown } = {};
  try { body = await req.json() as typeof body; } catch { /* 空体按缺省 */ }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id.startsWith("zcode:")) return Response.json({ error: "id 必须是 zcode: 复合 id" }, { status: 400 });
  const old = store?.get(id);
  if (!old) return Response.json({ error: `无存活的 handle：${id}` }, { status: 404 });
  if (old.isRunning() && !body.force) {
    return Response.json(
      { error: "会话正在运行中——等本轮收口后重试；确认要打断请带 force:true（当前轮作废，已排队 steer/队列随之清空）", running: true },
      { status: 409 },
    );
  }
  const realSid = id.startsWith("zcode:sess_") ? id.slice("zcode:".length) : "";
  const cwd = typeof (old as { cwd?: string }).cwd === "string" ? (old as { cwd?: string }).cwd : "";
  try { await old.dispose(); } catch { /* 已死容错 */ }
  if (!realSid) {
    return Response.json({ recycled: true, recreated: false, id, note: "占位会话已释放（未发过消息的空会话），前端下次访问按需重建" });
  }
  const base = recycleSelfBase(req);
  try {
    const res = await fetch(`${base}/api/session-backends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerType: "aiti-zcode-agent/zcode", sessionId: realSid, ...(cwd ? { cwd } : {}) }),
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

/** 套餐状态缓存（60s；force=1 绕过；本地文件读取，失败 10s 退避）。 */
let quotaCache: { at: number; ttl: number; value: Record<string, unknown> } | null = null;
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 10_000;

/** GET /login/quota[?force=1] → 统一额度视图（套餐通道状态；数据源 coding-plan-cache.json）。 */
function quotaView(force: boolean): Response {
  if (!force && quotaCache && Date.now() - quotaCache.at < quotaCache.ttl) return Response.json(quotaCache.value);
  const v = planQuotaView(readPlanStatus());
  quotaCache = { at: Date.now(), ttl: v.available === true ? QUOTA_TTL_MS : QUOTA_ERROR_TTL_MS, value: v };
  return Response.json(v);
}

export default {
  id: "aiti-zcode-agent",
  name: "ZCode CLI",
  version: "0.1.0",
  icon: "🟢",
  // 受控登录统一弹窗（零构建原生 h() client；client/ 下两文件随 deploy 拷贝）
  // 静态插入点声明（与 client registerItems 的 id 一一对应）
  // 登录 UI 已统一到 aiti-agent-manager（受控登录弹窗退役，2026-09-13）：不再声明 ui ——
  // 服务端 /login/* 与 .agent 描述符保留（manager 代理消费）。
  // client（2026-09-16 起）：sessionRequestCard 插槽的 provider_headers 验证码卡——
  // 「agent 扩展自带专属能力 UI」（去核化方案 docs/pi-web-agent-capability-ui-ext-plan.md §3.2）。
  client: "dist/aiti-zcode-cards.mjs",

  features: [
    {
      id: "zcode.transport",
      type: "string" as const,
      label: "传输通道",
      group: "ZCode CLI",
      description: "app-server = 长驻 ZCode Protocol（桌面端同款：流式打字机/工具卡/原生 steer/热切模型，省每轮 ~5-6s 冷启动）；oneshot = 每轮单发进程（旧路径兜底）。留空默认 app-server。",
      value: "app-server",
      placeholder: "app-server | oneshot",
    },
    {
      id: "zcode.runtimePath",
      type: "string" as const,
      label: "Runtime 路径",
      group: "ZCode CLI",
      description: "指定 ZCode runtime：zcode.cjs 文件、解压目录、或 ZCode-*.AppImage 本体。留空则自动探测（Windows 安装目录 / 挂载实例 / ~/.zcode）→ 自动下载。",
      placeholder: "/home/me/.zcode/ZCode-3.11.2-linux-x64.AppImage",
    },
    {
      id: "zcode.autoDownload",
      type: "boolean" as const,
      label: "自动下载 AppImage",
      group: "ZCode CLI",
      description: "探测不到 runtime 时从官网自动下载（约 300MB，缓存在扩展数据目录；Windows 已装则直接用安装目录）。",
      default: true,
    },
    {
      id: "zcode.mode",
      type: "string" as const,
      label: "权限模式",
      group: "ZCode CLI",
      description: "每轮 spawn 的 --mode：build（工具调用询问）/ edit（自动允许文件编辑）/ plan（只读规划）/ yolo（跳过全部权限询问，最大权限）。默认 yolo（2026-09-06 应用户要求由 build 改）。",
      value: "yolo",
      placeholder: "yolo",
    },
    {
      id: "zcode.model",
      type: "string" as const,
      label: "默认模型 ref",
      group: "ZCode CLI",
      description: "新会话默认模型（provider/model，如 bigmodel/GLM-5.3）。留空自动跟随已认证的套餐通道（bigmodel/zai）。",
      value: "",
      placeholder: "留空自动跟随套餐通道",
    },
    {
      id: "zcode.apiKeyOverride",
      type: "string" as const,
      label: "API Key 手动覆盖",
      group: "ZCode CLI",
      description: "手动提供编程套餐 API Key（跳过桌面端凭据 OAuth 链路）。一般留空。",
      value: "",
      placeholder: "留空使用桌面端登录凭据",
    },
    {
      id: "zcode.ultraGateway",
      type: "boolean" as const,
      label: "Ultra 网关路由",
      group: "ZCode CLI",
      description: "app-server 走 zcode.z.ai 平台根动态路由（桌面端同款）。注意：宿主对未声明布尔 feature 默认 true——本项必须显式声明才可控。3.17.2 独立 spawn 下网关持续 server_error（2026-11-07 实测），默认直连 open.bigmodel.cn。",
      default: false,
    },
    spawnEnvFeature("ZCode CLI"),
    spawnCommandFeature("ZCode CLI"),
    spawnArgsPrefixFeature("ZCode CLI"),
  ],

  server: {
    startup(ctx: {
      configDir: string;
      features?: { get(extIdOrFid?: string, fid?: string): boolean | string | undefined };
      services?: { get(key: string): unknown; provide<T>(key: string, impl: T): () => void };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
          }): Promise<ZcodeHandle>;
        }): string;
      };
    }) {
      hostFeatures = (ctx as any)?.features ?? null;
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      hostSvc = (ctx as any)?.services ?? null; // DI 方案 P1
      try { mkdirSync(ctx.configDir, { recursive: true }); } catch { /* exists */ }
      const configDir = ctx.configDir;
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json；docs/aiti-remote-queue-and-sidecar-plan.md §3）
      queueStateDir = (ctx as { stateDir?: string }).stateDir ?? join(configDir, "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // 任务列表快照根 + 休眠兜底服务（core state 路由休眠分支通用扫描消费；服务注册失败不阻断启动）
      taskListDir = join(queueStateDir, "task-lists");
      try { mkdirSync(taskListDir, { recursive: true }); } catch { /* exists */ }
      try {
        (ctx as { services?: { provide?: (key: string, impl: unknown) => unknown } }).services?.provide?.(
          "aiti-zcode-agent.sessionDormantState",
          readTaskSnapshot,
        );
      } catch { /* 服务面缺席（如单测桩）→ 休眠兜底降级为无数据 */ }
      // lazy migrate（数据分层双保险）：旧根级 runtime//apps/（AppImage 与解压运行时，可再下载）→ cache/
      // 三目录对称：configDir = <extRoot>/config，旧根级/缓存均在 <extRoot> 下 = dirname(configDir)
      const extRoot = dirname(configDir);
      for (const rel of ["runtime", "apps"]) {
        const from = join(extRoot, rel), to = join(extRoot, "cache", rel);
        try { if (existsSync(from) && !existsSync(to)) { mkdirSync(join(to, ".."), { recursive: true }); renameSync(from, to); } } catch { /* 下次重试 */ }
      }
      // 受控登录（工具条 🔑）：spawn 官方 `login --no-browser --json`，URL 交前端，
      // 凭据落盘/换 key 全官方；成功后预热 ensureCredential（login 只落 z.ai 通道 token）
      const login = createControlledLogin({
        driver: zcodeLoginDriver,
        configDir,
        resolveRuntime: async () => {
          const runtime = await resolveRuntime({
            featurePath: featureRuntimePath(),
            configDir,
            autoDownload: featureAutoDownload(),
            log: (m) => console.log(m),
          });
          return runtime.cjsPath;
        },
        onSuccess: () => {
          void ensureCredential({ providerId: "zai", configDir, override: featureApiKeyOverride(), log: (m) => console.log(m) })
            .catch((e) => console.warn("[aiti-zcode-agent] 登录成功但换 key 预热失败（下轮 ensureCredential 会重试）:", e instanceof Error ? e.message : e));
        },
        log: (m) => console.log(`[aiti-zcode-agent] ${m}`),
      });
      loginApi = mountControlledLoginApi(login);
      loginCtl = login;
      // createSession 主体（provider 与 P2 launch 服务共用：复活/种子模型/状态文件全链路一致）
      const createZcodeSession = async (
        options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } },
        launchOverride?: LaunchOverride,
      ): Promise<ZcodeHandle> => {
          const rawSid = options.sessionId ?? "";
          // All Sessions 历史行复活：composite id "zcode:sess_xxx" → sid 即真实 zcode 会话 id
          const isRealSid = rawSid.startsWith("sess_");
          const id = rawSid ? `zcode:${rawSid}` : `zcode:new-${++counter}-${Date.now()}`;

          // ★ 复活路径先读 zcode 会话存储：cwd 必须以会话原 directory 为准——
          //   upsert/resume 的 workspace 与会话原 workspace 不一致会导致
          //   provider 注入无效 + restoreWarning(-32031) 拒 send（实测）。
          //   URL ?session= 恢复路径的 options.cwd 常为空 → 不能落 process.cwd()。
          let restoredParsed: { meta?: { cwd?: string; model?: string }; messages?: unknown[] } | null = null;
          const parseSessionSvc = (): Promise<{ meta?: { cwd?: string; model?: string }; messages?: unknown[] } | null> => {
            const reg = (globalThis as any).__piWebExt;
            const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
            return typeof svc?.parseSession === "function" ? svc.parseSession(`zcode:${rawSid}`) : Promise.resolve(null);
          };
          if (isRealSid) {
            try {
              restoredParsed = await parseSessionSvc();
            } catch { /* 回放失败不阻断接管（fail-silent） */ }
          }
          const restoredCwd = typeof restoredParsed?.meta?.cwd === "string" && restoredParsed.meta.cwd.trim() ? restoredParsed.meta.cwd : "";
          const handle = new ZcodeHandle(id, restoredCwd || options.cwd || process.cwd(), configDir);
          handle.launchOverride = launchOverride;

          // 种子模型：显式指定 > 同会话状态恢复（用户上次在本会话切过，通道校验）> 会话回放真实模型
          // > 该 agent 上次使用（per-agent last used）> feature/套餐通道默认（优先级递减）
          const planChannel = detectPlanProvider(); // null = 探测不出（仅日志展示用；校验统一走模块级 channelUsable）
          if (typeof options.model?.id === "string" && options.model.id && parseModelRef(options.model.id)) {
            // 显式选择 start-plan → 人话拒绝（验证码只能桌面端产生、pi-web 不可驱动）；
            // 不静默回落——用户点击即应被告知，而非无感换模型。
            if (isStartPlanChannel(options.model.id.split("/")[0])) {
              throw new Error(START_PLAN_UNSUPPORTED);
            }
            handle.model = { id: options.model.id, provider: "zcode" };
          } else if (options.sessionId) {
            const restored = await readExtModelState("zcode", `zcode:${options.sessionId}`);
            if (restored?.selected?.id && parseModelRef(restored.selected.id)) {
              const pid = restored.selected.id.split("/")[0];
              if (channelUsable(pid)) {
                handle.model = { id: restored.selected.id, provider: "zcode" };
              } else {
                console.log(`[aiti-zcode-agent] 状态文件模型 ${restored.selected.id} 通道不可用/无凭据，回落默认（已认证通道: ${planChannel ?? "未知"}）`);
              }
            }
          }
          if (isRealSid) {
            handle.setKnownSessionId(rawSid);
            // 历史回放（cwd 已在上方读取）
            if (restoredParsed) {
              if (restoredParsed.messages?.length) handle.seedHistory(restoredParsed.messages as never[]);
              // 会话真实模型恢复（CC 同款 restore 语义：初始化不广播，选择器直接展示）：
              // 最近一条 assistant 的 provider/model ref；仅在无更优先来源时生效。
              // start-plan 会话照常恢复原模型（用户感知其为「start 加载的已知会话」，发消息时人话拦截）；
              // 其余死通道（套餐失效的 coding-plan 等）走 channelUsable 通道级校验回落 last-used/默认，
              // 避免种出 429/1113 死模型（2026-09-15 收紧）。
              if (!handle.model && typeof restoredParsed.meta?.model === "string" && parseModelRef(restoredParsed.meta.model)) {
                const pid = restoredParsed.meta.model.split("/")[0];
                if (isStartPlanChannel(pid) || channelUsable(pid)) {
                  handle.model = { id: restoredParsed.meta.model, provider: "zcode" };
                }
              }
            }
          }
          if (!handle.model) {
            const lastUsed = await lastUsedModelRef();
            if (lastUsed) handle.model = lastUsed;
          }
          if (!handle.model) handle.model = { id: seedModelRef(), provider: "zcode" };
          handle.persistModelState();
          return handle;
      };
      const lastKey = ctx.sessionProviders.register({
        type: "zcode",
        label: "ZCode CLI (智谱)",
        agentKey: "zcode",
        maxCapabilities: zcodeCapabilities(),
        // 静态目录（新建页选后端时供选择器；无会话即可取）——上次使用的模型置顶，
        // 前端默认选中它（列表首项），新建会话即默认该 agent 上次使用的模型。
        listModels: async () => zcodeCatalog(await lastUsedModelRef()),
        createSession: (options) => createZcodeSession(options),
      });
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用——manager 不写死各家
      ctx.services?.provide?.("aiti-zcode-agent.agent", {
        agent: "zcode",
        label: "ZCode CLI (智谱)",
        modes: ["url"],
        accountQuota: true, // 套餐通道状态（GET /login/quota；官方无额度数值接口）
        dependencyHint: "ZCode 桌面端 / zcode.cjs runtime",
        auth: [
          { kind: "file", path: [".zcode", "v2", "credentials.json"], label: "~/.zcode/v2/credentials.json" },
          { kind: "env", path: ["ZCODE_API_KEY"], label: "env ZCODE_API_KEY" },
        ],
        accountSlots: (c: { home: string }) => [
          { key: "zcode-credentials", label: "桌面端凭据（加密）", path: join(c.home, ".zcode", "v2", "credentials.json") },
        ],
      });
      // P2 协议委托：launch 服务（provider 同链路：复活/种子模型/状态文件）
      ctx.services?.provide?.("aiti-zcode-agent.launch", {
        agentKey: "zcode",
        capabilities: zcodeCapabilities(),
        createSessionFromLaunch: (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }) =>
          createZcodeSession(options, launch),
      });
      console.log(`[aiti-zcode-agent] registered: ${lastKey} (configDir: ${configDir})`);
    },

    /** 受控登录 API（/login/*）+ 会话 recycle（/session/recycle，存量 handle 升级到当前代码）。 */
    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const recycled = await recycleApi(req, ctx);
      if (recycled) return recycled;
      // 账号额度视图（套餐通道状态；无官方额度数值接口）
      // 注意：必须在受控登录层之前——controlled-login 对未知 /login/* 返回 404 Response 会吞路由
      if (ctx.path[0] === "login" && ctx.path[1] === "quota" && ctx.method === "GET") {
        return quotaView(ctx.searchParams?.get("force") === "1");
      }
      const loginRes = loginApi ? await loginApi(req, ctx) : null;
      if (loginRes) return loginRes;
      return null;
    },

    /** 扩展停卸/reload：终止进行中的登录进程（状态文件留档，下次 status reconcile 为 failed）。 */
    shutdown() {
      loginCtl?.dispose();
      loginCtl = null;
      loginApi = null;
    },
  },
};
