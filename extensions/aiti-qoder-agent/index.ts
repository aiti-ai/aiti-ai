/**
 * aiti-qoder-agent — 会话后端扩展：Qoder CLI 专属驱动 + 账号 credits。
 *
 * 驱动协议（2026-11-13 ACP 重写）：spawn `qodercli/qoderclicn --acp`（Agent Client
 * Protocol, JSON-RPC over stdio，见 qoder-acp.ts）。此前的 stream-json 双向协议
 * （system/init、assistant/result 帧、control_request/interrupt）随 qoderclicn
 * 1.1.81+ 移除 SDK worker 会话而断链（CLI 原话 "SDK worker sessions are no longer
 * supported"；headless 控制面只余 --acp，2026-11-13 全链路探针取证：session/cancel
 * 秒回、set_model/set_mode/plan 帧齐备）。宿主事件契约不变（message_start/update/end、
 * toolCall/toolResult 卡、agent_settled、permission_mode_changed、task_update）。
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
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { agentSpawnEnv, spawnEnvFeature, spawnDisplayEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch, captureSpawnEnvFeatures, spawnFeatureI18nEn } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, type QoderClient } from "./qoder-core.mjs";
import { qoderIdeSourceApi } from "./qoder-ide-source.ts";
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
  createInteractionLedger, deriveAskKind,
  type InteractionAnswer, type InteractionRecord,
} from "@aiti-ai/ext-shared/agent-interaction";
// 冷恢复工具行回放共享口径（权威源 _shared/seed-tool.ts；D18 四家归一，含空结果占位文案）
import { createSeedToolReplay, EMPTY_TOOL_ERROR, EMPTY_TOOL_OUTPUT } from "@aiti-ai/ext-shared/seed-tool";
import { qoderLoginBin, resolveQoderCli, qoderLoginDriver, type QoderVariant } from "./login-driver.ts";
import { AcpRpc } from "./qoder-acp.ts";
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

/** 某个 CLI 二进制的实际能力表（基表 + 探针门控的 steer；只认 ACP 驱动证据）。 */
function qoderCapabilitiesFor(cliPath: string | null | undefined): SessionCapabilitiesLike {
  return withSteerGate(QODER_CAPABILITIES, steerProbePassed(steerProbeBook, cliPath, "acp"));
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
 * With an active off-peak window (promotion.active, e.g. 22:00-08:00 at 40%) shows the
 * discounted effective factor — matching the CLI's actual charge; otherwise the catalog
 * factor (the discount teaser is the badge's job, see catalogBadge).
 */
function priceFactorHint(m: { price_factor?: unknown; original_price_factor?: unknown; promotion?: { active?: unknown; discount_factor?: unknown } }): string | undefined {
  const pf = typeof m.price_factor === "number" && Number.isFinite(m.price_factor) ? m.price_factor : null;
  if (pf === null) return undefined;
  const df = m.promotion?.discount_factor;
  if (m.promotion?.active === true && typeof df === "number" && Number.isFinite(df)) {
    return `${trimFactor(pf * df)}x`;
  }
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  const orig = typeof m.original_price_factor === "number" && Number.isFinite(m.original_price_factor) && m.original_price_factor > pf
    ? m.original_price_factor
    : null;
  return orig !== null ? `${trim(pf)}x→${trim(orig)}x` : `${trim(pf)}x`;
}

/** Same trailing-zero trim as priceFactorHint (shared by the promo branch; a separate function keeps the two branches decoupled). */
function trimFactor(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Catalog metadata → selector-row badge (an {en,zh} pair the host renders in the current
 * language; mirrors the official CLI's "New"/"Free"/off-peak corner marks). Priority:
 * server off-peak promotion (badge ships its own bilingual copy, passed through) >
 * free (is_free) > New (tags); the badge slot is single, so the most actionable hit wins.
 */
function catalogBadge(m: { is_free?: unknown; tags?: unknown; promotion?: { badge?: unknown } }): ExtModelEntry["badge"] {
  const promo = m.promotion?.badge;
  if (promo && typeof promo === "object") {
    const b = promo as { en?: unknown; zh?: unknown };
    const en = typeof b.en === "string" && b.en.trim() ? b.en.trim() : "";
    const zh = typeof b.zh === "string" && b.zh.trim() ? b.zh.trim() : "";
    if (en || zh) return { en: en || zh, zh: zh || en };
  }
  if (m.is_free === true) return { en: "Free", zh: "免费" };
  if (Array.isArray(m.tags) && m.tags.some((t) => t === "new")) return { en: "New", zh: "New" };
  return undefined;
}

/**
 * 模型目录核心（handle 方法与注册级静态 listModels 共用）：
 * 网关目录（WASM 签名拉取，client 可为 null——未就绪时静默降级为仅 pi 目录）
 * + pi 目录（models.json 实时扁平化，"pi" 分组）。当前模型置顶。
 * enable:false rows are no longer filtered out (2026-11-25 retrospective: with quota
 * exhausted the server disables every model, and filtering them all made the catalog
 * look broken) — keep them flagged disabled and let the host render them greyed; when
 * everything is disabled the selector shows why at a glance instead of leaving only
 * the pi catalog, misread as a code regression.
 */
async function qoderCatalog(client: QoderClient | null, current?: { id: string; provider: string }): Promise<ExtModelEntry[]> {
  const external: ExtModelEntry[] = [];
  if (client) {
    try {
      for (const m of await client.listModels()) {
        const hint = priceFactorHint(m);
        const badge = catalogBadge(m);
        external.push({
          id: m.key,
          provider: "qoder",
          label: m.display_name || m.key,
          source: "ext",
          ...(m.enable === false ? { disabled: true } : {}),
          ...(hint ? { hint } : {}),
          ...(badge ? { badge } : {}),
        });
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
 * Per-session usage from the qodercli native transcript
 * (`~/.qoder{,-cn}/projects/<cwd-encoded>/<sid>.jsonl`). The ACP surface reports no
 * token counts (usage all zeros), but each assistant record's usage carries the real
 * `context_usage_ratio` (current context share, dropping after compaction) and
 * per-turn `credits` (actually charged). Neither is fabricated: ratio is only
 * converted to a percentage, credits only summed.
 */
type NativeSessionUsage = { percent?: number; credits?: number; model?: string };
const NATIVE_USAGE_SYNC_READ_MAX = 8 * 1024 * 1024; // sync-read cap (engineering red line: no sync reads over 8MB)
const NATIVE_USAGE_TAIL_BYTES = 2 * 1024 * 1024;
const nativeSessionPathCache = new Map<string, string>();
const nativeUsageCache = new Map<string, { key: string; usage: NativeSessionUsage }>();

/** Transcript path: the projects dir shards by cwd, and shard-name casing/escaping varies
 * across versions (both d-- and D-- seen) → scan the directories. */
function resolveNativeSessionFile(nativeSid: string): string | undefined {
  const cached = nativeSessionPathCache.get(nativeSid);
  if (cached && existsSync(cached)) return cached;
  for (const home of [".qoder-cn", ".qoder"]) {
    const projects = join(homedir(), home, "projects");
    let dirs: string[];
    try { dirs = readdirSync(projects); } catch { continue; }
    for (const dir of dirs) {
      const fp = join(projects, dir, `${nativeSid}.jsonl`);
      if (existsSync(fp)) {
        nativeSessionPathCache.set(nativeSid, fp);
        return fp;
      }
    }
  }
  return undefined;
}

function readTailText(fp: string, size: number, bytes: number): string {
  const fd = openSync(fp, "r");
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function scanNativeUsage(text: string, usage: { percent?: number; credits?: number; model?: string }): void {
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') && !line.includes('"model"')) continue;
    let rec: { type?: unknown; model?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } };
    try { rec = JSON.parse(line); } catch { continue; }
    // runtime-config is written at session start; assistant records repeat the model.
    // Either is the CLI's own answer — the host start options often carry no model.
    if (typeof rec?.message?.model === "string" && rec.message.model) usage.model = rec.message.model;
    else if (rec?.type === "runtime-config" && typeof rec.model === "string" && rec.model) usage.model = rec.model;
    const u = rec?.message?.usage;
    if (!u || typeof u !== "object") continue;
    const ratio = u.context_usage_ratio;
    if (typeof ratio === "number" && Number.isFinite(ratio)) usage.percent = Math.min(100, Math.max(0, ratio * 100));
    const c = u.credits;
    if (typeof c === "number" && Number.isFinite(c)) usage.credits = (usage.credits ?? 0) + c;
  }
}

function readNativeSessionUsage(nativeSid: string): NativeSessionUsage | undefined {
  const fp = resolveNativeSessionFile(nativeSid);
  if (!fp) return undefined;
  try {
    const st = statSync(fp);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = nativeUsageCache.get(fp);
    if (hit && hit.key === key) return hit.usage;
    const usage: NativeSessionUsage = {};
    if (st.size <= NATIVE_USAGE_SYNC_READ_MAX) {
      scanNativeUsage(readFileSync(fp, "utf8"), usage);
    } else {
      // Over the cap, read only the tail: the ratio is a tail fact; credits needs a
      // full sum, so when unavailable the whole entry is absent (never fabricated).
      scanNativeUsage(readTailText(fp, st.size, NATIVE_USAGE_TAIL_BYTES), usage);
      delete usage.credits;
    }
    nativeUsageCache.set(fp, { key, usage });
    return usage;
  } catch {
    return undefined;
  }
}

/**
 * 基能力表（**不是**最终值：`steer` 由探针门控逐 CLI 覆盖，见 qoderCapabilitiesFor）。
 */
const QODER_CAPABILITIES: SessionCapabilitiesLike = {
  // ACP 驱动（2026-11-13 重写）：运行中注入 = 在途 session/prompt 旁再发一条
  // session/prompt（CLI initialize 自报 `_meta.qoder.promptQueueing`，入队默认
  // priority:"next" → AgentLoop 工具间隙吸收）。能力位仍由 ACP 实跑探针开门
  // （tools/steer-probe-acp.mjs --record → steer-gate.ts）；无证据 = 运行中输入
  // 一律入本地 followUp 队列。
  steer: false,
  followUp: true,
  queueManage: true, // 共享层全 CRUD（followUp 组；steer 组只读——注入后归 CLI 自己的队列管）
  getMessages: true,
  // Context share: arrives opportunistically in ACP usage_update frames; when absent,
  // fall back to the native transcript's context_usage_ratio (the host has outlets in
  // both get_state and get_session_stats).
  contextUsage: true,
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

/**
 * pi-native user content for `liveHistory` (host `UserMessage` shape: text block + base64
 * image blocks). The mirror must carry the images: the host compares its optimistic bubble
 * with the loaded copy through `userMessageKey()`, which hashes every image block — a
 * text-only mirror fails that comparison, so the bubble (with its pictures) is replaced by
 * a picture-less one and the sent image disappears from the transcript.
 */
function historyUserContent(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
): string | Array<Record<string, unknown>> {
  if (!images?.length) return text;
  const content: Array<Record<string, unknown>> = text ? [{ type: "text", text }] : [];
  for (const img of images) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
  }
  return content;
}

/** Replayed user image chunk → pi image block (ACP carries {type:"image", data, mimeType}). */
function replayImageBlock(content: Record<string, unknown>): Record<string, unknown> | null {
  if (content.type !== "image" || typeof content.data !== "string" || !content.data) return null;
  const mimeType = typeof content.mimeType === "string" && content.mimeType ? content.mimeType : "image/png";
  return { type: "image", source: { type: "base64", media_type: mimeType, data: content.data } };
}

/**
 * `IndexedMessage.images` → pi image blocks for cold history replay. Inline base64 data
 * URLs stay inline; remote URLs (Qoder uploads a pasted screenshot to its own storage and
 * records the signed URL) become URL-sourced blocks the renderer loads directly.
 */
function seedHistoryImages(images: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(images)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of images) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { mime?: unknown; dataUrl?: unknown };
    const dataUrl = typeof rec.dataUrl === "string" ? rec.dataUrl : "";
    if (!dataUrl) continue;
    const inline = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (inline) {
      out.push({ type: "image", source: { type: "base64", media_type: inline[1], data: inline[2] } });
      continue;
    }
    if (/^https?:\/\//i.test(dataUrl)) {
      const mime = typeof rec.mime === "string" && rec.mime ? rec.mime : undefined;
      out.push({ type: "image", source: { type: "url", ...(mime ? { media_type: mime } : {}), url: dataUrl } });
    }
  }
  return out;
}

// ============================================================================
// QoderHandle —— 驱动 qodercli/qoderclicn（ACP: Agent Client Protocol over stdio）
// ============================================================================

/** 导出仅供单测直接驱动（宿主 loader 只消费 default 导出）。 */
/**
 * Injected by the pi-web core (`agent-starter`). Older hosts do not pass it — the
 * extension then keeps its historical `child_process.spawn`. With the detachable
 * variant the long-lived `--acp` process outlives pi-web and a reattach adopts it
 * (see `QoderHandle.adopt`).
 */
export interface AgentStarterLike {
  readonly kind: "direct" | "wrapper";
  spawn(
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      shell?: boolean | string;
      agentKey?: string;
      sessionId?: string;
    },
  ): Promise<ChildProcess>;
}

/** Adopt an already-live agent process (core recovery after a pi-web restart). */
export interface AttachedChildOptions {
  child: ChildProcess;
  sessionId: string;
  agentKey?: string;
}

/** Core signal: the wrapper's journal replay ended, live frames start here. */
const REPLAY_END_EVENT = "replay_end";

/** One entry of the persisted qoder history store (session-manager parse output). */
type SeedHistoryMessage = {
  role?: unknown;
  text?: unknown;
  model?: unknown;
  provider?: unknown;
  tool?: unknown;
  /** session-manager `IndexedMessage.images` ({mime, dataUrl}): data: URL or remote URL. */
  images?: unknown;
};

/**
 * IndexedMessage[] → liveHistory entries, without touching any handle state.
 *
 * Shared by seedHistory (append) and the adopt path (compare against a wrapper-journal
 * replay and replace when the store is longer), so the two cannot drift in shape.
 *
 * The session-manager store has no per-message model (only a session-level meta.model),
 * so replayed assistant rows would render the provider id ("aiti-qoder-agent") as their
 * model label. `fallbackModel` (the native transcript's message.model) fills that in.
 */
function seedHistoryEntries(messages: SeedHistoryMessage[], fallbackModel?: string): unknown[] {
  const out: unknown[] = [];
  const replay = createSeedToolReplay("qoder-tool");
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const model = (typeof m.model === "string" && m.model) || fallbackModel || "";
    const provider = typeof m.provider === "string" && m.provider ? m.provider : "aiti-qoder-agent";
    const tool = role === "assistant" ? replay.entries(m.tool, { model, provider }) : null;
    if (tool) {
      out.push(...tool);
      continue;
    }
    const text = typeof m.text === "string" ? m.text : "";
    const images = role === "user" ? seedHistoryImages(m.images) : [];
    // An image-only prompt row is a real turn: replay it instead of dropping it.
    if (!text.trim() && images.length === 0) continue;
    out.push(
      role === "assistant"
        ? { role, content: [{ type: "text", text }], model, provider }
        : {
          role,
          content: images.length === 0
            ? text
            : [...(text ? [{ type: "text", text }] : []), ...images],
        },
    );
  }
  return out;
}

export class QoderHandle {
  source: string;
  /** 能力表（ACP 驱动：steer 由 ACP 探针门控，未取证时运行中输入走本地队列）。 */
  readonly capabilities: SessionCapabilitiesLike;
  /** 本会话 CLI 二进制路径（日志/排障用）。 */
  readonly cliPath: string;
  id: string;
  readonly cwd: string;
  readonly variant: "intl" | "cn";

  private child: ChildProcess;
  /** ACP JSON-RPC 传输层（session/prompt、session/cancel、set_mode/set_model 全走它）。 */
  private acp: AcpRpc | null = null;
  /** WASM 客户端（异步预热；就绪前 getUsage/getAvailableModels 静默降级）。 */
  private client: QoderClient | null;
  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  /**
   * 在途 session/prompt 计数（主轮 + 运行中注入）。注入轮可能在主轮之后另起一段
   * agent loop——计数器归零才算整轮收口（agent_settled 只发一次，UI 不会在中途闪回空闲）。
   */
  private promptsInFlight = 0;
  /** 注入序号（steer 镜像 id 用；协议无 ack，镜像随该请求响应出队）。 */
  private steerSeq = 0;
  /** CLI 在 initialize 里自报的 ACP prompt queueing 能力（`_meta.qoder.promptQueueing`）。 */
  private promptQueueing = false;
  private model: { id: string; provider: string } | undefined;
  /** 最近一轮 usage（session/prompt 响应机会式提取；部分版本恒缺） */
  private lastUsage: {
    model?: string; inputTokens?: number; outputTokens?: number;
    cacheReadTokens?: number; cacheWriteTokens?: number;
  } | undefined;
  /** 上下文用量（agent 的 session/update:usage_update 帧：{used,size}，机会式）。 */
  private lastContextUsage: { tokens: number; contextWindow: number } | undefined;
  /** 会话累计用量（有 usage 帧才累加；getUsageTotals 数据源） */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  /** session/cancel 后等待 prompt 收口的时长；超时转硬杀（测试可覆盖） */
  static CANCEL_SETTLE_TIMEOUT_MS = 5_000;
  /** 硬杀宽限（SIGTERM → 该时长后 SIGKILL）；测试可覆盖 */
  static HARD_KILL_GRACE_MS = 1_000;
  /** 直播期工具调用账本：toolCallId → 工具/入参（tool_call_update completed 回填结果，方案 X） */
  private toolCallOpen = new Map<string, { name: string; input: unknown }>();
  /**
   * 未决应答账本（共享层 agent-interaction）：session/request_permission 进、respondInteraction 出。
   * 键集即「仍在等待应答的请求」——turn 收口 / markDead 时逐个 interaction_expired
   * 解锁前端；sidecar 落盘 + subscribe 重发解决「刷新/重建后卡片没了、CLI 还在等」。
   * ⚠ field 初始化器早于 ctor body（此刻 id 还是占位值）→ sidecar 路径惰性取 this.id。
   */
  private interactions = createInteractionLedger({
    emit: (e) => this.emit(e as unknown as Record<string, unknown>),
    sidecarFile: () => (interactionDir && realSidOf(this.id) ? join(interactionDir, sidecarBase(this.id)) : undefined),
    record: (n) => this.recordInteractionCustom(n),
  });
  /** 未决权限请求（interaction requestId → JSON-RPC id + 选项 + response resolver）。 */
  private permissionWaiters = new Map<string, {
    rawId: number; allowOpt?: string; denyOpt?: string;
    resolve: (result: unknown) => void;
  }>();
  /** 流式气泡双线（agent_thought_chunk / agent_message_chunk 各一条），收口时落 message_end。 */
  private thinkingAcc: { contentIndex: number; text: string } | null = null;
  private textAcc: { contentIndex: number; text: string } | null = null;
  private contentSeq = 0;
  private messageStarted = false;
  /** initialize→session/new|load 完成前不受理 prompt：等待者挂 Promise（事件驱动，非轮询）。 */
  private sessionReady = false;
  private readyWaiters: Array<() => void> = [];
  /** Hosting restart: replace partial live history with the previous handle's full copy. */
  restoreHistory(messages: unknown[]): void {
    if (!Array.isArray(messages) || messages.length <= this.liveHistory.length) return;
    this.liveHistory = messages.slice();
  }

  /**
   * Public readiness seam for hosting switches and read routes: resolves after
   * session/new|load AND, for an adopted handle, after the persisted history seed.
   *
   * An adopt sets `sessionReady` immediately (the ACP session already exists), so the
   * replay/history window used to be invisible to readers: the context route returned an
   * empty transcript and the page never re-read (2026-11-23 qoder: messages appeared, then
   * vanished / stayed empty on reopen).
   */
  async waitUntilReady(): Promise<void> {
    await this.waitSessionReady();
    if (this.historyReady) await this.historyReady;
  }

  /** bootstrap 完成前挂起；markDead 时放行（后半段 aliveFlag 检查会 fail-loud）。 */
  private waitSessionReady(): Promise<void> {
    if (this.sessionReady) return Promise.resolve();
    if (!this.aliveFlag) return Promise.reject(new Error("[aiti-qoder-agent] not running"));
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }
  /** session/load 历史回放窗口：update 静默采集进 liveHistory，不发直播帧。 */
  private loading = false;
  /** Replay + history seed of an adopted handle: watchers wait on it via waitUntilReady. */
  private historyReady: Promise<void> | null = null;
  private releaseHistoryReady: (() => void) | null = null;
  /** session/load 历史回放的 assistant 文本累积（回放完成时落一条 liveHistory）。 */
  private replayAssistant = "";
  /** session/new|load 响应的 ACP 目录快照（权限档 + 模型清单）。 */
  private acpModes: { availableModes: Array<{ id: string; name?: string; description?: string }>; currentModeId?: string } | null = null;
  private acpModels: Array<{ modelId: string; name?: string; description?: string }> = [];
  /**
   * 会话级快照（原 init 帧）：commands = slash 目录（available_commands_update 喂），
   * permissionMode = CC 档名（ACP modeId 经映射）。
   */
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  private permissionMode: string | undefined;

  private resetStream(): void {
    this.thinkingAcc = null;
    this.textAcc = null;
    this.messageStarted = false;
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
    // ACP 驱动：steer = 在途 session/prompt 旁再发一条（CLI 自报 promptQueueing）。
    // 能力位与行为同一把门：只有 ACP 探针 pass 才给共享层挂 steer 钩子。
    const steerOn = steerProbePassed(steerProbeBook, cliPath, "acp");
    this.capabilities = withSteerGate(QODER_CAPABILITIES, steerOn);
    this.queueSupport = createBackendQueueSupport({
      isRunning: () => this.running || !this.aliveFlag,
      alive: () => this.aliveFlag,
      dispatch: (text, images) => this.prompt(text, images?.length ? { images: images as never } : {}),
      ...(steerOn ? { steer: (text, images) => this.injectSteer(text, images as never) } : {}),
      onEvent: (ev) => this.emit(ev),
      log: (m) => console.warn(`[aiti-qoder-agent] ${m}`),
      // steer 钩子缺省 = 运行中输入一律本地排队；开着时注入失败由共享层降级入队。
      persistence: createQueueFilePersistence(
        () => (queueStateDir ? join(queueStateDir, "queues", sidecarBase(this.id)) : undefined),
        (m) => console.warn(m),
      ),
    });
    // ACP JSON-RPC 传输层：session/update → 事件映射（onAcpNotification）；
    // agent 反向请求（session/request_permission 等）→ onAcpRequest。
    this.acp = new AcpRpc(child, {
      onRequest: (method, params, rawId) => this.onAcpRequest(method, params, rawId),
      onNotification: (method, params) => this.onAcpNotification(method, params),
    }, (m) => console.log(`[aiti-qoder-agent] ${m}`));
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
    this.acp?.close();
    this.promptsInFlight = 0; // 传输已关：在途请求永远不会再响应
    for (const w of this.readyWaiters.splice(0)) w(); // 挂起的 prompt 放行 → 后半段 aliveFlag 检查抛错
    
    // 未决权限请求随进程一起作废（resolve cancelled，避免 CLI 侧悬挂等响应）
    for (const [, w] of [...this.permissionWaiters.entries()]) {
      try { w.resolve({ outcome: { outcome: "cancelled" } }); } catch { /* 桩响应失败无害 */ }
    }
    this.permissionWaiters.clear();
    // 未决应答随进程一起作废：必须通知前端解锁（否则批准对话框挂在死会话上）
    this.interactions.failPending("dead");
    // 流式/工具账本清零：进程已死，未闭合的块与未配对的 tool_use 不再有未来（Map 留着是泄漏）
    this.toolCallOpen.clear();
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

  // ==========================================================================
  // ACP inbound: notifications (session/update, mode changes) and agent requests
  // (session/request_permission). Maps the ACP surface onto the host event
  // contract (message_start/update/end, toolCall/toolResult cards, task_update,
  // permission_mode_changed) — host sees no difference from the old stream-json era.
  // ==========================================================================

  private onAcpNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const update = (params as Record<string, unknown> | undefined)?.update;
      if (update && typeof update === "object") this.onSessionUpdate(update as Record<string, unknown>);
      return;
    }
    if (method === "session/current_mode_update") {
      const modeId = String((params as Record<string, unknown> | undefined)?.currentModeId ?? "");
      if (modeId) this.applyPermissionMode(this.modeIdToCc(modeId));
      return;
    }
    // Unknown notifications (session/set_model_confirm etc.) are ignored.
  }

  private onSessionUpdate(u: Record<string, unknown>): void {
    const kind = String(u.sessionUpdate ?? "");
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = (u.content ?? u.contentBlock ?? {}) as Record<string, unknown>;
      const text = typeof content.text === "string" ? content.text : "";
      if (!text) return;
      if (this.loading) {
        // session/load replay: silently accumulate into liveHistory, no live frames.
        if (kind === "agent_message_chunk") this.replayAssistant += text;
        return;
      }
      if (kind === "agent_message_chunk") {
        // 不在这里置 running：回合由 sendPromptTurn 置真、响应收口；超时后 CLI 仍会
        // 推迟到 chunk，置真会让已放弃的回合永远「运行中」（无后续帧可收口）。
        this.appendChunk("text", text);
      } else {
        this.appendChunk("thinking", text);
      }
      return;
    }
    if (kind === "user_message_chunk") {
      // session/load replay carries the user turns; live runs never send these.
      if (!this.loading) return;
      const content = (u.content ?? u.contentBlock ?? {}) as Record<string, unknown>;
      const text = typeof content.text === "string" ? content.text : "";
      this.flushStreamMessages(); // assistant replay segment before this user turn ends here
      // ACP replays one content block per chunk, so a prompt that carried a picture
      // arrives as text chunk(s) plus an image chunk. Fold the image into the user entry
      // right before it: a separate entry would show the picture as its own bubble.
      const image = replayImageBlock(content);
      if (image) {
        const last = this.liveHistory[this.liveHistory.length - 1] as { role?: unknown; content?: unknown } | undefined;
        if (last?.role === "user") {
          const prior = typeof last.content === "string"
            ? (last.content ? [{ type: "text", text: last.content }] : [])
            : Array.isArray(last.content) ? last.content : [];
          last.content = [...prior, image];
        } else {
          this.liveHistory.push({ role: "user", content: [image] });
        }
        return;
      }
      if (text.trim()) this.liveHistory.push({ role: "user", content: text });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.onToolCallUpdate(u, kind === "tool_call");
      return;
    }
    if (kind === "plan") {
      // ACP native plan entries → task-list mirror (TodoWrite-derived in the old protocol).
      const entries = Array.isArray(u.entries) ? u.entries as Array<Record<string, unknown>> : [];
      const todos = entries.flatMap((e) => {
        const content = typeof e.content === "string" ? e.content.trim() : "";
        if (!content) return [];
        const status = e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending";
        const priority = e.priority === "high" ? "high" : e.priority === "low" ? "low" : "medium";
        return [{ content, status, priority } as Record<string, unknown>];
      });
      this.tasks.apply(todos as never);
      return;
    }
    if (kind === "available_commands_update") {
      const cmds = Array.isArray(u.availableCommands) ? u.availableCommands as Array<Record<string, unknown>> : [];
      this.commands = cmds.flatMap((c) => {
        const name = typeof c?.name === "string" ? c.name : "";
        if (!name) return [];
        return [{
          name,
          ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
          source: "skill",
        }];
      });
      return;
    }
    if (kind === "usage_update") {
      const used = Number(u.used);
      const size = Number(u.size);
      if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
        this.lastContextUsage = { tokens: used, contextWindow: size };
      }
      return;
    }
    // Unknown update kinds (agent_info_update, current_mode inside update, ...) are ignored.
  }

  /** tool_call (new call) / tool_call_update (progress/result) → host tool cards (方案 X). */
  private onToolCallUpdate(u: Record<string, unknown>, isCall: boolean): void {
    const id = String(u.toolCallId ?? "");
    const meta = (u._meta ?? {}) as Record<string, unknown>;
    const qmeta = (meta.qoder ?? {}) as Record<string, unknown>;
    // The real CLI tool name lives in _meta.qoder.toolName; `title` is a human-friendly label.
    const name = typeof qmeta.toolName === "string" && qmeta.toolName ? qmeta.toolName
      : typeof u.title === "string" && u.title ? u.title : "tool";
    if (isCall) {
      const input = (u.rawInput ?? {}) as Record<string, unknown>;
      const alreadyCarded = id ? this.toolCallOpen.has(id) : false;
      if (id && !alreadyCarded) this.toolCallOpen.set(id, { name, input });
      // 任务列表主通道：TodoWrite 族工具入参（协议兜底；ACP 原生 plan 帧是第一通道）
      this.tasks.fromToolEvent(name, input);
      const status = String(u.status ?? "pending");
      // 出卡：pending/in_progress 直播即时出；completed（含 session/load 回放的单帧态）
      // 也必须出卡——只有 toolResult 没有调用卡时，刷新回放会变成匿名结果行。
      const model = this.effectiveModel();
      const cardMsg = {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: id, toolName: name, input }],
        model: model?.id ?? "",
        provider: model?.provider ?? "aiti-qoder-agent",
        timestamp: Date.now(),
      };
      if (!alreadyCarded) {
        this.liveHistoryPush(cardMsg);
        if (!this.loading) this.emit({ type: "message_end", message: cardMsg });
      }
      if (status === "completed" || status === "failed") {
        this.toolCallOpen.delete(id);
        this.emitToolResult(id, name, input, u);
      }
      return;
    }
    // tool_call_update
    const status = String(u.status ?? "");
    if (status !== "completed" && status !== "failed") return; // in_progress etc.
    const open = this.toolCallOpen.get(id);
    this.toolCallOpen.delete(id);
    this.emitToolResult(id, open?.name ?? name, open?.input ?? {}, u);
  }

  private emitToolResult(id: string, name: string, input: unknown, u: Record<string, unknown>): void {
    // content[] blocks (text/diff) or rawOutput — same fallback chain as the old tool_result path.
    const blocks = Array.isArray(u.content) ? u.content as Array<Record<string, unknown>> : [];
    const texts: string[] = [];
    for (const b of blocks) {
      const inner = (b.content ?? b) as Record<string, unknown>;
      if (typeof inner.text === "string") texts.push(inner.text);
      else if (typeof b.rawText === "string") texts.push(b.rawText);
      else if (b.type === "diff") texts.push(`[diff] ${typeof b.path === "string" ? b.path : ""}`);
    }
    if (!texts.length && typeof u.rawOutput === "string") texts.push(u.rawOutput);
    const outText = texts.join("\n").trim();
    const isError = u.status === "failed";
    // 任务列表第二通道（input 优先、output 兜底）：部分 CLI 把新列表回显在结果里
    this.tasks.fromToolEvent(name, input, outText);
    const resultMsg = {
      role: "toolResult",
      ...(id ? { toolCallId: id } : {}),
      ...(name ? { toolName: name } : {}),
      content: [{ type: "text", text: (outText || (isError ? EMPTY_TOOL_ERROR : EMPTY_TOOL_OUTPUT)).slice(0, 4000) }],
      ...(isError ? { isError: true } : {}),
      timestamp: Date.now(),
    };
    this.liveHistory.push(resultMsg);
    if (!this.loading) this.emit({ type: "message_end", message: resultMsg });
  }

  // ---- streaming bubbles (thinking / text lines), closed at turn end ----

  private ensureMessageStart(): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    const model = this.effectiveModel();
    this.emit({
      type: "message_start",
      role: "assistant",
      message: { role: "assistant", content: [], model: model?.id ?? "", provider: model?.provider ?? "aiti-qoder-agent" },
    });
  }

  private appendChunk(kind: "text" | "thinking", text: string): void {
    this.ensureMessageStart();
    let acc = kind === "text" ? this.textAcc : this.thinkingAcc;
    if (!acc) {
      acc = { contentIndex: this.contentSeq++, text: "" };
      if (kind === "text") this.textAcc = acc; else this.thinkingAcc = acc;
      this.emit({ type: "message_update", assistantMessageEvent: { type: kind === "thinking" ? "thinking_start" : "text_start", contentIndex: acc.contentIndex } });
    }
    acc.text += text;
    this.emit({
      type: "message_update",
      // top-level delta feeds the adapter's partialText snapshot (reconnect backfill)
      ...(kind === "text" ? { delta: text } : {}),
      assistantMessageEvent: { type: kind === "thinking" ? "thinking_delta" : "text_delta", contentIndex: acc.contentIndex, delta: text },
    });
  }

  /** session/load replay tail: accumulated assistant text lands as one liveHistory entry. */
  private flushReplayAssistant(): void {
    if (this.replayAssistant.trim()) {
      const model = this.effectiveModel();
      this.liveHistory.push({
        role: "assistant",
        content: [{ type: "text", text: this.replayAssistant }],
        model: model?.id ?? "",
        provider: model?.provider ?? "aiti-qoder-agent",
      });
    }
    this.replayAssistant = "";
  }

  /** Turn-end flush: bubble thinking/text lines as message_end entries (live history order). */
  private flushStreamMessages(): void {
    const flushOne = (acc: { contentIndex: number; text: string } | null, kind: "thinking" | "text") => {
      if (!acc) return;
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: kind === "thinking" ? "thinking_end" : "text_end", contentIndex: acc.contentIndex, content: acc.text },
      });
      if (acc.text.trim()) {
        const block = kind === "thinking" ? { type: "thinking", thinking: acc.text } : { type: "text", text: acc.text };
        const model = this.effectiveModel();
        const groupMsg = {
          role: "assistant",
          content: [block],
          model: model?.id ?? "",
          provider: model?.provider ?? "aiti-qoder-agent",
          timestamp: Date.now(),
        };
        this.liveHistoryPush(groupMsg);
        this.emit({ type: "message_end", message: groupMsg });
      }
    };
    flushOne(this.thinkingAcc, "thinking");
    flushOne(this.textAcc, "text");
    this.resetStream();
  }

  // ---- agent→client requests ----

  private onAcpRequest(method: string, params: unknown, rawId: number): Promise<unknown> | unknown {
    if (method === "session/request_permission") {
      return this.handlePermissionRequest(params as Record<string, unknown>, rawId);
    }
    // fs/* should never arrive (initialize declares no fs capabilities) — fail loudly so
    // silent client-side execution expectations never appear.
    throw new Error(`[aiti-qoder-agent] unsupported agent request: ${method}`);
  }

  /**
   * session/request_permission → interaction ledger (kind-derived cards, same UX as the
   * old can_use_tool path). The JSON-RPC response stays pending until respondInteraction
   * (or turn end / death) settles it.
   */
  private handlePermissionRequest(params: Record<string, unknown>, rawId: number): Promise<unknown> {
    const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
    // Pick allow/deny options by ACP kind (allow_once/allow_always vs deny_once/reject_once).
    const kindOf = (o: Record<string, unknown> | undefined) => String(o?.kind ?? o?.optionKind ?? "");
    const allowOpt = options.find((o) => kindOf(o).startsWith("allow"))?.optionId as string | undefined;
    const denyOpt = options.find((o) => kindOf(o).startsWith("deny") || kindOf(o).startsWith("reject"))?.optionId as string | undefined;
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const tcMeta = ((toolCall._meta ?? {}) as Record<string, unknown>).qoder as Record<string, unknown> | undefined;
    const toolName = (typeof tcMeta?.toolName === "string" && tcMeta.toolName)
      || (typeof toolCall.title === "string" ? toolCall.title : undefined);
    const input = toolCall.rawInput ?? {};
    const requestId = `perm-${rawId}`;
    const kind = deriveAskKind(toolName, input);
    const questions = (input as Record<string, unknown> | undefined)?.questions;
    const plan = typeof (input as Record<string, unknown> | undefined)?.plan === "string"
      ? ((input as Record<string, unknown>).plan as string)
      : undefined;
    this.interactions.open({ requestId, kind, toolName, input, ...(questions ? { questions } : {}), ...(plan ? { plan } : {}) });
    return new Promise<unknown>((resolve) => {
      this.permissionWaiters.set(requestId, { rawId, allowOpt, denyOpt, resolve });
    });
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
    /** Injected by the pi-web core (detachable hosting); absent = plain spawn. */
    agentStarter?: AgentStarterLike;
    /** Core recovery: adopt this live process instead of spawning. */
    attached?: AttachedChildOptions;
  }): Promise<QoderHandle> {
    if (opts.attached) return QoderHandle.adopt(opts, opts.attached.child, opts.attached.sessionId);
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
    // ACP 驱动（qoderclicn 1.1.81+ 移除 stream-json SDK worker 的入站控制通道）：
    // 长驻 `--acp` 进程，控制面走 JSON-RPC（session/prompt、session/cancel、set_mode/set_model）。
    // 起步最大权限在 bootstrap 里用 session/set_mode("yolo") 设置（对应原 --permission-mode
    // bypass_permissions）；模型种子在 bootstrap 里 session/set_model。
    const args = [
      "--acp",
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
    // One native key shared by the detached registry and the provisional handle id
    // (the ACP session id only arrives with the session/new response).
    const nativeKey = opts.sessionId ?? `${PLACEHOLDER_MARK}${randomUUID()}`;
    const child = opts.agentStarter
      ? await opts.agentStarter.spawn(launch.command, launch.args, {
          cwd,
          env: launch.env as Record<string, string>,
          agentKey,
          sessionId: nativeKey,
        })
      : spawn(launch.command, launch.args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: launch.env,
        });
    const provisionalId = `${agentKey}:${nativeKey}`;
    // cliPath 传 CLI 本体（不是启动包装）：steer 门控的证据键要落在实际执行注入的二进制上，
    // spawn.command/launchOverride 只是外层 wrapper，换 wrapper 不该让探针结论失效。
    const handle = new QoderHandle(provisionalId, child, opts.client, cwd, opts.variant, cli);
    if (seedModel) handle.model = { id: seedModel, provider: "qoder" };
    // Hosting switch restarts the process: if the CLI's session/load replay is
    // empty, fall back to the source index so the reopened session is not blank.
    if (Array.isArray(external?.messages) && external.messages.length > 0) {
      handle.sourceHistory = external.messages as typeof handle.sourceHistory;
    }
    // 接管既有会话：历史由 session/load 的 CLI 回放填充（比宿主索引 seedHistory 更权威——
    // 宿主侧历史是 CLI 会话的投影，双喂会重复）。metaCwd 已保证 load 在原项目目录里进行。
    // 启动即写状态文件（pi 目录快照 + selected），引导外部 agent
    handle.persistModelState();
    // ACP 握手 + 会话引导（异步不阻塞 start 返回；失败 → markDead → 前端复位）
    void handle.startSession({ sessionId: opts.sessionId, seedModel });
    return handle;
  }

  /**
   * Recovery: adopt the still-open `--acp` process the core reattached to.
   *
   * ACP is a stateful JSON-RPC stream, so the adopted handle must behave as the
   * SAME logical client that just reconnected: the agent sees one continuous stdio,
   * and re-running `initialize`/`session/new` would create a second session.
   * Therefore: no bootstrap (the negotiated session id is already known), and the
   * wrapper's journal replay is consumed as history — `loading` keeps
   * `session/update` frames out of the live stream until the replay boundary
   * (`replay_end`) arrives. Replayed responses carry request ids this client never
   * issued, so `AcpRpc` drops them (pending-map miss); replayed permission requests
   * stay answerable — a request that was genuinely pending before the restart is
   * exactly what this feature is meant to preserve.
   */
  private static adopt(
    opts: {
      cwd?: string;
      variant: "intl" | "cn";
      client?: QoderClient | null;
      model?: { provider: string; id: string };
    },
    child: ChildProcess,
    nativeSessionId: string,
  ): QoderHandle {
    const cli = resolveQoderCli(opts.variant) ?? qoderLoginBin(opts.variant);
    const { agentKey } = qoderVariant(opts.variant);
    const handle = new QoderHandle(`${agentKey}:${nativeSessionId}`, child, opts.client, opts.cwd || process.cwd(), opts.variant, cli);
    if (opts.model?.id) handle.model = { id: opts.model.id, provider: "qoder" };
    // The ACP session already exists in the live process: no handshake to replay.
    handle.sessionReady = true;
    handle.loading = true; // replay = history, not live streaming
    // Readers (context/state/hosting) wait for this, not just sessionReady: the replay tail
    // and the history seed are what make the transcript complete.
    handle.historyReady = new Promise<void>((resolve) => { handle.releaseHistoryReady = resolve; });
    let replayEnded = false;
    const endReplay = async () => {
      if (replayEnded) return;
      replayEnded = true;
      handle.loading = false;
      handle.flushStreamMessages();
      handle.flushReplayAssistant();
      // The wrapper journal replays a bounded tail of the PREVIOUS client's live frames.
      // After an adopt that tail is often shorter than the authoritative history store
      // (observed 2026-11-23: replay landed 1 frame while the store held the whole
      // conversation), and the old "seed only when the replay is empty" guard left the
      // page with an empty/partial transcript — history visibly disappeared after a
      // reconnect. Compare the two and let the longer one win: seed appends (empty
      // replay), restoreHistory replaces (store longer; it only ever grows).
      // AWAIT the seed: readiness (waitUntilReady / the context read's waitSessionReady) must
      // not resolve before the transcript exists, or the page projects an empty history and
      // never re-reads. The parse is local (ms) and failure is harmless.
      try {
        const external = await parseExternalSession(`${agentKey}:${nativeSessionId}`);
        const stored = Array.isArray(external?.messages) ? external.messages.length : 0;
        if (stored > 0) {
          const messages = external!.messages as SeedHistoryMessage[];
          // The store carries no per-message model; take it from the native transcript so
          // replayed rows show the model name, not the provider id.
          const fallbackModel = readNativeSessionUsage(nativeSessionId)?.model;
          if (handle.liveHistory.length === 0) handle.seedHistory(messages, fallbackModel);
          else {
            const mapped = seedHistoryEntries(messages, fallbackModel);
            if (mapped.length > handle.liveHistory.length) handle.restoreHistory(mapped);
          }
        }
      } catch { /* unreadable store: the replay tail is all we have */ }
      handle.releaseHistoryReady?.();
      handle.releaseHistoryReady = null;
      for (const w of handle.readyWaiters.splice(0)) w();
      // `resumed`: readiness announcement after an adopt, NOT a run start. A live run start
      // carries the plain shape; the frontend must not show "Waiting for model…" for this
      // one (an adopted idle backend otherwise looked like a run that never produced output).
      handle.emit({ type: "agent_start", sessionId: handle.id, model: handle.model, resumed: true });
    };
    const facade = child as unknown as { detachable?: unknown; on?: (event: string, listener: () => void) => unknown };
    if (facade.detachable === true && typeof facade.on === "function") {
      // Wrapper child: history arrives first, then the boundary.
      facade.on(REPLAY_END_EVENT, () => { void endReplay(); });
      // Older hosts predate the boundary event: the replay is one batch written
      // before any live traffic, so a short fallback keeps the session usable
      // (otherwise `loading` would swallow every update forever).
      setTimeout(() => {
        if (handle.loading) void endReplay();
      }, 3000).unref?.();
    } else {
      void endReplay(); // plain child: no journal, live from the start
    }
    return handle;
  }

  /**
   * ACP bootstrap: initialize → initialized → session/new | session/load → set_mode(yolo)
   * → set_model(seed). Failures land in markDead so the frontend settles (session_backend_dead)
   * instead of hanging on a half-open session. agent_start fires after the real sid is bound.
   */
  private async startSession(opts: { sessionId?: string; seedModel?: string }): Promise<void> {
    if (!this.acp) return;
    try {
      const init = await this.acp.request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
        60_000,
      ) as Record<string, unknown> | null;
      const initMeta = ((init?.agentCapabilities as Record<string, unknown> | undefined)?._meta ?? {}) as Record<string, unknown>;
      const qoderMeta = (initMeta.qoder ?? {}) as Record<string, unknown>;
      this.promptQueueing = qoderMeta.promptQueueing === true;
      if (this.capabilities.steer && !this.promptQueueing) {
        console.warn(`[aiti-qoder-agent] steer 探针已通过但本 CLI 未自报 ACP promptQueueing — 注入将降级为本地队列`);
      }
      const cliVersion = String((init?.agentInfo as Record<string, unknown> | undefined)?.version ?? "");
      const stale = this.capabilities.steer && cliVersion ? steerEvidenceStale(steerProbeBook, this.cliPath, cliVersion) : null;
      if (stale) console.warn(`[aiti-qoder-agent] ${stale}`);
      this.acp.notify("initialized", {});
      const { agentKey } = qoderVariant(this.variant);
      if (opts.sessionId) {
        // 接管：session/load（cwd 已按原会话归属解析——CLI 只在原项目目录里找历史）
        this.loading = true;
        let res: Record<string, unknown> | null = null;
        // A hosting switch stops the previous qoder process right before this
        // one starts; the CLI briefly reports "The operation was aborted" while
        // releasing that session. One short retry avoids leaving the reopened
        // session dead on the first attempt (observed 2026-11-23).
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            res = await this.acp.request(
              "session/load", { sessionId: opts.sessionId, cwd: this.cwd || undefined, mcpServers: [] }, 150_000,
            ) as Record<string, unknown> | null;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (attempt === 0 && /aborted|locked|busy|conflict/i.test(message)) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              continue;
            }
            throw error;
          }
        }
        this.applyAcpSessionMeta(res);
        this.loading = false;
        this.flushStreamMessages();
        this.flushReplayAssistant();
        this.seedSourceHistoryIfEmpty();
      } else {
        const res = await this.acp.request(
          "session/new", { cwd: this.cwd || undefined, mcpServers: [] }, 60_000,
        ) as Record<string, unknown> | null;
        const sid = String((res as { sessionId?: unknown } | null)?.sessionId ?? "");
        if (sid && !this.id.includes(sid)) {
          const oldId = this.id;
          this.id = `${agentKey}:${sid}`;
          this.emit({ type: "session_backend_ready", oldId, id: this.id });
          // 状态文件跟随换绑（模型选择持久化到真实 sid 名下）
          const { stateKey } = qoderVariant(this.variant);
          renameExtModelState(stateKey, oldId, this.id).then(() => this.persistModelState());
          // 队列 sidecar 随 id 换绑（占位 id 随机，不迁移则 new 前排队的条目崩溃后不可恢复）
          migrateSidecar(oldId, this.id);
        }
        this.applyAcpSessionMeta(res);
      }
      const sid = realSidOf(this.id) ?? undefined;
      // 起步最大权限（headless 长驻会话逐条审批太吵）；运行时仍可 set_mode 切换。
      try {
        await this.acp.request("session/set_mode", { sessionId: sid, modeId: "yolo" }, 15_000);
        this.applyPermissionMode("bypassPermissions");
      } catch (e) {
        console.warn(`[aiti-qoder-agent] set_mode(yolo) failed — staying on CLI default: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (opts.seedModel) {
        try {
          await this.acp.request("session/set_model", { sessionId: sid, modelId: opts.seedModel }, 15_000);
          this.trackModel(opts.seedModel, "restore");
        } catch (e) {
          console.warn(`[aiti-qoder-agent] set_model(${opts.seedModel}) failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.sessionReady = true;
      for (const w of this.readyWaiters.splice(0)) w();
      this.emit({ type: "agent_start", sessionId: this.id, model: this.model });
      // bootstrap 期间经共享层入队的 prompt（创建即发/早到消息）在此放行（幂等，空队列无害）
      this.q.scheduleDrain();
    } catch (e) {
      this.markDead(`acp bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Seed the source index when the CLI did not replay any history. */
  private seedSourceHistoryIfEmpty(): void {
    const source = this.sourceHistory;
    this.sourceHistory = null;
    if (!source?.length || this.liveHistory.length > 0) return;
    this.seedHistory(source);
  }

  /** session/new|load 响应的目录快照（权限档清单 + 模型清单）。 */
  private applyAcpSessionMeta(res: Record<string, unknown> | null): void {
    if (!res || typeof res !== "object") return;
    const modes = res.modes as { availableModes?: unknown; currentModeId?: unknown } | undefined;
    if (modes && Array.isArray(modes.availableModes)) {
      this.acpModes = {
        availableModes: (modes.availableModes as Array<Record<string, unknown>>).flatMap((m) => {
          const id = typeof m?.id === "string" ? m.id : "";
          return id ? [{ id, ...(typeof m.name === "string" ? { name: m.name } : {}), ...(typeof m.description === "string" ? { description: m.description } : {}) }] : [];
        }),
        ...(typeof modes.currentModeId === "string" ? { currentModeId: modes.currentModeId } : {}),
      };
    }
    const models = res.models as { availableModels?: unknown } | undefined;
    if (models && Array.isArray(models.availableModels)) {
      this.acpModels = (models.availableModels as Array<Record<string, unknown>>).flatMap((m) => {
        const modelId = typeof m?.modelId === "string" ? m.modelId : "";
        return modelId ? [{ modelId, ...(typeof m.name === "string" ? { name: m.name } : {}), ...(typeof m.description === "string" ? { description: m.description } : {}) }] : [];
      });
    }
  }

  /** CC 档名 → ACP modeId（session/set_mode）。plan 在 ACP 面 unavailable（返回 undefined）。 */
  private ccToModeId(mode: string): string | undefined {
    const map: Record<string, string> = {
      default: "default", acceptEdits: "acceptEdits", auto: "auto",
      dontAsk: "dontAsk", bypassPermissions: "yolo", dont_ask: "dontAsk",
    };
    return map[mode];
  }

  /** ACP modeId → CC 档名（CLI 回显 / current_mode_update）。未知原样透传。 */
  private modeIdToCc(modeId: string): string {
    const map: Record<string, string> = {
      default: "default", acceptEdits: "acceptEdits", auto: "auto",
      dontAsk: "dontAsk", yolo: "bypassPermissions", bypass_permissions: "bypassPermissions",
    };
    return map[modeId] ?? modeId;
  }

  /** CLI 回显/设置成功后的统一入口：更新快照 + 广播（幂等，宿主按值去重）。 */
  private applyPermissionMode(ccMode: string): void {
    if (!ccMode) return;
    this.permissionMode = ccMode;
    this.emit({ type: "permission_mode_changed", mode: ccMode });
  }

  async prompt(
    text: string,
    options?: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      files?: Array<{ data: string; mimeType: string; filename?: string }>;
      /** 运行中排队语义（core 透传）：steer=注入（探针开门 + CLI 自报 promptQueueing），followUp=本地队列。 */
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    if (this.running) {
      // 运行中：分流归共享层——有 steer 钩子则注入（失败自降级），否则/明确 followUp 入本地队列。
      await this.q.routePrompt(text, {
        ...(options?.images?.length ? { images: options.images as never } : {}),
        streamingBehavior: options?.streamingBehavior,
      });
      return;
    }
    // bootstrap 未完成：挂起等 ready（事件驱动）。⚠ 不能走 routePrompt——共享层见
    // isRunning()=false 会当空闲 dispatch 回本方法，无限递归。
    await this.waitSessionReady();
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    const sid = realSidOf(this.id);
    if (!sid || !this.acp) throw new Error("[aiti-qoder-agent] session not ready");
    // ACP content blocks: text + optional images（promptCapabilities.image=true）。
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const img of options?.images ?? []) {
      prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    this.liveHistory.push({ role: "user", content: historyUserContent(text, options?.images) });
    await this.sendPromptTurn(prompt, "primary");
  }

  /** session/prompt 应答上限：一次回合可跨数十次工具调用，按小时计；超时按传输失败收口。 */
  static PROMPT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
  /** Steer injection uses a short timeout: a healthy CLI replies in ~5s (probe-measured),
   *  so 90s is ~18x headroom — a hang must fall back to the local queue fast, not tie
   *  the turn up for PROMPT_TIMEOUT_MS. */
  static STEER_TIMEOUT_MS = 90_000;

  /**
   * 发一条 session/prompt 并记账（主轮与运行中注入共用）：
   *  - `promptsInFlight` 归零才算整轮收口（注入轮可能在主轮之后另起一段 loop）；
   *  - 注入请求的响应不触发 agent_settled，失败自降级回本地 followUp 队列
   *    （共享层在注入时已按 "steered" 返回，必须由 handle 自己兜住消息不丢）。
   */
  private async sendPromptTurn(
    prompt: Array<Record<string, unknown>>,
    kind: "primary" | "steer",
    steer?: {
      text: string;
      images?: Array<{ data: string; mimeType: string }>;
      mirrorId: string;
      historyEntry: unknown;
    },
    timeoutMs: number = QoderHandle.PROMPT_TIMEOUT_MS,
  ): Promise<void> {
    const sid = realSidOf(this.id);
    if (!sid || !this.acp) return;
    this.promptsInFlight += 1;
    this.running = true;
    let result: Record<string, unknown> | null = null;
    let failure: string | null = null;
    try {
      result = await this.acp.request(
        "session/prompt",
        { sessionId: sid, prompt },
        timeoutMs,
      ) as Record<string, unknown> | null;
    } catch (e) {
      // transport-level failure (dead pipe / timeout): let markDead settle the UI via
      // session_backend_dead; reset running below so the queue stays drainable.
      failure = e instanceof Error ? e.message : String(e);
    }
    this.settlePromptTurn(kind, result, failure, steer);
  }

  private settlePromptTurn(
    kind: "primary" | "steer",
    result: Record<string, unknown> | null,
    failure: string | null,
    steer?: { text: string; images?: Array<{ data: string; mimeType: string }>; mirrorId: string; historyEntry: unknown },
  ): void {
    this.promptsInFlight = Math.max(0, this.promptsInFlight - 1);
    if (steer) {
      // 协议无认领帧：请求响应 = CLI 已处理该条 → 镜像出队；失败则撤回气泡、转本地队列。
      this.q.drainSteer([steer.mirrorId]);
      if (failure) {
        const i = this.liveHistory.indexOf(steer.historyEntry);
        if (i >= 0) this.liveHistory.splice(i, 1);
        this.q.enqueueFollowUp(steer.text, steer.images as never);
      }
    }
    // 本段 loop 结束：先把流式气泡落成消息（注入轮可能在主轮后继续，各段边界都收一次）
    this.flushStreamMessages();
    if (this.promptsInFlight > 0) return; // 还有注入在途：收口等最后一个响应
    if (failure !== null) {
      this.running = false;
      console.warn(`[aiti-qoder-agent] session/prompt failed${kind === "steer" ? " (steer)" : ""}: ${failure}`);
      // Steer-fallback turn end: the primary settled earlier with promptsInFlight>0
      // (skipping finishTurn), so the UI still reads "running" and the downgraded
      // followUp would sit idle until the next manual turn. Settle the UI now — the
      // extra frame is idempotent (same pattern as the abort path) — and drain the
      // queue so the fallback message goes out this turn.
      this.emit({ type: "agent_settled" });
      this.q.scheduleDrain();
      return;
    }
    this.finishTurn(result);
  }

  /**
   * 运行中注入（共享层 steer 钩子）：在途 session/prompt 旁再发一条 session/prompt。
   * CLI 侧入队 priority:"next"（工具间隙被本轮 AgentLoop 吸收；主轮无间隙时成为下一段
   * loop）。不阻塞等待应答——应答在消费该条的 loop 结束时到达。
   */
  private async injectSteer(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    if (!this.running) throw new Error("[aiti-qoder-agent] steer requires a running turn");
    if (!this.promptQueueing) throw new Error("[aiti-qoder-agent] CLI does not advertise ACP promptQueueing");
    const sid = realSidOf(this.id);
    if (!sid || !this.acp) throw new Error("[aiti-qoder-agent] session not ready");
    // ACP content blocks: text + optional images（与 prompt() 同一构造）。
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const img of images ?? []) {
      prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    const historyEntry = { role: "user", content: historyUserContent(text, images) };
    this.liveHistory.push(historyEntry);
    const mirrorId = `acp-steer-${++this.steerSeq}`;
    this.q.registerSteer(mirrorId, text);
    void this.sendPromptTurn(prompt, "steer", { text, images, mirrorId, historyEntry }, QoderHandle.STEER_TIMEOUT_MS);
  }

  /**
   * Turn settlement (session/prompt response): stopReason end_turn/cancelled/...
   * flushes streaming bubbles, expires pending interactions, emits agent_settled
   * (cancelled → stopReason "aborted", the host abort semantics) and drains the queue.
   */
  private finishTurn(result: Record<string, unknown> | null): void {
    this.running = false;
    this.flushStreamMessages();
    const stopReason = String(result?.stopReason ?? "end_turn");
    this.extractUsage(result);
    // 本轮结束 = 未决权限请求一并作废（卡片永挂会让前端误判仍在等待；CLI 侧响应 cancelled）
    for (const [, w] of [...this.permissionWaiters.entries()]) {
      try { w.resolve({ outcome: { outcome: "cancelled" } }); } catch { /* 无害 */ }
    }
    this.permissionWaiters.clear();
    this.interactions.failPending("turn_end");
    const aborted = stopReason === "cancelled";
    const errorText = aborted ? undefined
      : stopReason === "end_turn" ? undefined
        : `stopReason=${stopReason}`;
    this.emit({
      type: "agent_settled",
      ...(errorText ? { error: errorText } : {}),
      ...(aborted ? { stopReason: "aborted" } : {}),
    });
    // settle（prompt 响应）后自动续轮（共享层幂等；running 已置 false 才会放行）
    this.q.scheduleDrain();
  }

  /**
   * Model fallback: host start options often omit model (detached/restore paths) and
   * the CLI's ACP frames don't echo one either, so message headers degrade to the
   * provider string ("aiti-qoder-agent"). The native transcript's runtime-config /
   * assistant records are persistent facts — fill in from there when present, with
   * provider "qoder" from the catalog (model display-name maps key on provider:model).
   */
  private effectiveModel(): { id: string; provider: string } | undefined {
    if (this.model?.id) return this.model;
    const sid = realSidOf(this.id);
    const native = sid ? readNativeSessionUsage(sid) : undefined;
    if (native?.model) this.model = { id: native.model, provider: "qoder" };
    return this.model;
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
  private extractUsage(result: Record<string, unknown> | null): void {
    const u = (result?.usage ?? null) as Record<string, unknown> | null;
    if (!u || typeof u !== "object") return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const inputTokens = n(u.inputTokens);
    const outputTokens = n(u.outputTokens);
    if (inputTokens === undefined && outputTokens === undefined) return;
    this.lastUsage = {
      model: this.model?.id,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
    this.usageTotals.inputTokens += inputTokens ?? 0;
    this.usageTotals.outputTokens += outputTokens ?? 0;
    this.usageTotals.turns += 1;
  }

  /**
   * @capability contextUsage — usage_update frames first; otherwise the native
   * transcript's context_usage_ratio (a real share; when the window is unpublished
   * only the percentage is given: contextWindow 0 / tokens null). Neither source →
   * undefined (empty-track state, no invented numbers).
   */
  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    const frame = this.lastContextUsage;
    if (frame) {
      return { percent: Math.min(100, (frame.tokens / frame.contextWindow) * 100), contextWindow: frame.contextWindow, tokens: frame.tokens };
    }
    const sid = realSidOf(this.id);
    const native = sid ? readNativeSessionUsage(sid) : undefined;
    if (native?.percent !== undefined) {
      return { percent: native.percent, contextWindow: 0, tokens: null };
    }
    const u = this.lastUsage;
    if (!u) return undefined;
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (!(tokens > 0)) return undefined;
    const contextWindow = qoderContextWindow(this.effectiveModel()?.id ?? u.model);
    if (!contextWindow) return undefined;
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }

  /**
   * @capability getUsageTotals — session totals (the host get_session_stats truth).
   * Token counts: qodercli doesn't report them (native usage all zeros, stay 0);
   * credits are summed per turn from the native transcript, staying continuous
   * across restarts.
   */
  getUsageTotals() {
    const sid = realSidOf(this.id);
    const native = sid ? readNativeSessionUsage(sid) : undefined;
    return {
      ...this.usageTotals,
      ...(native?.credits !== undefined ? { credits: native.credits } : {}),
    };
  }

  /**
   * 运行时切换模型：set_model control_request → control_response
   * （qodercli 1.1.17 为 CC 族 fork，二进制取证含该分支；超时回 false，fail-loud）。
   */
  /** 运行时切换模型：session/set_model（ACP 原生；1.1.83 探针响应 {}）。 */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    const sid = realSidOf(this.id);
    if (!sid || !this.acp) {
      console.warn(`[aiti-qoder-agent] set_model(${model.id}) skipped — session not ready`);
      return false;
    }
    try {
      await this.acp.request("session/set_model", { sessionId: sid, modelId: model.id }, 15_000);
    } catch (e) {
      console.warn(`[aiti-qoder-agent] set_model(${model.id}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const prev = this.model;
    this.model = { id: model.id, provider: "qoder" };
    this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
    this.persistModelState();
    return true;
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
  seedHistory(messages: SeedHistoryMessage[], fallbackModel?: string): void {
    this.liveHistory.push(...seedHistoryEntries(messages, fallbackModel ?? this.effectiveModel()?.id));
  }

  async abort(): Promise<void> {
    // ACP abort: session/cancel (acks sub-second, 2026-11-13 probe) → the in-flight
    // session/prompt responds with stopReason:"cancelled" → finishTurn settles the UI
    // with agent_settled("aborted"). Fallback: if the turn does not settle within
    // CANCEL_SETTLE_TIMEOUT_MS, hard-kill the child (exit → markDead → session_backend_dead
    // resets the UI; the host rebuilds with session/load on the next prompt).
    if (!this.running) {
      // 失步兜底（zcode 同款）：前端运行态与 handle 失步（如响应帧丢失）时静默 return
      // 会让停止按钮永久悬挂。补一帧 aborted 收口复位前端；幂等，真空闲时多一帧无害。
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    const sid = realSidOf(this.id);
    const wrote = sid && this.acp ? this.acp.notify("session/cancel", { sessionId: sid }) : false;
    if (!wrote) console.warn("[aiti-qoder-agent] session/cancel not written — falling back to hard stop");
    // Two-stage fallback: if the turn is still unsettled after the grace period, kill the child.
    const timer = setTimeout(() => {
      if (!this.running) return; // settled normally via the cancelled response
      console.warn("[aiti-qoder-agent] cancel not settled in time — hard-stopping CLI (SIGTERM→SIGKILL)");
      try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
      const t = setTimeout(() => { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } }, QoderHandle.HARD_KILL_GRACE_MS);
      t.unref?.();
    }, QoderHandle.CANCEL_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  }

  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    const supported = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"];
    if (!supported.includes(mode)) {
      throw new Error(`[aiti-qoder-agent] 非法权限模式 "${mode}"（可选：${supported.join("/")}）`);
    }
    // plan 档在 ACP 面不可用（availableModes 无 plan 条目，1.1.83 探针）——fail-loud，
    // 前端提示失败（stream-json 时代的 planStateManager 通道随 SDK worker 一起移除）。
    const modeId = this.ccToModeId(mode);
    if (!modeId) {
      console.warn(`[aiti-qoder-agent] permission mode "${mode}" is unavailable over ACP`);
      return false;
    }
    const sid = realSidOf(this.id);
    if (!sid || !this.acp) return false;
    try {
      await this.acp.request("session/set_mode", { sessionId: sid, modeId }, 15_000);
    } catch (e) {
      console.warn(`[aiti-qoder-agent] set_mode(${modeId}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    // 生效回显由 session/current_mode_update 帧驱动（applyPermissionMode）；这里不重复广播。
    return true;
  }

  getPermissionMode(): string | undefined {
    return this.permissionMode;
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
    const waiter = this.permissionWaiters.get(requestId);
    if (!waiter) return false;
    this.permissionWaiters.delete(requestId);
    // ACP outcome mapping: accept → allow option (deny 档无 allow 项时 cancelled fail-safe)；
    // decline → deny option（无则 cancelled）。optionId 显式指定优先。
    let outcome: Record<string, unknown>;
    const optionId = answer.optionId ?? (answer.action === "accept" ? waiter.allowOpt : waiter.denyOpt);
    if (answer.action === "accept" && waiter.allowOpt && !answer.optionId) {
      outcome = { outcome: "allow_selected", optionId: waiter.allowOpt };
    } else if (optionId) {
      outcome = { outcome: "allow_selected", optionId };
    } else {
      outcome = { outcome: "cancelled" };
    }
    try {
      waiter.resolve({ outcome });
      return true;
    } catch {
      return false;
    }
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
    // Wrapper-hosted process: disconnect and leave it running (killing is the
    // core's decision; a restart then reattaches to the same ACP session).
    const facade = this.child as unknown as { detachable?: unknown; release?: () => void };
    if (facade.detachable === true && typeof facade.release === "function") {
      this.acp?.close();
      facade.release();
      this.markDead("detached");
      return;
    }
    this.acp?.close();
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
   * @capability steer —— 运行中注入（ACP 探针 pass 才开放；空闲时等同普通发送）。
   * 分流归共享层：运行中 → steer 钩子（在途 session/prompt 旁再发一条）；空闲 → dispatch；
   * 注入失败 → 自动降级入本地 followUp 队列（消息不丢、不打断原轮）。
   * 门控关时保持 fail-loud：宿主已按能力位降级成 followUp，走到这里只能是有人直连 RPC。
   */
  async steer(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-qoder-agent] not running");
    if (!this.capabilities.steer) {
      throw new Error(
        `Capability "steer" is not enabled for CLI "${this.cliPath || "?"}"：` +
        "ACP 注入面未通过探针（运行中输入一律走 followUp 本地队列）",
      );
    }
    await this.q.routePrompt(text);
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
    return this.effectiveModel();
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


  /** @capability listTools —— ACP 面无工具清单帧（tool_call 卡自带工具名）→ 空态。 */
  async getAllTools(): Promise<Array<{ name: string; description: string }>> {
    return [];
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
      agentStarter?: AgentStarterLike;
      attached?: AttachedChildOptions;
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
  // The core may host this backend's `--acp` process in a detachable wrapper; the
  // handle adopts the live process on reattach (see QoderHandle.adopt).
  detachable: true,
  // Restart clears old handles/wrappers and seeds source history on the new
  // handle (hosting switch verification).
  hostingSwitch: true,
  createSession: (options: {
    sessionId?: string;
    cwd?: string;
    extraArgs?: string[];
    model?: { provider: string; id: string };
    /** Host-injected process strategy (detachable hosting); absent = plain spawn. */
    agentStarter?: AgentStarterLike;
    /** Host recovery: adopt a live process instead of spawning. */
    attached?: AttachedChildOptions;
  }) => QoderHandle.start({ ...options, variant: v.variant, client: sharedClient }),
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
      console.log(`[aiti-qoder-agent] ${v.agentKey}: ${describeSteerGate(steerProbeBook, bin, "acp")}`);
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
  icon: "icons/terminal.svg",
  // 受控登录统一弹窗（零构建原生 h() client；client/ 下两文件随 deploy 拷贝）
  // 静态插入点声明（与 client registerItems 的 id 一一对应）
  // 登录 UI 已统一到 aiti-agent-manager（受控登录弹窗退役，2026-09-13）：不再声明
  // client/ui —— 服务端 /login/* 与 .agent 描述符保留（manager 代理消费）。

  features: [spawnEnvFeature("Qoder"), spawnDisplayEnvFeature("Qoder"), spawnCommandFeature("Qoder"), spawnArgsPrefixFeature("Qoder")],


  ui: {
    // session-manager §4.8 slot: contribute the Qoder CN IDE history as an agent source
    provides: ["session-agent-source"],
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "ext.displayName": "Qoder 会话后端",
      },
      en: {
        ...spawnFeatureI18nEn(),
        "ext.displayName": "Qoder Session Backend",
      },
    },
  },

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
            agentStarter?: AgentStarterLike;
            attached?: AttachedChildOptions;
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
      // steer 探针账本（<stateDir>/steer-probe.json，tools/steer-probe-acp.mjs --record 写入）：
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
      // session-agent-source provider: must precede ensureClient() — reading the
      // IDE db has nothing to do with CLI login/model client availability.
      const sourceRes = qoderIdeSourceApi(ctx);
      if (sourceRes) return sourceRes;
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
