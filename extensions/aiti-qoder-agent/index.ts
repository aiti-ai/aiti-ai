/**
 * aiti-qoder-agent — 会话后端扩展：Qoder CLI 专属驱动 + 账号 credits。
 *
 * qodercli/qoderclicn 是 claude-code 协议族成员（stream-json 双向、system/init、
 * assistant/result 帧、total_credits 字段），驱动层与 aiti-claude-code-agent 同构；
 * 本扩展**独占** qoder 两个成员（CC 族清单里不再注册），额外提供：
 *
 *   1. getUsage         — 账号 credits/配额（OpenAPI /api/v2/quota/usage）
 *   2. listModels       — 模型目录（infer 网关 /api/v2/model/list?Encode=1，WASM 签名请求）
 *
 * 认证（逆向结论，见 docs/qodercli-auth-api-analysis.md）：
 *   - 凭据存于 ~/.qoder{,-cn}/.auth/user（WASM 加密）；qoder_auth.wasm 从
 *     qoderclicn 二进制提取，运行时解密出 dt- token / encrypt_user_info / key。
 *   - quota REST 只需 Bearer dt-token；模型目录需 COSY 签名头（WASM QoderContext 构造）。
 *   - 推理走 CLI 子进程（stream-json），认证由 CLI 自理。
 *
 * 区域：cn = qoderclicn + gateway.qoder.com.cn；intl = qodercli + api2-v2.qoder.sh。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentSpawnEnv, spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, type QoderClient } from "./qoder-core.mjs";
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";
import {
  readExtModelState, readAgentLastUsedModel, readPiModels, renameExtModelState, writeExtModelState,
  mergeModelCatalogs, withCurrentFirst, withLastUsedFirst, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";
// 受控登录共享层 + 家驱动（权威源 pi-web-ext/_shared/，副本随扩展部署——改动须双向同步）
import { createControlledLogin, mountControlledLoginApi } from "@aiti-ai/ext-shared/controlled-login";
// 队列共享实现层（权威源 pi-web-ext/_shared/backend-queue.ts）：运行中输入入本地 followUp
// 队列（面板实时 queue_update、可撤回、settle 后自动续轮）——与 claude-code 后端同款。
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar, type BackendQueue } from "@aiti-ai/ext-shared/backend-queue";
// 任务列表（TodoWrite working plan 只读镜像）派生语义共享层（权威源 _shared/task-list.ts）
import { createTaskListMirror, type TaskEntry } from "@aiti-ai/ext-shared/task-list";
// 会话「需用户应答的请求」统一语义共享层（权威源 _shared/agent-interaction.ts）：
// kind 裁决 + pending 账本（sidecar 落盘/重建重发）+ 答案→CC 线协议换算。
import {
  createInteractionLedger, deriveAskKind, toControlResponse,
  type InteractionAnswer, type InteractionRecord,
} from "@aiti-ai/ext-shared/agent-interaction";
// 冷恢复工具行回放共享口径（权威源 _shared/seed-tool.ts；D18 四家归一，含空结果占位文案）
import { createSeedToolReplay, EMPTY_TOOL_ERROR, EMPTY_TOOL_OUTPUT } from "@aiti-ai/ext-shared/seed-tool";
import { qoderLoginBin, resolveQoderCli, qoderLoginDriver, type QoderVariant } from "./login-driver.ts";
import { QODER_VARIANTS, qoderVariant, type QoderVariantInfo } from "./variants.ts";
// steer 能力探针门控（纯函数层）：运行中注入只在「该 CLI 二进制探针 pass」时开放，见 steer-gate.ts
import {
  describeSteerGate, parseSteerProbeBook, steerEvidenceStale, steerProbePassed, steerProbePath, withSteerGate,
  type SteerProbeBook,
} from "./steer-gate.ts";

let hostSvc: any = null; // DI 方案 P1：startup 捕获 ctx.services（session-manager.sessions 消费）
/** 受控登录 API（startup 里挂载；/login/* 命中返回 Response，其余 null 放行）。 */
let loginApi: ((req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) => Promise<Response | null>) | null = null;
/** 受控登录控制器引用（shutdown 时终止进行中的登录进程）。 */
let loginCtl: { dispose(): void } | null = null;
/** 队列 sidecar 根（<stateDir>/queues/<sessionId>.json；startup 赋值，见 backend-queue 共享层）。 */
let queueStateDir: string | undefined;
/** 任务快照根（<stateDir>/task-lists/<sid>.json；休眠会话兜底，startup 赋值）。 */
let taskListDir: string | undefined;
/** 未决应答 sidecar 根（<stateDir>/interactions/<sid>.json；刷新/重建后重发卡片，startup 赋值）。 */
let interactionDir: string | undefined;
/**
 * steer 探针账本（`<stateDir>/steer-probe.json` 的解析结果；startup 读一次）。
 * 空 = 无证据 = 所有 CLI 的 steer 保持 false（fail-closed，见 steer-gate.ts）。
 */
let steerProbeBook: SteerProbeBook = {};

/** 换入探针账本（startup 读取 / 单测注入都用它；改完新会话即生效，无需重启宿主）。 */
export function applySteerProbeBook(book: SteerProbeBook): void {
  steerProbeBook = book;
}

/**
 * 读探针账本（小文件同步读；缺文件/坏 JSON → 空账本，绝不因脏数据放开能力）。
 * 只在 startup 跑一次（进程启动前无从知道 CLI 是否被探针验过，句柄创建要同步判定）。
 */
export function loadSteerProbeBook(stateDir: string): SteerProbeBook {
  let text: string | null = null;
  try {
    text = readFileSync(steerProbePath(stateDir), "utf8");
  } catch {
    text = null; // 从未跑过探针 = 正常态
  }
  const book = parseSteerProbeBook(text);
  applySteerProbeBook(book);
  return book;
}

/** 某个 CLI 二进制的实际能力表（基表 + 探针门控的 steer）。 */
function qoderCapabilitiesFor(cliPath: string | null | undefined): SessionCapabilitiesLike {
  return withSteerGate(QODER_CAPABILITIES, steerProbePassed(steerProbeBook, cliPath));
}

/**
 * 外部会话读取（复合 id → { meta, messages }）：唯一权威实现 = session-manager 的
 * AgentAdapter 体系，本扩展不重写各家存储读取。双轨（DI 方案 P1）：ctx.services 优先、
 * byId 穿透兜底；服务缺席/解析失败 → null（fail-silent）。
 * ⚠ 必须调用时动态解析：startup 顺序不保证 session-manager 已注册。
 */
async function parseExternalSession(
  compositeId: string,
): Promise<{ meta?: Record<string, unknown>; messages?: unknown[] } | null> {
  try {
    const reg = (globalThis as { __piWebExt?: { byId?(id: string): { ext?: { services?: Record<string, unknown> } } } }).__piWebExt;
    const svc = (hostSvc?.get?.("session-manager.sessions")
      ?? reg?.byId?.("session-manager")?.ext?.services?.sessions) as
      { parseSession?(id: string): Promise<{ meta?: Record<string, unknown>; messages?: unknown[] } | null> } | undefined;
    if (typeof svc?.parseSession !== "function") return null;
    return (await svc.parseSession(compositeId)) ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// 结构化契约 + 工具（out-of-tree，无宿主导入）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

/** 按 \n 切行的字节级 reader（跨 chunk 多字节字符安全）。⚠ 导出仅为单测可达（qoder-hardening）。 */
export function lineReader(
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
    // 溢出闸门必须真的可达（原实现在循环里 return，下面的检查是死代码）：
    // 单行超阈值 = CLI 吐了不该吐的东西（二进制/日志混进 stdout），无限累积会吃满内存
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

/** 工具入参单行摘要（授权卡用；优选 command/path/url 等关键字段，超长截断）。 */
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > 120 ? `${input.slice(0, 120)}…` : input;
  try {
    const rec = input as Record<string, unknown>;
    const preferred = ["reason", "command", "path", "file_path", "url", "pattern", "query", "description"]
      .filter((k) => typeof rec[k] === "string" && rec[k])
      .map((k) => `${k}=${String(rec[k])}`);
    // ExitPlanMode 只带 allowedPrompts（方案正文在 plan 文件里）——不摊平就是满屏 JSON
    if (Array.isArray(rec.allowedPrompts) && rec.allowedPrompts.length) {
      const items = (rec.allowedPrompts as unknown[]).map((p) => {
        const o = p as { prompt?: unknown; tool?: unknown };
        return typeof o?.prompt === "string" ? `${o.prompt}(${typeof o.tool === "string" ? o.tool : "?"})` : JSON.stringify(p);
      });
      preferred.push(`allowedPrompts=${items.join(" ")}`);
    }
    const s = preferred.length ? preferred.join(" ") : JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return "";
  }
}

/**
 * 占位会话 id 标记：`<prefix>:new-<uuid>`（收到 system/init 前无从得知真实 sid）。
 * recycle 与 id 换绑都以此判「从没真正建立过的空会话」。
 */
const PLACEHOLDER_MARK = "new-";
function isPlaceholderSid(sid: string): boolean {
  return sid.startsWith(PLACEHOLDER_MARK);
}

/**
 * 队列 sidecar 文件名（与共享层 sidecarFileName 同规则；那一行规则就地实现，不导入——
 * 该导出还没发布，已部署实例里的 ext-shared 没有它，调了就是 undefined is not a function）。
 * ⚠ 冒号在 NTFS 是 ADS 流分隔符：`qoder:new-x.json` 会被写成基名 `qoder` + 匿名流，
 *   多会话互相踩踏，且 sidecar 目录的 >7 天 prune 会连带删掉基名文件（=全部会话队列）。
 * ⚠ 导出仅为单测钉死该规则。
 */
export function sidecarBase(id: string): string {
  return `${process.platform === "win32" ? id.replace(/:/g, "_") : id}.json`;
}

/**
 * sidecar 随 id 换绑迁移（共享层 backend-queue）。缺导出时降级为不迁移（只丢占位 id
 * 窗口的崩溃恢复）——部署实例的 @aiti-ai/ext-shared 可能是旧版且 jiti 模块缓存不随扩展
 * reload 更新（同本文件 localQuotaFromUsage 记的教训），届时直接调用会抛 TypeError，
 * 而这是在 stdout data 回调里抛 = 打挂宿主进程，不是降级。
 */
function migrateSidecar(fromId: string, toId: string): void {
  if (typeof migrateQueueSidecar === "function") {
    migrateQueueSidecar(queueStateDir, fromId, toId, (m) => console.warn(`[aiti-qoder-agent] ${m}`));
  }
}

// ----------------------------------------------------------------------------
// 任务列表快照（休眠会话兜底，aiti-zcode-agent 同配方）：get_state 只对活 handle 有
// tasks；handle 空闲 GC / 进程重启后打开历史会话时，core state 路由经
// <extId>.sessionDormantState 服务读这里的最近快照。派生语义本身在共享层 task-list。
// ----------------------------------------------------------------------------

/** 快照文件名白名单（防路径穿越；qoder sid 为 uuid 形态，容字母数字与 - . _）。 */
const TASK_SNAPSHOT_SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** 复合 id → 裸 sid：**只认本扩展前缀**（qoder:/qodercn:）或无前缀裸 id；占位 id（new-*）→ null。 */
function realSidOf(compositeId: string): string | null {
  if (typeof compositeId !== "string") return null;
  let raw = compositeId;
  for (const prefix of ["qodercn:", "qoder:"]) {
    if (compositeId.startsWith(prefix)) {
      raw = compositeId.slice(prefix.length);
      break;
    }
  }
  if (raw.includes(":")) return null; // 其他后端的复合 id（pi:/claude:…）不认领
  return raw && !isPlaceholderSid(raw) && TASK_SNAPSHOT_SID_RE.test(raw) ? raw : null;
}

function taskSnapshotPath(sid: string): string | undefined {
  return taskListDir && TASK_SNAPSHOT_SID_RE.test(sid) ? join(taskListDir, `${sid}.json`) : undefined;
}

/** 任务快照落盘（每次 task_update 全量覆写；原子写 = tmp + rename，Windows 兼容 §0）。 */
function persistTaskSnapshot(compositeId: string, todos: TaskEntry[]): void {
  const sid = realSidOf(compositeId);
  const fp = sid ? taskSnapshotPath(sid) : undefined;
  if (!fp) return;
  try {
    mkdirSync(taskListDir!, { recursive: true });
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sid, todos, updatedAt: Date.now() }));
    renameSync(tmp, fp);
  } catch (e) {
    console.warn("[aiti-qoder-agent] 任务快照落盘失败（不影响实时链路）:", e instanceof Error ? e.message : e);
  }
}

async function readTaskSnapshotTodos(compositeId: string): Promise<TaskEntry[] | null> {
  const sid = realSidOf(compositeId);
  const fp = sid ? taskSnapshotPath(sid) : undefined;
  if (!fp || !existsSync(fp)) return null;
  try {
    const data = JSON.parse(readFileSync(fp, "utf8")) as { todos?: TaskEntry[] };
    return Array.isArray(data.todos) ? data.todos : null;
  } catch {
    return null;
  }
}

/**
 * sessionDormantState 服务实现（core state 路由休眠分支消费）：应答字段与
 * AgentStateResponse.wire 对齐 = `{tasks}`（handle 契约 taskList() 才是 `{todos}`）；
 * 无数据/非本扩展会话 → null（core 继续扫下一个提供方）。
 */
async function readTaskSnapshot(compositeId: string): Promise<{ tasks: TaskEntry[] } | null> {
  const todos = await readTaskSnapshotTodos(compositeId);
  return todos ? { tasks: todos } : null;
}

/**
 * 冷恢复 cwd（同 aiti-claude-code-agent 2026-09-16 修复）：resume 时 options.cwd 常缺省，
 * 落 process.cwd() = pi-web 服务端目录 → qodercli 在 ~/.qoder{,-cn}/projects/<cwd-encoded>/
 * 下找不到该会话的 jsonl（CC 族按目录分片存储），--resume 直接起不来或开成空会话。
 * 经 session-manager（qoder 存储的唯一权威）取 meta.cwd；读不到/服务缺席 → null 走旧兜底。
 */
async function restoredCwdFor(sessionId?: string): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const reg = (globalThis as any).__piWebExt;
    const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
    if (typeof svc?.parseSession !== "function") return null;
    const parsed = await svc.parseSession(`qoder:${sessionId}`);
    const cwd = typeof parsed?.meta?.cwd === "string" ? parsed.meta.cwd.trim() : "";
    return cwd || null;
  } catch {
    return null;
  }
}

/**
 * 计费系数（price_factor，服务端目录下发）→ 选择器行右侧弱化文本（"0.5x"）。
 * 尾零裁剪对齐 CLI 截图观感（0.5→"0.5x"、1→"1x"）；非有限数一律无 hint（不编数据）。
 * original_price_factor 更高（限时降价）时附原价："0.1x→0.5x"（现价→原价，locale 中立）。
 */
function priceFactorHint(m: { price_factor?: unknown; original_price_factor?: unknown }): string | undefined {
  const f = typeof m.price_factor === "number" && Number.isFinite(m.price_factor) ? m.price_factor : null;
  if (f === null) return undefined;
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  const orig = typeof m.original_price_factor === "number" && Number.isFinite(m.original_price_factor) && m.original_price_factor > f
    ? m.original_price_factor
    : null;
  return orig !== null ? `${trim(f)}x→${trim(orig)}x` : `${trim(f)}x`;
}

/**
 * 模型目录核心（handle 方法与注册级静态 listModels 共用）：
 * 网关目录（WASM 签名拉取，client 可为 null——未就绪时静默降级为仅 pi 目录）
 * + pi 目录（models.json 实时扁平化，"pi" 分组）。当前模型置顶。
 */
async function qoderCatalog(client: QoderClient | null, current?: { id: string; provider: string }): Promise<ExtModelEntry[]> {
  const external: ExtModelEntry[] = [];
  if (client) {
    try {
      for (const m of await client.listModels()) {
        if (m.enable === false) continue;
        const hint = priceFactorHint(m);
        external.push({ id: m.key, provider: "qoder", label: m.display_name || m.key, source: "ext", ...(hint ? { hint } : {}) });
      }
    } catch (e) {
      console.warn("[aiti-qoder-agent] listModels failed:", e instanceof Error ? e.message : e);
    }
  }
  const piModels = await readPiModels();
  return withCurrentFirst(
    mergeModelCatalogs(external, piModels),
    current,
  );
}

/**
 * 目录内解析模型引用：id 精确命中优先，其次 label（大小写不敏感）。
 * qodercli 帧里回报的是 display_name（"Qwen3.8-Flash"）而不是目录 key（"qfmodel"），
 * 任何「按 id 比对目录」的逻辑都要先过这里，否则恒不命中。
 */
export function resolveCatalogEntry(
  models: ExtModelEntry[],
  ref?: { id: string } | null,
): ExtModelEntry | null {
  if (!ref?.id) return null;
  return models.find((m) => m.id === ref.id)
    ?? models.find((m) => typeof m.label === "string" && m.label.toLowerCase() === ref.id.toLowerCase())
    ?? null;
}

/**
 * 新建页静态目录：把「上次使用的模型」置顶（宿主前端取 list[0] 当默认项）。
 * 存量状态可能存的是 CLI display_name（老版本直接落 trackModel 的原始值），先按目录
 * 归一成 key 再前移，否则恒不命中 → 默认永远落回目录首行（qoder 是 auto）。
 */
export async function qoderStaticCatalog(
  client: QoderClient | null,
  stateKey: string,
): Promise<ExtModelEntry[]> {
  const base = await qoderCatalog(client);
  const lastUsed = await readAgentLastUsedModel(stateKey);
  return withLastUsedFirst(base, resolveCatalogEntry(base, lastUsed)?.id ?? lastUsed?.id);
}

/**
 * qoder 模型族上下文窗口（getContextUsage 换算用）：qmodel_* 等自研命名窗口未
 * 公开——未命中返回 undefined（空轨态，不编数字）；claude/gpt 系转发名可判。
 */
export function qoderContextWindow(modelId?: string): number | undefined {
  if (typeof modelId !== "string" || !modelId) return undefined;
  const m = modelId.toLowerCase();
  if (m.includes("gpt-5")) return 272_000;
  if (m.includes("gpt-4")) return 128_000;
  if (m.includes("claude")) return m.includes("[1m]") ? 1_000_000 : 200_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined; // qmodel_* 等自研模型不猜
}

/**
 * 基能力表（**不是**最终值：`steer` 由探针门控逐 CLI 覆盖，见 qoderCapabilitiesFor）。
 */
const QODER_CAPABILITIES: SessionCapabilitiesLike = {
  // 基线关。qodercli 的 headless stream-json **有**注入面：入站 user 帧带 `priority`
  // （MessageQueue 三档 now(0)/next(1)/later(2)），AgentLoop 在 inter_turn 附件采集时取
  // **rank ≤ next** 的条目当轮吸收（`attachment.type==="queued_command"` + midTurn 包装，
  // 消费回 `command_lifecycle state:"started"`，1.1.44 取证）。注意 `now` 会额外触发 headless
  // 抢占（本轮被打断另起一轮），不是 steer。但同族 codebuddy 有吞输入前科、且注入被丢没有
  // 显式错误——所以只在「该版本二进制的实跑探针 pass」时点亮（steer-gate.ts + tools/steer-probe.mjs）。
  steer: false,
  // backend-queue 共享层本地队列（D2 债清）：运行中输入不具备注入条件时**不写 stdin**
  // → 入队、queue_update 上面板、result 收口后自动续轮（空闲 dispatch，等价于验证过「第二轮正常受理」）。
  followUp: true,
  queueManage: true, // 共享层全 CRUD（followUp 组；steer 组只读——注入后归 CLI 自己的队列管）
  getMessages: true,
  // 上下文占比：qodercli 的 assistant usage 里确实带 `context_usage_ratio`（本机 jsonl 实测），
  // 但宿主后端会话链路没有出口——handle-adapter get_state 不吐 contextUsage 字段，
  // 前端只在 `state.contextUsage !== undefined` 时采纳（useAgentSession:1083）。
  // 声明了也没有消费方（zcode 的 contextUsage:true 同样悬空），等宿主补线再接。
  contextUsage: false,
  // 2026-08 对 qodercli 1.1.17 取证：CC 族 control_request 支持 subtype "set_model"
  setModel: true,
  setThinkingLevel: false,
  fork: false,
  renameSession: false,
  compact: false,
  executeBash: false,
  listTools: true,
  setActiveTools: false,
  navigateTree: false,
  deleteSession: false,
  getCommands: true,
  // CC 族 control_request/can_use_tool 双向（ask 应答通道）：⚠ bypass_permissions **不**等于
  // 「不再询问」——requiresUserInteraction 类工具（EnterPlanMode/ExitPlanMode/AskUserQuestion）
  // 照样发 can_use_tool（1.1.56 实测）。宿主不应答 = CLI 无超时永久等（本机事故会话挂 5 小时）。
  // 统一契约 interaction_request/respondInteraction（kind 驱动卡片；答案回填 updatedInput）。
  respondInteraction: true,
  // ---- 招牌能力 ----
  getUsage: true,
  listModels: true,
  fileAttachments: false,
  // 2026-09-19 探针实测：control_request/set_permission_mode 接受 default/acceptEdits/
  // dontAsk/bypassPermissions/auto **以及 plan**（plan 是独立的 planStateManager 开关，
  // 与权限档并存；只与 dontAsk 互斥），进出各发一帧 system/plan_mode_changed。
  // 旧记载「qodercli 无 plan 档」是在 bypass 档下没应答测出的假结论。运行时生效（长驻进程）。
  setPermissionMode: true,
  // TodoWrite working plan 只读镜像（共享层 task-list 从工具事件派生；协议无 todo 事件）。
  // 宿主 get_state.tasks = h.taskList?.() —— 方法存在性探测，capability 名必须等于方法名。
  taskList: true,
};

// ============================================================================
// UsageReport 组装（对齐 pi-web lib/session/types.ts UsageReport）
// ============================================================================

type QuotaBucketShape = { total?: number; cap?: number; used?: number; remaining?: number; percentage?: number; unit?: string };

type QoderQuotaResponse = {
  user_quota?: QuotaBucketShape;
  userQuota?: QuotaBucketShape;
  add_on_quota?: QuotaBucketShape;
  addOnQuota?: QuotaBucketShape;
  org_resource_package?: QuotaBucketShape;
  orgResourcePackage?: QuotaBucketShape;
  total_remaining?: number;
  totalRemaining?: number;
  total_usage_percentage?: number;
  totalUsagePercentage?: number;
  is_quota_exceeded?: boolean;
  isQuotaExceeded?: boolean;
  quota_exhausted?: boolean;
  expires_at?: number;
  expiresAt?: number;
  unit?: string;
  plan_name?: string;
  plan_tier_name?: string;
  user_type?: string;
  userType?: string;
};

function bucket(name: string, b?: QuotaBucketShape): { name: string; total?: number; used?: number; remaining?: number; usedPercent?: number } {
  const total = b?.total ?? b?.cap;
  const pct = typeof b?.percentage === "number"
    ? (b.percentage <= 1 ? Math.round(b.percentage * 100) : Math.round(b.percentage))
    : typeof total === "number" && typeof b?.used === "number" && total > 0
      ? Math.round((b.used / total) * 100)
      : undefined;
  return {
    name,
    ...(total !== undefined ? { total } : {}),
    ...(b?.used !== undefined ? { used: b.used } : {}),
    ...(b?.remaining !== undefined ? { remaining: b.remaining } : {}),
    ...(pct !== undefined ? { usedPercent: pct } : {}),
  };
}

/** 查询账号 credits/配额（经 WASM 解密凭据 → Bearer REST；fail-loud）。 */
export async function fetchQoderUsage(client: QoderClient): Promise<{
  provider: string;
  plan?: string;
  buckets: Array<{ name: string; total?: number; used?: number; remaining?: number; usedPercent?: number }>;
  credits?: { remaining?: number; used?: number; usedPercent?: number; unit?: string; expiresAt?: number };
  quotaExceeded?: boolean;
}> {
  const d = (await client.quotaUsage()) as QoderQuotaResponse;

  const buckets: Array<{ name: string; total?: number; used?: number; remaining?: number; usedPercent?: number }> = [];
  const uq = d.user_quota ?? d.userQuota;
  const aq = d.add_on_quota ?? d.addOnQuota;
  const op = d.org_resource_package ?? d.orgResourcePackage;
  if (uq) buckets.push(bucket("user_quota", uq));
  if (aq) buckets.push(bucket("add_on_quota", aq));
  if (op) buckets.push(bucket("org_resource_package", op));

  // API 无 total_remaining 字段时，合并所有配额桶的 remaining（基础 + 扩展包 + 组织包）
  let totalRemaining = d.total_remaining ?? d.totalRemaining;
  if (totalRemaining === undefined) {
    const defined = buckets.filter((b) => b.remaining !== undefined);
    if (defined.length) totalRemaining = defined.reduce((s, b) => s + (b.remaining ?? 0), 0);
  }
  const unit = d.unit ?? uq?.unit ?? aq?.unit ?? op?.unit;
  const expiresAt = d.expires_at ?? d.expiresAt;
  const exceeded = d.is_quota_exceeded ?? d.isQuotaExceeded ?? d.quota_exhausted;
  const totalUsagePct = d.total_usage_percentage ?? d.totalUsagePercentage;
  const usedPct = typeof totalUsagePct === "number"
    ? (totalUsagePct <= 1 ? Math.round(totalUsagePct * 100) : Math.round(totalUsagePct))
    : undefined;
  return {
    provider: client.region.name === "cn" ? "qoder-cn" : "qoder",
    ...(d.plan_tier_name || d.plan_name || d.user_type || d.userType ? { plan: d.plan_tier_name ?? d.plan_name ?? d.user_type ?? d.userType } : {}),
    buckets,
    credits: {
      ...(totalRemaining !== undefined ? { remaining: totalRemaining } : {}),
      ...(unit ? { unit } : {}),
      ...(expiresAt ? { expiresAt: expiresAt > 1e12 ? expiresAt : expiresAt * 1000 } : {}),
      ...(usedPct !== undefined ? { usedPercent: usedPct } : {}),
    },
    ...(exceeded ? { quotaExceeded: true } : {}),
  };
}

/** 入站 user 帧 content 块（空闲 prompt 与运行中注入同一份构造，避免两处漂移）。 */
function buildUserContent(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const img of images ?? []) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
  }
  if (text || content.length === 0) content.push({ type: "text", text });
  return content;
}

// ============================================================================
// QoderHandle —— 驱动 qodercli/qoderclicn（协议同 claude-code 族）
// ============================================================================

/** 导出仅供单测直接驱动（宿主 loader 只消费 default 导出）。 */
export class QoderHandle {
  source: string;
  /** 探针门控后的能力表（构造时按 cliPath 定；steer 只在实跑 pass 的版本上为 true）。 */
  readonly capabilities: SessionCapabilitiesLike;
  /** 本会话 CLI 二进制路径（steer 门控键；版本化文件名，升级即失配 → 需重跑探针）。 */
  readonly cliPath: string;
  id: string;
  readonly cwd: string;
  readonly variant: "intl" | "cn";

  private child: ChildProcess;
  /** WASM 客户端（异步预热；就绪前 getUsage/getAvailableModels 静默降级）。 */
  private client: QoderClient | null;
  private detachReader: (() => void) | null = null;
  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  private model: { id: string; provider: string } | undefined;
  /** 最近一轮 usage（result 帧机会式提取；部分版本恒缺） */
  private lastUsage: {
    model?: string; inputTokens?: number; outputTokens?: number;
    cacheReadTokens?: number; cacheWriteTokens?: number;
  } | undefined;
  /** 会话累计用量（有 usage 帧才累加；getUsageTotals 数据源） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  /** control_request 序号 + 待决 set_model 响应关联 */
  private seq = 0;
  private controlWaiters = new Map<string, (ok: boolean) => void>();
  /** abort 的 control_request 关联（request_id → resolver；2026-09-06 实测 qodercli 支持同构中断） */
  private interruptWaiters: Array<(ok: boolean) => void> = [];
  /** 直播期工具调用账本：toolCallId → 工具/入参（user 帧 tool_result 回填 toolName，方案 X） */
  private toolCallOpen = new Map<string, { name: string; input: unknown }>();
  /**
   * 未决应答账本（共享层 agent-interaction）：can_use_tool 进、respondInteraction 出。
   * 键集即「仍在等待应答的请求」——result 帧收口 / markDead 时逐个 interaction_expired
   * 解锁前端；sidecar 落盘 + subscribe 重发解决「刷新/重建后卡片没了、CLI 还在等」。
   * ⚠ field 初始化器早于 ctor body（此刻 id 还是占位值）→ sidecar 路径惰性取 this.id。
   */
  private interactions = createInteractionLedger({
    emit: (e) => this.emit(e as unknown as Record<string, unknown>),
    sidecarFile: () => (interactionDir && realSidOf(this.id) ? join(interactionDir, sidecarBase(this.id)) : undefined),
    record: (n) => this.recordInteractionCustom(n),
  });
  /**
   * 流式块账本（三线显示：text / thinking）：上游 content_block 序号 → 本气泡 contentIndex。
   * tool_use 块不进表（工具卡走 assistant 帧方案 X），故本地序号自增连续、无空洞。
   */
  private blockMap = new Map<number, number>();
  private blockAcc = new Map<number, { kind: "text" | "thinking"; text: string }>();
  private blockSeq = 0;
  /**
   * init 帧快照（CC 族 system/init 免费携带）：tools = 本轮可用工具名，
   * commands = slash_commands（前端斜杠面板），permissionMode = CLI 自报当前档。
   * init 可能重复发（同 codebuddy 实测）→ 直接覆盖为最近一轮。
   */
  private tools: Array<{ name: string; description: string }> = [];
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  private permissionMode: string | undefined;
  /** plan 态（planStateManager；与权限档并存，只与 dontAsk 互斥）——由 plan_mode_changed 帧驱动。 */
  private planActive = false;

  private resetStream(): void {
    this.blockMap.clear();
    this.blockAcc.clear();
    this.blockSeq = 0;
  }

  /**
   * 队列支持（共享层 backend-queue）：运行中输入的两种归宿，按 steer 门控分流——
   * 探针 pass（steerOn）→ 注 stdin（CLI 自己的消息队列，工具间隙消费，面板走 steer 镜像）；
   * 否则 → 入本地 followUp 队列（queue_update 上前端面板、可撤回，result 收口后 scheduleDrain 自动续轮）。
   * ⚠ 必须构造后建：`steer` 钩子的有无取决于探针门控，而门控要等 ctor 拿到 cliPath。
   * ⚠ field 初始化器早于 ctor body：id 此刻还是占位值，故 sidecar 路径惰性取 this.id。
   */
  private queueSupport: BackendQueue;
  get q(): BackendQueue {
    return this.queueSupport;
  }

  /** 本会话是否开放运行中注入（探针门控结果，构造时定）。 */
  private readonly steerOn: boolean;
  /**
   * 已写 stdin、尚未被 CLI 认领的注入（uuid → 文本）。认领信号是事件而非轮询：
   * CLI 消费时回显 `user`（isReplay，uuid=我们写的）或发 `command_lifecycle{command_uuid}`，
   * 两条都没等到就在本轮 result 处收口。只用于「插队组条目从面板搬进消息流」，不做投递等待。
   */
  private steerPending = new Map<string, string>();
  /** 探针证据版本 vs CLI 自报版本的校验只做一次（每会话一条日志够了）。 */
  private steerVersionChecked = false;

  /**
   * 任务列表镜像（TodoWrite working plan，共享层 task-list）：协议没有 todo 事件，
   * 只能从工具调用入参/结果派生。变更 → task_update 上面板 + 快照落盘（休眠会话兜底）。
   * ⚠ field 初始化器早于 ctor body，回调只在后续 onLine 里触发，取 this.id 时已定。
   */
  private tasks = createTaskListMirror((todos) => {
    this.emit({ type: "task_update", todos });
    persistTaskSnapshot(this.id, todos);
  });

  constructor(
    id: string,
    child: ChildProcess,
    client: QoderClient | null,
    cwd = "",
    variant: "intl" | "cn" = "cn",
    cliPath = "",
  ) {
    this.id = id;
    this.child = child;
    this.client = client;
    this.cwd = cwd;
    this.variant = variant;
    this.source = `aiti-qoder-agent/${qoderVariant(variant).type}`;
    this.cliPath = cliPath;
    this.steerOn = steerProbePassed(steerProbeBook, cliPath);
    this.capabilities = withSteerGate(QODER_CAPABILITIES, this.steerOn);
    this.queueSupport = createBackendQueueSupport({
      isRunning: () => this.running || !this.aliveFlag,
      alive: () => this.aliveFlag,
      dispatch: (text, images) => this.prompt(text, images?.length ? { images: images as never } : {}),
      onEvent: (ev) => this.emit(ev),
      log: (m) => console.warn(`[aiti-qoder-agent] ${m}`),
      // 探针未 pass 的 CLI 不挂 steer 钩子：运行中输入一律本地排队（共享层不过滤，
      // 挂了钩子就会注入——能力位与行为必须同一把门）。
      ...(this.steerOn ? { steer: (text, images) => this.steerInject(text, images) } : {}),
      persistence: createQueueFilePersistence(
        () => (queueStateDir ? join(queueStateDir, "queues", sidecarBase(this.id)) : undefined),
        (m) => console.warn(m),
      ),
    });
    this.detachReader = lineReader(child.stdout, (line) => this.onLine(line), {
      onOverflow: (size) => this.markDead(`stdout line overflow (${size} bytes)`),
    });
    // 三个流必须挂 error 监听（加固 A2）：ECONNRESET/EPIPE 无监听器会崩宿主进程。
    child.stdout?.on("error", (err) => this.markDead(`stdout error: ${err.message}`));
    child.stderr?.on("error", (err) => console.log(`[aiti-qoder-agent] stderr error: ${err.message}`));
    child.stdin?.on("error", (err) => console.log(`[aiti-qoder-agent] stdin error: ${err.message}`));
    child.stderr?.on("data", (c: Buffer | string) => {
      const text = String(c).trim();
      if (text) console.log(`[aiti-qoder-agent] ${text.slice(0, 300)}`);
    });
    child.once("exit", (code) => {
      this.running = false;
      this.markDead(`process exited (${code ?? "signal"})`);
    });
    child.once("error", (err) => this.markDead(`process error: ${err.message}`));
    // 未决应答随会话恢复（上次进程被硬杀、没走到 markDead 收口的残留）：
    // 只读盘不发卡，卡片由 subscribe 时定向 replay 投递
    this.interactions.load();
  }

  private markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.detachReader?.();
    this.detachReader = null;
    for (const w of this.interruptWaiters.splice(0)) w(false);
    // 未决 control 往返一并落定（waiter 自带 clearTimeout）
    for (const w of this.controlWaiters.values()) w(false);
    this.controlWaiters.clear();
    // 未决应答随进程一起作废：必须通知前端解锁（否则批准对话框挂在死会话上）
    this.interactions.failPending("dead");
    // 流式/工具账本清零：进程已死，未闭合的块与未配对的 tool_use 不再有未来（Map 留着是泄漏）
    this.toolCallOpen.clear();
    this.steerPending.clear(); // 进程已死：注入帧不可能再被认领，账本留着是泄漏
    this.resetStream();
    this.q.dispose(); // 队列清空 + 停未决续轮（进程死了队列没有未来）
    this.emit({ type: "session_backend_dead", reason });
  }

  private emit(event: Record<string, unknown>): void {
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧、不得沿流回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-qoder-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 会话消息流记录（custom 消息，规范 §6 范式 / ACP 样板）：liveHistory 恒记录（刷新可回放），
   * 同时发 message_end 直播卡。
   */
  private pushOrEmitCustom(opts: { customType: string; content: string; details?: unknown }): void {
    const message = {
      role: "custom",
      customType: opts.customType,
      content: opts.content,
      display: true,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  /** 会话请求/决策写进消息流（规范 §6：ask 有卡有记录；allow 静默放行也留痕）。 */
  private recordInteractionCustom(note: InteractionRecord): void {
    const label = note.decision === "pending" ? "⏳ 等待应答"
      : note.decision === "allow" ? `✅ 已允许${note.note ? `（${note.note}）` : ""}`
        : note.decision === "deny" ? `⛔ 已拒绝${note.note ? `（${note.note}）` : ""}`
          : "🚫 已取消（回合结束）";
    const title = note.kind === "ask_user" ? "提问" : note.kind === "plan_approval" ? "方案审批" : note.toolName || "tool";
    const inputStr = summarizeToolInput(note.input);
    this.pushOrEmitCustom({
      customType: "🔐 会话请求",
      content: `${title}${inputStr ? ` — ${inputStr}` : ""}\n\n${label}`,
      details: { requestId: note.requestId, kind: note.kind, toolName: note.toolName, input: note.input, decision: note.decision },
    });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const type = String(msg.type ?? "");

    if (type === "system" && msg.subtype === "init") {
      const sid = String(msg.session_id ?? "");
      const { agentKey, stateKey } = qoderVariant(this.variant);
      if (sid && !this.id.includes(sid)) {
        const oldId = this.id;
        this.id = `${agentKey}:${sid}`;
        this.emit({ type: "session_backend_ready", oldId, id: this.id });
        // 状态文件跟随换绑（模型选择持久化到真实 sid 名下）
        renameExtModelState(stateKey, oldId, this.id).then(() => this.persistModelState());
        // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则 init 前排队的条目崩溃后不可恢复）
        migrateSidecar(oldId, this.id);
      }
      const m = typeof msg.model === "string" ? msg.model : undefined;
      if (m) this.trackModel(m, "restore");
      // init 帧顺带把本轮能力面快照捡回来（工具/斜杠命令/权限档）——之前声明了
      // listTools/getCommands 却恒返 []（宿主面板空白）。
      if (Array.isArray(msg.tools)) {
        this.tools = (msg.tools as unknown[]).map((name) => ({ name: String(name), description: "" }));
      }
      if (Array.isArray(msg.slash_commands)) {
        this.commands = (msg.slash_commands as unknown[]).map((name) => ({ name: String(name), source: "skill" }));
      }
      if (typeof msg.permissionMode === "string" && msg.permissionMode) {
        this.permissionMode = msg.permissionMode;
      }
      // 门控开着但 CLI 自报版本与探针记录不符 = 证据属于别的二进制（符号链接被升级
      // 重指向）→ 只告警不收回：能力表已随会话创建发布给宿主，中途改会让前端按钮与
      // 后端行为不一致。重跑探针即可纠正（新会话生效）。
      if (this.steerOn && !this.steerVersionChecked) {
        this.steerVersionChecked = true;
        const stale = steerEvidenceStale(steerProbeBook, this.cliPath, String(msg.qodercli_version ?? ""));
        if (stale) console.warn(`[aiti-qoder-agent] ${stale}`);
      }
      this.emit({ type: "agent_start", sessionId: this.id, model: this.model });
      return;
    }

    if (type === "control_request" && String((msg.request as Record<string, unknown>)?.subtype ?? "") === "can_use_tool") {
      // 需应答请求（CC 族 control_request）：记账 + 广播卡片（kind 决定前端渲哪张卡）+
      // 消息流留痕。无人应答时由 result/markDead 终结；刷新/重连后由 subscribe 重发。
      const reqId = String(msg.request_id ?? "");
      const request = msg.request as Record<string, unknown>;
      const toolName = typeof request.tool_name === "string" ? request.tool_name : undefined;
      const input = request.input;
      if (!reqId) return;
      const kind = deriveAskKind(toolName, input);
      const questions = (input as Record<string, unknown> | undefined)?.questions;
      const plan = typeof (input as Record<string, unknown> | undefined)?.plan === "string"
        ? ((input as Record<string, unknown>).plan as string)
        : undefined;
      this.interactions.open({ requestId: reqId, kind, toolName, input, ...(questions ? { questions } : {}), ...(plan ? { plan } : {}) });
      return;
    }

    if (type === "system" && msg.subtype === "plan_mode_changed") {
      // plan 是独立于权限档的状态机（planStateManager），CLI 进出各发一帧；
      // 前端徽标只认 permission_mode_changed，故折算成 mode="plan"/回到原档。
      const active = (msg.plan_mode as Record<string, unknown> | undefined)?.active === true;
      this.planActive = active;
      this.emit({ type: "permission_mode_changed", mode: active ? "plan" : this.permissionMode ?? "default" });
      return;
    }

    if (type === "control_response") {
      const resp = (msg.response ?? {}) as Record<string, unknown>;
      const ok = resp.subtype === "success";
      if (ok && typeof resp.mode === "string") {
        // set_permission_mode 成功 → CLI 回读权限档，前端徽标跟随（plan 态另算一层）
        this.permissionMode = resp.mode;
        this.emit({ type: "permission_mode_changed", mode: this.planActive ? "plan" : resp.mode });
      }
      for (const w of this.interruptWaiters.splice(0)) w(ok);
      for (const [rid, waiter] of this.controlWaiters) {
        if (rid === String(resp.request_id)) { waiter(ok); this.controlWaiters.delete(rid); }
      }
      return;
    }

    if (type === "stream_event") {
      const ev = (msg.event ?? {}) as Record<string, unknown>;
      const upIdx = typeof ev.index === "number" ? ev.index : -1;
      if (ev.type === "message_start") {
        this.running = true;
        this.resetStream();
        // 宿主 reducer 按 contentIndex 建块要求先有消息骨架（zcode ensureOpen 同形）；
        // 缺 message 时所有 *_start/*_delta 整条丢弃（气泡空白）
        this.emit({
          type: "message_start",
          role: "assistant",
          message: {
            role: "assistant",
            content: [],
            model: this.model?.id ?? "",
            provider: "aiti-qoder-agent",
          },
        });
      } else if (ev.type === "content_block_start") {
        const block = (ev.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use") {
          // 工具名账本提前登记（zcode toolNameByCallId 同款）：块头带 id/name，assistant 终帧
          // 丢失/滞后时 tool_result 仍能报出工具名（卡片不再匿名）。入参等终帧补齐。
          const tid = String(block.id ?? "");
          if (tid && typeof block.name === "string" && !this.toolCallOpen.has(tid)) {
            this.toolCallOpen.set(tid, { name: block.name, input: {} });
          }
          return; // tool_use 块不流式（卡片由 assistant 帧方案 X 出）
        }
        const kind = block.type === "thinking" ? "thinking" : block.type === "text" ? "text" : null;
        if (!kind || upIdx < 0) return;
        const idx = this.blockSeq++;
        this.blockMap.set(upIdx, idx);
        this.blockAcc.set(idx, { kind, text: "" });
        this.emit({ type: "message_update", assistantMessageEvent: { type: kind === "thinking" ? "thinking_start" : "text_start", contentIndex: idx } });
      } else if (ev.type === "content_block_delta") {
        const delta = (ev.delta ?? {}) as Record<string, unknown>;
        const knownIdx = this.blockMap.get(upIdx);
        const known = knownIdx === undefined ? undefined : this.blockAcc.get(knownIdx);
        let idx: number;
        let acc: { kind: "text" | "thinking"; text: string };
        if (known === undefined || knownIdx === undefined) {
          // 孤儿 delta（content_block_start 丢帧，或 CLI 干脆不发块头）：按 delta 类型就地
          // 开块（zcode ensureOpen 同款容错）——整段正文静默丢弃是最难查的失败模式。
          const kind = delta.type === "thinking_delta" ? "thinking" : delta.type === "text_delta" ? "text" : null;
          if (!kind || upIdx < 0) return;
          idx = this.blockSeq++;
          this.blockMap.set(upIdx, idx);
          acc = { kind, text: "" };
          this.blockAcc.set(idx, acc);
          this.emit({
            type: "message_update",
            assistantMessageEvent: { type: kind === "thinking" ? "thinking_start" : "text_start", contentIndex: idx },
          });
        } else {
          idx = knownIdx;
          acc = known;
        }
        const isText = delta.type === "text_delta" && acc.kind === "text";
        const isThinking = delta.type === "thinking_delta" && acc.kind === "thinking";
        const text = typeof delta.text === "string" ? delta.text : typeof delta.thinking === "string" ? delta.thinking : "";
        if ((!isText && !isThinking) || !text) return;
        acc.text += text;
        this.emit({
          type: "message_update",
          // 顶层 delta 只喂适配层的 partialText 快照（断线重连补气泡），不影响内容归位
          ...(isText ? { delta: text } : {}),
          assistantMessageEvent: {
            type: isText ? "text_delta" : "thinking_delta",
            contentIndex: idx,
            delta: text,
          },
        });
      } else if (ev.type === "content_block_stop") {
        const idx = this.blockMap.get(upIdx);
        const acc = idx === undefined ? undefined : this.blockAcc.get(idx);
        if (idx === undefined || acc === undefined) return;
        this.blockMap.delete(upIdx);
        this.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: acc.kind === "thinking" ? "thinking_end" : "text_end",
            contentIndex: idx,
            content: acc.text,
          },
        });
      }
      return;
    }

    if (type === "assistant") {
      const message = (msg.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      // 后台模型感知：assistant 帧自带实际服务的 model（CLI 降级/后台切换会变）
      if (typeof message.model === "string" && message.model) this.trackModel(message.model, "set");
      // 方案 X（对齐 aiti-claude-code-agent/zcode）：工具调用直播走原生 assistant toolCall 消息，
      // 宿主 ToolCallBlock 按 toolCallId 折叠后续 toolResult——直播/refetch 同形，工具名/入参/输出齐全。
      const toolUseBlocks = (content as Array<Record<string, unknown>>)
        .filter((b) => b && b.type === "tool_use" && typeof b.name === "string");
      // ⚠ 分组按**帧内原序**（连续同类归一条）：thinking 段该在工具卡之前，历史上把
      //   toolCall 一律抢先入 liveHistory，刷新回放时思考/正文会跳到工具卡后面（与直播不一致）。
      const groups = (content as Array<Record<string, unknown>>).reduce<
        Array<{ kind: "tool"; blocks: unknown[] } | { kind: "text"; blocks: unknown[] }>
      >((acc, b) => {
        if (!b) return acc;
        const isTool = b.type === "tool_use" && typeof b.name === "string";
        const textBlock = b.type === "text" && typeof b.text === "string" && b.text
          ? { type: "text", text: b.text }
          : b.type === "thinking" && typeof b.thinking === "string" && b.thinking
            ? { type: "thinking", thinking: b.thinking }
            : null;
        const block = isTool
          ? { type: "toolCall", toolCallId: String((b as Record<string, unknown>).id ?? ""), toolName: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }
          : textBlock;
        if (!block) return acc;
        const kind = isTool ? "tool" : "text";
        const last = acc[acc.length - 1];
        if (last && last.kind === kind) last.blocks.push(block);
        else acc.push({ kind, blocks: [block] });
        return acc;
      }, []);
      for (const b of toolUseBlocks) {
        this.toolCallOpen.set(String(b.id ?? ""), { name: String(b.name), input: b.input ?? {} });
        // 任务列表主通道：TodoWrite 族工具入参（协议无 todo 事件，只能从工具事件派生）
        this.tasks.fromToolEvent(String(b.name), b.input);
      }
      for (const g of groups) {
        const groupMsg = {
          role: "assistant",
          content: g.blocks,
          model: typeof message.model === "string" ? message.model : this.model?.id ?? "",
          provider: "aiti-qoder-agent",
          timestamp: Date.now(),
        };
        this.liveHistoryPush(groupMsg);
        this.emit({ type: "message_end", message: groupMsg });
      }
      this.resetStream();
      return;
    }

    if (type === "user") {
      const echoUuid = typeof msg.uuid === "string" ? msg.uuid : "";
      if (echoUuid && this.steerPending.has(echoUuid)) {
        this.acceptSteer(echoUuid); // 注入被消费：CLI 回显（isReplay）= 认领回执
        return;
      }
      // 方案 X：工具结果 → 原生 toolResult 条目（liveHistory 折叠配对 + message_end 直播即时出输出）
      const message = (msg.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const b of content) {
        if (b.type === "tool_result") {
          const id = String(b.tool_use_id ?? "");
          const open = this.toolCallOpen.get(id);
          this.toolCallOpen.delete(id);
          const rc = Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>) : [];
          const outText = (typeof b.content === "string" ? b.content : rc.map((x) => (typeof x.text === "string" ? x.text : "")).join("")).trim();
          // 任务列表第二通道（zcode 同款 input 优先、output 兜底）：部分 CLI 把新列表回显在结果里
          this.tasks.fromToolEvent(open?.name ?? "", open?.input, outText);
          const isError = b.is_error === true;
          const resultMsg = {
            role: "toolResult",
            ...(id ? { toolCallId: id } : {}),
            ...(open?.name ? { toolName: open.name } : {}),
            content: [{ type: "text", text: (outText || (isError ? EMPTY_TOOL_ERROR : EMPTY_TOOL_OUTPUT)).slice(0, 4000) }],
            ...(isError ? { isError: true } : {}),
            timestamp: Date.now(),
          };
          this.liveHistory.push(resultMsg);
          this.emit({ type: "message_end", message: resultMsg });
        }
      }
      return;
    }

    if (type === "command_lifecycle") {
      // msg_lifecycle_v1：{command_uuid, state}——注入帧的第二条认领通道（部分版本回显
      // user、部分只发生命周期）。state 不做区分：cancelled 既出现在「被丢弃的排队项」
      // 也出现在「已读取但本轮被打断」的收尾（1.1.44 按 reason 批量收尾），据其重发会
      // 重复投递模型已看过的消息 → 一律按「已认领」收口。
      const cu = typeof msg.command_uuid === "string" ? msg.command_uuid : "";
      if (cu && this.steerPending.has(cu)) this.acceptSteer(cu);
      return;
    }

    if (type === "result") {
      this.running = false;
      this.settleSteerAtTurnEnd(); // 注入没等到认领帧也要随本轮收口（面板不挂陈旧条目）
      this.extractUsage(msg);
      const isError = msg.is_error === true;
      // 本轮结束 = 未决应答一起作废（卡片永挂会让前端误判仍在等待）
      this.interactions.failPending("turn_end");
      // result 帧 自带本轮 credits（total_credits / modelUsage.*.credits）
      const credits = typeof msg.total_credits === "number" ? msg.total_credits : undefined;
      this.emit({
        type: "agent_settled",
        ...(isError ? { error: String(msg.result ?? "error") } : {}),
        ...(credits !== undefined ? { usage: { provider: "qoder", costUsd: 0, credits } } : {}),
        result: typeof msg.result === "string" ? msg.result : undefined,
      });
      // settle（result 帧）后自动续轮（共享层幂等；running 已置 false 才会放行）
      this.q.scheduleDrain();
      return;
    }
  }

  private liveHistory: unknown[] = [];
  private liveHistoryPush(entry: unknown): void {
    this.liveHistory.push(entry);
  }

  static async start(opts: {
    sessionId?: string;
    cwd?: string;
    extraArgs?: string[];
    variant: "intl" | "cn";
    client?: QoderClient | null;
    model?: { provider: string; id: string };
    /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
    launchOverride?: LaunchOverride;
  }): Promise<QoderHandle> {
    // env 覆盖 > PATH > 安装位兜底（Windows qoderclicn 常不在 PATH）；均未命中留约定名让 spawn fail-loud
    const cli = resolveQoderCli(opts.variant) ?? qoderLoginBin(opts.variant);
    const { agentKey, stateKey } = qoderVariant(opts.variant);
    // 种子模型：显式指定 > 状态文件恢复（重开会话不丢上次切换）；同族 CC CLI，--model 同款
    let seedModel = opts.model?.id;
    if (!seedModel && opts.sessionId) {
      const restored = await readExtModelState(stateKey, `${agentKey}:${opts.sessionId}`);
      if (restored?.selected?.id) seedModel = restored.selected.id;
    }
    // 新会话（无显式模型/无同会话恢复）→ 该 agent 上次使用的模型（per-agent last used）
    // ⚠ 仅新会话：resume 会话模型以 CLI 自身为准，不用 agent 级默认覆盖
    if (!seedModel && !opts.sessionId) {
      const lastUsed = await readAgentLastUsedModel(stateKey);
      if (lastUsed?.id) seedModel = lastUsed.id;
    }
    // 接管既有会话：一次读取（session-manager 权威存储）同时拿到「原 cwd」与「历史」。
    // cwd 必须以原会话归属为准——qodercli 的 --resume 只在 cwd 对应的项目目录里找历史，
    // 回退到 pi-web 进程 cwd 会报「会话不存在」（URL 直开 / ?session= 恢复都不带 cwd）。
    const external = opts.sessionId ? await parseExternalSession(`${agentKey}:${opts.sessionId}`) : null;
    const metaCwd = typeof external?.meta?.cwd === "string" ? external.meta.cwd.trim() : "";
    const cwd = opts.cwd || metaCwd || process.cwd();
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      // 起步最大权限：headless 长驻会话逐条审批太吵（普通工具 CLI 自己 policy 放行，
      // 只有 requiresUserInteraction 类工具会发 can_use_tool——那条走 interaction_request 应答）。
      // 运行时仍可 set_permission_mode 切换。
      "--permission-mode", "bypass_permissions",
      // 注意：qodercli 不支持 --verbose（claude CLI 专属，传了会 exit 1）
      ...(seedModel ? ["--model", seedModel] : []),
      ...(opts.sessionId ? ["--resume", opts.sessionId] : []),
      ...(opts.extraArgs ?? []),
    ];
    // P1' 启动包装（docs/aiti-custom-agent-plan.md）：extman spawn.command/spawn.argsPrefix，缺省 = 行为不变
    // P2：launchOverride（custom-agent 委托路径）优先于 extman feature
    const ov = opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: cli,
      command: ov?.command?.trim() || spawnCommand("aiti-qoder-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-qoder-agent")).args,
      driverArgs: args,
      env: agentSpawnEnv({ extId: "aiti-qoder-agent", envList: spawnEnvList("aiti-qoder-agent") }),
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd,
      warn: (m) => console.log(`[aiti-qoder-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    const provisionalId = opts.sessionId ? `${agentKey}:${opts.sessionId}` : `${agentKey}:${PLACEHOLDER_MARK}${randomUUID()}`;
    // cliPath 传 CLI 本体（不是启动包装）：steer 门控的证据键要落在实际执行注入的二进制上，
    // spawn.command/launchOverride 只是外层 wrapper，换 wrapper 不该让探针结论失效。
    const handle = new QoderHandle(provisionalId, child, opts.client, cwd, opts.variant, cli);
    if (seedModel) handle.model = { id: seedModel, provider: "qoder" };
    if (external?.messages?.length) handle.seedHistory(external.messages);
    // 启动即写状态文件（pi 目录快照 + selected），引导外部 agent
    handle.persistModelState();
    return handle;
  }

  /** 背压修正（加固 A4）：write() 返回 false 仅表示帧入缓冲（>16KB 必返 false），不是失败。 */
  private writeLine(obj: Record<string, unknown>): boolean {
    const stdin = this.child.stdin;
    if (!stdin?.writable) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  async prompt(
    text: string,
    options?: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      files?: Array<{ data: string; mimeType: string; filename?: string }>;
      /**
       * 运行中排队语义（core 透传）：followUp 恒入本地队列；steer/缺省按探针门控——
       * pass 的 CLI 注入 stdin（当前轮工具间隙消费），否则同样收敛到队列（消息不丢）。
       */
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    if (this.running) {
      // 运行中：不在此处直发（注入或入队都由共享层按能力门分流；写 stdin 的注入路径
      // 一旦被 CLI 吞掉也不会有显式错误，所以只在实跑探针通过的版本开放）。
      await this.q.routePrompt(text, {
        ...(options?.images?.length ? { images: options.images as never } : {}),
        streamingBehavior: options?.streamingBehavior,
      });
      return;
    }
    const ok = this.writeLine({
      type: "user",
      message: { role: "user", content: buildUserContent(text, options?.images) },
    });
    if (!ok) throw new Error("[aiti-qoder-agent] stdin closed");
    // 写成功后才置 running（加固 A4）：写失败抛错时 running 保持 false，会话不被卡死
    this.running = true;
    this.liveHistory.push({ role: "user", content: text });
  }

  /**
   * 运行中注入（steer 钩子；只在探针 pass 时挂载）。
   *
   * 帧形 = CLI 入站 user schema（1.1.44 取证）：MessageQueue 三档 `now(0) < next(1) < later(2)`，
   * AgentLoop 的 inter_turn 附件采集取 **rank ≤ next** 的条目当轮吸收（`queued_command` 附件 +
   * midTurn 包装，消费时回 `command_lifecycle state:"started"`）→ **steer 用 `next`**。
   * `now` 额外命中 headless 的队列监听「有 now 就打断本轮」——实测注入后 535ms 本轮以
   * `result/error_during_execution` 收口、注入另起一轮：那是**抢占**（等价 stop+重发），不是 steer。
   * **uuid 必须由我们生成**——它是后面认领回执（`user` isReplay 回显 / `command_lifecycle.command_uuid`）
   * 的关联键。
   *
   * 不做投递等待：CLI 丢弃注入时没有任何显式错误，等回执只会变成超时猜测（既不能证明
   * 丢了、又不能安全重发——重发才是重复消息的根源）。写失败（stdin 已关）是唯一确定
   * 的失败 → 抛给共享层降级入队。投递事实由探针与运行时日志负责。
   */
  private async steerInject(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    const uuid = randomUUID();
    const wrote = this.writeLine({
      type: "user",
      uuid,
      priority: "next",
      message: { role: "user", content: buildUserContent(text, images) },
    });
    if (!wrote) throw new Error("[aiti-qoder-agent] stdin closed");
    this.steerPending.set(uuid, text);
    // 面板「插队」组先挂上（只读——注入后归 CLI 自己的队列，撤回要走 stop 中断本轮）
    this.q.registerSteer(uuid, text);
    console.log(`[aiti-qoder-agent] steer injected uuid=${uuid} len=${text.length}`);
  }

  /** CLI 认领了一条注入：从「插队」组摘掉，落进消息流（回显帧不带 tool_result）。 */
  private acceptSteer(uuid: string): void {
    const text = this.steerPending.get(uuid);
    if (text === undefined) return;
    this.steerPending.delete(uuid);
    this.q.drainSteer([uuid]);
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  /**
   * 轮末收口：本轮结束仍没等到认领帧的注入，按「已随本轮过去」处理（摘面板条目 + 落消息流）。
   * 不重发——歧义时重发才是重复消息的来源；真要重发由用户在面板里重新发一条。
   */
  private settleSteerAtTurnEnd(): void {
    for (const uuid of [...this.steerPending.keys()]) this.acceptSteer(uuid);
  }

  /**
   * 模型感知（后台切了我们能感知到）：init/assistant 帧模型变化时广播
   * model_select（pi 原生 ModelSelectEvent 形状）。首轮初始化不广播。
   */
  private trackModel(id: string, source: "set" | "restore"): void {
    const next = { id, provider: "qoder" };
    const prev = this.model;
    if (prev && prev.id === id) return;
    this.model = next;
    if (prev) {
      this.emit({ type: "model_select", model: next, previousModel: prev, source });
      this.persistModelState();
    }
  }

  /**
   * 机会式 usage 提取（result 帧）：qodercli 是 CC stream-json 族 fork，result
   * 帧若带 claude 形态 usage 则记账；实测部分版本不落 token（usage 恒缺/恒 0）
   * ——拿不到不编数据，getContextUsage 相应保持空轨。
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
   * 可判才报（qmodel_* 等自研命名未公开窗口 → undefined，空轨态）。
   */
  getContextUsage(): { percent: number; contextWindow: number; tokens: number } | undefined {
    const u = this.lastUsage;
    if (!u) return undefined;
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (!(tokens > 0)) return undefined;
    const contextWindow = qoderContextWindow(this.model?.id ?? u.model);
    if (!contextWindow) return undefined;
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }

  /** @capability getUsageTotals —— 会话累计（宿主 get_session_stats 真实口径；无 usage 帧 → 全 0）。 */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  /**
   * 运行时切换模型：set_model control_request → control_response
   * （qodercli 1.1.17 为 CC 族 fork，二进制取证含该分支；超时回 false，fail-loud）。
   */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    const requestId = `sm-${++this.seq}`;
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.controlWaiters.has(requestId)) {
          this.controlWaiters.delete(requestId);
          console.warn(`[aiti-qoder-agent] set_model(${model.id}) timed out — send a message first`);
          resolve(false);
        }
      }, 15_000);
      this.controlWaiters.set(requestId, (v) => { clearTimeout(timer); resolve(v); });
      const wrote = this.writeLine({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_model", model: model.id },
      });
      if (!wrote) { clearTimeout(timer); this.controlWaiters.delete(requestId); resolve(false); }
    });
    if (ok) {
      const prev = this.model;
      this.model = { id: model.id, provider: "qoder" };
      this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
      this.persistModelState();
    }
    return ok;
  }

  async getAvailableModels(): Promise<ExtModelEntry[]> {
    return qoderCatalog(this.client ?? (await ensureClient()), this.model);
  }

  /** 临时模型状态文件（启动/切换时写：selected + pi 目录快照，引导 spawn --model 与重开恢复）。 */
  persistModelState(): Promise<void> {
    // ⚠ 共享层字段名叫 agentKey，装的是状态文件命名空间（stateKey，如 "qoder-cn"），
    //   不是 All Sessions join key（"qodercn"）——两者混用会写花历史状态文件。
    const { stateKey } = qoderVariant(this.variant);
    const tracked = this.model;
    return (async () => {
      // 归一必须在「未置顶」目录上做：getAvailableModels 的 withCurrentFirst 会把命不中的
      // 当前模型合成成裸条目，拿它自匹配等于没归一。
      const base = await qoderCatalog(this.client ?? (await ensureClient()));
      // CLI 帧回报 display_name（"Qwen3.8-Flash"）而非目录 key（"qfmodel"）：不归一就写进
      // selected，新建页 withLastUsedFirst 命不中 → 默认落回目录首行 auto，spawn --model 也拿到废值。
      const hit = resolveCatalogEntry(base, tracked);
      if (hit && tracked && this.model === tracked) this.model = { id: hit.id, provider: tracked.provider };
      await writeExtModelState({
        agentKey: stateKey,
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models: withCurrentFirst(base, this.model ?? undefined),
        updatedAt: "",
      });
    })().catch((e) => console.warn(
      `[aiti-qoder-agent] persistModelState 失败（不阻断会话）: ${e instanceof Error ? e.message : String(e)}`,
    ));
  }

  /** 内部历史出口（历史命名保留；seedHistory/回填路径使用）。 */
  getLiveHistory(): unknown[] {
    return this.liveHistory;
  }

  /** @capability getMessages —— 适配层 get_messages/get_entries 查此名（D2：曾错名 getLiveHistory 致功能缺失）。 */
  getMessages(): unknown[] {
    return this.getLiveHistory();
  }

  /**
   * 历史回填（All Sessions 服务出口读取的落点）：IndexedMessage[] → liveHistory 形状。
   * 与 recordAssistant 同形状（assistant 带 model/provider）；结构化工具行（claude-like
   * adapter 的 tool 字段）→ 原生 assistant toolCall + toolResult（按 callID 配对，宿主
   * ToolCallBlock 渲成 pi 自家工具卡片）；🛠 {json} 文本行只作结构化缺席时的兜底
   * （交棒上下文语义：老索引/未知格式不丢内容）。
   */
  seedHistory(messages: Array<{ role?: unknown; text?: unknown; model?: unknown; provider?: unknown; tool?: unknown }>): void {
    const replay = createSeedToolReplay("qoder-tool");
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const model = typeof m.model === "string" && m.model ? m.model : "";
      const provider = typeof m.provider === "string" && m.provider ? m.provider : "aiti-qoder-agent";
      const tool = role === "assistant" ? replay.entries(m.tool, { model, provider }) : null;
      if (tool) {
        this.liveHistory.push(...tool);
        continue;
      }
      const text = typeof m.text === "string" ? m.text : "";
      if (!text.trim()) continue;
      this.liveHistory.push(
        role === "assistant"
          ? { role, content: [{ type: "text", text }], model, provider }
          : { role, content: text },
      );
    }
  }

  async abort(): Promise<void> {
    // 2026-09-06 协议实测：qodercli 支持 CC 同构 control_request/interrupt——
    // control_response success + result 帧（is_error）收敛；此前只置 running=false
    // 属假成功（前端显停、CLI 仍在跑）。与 aiti-claude-code-agent 同款两段式。
    // 15s 超时（加固：对齐 set_model/set_permission_mode；CLI 忙时不让宿主 abort 永挂）。
    if (!this.running) {
      // 失步兜底（zcode 同款）：前端运行态与 handle 失步（如 result 帧丢失）时静默 return
      // 会让停止按钮永久悬挂。补一帧 aborted 收口复位前端；幂等，真空闲时多一帧无害。
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    const requestId = `int-${++this.seq}`;
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
    if (!interrupted) console.warn("[aiti-qoder-agent] interrupt not acknowledged");
  }

  /**
   * 运行时切换权限模式（control_request/set_permission_mode，长驻进程运行时生效）。
   * 2026-09-19 二进制定位：`plan` 走 planStateManager 开关（与权限档并存，进/出各发一帧
   * plan_mode_changed），其余档直通 setPermissionMode；只有 `dontAsk` 与 plan 互斥
   * （CLI 抛 "Plan mode is unavailable while the Don't ask permission mode is active"）
   * → 那种情况下本方法拿到 error 响应返 false，前端先切别的档再进 plan。
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    const supported = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"];
    if (!supported.includes(mode)) {
      throw new Error(`[aiti-qoder-agent] 非法权限模式 "${mode}"（qodercli 可选：${supported.join("/")}）`);
    }
    const requestId = `pm-${++this.seq}`;
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.controlWaiters.has(requestId)) {
          this.controlWaiters.delete(requestId);
          resolve(false);
        }
      }, 15_000);
      this.controlWaiters.set(requestId, (v) => { clearTimeout(timer); resolve(v); });
      const wrote = this.writeLine({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_permission_mode", mode },
      });
      if (!wrote) { clearTimeout(timer); this.controlWaiters.delete(requestId); resolve(false); }
    });
    // plan 不是权限档（独立状态机），生效由 plan_mode_changed 帧回执，别把它记进 permissionMode
    if (ok && mode !== "plan") this.permissionMode = mode;
    return ok;
  }

  /** 当前模式（plan 态优先；init 帧回读 / 本进程切换记录；宿主无查询通道，供本扩展与排障用）。 */
  getPermissionMode(): string | undefined {
    return this.planActive ? "plan" : this.permissionMode;
  }

  /**
   * @capability respondInteraction —— 应答一个未决 interaction_request（统一契约）。
   * 账本查无此项（重复应答/已随回合作废）→ 直接 false，绝不向 CLI 写一条它对不上的帧；
   * 答案换算（answers/approved/feedback → updatedInput）在共享层做，这里只认帧写字节。
   */
  async respondInteraction(requestId: string, answer: InteractionAnswer): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] stdin closed");
    const ask = this.interactions.settle(requestId, answer);
    if (!ask) return false;
    return this.writeLine({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: toControlResponse(ask, answer) },
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // 未决应答单独补发给这条新订阅：前端刷新后卡片不在（内存 state 丢了）而 CLI 还在那儿等，
    // 不补发就是永久挂起。已在看卡片的旧订阅者不再收到第二帧（同 requestId 重复渲染无害但多余）。
    for (const event of this.interactions.replay()) {
      try {
        listener(event as unknown as Record<string, unknown>);
      } catch (e) {
        console.error(`[aiti-qoder-agent] replay error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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

  /**
   * @capability steer —— 运行中注入（探针 pass 才开放；空闲时等同普通发送）。
   * 门控关时保持 fail-loud：宿主已按能力位把 steer 降级成 followUp，走到这里只能是
   * 有人直连 RPC——静默改语义（悄悄排队）比抛错更坏。
   */
  async steer(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    if (!this.steerOn) {
      throw new Error(
        `Capability "steer" is not enabled for CLI "${this.cliPath || "?"}"：` +
        "注入面未经实跑探针验证（跑 node tools/steer-probe.mjs --record，pass 后重开会话）",
      );
    }
    if (!this.running) {
      await this.prompt(text);
      return;
    }
    await this.steerInject(text);
  }

  /** @capability followUp —— 运行中入本地队列（result 后自动续轮，可撤回）；空闲等同普通 prompt。 */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage —— queue keeper 队列操作原语转发共享层。
   * followUp 组全 CRUD；steer 组只读（注入后条目在 CLI 自己的消息队列里，共享层对
   * kind==="steer" 的写操作给出说明性报错——真撤回见 control_request/cancel_async_message，
   * 协议已取证、面板接线尚未做）。
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
   * @capability taskList —— 任务列表快照（宿主 get_state / 任务面板数据源）。
   * 内存镜像为空时回退磁盘快照：handle 由空闲 GC 重建后（同一 sid）面板不空。
   * ⚠ 应答形状 `{todos}`（宿主契约）；休眠分支的 sessionDormantState 才用 `{tasks}`。
   */
  taskList = async (): Promise<{ todos: TaskEntry[] }> => ({
    todos: this.tasks.current().length
      ? this.tasks.current().map((t) => ({ ...t }))
      : (await readTaskSnapshotTodos(this.id)) ?? [],
  });

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  /** 账号 credits（独立于子进程生命周期；WASM 未就绪或失败时 undefined）。 */
  async getUsage() {
    const client = this.client ?? (await ensureClient());
    if (!client) return undefined;
    try {
      return await fetchQoderUsage(client);
    } catch (e) {
      console.warn("[aiti-qoder-agent] getUsage failed:", e instanceof Error ? e.message : e);
      return undefined;
    }
  }


  /** @capability listTools —— init 帧 tools 快照（宿主面板/工具卡描述用）。 */
  async getAllTools(): Promise<Array<{ name: string; description: string }>> {
    return this.tools.map((t) => ({ ...t }));
  }

  /** @capability getCommands —— init 帧 slash_commands 快照（前端斜杠面板）。 */
  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    return this.commands.map((c) => ({ ...c }));
  }
}

// ============================================================================
// Extension entry
// ============================================================================

let sharedClient: QoderClient | null = null;

/**
 * WASM 客户端按需预热（2026-09-19 修正）：旧版只在模块加载尾部一次性 createClient——
 * 加载时刻早于登录（新机先部署、后人完成授权）时 sharedClient 永为 null，
 * 网关模型目录/credits 静默缺失且无从恢复。改为消费点按需单飞重试 + 失败冷却（事件驱动非轮询）。
 */
let clientPromise: Promise<QoderClient | null> | null = null;
let clientFailedAt = 0;
const CLIENT_RETRY_COOLDOWN_MS = 60_000;

async function ensureClient(): Promise<QoderClient | null> {
  if (sharedClient) return sharedClient;
  if (clientPromise) return clientPromise;
  if (Date.now() - clientFailedAt < CLIENT_RETRY_COOLDOWN_MS) return null;
  clientPromise = createClient(homedir())
    .then((c) => {
      sharedClient = c;
      console.log(`[aiti-qoder-agent] wasm client ready · region=${c.region.name} uid=${c.region.creds.uid}`);
      return c;
    })
    .catch((e) => {
      clientFailedAt = Date.now();
      console.warn(`[aiti-qoder-agent] 未找到已登录 Qoder 凭据，credits/listModels 能力不可用: ${e instanceof Error ? e.message : String(e)}` +
        "——可点 pi-web 工具条 🔑「登录 Qoder」发起受控登录（授权链接任意设备打开，凭据自动落盘；登录后首次查询即自动重试）");
      return null;
    })
    .finally(() => { clientPromise = null; });
  return clientPromise;
}

/** configDir 兑底（宿主 serverContext 恒带 configDir；按 demo 约定自拼，仅防御性）。 */
function extDataDir(): string {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return join(root, "aiti-qoder-agent", "config");
}

/**
 * recycle 的 id → 重建参数解析（占位 id 不得拿去 --resume）。⚠ 导出仅为单测可达。
 */
export function parseRecycleId(id: string): { sessionId: string; providerType: string } | null {
  const split = (sid: string, providerType: string) => ({ sessionId: isPlaceholderSid(sid) ? "" : sid, providerType });
  if (id.startsWith("qodercn:")) return split(id.slice("qodercn:".length), "aiti-qoder-agent/qoder-cn");
  if (id.startsWith("qoder:")) return split(id.slice("qoder:".length), "aiti-qoder-agent/qoder");
  return null;
}

/** 会话 recycle（D8，共享层 session-recycle.ts）：存量 QoderHandle 升级到当前扩展代码。 */
const recycleApi = createSessionRecycleApi({
  isOwn: (h) => h.id.startsWith("qoder:") || h.id.startsWith("qodercn:"),
  parseId: (id) => parseRecycleId(id),
});

/**
 * 额度归一（内联版）：qoder-core.mjs 是原生 ESM 子模块，jiti 走 native import——
 * 进程内模块缓存不随 reload 更新（新导出拿不到），故归一化内联在 index.ts。
 * 与 qoder-core.quotaFromUsage 同契约（agent-manager 显示用）。
 */
function localQuotaFromUsage(usage: {
  plan?: string;
  buckets?: Array<{ name: string; total?: number; used?: number; remaining?: number; usedPercent?: number }>;
  credits?: { remaining?: number; used?: number; usedPercent?: number; unit?: string; expiresAt?: number };
  quotaExceeded?: boolean;
}): Record<string, unknown> {
  const BUCKET_LABEL: Record<string, string> = { user_quota: "基础配额", add_on_quota: "增购包", org_resource_package: "组织包" };
  const c = usage?.credits ?? {};
  const remaining = typeof c.remaining === "number" ? c.remaining : undefined;
  const unit = c.unit ?? "credits";
  const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const packages = (usage?.buckets ?? []).map((b) => ({
    name: BUCKET_LABEL[b.name] ?? b.name,
    ...(b.remaining !== undefined ? { remaining: b.remaining } : {}),
    ...(b.total !== undefined ? { total: b.total } : {}),
    ...(b.used !== undefined ? { used: b.used } : {}),
    ...(b.usedPercent !== undefined ? { usedPercent: b.usedPercent } : {}),
  }));
  const notes: string[] = [];
  if (usage?.plan) notes.push("套餐：" + usage.plan);
  if (usage?.quotaExceeded) notes.push("配额已耗尽");
  const display = remaining !== undefined
    ? `额度 剩余 ${fmt(remaining)} ${unit}`
    : typeof c.usedPercent === "number" ? `额度 已用 ${fmt(c.usedPercent)}%` : "额度";
  return {
    available: true, display, unit,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(typeof c.used === "number" ? { used: c.used } : {}),
    ...(typeof c.usedPercent === "number" ? { usedPercent: c.usedPercent } : {}),
    ...(typeof c.expiresAt === "number" ? { expiresAt: c.expiresAt } : {}),
    ...(notes.length ? { note: notes.join("；") } : {}),
    packages,
    fetchedAt: Date.now(),
  };
}

/** 账号额度缓存（60s；force=1 绕过；失败 10s 退避，防面板轮询打爆 API）。 */
let quotaCache: { at: number; ttl: number; value: Record<string, unknown> } | null = null;
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 10_000;

/** GET /login/quota[?force=1] → 统一额度视图（agent-manager 显示契约；token 不出服务端）。 */
async function quotaView(force: boolean): Promise<Response> {
  if (!force && quotaCache && Date.now() - quotaCache.at < quotaCache.ttl) return Response.json(quotaCache.value);
  const client = await ensureClient();
  if (!client) {
    const v = { available: false, reason: "no-client", note: "Qoder 客户端未就绪（未登录/WASM 未加载）", fetchedAt: Date.now() };
    quotaCache = { at: Date.now(), ttl: QUOTA_ERROR_TTL_MS, value: v };
    return Response.json(v);
  }
  try {
    const v = localQuotaFromUsage(await fetchQoderUsage(client));
    quotaCache = { at: Date.now(), ttl: QUOTA_TTL_MS, value: v };
    return Response.json(v);
  } catch (e) {
    const v = { available: false, reason: "fetch-failed", note: e instanceof Error ? e.message : String(e), fetchedAt: Date.now() };
    quotaCache = { at: Date.now(), ttl: QUOTA_ERROR_TTL_MS, value: v };
    return Response.json(v);
  }
}

// ── Backend scan (shared by startup + rescanBackends) ─────────────────────
// Probe + register pass for both qoder variants — unconditional registration:
// a missing CLI still registers the entry (available:false + installHint, the
// dropdown greys it out); re-running the scan flips the snapshot (POST
// /api/session-backends/rescan, host-invoked after boot).
type QoderScanSlot = {
  register(provider: {
    type: string;
    label: string;
    agentKey?: string;
    priority?: number;
    maxCapabilities: SessionCapabilitiesLike;
    available?: boolean;
    installHint?: string;
    listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
    createSession(options: {
      sessionId?: string;
      cwd?: string;
      extraArgs?: string[];
      model?: { provider: string; id: string };
    }): Promise<QoderHandle>;
  }): string;
};

// Shown next to the greyed-out dropdown entry when the CLI is not on PATH nor
// in the known install locations.
const QODER_INSTALL_HINT = "Qoder standalone CLI (qodercli / qoderclicn — CC-protocol headless agent; `qoder` is the IDE launcher, not this CLI)";

const mkQoderProvider = (v: QoderVariantInfo, bin: string | null) => ({
  type: v.type,
  label: v.label,
  agentKey: v.agentKey,
  priority: 20, // 高于通用 CC 族驱动的 10：同 agentKey 时优先由本扩展认领
  // 该二进制的实际能力表（steer 只在探针 pass 时开放；宿主按它门控按钮/降级）
  maxCapabilities: qoderCapabilitiesFor(bin),
  // Availability snapshot: false = CLI missing → dropdown entry greyed out;
  // refreshed on rescan. createSession fails with an install pointer when
  // invoked without the binary.
  ...(bin ? {} : { available: false as const, installHint: QODER_INSTALL_HINT }),
  // 静态目录（新建页选后端时给选择器供数据；无会话即可取，WASM 未就绪时仅 pi 目录）——上次使用的模型置顶
  listModels: () => qoderStaticCatalog(sharedClient, v.stateKey),
  createSession: (options: { sessionId?: string; cwd?: string; extraArgs?: string[]; model?: { provider: string; id: string } }) =>
    QoderHandle.start({ ...options, variant: v.variant, client: sharedClient }),
});

function scanQoderBackends(
  slot: QoderScanSlot,
  provide?: <T>(key: string, impl: T) => () => void,
): { registered: string[]; unavailable: string[] } {
  const registered: string[] = [];
  const unavailable: string[] = [];
  const installedVariants = new Set<QoderVariant>();
  for (const v of QODER_VARIANTS) {
    const bin = resolveQoderCli(v.variant);
    const key = slot.register(mkQoderProvider(v, bin));
    if (bin) {
      installedVariants.add(v.variant);
      registered.push(`${key}(${bin})`);
      console.log(`[aiti-qoder-agent] ${v.agentKey}: ${describeSteerGate(steerProbeBook, bin)}`);
    } else {
      unavailable.push(key); // PATH 与安装位均无 → 条目常驻但灰显（装机后 rescan 自动点亮）
    }
  }
  // P2 协议委托：launch 服务（intl 优先，未装则 cn；均未装时 agentKey 仍给 qoder——注册侧按需消费）
  // agentKey 一律是「All Sessions join key」= 复合 id 前缀（CN = qodercn），不是 provider type。
  const primary = qoderVariant(installedVariants.has("cn") && !installedVariants.has("intl") ? "cn" : "intl");
  provide?.("aiti-qoder-agent.launch", {
    agentKey: primary.agentKey,
    capabilities: qoderCapabilitiesFor(resolveQoderCli(primary.variant)),
    // name = provider type（custom-agent 存进 agents.json 的 target，勿改）
    members: QODER_VARIANTS.map((v) => ({ name: v.type, agentKey: v.agentKey, label: v.label })),
    createSessionFromLaunch: (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; extraArgs?: string[]; model?: { provider: string; id: string } }) =>
      QoderHandle.start({
        ...options,
        variant: QODER_VARIANTS.find((v) => v.type === launch.target)?.variant ?? primary.variant,
        client: sharedClient,
        launchOverride: launch,
      }),
  });
  return { registered, unavailable };
}

export default {
  id: "aiti-qoder-agent",
  name: "Qoder CLI (国际/CN 独立 CLI·非 IDE)",
  version: "0.3.0",
  icon: "🟠",
  // 受控登录统一弹窗（零构建原生 h() client；client/ 下两文件随 deploy 拷贝）
  // 静态插入点声明（与 client registerItems 的 id 一一对应）
  // 登录 UI 已统一到 aiti-agent-manager（受控登录弹窗退役，2026-09-13）：不再声明
  // client/ui —— 服务端 /login/* 与 .agent 描述符保留（manager 代理消费）。

  features: [spawnEnvFeature("Qoder"), spawnCommandFeature("Qoder"), spawnArgsPrefixFeature("Qoder")],

  server: {
    startup(ctx: {
      /** 扩展数据目录（宿主 serverContext 恒提供；类型上按需声明）。 */
      configDir?: string;
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
            sessionId?: string;
            cwd?: string;
            extraArgs?: string[];
            model?: { provider: string; id: string };
            listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          }): Promise<QoderHandle>;
        }): string;
      };
    }) {
      hostSvc = (ctx as any)?.services ?? null; // DI 方案 P1
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json，与 claude-code 后端同配方）
      queueStateDir = (ctx as { stateDir?: string }).stateDir
        ?? join((ctx as { configDir?: string }).configDir ?? extDataDir(), "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // 任务快照根（<stateDir>/task-lists/<sid>.json）：handle 被空闲 GC/进程重启后，
      // 打开历史会话时 core state 路由经下面的休眠兜底服务读最近一次 task_update。
      taskListDir = join(queueStateDir, "task-lists");
      try { mkdirSync(taskListDir, { recursive: true }); } catch { /* exists */ }
      // 未决应答 sidecar 根（<stateDir>/interactions/<sid>.json）：刷新/重建后重发卡片，
      // 免得 CLI 等一个没人回答的请求把回合永久钉住（2026-09-19 挂 5 小时事故）
      interactionDir = join(queueStateDir, "interactions");
      try { mkdirSync(interactionDir, { recursive: true }); } catch { /* exists */ }
      // steer 探针账本（<stateDir>/steer-probe.json，tools/steer-probe.mjs --record 写入）：
      // 必须在注册会话后端之前读入——能力表与 steer 钩子都在句柄创建时同步判定。
      loadSteerProbeBook(queueStateDir);
      ctx.services?.provide?.("aiti-qoder-agent.sessionDormantState", readTaskSnapshot);
      // 受控登录（工具条 🔑）：spawn `login` + NO_BROWSER=true；variant 可由 body 指定，
      // 缺省 cn 优先（本机双 CLI 装机时与 credits 面板一致）、未装才落 intl
      const login = createControlledLogin({
        driver: qoderLoginDriver,
        configDir: (ctx as { configDir?: string }).configDir ?? extDataDir(),
        resolveRuntime: async (argv) => {
          const requested = (argv as { variant?: string } | undefined)?.variant;
          let variant: QoderVariant;
          if (requested === "intl" || requested === "cn") variant = requested;
          else variant = resolveQoderCli("cn") ? "cn" : "intl";
          const bin = resolveQoderCli(variant);
          if (!bin) {
            throw new Error(
              `未找到 Qoder CLI（变体 ${variant}：PATH 与安装位均无 "${qoderLoginBin(variant)}"）——请先安装 qodercli/qoderclicn；` +
              "或在有浏览器的机器上运行其 `login` 完成授权",
            );
          }
          return bin;
        },
        log: (m) => console.log(`[aiti-qoder-agent] ${m}`),
      });
      loginApi = mountControlledLoginApi(login);
      loginCtl = login;
      // 变体键全部来自 variants.ts（type=注册键 / agentKey=All Sessions join key=复合 id
      // 前缀 / stateKey=模型状态命名空间）——agentKey 必须等于 session-manager 适配器 id，
      // 否则 findProvidersForAgent 精确匹配落空，该变体的历史行既不能直开也不能接管。
      // 变体探测+注册+launch 服务（可重入；装机后无需重启，经 rescanBackends 重扫）
      const qoderScan = scanQoderBackends(ctx.sessionProviders, ctx.services?.provide);
      console.log(`[aiti-qoder-agent] registered: ${qoderScan.registered.join(", ") || "(no qoder CLI on PATH)"} + launch service`);
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用——manager 不写死各家
      ctx.services?.provide?.("aiti-qoder-agent.agent", {
        agent: "qoder",
        label: "Qoder CLI",
        modes: ["url"],
        accountQuota: true, // 账号 credits 额度（GET /login/quota）
        dependencyHint: "Qoder 独立 CLI（qodercli / qoderclicn，CC 协议族 headless agent；非 IDE 启动命令 `qoder`）",
        auth: [
          { kind: "file", path: [".qoder", ".auth", "user"], label: "~/.qoder/.auth/user" },
          { kind: "file", path: [".qoder-cn", ".auth", "user"], label: "~/.qoder-cn/.auth/user" },
        ],
        accountSlots: (c: { home: string }) => [
          { key: "qoder-user", label: "凭据（国际版）", path: join(c.home, ".qoder", ".auth", "user") },
          { key: "qoder-cn-user", label: "凭据（中国版）", path: join(c.home, ".qoder-cn", ".auth", "user") },
        ],
      });
      // P2 协议委托 launch 服务已并入 scanQoderBackends（rescan 重扫时同样刷新）
    },

    /** Backend rescan (POST /api/session-backends/rescan): re-run the probe pass —
     *  CLIs installed after host boot light up without a restart; missing ones stay
     *  greyed out with the install hint. */
    rescanBackends(ctx: {
      sessionProviders: QoderScanSlot;
      services?: { provide<T>(key: string, impl: T): () => void };
    }) {
      const r = scanQoderBackends(ctx.sessionProviders, ctx.services?.provide);
      console.log(`[aiti-qoder-agent] rescan: ${r.registered.length} available / ${r.unavailable.length} not installed`);
      return r;
    },

    /** credits 也暴露为扩展级 API（无需先开会话即可查询）；受控登录 /login/* 优先（未登录时 sharedClient 为 null 也要可达）。 */
    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const recycled = await recycleApi(req, ctx);
      if (recycled) return recycled;
      const [action] = ctx.path;
      // 账号额度（浏览器 OAuth 档，WASM 解密凭据 → 官方 OpenAPI；未就绪也须可达）
      // 注意：必须在受控登录层之前——controlled-login 对未知 /login/* 返回 404 Response 会吞路由
      if (ctx.path[0] === "login" && ctx.path[1] === "quota" && ctx.method === "GET") {
        return quotaView(ctx.searchParams?.get("force") === "1");
      }
      const loginRes = loginApi ? await loginApi(req, ctx) : null;
      if (loginRes) return loginRes;
      const client = await ensureClient();
      if (!client) return null;
      if (action === "usage" && ctx.method === "GET") {
        try {
          return Response.json({ ok: true, region: client.region.name, usage: await fetchQoderUsage(client) });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (action === "models" && ctx.method === "GET") {
        try {
          const catalog = await client.listModels();
          return Response.json({ ok: true, models: catalog.map((m) => ({ id: m.key, label: m.display_name, reasoning: m.is_reasoning, vl: m.is_vl, priceFactor: m.price_factor })) });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
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

// WASM 客户端启动预热（异步不阻塞；失败不判死刑——消费点 ensureClient 带 60s 冷却自动重试，
// 「先部署后登录」时序下登录完成后首次查询即恢复）
void ensureClient();
