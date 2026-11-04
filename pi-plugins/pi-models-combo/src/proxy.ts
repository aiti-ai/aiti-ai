/**
 * pi-models-combo proxy — local HTTP proxy that rotates named API keys.
 *
 * Data format (models.json, under each provider):
 *   "providers": {
 *     "openrouter": {
 *       "baseUrl": "https://openrouter.ai/api/v1",
 *       "apiKeys": [
 *         { "name": "key-1", "key": "sk-xxx1", "rpm": 60, "minIntervalMs": 2000 },
 *         { "name": "key-2", "key": "sk-xxx2", "rpm": 120 }
 *       ]
 *     }
 *   }
 *
 * Two per-key throttles (both optional, applied together, take the max wait):
 *   `rpm` = max requests per minute.
 *   `minIntervalMs` = even-spacing throttle (default semantics: when unset,
 *     it AUTO-DERIVES 60000/rpm — rpm 30 → one request every 2s; set 0 to
 *     opt out and get the legacy burst-then-quiet sliding window; set a
 *     number for a fixed gap in ms).
 *
 * Flow:
 *   pi → 127.0.0.1:{PORT}/{upstream-path}/*  →  proxy  →  upstream API
 *   Proxy strips incoming auth headers (authorization / x-api-key /
 *   x-goog-api-key), injects the rotating key using the header scheme that
 *   matches the provider's api type (openai-completions → Bearer,
 *   anthropic-messages → x-api-key, google-generative-ai → x-goog-api-key).
 *   On 429: proxy retries at most once with the next key (exp backoff + jitter).
 *   pi itself retries on failure, so the proxy fails fast instead of burning retry
 *   budget against a rate-limited window (default 429 retries = 1).
 *   429 → cooldown keyed per slot (multi-key: per key; combo: per key×member model — a single member's rate limit must not freeze the whole pool).
 *   Rate-limit + server headers stripped from responses (pi never sees them).
 *
 * The auth gate accepts the dummy token via ANY of those three headers, so
 * whichever scheme pi's client uses for the provider still passes the gate.
 *
 * The listen socket is unref()'d so an active proxy never keeps a host
 * process alive on its own (CLI print mode / RPC hosts can exit freely).
 */

import fs, { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const { join } = path;
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { StickyRouter } from "./sticky.ts";
import { t } from "./i18n.ts";
import {
  appendUsageRecord,
  extractModelFromBody,
  extractUsageFromBody,
  shortClient,
  type ParsedUsage,
} from "./usage-log.ts";
import { resolveProviderModels, findModel, normModelId } from "./effective-models.cjs";

/** Response tail kept for usage parsing (SSE usage frames live at the end). */
const USAGE_TAIL_BYTES = 256 * 1024;

const DEFAULT_COOLDOWN = 30;
const MIN_COOLDOWN = 8; // s — 至少覆盖指数退避累计（1+2+4≈7s），避免同一 key 在退避窗口内冷却过期被反复选中重复打 429
/** 上游 retry-after 封顶（秒）：免费池配额耗尽常返回小时/天级 retry-after（曾见 opencode-go 返回
 *  442132s≈5.1 天，主力槽位被雪藏数日无人察觉）。照单全收 → 封顶后到期重新探测——用户可能已充值/
 *  上游已恢复。env PMC_RETRY_AFTER_CAP 可调（秒）。 */
const DEFAULT_RETRY_AFTER_CAP_SEC = 60;
/** 持续饱和闸门（毫秒）：一个池子（combo 分组或整个 provider）从「全部槽位冷却」开始连续计时，
 *  超过此时长仍全冷却 → 返回终态 400 终止客户端无限重试（pi 的 openai SDK 收 429 会自己内部
 *  重试，session 级还可能再重试——不终态报错用户只会看到无限转圈）。终态消息带 "quota exceeded"
 *  锚点：pi-ai 的 NON_RETRYABLE 模式优先命中 → 立即终止重试并把错误冒给用户。
 *  env PMC_SATURATION_TERMINAL_MS 可调（毫秒）。 */
const DEFAULT_SATURATION_TERMINAL_MS = 180_000;
/** 池级硬截止（毫秒）：一次客户端请求在代理内的**总预算**——跨所有重试/换成员串行累计。
 *  免费池整体拥堵时成员会挨个 TTFB 超时，无截止 = 客户端串行干等 N×TTFB
 *  （实测 2026-09-02：6 成员 × 90s ≈ 11.5min，session 表现为「卡死」）。
 *  到期 → 终止重试链 + 结构化 504（pi 端自带重试，稍后重试往往已避开拥堵窗口；
 *  超时成员同时带降权，重试时自动避开惯犯）。models.json provider 级
 *  timeouts.poolDeadlineMs 可调；显式 0 = 关闭；env PMC_POOL_DEADLINE_MS 兜底。 */
const DEFAULT_POOL_DEADLINE_MS = 300_000;
/** 超时降权因子：TTFB/流空闲/总时长任一超时 → 该成员权重 ×1/2（成员级语义，
 *  与 #scanHealthy 的成员加权选点一致）。该成员下次真实成功（<400 完整响应）自动恢复。 */
const TIMEOUT_WEIGHT_FACTOR = 0.5;

/** 秒数 → 人话时长（日志用；多语） */
function fmtDur(sec: number): string {
  if (sec >= 3600) return t("dur.h", { n: (sec / 3600).toFixed(1) });
  if (sec >= 60) return t("dur.min", { n: Math.round(sec / 60) });
  return t("dur.sec", { n: sec });
}
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
/** 粘性场景下，当前 key 的 rpm 滑窗等待超过此阈值 → 提前换下一把（避免粘性造成单 key 排队） */
const RPM_SWITCH_WAIT_MS = 10_000;

/** 槽位默认权重（组合成员未配 weight 时的占比基准） */
export const DEFAULT_SLOT_WEIGHT = 10;

/** 请求类别全集（成员 types 白名单可取值；classifyContent 输出同源）。
 *  将来加类别（视频/音频等）：此处加一项 + classifyContent 加一条检测映射 + 向导 UI 自动出现，数据格式零破坏。 */
export const CONTENT_CLASSES = ["text", "vision", "other"] as const;
export type ContentClass = (typeof CONTENT_CLASSES)[number];

/** 请求体 → 携带的类别集合（多类可并存：图文混合 → ["text","vision"]；纯文本 → ["text"]）。
 *  覆盖面：openai image_url / anthropic image / google inline_data|file_data 的 mime 前缀
 *  （image/* → vision；audio/*、video/*、pdf → other；其余多模态 → other）。
 *  纯文本内容（content 字符串或 text part）不额外加类（"text" 为基准类）。 */
export function classifyContent(parsed: any): string[] {
  const classes = new Set<string>(["text"]);
  const msgs = parsed?.messages ?? parsed?.contents;
  if (!Array.isArray(msgs)) return ["text"];
  for (const m of msgs) {
    const content = m?.content ?? m?.parts;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part) continue;
      if (part.type === "image_url" || part.type === "image") classes.add("vision");
      else if (part.type === "input_audio" || part.type === "document") classes.add("other");
      else {
        // google（无 type 字段，靠 mime）：inline_data / file_data
        const mt = String(part?.inline_data?.mime_type || part?.file_data?.mime_type || "");
        if (mt.startsWith("image/")) classes.add("vision");
        else if (mt.startsWith("audio/") || mt.startsWith("video/") || mt.includes("pdf")) classes.add("other");
      }
    }
  }
  return [...classes];
}

/** 兼容包装：请求是否携带图片（旧 hasImageContent 语义 = classifyContent 含 vision）。 */
export function hasImageContent(parsed: any): boolean {
  return classifyContent(parsed).includes("vision");
}

/** types 归一：数组过滤合法类别去重；空/undefined → undefined（全收）。 */
export function normalizeTypes(raw: any): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const valid = raw.filter((x: any) => CONTENT_CLASSES.includes(String(x)));
  return valid.length > 0 ? [...new Set(valid)] : undefined;
}

/** 粘性 key 的请求类别维度（vision > other > text 优先级取主导类别）。 */
function contentKey(classes: string[]): string {
  if (classes.includes("vision")) return "v";
  if (classes.includes("other")) return "o";
  return "t";
}

// ── 质量/超时默认值（provider 级 timeouts/quality 可覆盖）──
/** 等待上游响应头（TTFB）：推理模型首 token 常见 10–60s，取宽值 */
const DEFAULT_TTFB_MS = 90_000;
/** 流空闲：SSE 字节间无任何数据超过此值 → 判死（nginx proxy_read_timeout 同量级） */
const DEFAULT_IDLE_MS = 45_000;
/** 单请求总时长上限（防极端长挂） */
const DEFAULT_TOTAL_MS = 900_000;
/** 全部槽位因错误冷却时的重试间隔封顶：不空等整个冷却期，快速重开 */
const ERROR_COOLDOWN_RETRY_WAIT_MS = 2_000;
/** 429 专用重试上限：代理最多再试 1 次即返回 429——pi 端自带重试，不在此空耗限流窗口 */
const DEFAULT_MAX_429_RETRIES = 1;
/** 客户端请求体（body）接收超时：headers 已到但 body 卡住未发完时，防止 req.on("end") 永不触发导致永久挂起（零日志卡死） */
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
/** 持续慢判定：最近 N 次成功请求的 TTFB 中位数超过阈值 → 标记 slow（粘性命中即忽略 TTL 换槽） */
const DEFAULT_SLOW_WINDOW = 8;
const DEFAULT_SLOW_TTFB_MEDIAN_MS = 30_000;

export interface SlotTimeouts { ttfbMs: number; idleMs: number; totalMs: number; poolDeadlineMs: number }
export interface SlotQuality { window: number; ttfbMedianMs: number }

/** 400 响应体是否为「缺 x-opencode-session」错误（Console Go 等：error.type=MissingSessionID）。
 *  字符串匹配足够：上游错误体稳定含这两个标记之一，且调用方已限定 status===400。 */
function isMissingSessionIdError(text: string): boolean {
  return text.includes("MissingSessionID") || text.includes("x-opencode-session");
}

/** 每槽位运行时统计（状态面板：聚合/多 key 信息）。进程内累计，配置变更移除槽位时清零。 */
export interface SlotStat {
  ok: number;
  err429: number;
  err4xx: number;
  err5xx: number;
  timeout: number;
  other: number;
  /** 累计输入 token（成功响应解析 usage；不含缓存读，缓存单列 tcr/tcw） */
  tin: number;
  /** 累计输出 token（含 reasoning——上游 output 口径本就包含） */
  tout: number;
  /** 累计缓存读 / 写 token */
  tcr: number;
  tcw: number;
  /** 最近一次发起请求的时刻（成功/失败均记；0=从未使用） */
  lastUsedAt: number;
  /** 最近一次响应的状态码（0=无） */
  lastStatus: number;
}
const zeroStat = (): SlotStat => ({ ok: 0, err429: 0, err4xx: 0, err5xx: 0, timeout: 0, other: 0, tin: 0, tout: 0, tcr: 0, tcw: 0, lastUsedAt: 0, lastStatus: 0 });

/**
 * 加权随机：把各候选按权重从大到小排序，切成累计权重区间，随机数 r∈[0,1)
 * 落在哪个区间就选哪个候选（纯函数便于单测区间划分）。总权重 ≤0 时退回首个。
 */
export function weightedPick(idxs: number[], weights: number[], r: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total) || idxs.length === 0) return idxs[0];
  const order = idxs.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  const x = r * total;
  let acc = 0;
  for (const oi of order) {
    acc += weights[oi];
    if (x < acc) return idxs[oi];
  }
  return idxs[order[order.length - 1]];
}

/** 扁平化槽位：普通多 key 场景只有 name/key/rpm；
 *  组合（combo）场景每个槽位额外自带目标地址（成员上游 + 真实模型）与能力标记。 */
export interface ProxySlotEntry {
  name: string;
  key: string;
  rpm?: number;
  /** 等间距节流（ms）：距上次发出不足此值则 sleep 补足。已归一：0=关闭（突发滑窗），N>0=固定毫秒。缺省在归一层折算为 60000/rpm。 */
  minIntervalMs?: number;
  /** 该槽位的上游 baseUrl（combo 成员；缺省用 provider 级 upstream） */
  upstream?: string;
  /** 转发前把 body.model 改写为该真实模型 id（combo 成员） */
  model?: string;
  /** 成员是否支持图片输入（vision 路由用） */
  vision?: boolean;
  /** 成员协议（鉴权头方案；缺省用 provider 级 api） */
  api?: string;
  /** 所属虚拟模型 id（provider 内多个组合模型时按 body.model 分组选槽位） */
  group?: string;
  /** 成员身份标签 `${providerId}/${modelId}`（usage log / switch 归因用） */
  member?: string;
  /** 成员权重（默认 10；初始选点/切换重选时按权重占比随机） */
  weight?: number;
  /** 成员 supportsDeveloperRole（来自 models.json compat；布尔值，供 developer→system 改写判定） */
  devRole?: boolean;
  /** 成员承接的请求类别白名单（"text"/"vision"/"other"；未配/空 = 全收，与现状等价） */
  types?: string[];
}



/** 单个在途请求的路由状态（#dispatch 创建，闭包链路传递；严禁挂实例字段——并发请求会互踩） */
interface ReqCtx {
  /** 本次请求的 client 关联键 */
  client: string;
  /** 组合模式：body.model 命中的分组槽位索引；普通模式 null */
  groupIdxs: number[] | null;
  /** 组合模式：请求携带的类别集合（classifyContent 输出；"text"/"vision"/"other" 可并存） */
  contentClasses: string[];
  /** 粘性指针键（组合 = client+\0+虚拟模型+\0+类别维度；普通 = client） */
  stickyKey: string;
  /** 请求体解析结果（模型改写重建 body 用；非 JSON 为 null） */
  parsed: any;
  /** 虚拟模型 id（组合模式） */
  model: string | null;
  /** pick 相对上次粘住槽位的切换事件（成功路径落 usage log 后清空） */
  switchEvt: { from: string; to: string; reason: string } | null;
}

/** minIntervalMs 归一（默认匀速）：空/"auto"/true → 按 rpm 折算 60000/rpm（无 rpm → 0 关）；
 *  0 → 0（显式关闭匀速 = 突发滑窗）；N>0 → N；非法值 → 按默认 auto 处理。 */
function normalizeMinInterval(raw: any, rpm: number | undefined): number {
  if (raw === 0 || raw === "0") return 0;
  const auto = rpm ? Math.round(60000 / rpm) : 0;
  if (raw == null || raw === "" || raw === "auto" || raw === true) return auto;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : auto;
}

export class ProxyServer {
  #provider: string;
  #upstream: string;
  #entries: ProxySlotEntry[];
  #port: number;
  #retryAfterCapSec: number;
  #saturationTerminalMs: number;
  #maxRetries: number;
  /** 429 专用重试上限（pi 自带重试 → 代理快速失败，默认只重试 1 次） */
  #max429Retries: number;
  #currentIndex: number;
  #cooldown: Map<string, number>;   // 槽位冷却键 → ms 时间戳（普通=key名；组合=key名|member|model，按 key×member 独立冷却）
  /** 冷却原因（组合模式区分结构化响应：ratelimit→429 / error→502） */
  #coolKind: Map<string, "ratelimit" | "error"> = new Map();
  /** 槽位级上游原始 429 冷却时间（retry-after / x-ratelimit-reset 提取，未封顶）：
   *  状态面板展示「上游给了多少秒」，与内部（封顶后）冷却到期时间分开。 */
  #upstreamRl: Map<string, { retryAfterSec: number | null; capped: boolean; hint: string }> = new Map();
  #server: http.Server | null = null;
  #uParsed: URL | null = null;
  /** 槽位上游 URL 缓存（combo 成员各有目标地址，避免重复 new URL） */
  #uCache: Map<string, URL> = new Map();
  /** Registered dummy tokens (insertion-ordered; LRU-refreshed on use). */
  #authTokens: Map<string, string> = new Map();
  /** Token presented by the in-flight request (client correlation key). */
  #reqClient: string | null = null;
  static TOKEN_CAP = 1000;
  #reqTimes: Map<string, number[]>;
  #api: string;
  #upstreamTimeoutMs: number;
  /** key 层粘性（v0.3）：同一 client 稳定用一把 key 直到 TTL/冷却/rpm 长等待。 */
  #sticky: boolean;
  #stickyRouter: StickyRouter;

  // ── 组合模型（扁平化槽位）：同一套代理骨架，只是每个槽位自带目标地址 ──
  /** 存在带 group 的槽位即为组合代理 */
  #isCombo = false;
  /** 虚拟模型 id → 槽位索引数组 */
  #groups: Map<string, number[]> | null = null;
  /** 模型 id → supportsDeveloperRole（来自 models.json 的 compat）。代理据此决定 developer→system 改写：
   *  只有显式 false 才改写；true/未知 = 原样透传，绝不误伤支持 developer 的上游。 */
  #devRole: Map<string, boolean> = new Map();
  /** Console Go（opencode.ai/zen/go）强制要求 x-opencode-session 头（prompt cache 路由）。
   *  三态：true=强制注入 / false=强制不注入 / undefined=按上游 host 自动检测（*opencode.ai）。 */
  #xOpenCodeSession: boolean | undefined;
  /** MissingSessionID 自学习标记（全局）：上游 host 曾报「缺 x-opencode-session」→ 该 host 的后续所有请求
   *  直接注入该头，不再依赖错误触发。host 维度（组合成员可异构上游，只对被学习过的 host 注入）；
   *  实例生命周期内有效，跨重启可配置 models.json compat.xOpenCodeSession=true 固化。 */
  #learnedOcHosts: Set<string> = new Set();
  /** 持续饱和计时：池 key（combo=虚拟模型 id / 普通="__provider__"）→ 首次「全冷却」时刻 ms。
   *  持续超 #saturationTerminalMs 仍全冷却 → 终态 400。任一请求选到健康槽位即清除。 */
  #saturationSince: Map<string, number> = new Map();

  get port(): number { return this.#port; }

  /** 质量/超时配置（每实例；来自 provider 级 models.json 配置或默认值） */
  #timeouts: SlotTimeouts;
  #quality: SlotQuality;
  /** 请求体接收超时（见 #handle：body 卡住未发完时防永久挂起） */
  #bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS;
  /** 槽位质量档案：name → 最近 N 次成功请求的 TTFB（滚动窗口） */
  #slotStats: Map<string, number[]> = new Map();
  /** 超时降权表：成员标识（member ?? name）→ 罚因子（TIMEOUT_WEIGHT_FACTOR）。
   *  TTFB/流空闲/总时长任一超时即写入；该成员下次真实成功（<400 完整响应）删除恢复。
   *  成员级语义：权重是成员级的，多 key 不放大（同 #scanHealthy 成员加权）。 */
  #weightPenalty: Map<string, number> = new Map();
  /** 运行时统计（状态面板）：name → 计数/最近使用（进程内累计，不落盘） */
  #stats: Map<string, SlotStat> = new Map();
  /** models-store 索引缓存（按 normModelId 索引的 maxTokens / maxTokensField / api 字典）。
   *  仅在 maxTokens 改写路径按需懒加载：进程级首查触发全表扫描，之后按 mtime 缓存。
   *  字段 ① normModelId → { maxTokens, maxTokensField, api, provider } ② 加载时刻 mtimeMs。
   *  同一个 provider 下多源镜像（同一 modelId 跨 provider 出现）→ 取首条结果（store 序），
   *  提示 providerId 可让 #lookupModelMeta 优先匹配 source provider。 */
  #storeIdx: { mtime: number; byModel: Map<string, { maxTokens: number | null; maxTokensField: string | null; api: string | null; provider: string }> } | null = null;

  constructor({ provider, upstream, apiKeys, port = 18777, maxRetries = 5, max429Retries = DEFAULT_MAX_429_RETRIES, authToken = "", api = "", upstreamTimeoutMs, stickyKeys = true, stickyTtlMin = 15, timeouts, quality, retryAfterCapSec, saturationTerminalMs, devRole, xOpenCodeSession }: any) {
    this.#retryAfterCapSec = Number(retryAfterCapSec) > 0 ? Number(retryAfterCapSec)
      : (Number(process.env.PMC_RETRY_AFTER_CAP) > 0 ? Number(process.env.PMC_RETRY_AFTER_CAP) : DEFAULT_RETRY_AFTER_CAP_SEC);
    this.#saturationTerminalMs = Number(saturationTerminalMs) > 0 ? Number(saturationTerminalMs)
      : (Number(process.env.PMC_SATURATION_TERMINAL_MS) > 0 ? Number(process.env.PMC_SATURATION_TERMINAL_MS) : DEFAULT_SATURATION_TERMINAL_MS);
    const t = timeouts || {};
    const q = quality || {};
    this.#timeouts = {
      ttfbMs: Number(t.ttfbMs) > 0 ? Number(t.ttfbMs) : DEFAULT_TTFB_MS,
      idleMs: Number(t.idleMs) > 0 ? Number(t.idleMs) : DEFAULT_IDLE_MS,
      totalMs: Number(t.totalMs) > 0 ? Number(t.totalMs) : DEFAULT_TOTAL_MS,
      poolDeadlineMs: this.#parsePoolDeadline(t.poolDeadlineMs),
    };
    this.#bodyTimeoutMs = Number(t.bodyTimeoutMs) > 0 ? Number(t.bodyTimeoutMs) : DEFAULT_BODY_TIMEOUT_MS;
    this.#quality = {
      window: Number(q.window) > 0 ? Math.floor(Number(q.window)) : DEFAULT_SLOW_WINDOW,
      ttfbMedianMs: Number(q.ttfbMedianMs) > 0 ? Number(q.ttfbMedianMs) : DEFAULT_SLOW_TTFB_MEDIAN_MS,
    };
    this.#provider = provider;
    this.#upstream = upstream;
    this.#api = String(api || "");
    this.#xOpenCodeSession = typeof xOpenCodeSession === "boolean" ? xOpenCodeSession : undefined;
    if (devRole instanceof Map) for (const [k, v] of devRole) this.#devRole.set(String(k), !!v);
    this.#upstreamTimeoutMs = Number(upstreamTimeoutMs) > 0 ? Number(upstreamTimeoutMs) : DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.#entries = (apiKeys as ProxySlotEntry[]).map((e) => ({
      name: e.name || "key",
      key: e.key,
      rpm: e.rpm != null ? Math.max(1, e.rpm) : undefined,
      minIntervalMs: normalizeMinInterval(e.minIntervalMs, e.rpm != null ? Math.max(1, e.rpm) : undefined),
      upstream: e.upstream ? String(e.upstream) : undefined,
      model: e.model ? String(e.model) : undefined,
      vision: !!e.vision,
      api: e.api ? String(e.api) : undefined,
      group: e.group != null ? String(e.group) : undefined,
      member: e.member ? String(e.member) : undefined,
      weight: e.weight != null ? Math.max(1, Math.floor(Number(e.weight))) : undefined,
      types: normalizeTypes((e as any).types),
    }));
    this.#isCombo = this.#entries.some((e) => e.group);
    if (this.#isCombo) {
      this.#groups = new Map();
      for (let i = 0; i < this.#entries.length; i++) {
        const g = this.#entries[i].group!;
        if (!this.#groups.has(g)) this.#groups.set(g, []);
        this.#groups.get(g)!.push(i);
      }
    }
    this.#port = port;
    this.#maxRetries = maxRetries;
    this.#max429Retries = max429Retries;
    if (authToken) this.registerToken(authToken);
    this.#currentIndex = 0;
    this.#cooldown = new Map();
    this.#reqTimes = new Map();
    this.#sticky = stickyKeys !== false;
    this.#stickyRouter = new StickyRouter({ ttlMin: stickyTtlMin });
  }

  get uParsed(): URL {
    if (!this.#uParsed) this.#uParsed = new URL(this.#upstream);
    return this.#uParsed;
  }

  /**
   * 原地更新槽位（config 变更后无需重启 HTTP server，端口不变）。
   * 流程：替换条目 → 重建分组/上游 → 清理已移除槽位的运行时状态（冷却/请求计数/质量档案/粘性指针）。
   * 保留：HTTP server、端口、鉴权 token 集合、粘性 Router 实例（仅清掉指向已移除槽位的指针）。
   * 返回被移除的槽位名（调用方日志用）。
   */
  updateEntries(opts: { entries: ProxySlotEntry[]; upstream?: string; api?: string; apiKeys?: ProxySlotEntry[]; timeouts?: any; quality?: any; devRole?: Map<string, boolean>; xOpenCodeSession?: boolean }): string[] {
    // 更新 provider 级参数配置（timeouts/quality/bodyTimeout）——与构造函数同规则解析
    if (opts.devRole instanceof Map) {
      this.#devRole.clear();
      for (const [k, v] of opts.devRole) this.#devRole.set(String(k), !!v);
    }
    if (typeof opts.xOpenCodeSession === "boolean") this.#xOpenCodeSession = opts.xOpenCodeSession;
    else this.#xOpenCodeSession = undefined; // 缺省 → 回退按上游 host 自动检测（热更新重置残留显式值）
    if (opts.timeouts || opts.quality) {
      const t = opts.timeouts || {};
      const q = opts.quality || {};
      if (opts.timeouts) {
        this.#timeouts = {
          ttfbMs: Number(t.ttfbMs) > 0 ? Number(t.ttfbMs) : DEFAULT_TTFB_MS,
          idleMs: Number(t.idleMs) > 0 ? Number(t.idleMs) : DEFAULT_IDLE_MS,
          totalMs: Number(t.totalMs) > 0 ? Number(t.totalMs) : DEFAULT_TOTAL_MS,
          poolDeadlineMs: this.#parsePoolDeadline(t.poolDeadlineMs),
        };
        this.#bodyTimeoutMs = Number(t.bodyTimeoutMs) > 0 ? Number(t.bodyTimeoutMs) : DEFAULT_BODY_TIMEOUT_MS;
      }
      if (opts.quality) {
        this.#quality = {
          window: Number(q.window) > 0 ? Math.floor(Number(q.window)) : DEFAULT_SLOW_WINDOW,
          ttfbMedianMs: Number(q.ttfbMedianMs) > 0 ? Number(q.ttfbMedianMs) : DEFAULT_SLOW_TTFB_MEDIAN_MS,
        };
      }
    }
    const raw = opts.entries ?? opts.apiKeys ?? [];
    const entries = raw.map((e) => ({
      name: e.name || "key",
      key: e.key,
      rpm: e.rpm != null ? Math.max(1, e.rpm) : undefined,
      minIntervalMs: normalizeMinInterval(e.minIntervalMs, e.rpm != null ? Math.max(1, e.rpm) : undefined),
      upstream: e.upstream ? String(e.upstream) : undefined,
      model: e.model ? String(e.model) : undefined,
      vision: !!e.vision,
      api: e.api ? String(e.api) : undefined,
      group: e.group != null ? String(e.group) : undefined,
      member: e.member ? String(e.member) : undefined,
      weight: e.weight != null ? Math.max(1, Math.floor(Number(e.weight))) : undefined,
      types: normalizeTypes((e as any).types),
    }));

    const oldNames = new Set(this.#entries.map((e) => e.name));
    const newNames = new Set(entries.map((e) => e.name));
    const removed: string[] = [];
    for (const n of oldNames) if (!newNames.has(n)) removed.push(n);

    // 上游 / 协议更新
    if (opts.upstream) this.#upstream = String(opts.upstream);
    if (opts.api) this.#api = String(opts.api);
    this.#uParsed = null;

    this.#entries = entries;
    this.#isCombo = entries.some((e) => e.group);
    this.#groups = null;
    if (this.#isCombo) {
      this.#groups = new Map();
      for (let i = 0; i < entries.length; i++) {
        const g = entries[i].group!;
        if (!this.#groups.has(g)) this.#groups.set(g, []);
        this.#groups.get(g)!.push(i);
      }
    }
    this.#currentIndex = 0;

    // 槽位索引可能位移 → 粘性指针全部重置（config 变更罕见，清缓存最安全）
    this.#stickyRouter.clear();

    // 清理已移除槽位的运行时状态（配置变更=池子变化 → 饱和计时一并重置）
    this.#saturationSince.clear();
    if (removed.length) {
      for (const n of removed) { this.#reqTimes.delete(n); this.#stats.delete(n); }
    }
    // 槽位级冷却键清理：不在新槽位集合里的（含旧格式 key 名键）一律删
    const keepCoolKeys = new Set(this.#entries.map((e) => this.#coolKey(e)));
    for (const k of [...this.#cooldown.keys()]) {
      if (!keepCoolKeys.has(k)) { this.#cooldown.delete(k); this.#coolKind.delete(k); this.#upstreamRl.delete(k); }
    }
    // 超时降权表清理：成员已不在新槽位集合 → 移除
    const keepMembers = new Set(this.#entries.map((e) => e.member ?? e.name));
    for (const k of [...this.#weightPenalty.keys()]) if (!keepMembers.has(k)) this.#weightPenalty.delete(k);
    for (const k of [...this.#slotStats.keys()]) {
      if (!keepCoolKeys.has(k)) this.#slotStats.delete(k);
    }
    return removed;
  }

  /** Register an additional per-session dummy token (LRU-capped). Each pi
   *  session factory run generates its own token so usage records can be
   *  attributed back to the issuing session via the `client` field. */
  registerToken(token: string): void {
    if (!token) return;
    // delete+set refreshes LRU position
    this.#authTokens.delete(token);
    this.#authTokens.set(token, "1");
    while (this.#authTokens.size > ProxyServer.TOKEN_CAP) {
      const oldest = this.#authTokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#authTokens.delete(oldest);
    }
  }

  /** 持续饱和计时 key：combo=虚拟模型 id（池子按分组独立饱和）；普通 provider 级统一。 */
  #satKey(ctx: ReqCtx): string {
    return this.#isCombo && ctx.model ? ctx.model : "__provider__";
  }

  /** 池子已连续饱和的时长 ms（0=未饱和/已恢复）。 */
  #saturationMs(ctx: ReqCtx): number {
    const since = this.#saturationSince.get(this.#satKey(ctx));
    return since ? Date.now() - since : 0;
  }

  /** 确保饱和计时在走（无记录则从现在开始计）：请求已拿到失败信号（全冷却 / 重试耗尽仍 429）时调用。 */
  #armSaturation(ctx: ReqCtx): void {
    const key = this.#satKey(ctx);
    if (!this.#saturationSince.has(key)) this.#saturationSince.set(key, Date.now());
  }

  /** 选到健康槽位（池子有可用容量）→ 饱和解除。 */
  #clearSaturation(ctx: ReqCtx): void {
    this.#saturationSince.delete(this.#satKey(ctx));
  }

  /** 全部槽位冷却时的响应出口：未达闸门 → 结构化 429（客户端自带重试）；
   *  持续饱和超阈值 → 终态 400 终止客户端无限重试。终态消息带 "quota exceeded" 锚点
 *  （pi-ai NON_RETRYABLE 模式优先命中 → 立即终止并把错误展示给用户）。 */
  #saturatedResponse(ctx: ReqCtx, res: http.ServerResponse): void {
    // 含网络错误冷却的「全不可用」≠ 限流饱和：保持 502 api_error 语义，不进闸门计时
    const nowK = Date.now();
    const kinds = this.#candidates(ctx)
      .map((i) => this.#coolKey(this.#entries[i]))
      .filter((n) => { const t2 = this.#cooldown.get(n); return t2 != null && nowK < t2; })
      .map((n) => this.#coolKind.get(n));
    const allRateLimit = kinds.length > 0 && kinds.every((k) => k === "ratelimit");
    if (!allRateLimit) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: t("all.unavailable", { detail: this.#unavailableDetail(ctx) }), type: "api_error", provider: this.#provider } }));
      return;
    }
    this.#armSaturation(ctx);
    const key = this.#satKey(ctx);
    const since = this.#saturationSince.get(key)!;
    const satSec = Math.round((Date.now() - since) / 1000);
    const terminalMin = Math.round(this.#saturationTerminalMs / 60000);
    if (Date.now() - since >= this.#saturationTerminalMs) {
      this.#saturationSince.delete(key); // 终态后重新计时：客户端若立即重发，重新走 429→…→400 循环
      const what = this.#isCombo && ctx.model ? t("sat.what.combo", { model: ctx.model }) : t("sat.what.pool", { provider: this.#provider });
      this.log(t("sat.terminal.log", { k: key, dur: fmtDur(satSec) }));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: t("sat.terminal.err", { what, min: Math.max(1, terminalMin) }),
          type: "invalid_request_error",
          code: "quota exceeded",
          provider: this.#provider,
        },
      }));
      return;
    }
    // retry-after 同样封顶且 ≤60（pi 的 validateServerRetryDelayMs 上限）：用户若调低 cap，
    // 客户端重试节奏对齐内部冷却到期，避免「被告知等 60s 但槽位 30s 已解冻」的错位
    res.writeHead(429, { "retry-after": String(Math.min(60, this.#retryAfterCapSec)), "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: t("all.unavailable", { detail: this.#unavailableDetail(ctx) }), type: "rate_limit_exceeded", provider: this.#provider } }));
  }

  /** 本请求的候选槽位（组合模式 = body.model 命中的虚拟模型分组；普通模式 = 全部）。 */
  #candidates(ctx: ReqCtx): number[] {
    const n = this.#entries.length;
    const raw = ctx.groupIdxs ?? this.#entries.map((_, i) => i);
    // updateEntries 热更新后，在途请求的 ctx.groupIdxs 可能含越界旧索引（旧槽位已移除/重排）
    // → 过滤掉，防重试路径访问 #entries 越界崩溃（进程级 uncaughtException）
    return raw.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  }

  /** 记录一次成功请求的 TTFB（滚动窗口，槽位级：key×member），供持续慢判定。 */
  #recordTtfb(e: { name: string; member?: string; model?: string }, ttfbMs: number) {
    const k = this.#coolKey(e);
    const w = this.#slotStats.get(k) ?? [];
    w.push(ttfbMs);
    while (w.length > this.#quality.window) w.shift();
    this.#slotStats.set(k, w);
  }

  /** 槽位是否「持续慢」：窗口满且 TTFB 中位数超阈值。 */
  #isSlowSlot(idx: number): boolean {
    const w = this.#slotStats.get(this.#coolKey(this.#entries[idx]));
    if (!w || w.length < this.#quality.window) return false;
    const sorted = [...w].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return median > this.#quality.ttfbMedianMs;
  }

  /** 槽位冷却键：普通多 key 槽位=唯一 key，退化为 key 名（行为不变）；
   *  组合槽位=key名|member|model —— 同一 key 下各成员模型独立冷却
   *  （免费上游普遍单模型限流，按 key 名连坐会让一个 429 冻结全池）。 */
  #coolKey(e: { name: string; member?: string; model?: string }): string {
    return e.member || e.model ? `${e.name}|${e.member ?? ""}|${e.model ?? ""}` : e.name;
  }

  /** 槽位 idx 是否可用（不在冷却中 + 组合模式下类别/能力匹配）。 */
  #healthyAt(ctx: ReqCtx, idx: number, now: number): boolean {
    const e = this.#entries[idx];
    const ck = this.#coolKey(e);
    if (this.#cooldown.has(ck) && now < this.#cooldown.get(ck)!) return false;
    if (ctx.contentClasses.includes("vision") && !e.vision) return false; // 带图请求避开无 vision 的槽位（能力过滤）
    if (!this.#slotAccepts(e, ctx.contentClasses)) return false; // 分工路由：成员 types 白名单不覆盖请求类别
    return true;
  }

  /** 成员是否承接指定请求类别集合：未配 types（或空）= 全收；否则——
   *  text 是基础类（隐含放行，任何成员都能处理文本）：纯文本请求要求 types 含 "text"；
   *  带图/媒体请求要求**每个非 text 类别** ∈ types（混合请求需全能成员或全收）。
   *  语义：types 是「我处理哪几类请求」的白名单——
   *    text 成员不收带图/媒体；vision 成员不收纯文本/媒体；未配成员照旧全收。 */
  #slotAccepts(e: ProxySlotEntry, classes: string[]): boolean {
    if (!e.types || e.types.length === 0) return true;
    const nonText = classes.filter((c) => c !== "text");
    if (nonText.length === 0) return e.types.includes("text");
    return nonText.every((c) => e.types.includes(c));
  }

  /** 组合模式：429 后是否还有（其它）健康候选槽位可换。
   *  成员是独立上游/独立配额 → 单个成员 429 不代表其它成员限流；
   *  只要还有健康候选就继续换成员重试（有活的成员就一定能接住请求）。
   *  全冷却才返回 false（进饱和/429/终态 400）。普通多 key 不调用此逻辑。 */
  #anyHealthyCandidate(ctx: ReqCtx): boolean {
    const now = Date.now();
    return this.#candidates(ctx).some((i) => this.#healthyAt(ctx, i, now));
  }

  /** 扫描候选收集健康槽位：无健康时区分「有槽位在冷却」（可等待）与「被 vision 过滤清空」（等也没用）；
   *  有健康时：组合模式按**成员**加权随机（排序+累计区间+随机数落点；同成员多 key 不放大占比，
   *  仅成员间权重有差异才启用随机，全默认保持确定性轮转起步），否则确定性轮转。游标推进到选中槽位之后。 */
  #scanHealthy(ctx: ReqCtx): { idx?: number; anyCooling: boolean } {
    const cand = this.#candidates(ctx);
    const n = cand.length;
    const now = Date.now();
    let anyCooling = false;
    const healthy: number[] = [];
    for (let i = 0; i < n; i++) {
      const gi = (this.#currentIndex + i) % n;
      const idx = cand[gi];
      const e = this.#entries[idx];
      const ck = this.#coolKey(e);
      if (this.#cooldown.has(ck) && now < this.#cooldown.get(ck)!) anyCooling = true;
      if (this.#healthyAt(ctx, idx, now)) healthy.push(idx);
    }
    if (healthy.length === 0) return { anyCooling };

    // 按成员分组（保持出现顺序）；组合模式且成员间权重非均匀 → 成员级加权随机后取该成员首个健康槽位
    const byMember = new Map<string, number[]>();
    for (const i of healthy) {
      const gk = this.#entries[i].member ?? `#${i}`;
      if (!byMember.has(gk)) byMember.set(gk, []);
      byMember.get(gk)!.push(i);
    }
    let idx = healthy[0];
    if (this.#isCombo && byMember.size > 1) {
      const gks = [...byMember.keys()];
      // 成员代表权重取组内最大值——不随扫描起点（游标相位）变化；
      // 正常配置下同成员各槽位权重一致，此处即成员权重；超时罚因子直接乘上（乘后保底 1）
      const ws = gks.map((g) => {
        const rep = Math.max(...byMember.get(g)!.map((i) => this.#entries[i].weight ?? DEFAULT_SLOT_WEIGHT));
        const pen = this.#weightPenalty.get(g);
        return pen != null && pen < 1 ? Math.max(1, rep * pen) : rep;
      });
      if (new Set(ws).size > 1) {
        idx = byMember.get(gks[weightedPick(gks.map((_, i) => i), ws, Math.random())])![0];
      }
    }
    this.#currentIndex = (cand.indexOf(idx) + 1) % n;
    return { idx, anyCooling };
  }

  /**
   * 选槽位。v0.3 默认粘性：同一 client（session 关联键）TTL 内稳定用同一个；
   * 冷却中/能力不匹配的槽位视为不健康自然触发切换（外层 429 路径不变）。
   * `stickyKeys:false` 时回退无状态顺序轮转。
   * 组合模式下候选集 = body.model 命中的虚拟模型分组（扁平化槽位，各带目标地址）。
   */
  pick(ctx: ReqCtx) {
    const now = Date.now();
    ctx.switchEvt = null;

    // 扫描候选（含加权随机选点）：无健康槽位时区分「有槽位在冷却」（可等待重试）与「被 vision 过滤清空」（等也没用）
    const scan = () => this.#scanHealthy(ctx);

    if (this.#sticky) {
      // 取旧指针（避免遮蔽导入的 i18n t()，取名 st）
      const st = this.#stickyRouter.take(ctx.stickyKey, (i) => this.#healthyAt(ctx, i, now));
      let idx = st.idx;
      // 质量监控：粘住的槽位「持续慢」→ 无视 TTL 立即换到健康且不慢的槽位（reason "slow"）
      if (idx !== undefined && this.#isSlowSlot(idx)) {
        const s = scan();
        const alt = s.idx;
        if (alt !== undefined && alt !== idx && !this.#isSlowSlot(alt)) {
          this.log(t("sticky.slow", { from: this.#entries[idx].member ?? this.#entries[idx].name, to: this.#entries[alt].member ?? this.#entries[alt].name }));
          idx = alt;
          this.#stickyRouter.set(ctx.stickyKey, idx);
          if (this.#isCombo) {
            const from = this.#entries[st.idx].member ?? String(st.idx);
            const to = this.#entries[idx].member ?? String(idx);
            if (from !== to) ctx.switchEvt = { from, to, reason: "slow" };
          }
        }
      }
      if (idx === undefined) {
        const s = scan();
        if (s.idx === undefined) return s.anyCooling ? this.#allCoolingWait(now) : { unavailable: true };
        idx = s.idx;
        this.#stickyRouter.set(ctx.stickyKey, idx);
      }
      // 组合切换归因：粘住的槽位成员身份变化时记 switch 事件（成功路径落 usage log）。
      // from 取 st.idx（健康命中但换槽）或 st.prevIdx（原槽位冷却/TTL 被清除——归因不能丢）
      const fromIdx = st.idx ?? st.prevIdx;
      if (this.#isCombo && !ctx.switchEvt && fromIdx !== undefined && fromIdx !== idx) {
        const from = this.#entries[fromIdx].member ?? String(fromIdx);
        const to = this.#entries[idx].member ?? String(idx);
        if (from !== to) {
          ctx.switchEvt = { from, to, reason: st.clearReason === "ttl" ? "ttl" : "member-unavailable" };
        }
      }
      const e = this.#entries[idx];
      return { name: e.name, key: e.key, rpm: e.rpm, minIntervalMs: e.minIntervalMs, idx };
    }

    const s = scan();
    if (s.idx === undefined) return s.anyCooling ? this.#allCoolingWait(now) : { unavailable: true };
    const e = this.#entries[s.idx];
    return { name: e.name, key: e.key, rpm: e.rpm, minIntervalMs: e.minIntervalMs, idx: s.idx };
  }

  #allCoolingWait(now: number) {
    const earliest = Math.min(...this.#cooldown.values());
    return { wait: Math.max(100, earliest - now + 1000) };
  }

  /** 粘性场景下因当前槽位 rpm/等间距长等待提前换下一个健康槽位（无可换返回 null）。 */
  #stickySwitch(ctx: ReqCtx, client: string): { name: string; key: string; rpm?: number; minIntervalMs?: number } | null {
    const now = Date.now();
    const cand = this.#candidates(ctx);
    const n = cand.length;
    for (let i = 0; i < n; i++) {
      const gi = (this.#currentIndex + i) % n;
      const idx = cand[gi];
      if (!this.#healthyAt(ctx, idx, now)) continue;
      this.#currentIndex = (gi + 1) % n;
      this.#stickyRouter.set(ctx.stickyKey || client, idx);
      const e = this.#entries[idx];
      return { name: e.name, key: e.key, rpm: e.rpm, minIntervalMs: e.minIntervalMs, idx };
    }
    return null;
  }


  /** 查找模型的 maxInputTokens 上限定义。
   *  数据源优先级同 #lookupModelMeta。
   *  返回 null 表示「未配置 / 找不到」——调用方应透传不阻断。
   *  该字段专门用于限制请求体 token 数量，避免 413 Request Entity Too Large。
   */
  #lookupModelMaxInputTokens(modelId: string, hintProvider?: string): { maxInputTokens: number | null; maxTokensField: string | null; api: string | null } | null {
    const meta = this.#lookupModelMeta(modelId, hintProvider);
    if (!meta) return null;
    // 从 models.json 显式 models 列表中读取 maxInputTokens（如果有的话）
    // 或者从 store 索引读取（如果 models.json 没配但 store 有）
    // 目前兼容模型配置中的 maxTokens 作为 fallback（更保守的上限）
    if (meta.maxTokens != null && Number.isFinite(meta.maxTokens) && meta.maxTokens > 0) {
      return { maxInputTokens: meta.maxTokens, maxTokensField: meta.maxTokensField, api: meta.api };
    }
    // 兼容 store 索引里的 maxTokens
    const idx = this.#loadStoreIndex();
    const hit = idx.get(normModelId(modelId));
    if (hit && hit.maxTokens != null && Number.isFinite(hit.maxTokens) && hit.maxTokens > 0) {
      return { maxInputTokens: hit.maxTokens, maxTokensField: hit.maxTokensField, api: hit.api };
    }
    return null;
  }


  setCooldown(e: { name: string; member?: string; model?: string }, retryAfterSec: number | null, hint = "") {
    const k = this.#coolKey(e);
    // 记录上游原始值（封顶前）供状态面板展示；null = 上游未给 retry-after（落到默认冷却）
    const raw = retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec : null;
    let sec = retryAfterSec || DEFAULT_COOLDOWN;
    let capped = false;
    if (sec > this.#retryAfterCapSec) {
      // 超长 retry-after = 上游在说「配额没了」而非「等一会儿」。照单全收会把槽位雪藏数日
      // 且只有一行普通 429 日志，完全看不出严重性——醒目警告 + 封顶，到期重新探测。
      this.log(t("cooldown.cap", { k, dur: fmtDur(sec), cap: this.#retryAfterCapSec }));
      sec = this.#retryAfterCapSec;
      capped = true;
    }
    sec = Math.max(sec, MIN_COOLDOWN);
    this.#cooldown.set(k, Date.now() + sec * 1000);
    this.#coolKind.set(k, "ratelimit");
    this.#upstreamRl.set(k, { retryAfterSec: raw, capped, hint });
  }

  /** 错误冷却（网络错/超时/槽位故障，区别于 429 限流冷却——组合模式全冷却时的结构化响应不同） */
  setErrorCooldown(e: { name: string; member?: string; model?: string }, retryAfterSec: number | null = null) {
    const k = this.#coolKey(e);
    this.setCooldown(e, retryAfterSec);
    this.#coolKind.set(k, "error");
  }

  /** poolDeadlineMs 解析：显式 0 = 关闭；正数 = 毫秒；未配 → env PMC_POOL_DEADLINE_MS → 默认。 */
  #parsePoolDeadline(raw: any): number {
    if (raw === 0 || raw === "0") return 0;
    if (Number(raw) > 0) return Number(raw);
    if (Number(process.env.PMC_POOL_DEADLINE_MS) > 0) return Number(process.env.PMC_POOL_DEADLINE_MS);
    return DEFAULT_POOL_DEADLINE_MS;
  }

  /** 超时降权：TTFB/流空闲/总时长任一超时 → 成员权重 ×TIMEOUT_WEIGHT_FACTOR（1/2），
   *  该成员下次真实成功自动恢复（#teeAndLog 成功路径解除）。配错误冷却 = 「冻结一段时间 + 降权」。 */
  #penalizeTimeout(e: { name: string; member?: string; model?: string }, why: string, cooldownSec: number) {
    const k = e.member ?? e.name;
    this.#weightPenalty.set(k, TIMEOUT_WEIGHT_FACTOR);
    this.log(t("timeout.penalize", { k, why, dur: fmtDur(Math.max(1, Math.round(cooldownSec))), f: TIMEOUT_WEIGHT_FACTOR }));
  }

  /** 从 429 响应头提取上游给出的原始冷却时间（方案抄 aiti-model-check 的 extractRateLimit 头解析：
   *  retry-after 秒 / HTTP 日期、x-ratelimit-reset 系列 unix 秒或毫秒）。归一化为「距现在还需多少秒」；
   *  提取不到返回 null（上层落到默认冷却 / 内部封顶）。 */
  parseRateLimitHeaders(headers: http.IncomingHttpHeaders): { retryAfterSec: number | null; hint: string } {
    const get = (k: string): string | undefined => {
      const v = headers[k];
      return Array.isArray(v) ? String(v[0]) : v != null ? String(v) : undefined;
    };
    // 1) retry-after：纯数字 = 秒；HTTP 日期 = 绝对时间
    const retryAfter = get("retry-after");
    if (retryAfter) {
      const raw = retryAfter.trim();
      if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (n > 0) return { retryAfterSec: n, hint: "" };
      } else {
        const d = Date.parse(raw);
        if (!isNaN(d)) return { retryAfterSec: Math.max(1, Math.ceil((d - Date.now()) / 1000)), hint: "" };
      }
    }
    // 2) x-ratelimit-reset 系列：unix 秒或毫秒（>1e12 视为毫秒）
    for (const key of ["x-ratelimit-reset", "x-ratelimit-reset-models", "ratelimit-reset"]) {
      const v = get(key);
      if (v) {
        const n = Number(v.trim());
        if (!isNaN(n) && n > 0) {
          const ms = n > 1e12 ? n : n * 1000;
          return { retryAfterSec: Math.max(1, Math.ceil((ms - Date.now()) / 1000)), hint: `reset=${v.trim()}` };
        }
      }
    }
    return { retryAfterSec: null, hint: "" };
  }

  /** Check sliding-window RPM. Returns ms to sleep, or 0 if safe. */
  #checkRpm(name: string, rpm: number | undefined): number {
    if (!rpm) return 0;
    const now = Date.now();
    const win = 60000;
    const times = this.#reqTimes.get(name) || [];
    while (times.length > 0 && now - times[0] > win) times.shift();
    if (times.length < rpm) return 0;
    return Math.max(0, times[0] + win - now);
  }

  /** 等间距节流：距上次发出不足 minIntervalMs → 返回还需等多久（ms），否则 0。 */
  #spacingWait(name: string, minIntervalMs: number | undefined): number {
    if (!minIntervalMs || minIntervalMs <= 0) return 0;
    const times = this.#reqTimes.get(name) || [];
    if (times.length === 0) return 0;
    const last = times[times.length - 1];
    const dt = Date.now() - last;
    return dt >= minIntervalMs ? 0 : Math.ceil(minIntervalMs - dt);
  }

  /** Record a request timestamp for the sliding window (rate limit; per key). */
  #recordReq(name: string, entry?: ProxySlotEntry) {
    const now = Date.now();
    const times = this.#reqTimes.get(name) || [];
    while (times.length > 0 && now - times[0] > 60000) times.shift();
    times.push(now);
    this.#reqTimes.set(name, times);
    // 面板统计按模型（combo member）聚合，rate-limit 仍按 key（name）
    const rk = this.#reportKey(entry, name);
    const st = this.#stats.get(rk) ?? zeroStat();
    st.lastUsedAt = now;
    this.#stats.set(rk, st);
  }

  /** 统计一次上游结果（状态面板：每 key/槽位 ok/429/4xx/5xx/timeout 计数）。 */
  #bumpStat(name: string, status: number) {
    if (!name) return;
    const st = this.#stats.get(name) ?? zeroStat();
    if (status >= 200 && status < 300) st.ok++;
    else if (status === 429) st.err429++;
    else if (status === 504) st.timeout++;
    else if (status >= 400 && status < 500) st.err4xx++;
    else if (status >= 500) st.err5xx++;
    else st.other++;
    st.lastStatus = status;
    this.#stats.set(name, st);
  }

  /** 累计一次成功请求的 token 流量（usage 解析自响应尾部；解析失败不计，只影响面板不落日志）。 */
  #bumpUsage(name: string, usage: ParsedUsage | null) {
    if (!name || !usage) return;
    const st = this.#stats.get(name) ?? zeroStat();
    st.tin += usage.input ?? 0;
    st.tout += usage.output ?? 0;
    st.tcr += usage.cacheRead ?? 0;
    st.tcw += usage.cacheWrite ?? 0;
    this.#stats.set(name, st);
  }

  /** 面板统计报告键：组合成员按 member（provider/model）聚合 → 状态面板按「模型」计数；
   *  普通多 key 无 member → 回退按 key（name）计数（与历史一致）。 */
  #reportKey(entry?: ProxySlotEntry | null, fallback?: string): string {
    if (entry?.member) return entry.member;
    return entry?.name ?? fallback ?? "";
  }

  log(msg: string) {
    const line = `[pi-proxy:${this.#provider}] ${new Date().toISOString().slice(11,19)} ${msg}\n`;
    try {
      // PI_CODING_AGENT_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/agent 原行为
      const logDir = process.env.PI_CODING_AGENT_DIR
        ? join(process.env.PI_CODING_AGENT_DIR, "logs")
        : join(homedir(), ".pi", "agent", "logs");
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "pi-proxy.log"), line);
    } catch { /* 忽略写日志失败 */ }
  }

  /** 活跃粘性指针分布（name → 绑定数；受 TTL/容量约束的近似「当前在用」画像）。 */
  #stickyBindings(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      for (const [idx, count] of this.#stickyRouter.bindings()) {
        const e = this.#entries[idx];
        if (e) out[e.name] = (out[e.name] ?? 0) + count;
      }
    } catch { /* 兼容旧 StickyRouter（无 bindings） */ }
    return out;
  }

  /** 上游地址脱敏：剥离 userinfo 凭据（baseUrl 若带 https://user:pass@host 不应经 status 流出）。 */
  static safeUpstream(u: string | undefined): string | undefined {
    if (!u) return undefined;
    try {
      const url = new URL(u);
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
      }
      return url.toString();
    } catch { return u; }
  }

  /** 运行状态快照（聚合 / 多 key 信息面板）。不暴露 key 明文，只给槽位标识/健康/统计。 */
  status(): Record<string, unknown> {
    const now = Date.now();
    const bindings = this.#stickyBindings();
    return {
      provider: this.#provider,
      port: this.#port,
      upstream: ProxyServer.safeUpstream(this.#upstream),
      api: this.#api || undefined,
      isCombo: this.#isCombo,
      sticky: this.#sticky,
      retryAfterCapSec: this.#retryAfterCapSec,
      saturationTerminalMs: this.#saturationTerminalMs,
      poolDeadlineMs: this.#timeouts.poolDeadlineMs,
      /** 持续饱和中的池子（combo 分组/provider）→ 已持续秒数 */
      saturation: [...this.#saturationSince.entries()].map(([pool, since]) => ({
        pool,
        seconds: Math.max(0, Math.round((Date.now() - since) / 1000)),
      })),
      entries: this.#entries.map((e) => {
        const ck = this.#coolKey(e);
        const c = this.#cooldown.get(ck);
        const cooling = c != null && now < c;
        const kind = this.#coolKind.get(ck) ?? "ratelimit";
        const upRl = kind === "ratelimit" ? (this.#upstreamRl.get(ck) ?? null) : null;
        return {
          name: e.name,
          member: e.member,
          model: e.model,
          group: e.group,
          vision: !!e.vision,
          types: e.types,
          weight: e.weight,
          effectiveWeight: Math.max(1, Math.round((e.weight ?? DEFAULT_SLOT_WEIGHT) * (this.#weightPenalty.get(e.member ?? e.name) ?? 1))),
          timeoutPenalized: this.#weightPenalty.has(e.member ?? e.name) || undefined,
          rpm: e.rpm,
          minIntervalMs: e.minIntervalMs,
          upstream: ProxyServer.safeUpstream(e.upstream),
          cooldown: cooling
            ? {
                kind,
                secondsLeft: Math.max(0, Math.round((c! - now) / 1000)),
                // 上游原始冷却时间（429 时才附，区别于内部封顶后的实际冷却）：供面板显示「上游给了多少秒」
                ...(kind === "ratelimit" && upRl
                  ? { upstreamSec: upRl.retryAfterSec ?? undefined, capped: upRl.capped, hint: upRl.hint || undefined }
                  : {}),
              }
            : null,
          stats: this.#stats.get(this.#reportKey(e)) ?? zeroStat(),
          pinned: bindings[e.name] ?? 0,
        };
      }),
    };
  }

  /** 上游鉴权头方案（按 api 类型分派；组合成员可逐槽位覆盖）。 */
  authHeaderName(api?: string): string {
    const a = api ?? this.#api;
    if (a === "anthropic-messages") return "x-api-key";
    if (a === "google-generative-ai") return "x-goog-api-key";
    return "authorization";
  }

  /** 是否给本次上游请求注入 x-opencode-session（Console Go 要求）：
   *  显式 true/false 覆盖，缺省按 host 自动匹配 opencode 服务。 */
  #wantsXOpenCodeSession(hostname: string): boolean {
    if (this.#xOpenCodeSession === true) return true;
    if (this.#xOpenCodeSession === false) return false;
    return hostname === "opencode.ai" || hostname.endsWith(".opencode.ai");
  }

  /** auth gate：已注册的 dummy token 可经三种鉴权头任一携带（pi 按各 api 类型发不同头）。
   *  命中时把呈现的 token 记为本次请求的 client 关联键。 */
  #authorized(req: http.IncomingMessage): boolean {
    if (this.#authTokens.size === 0) return true;
    const h = (n: string) => String(req.headers[n] ?? "");
    let presented = h("authorization");
    if (presented.startsWith("Bearer ")) presented = presented.slice(7);
    else presented = h("x-api-key") || h("x-goog-api-key");
    if (!presented || !this.#authTokens.has(presented)) return false;
    // LRU refresh
    this.#authTokens.delete(presented);
    this.#authTokens.set(presented, "1");
    this.#reqClient = shortClient(presented);
    return true;
  }

  async start(maxAttempts = 6) {
    let lastErr: string = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.#server = http.createServer((req, res) => this.#handle(req, res));
          this.#server.listen(this.#port, "127.0.0.1", () => {
            this.#server!.unref(); // 不让代理句柄单独挂住宿主进程退出
            const label = this.#isCombo
              ? `groups=[${[...(this.#groups as Map<string, number[]>).keys()].join(", ")}] slots=[${this.#entries.map((e) => e.member ?? e.name).join(", ")}]`
              : `[${this.#entries.map((e) => e.name).join(", ")}]`;
            // this.log(`127.0.0.1:${this.#port} → ${this.#upstream} ${label}${this.#api ? ` api=${this.#api}` : ""}`);
            resolve();
          });
          this.#server.on("error", (err) => reject(err));
        });
        return;
      } catch (err: any) {
        lastErr = err.message;
        this.#server = null;
        // 仅端口冲突（EADDRINUSE）换端口重试；其它错误（EMFILE/ENFILE/EACCES 等）
        // 换端口无意义，直接失败并带出真实错误码，避免烧光重试后把根因吞成 "port busy"。
        const code = err?.code ?? "";
        if (code !== "EADDRINUSE") {
          throw new Error(`failed to start proxy on 127.0.0.1:${this.#port}: ${code || "error"}: ${lastErr}`);
        }
        const oldPort = this.#port;
        this.#port = 30000 + Math.floor(Math.random() * 20000);
        if (this.#port === oldPort) this.#port += 1;
        this.log(t("port.busy", { old: oldPort, new: this.#port, attempt, max: maxAttempts }));
        // 线性退避：并发风暴（批量建代理/测试套件并发）下连续碰撞时错开重试节奏
        await new Promise((r) => setTimeout(r, 5 * attempt));
      }
    }
    throw new Error(`failed to start proxy after ${maxAttempts} attempts (port busy): ${lastErr}`);
  }

  stop() {
    if (this.#server) {
      const srv = this.#server;
      this.#server = null;
      this.#cooldown.clear();
      this.#coolKind.clear();
      this.#reqTimes.clear();
      this.#slotStats.clear();
      this.#stats.clear();
      this.#saturationSince.clear();
      this.#weightPenalty.clear();
      (srv as any).closeAllConnections?.();
      srv.close(() => {});
    }
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // Auth gate — reject requests without the correct dummy token
    if (!this.#authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      this.#logRequest({ status: 401 });
      return;
    }

    // Buffer the request body once — replayed on each retry (re-piping an
    // already-consumed stream hangs the upstream on content-length mismatch).
    const chunks: Buffer[] = [];
    let size = 0;
    // Body 接收超时兜底：客户端发了 headers 后 body 卡住不发完（content-length 声明
    // 大于实际发送），req.on("end") 永不触发 → #dispatch 永不执行 → 请求永久挂起、
    // 代理零日志（曾致 freeglm 请求卡 65 分钟）。加 body 超时：超时即响应错误并结束。
    let bodyTimer: NodeJS.Timeout | null = null;
    const armBodyTimeout = () => {
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        this.log(t("body.timeout.log"));
        if (!res.headersSent) {
          res.writeHead(408, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: t("body.timeout.err") }));
        } else {
          res.destroy();
        }
        req.destroy();
      }, this.#bodyTimeoutMs);
    };
    armBodyTimeout();
    req.on("data", (c: Buffer) => { chunks.push(c); size += c.length; armBodyTimeout(); });
    req.on("end", () => {
      if (bodyTimer) { clearTimeout(bodyTimer); bodyTimer = null; }
      const body = Buffer.concat(chunks, size);
      this.#reqModel = extractModelFromBody(body);
      this.#dispatch(req, res, body);
    });
    req.on("error", () => { if (bodyTimer) { clearTimeout(bodyTimer); bodyTimer = null; } /* socket aborted mid-body — nothing to do */ });
  }

  /**
   * openai-completions 兼容改写：pi 对推理类模型用 role:"developer"（OpenAI 新约定），
   * 但大量 openai 兼容中转/GLM 系上游只认 "system"（如 Console Go 报 [1214] Incorrect role information）。
   * 按模型 compat 决定：只有该模型在 models.json 显式配了 supportsDeveloperRole:false 才改写；
   * true/未配置 → 原样透传（不误伤支持 developer 的上游）。PMC_NO_ROLE_REWRITE=1 可全局关。
   */
  #compatRewrite(body: Buffer): Buffer {
    if (this.#api !== "openai-completions" || process.env.PMC_NO_ROLE_REWRITE) return body;
    try {
      const obj = JSON.parse(body.toString("utf8"));
      const msgs = Array.isArray(obj?.messages) ? obj.messages : null;
      if (!msgs || !msgs.some((m: any) => m?.role === "developer")) return body;
      const mid = typeof obj?.model === "string" ? obj.model : "";
      if (!mid || this.#devRole.get(mid) !== false) return body; // 未显式 false → 不改写
      for (const m of msgs) if (m?.role === "developer") m.role = "system";
      return Buffer.from(JSON.stringify(obj), "utf8");
    } catch {
      return body; // 非 JSON/解析失败：原样透传
    }
  }

  #dispatch(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer) {
    const body = this.#compatRewrite(rawBody);

    // ── 组合模型路由：body.model（虚拟 id）→ 扁平化槽位分组；GET /models 返回组合清单 ──
    // 请求级状态全部收进 ctx（闭包传递），并发请求互不干扰
    let ctx: ReqCtx;
    if (this.#isCombo) {
      let parsed: any = null;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { /* 非 JSON：无法改写 model */ }
      const m = (req.method || "").toUpperCase();
      if (m === "GET" && (req.url ?? "").includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [...this.#groups!.keys()].map((id) => ({ id, object: "model", owned_by: this.#provider })),
        }));
        return;
      }
      const g = typeof this.#reqModel === "string" ? this.#groups!.get(this.#reqModel) : undefined;
      if (!g || g.length === 0) {
        const known = [...this.#groups!.keys()].join(", ") || t("combo.none.known");
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: t("combo.unknown", { model: this.#reqModel ?? t("combo.nobody"), known }) , type: "invalid_request_error", provider: this.#provider } }));
        return;
      }
      const contentClasses = !!parsed ? classifyContent(parsed) : ["text"];
      ctx = {
        client: this.#reqClient ?? "",
        groupIdxs: g,
        contentClasses,
        stickyKey: `${this.#reqClient ?? ""}\u0000${this.#reqModel}\u0000${contentKey(contentClasses)}`,
        parsed,
        model: this.#reqModel,
        switchEvt: null,
      };
    } else {
      ctx = {
        client: this.#reqClient ?? "",
        groupIdxs: null,
        contentClasses: ["text"],
        stickyKey: this.#reqClient ?? "",
        parsed: null,
        model: this.#reqModel,
        switchEvt: null,
      };
    }

    let attempt = 0;
    let servedKey = "";


    // ── 模型输入大小限制：检查请求体token数量是否超过模型配置的 maxInputTokens
    // 如果超过，返回 413 Request Entity Too Large 错误，允许用户重试其他模型
    let maxInputTokens: number | null = null;
    let modelIdForCheck: string | null = null;
    let providerHint: string | null = null;

    if (ctx.model) {
      modelIdForCheck = ctx.model;
      // 从 entry 中获取 provider hint（combo 模式有 member，普通模式没有）
      if (this.#isCombo && ctx.parsed && ctx.parsed.model) {
        // combo 模式：member 是 "pid/modelId" 格式
        const member = ctx.parsed.member ?? "";
        providerHint = member.split("/")[0];
      } else if (!this.#isCombo) {
        providerHint = this.#provider;
      }
      const limitMeta = this.#lookupModelMaxInputTokens(modelIdForCheck, providerHint);
      if (limitMeta && limitMeta.maxInputTokens != null) {
        maxInputTokens = limitMeta.maxInputTokens;
      }
    }

    // 如果配置了 maxInputTokens 且请求体是 JSON，检查 token 数量
    if (maxInputTokens !== null && ctx.parsed && typeof ctx.parsed === "object") {
      const bodyStr = ctx.parsed.toString ? ctx.parsed.toString() : "";
      // 简单的 token 计数：统计 messages/completion 里的 content 长度近似
      let contentLength = 0;
      const messages = ctx.parsed.messages ?? ctx.parsed.contents ?? [];
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          const parts = msg.content ?? msg.parts ?? [];
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (typeof part === "string") {
                contentLength += part.length;
              }
            }
          }
        }
      }
      // 粗略的 token 估算：英文约 4 字符/token，中文约 1.5 字符/token
      // 使用保守估算：字符数 / 3 大致相当于 token 数
      const estimatedTokens = Math.max(1, Math.round(contentLength / 3));
      
      if (estimatedTokens > maxInputTokens) {
        // 超过限制，返回 413 Request Entity Too Large
        this.#logRequest({ status: 413, client: ctx.client, model: ctx.model });
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: t("input.too.large", { 
              model: ctx.model ?? t("combo.nobody"), 
              limit: maxInputTokens, 
              estimated: estimatedTokens 
            }),
            type: "request_entity_too_large",
            provider: this.#provider
          }
        }));
        return;
      }
    }


    // ── 池级硬截止：一次客户端请求在代理内的总预算（跨所有重试/换成员串行累计）。
    // 到期 → 终止重试链 + 结构化 504；迟到的上游响应直接丢弃（严禁碰已结束的 res）。
    const deadlineMs = this.#timeouts.poolDeadlineMs;
    let deadlineHit = false;
    let deadlineTimer: NodeJS.Timeout | null = null;
    const clearDeadline = () => { if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; } };
    if (deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        deadlineHit = true;
        clearDeadline();
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        this.log(t("pool.deadline.log", { s: Math.round(deadlineMs / 1000) }));
        this.#logRequest({ status: 504, client: ctx.client, model: ctx.model });
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: t("pool.deadline.err", { s: Math.round(deadlineMs / 1000) }), type: "timeout", provider: this.#provider } }));
      }, deadlineMs);
      deadlineTimer.unref?.();
    }
    const path = req.url!;
    const method = req.method || "GET";
    // 客户端断开标记：重试窗口内感知，避免对已离开的客户端继续打扰上游
    let clientGone = false;
    const baseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      // 剥掉 hop 头、content-length 与所有入站鉴权头（轮转 key 由下方按 api 类型重新注入）
      if (kl === "host" || kl === "content-length" ||
          kl === "authorization" || kl === "x-api-key" || kl === "x-goog-api-key") continue;
      baseHeaders[k] = typeof v === "string" ? v : Array.isArray(v) ? v[0] : String(v);
    }

    const tryReq = () => {
      if (deadlineHit) return; // 池级硬截止已触发（响应已 504）：不再发起任何新尝试
      if (clientGone && !res.headersSent) return; // 客户端已断开：不再打扰上游
      const p = this.pick(ctx);
      if (p.unavailable) {
        // 组合/普通模式：无槽位在冷却仍全不可用（vision 过滤清空）→ 等也没用，立即结构化 502
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: t("all.unavailable", { detail: this.#unavailableDetail(ctx) }), type: "api_error", provider: this.#provider } }));
        return;
      }
      if (!p.key && this.#isCombo) {
        // 组合模式：全部槽位冷却中 → 不傻等；过饱和闸门（未达阈值→结构化 429；持续饱和→终态 400 终止客户端无限重试）
        this.#saturatedResponse(ctx, res);
        return;
      }
      if (!p.key) {
        if (this.#isCombo) { setTimeout(tryReq, p.wait!); return; } // 组合模式已在上方立即响应，不会到达
        const nowW = Date.now();
        const kinds = this.#candidates(ctx)
          .map((i) => this.#coolKey(this.#entries[i]))
          .filter((n) => { const t = this.#cooldown.get(n); return t != null && nowW < t; })
          .map((n) => this.#coolKind.get(n));
        // 普通模式：全部 key 因【错误】冷却（非限流）→ 2s 封顶轮询重开（attempt 有上限）
        if (kinds.length > 0 && kinds.every((k) => k === "error")) {
          attempt++;
          servedKey = "";
          if (attempt >= this.#maxRetries) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: t("keys.allfailed.exhausted") }));
            return;
          }
          setTimeout(tryReq, Math.min(p.wait!, ERROR_COOLDOWN_RETRY_WAIT_MS));
          return;
        }
        // 普通模式：全部 key 因【限流】冷却 → 过饱和闸门（同组合模式）：
        // 未达阈值→立即 429 不等冷却窗口（等窗口只会放大延迟，且 pi 端自带重试）；
        // 持续饱和超阈值→终态 400，终止 SDK/session 层的无限重试循环。
        const allRateLimit = kinds.length > 0 && kinds.every((k) => k === "ratelimit");
        if (allRateLimit) {
          this.#saturatedResponse(ctx, res);
          return;
        }
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: t("keys.allfailed"), type: "api_error", provider: this.#provider } }));
        return;
      }

      // 注：不在「选到健康槽位」时清饱和计时——选到≠成功，配额死的槽位冷却一到期就看似健康，
      // 慢节奏客户端（如 pi 每 60s 重试）会永远清零闸门 → 终态 400 永不触发（实测证实）。
      // 改为上游真成功（<400）才解除，见下方成功路径。

      let { name, key, rpm, minIntervalMs } = p;
      let entry = this.#entries[p.idx];
      servedKey = name;
      // 两道门控取最大等待：① 滑动窗口计数（rpm） ② 等间距节流（minIntervalMs，距上次发出不足则补足）
      let waitMs = Math.max(this.#checkRpm(name, rpm), this.#spacingWait(name, minIntervalMs));
      // 粘性保护：当前 key 要排队太久（>10s）→ 提前换下一把，避免粘住单 key 排队
      if (waitMs > RPM_SWITCH_WAIT_MS && this.#sticky && this.#entries.length > 1) {
        // 先取旧指针标签再换槽——stickySwitch 内部会改写指针，事后 peek 只能读到新槽
        const prevIdx = this.#stickyRouter.peek(ctx.stickyKey);
        const prevTag = prevIdx !== undefined ? (this.#entries[prevIdx].member ?? this.#entries[prevIdx].name) : "";
        const alt = this.#stickySwitch(ctx, ctx.client);
        if (alt && alt.name !== name) {
          this.log(t("rpm.switch", { k: name, s: Math.round(waitMs / 1000), alt: alt.name }));
          if (this.#isCombo) {
            const to = this.#entries[alt.idx]?.member ?? alt.name;
            if (prevTag && prevTag !== to) ctx.switchEvt = { from: prevTag, to, reason: "rpm" };
          }
          ({ name, key, rpm, minIntervalMs } = alt);
          entry = this.#entries[alt.idx];
          servedKey = name;
        }
      }
      const waitMs2 = Math.max(this.#checkRpm(name, rpm), this.#spacingWait(name, minIntervalMs));
      if (waitMs2 > 0) {
        this.log(t("rpm.wait", { k: name, s: Math.round(waitMs2 / 1000) }));
        setTimeout(tryReq, waitMs2);
        return;
      }
      this.#recordReq(name, entry);

      // 组合成员：鉴权头方案与目标地址都可逐槽位覆盖
      const api = entry.api || this.#api;
      const headers: Record<string, string> = { ...baseHeaders };
      const authHeader = this.authHeaderName(api);
      if (authHeader === "authorization") headers.authorization = `Bearer ${key}`;
      else headers[authHeader] = key;
      if (api === "anthropic-messages" && !headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }

      const u = this.#urlOf(entry.upstream || this.#upstream);
      // Console Go（opencode.ai/zen/go）强制要求 x-opencode-session 头（prompt cache 路由）。
      // 只在目标服务为 opencode 时注入（其他上游原样透传）；值取 per-session 的 client key
      // （dummy token 截断，会话内稳定、跨会话隔离）；无 client 时退到随机 UUID 防跨会话串缓存。
      // 另加自学习命中：该 host 曾报 MissingSessionID（自动检测不可达的中转域名）→ 全局直接带头。
      if (this.#wantsXOpenCodeSession(u.hostname) || this.#learnedOcHosts.has(u.hostname)) {
        headers["x-opencode-session"] = ctx.client || `pi-${randomUUID()}`;
      }
      const transport = u.protocol === "https:" ? https : http;

      // ── 三段计时器（质量/超时体系）：TTFB / 流空闲 / 总时长 ──
      // 计时器与上游流引用都挂在 dispatch 层：多次重试共享同一组变量，
      // 每轮尝试开始时先清旧 TTFB 计时器——否则上一轮的定时器会误杀下一轮请求。
      const startTs = Date.now();
      let ttfbTimer: NodeJS.Timeout | null = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let totalTimer: NodeJS.Timeout | null = null;
      let upstreamRes: http.IncomingMessage | null = null;
      const clearTimers = () => {
        if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = null; }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
      };
      const clearStreamTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
      };
      const abortStream = (why: string) => {
        clearStreamTimers();
        this.log(t("stream.abort", { k: name, why }));
        this.setErrorCooldown(entry);
        this.#penalizeTimeout(entry, why, DEFAULT_COOLDOWN);
        if (upstreamRes) upstreamRes.destroy();
        res.destroy();
      };

      // 客户端取消传播：客户端提前断开（用户取消/会话终止）→ 中止上游，不浪费配额。
      const onClientClose = () => {
        if (res.writableEnded) return;
        if (!clientGone) this.log(t("client.gone", { k: name }));
        clientGone = true;
        clearTimers();
        clearDeadline();
        if (upstreamRes) upstreamRes.destroy(); else if (proxied) proxied.destroy();
      };
      res.off("close", onClientClose);
      res.on("close", onClientClose);

      const armStreamWatch = () => {
        idleTimer = setTimeout(() => abortStream(t("idle.reason", { s: Math.round(this.#timeouts.idleMs / 1000) })), this.#timeouts.idleMs);
        totalTimer = setTimeout(() => abortStream(t("total.reason", { min: Math.round(this.#timeouts.totalMs / 60000) })), this.#timeouts.totalMs);
      };

      const proxied = transport.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + path,
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeouts.totalMs),
      }, (proxiedRes) => {
        // 池级硬截止已触发（客户端已拿到 504）：迟到的上游响应直接丢弃，严禁再触碰已结束的 res
        if (deadlineHit) { upstreamRes = proxiedRes; proxiedRes.resume(); proxiedRes.destroy(); return; }
        upstreamRes = proxiedRes;
        if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = null; }
        const ttfb = Date.now() - startTs;
        if (proxiedRes.statusCode! < 400) this.#recordTtfb(entry, ttfb);

        if (proxiedRes.statusCode === 429) {
          proxiedRes.resume();
          const rl = this.parseRateLimitHeaders(proxiedRes.headers);
          const ra = rl.retryAfterSec;
          this.setCooldown(entry, ra, rl.hint);
          this.#logRequest({ key: name, member: entry?.member, status: 429, client: ctx.client, model: ctx.model });
          attempt++;
          // 组合模式：成员=独立上游/独立配额 → 单个成员 429 只说明它自己限流，与其它成员无关。
          // 必须继续换成员重试到「无健康候选可换」为止：3 死 1 活的池子，死的先碰 429 时立即接力到活的，
          // 否则永远只试 2 个槽就谎报 all combo members unavailable（本事故根因）。
          // 重试上限 = 候选健康槽位数（每试一个就冷却一个，自然收敛到全冷却）。
          // 普通多 key：保留硬限（同一上游大概率共享配额，跨 key 重试收益小，pi 端自会重试）。
          if (this.#isCombo ? this.#anyHealthyCandidate(ctx) : attempt < this.#max429Retries + 1) {
            const b = this.#isCombo ? (200 + Math.random() * 300) : Math.min(1000 * 2 ** (attempt - 1), 30000);
            this.log(`429 "${name}"${ra ? ` retry-after ${ra}s` : ""} retry ${attempt}/${this.#isCombo ? t("candidates") : this.#max429Retries + 1}`);
            setTimeout(tryReq, b + Math.random() * b * 0.3);
          } else {
            this.log(`"${name}" exhausted 429 retries → 429`);
            // 重试耗尽仍 429 = 明确饱和信号 → 开始/继续闸门计时；持续超阈值 → 终态 400 终止客户端重试
            this.#armSaturation(ctx);
            if (this.#saturationMs(ctx) >= this.#saturationTerminalMs) {
              this.#saturatedResponse(ctx, res);
              return;
            }
            const msg = this.#isCombo ? t("all.unavailable", { detail: this.#unavailableDetail(ctx) }) : t("keys.ratelimited");
            // 响应头封顶三重上限：pi 硬限 60s（validateServerRetryDelayMs 超限直接拒等）> cap > 上游原始值——
            // 注意不能只封到 cap：用户配 PMC_RETRY_AFTER_CAP=600（内部冷却雪藏久些）时，若头部跟眑600s，
            // 原始事故《Server requested 600s retry delay》会在本路径原样复发
            const clientRa = Math.min(60, this.#retryAfterCapSec, ra || this.#retryAfterCapSec);
            res.writeHead(429, { "retry-after": String(clientRa), "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: msg, type: "rate_limit_exceeded", provider: this.#provider } }));
          }
          return;
        }

        if (proxiedRes.statusCode === 413) {
          proxiedRes.resume();
          this.#logRequest({ key: name, member: entry?.member, status: 413, client: ctx.client, model: ctx.model });
          if (this.#isCombo) {
            // 清粘性：避免下次再被 pin 到同一个 413 成员
            this.#stickyRouter.take(ctx.stickyKey, () => false);
            const anyAlt = this.#anyHealthyCandidate(ctx);
            if (anyAlt) {
              attempt++;
              this.log(`413 "${entry?.member ?? name}" body too large → switch member (attempt ${attempt})`);
              setTimeout(tryReq, 150 + Math.random() * 200);
            } else {
              // combo 已无可换健康成员 → 把这个 413 直接透传给客户端，客户端可换模型
              this.log(`413 "${entry?.member ?? name}" → no other members to switch to (combo exhausted)`);
              res.writeHead(413, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: t("body.too.large.noalt", { member: entry?.member ?? name }), type: "request_entity_too_large", provider: this.#provider } }));
            }
          } else {
            // 普通模式：所有 key 共享同一上游 body 限制 → 413 透传
            this.log(`413 "${name}" body too large → passthrough (all key share upstream)`);
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: t("body.too.large"), type: "request_entity_too_large", provider: this.#provider } }));
          }
          return;
        }

        // MissingSessionID 自学习：上游要求 x-opencode-session 但本请求没带（host 自动检测未命中，
        // 如 Console Go 走中转域名）→ 缓冲 400 响应体确认 → 打全局标记（host 维度，后续请求直接带头）
        // → 原样重发（粘性不变，同槽位同 key 重试）；已带头仍报或重试预算耗尽 → 落入下方通用 4xx 透传。
        if (proxiedRes.statusCode === 400 && !headers["x-opencode-session"] && attempt < this.#maxRetries) {
          const msChunks: Buffer[] = [];
          proxiedRes.on("data", (c: Buffer) => msChunks.push(c));
          proxiedRes.on("end", () => {
            const text = Buffer.concat(msChunks).toString("utf8");
            if (!isMissingSessionIdError(text)) {
              // 普通 400（参数错等）→ 原样透传，不重试
              if (!res.headersSent) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(text);
              }
              return;
            }
            if (!this.#learnedOcHosts.has(u.hostname)) {
              this.#learnedOcHosts.add(u.hostname);
              this.log(t("ocsession.learn", { host: u.hostname }));
            }
            attempt++;
            setTimeout(tryReq, 120 + Math.random() * 180);
          });
          return;
        }

        if (proxiedRes.statusCode! >= 400) {
          this.#logRequest({ key: name, member: entry?.member, status: proxiedRes.statusCode!, client: ctx.client, model: ctx.model });
          // 错误状态码 → 该槽位粘性立即到期：清指针；多槽位时上冷却并换槽重试。
          // 429 已有专门路径；401/402/403（key 失效）与 5xx（上游故障）视为槽位故障；
          // combo 成员的 404 = 上游下架该模型（成员是配置写死的，与客户端参数无关）→ 同槽位故障
          //   （2026-10 实况：sensenova deepseek-v4-pro 上游下架，404 按成员权重间歇打穿客户端）；
          // 其余 4xx（400 参数错 / 非 combo 的 404 模型名不存在）与本槽无关 → 透传给客户端但同样清指针。
          this.#stickyRouter.take(ctx.stickyKey, () => false);
          const code = proxiedRes.statusCode!;
          const slotFault = code === 401 || code === 402 || code === 403 || code >= 500 || (this.#isCombo && code === 404);
          const multiSlot = this.#candidates(ctx).length > 1;
          if (slotFault && multiSlot && !res.headersSent) {
            this.setErrorCooldown(entry, code >= 500 ? null : 60);
            attempt++;
            if (attempt < this.#maxRetries) {
              proxiedRes.resume();
              setTimeout(tryReq, 200 + Math.random() * 300);
              return;
            }
            if (this.#isCombo) {
              res.writeHead(code, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: t("combo.allfailed.code", { code, detail: this.#unavailableDetail(ctx) }), type: "api_error", provider: this.#provider } }));
            } else {
              res.writeHead(code, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: t("keys.allfailed.code", { code }), type: "api_error", provider: this.#provider } }));
            }
            return;
          }
        }

        if (process.env.PMC_DEBUG_DUMP && proxiedRes.statusCode && proxiedRes.statusCode >= 400) {
          const errChunks: Buffer[] = [];
          proxiedRes.on("data", (c: Buffer) => errChunks.push(c));
          proxiedRes.on("end", () => {
            console.log(`[pi-proxy:${this.#provider}] [dump-resp] ${proxiedRes.statusCode} ${Buffer.concat(errChunks).toString("utf8").slice(0, 600)}`);
            if (!res.headersSent) {
              res.writeHead(proxiedRes.statusCode!, { "content-type": "application/json" });
              res.end(Buffer.concat(errChunks));
            }
          });
          return;
        }

        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(proxiedRes.headers)) {
          const kl = k.toLowerCase();
          if (kl.startsWith("x-ratelimit") || kl === "retry-after" || kl === "server") continue;
          out[k] = v!;
        }
        res.writeHead(proxiedRes.statusCode, out);
        // 响应链成功接通：池级预算不再计时（流内停摆由 idle/total 计时器管辖）
        clearDeadline();
        // 流空闲/总时长监控：SSE 中途停摆是「会话卡几十分钟」的根因——无字节超时即双端掐断
        armStreamWatch();
        proxiedRes.on("data", () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = setTimeout(() => abortStream(t("idle.reason", { s: Math.round(this.#timeouts.idleMs / 1000) })), this.#timeouts.idleMs); }
        });
        proxiedRes.on("end", clearStreamTimers);
        proxiedRes.on("close", clearStreamTimers);
        proxiedRes.on("aborted", clearStreamTimers);
        if (proxiedRes.statusCode! < 400) {
          this.#teeAndLog(proxiedRes, name, entry, ctx);
          // 上游真成功 = 池子确有可用容量 → 持续饱和计时解除（选到槽但 429 不算恢复）
          this.#clearSaturation(ctx);
        }
        proxiedRes.pipe(res);
        this.log(`${proxiedRes.statusCode >= 200 && proxiedRes.statusCode < 300 ? "✓" : ""} "${name}" → ${this.#isCombo ? `${entry.member ?? name} ` : ""}${proxiedRes.statusCode}`);
      });

      // 每轮尝试开始时武装 TTFB 计时器（重试前清旧，防上一轮定时器误杀本轮）
      if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = null; }
      ttfbTimer = setTimeout(() => {
        proxied.destroy(new Error("pmc-ttfb-timeout"));
      }, this.#timeouts.ttfbMs);

      if (process.env.PMC_DEBUG_DUMP) {
        console.log(`[pi-proxy:${this.#provider}] [dump] ${method} ${u.pathname + path} auth=${authHeader}`);
        try {
          const dumpFile = process.env.PMC_DEBUG_FILE;
          if (dumpFile) fs.writeFileSync(dumpFile, body);
        } catch {}
      }
      proxied.on("error", (err: any) => {
        clearTimers();
        const isTimeout = err?.name === "TimeoutError" || err?.code === "ABORT_ERR" || String(err?.message || "").includes("pmc-ttfb-timeout");
        if (isTimeout) {
          this.log(`upstream timeout (${entry.member ?? name})`);
          this.#logRequest({ key: servedKey || undefined, member: entry?.member, status: 504, client: ctx.client, model: ctx.model });
        } else {
          this.log(`upstream error (${entry.member ?? name}): ${err.message}`);
          this.#logRequest({ key: servedKey || undefined, member: entry?.member, status: 502, client: ctx.client, model: ctx.model });
        }
        if (res.headersSent || res.writableEnded) {
          // 流已开始：无法透明重试——双端立即中止，让 pi 端拿到中断错误自行重试（远好于无限挂起）
          if (upstreamRes) upstreamRes.destroy();
          res.destroy();
          return;
        }
        // 首字节前失败（连接拒绝/TTFB 超时）→ 该槽位冷却并换下一槽位重试；
        // 组合与普通多 key 同语义。耗尽：组合→结构化 502；普通→502/504。
        this.setErrorCooldown(entry, isTimeout ? this.#timeouts.ttfbMs / 1000 : null);
        if (isTimeout) this.#penalizeTimeout(entry, t("ttfb.reason", { s: Math.round(this.#timeouts.ttfbMs / 1000) }), this.#timeouts.ttfbMs / 1000);
        this.#stickyRouter.take(ctx.stickyKey, () => false); // 清除指向死槽位的粘性指针
        attempt++;
        if (attempt < this.#maxRetries) {
          setTimeout(tryReq, 400 + Math.random() * 400);
          return;
        }
        if (this.#isCombo) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: t("all.unavailable", { detail: this.#unavailableDetail(ctx) }), type: "api_error", provider: this.#provider } }));
        } else {
          res.writeHead(isTimeout ? 504 : 502, { "content-type": "application/json" });
          res.end(JSON.stringify(isTimeout ? { error: { message: t("upstream.timeout.err"), type: "timeout", provider: this.#provider } } : { error: `proxy upstream error: ${err.message}` }));
        }
      });

      // 组合成员：转发前把 body.model 改写为该槽位的真实模型 id（body 已缓冲，逐次重建免费）
      let sendBody = body;
      if (entry.model && ctx.parsed) {
        sendBody = Buffer.from(JSON.stringify({ ...ctx.parsed, model: entry.model }));
      }
      // maxTokens 改写：若 body 携带的 maxTokens > 上游真实模型 maxTokens，则改小（openai 字段名按
      // 模型 compat.maxTokensField 决定；anthropic 顶层 max_tokens；google 嵌套 generationConfig.maxOutputTokens）。
      // 普通模式：hintProvider = this.#provider，model id = sendBody.model（body 原样）。
      // combo 模式：hintProvider 从 entry.member（"pid/mid"）拆 pid，model id = entry.model（已改写）。
      // sendBody 现在 model 字段是「最终要发上游的 id」——与字段名查表的口径一致。
      try {
        const m = (() => { try { return JSON.parse(sendBody.toString("utf8")).model; } catch { return null; } })();
        const hintProvider = entry.model ? String(entry.member ?? "").split("/")[0] || undefined : this.#provider;
        const entryApi = entry.api || this.#api;
        if (m) sendBody = this.#maxTokensRewrite(sendBody, String(m), hintProvider, entryApi);
      } catch { /* 改写失败不阻断转发 */ }
      headers["content-length"] = String(sendBody.length);
      proxied.end(sendBody);
    };

    tryReq();
  }

  /** 槽位上游 URL（带缓存）。 */
  #urlOf(upstream: string): URL {
    let u = this.#uCache.get(upstream);
    if (!u) {
      u = new URL(upstream);
      this.#uCache.set(upstream, u);
    }
    return u;
  }

  /** 加载 ~/.pi/agent/models-store.json 并按 normModelId 建索引（首次调用 + mtime 变化时重载）。
   *  仅 maxTokens 改写路径调用——一般请求路径零开销（不到改写分支不触此加载）。 */
  #loadStoreIndex(): Map<string, { maxTokens: number | null; maxTokensField: string | null; api: string | null; provider: string }> {
    const p = this.#storePath();
    let mtime = -1;
    try { mtime = statSync(p).mtimeMs; } catch { /* 缺 store 走空索引 */ }
    if (this.#storeIdx && this.#storeIdx.mtime === mtime) return this.#storeIdx.byModel;
    const idx = new Map<string, { maxTokens: number | null; maxTokensField: string | null; api: string | null; provider: string }>();
    if (mtime >= 0) {
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        if (data && typeof data === "object") {
          for (const [pid, pcfg] of Object.entries(data as Record<string, any>)) {
            const ms = Array.isArray(pcfg?.models) ? pcfg.models : [];
            for (const m of ms) {
              if (!m || typeof m !== "object") continue;
              const id = m.id ?? m.model;
              const nm = normModelId(String(id || ""));
              if (!nm) continue;
              if (!idx.has(nm)) {
                idx.set(nm, {
                  maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : null,
                  maxTokensField: m.compat?.maxTokensField ?? null,
                  api: m.api ?? null,
                  provider: String(pid),
                });
              }
            }
          }
        }
      } catch { /* 解析失败走空索引（与缺文件同语义） */ }
    }
    this.#storeIdx = { mtime, byModel: idx };
    return idx;
  }

  /** 模型 store 路径（可被 PMC_MODELS_STORE 环境变量覆盖，供单测使用）。 */
  #storePath(): string {
    return process.env.PMC_MODELS_STORE || join(homedir(), ".pi", "agent", "models-store.json");
  }
  /** 模型配置路径（可被 PMC_MODELS_JSON 环境变量覆盖，供单测使用）。 */
  #modelsJsonPath(): string {
    return process.env.PMC_MODELS_JSON || join(homedir(), ".pi", "agent", "models.json");
  }

  /** 查找模型的 maxTokens / maxTokensField / api 权威定义。
   *  数据源优先级：
   *    1) hintProvider 显式 → models.json 中该 provider 的显式定义（effective-models 解析）
   *    2) store 索引按 normModelId 查（一般场景的 main 路径；适用于普通多 key provider，
   *       以及 combo 成员没在 models.json 显式的情况）
   *  任意一层拿到 maxTokens 即返回；返回 null 表示「未配置 / 找不到」——调用方应透传不阻断。 */
  #lookupModelMeta(modelId: string, hintProvider?: string): { maxTokens: number | null; maxTokensField: string | null; api: string | null } | null {
    if (!modelId) return null;
    const nm = normModelId(modelId);
    if (!nm) return null;
    if (hintProvider) {
      try {
        const mj = JSON.parse(readFileSync(this.#modelsJsonPath(), "utf8"));
        const prov = mj?.providers?.[hintProvider];
        if (prov && typeof prov === "object") {
          const resolved = resolveProviderModels({ providers: { [hintProvider]: prov } });
          const entry = resolved.get(hintProvider);
          const m = entry ? findModel(entry, nm) : null;
          if (m && m.maxTokens != null) {
            return { maxTokens: m.maxTokens, maxTokensField: m.compat?.maxTokensField ?? null, api: m.api ?? null };
          }
        }
      } catch { /* models.json 读失败 → 落到 store 索引 */ }
    }
    const idx = this.#loadStoreIndex();
    const hit = idx.get(nm);
    if (hit) {
      if (hintProvider && hit.provider !== hintProvider) {
        for (const [k, v] of idx) {
          if (k === nm && v.provider === hintProvider) return { maxTokens: v.maxTokens, maxTokensField: v.maxTokensField, api: v.api };
        }
      }
      return { maxTokens: hit.maxTokens, maxTokensField: hit.maxTokensField, api: hit.api };
    }
    return null;
  }

  /** 改写请求体的 maxTokens 字段：「若 client 请求的 maxTokens > 真实上游模型 maxTokens，则改小。
   *  改写字段名按协议分派：
   *    - openai-completions：按 compat.maxTokensField（max_tokens / max_completion_tokens）——这是
   *      同一 api 下不同模型字段不同的关键（GLM/老上游只认 max_tokens；新 openai 用 max_completion_tokens）
   *    - anthropic-messages：顶层 max_tokens
   *    - google-generative-ai / google-vertex：嵌套 generationConfig.maxOutputTokens
   *  边界：未指定 / 非正数 / 字符串 / 已 ≤ 上限 / 上游 maxTokens 未知 → 静默透传。
   *  不主动补默认值（用户没要上限不擅自加 max_tokens —— 上游 model.maxTokens 兜底）。 */
  #maxTokensRewrite(body: Buffer, modelId: string, hintProvider?: string, entryApi?: string): Buffer {
    if (process.env.PMC_NO_MAXTOKENS_REWRITE) return body;
    if (!modelId) return body;
    let obj: any;
    try { obj = JSON.parse(body.toString("utf8")); } catch { return body; }
    if (!obj || typeof obj !== "object") return body;

    // 找「当前 maxTokens 字段名」+「上游真实 maxTokens 上限」+「协议」
    // 优先级：entryApi（combo 成员协议） > provider api > body 当前字段反推
    const api = entryApi || this.#api;
    let fieldName: string | null = null;
    let nested = false; // google 协议的 generationConfig.maxOutputTokens 是嵌套的
    if (api === "openai-completions") {
      // 先用 effective-models 查 compat.maxTokensField；查不到再回退到 body 当前字段
      const meta = this.#lookupModelMeta(modelId, hintProvider);
      if (meta?.maxTokensField === "max_completion_tokens") fieldName = "max_completion_tokens";
      else if (meta?.maxTokensField === "max_tokens") fieldName = "max_tokens";
      else {
        // meta 缺：扫描 body 看 client 实际用的字段是哪边（不在该字段名时不改）
        if (typeof obj.max_completion_tokens === "number") fieldName = "max_completion_tokens";
        else if (typeof obj.max_tokens === "number") fieldName = "max_tokens";
        else return body;
      }
    } else if (api === "anthropic-messages") {
      fieldName = "max_tokens";
    } else if (api === "google-generative-ai" || api === "google-vertex") {
      fieldName = "maxOutputTokens";
      nested = true;
    } else {
      // 未知协议 / 扩展协议：扫描 body 找任一已知字段名
      if (typeof obj.max_tokens === "number") { fieldName = "max_tokens"; api === "openai-completions" || (api as any); }
      else if (typeof obj.max_completion_tokens === "number") { fieldName = "max_completion_tokens"; }
      else if (obj.generationConfig && typeof obj.generationConfig.maxOutputTokens === "number") {
        fieldName = "maxOutputTokens"; nested = true;
      }
      if (!fieldName) return body;
    }

    // 读取当前值（支持嵌套）
    const cur = nested
      ? (obj.generationConfig && typeof obj.generationConfig.maxOutputTokens === "number" ? obj.generationConfig.maxOutputTokens : null)
      : (typeof obj[fieldName] === "number" ? obj[fieldName] : null);
    if (cur == null || !Number.isFinite(cur) || cur <= 0) return body; // 用户没指定 / 非法 → 透传

    // 查上游真实 maxTokens 上限
    const meta = this.#lookupModelMeta(modelId, hintProvider);
    if (!meta || meta.maxTokens == null || !Number.isFinite(meta.maxTokens) || meta.maxTokens <= 0) return body;

    if (cur <= meta.maxTokens) return body; // 已 ≤ 上限，不动

    // 改小
    if (nested) {
      if (!obj.generationConfig || typeof obj.generationConfig !== "object") obj.generationConfig = {};
      obj.generationConfig.maxOutputTokens = meta.maxTokens;
    } else {
      obj[fieldName] = meta.maxTokens;
    }
    return Buffer.from(JSON.stringify(obj), "utf8");
  }

  /** 组合模式：列出各候选槽位当前不可用原因（结构化错误消息用）。 */
  #unavailableDetail(ctx: ReqCtx): string {
    const now = Date.now();
    return this.#candidates(ctx).map((i) => {
      const e = this.#entries[i];
      const ck = this.#coolKey(e);
      const cooling = this.#cooldown.has(ck) && now < this.#cooldown.get(ck)!;
      const noVision = ctx.contentClasses.includes("vision") && !e.vision;
      const noRole = !noVision && !this.#slotAccepts(e, ctx.contentClasses);
      return `${e.member ?? e.name}${cooling ? t("detail.cooling") : ""}${noVision ? t("detail.novision") : noRole ? t("detail.norole") : ""}`;
    }).join("; ");
  }

  /** Model id of the in-flight request (parsed from the request body). */
  #reqModel: string | null = null;

  /** Append one key-attempt record to the usage log (best-effort).
   *  One line per upstream attempt: rotation/429 counts stay exact per key. */
  #logRequest(opts: { key?: string; member?: string; status: number; usage?: Record<string, number>; client?: string; model?: string | null }) {
    this.#bumpStat(opts.member || opts.key || "", opts.status);
    appendUsageRecord({
      ts: Date.now(),
      provider: this.#provider,
      ...(opts.model !== undefined ? { model: opts.model } : { model: this.#reqModel }),
      key: opts.key || "",
      status: opts.status,
      ...((opts.client ?? this.#reqClient) ? { client: opts.client ?? this.#reqClient } : {}),
      ...(opts.usage ?? {}),
    });
  }

  /** Pipe `src` to the client while keeping a bounded tail; on end, parse
   *  usage from it and write the success record. Combo mode: record carries
   *  the member attribution (`combo`) plus a separate switch row when the
   *  sticky pointer moved member identity for this request. */
  #teeAndLog(src: http.IncomingMessage, keyName: string, entry: ProxySlotEntry | undefined, ctx: ReqCtx) {
    const tailChunks: Buffer[] = [];
    let tailSize = 0;
    src.on("data", (c: Buffer) => {
      tailChunks.push(c);
      tailSize += c.length;
      while (tailSize > USAGE_TAIL_BYTES && tailChunks.length > 1) {
        tailSize -= tailChunks[0].length;
        tailChunks.shift();
      }
    });
    src.on("end", () => {
      const rk = entry ? (entry.member ?? entry.name) : keyName;
      // 上游真成功（完整 <400 响应）→ 解除该成员的超时降权（权重恢复）
      if (this.#weightPenalty.delete(rk)) this.log(t("penalty.clear", { k: rk }));
      this.#bumpStat(rk, 200);
      const parsed = extractUsageFromBody(Buffer.concat(tailChunks).toString("utf8"));
      this.#bumpUsage(rk, parsed);
      // 单条记录同时携带常规字段与 combo 归属（严禁双写——消费者会双计 token）
      appendUsageRecord({
        ts: Date.now(),
        provider: this.#provider,
        model: entry?.model ?? ctx.model,
        key: keyName,
        status: 200,
        ...(entry?.group ? { combo: entry.member ?? `${entry.group}/${entry.model}` } : {}),
        ...(ctx.client ? { client: ctx.client } : {}),
        ...(parsed ?? undefined),
      } as any);
      if (ctx.switchEvt) {
        const sw = ctx.switchEvt;
        ctx.switchEvt = null;
        appendUsageRecord({
          ts: Date.now(),
          provider: this.#provider,
          model: sw.to.includes("/") ? sw.to.slice(sw.to.indexOf("/") + 1) : sw.to,
          key: "",
          status: 200,
          ...(ctx.client ? { client: ctx.client } : {}),
          switch: sw,
        } as any);
      }
    });
  }
}