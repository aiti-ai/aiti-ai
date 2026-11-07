/**
 * zcode-core —— aiti-zcode-agent 核心逻辑（纯模块，可测；调研 docs/zcode-desktop-cli-agent-analysis.md）
 *
 * 职责：
 *   1. runtime 生命周期（§3/§8.1）：feature 指定 → 自动探测（Windows 安装目录 / 挂载实例 / ~/.zcode AppImage）
 *      → 自动下载（官网 #all-downloads 直链）→ `--appimage-extract` 解压缓存（免 root）
 *   2. 凭据链路（§5）：桌面端 credentials.json 解密（aes-256-gcm + fallback secret）
 *      → 官方 login 同路径静默换 `zcode-api-key`（先查后建，幂等）→ configDir 缓存（0600）
 *   3. 每轮进程编排（§8.3）：spawn node zcode.cjs --json --mode M [--resume sid] --prompt T
 *   4. 输出解析：--json = 单个 pretty JSON 对象（2026-09-06 实测 runtime 0.16.5，exit 0 全量打印）
 *
 * 测试面：fetch 全部可注入；~/.zcode 位置可用 AITI_ZCODE_HOME 覆盖；无任何全局轮询。
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync, closeSync, cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
// 受控登录共享层（权威源 pi-web-ext/_shared/controlled-login.mjs，副本随扩展部署——改动须双向同步）
import { cleanEnv, tailLine } from "@aiti-ai/ext-shared/controlled-login";
// P1' 启动包装（docs/aiti-custom-agent-plan.md）：launch 解析走共享层
import { spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** 凭据链路 fetch 兜底超时（加固 2026-09-15：换 key 4 段串行调用曾无超时——端点 hang 时 prompt 永挂）。 */
function withFetchTimeout(f: FetchImpl, ms = 15_000): FetchImpl {
  return (url, init) => {
    const signals: AbortSignal[] = [];
    if (init?.signal) signals.push(init.signal);
    signals.push(AbortSignal.timeout(ms));
    return f(url, { ...init, signal: AbortSignal.any(signals) });
  };
}

// ============================================================================
// 常量（provider 表 = CLI 内置常量，§5.1 实测）
// ============================================================================

/** 模型 ref 的 providerId → Anthropic 兼容端点（必须显式设 ZCODE_BASE_URL，否则 bigmodel fallback 到 api.anthropic.com）。 */
export const PROVIDER_BASE_URL: Record<string, string> = {
  bigmodel: "https://open.bigmodel.cn/api/anthropic",
  zai: "https://api.z.ai/api/anthropic",
};

/**
 * ZCode 平台根（desktop 同款：desktop 进程 env `ZCODE_BASE_URL=https://zcode.z.ai`）。
 * app-server 通道将其注入 ZCODE_BASE_URL，引擎据此拉 `{平台根}/api/v1/agent/configs`，
 * 读 `data.proxyEndpoint.mapping` 把 provider 直连请求**动态路由**到 ultra 网关，并在 provider 域
 * 完成握手签名（ClientRequestSigningV4）——与 desktop 请求完全一致（含签名头）。
 * oneshot 通道不用平台根（ZCODE_BASE_URL 仍为 provider baseURL 直连）。
 */
export const ZCODE_PLATFORM_BASE_URL = "https://zcode.z.ai";

/** start-plan（体验套餐）端点兜底：桌面注册表缺失时用（zcode.z.ai 官方套餐网关，analysis §9）。 */
export const START_PLAN_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

/** 协议层 providerId wire 形态：start-plan 必须带 `builtin:` 前缀——runtime 的
 *  runtime-headers 反向请求触发判定严格等于 `builtin:*-start-plan`（analysis §9.2 实测：
 *  裸 id 不发 `interaction/requestProviderRuntimeHeaders`）。 */
export function wireProviderId(providerId: string): string {
  return isStartPlanChannel(providerId) ? `builtin:${providerId}` : providerId;
}

/**
 * start-plan 凭据（桌面同款）：凭据库 OAuth token set 的 `zcodejwttoken` 字段
 * （asar `loadZcodeJwtTokenForProvider` 同源；不换 key、不落盘，指纹 memo 防重复解密）。
 * 缺失 → fail-loud 人话指引。
 */
export async function ensureStartPlanCredential(opts: { log?: (msg: string) => void }): Promise<CredentialResult> {
  const fp = credentialFingerprint();
  const mem = fp ? memJwt.get(fp) : undefined;
  if (mem) return { apiKey: mem, providerId: "start-plan", source: "cache" };
  const raw = (() => {
    try {
      return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(buildNotLoggedInMessage("bigmodel-start-plan", `凭据文件不可读：${e instanceof Error ? e.message : String(e)}`));
    }
  })();
  let plain: Record<string, string>;
  try {
    plain = decryptCredentials(raw, deriveCredentialSecret());
  } catch (e) {
    throw new Error(buildNotLoggedInMessage("bigmodel-start-plan", `凭据解密失败：${e instanceof Error ? e.message : String(e)}`));
  }
  const jwt = plain["zcodejwttoken"]?.trim();
  if (!jwt) {
    throw new Error(
      "ZCode 套餐通道缺少 zcodejwttoken（桌面端/CLI 登录后凭据库应含该字段）。\n" +
      "请打开 ZCode 桌面端完成登录（或工具条 🔑 受控登录）后重试；" +
      `凭据文件：${credentialsPath()}`,
    );
  }
  opts.log?.(`[aiti-zcode-agent] start-plan 凭据就绪（zcodejwttoken ${jwt.length}B）`);
  if (fp) memJwt.set(fp, jwt);
  return { apiKey: jwt, providerId: "start-plan", source: "fresh" };
}

/** zcodejwttoken memo（按凭据指纹；桌面端重新登录后指纹变化自动失效）。 */
const memJwt = new Map<string, string>();

export interface AliyunCaptchaConfig {
  sceneId: string;
  prefix: string;
  region: string;
}

/**
 * 验证码 SDK 初始化三元组（桌面同款数据源）：服务端客户端配置 `data.configs.captcha`
 * （`/api/v1/client/configs`，Bearer zcodejwttoken；analysis §9 / 方案 §3.4 路径③）。
 * enabled:false 或缺字段 → null（前端验证卡不可用，轮次人话失败）。
 */
export async function fetchCaptchaConfig(jwt: string, f: FetchImpl = fetch): Promise<AliyunCaptchaConfig | null> {
  f = withFetchTimeout(f);
  const res = await f("https://zcode.z.ai/api/v1/client/configs", {
    headers: { Authorization: `Bearer ${jwt}`, "X-ZCode-App-Version": "3.11.2" },
  });
  if (!res.ok) throw new Error(`client/configs HTTP ${res.status}`);
  const j = await res.json() as { data?: { configs?: { captcha?: { enabled?: boolean; sceneId?: string; prefix?: string; region?: string } } } };
  const c = j.data?.configs?.captcha;
  if (!c?.enabled || typeof c.sceneId !== "string" || !c.sceneId || typeof c.prefix !== "string" || !c.prefix) return null;
  return { sceneId: c.sceneId, prefix: c.prefix, region: typeof c.region === "string" && c.region ? c.region : "cn" };
}

/** P1 模型目录 seed（§8.4，历史静态表）：现仅作动态目录（buildZcodeCatalogRefs，桌面端注册表优先）的兜底——
 *  未装桌面端的 headless 机器读不到 v2/config.json 时回落此表。勿新增通道到此，扩通道走注册表/套餐缓存。 */
export const ZCODE_MODEL_REFS: Array<{ id: string; label: string }> = [
  { id: "bigmodel/GLM-5.3-Flash", label: "GLM-5.3-Flash (ZCode)" },
  { id: "bigmodel/GLM-5.3", label: "GLM-5.3 (ZCode)" },
  { id: "bigmodel/GLM-5-Turbo", label: "GLM-5-Turbo (ZCode)" },
  { id: "zai/GLM-5.3-Flash", label: "GLM-5.3-Flash (ZCode·zai)" },
  { id: "zai/GLM-5.3", label: "GLM-5.3 (ZCode·zai)" },
  { id: "zai/GLM-5-Turbo", label: "GLM-5-Turbo (ZCode·zai)" },
];

export const DEFAULT_MODEL_REF = "bigmodel/GLM-5.3-Flash";

/** `--mode` 合法值（--prompt 缺省 yolo，backend 场景显式传；未知值回落 build）。 */
export const ZCODE_MODES = ["build", "edit", "plan", "yolo"] as const;

/** --json 输出的上下文窗口（projection.contextWindow，1M 窗口套餐）。 */
export const ZCODE_CONTEXT_WINDOW = 1_000_000;

/** 解析模型 ref："bigmodel/GLM-5.3" → { providerId, modelId }；通道须在已知集（seed ∪ 注册表 ∪ 套餐缓存），非法返回 null。 */
export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  const providerId = ref.slice(0, i);
  const modelId = ref.slice(i + 1);
  if (providerId.includes("/")) return null;
  if (!knownChannels().has(providerId)) return null;
  return { providerId, modelId };
}

export function baseUrlFor(providerId: string): string | undefined {
  const reg = readProviderRegistry().find((p) => p.channel === providerId && p.baseURL);
  if (reg?.baseURL) return reg.baseURL;
  return PROVIDER_BASE_URL[providerId];
}

// ============================================================================
// --json 输出解析（单 pretty JSON 对象；容忍前后噪声行）
// ============================================================================

export interface ParsedTurn {
  sessionId?: string;
  traceId?: string;
  turnId?: string;
  /** 归一后的回复文本（string / 块数组 / {text} 均已拍平）。 */
  response?: string;
  usage?: Record<string, unknown>;
  projection?: Record<string, unknown>;
}

/** 从 stdout 解析一轮结果；解析不出 JSON 返回 null（调用方按 CLI 失败处理）。 */
export function parseTurnOutput(stdout: string): ParsedTurn | null {
  const s = stdout.trim();
  if (!s) return null;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let m: unknown;
  try {
    m = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  return {
    ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}),
    ...(typeof o.traceId === "string" ? { traceId: o.traceId } : {}),
    ...(typeof o.turnId === "string" ? { turnId: o.turnId } : {}),
    ...(o.response !== undefined ? { response: extractResponseText(o.response) } : {}),
    ...(o.usage && typeof o.usage === "object" ? { usage: o.usage as Record<string, unknown> } : {}),
    ...(o.projection && typeof o.projection === "object" ? { projection: o.projection as Record<string, unknown> } : {}),
  };
}

/** response 字段拍平：string 直用；块数组取 text/thinking 之外文本块；{text} 取字段。 */
function extractResponseText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((b) => (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string"
        ? (b as Record<string, unknown>).text as string
        : ""))
      .filter(Boolean)
      .join("");
  }
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).text === "string") {
    return (v as Record<string, unknown>).text as string;
  }
  return "";
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** usage → pi-web UsageReport 归一（camelCase 字段，2026-09 实测）。 */
export function usageToReport(usage: Record<string, unknown> | undefined, model?: string): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const out: Record<string, unknown> = { provider: "zcode", ...(model ? { model } : {}) };
  const inputTokens = num(usage.inputTokens);
  const outputTokens = num(usage.outputTokens);
  const cacheReadTokens = num(usage.cacheReadTokens);
  const cacheWriteTokens = num(usage.cacheWriteTokens);
  const totalTokens = num(usage.totalTokens);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  // totalTokens 兜底：input 缺失时用 total - output 近似（CLI 实测 total ≈ input + output）
  if (inputTokens === undefined && totalTokens !== undefined && outputTokens !== undefined) {
    out.inputTokens = Math.max(0, totalTokens - outputTokens);
  }
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return Object.keys(out).length > (model ? 2 : 1) ? out : undefined;
}

/** CLI 失败时从 stderr 提取人话错误（responseBody JSON → 最后一条 Error: 行 → 尾行兜底）。 */
export function extractCliError(stderr: string, fallback: string): string {
  // responseBody 行按整行贪婪取（非贪婪会在内层引号提前截断）
  const rbLine = stderr.split("\n").find((l) => l.includes("responseBody:"));
  const rb = rbLine?.match(/responseBody:\s*['"](.*)['"]\s*,?\s*$/)?.[1];
  if (rb) {
    try {
      const j = JSON.parse(rb) as { error?: { message?: unknown } };
      if (j?.error?.message) return `zcode CLI: ${String(j.error.message)}`;
    } catch { /* 非 JSON，继续 */ }
  }
  const errs = [...stderr.matchAll(/^Error:\s*(.+)$/gm)];
  if (errs.length > 0) return `zcode CLI: ${errs[errs.length - 1][1].trim().slice(0, 300)}`;
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) return `zcode CLI: ${lines[lines.length - 1].slice(0, 300)}`;
  return fallback;
}

// ============================================================================
// 每轮进程编排（§8.3：单发进程，stdout 全量收集，stderr 尾部环形）
// ============================================================================

export interface ZcodeTurnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  stdout: string;
  stderrTail: string;
}

const STDERR_TAIL_BYTES = 8 * 1024;

export function execZcodeTurn(opts: {
  nodeBin: string;
  runtimePath: string;
  cliArgs: string[];
  cwd: string;
  env: Record<string, string>;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;
  /** abort 挂钩：拿到 child 后可 kill。 */
  onChild?: (child: ChildProcess) => void;
}): Promise<ZcodeTurnOutcome> {
  return new Promise((resolve, reject) => {
    // extman spawn.command/spawn.argsPrefix 启动包装，缺省 = 行为不变；P2 launchOverride 优先
    const ov = opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: opts.nodeBin,
      command: ov?.command?.trim() || spawnCommand("aiti-zcode-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-zcode-agent")).args,
      driverArgs: [opts.runtimePath, ...opts.cliArgs],
      env: opts.env,
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: opts.cwd,
      warn: (m) => console.log(`[aiti-zcode-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
    });
    opts.onChild?.(child);
    let stdout = "";
    let stderrTail = "";
    let killed = false;
    // StringDecoder 跨 chunk 安全解码（加固 A1）：逐 chunk toString 会切碎多字节字符
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : stdoutDec.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + (typeof chunk === "string" ? chunk : stderrDec.write(chunk))).slice(-STDERR_TAIL_BYTES);
    });
    child.once("error", (err) => reject(new Error(`spawn ${opts.nodeBin} 失败: ${err.message}`)));
    child.once("exit", (code, signal) => {
      if (signal) killed = true;
      resolve({ exitCode: code, signal, killed, stdout, stderrTail });
    });
  });
}

// ============================================================================
// 凭据链路（§5）：解密 → 静默换 key → 缓存
// ============================================================================

export function zcodeHome(): string {
  return process.env.AITI_ZCODE_HOME || join(homedir(), ".zcode");
}

export function credentialsPath(): string {
  return join(zcodeHome(), "v2", "credentials.json");
}

export function codingPlanCachePath(): string {
  return join(zcodeHome(), "v2", "coding-plan-cache.json");
}

export function desktopConfigPath(): string {
  return join(zcodeHome(), "v2", "config.json");
}

/**
 * 套餐可用性（桌面端同款数据源）：coding-plan-cache.json entryStatus.items 全量透出
 * （桌面端登录后由服务端同步维护，2026-09 起含 *-start-plan「ZCode 套餐」条目）。
 * key strip `builtin:` 前缀；读不到/坏 JSON → []（未装桌面端 / headless 服务器）。
 */
let _planStatusMemo: { fp: string | null; data: Array<{ channel: string; status: string }> } | null = null;

export function readPlanStatus(): Array<{ channel: string; status: string }> {
  // stat 指纹 memo：parseModelRef 在 turn 热路径每轮多次调用，readProviderRegistry/readPlanStatus
  // 各读一次小文件；文件未变（mtimeMs+size 一致）即命中缓存，桌面端重新登录后自动失效。
  const fp = statFingerprint(codingPlanCachePath());
  if (_planStatusMemo && _planStatusMemo.fp === fp) return _planStatusMemo.data;
  let data: Array<{ channel: string; status: string }> = [];
  try {
    const j = JSON.parse(readFileSync(codingPlanCachePath(), "utf8")) as {
      entryStatus?: { items?: Record<string, { status?: string }> };
    };
    data = Object.entries(j.entryStatus?.items ?? {}).map(([k, v]) => ({
      channel: k.replace(/^builtin:/, ""),
      status: typeof v?.status === "string" ? v.status : "unknown",
    }));
  } catch { /* 未登录/缺文件 */ }
  _planStatusMemo = { fp, data };
  return data;
}

/**
 * 套餐通道状态 → agent-manager 额度视图（统一显示契约，2026-09-13）：
 * zcode 官方无额度数值接口，展示套餐通道可用性（数据源 = coding-plan-cache.json）。
 * 纯函数（无 IO），便于单测。
 */
export function planQuotaView(
  status: Array<{ channel: string; status: string }>,
  now = Date.now(),
): Record<string, unknown> {
  if (!status.length) {
    return { available: false, reason: "no-plan-cache", note: "未读到 coding-plan-cache.json（未装桌面端 / headless 未登录）", fetchedAt: now };
  }
  const available = status.filter((s) => s.status === "available").map((s) => s.channel);
  return {
    available: true,
    display: available.length ? `套餐：${available.join(", ")} 可用` : "套餐：无可用通道",
    unit: "plan",
    note: "z.ai/bigmodel 套餐通道状态（官方无额度数值接口）",
    packages: status.map((s) => ({ name: s.channel, note: s.status })),
    fetchedAt: now,
  };
}

/**
 * 桌面端 provider 注册表（v2/config.json provider 段）：channel → baseURL + 模型 id 表。
 * 桌面端随版本/套餐自动维护（不写死端点与模型目录的权威来源）；读不到 → []。
 */
let _registryMemo: { fp: string | null; data: Array<{ channel: string; baseURL?: string; models: string[]; label?: string }> } | null = null;

export function readProviderRegistry(): Array<{ channel: string; baseURL?: string; models: string[]; label?: string }> {
  const fp = statFingerprint(desktopConfigPath());
  if (_registryMemo && _registryMemo.fp === fp) return _registryMemo.data;
  let data: Array<{ channel: string; baseURL?: string; models: string[]; label?: string }> = [];
  try {
    const j = JSON.parse(readFileSync(desktopConfigPath(), "utf8")) as {
      provider?: Record<string, { name?: unknown; baseURL?: unknown; options?: { baseURL?: unknown }; models?: unknown }>;
    };
    data = Object.entries(j.provider ?? {}).map(([k, v]) => ({
      channel: k.replace(/^builtin:/, ""),
      // 桌面端真实结构把端点写在 provider.options.baseURL（2026-09-12 48/155 双机实测）；
      // 顶层 baseURL 保留兼容兜底。
      ...(typeof v?.baseURL === "string" && v.baseURL
        ? { baseURL: v.baseURL }
        : typeof v?.options?.baseURL === "string" && v.options.baseURL
          ? { baseURL: v.options.baseURL }
          : {}),
      models: v?.models && typeof v.models === "object" ? Object.keys(v.models) : [],
      ...(typeof v?.name === "string" && v.name ? { label: v.name } : {}),
    }));
  } catch { /* 缺文件 */ }
  _registryMemo = { fp, data };
  return data;
}

/** 通道 → 家族（bigmodel-start-plan → bigmodel）。 */
export function channelFamily(channel: string): string {
  return channel.split("-")[0];
}

/** start-plan（ZCode 套餐）通道：凭据注入已按桌面同款打通（zcodejwttoken → upsertModelProvider），
 *  但端点对模型请求强制阿里云验证码校验（3007），验证参数只能由桌面 GUI 会话产生——
 *  pi-web 网页环境的验证码验签过不了（2026-09-13 实证），故 headless/网页不可驱动，已从目录排除。 */
export function isStartPlanChannel(channel: string): boolean {
  return channel.endsWith("-start-plan");
}

/** 通道排序：可驱动（API-key / coding-plan）在前，start-plan（桌面端）在后。 */
function channelRank(channel: string): number {
  return isStartPlanChannel(channel) ? 1 : 0;
}

/**
 * 动态模型目录（不写死），以桌面端实际可见为准（2026-09-12 用户要求：不显示与桌面端不一致的套餐）：
 * - 通道集 = 静态 seed 通道 ∪ 桌面端注册表 ∪ 套餐缓存；start-plan 仅 available（桌面端实据）；
 * - 套餐缓存可读（桌面端登录过）→ 按 isChannelDriveable 通道级裁决：套餐缓存跟踪的通道
 *   须**自身** available（2026-09-15 收紧——原家族级放行会把 unavailable 的 coding-plan
 *   通道列进目录，选中即每轮 429/1113）；base 通道维持家族门；缓存缺失保持全列，coding-plan 走原 available 门；
 * - **标签 = zcode 通道 id 原样**（`模型id (通道id)`，builtin: 前缀剥除）——零归一化零造词，
 *   2026-09-13 用户拍板：能拿到 bigmodel-coding-plan 就直接显示，不得归一化为自造术语；
 * - 注册表模型权威：注册表有该通道模型则不再并入静态 seed（防下架档位残留）；无则 seed 兜底老机型。
 * - start-plan（ZCode 套餐）通道不再排除（2026-09-15 起，用户拍板）：端点对无头/网页请求强制阿里云
 *   验证码 3007、验证参数只能由桌面 GUI 会话产生——pi-web 网页环境验签过不了（isChannelDriveable 恒
 *   false），故**照常列出但标签带「暂不支持」提示**（仅桌面端实据 available 时列，避免与桌面端不一致），
 *   让用户感知通道存在；选中/发消息由 index.ts 人话拦截（需验证码、暂不支持）。
 * 返回 `channel/modelId` ref 表，可驱动通道在前、start-plan 在后。
 */
export function buildZcodeCatalogRefs(): Array<{ id: string; label: string }> {
  const registry = new Map(readProviderRegistry().map((p) => [p.channel, p]));
  const planItems = readPlanStatus();
  const available = new Set(planItems.filter((x) => x.status === "available").map((x) => x.channel));
  const channels = new Set<string>([...Object.keys(PROVIDER_BASE_URL), ...registry.keys(), ...available.keys()]);
  const out: Array<{ id: string; label: string }> = [];
  for (const channel of [...channels].sort((a, b) => channelRank(a) - channelRank(b) || a.localeCompare(b))) {
    const isStart = isStartPlanChannel(channel);
    if (isStart) {
      // 套餐通道（start-plan）：验证码只能桌面 GUI 产生、pi-web 无法驱动（isChannelDriveable 恒 false）。
      // 不再排除——桌面端实据 available 时照常列出（标签带「暂不支持」提示，见下），让用户感知存在；
      // 无实据（套餐缓存无此通道）不列，保持与桌面端一致。
      if (!available.has(channel)) continue;
    } else {
      const driveable = isChannelDriveable(channel);
      if (driveable === false) continue;
      // 套餐缓存缺失（isChannelDriveable → null，headless 老机型）：coding-plan 通道走原 available 门
      if (driveable === null && channel.endsWith("-coding-plan") && available.size > 0 && !available.has(channel)) {
        continue;
      }
    }
    const regModels = registry.get(channel)?.models ?? [];
    const models = regModels.length > 0
      ? regModels
      : ZCODE_MODEL_REFS.filter((m) => m.id.split("/")[0] === channel).map((m) => m.id.split("/")[1]);
    for (const modelId of models) {
      // 标签 = zcode 通道 id 原样（builtin: 命名空间前缀按惯例剥除）；零归一化零造词；
      // start-plan 通道追加「暂不支持」提示（驱动不可用，见 isStartPlanChannel 注释）。
      out.push({ id: `${channel}/${modelId}`, label: `${modelId} (${channel})${isStart ? " · 暂不支持" : ""}` });
    }
  }
  return out;
}

/** 解析模型 ref 时认可的通道集（seed ∪ 注册表 ∪ 套餐缓存全条目）。 */
function knownChannels(): Set<string> {
  return new Set<string>([
    ...Object.keys(PROVIDER_BASE_URL),
    ...readProviderRegistry().map((p) => p.channel),
    ...readPlanStatus().map((x) => x.channel),
  ]);
}

/**
 * 轻量探测默认模型通道家族（不碰加密、不发网络）：读套餐缓存的 available 状态，
 * 可驱动通道（coding-plan / API-key）优先；仅有 start-plan（ZCode 套餐）可用时
 * 回落到该家族——start-plan 端点本身 headless 不可驱动（不选它），但家族内还有
 * base / coding-plan 通道（目录里展示的就是这些），默认模型应落在该可用家族。
 * 返回 null = 探测不出（未登录/文件缺）——调用方回落 bigmodel。
 */
export function detectPlanProvider(): "bigmodel" | "zai" | null {
  const available = new Set(readPlanStatus().filter((x) => x.status === "available").map((x) => x.channel));
  for (const channel of ["bigmodel-coding-plan", "bigmodel", "zai-coding-plan", "zai"]) {
    if (available.has(channel)) return channelFamily(channel) as "bigmodel" | "zai";
  }
  // 仅有 start-plan 可用（桌面端体验套餐）：家族仍可裁决——start-plan 本身不作默认，
  // 但同家族 base/coding-plan 通道在目录内且可驱动（2026-09-14 实测踩坑：此前返回
  // null 会回落 bigmodel，在只有 zai 套餐的机器上种出目录外的无效默认模型）。
  for (const channel of available) {
    if (!isStartPlanChannel(channel)) continue;
    const family = channelFamily(channel);
    if (family === "bigmodel" || family === "zai") return family;
  }
  return null;
}

/**
 * 通道可驱动判定（2026-09-15 通道级收紧；目录 buildZcodeCatalogRefs / index.ts
 * createSession 种子与恢复校验 / lastUsedModelRef 共用，勿在他处重写）：
 * - start-plan：false（验证码只能桌面 GUI 产生，headless 不可驱动——2026-09-13 拍板）；
 * - 套餐缓存跟踪的通道（*-coding-plan 等）：**该通道自身** status=available 才可驱动——
 *   原家族级连带放行会种出「选中即每轮 429/1113」的死通道（2026-09-15 实测：仅
 *   zai-start-plan available 时 zai-coding-plan（not_entitled）仍被列出并被选为默认）；
 * - base 通道（bigmodel/zai，不在套餐缓存、OAuth/API-key 凭据驱动）：维持家族门
 *   （家族内有 available 套餐即放行；凭据缺失由 ensureCredential 人话报错兜底）；
 * - 返回 null = 套餐缓存缺失探测不出（headless 老机型）→ 调用方按旧家族逻辑自行裁决。
 */
export function isChannelDriveable(providerId: string): boolean | null {
  if (isStartPlanChannel(providerId)) return false;
  const planItems = readPlanStatus();
  if (!planItems.length) return null;
  const own = planItems.find((x) => x.channel === providerId)?.status;
  if (own !== undefined) return own === "available";
  return planItems.some((x) => x.status === "available" && channelFamily(x.channel) === channelFamily(providerId));
}

/**
 * fallback secret 推导（§5.2，实测可解）：
 *   secret = ZCODE_CREDENTIAL_SECRET env ?? "zcode-credential-fallback:{platform}:{homedir}:{username}"
 */
export function deriveCredentialSecret(parts?: { platform?: string; homedir?: string; username?: string; secretEnv?: string }): string {
  const secretEnv = parts?.secretEnv ?? process.env.ZCODE_CREDENTIAL_SECRET;
  if (secretEnv) return secretEnv;
  const platform = parts?.platform ?? process.platform;
  const home = parts?.homedir ?? homedir();
  const username = parts?.username ?? userInfo().username;
  return `zcode-credential-fallback:${platform}:${home}:${username}`;
}

/** 解开单个 enc:v1:{iv}.{tag}.{ct}（aes-256-gcm，key=sha256(secret)）。 */
export function decryptEncValue(enc: string, secret: string): string {
  const body = enc.replace(/^enc:v1:/, "");
  const [ivB, tagB, ctB] = body.split(".");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}

/** 解密整份 credentials.json：enc:v1 值逐个解开，明文值原样保留。解密失败抛错。 */
export function decryptCredentials(raw: Record<string, unknown>, secret: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    out[k] = v.startsWith("enc:v1:") ? decryptEncValue(v, secret) : v;
  }
  return out;
}

/** stat 指纹（mtimeMs:size，文件不存在 → null）：凭据缓存 + 目录数据 memo 共用。 */
function statFingerprint(p: string): string | null {
  try {
    const st = statSync(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}

/** credentials.json 指纹（mtimeMs:size）——桌面端重新授权后自动失效缓存。null = 文件不存在。 */
export function credentialFingerprint(p = credentialsPath()): string | null {
  return statFingerprint(p);
}

/** 「默认机构/项目」选取：isDefault → 名称含「默认」→ 第一个（§5.3 + 2026-09 实测 isDefault 字段）。 */
export function pickDefault<T extends Record<string, unknown>>(list: T[] | undefined, nameField: string): T | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.find((x) => x.isDefault === true)
    ?? list.find((x) => typeof x[nameField] === "string" && (x[nameField] as string).includes("默认"))
    ?? list[0];
}

/**
 * bigmodel 静默换 key（§5.3 官方 login 非交互复刻，2026-09-06 全链路实测）：
 * getCustomerInfo（Authorization: <token> 无 Bearer）→ 默认机构/项目
 * → api_keys 找 name="zcode-api-key"（无则 POST 创建，幂等）→ copy 端点取完整 secretKey
 * → key = `${apiKey}.${secretKey}`（智谱 id.secret 格式）。
 */
export async function fetchBigModelApiKey(token: string, f: FetchImpl = fetch): Promise<string> {
  f = withFetchTimeout(f);
  const H: Record<string, string> = { Authorization: token };
  const info = await f("https://bigmodel.cn/api/biz/customer/getCustomerInfo", { headers: H });
  const infoJson = await info.json().catch(() => null) as { code?: number; msg?: string; success?: boolean; data?: Record<string, unknown> } | null;
  if (!infoJson || infoJson.code !== 200 || infoJson.success !== true) {
    throw new Error(`getCustomerInfo 失败: code=${infoJson?.code} msg=${infoJson?.msg ?? "HTTP " + info.status}`);
  }
  const orgs = infoJson.data?.organizations as Array<Record<string, unknown>> | undefined;
  const org = pickDefault(orgs, "organizationName");
  const proj = pickDefault(org?.projects as Array<Record<string, unknown>> | undefined, "projectName");
  const orgId = typeof org?.organizationId === "string" ? org.organizationId : undefined;
  const projId = typeof proj?.projectId === "string" ? proj.projectId : undefined;
  if (!orgId || !projId) throw new Error("getCustomerInfo 未返回可用的机构/项目（organizations/projects 为空）");

  const base = `https://bigmodel.cn/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`;
  const listJson = await f(base, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const items = Array.isArray(listJson?.data) ? listJson.data as Array<Record<string, unknown>> : [];
  let entry = items.find((k) => k?.name === "zcode-api-key");
  if (!entry) {
    const created = await f(base, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zcode-api-key" }),
    }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
    entry = (created?.data ?? null) as Record<string, unknown> | null;
    if (entry && Array.isArray((entry as { items?: unknown }).items)) {
      entry = ((entry as { items: Array<Record<string, unknown>> }).items ?? []).find((k) => k?.name === "zcode-api-key") ?? null;
    }
  }
  const apiKey = typeof entry?.apiKey === "string" ? entry.apiKey : undefined;
  if (!apiKey) throw new Error("zcode-api-key 查找/创建失败（api_keys 列表无该条目且创建未返回）");

  const copyJson = await f(`${base}/copy/${apiKey}`, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const d = copyJson?.data;
  const secretKey = typeof d === "string" ? d : (d as Record<string, unknown> | undefined)?.secretKey;
  if (typeof secretKey !== "string" || !secretKey || secretKey.includes("*")) {
    throw new Error(`copy secretKey 失败: code=${(copyJson as { code?: unknown })?.code}`);
  }
  return `${apiKey}.${secretKey}`;
}

/**
 * zai 通道静默换 key（§5.3 zai 分支：login 换 biz token → Bearer 走同构 fbr 流程）。
 * ⚠️ 2026-09-14 实测：OAuth token 只在官方登录时能换一次 key（换过即失效/过期），
 *    之后重呼 z/login 服务端返回 code=500 "Z.ai user information is invalid"。
 *    故本函数只作「桌面 config.json 无现成通道 key」时的兜底；失败 fail-loud
 *    并指引重新登录 / apiKeyOverride / 换通道。
 */
export async function fetchZaiApiKey(token: string, f: FetchImpl = fetch): Promise<string> {
  f = withFetchTimeout(f);
  const loginJson = await f("https://api.z.ai/api/auth/z/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).then((r) => r.json()).catch(() => null) as Record<string, unknown> | null;
  const d = loginJson?.data as Record<string, unknown> | undefined;
  const biz = loginJson?.access_token ?? d?.access_token ?? d?.token;
  if (typeof biz !== "string" || !biz) {
    const code = loginJson?.code;
    const msg = loginJson?.msg;
    const detail = [
      code !== undefined ? `code=${String(code)}` : null,
      typeof msg === "string" && msg ? `msg=${msg}` : null,
    ].filter(Boolean).join(" ");
    throw new Error(
      `zai login 未换到 biz token${detail ? `（服务端：${detail}）` : "（响应结构可能与预期不同）"}。`
      + "OAuth token 过期或已用于换过 key——请重新登录 ZCode（工具条 🔑 受控登录），"
      + "或改选其它通道 / 在扩展管理器填 zcode.apiKeyOverride。",
    );
  }

  const H: Record<string, string> = { Authorization: `Bearer ${biz}` };
  const base0 = "https://api.z.ai";
  const infoJson = await f(`${base0}/api/biz/customer/getCustomerInfo`, { headers: H }).then((r) => r.json()).catch(() => null) as Record<string, unknown> | null;
  const data = (infoJson?.data ?? infoJson) as Record<string, unknown> | undefined;
  const org = pickDefault(data?.organizations as Array<Record<string, unknown>> | undefined, "organizationName");
  const proj = pickDefault(org?.projects as Array<Record<string, unknown>> | undefined, "projectName");
  const orgId = typeof org?.organizationId === "string" ? org.organizationId : undefined;
  const projId = typeof proj?.projectId === "string" ? proj.projectId : undefined;
  if (!orgId || !projId) throw new Error("zai getCustomerInfo 未返回可用的机构/项目");

  const base = `${base0}/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`;
  const listJson = await f(base, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const items = Array.isArray(listJson?.data) ? listJson.data as Array<Record<string, unknown>> : [];
  const entry = items.find((k) => k?.name === "zcode-api-key");
  const apiKey = typeof entry?.apiKey === "string" ? entry.apiKey : undefined;
  if (!apiKey) throw new Error("zai api_keys 中无 zcode-api-key（zai 通道创建流程未实现，请改用 bigmodel 通道或手动填 zcode.apiKeyOverride）");
  const copyJson = await f(`${base}/copy/${apiKey}`, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const cd = copyJson?.data;
  const secretKey = typeof cd === "string" ? cd : (cd as Record<string, unknown> | undefined)?.secretKey;
  if (typeof secretKey !== "string" || !secretKey || secretKey.includes("*")) throw new Error("zai copy secretKey 失败");
  return `${apiKey}.${secretKey}`;
}

/** 未登录的人话指引（§5.4 三条出路）。 */
export function buildNotLoggedInMessage(providerId: string, detail: string): string {
  return [
    `ZCode 凭据不可用（${detail}）。`,
    "",
    "解决（任选其一）：",
    CONTROLLED_LOGIN_HINT,
    "1. 本机装有 ZCode 桌面端：打开桌面端 → 左下角「连接使用」→ 连接 BigModel/Z.ai 完成授权，然后重试；",
    "2. headless 服务器：在有浏览器的机器上运行 zcode CLI 的 `login --no-browser`，按打印的 URL 完成 OAuth；",
    "3. 或在智谱开放平台手动创建 API Key，填到 扩展管理器 → aiti-zcode-agent → 功能管理 → zcode.apiKeyOverride。",
    "",
    `（通道：${providerId}；凭据文件：${credentialsPath()}）`,
  ].join("\n");
}

/**
 * turn 错误 → 用户可读消息（UI 红色错误帧正文）。已知 provider 错误给出原因 + 可行动指引，
 * 未知错误原样透传。
 */
export function humanizeZcodeError(raw: string): string {
  const s = raw.trim();
  // z.ai 余额/权益拒绝（429，官方 message 形如 `[1113][Insufficient balance or no resource package...]`）
  if (/\[1113\]|Insufficient balance|no resource package/i.test(s)) {
    return [
      "Z.ai 账号没有 GLM Coding Plan 权益（或余额不足）——z.ai 拒绝了本次请求（错误码 1113）。",
      "解决（任选其一）：",
      "1. 在 z.ai 开通/续费 GLM Coding Plan（或充值）后重试；",
      "2. 在模型选择器改选其它可用通道的模型（如 bigmodel/…）；",
      "3. 或在 扩展管理器 → aiti-zcode-agent → 功能管理 填自己的 zcode.apiKeyOverride。",
      "",
      `原始错误：${s}`,
    ].join("\n");
  }
  return s;
}

/** 受控登录入口指引（工具条 🔑 = 受控登录弹窗，docs/ext-controlled-login-standard.md）。 */
export const CONTROLLED_LOGIN_HINT =
  "0. 受控登录（推荐，headless 适用）：pi-web 工具条 🔑「登录 ZCode」一键发起——后端 spawn 官方 login，授权链接发给你，任意设备浏览器打开完成授权，凭据自动落盘（需 z.ai 账号；bigmodel 国内套餐走第 2 条）；";

export interface CredentialResult {
  apiKey: string;
  providerId: string;
  /** desktop = 桌面端 config.json 现成通道 key（官方登录时换好写入，官方 CLI 每轮直接用它）。 */
  source: "override" | "cache" | "fresh" | "desktop";
}

/**
 * 桌面端 config.json 现成通道 key（`builtin:<providerId>.options.apiKey`）。
 * 官方 CLI 只在 OAuth 登录时调一次 z/login 换 key 并写入这里，之后每轮直接用它；
 * 换过的 OAuth token 会失效，重呼 z/login 必失败（2026-09-14 实测）——凭据链优先复用它。
 */
export function readDesktopChannelApiKey(providerId: string): string | null {
  try {
    const j = JSON.parse(readFileSync(desktopConfigPath(), "utf8")) as {
      provider?: Record<string, { options?: { apiKey?: unknown } }>;
    };
    const k = j.provider?.[`builtin:${providerId}`]?.options?.apiKey;
    return typeof k === "string" && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

// 内存缓存：凭据指纹不变即复用（避免每轮解密 + 每轮打 API）
const memCred = new Map<string, { apiKey: string; fingerprint: string | null }>();

function keyCachePath(configDir: string): string {
  return join(configDir, "zcode-api-key.json");
}

function readKeyCache(configDir: string): { apiKey: string; providerId: string; fingerprint: string | null } | null {
  try {
    const j = JSON.parse(readFileSync(keyCachePath(configDir), "utf8")) as { apiKey?: unknown; providerId?: unknown; fingerprint?: unknown };
    if (typeof j.apiKey !== "string" || !j.apiKey) return null;
    return {
      apiKey: j.apiKey,
      providerId: typeof j.providerId === "string" ? j.providerId : "",
      fingerprint: typeof j.fingerprint === "string" ? j.fingerprint : null,
    };
  } catch {
    return null;
  }
}

function writeKeyCache(configDir: string, v: { apiKey: string; providerId: string; fingerprint: string | null }): void {
  try {
    mkdirSync(configDir, { recursive: true });
    const p = keyCachePath(configDir);
    // 先 0600 建文件再写内容（防窗口期宽松权限）
    if (!existsSync(p)) closeSync(openSync(p, "w", 0o600));
    writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn("[aiti-zcode-agent] key 缓存写失败（不影响本轮）:", e instanceof Error ? e.message : e);
  }
}

/**
 * ensureCredential（§8.2）：override → 桌面 config.json 现成通道 key → 内存缓存（指纹校验）
 * → 磁盘缓存 → 解密+静默换 key。providerId 以「当前模型 ref 的 provider」为准（模型选择决定通道）。
 */
export async function ensureCredential(opts: {
  providerId: string;
  configDir: string;
  override?: string;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}): Promise<CredentialResult> {
  const { providerId, configDir } = opts;
  const log = opts.log ?? (() => {});
  if (opts.override) return { apiKey: opts.override, providerId, source: "override" };
  if (isStartPlanChannel(providerId)) {
    throw new Error(
      `ZCode 套餐通道（${providerId}）暂无法在无头模式驱动（2026-09-13 桌面端逆向复核）：\n` +
      "官方套餐端点（zcode.z.ai/api/v1/zcode-plan/anthropic）对模型请求强制阿里云验证码校验" +
      "（3007 CAPTCHA_VERIFY_FAILED / x-aliyun-captcha-verify-param，桌面端内嵌 zcode-aliyun-captcha 组件解验，含 captcha-retry 重试流）。\n" +
      "凭据注入本身已按桌面同款打通（凭据库 zcodejwttoken → workspace/upsertModelProvider inline apiKey，请求可直达套餐端点），" +
      "但验证码参数只能由桌面 GUI 会话产生，同一 JWT 无头直连即 400 captcha verify failed。\n" +
      "请改选 Coding Plan / API Key 通道的模型（bigmodel/… 或 zai/…）；套餐通道请在 ZCode 桌面端内使用。",
    );
  }

  const fp = credentialFingerprint();
  const memKey = `${providerId}`;

  // 桌面端已登录且该通道有现成 key（官方登录时换好、写入 config.json；官方 CLI 每轮直接用它）：
  // 直接复用，不再调 z/login（OAuth token 换过一次即失效，2026-09-14 实证
  // code=500 "Z.ai user information is invalid"）。
  const desktopKey = readDesktopChannelApiKey(providerId);
  if (desktopKey) {
    memCred.set(memKey, { apiKey: desktopKey, fingerprint: fp });
    return { apiKey: desktopKey, providerId, source: "desktop" };
  }

  const mem = memCred.get(memKey);
  if (mem && mem.fingerprint === fp) return { apiKey: mem.apiKey, providerId, source: "cache" };

  const disk = readKeyCache(configDir);
  if (disk && disk.providerId === providerId && disk.fingerprint !== null && disk.fingerprint === fp) {
    memCred.set(memKey, { apiKey: disk.apiKey, fingerprint: fp });
    return { apiKey: disk.apiKey, providerId, source: "cache" };
  }

  const raw = (() => {
    try {
      return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(buildNotLoggedInMessage(providerId, `凭据文件不可读：${e instanceof Error ? e.message : String(e)}`));
    }
  })();
  let plain: Record<string, string>;
  try {
    plain = decryptCredentials(raw, deriveCredentialSecret());
  } catch (e) {
    throw new Error(buildNotLoggedInMessage(providerId, `凭据解密失败（跨设备拷贝的 credentials.json 无法在本机解开）：${e instanceof Error ? e.message : String(e)}`));
  }
  const family = channelFamily(providerId);
  const token = plain[`oauth:${family}:access_token`];
  if (!token) {
    const has = Object.keys(plain).filter((k) => k.startsWith("oauth:") && k.includes(":access_token")).map((k) => k.split(":")[1]);
    const detail = has.length > 0
      ? `已登录通道为 [${has.join(", ")}]，与当前模型通道 ${providerId} 不匹配（可在模型选择器切换通道，或重新授权）`
      : "credentials.json 中无 OAuth token（未登录）";
    throw new Error(buildNotLoggedInMessage(providerId, detail));
  }
  log(`[aiti-zcode-agent] 凭据指纹变化，静默换取 ${family} zcode-api-key…`);
  const apiKey = family === "bigmodel"
    ? await fetchBigModelApiKey(token, opts.fetchImpl)
    : await fetchZaiApiKey(token, opts.fetchImpl);
  memCred.set(memKey, { apiKey, fingerprint: fp });
  writeKeyCache(configDir, { apiKey, providerId, fingerprint: fp });
  return { apiKey, providerId, source: "fresh" };
}

/** 测试钩子：清内存凭据缓存。 */
export function resetCredentialCacheForTests(): void {
  memCred.clear();
}

/** 测试钩子：清目录数据 memo（readProviderRegistry/readPlanStatus 的 stat 指纹缓存）。 */
export function resetZcodeCatalogCacheForTests(): void {
  _registryMemo = null;
  _planStatusMemo = null;
}

// ============================================================================
// runtime 生命周期（§3/§8.1）：指定 → 探测 → 下载 → 解压缓存
// ============================================================================

export interface ResolvedRuntime {
  /** zcode.cjs 绝对路径（用 node 执行）。 */
  cjsPath: string;
  /** AppImage 版本（ZCODE_APP_VERSION 对齐桌面端 UA；Windows 安装从 app.asar 尽力解析；来源非 AppImage 时缺省）。 */
  appVersion?: string;
  origin: "feature" | "install" | "mount" | "appimage" | "download";
}

/** AppImage 文件名 → 版本（ZCode-3.11.2-linux-x64.AppImage → 3.11.2）。 */
export function parseAppImageVersion(p: string): string | null {
  const m = p.match(/ZCode-(\d+(?:\.\d+)+)/);
  return m ? m[1] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 解压缓存目录：<extRoot>/cache/runtime/ZCode-<ver>/resources/glm/zcode.cjs（解压根直接改名 ZCode-<ver>）。
 *  数据分层：configDir = <extRoot>/config → cache 在 dirname(configDir) 下。 */
export function cachedRuntimeCjs(configDir: string, version: string): string {
  return join(dirname(configDir), "cache", "runtime", `ZCode-${version}`, "resources", "glm", "zcode.cjs");
}

/**
 * 可读性探测：statSync 对断开的 FUSE 挂载点残留（AppImage 卸载后 /tmp/.mount_ZCode-* 空壳）
 * 仍返回“文件存在”（isFile() 通过），open/read 时才报 ENOTCONN——只在 stat 通过的候选上
 * 追加 open+read 探测，避免残留挂载点劫持运行时解析（2026-09-18 生产事故根因）。
 */
export function isReadableFile(p: string): boolean {
  try {
    const fd = openSync(p, "r");
    try { readSync(fd, Buffer.alloc(8), 0, 8, 0); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}

function findCjsUnderDir(dir: string): string | null {
  const candidates = [join(dir, "resources", "glm", "zcode.cjs"), join(dir, "zcode.cjs")];
  for (const c of candidates) {
    try { if (statSync(c).isFile() && isReadableFile(c)) return c; } catch { /* next */ }
  }
  return null;
}

/**
 * Windows 常见安装目录（NSIS/绿色版/用户级 Electron 安装全覆盖）：
 *   %ProgramFiles%\ZCode、%ProgramFiles(x86)%\ZCode、%LOCALAPPDATA%\ZCode、%LOCALAPPDATA%\Programs\ZCode。
 * env 可注入（测试隔离）。
 */
export function windowsInstallDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  // Windows 路径恒用反斜杠拼接（path.join 在非 win32 宿主上产 "/"，测试钉反斜杠；
  // win32 上行为不变——这些简单段无 ".." 与尾随分隔符，join 等价）
  const winJoin = (...parts: string[]) => parts.filter(Boolean).join("\\");
  const out: string[] = [];
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const base = env[key];
    if (base) out.push(winJoin(base, "ZCode"));
  }
  const la = env.LOCALAPPDATA;
  if (la) {
    out.push(winJoin(la, "ZCode"));
    out.push(winJoin(la, "Programs", "ZCode"));
  }
  return [...new Set(out)];
}

/**
 * 从 Windows 安装目录的 resources/app.asar 尽力解析桌面端版本（ZCODE_APP_VERSION 对齐 UA）。
 * 支持 @electron/asar v3 新格式（header 在文件头：[u32 x4][header JSON][data]）与
 * 旧格式（header 在文件尾：[data][u32 size][u32 headerSize][header JSON]）；
 * 任何一步失败返回 null（版本缺省不致命，运行时本身已可用）。
 */
export function detectWindowsInstallVersion(installDir: string): string | null {
  let fd: number;
  try { fd = openSync(join(installDir, "resources", "app.asar"), "r"); } catch { return null; }
  try {
    const st = fstatSync(fd);
    const readPkgVersion = (headerBuf: Buffer, offsetBase: number): string | null => {
      try {
        const header = JSON.parse(headerBuf.toString("utf8")) as { files?: Record<string, { size: number; offset?: number | string }> };
        const pj = header.files?.["package.json"];
        if (!pj) return null;
        const off = parseInt(String(pj.offset), 10);
        if (!Number.isFinite(off) || !Number.isFinite(pj.size) || off < 0) return null;
        const pos = offsetBase + off;
        if (pos + pj.size > st.size) return null;
        const dbuf = Buffer.alloc(pj.size);
        if (readSync(fd, dbuf, 0, pj.size, pos) !== pj.size) return null;
        const v = (JSON.parse(dbuf.toString("utf8")) as { version?: unknown })?.version;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    };
    // 新格式：[u32][u32 size][u32 size-4][u32 headerSize][header JSON][data]，header JSON 从 offset 16 起
    const head = Buffer.alloc(16);
    if (st.size > 16 && readSync(fd, head, 0, 16, 0) === 16) {
      const headerSize = head.readUInt32LE(12);
      if (headerSize > 0 && 16 + headerSize < st.size) {
        const hbuf = Buffer.alloc(headerSize);
        if (readSync(fd, hbuf, 0, headerSize, 16) === headerSize && hbuf.toString("utf8").includes("\"files\"")) {
          const v = readPkgVersion(hbuf, 16 + headerSize);
          if (v) return v;
        }
      }
    }
    // 旧格式：尾部 [u32 size][u32 headerSize][header JSON]，header JSON 起点 = size - 末尾 8 字节
    if (st.size > 8) {
      const tail = Buffer.alloc(8);
      if (readSync(fd, tail, 0, 8, st.size - 8) === 8) {
        const size = tail.readUInt32LE(0);
        const headerSize = tail.readUInt32LE(4);
        const headerStart = st.size - size;
        if (headerSize > 0 && headerSize + 8 === size && headerStart >= 0 && headerStart + headerSize <= st.size) {
          const hbuf = Buffer.alloc(headerSize);
          if (readSync(fd, hbuf, 0, headerSize, headerStart) === headerSize) {
            const v = readPkgVersion(hbuf, 0);
            if (v) return v;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** rename 目标占位目录若为空则移除（rename 需要目标不存在）。 */
function rmdirIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch { /* 不存在即可 */ }
}

/**
 * 解压 AppImage（免 root）：优先 pattern 提取 resources/glm/*（只取 CLI，省 200MB Electron），
 * 失败回退全量提取。产物落到 <extRoot>/cache/runtime/ZCode-<ver>/（同分区 rename，跨设备 cp 兜底）。
 * 注：configDir = <extRoot>/config（三目录对称）→ 缓存根 = dirname(configDir)。
 */
export async function extractAppimage(appImage: string, configDir: string, version: string, log = console.log): Promise<string> {
  const cached = cachedRuntimeCjs(configDir, version);
  if (existsSync(cached)) return cached;
  const work = mkdtempSync(join(tmpdir(), "zcode-extract-"));
  try {
    try { chmodSync(appImage, 0o755); } catch { /* 只读挂载等——--appimage-extract 仍可能可用 */ }
    // 先试 pattern 提取（AppImage runtime 内建 glob）；不支持 pattern 的旧 runtime 回退全量
    for (const args of [["--appimage-extract", "resources/glm/*"], ["--appimage-extract"]]) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(appImage, args, { cwd: work, stdio: "ignore" });
        child.once("error", () => resolve(false));
        child.once("exit", (code) => resolve(code === 0));
      });
      const produced = findCjsUnderDir(join(work, "squashfs-root"));
      if (ok && produced) {
        // 3.17+ provider 闸需要 <resources>/config/provider/zcode-builtin.json，glm-only pattern 不含
        // → 缺失时二次 pattern 提取补齐（独立临时目录提取后并入，规避旧 runtime 重复提取行为不明）。
        const cfg = join(work, "squashfs-root", "resources", "config", "provider", "zcode-builtin.json");
        if (!existsSync(cfg)) {
          const work2 = mkdtempSync(join(tmpdir(), "zcode-extract-cfg-"));
          try {
            const ok2 = await new Promise<boolean>((resolve) => {
              const c2 = spawn(appImage, ["--appimage-extract", "resources/config/*"], { cwd: work2, stdio: "ignore" });
              c2.once("error", () => resolve(false));
              c2.once("exit", (code) => resolve(code === 0));
            });
            const srcCfg = join(work2, "squashfs-root", "resources", "config");
            if (ok2 && existsSync(srcCfg)) {
              cpSync(srcCfg, join(work, "squashfs-root", "resources", "config"), { recursive: true });
            }
          } finally {
            rmSync(work2, { recursive: true, force: true });
          }
        }
        // 解压根 squashfs-root 整体改名为 <extRoot>/cache/runtime/ZCode-<ver>
        //（destRoot = cached 向上三级：zcode.cjs→glm→resources→ZCode-<ver>）
        const destRoot = join(cached, "..", "..", "..");
        mkdirSync(join(destRoot, ".."), { recursive: true });
        rmdirIfEmpty(destRoot);
        try {
          renameSync(join(work, "squashfs-root"), destRoot);
        } catch {
          cpSync(join(work, "squashfs-root"), destRoot, { recursive: true });
        }
        log(`[aiti-zcode-agent] AppImage 解压完成（${args.length > 1 ? "pattern" : "full"}）→ ${cached}`);
        return cached;
      }
      rmSync(join(work, "squashfs-root"), { recursive: true, force: true });
    }
    throw new Error(`--appimage-extract 失败（AppImage: ${appImage}）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 官网入口页 → CDN 直链集合（cn/en 两页解析结果相同，§3.1）。
 *  路径段实测为连字符 `linux-x64`（2026-09-08 抓包）；`linux/x64` 斜杠形态为旧兼容。 */
export function extractReleaseUrls(html: string): Array<{ ver: string; url: string }> {
  const clean = html.replaceAll("\\/", "/");
  const re = /cdn-zcode\.z\.ai\/zcode\/electron\/releases\/(\d+(?:\.\d+)+)\/(?:linux-x64|linux\/x64)\/ZCode-[\d.]+-linux-x64\.AppImage/g;
  const out = new Map<string, string>();
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    out.set(m[1], `https://${m[0]}`);
  }
  return [...out].map(([ver, url]) => ({ ver, url }));
}

export function pickLatestVersion(vers: string[]): string | null {
  if (vers.length === 0) return null;
  return vers.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

/** 下载 AppImage（流式落盘；先写 .part 临时文件，完成才 rename——防中断残留半文件被当缓存）。 */
export async function downloadAppimage(url: string, destFile: string, f: FetchImpl = fetch, log = console.log, signal?: AbortSignal): Promise<void> {
  const res = await f(url, { redirect: "follow", ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}（${url}）`);
  mkdirSync(join(destFile, ".."), { recursive: true });
  const partFile = `${destFile}.part`;
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  let seen = 0;
  let lastLogged = 0;
  const src = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  src.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen - lastLogged >= 64 * 1024 * 1024) {
      lastLogged = seen;
      log(`[aiti-zcode-agent] 下载中… ${(seen / 1024 / 1024).toFixed(0)} MB`);
    }
  });
  try {
    await pipeline(src, createWriteStream(partFile));
    if (seen < 1_000_000) throw new Error(`下载内容异常（仅 ${seen} 字节，疑似错误页）`);
    renameSync(partFile, destFile);
  } catch (e) {
    rmSync(partFile, { force: true });
    throw e;
  }
}

/**
 * resolveRuntime（§8.1）：
 *   1. featurePath（zcode.cjs / 解压目录 / AppImage 任一）
 *   2. Windows 安装目录（Program Files / LOCALAPPDATA 的 ZCode 桌面端；win32 下自动）
 *   3. 自动探测：/tmp/.mount_ZCode 点号通配目录（挂载运行实例，最新鲜）→ ~/.zcode/ZCode-*.AppImage（最高版本）
 *   4. autoDownload：官网直链下载到 configDir/apps → 解压缓存
 * 全部落空 → 人话报错（fail-loud）。

结果模块级缓存：同参数（featurePath/configDir/autoDownload/mountScanDir）直接命中——
cjsPath 稳定不变；避免每轮 readdir/解压检查与重复日志。
 */
export async function resolveRuntime(opts: {
  featurePath?: string;
  configDir: string;
  autoDownload?: boolean;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  /** 挂载实例扫描目录（默认系统 tmpdir；测试注入空目录隔离真实环境）。 */
  mountScanDir?: string;
  /** Windows 安装目录扫描列表（默认 win32 下 Program Files / LOCALAPPDATA；测试注入 [] 隔离本机真实安装）。 */
  winInstallDirs?: string[];
  /** 下载阶段取消信号（abort 用）。 */
  signal?: AbortSignal;
}): Promise<ResolvedRuntime> {
  const cacheKey = JSON.stringify([
    opts.featurePath ?? "", opts.configDir, !!opts.autoDownload, opts.mountScanDir ?? "",
    opts.winInstallDirs ?? null,
  ]);
  const memo = resolveRuntimeCache.get(cacheKey);
  if (memo && existsSync(memo.cjsPath)) return memo;
  const resolved = await resolveRuntimeUncached(opts);
  resolveRuntimeCache.set(cacheKey, resolved);
  return resolved;
}

const resolveRuntimeCache = new Map<string, ResolvedRuntime>();

async function resolveRuntimeUncached(opts: {
  featurePath?: string;
  configDir: string;
  autoDownload?: boolean;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  mountScanDir?: string;
  winInstallDirs?: string[];
  signal?: AbortSignal;
}): Promise<ResolvedRuntime> {
  const log = opts.log ?? (() => {});
  const f = opts.fetchImpl ?? fetch;

  // 1) 用户指定
  const fp = opts.featurePath?.trim();
  if (fp) {
    let st: import("node:fs").Stats | null = null;
    try { st = statSync(fp); } catch { /* 落到报错 */ }
    if (st?.isFile()) {
      if (/\.(cjs|js|mjs)$/.test(fp)) return { cjsPath: fp, origin: "feature" };
      const ver = parseAppImageVersion(fp) ?? "unknown";
      const cjs = await extractAppimage(fp, opts.configDir, ver, log);
      return { cjsPath: cjs, appVersion: ver === "unknown" ? undefined : ver, origin: "feature" };
    }
    if (st?.isDirectory()) {
      const cjs = findCjsUnderDir(fp);
      if (cjs) return { cjsPath: cjs, origin: "feature" };
    }
    throw new Error(`zcode.runtimePath 指定的路径不可用：${fp}（需为 zcode.cjs 文件、含 resources/glm/zcode.cjs 的目录、或 ZCode AppImage）`);
  }

  // 2) Windows 安装探测（Program Files / LOCALAPPDATA 的 ZCode 桌面端；命中直接用安装目录 CLI，
  //    免解压免下载；版本尽力从 resources/app.asar 解析 → ZCODE_APP_VERSION 对齐 UA）。
  const winDirs = opts.winInstallDirs ?? (process.platform === "win32" ? windowsInstallDirs() : []);
  if (winDirs.length > 0) {
    const hits: Array<{ dir: string; cjs: string; ver: string | null }> = [];
    for (const dir of winDirs) {
      const cjs = findCjsUnderDir(dir);
      if (cjs) hits.push({ dir, cjs, ver: detectWindowsInstallVersion(dir) });
    }
    hits.sort((a, b) => {
      if (a.ver && b.ver) return compareVersions(b.ver, a.ver);
      if (a.ver) return -1;
      if (b.ver) return 1;
      return 0;
    });
    const best = hits[0];
    if (best) {
      log(`[aiti-zcode-agent] 使用 Windows 安装 runtime${best.ver ? ` ZCode ${best.ver}` : ""}（${best.dir}）`);
      return { cjsPath: best.cjs, ...(best.ver ? { appVersion: best.ver } : {}), origin: "install" };
    }
  }

  // 3a) 挂载运行实例（桌面端正跑着；版本未知 → 不传 ZCODE_APP_VERSION）
  try {
    for (const name of readdirSync(opts.mountScanDir ?? tmpdir())) {
      if (!name.startsWith(".mount_ZCode")) continue;
      const cjs = findCjsUnderDir(join(opts.mountScanDir ?? tmpdir(), name));
      if (cjs) {
        log(`[aiti-zcode-agent] 使用挂载实例 runtime: ${cjs}`);
        return { cjsPath: cjs, origin: "mount" };
      }
    }
  } catch { /* /tmp 不可读等 */ }

  // 3b) 解压缓存优先（<extRoot>/cache/runtime/ZCode-*/…/zcode.cjs）：AppImage 源被删/升级后缓存仍可用
  const runtimeDir = join(dirname(opts.configDir), "cache", "runtime");
  const cachedVers: Array<{ ver: string; cjs: string }> = [];
  try {
    for (const name of readdirSync(runtimeDir)) {
      const m = name.match(/^ZCode-(\d+(?:\.\d+)+)$/);
      if (!m) continue;
      const cjs = findCjsUnderDir(join(runtimeDir, name));
      if (cjs) cachedVers.push({ ver: m[1], cjs });
    }
  } catch { /* 无 runtime 目录 */ }
  const bestCached = cachedVers.sort((a, b) => compareVersions(b.ver, a.ver))[0];
  if (bestCached) {
    log(`[aiti-zcode-agent] 使用解压缓存 ZCode ${bestCached.ver}: ${bestCached.cjs}`);
    return { cjsPath: bestCached.cjs, appVersion: bestCached.ver, origin: "appimage" };
  }

  // 3c) ~/.zcode/ZCode-*.AppImage（最高版本）→ 解压进缓存
  const appImages: string[] = [];
  try {
    for (const name of readdirSync(zcodeHome())) {
      if (/^ZCode-.*linux.*\.AppImage$/.test(name)) appImages.push(join(zcodeHome(), name));
    }
  } catch { /* 无 ~/.zcode */ }
  const best = appImages
    .map((p) => ({ p, ver: parseAppImageVersion(p) }))
    .filter((x): x is { p: string; ver: string } => !!x.ver)
    .sort((a, b) => compareVersions(b.ver, a.ver))[0];
  if (best) {
    const cjs = await extractAppimage(best.p, opts.configDir, best.ver, log);
    log(`[aiti-zcode-agent] 使用本机 AppImage ${best.ver}: ${cjs}`);
    return { cjsPath: cjs, appVersion: best.ver, origin: "appimage" };
  }

  // 4) 自动下载
  if (opts.autoDownload) {
    const page = await pickDownloadPage(f, opts.signal);
    const releases = extractReleaseUrls(page);
    const ver = pickLatestVersion(releases.map((r) => r.ver));
    const hit = releases.find((r) => r.ver === ver);
    if (hit) {
      log(`[aiti-zcode-agent] 自动下载 ZCode ${ver} …`);
      const dest = join(dirname(opts.configDir), "cache", "apps", `ZCode-${ver}-linux-x64.AppImage`);
      if (!existsSync(dest)) await downloadAppimage(hit.url, dest, f, log, opts.signal);
      const cjs = await extractAppimage(dest, opts.configDir, ver, log);
      return { cjsPath: cjs, appVersion: ver, origin: "download" };
    }
    throw new Error("官网下载页未解析到 linux-x64 AppImage 直链（页面结构可能变化）");
  }

  throw new Error(
    "未找到 ZCode runtime。解决（任选其一）：\n"
    + "1. 扩展管理器 → aiti-zcode-agent → 功能管理 → zcode.runtimePath 填 ZCode AppImage 或 zcode.cjs 路径；\n"
    + "2. 安装 ZCode 桌面端（https://zcode.z.ai；Windows 安装后扩展自动从安装目录复用 CLI）；\n"
    + "3. 打开功能管理里的 zcode.autoDownload 让扩展自动下载（约 300MB）。",
  );
}

async function pickDownloadPage(f: FetchImpl, signal?: AbortSignal): Promise<string> {
  for (const u of ["https://zcode.z.ai/cn", "https://zcode.z.ai/en"]) {
    try {
      const res = await f(u, { redirect: "follow", ...(signal ? { signal } : {}) });
      if (res.ok) return await res.text();
    } catch { /* next */ }
  }
  throw new Error("官网入口页抓取失败（zcode.z.ai 不可达）");
}

/**
 * node 可执行文件：pi-web 服务进程本身就是 node 跑的 → process.execPath 最稳
 * （免 systemd PATH 缺 nvm 的坑）；ZCODE_NODE_PATH 可覆盖。
 */
export function resolveNodeBin(): string {
  return process.env.ZCODE_NODE_PATH || process.execPath;
}

/** 组装 CLI argv（不含 runtime 路径本身；execZcodeTurn 负责拼接）。 */
export function buildCliArgs(opts: {
  mode?: string;
  sessId?: string;
  prompt: string;
  attachPaths?: string[];
}): string[] {
  const mode = (ZCODE_MODES as readonly string[]).includes(opts.mode ?? "") ? opts.mode as typeof ZCODE_MODES[number] : "build";
  return [
    "--json",
    "--mode", mode,
    ...(opts.sessId ? ["--resume", opts.sessId] : []),
    ...(opts.attachPaths ?? []).flatMap((p) => ["--attach", p]),
    "--prompt", opts.prompt,
  ];
}

/**
 * 3.17+ CLI provider runtime 闸 spawn env（桌面端同款注入，2026-11-07）：
 * CLI 启动 tui/app-server/agent-server/login/logout/裸跑时需要 builtin provider config，
 * 缺省按入口相对扫描（<cliDir>/provider/ 与 <cliDir>/../../../../../config/provider/——npm 安装
 * 布局假设）；AppImage 挂载/解压布局（resources/glm/zcode.cjs）两处皆不存在 →
 * 「无法定位 CLI ZCode Built-in Provider Config」启动即崩（桌面端靠 env 直供跳过扫描，
 * 挂载实例 env 实测：BUILTIN=~/.zcode/v2/runtime/…/endpoint-<hash>/zcode-builtin.json、
 * PERSONAL=~/.zcode/v2/provider_config.json）。对齐注入：
 *   ZCODE_BUILTIN_PROVIDER_CONFIG_FILE  = runtime 同包 <resources>/config/provider/zcode-builtin.json
 *     （与所 spawn 的 CLI 版本精确对齐；缺失回退桌面刷新副本 v2/runtime/<plat>-<arch>/<ver>/endpoint-<hash>/）
 *   ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = <zcodeHome>/v2/provider_config.json
 * 已在 passthrough 里的键不覆盖（spawn.env / launchOverride.memberEnv 显式值优先）。
 */
export function providerRuntimeEnv(
  runtimeCjsPath: string | undefined,
  passthrough: Record<string, string | undefined> = {},
  appVersion?: string,
): Record<string, string> {
  const BUILTIN = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
  const PERSONAL = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
  const out: Record<string, string> = {};
  if (runtimeCjsPath && !(BUILTIN in passthrough)) {
    const bundled = join(dirname(runtimeCjsPath), "..", "config", "provider", "zcode-builtin.json");
    if (existsSync(bundled)) out[BUILTIN] = bundled;
    else {
      const refreshed = refreshedProviderConfig(zcodeHome(), appVersion);
      if (refreshed) out[BUILTIN] = refreshed;
    }
  }
  if (!(PERSONAL in passthrough)) {
    const personal = join(zcodeHome(), "v2", "provider_config.json");
    if (existsSync(personal)) out[PERSONAL] = personal;
  }
  return out;
}

/** 桌面端 v2 runtime 刷新副本：runtime/provider/<plat>-<arch>/<ver>/endpoint-<hash>/zcode-builtin.json（ver 缺省取最高）。
 *  目录名 = CLI fnt() 同式：linux-x86_64 / windows-x86_64 / darwin-aarch64…（平台与 arch 合成段）。 */
function refreshedProviderConfig(zcodeHomeDir: string, appVersion?: string): string | null {
  const plat = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
  const platDir = join(zcodeHomeDir, "v2", "runtime", "provider", plat);
  let vers: string[];
  try {
    vers = readdirSync(platDir);
  } catch {
    return null;
  }
  const pick = appVersion && vers.includes(appVersion)
    ? appVersion
    : vers.filter((v) => /^\d+(?:\.\d+)+$/.test(v)).sort(compareVersions).at(-1);
  if (!pick) return null;
  try {
    const ep = readdirSync(join(platDir, pick)).find((d) => d.startsWith("endpoint-"));
    if (!ep) return null;
    const f = join(platDir, pick, ep, "zcode-builtin.json");
    return existsSync(f) ? f : null;
  } catch {
    return null;
  }
}

/** 组装治理后的 spawn env（§8.3；UA/指纹工具定义全由官方 CLI 自身构造）。 */
export function buildTurnEnv(opts: {
  modelRef: string;
  providerId: string;
  apiKey: string;
  appVersion?: string;
  passthroughEnv: Record<string, string | undefined>;
  /** 覆盖 ZCODE_BASE_URL（app-server 通道传平台根，缺省=provider baseURL 直连）。 */
  baseURL?: string;
  /** runtime zcode.cjs 绝对路径：注入 3.17+ provider runtime 闸 env（providerRuntimeEnv）。 */
  runtimeCjsPath?: string;
}): Record<string, string> {
  return {
    ...opts.passthroughEnv,
    ...providerRuntimeEnv(opts.runtimeCjsPath, opts.passthroughEnv, opts.appVersion),
    ZCODE_MODEL: opts.modelRef,
    // 动态通道（*-coding-plan/*-start-plan）走注册表端点；静态表只覆盖 bigmodel/zai。
    ZCODE_BASE_URL: opts.baseURL ?? baseUrlFor(opts.providerId) ?? PROVIDER_BASE_URL.bigmodel,
    ZCODE_API_KEY: opts.apiKey,
    ZCODE_ENV: "production",
    ...(opts.appVersion ? { ZCODE_APP_VERSION: opts.appVersion } : {}),
  };
}

// ============================================================================
// 受控登录 driver（外部 Agent 受控登录标准，共享层 pi-web-ext/_shared/controlled-login.mjs）
// 模式 A url-only：spawn 官方 `login --no-browser --json`，凭据/换 key 全由官方完成，
// 与 ensureCredential 指纹链路天然闭环（docs/zcode-controlled-login-analysis.md §6）。
// ============================================================================

/** login URL 抓取（官方打印格式，runtime 0.16.5 实测：stderr `Open this URL to sign in:\n<url>`）。 */
export function extractZcodeLoginUrl(text: string): string | null {
  const m = /Open this URL to sign in:\s*(https?:\/\/\S+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * 结果判定（实测输出形态）：
 *   exit 0 + stdout 单 pretty JSON `"status":"ready"`（user{name?,email?}）→ success；
 *   exit 1 + stderr `Error: Authorization timed out. Please retry login.` → timeout；
 *   其余 → failed（Error 行人话透出）。
 */
export function interpretZcodeLogin(code: number | null, stdout: string, stderr: string): { state: "success" | "failed" | "timeout"; user?: string; error?: string } {
  if (code === 0) {
    let user: string | undefined;
    try {
      const j = JSON.parse(stdout) as { status?: unknown; user?: { name?: unknown; email?: unknown } };
      if (j?.status !== undefined && j.status !== "ready") {
        return { state: "failed", error: `zcode login 退出码 0 但 status=${String(j.status)}` };
      }
      const name = typeof j?.user?.name === "string" ? j.user.name : "";
      const email = typeof j?.user?.email === "string" ? j.user.email : "";
      if (name || email) user = name || email;
    } catch { /* 非 JSON（理论不可达）：凭据已由官方落盘，按成功无 user 处理 */ }
    return { state: "success", ...(user ? { user } : {}) };
  }
  const detail = extractCliError(stderr, tailLine(stderr) || tailLine(stdout) || `zcode login 异常退出（code=${code ?? "signal"}）`);
  if (/timed out/i.test(stderr) || /timed out/i.test(stdout)) {
    return { state: "timeout", error: detail };
  }
  return { state: "failed", error: detail };
}

/** zcode 家驱动（loginTimeoutMs 330s：CLI 内部 300s 硬超时，外层放宽一档兜底 kill）。 */
export const zcodeLoginDriver = {
  agentId: "zcode",
  mode: "url" as const,
  loginTimeoutMs: 330_000,
  buildLogin: ({ runtime }: { runtime: string; consoleMode?: boolean }) => ({
    cmd: resolveNodeBin(),
    args: [runtime, "login", "--no-browser", "--json"],
    // login 也在 provider runtime 闸门内（3.17+ 裸跑即崩）→ 同款 env 注入
    env: { ...cleanEnv(), ...providerRuntimeEnv(runtime) },
  }),
  extractUrl: extractZcodeLoginUrl,
  interpret: interpretZcodeLogin,
};
