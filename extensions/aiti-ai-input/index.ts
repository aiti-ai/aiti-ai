/**
 * AI input 扩展（pi-web）—— id: aiti-ai-input
 *
 * 定位：AI 聊天输入框的输入增强扩展（长期保留，非临时测试）。
 * 第一个能力 = 语音来源标记（最小切片，见 docs/aiti-voice-input-plan.md §9）：
 *   1. 检测【系统输入法语音输入】（Gboard 听写 / iOS 听写 / 桌面系统听写）——
 *      beforeinput 特征启发式（整段替换 / 大范围删除 / 整句上屏 / 密集节奏）；
 *   2. 检测到 → chatInputTop 显示「🎤 疑似语音输入」标记条，用户可 ✕ 删除；
 *   3. 不删除 → 发送时 preSend 在消息末尾附加 [语音输入：…] 标记
 *      （与 [发自:] 并列、各自幂等清理，互不干扰）。
 *
 * 第二个能力 = AI 行内自动补全（docs/aiti-input-autocomplete-plan.md）：
 *   - 输入静止 700ms 且光标在末尾 → 灰字显示下一句（服务端独立轻量模型小请求，
 *     POST /api/chat/complete-input；不碰会话上下文、不落盘）；Tab/→ 接受一句，
 *     Esc 取消，接受后续下一句（逐句流）。
 *   - 治理走 extman 功能管理（features，docs/aiti-devtools-ext-features.md）：
 *     autocomplete.enabled 总开关 · autocomplete.localOnly 仅本地 · ctx 三档互斥上下文预算。
 *   - client 启动时 GET /features 拉取当前档位（server.api）。
 *
 *   L0 本地层（零模型秒出，M2）：输入静止后**先查本地**（收藏 prompt + 会话历史输入，
 *   前缀匹配）——命中即灰字直出 + ↦收藏/↦历史 角标，**不请求 AI**；仅当 L0 未命中才走
 *   L1 AI 补全。localOnly = 只跑 L0（0 出网）。
 *
 * 第三个能力 = 收藏联想 suggest（docs/aiti-ai-helper-plan.md §3.5，静态优先）：
 *   - 敲前缀弹补全小窗（命令⚡ + prompt📌），静态 provider 优先；无静态命中 → aiFallback（AI 动态建议）
 *   - 后端扩展点：其它扩展 POST /providers 注册自己的 suggest 端点（仿 aiti-msg-smart registerRecognizer）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
// ASR 引擎可插拔（builtin 8767 / 云 API）：docs/aiti-ai-input-asr-provider-plan.md
import {
  asrProviderCfg, asrProviderId, asrProviderReady, asrProviderSpec, asrProviderView, asrMergeProviderCfg, encodeMultipart,
} from "./asr-providers.ts";
import { ensureXfBridge, xfBridgePort } from "./xfyun-bridge.ts";
import { readSeries, readUsage, recordUsage, resetUsage, setUsageDir, setUsagePrice } from "./asr-usage.ts";

let configDir = "";
let stateDir = "";

// ---- ASR 热词（session-manager services.hotwords 出口 → 8767 /hotwords 模型级偏置） ----
// 懒拉取 + 10min TTL + 单飞，**全部 workspace 粒度**（多 workspace 并行不冲突；8767 侧只存哈希 key，不见路径）。
const HOTWORDS_TTL_MS = 10 * 60 * 1000;
const asrHotwordsCache = new Map<string, { list: string[]; at: number }>();       // wsKey → 拉取缓存
const asrHotwordsInflight = new Map<string, Promise<string[]>>();                // wsKey → 单飞
const asrHotwordsPushedAt = new Map<string, number>();                           // wsKey → 防抖

// ---- 用户热词库（弹窗编辑/导入/导出；与自动收取词合并，用户词优先） ----
const USER_HOTWORDS_MAX = 500;
function userHotwordsFile(): string {
  return join(configDir || ".", "user-hotwords.json");
}
function readUserHotwords(): string[] {
  try {
    const raw = JSON.parse(readFileSync(userHotwordsFile(), "utf8"));
    if (Array.isArray(raw)) {
      const seen = new Set<string>();
      return raw.map(String).map((w) => w.trim()).filter((w) => {
        if (!w) return false;
        const k = w.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, USER_HOTWORDS_MAX);
    }
  } catch { /* 不存在/损坏 → 空 */ }
  return [];
}
function saveUserHotwords(words: string[]): string[] {
  const seen = new Set<string>();
  const out = words.map(String).map((w) => w.trim()).filter((w) => {
    if (!w) return false;
    const k = w.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, USER_HOTWORDS_MAX);
  try {
    writeFileSync(userHotwordsFile(), JSON.stringify(out, null, 2), "utf8");
  } catch (e) { /* 写失败不影响主链路 */ }
  asrHotwordsCache.clear(); // 用户词变化 → 拉取缓存失效（合并源变了，下次 push 自动带新用户词）
  return out;
}
/** workspace 标识 = 关注路径/根的哈希（12 位 hex）——不传完整路径（日志/8767 均无路径） */
function asrWsKey(cwd?: string, paths?: string[]): string {
  const raw = (paths && paths.length ? paths.join("\n") : (cwd || "")).trim() || "__default__";
  return createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

// DI 方案 P1：feature 读收口（ctx.features 优先，__piWebExt 直调兜底——生产旧 core 过渡期）
let hostFeatures: any = null; // startup 捕获 ctx.features
let hostSvc: any = null; // startup 捕获 ctx.services（session-manager.hotwords 消费用）
function featureGet(fid: string, fallback: boolean | string): boolean | string {
  const v = hostFeatures?.get?.("aiti-ai-input", fid);
  if (v !== undefined) return v;
  const reg = (globalThis as Record<string, unknown>).__piWebExt as { featureValue?: (e: string, f: string) => boolean | string } | undefined;
  return reg?.featureValue ? reg.featureValue("aiti-ai-input", fid) : fallback;
}

/** 拉取热词：session-manager 服务出口（缺席 → 空列表降级，绝不影响主链路）
 *  数量与提取范围（用户/AI 输入）由 features 控制：asr.hotwords.count（默认 100，中英各 N）、
 *  asr.hotwords.includeUser / asr.hotwords.includeAi（默认全包含）。 */
async function asrFetchHotwords(cwd?: string): Promise<{ ws: string; list: string[] }> {
  try {
    const reg = (globalThis as Record<string, unknown>).__piWebExt as {
      byId?: (id: string) => { ext?: { services?: Record<string, { get?: (p: Record<string, unknown>) => Promise<unknown> | unknown }> } } | null;
      featureValue?: (extId: string, fid: string) => boolean | string;
      featureEnabled?: (extId: string, fid: string) => boolean;
    } | undefined;
    // feature 读取（extman 面板可调；缺省：100 / 全包含；0 = 关闭热词）——DI P1：ctx.features 优先
    const fv = String(featureGet("asr.hotwords.count", ""));
    const countParsed = parseInt(String(fv), 10);
    const count = Number.isFinite(countParsed) && countParsed >= 0 ? Math.min(countParsed, 500) : 100;
    const includeUser = featureGet("asr.hotwords.includeUser", true) !== false;
    const includeAi = featureGet("asr.hotwords.includeAi", true) !== false;
    if (count <= 0) return { ws: asrWsKey(cwd), list: [] }; // 0 = 关闭热词
    // 双轨（DI 方案 P1）：ctx.services 优先（session-manager.hotwords），byId 穿透兜底
    const svc = hostSvc?.get?.("session-manager.hotwords")
      ?? reg?.byId?.("session-manager")?.ext?.services?.hotwords;
    const norm = (d: unknown): string[] => {
      const r = d as { cn?: unknown[]; en?: unknown[] } | undefined;
      const cn = Array.isArray(r?.cn) ? (r.cn as unknown[]).map(String).filter((s) => s && s.length >= 1) : [];
      const en = Array.isArray(r?.en) ? (r.en as unknown[]).map(String).filter((s) => s && s.length >= 2) : [];
      return [...cn, ...en];
    };
    // 热词质量过滤（双保险：session-manager 提取已过滤，此处兜底用户热词/旧缓存等任意来源）
    // 白名单：纯中文 2-8 字 / 英文/数字/连字符/点/下划线 **2**-51 字符（2 字符 = IT 术语如 pi/ai/ui/db/js，勿过滤）；
    // 剔除 <s> 类 token、纯符号残留。
    const HOTWORD_OK = (w: string): boolean => {
      if (!w || w.length > 51) return false;
      if (/^[\u4e00-\u9fff]{2,8}$/.test(w)) return true;
      if (/^[a-z0-9][a-z0-9_.-]{1,50}$/i.test(w)) return true;   // 2 字符起（首字符 + ≥1 后续）
      return false;
    };
    // 关注路径（多路径）：git-trace services.trace.watchPaths(cwd) 展开；无 git-trace/未配置 → 降级单 cwd；均无 → 仅全局
    let paths: string[] = [];
    try {
      const traceSvc = (reg as any)?.byId?.("aiti-git-trace")?.ext?.services?.trace;
      if (cwd && traceSvc && typeof traceSvc.watchPaths === "function") {
        paths = (traceSvc.watchPaths(cwd) as Array<{ path?: string }> || [])
          .map((p: { path?: string }) => p.path).filter((p: unknown): p is string => typeof p === "string" && !!p);
      }
    } catch { /* git-trace 缺席/异常 → 降级 */ }
    // 防丢：watchPaths 为空/未配置/异常时，仍把当前 cwd 追加合并进 paths（当前 workspace 一定相关）
    if (cwd) {
      const norm0 = (x: string) => x.replace(/\/+$/, "");
      if (!paths.some((x) => norm0(x) === norm0(cwd))) paths.push(cwd);
    }
    // 4 档各 count（设置数量=每档数量）：workspace(关注路径) 中/英 + 全局中/英，最多 4×count（count=100 → 400）
    const wsArgs = paths.length ? { paths } : {};
    // svc.get 无内部超时——外包 10s race（hang 场景降级空表，inflight 正常清理）
    const svcGet = async (p: Record<string, unknown>): Promise<unknown> => {
      return Promise.race([
        Promise.resolve(svc.get(p)),
        new Promise((_, rej) => setTimeout(() => rej(new Error("hotwords 提取超时")), 10000)),
      ]);
    };
    // 用户词先取先并（无条件放行，不加 HOTWORD_OK 质量过滤——曾踩坑：用户词 pi（2 字符英文）被白名单丢）。
    // ⚠ 必须在 svc 调用之前：session-manager 超时/缺席不能连坐用户词（2026-09-11 曾因 svc
    //   10s 提取超时整体抛异常走 catch 返回空表 → 重启后热词全灭）。
    const userWordsRaw = readUserHotwords();
    const userWords = new Set<string>();
    for (const w of userWordsRaw) { const k = w.toLowerCase(); if (!userWords.has(k)) { userWords.add(k); } }
    const merged: string[] = [];
    const seen = new Set<string>();
    const pushWord = (w: string, isUser: boolean) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return;
      if (!isUser && !HOTWORD_OK(w)) return;               // 仅自动词过滤；用户词放行
      seen.add(k);
      merged.push(w);
    };
    for (const w of userWordsRaw) pushWord(w, true);
    // 自动词分两段拉取（workspace → 全局）：单段失败（如提取超时）只丢该段，另一段+用户词仍推送
    const pullAuto = async (extra: Record<string, unknown>): Promise<string[]> => {
      try {
        return norm(await svcGet({ cnCount: count, enCount: count, timeWeight: "24h", includeUser, includeAi, ...extra }));
      } catch (e) {
        try { console.warn("[aiti-ai-input] 热词自动段拉取失败（跳过该段，用户词仍推送）", e); } catch {}
        return [];
      }
    };
    for (const w of paths.length ? await pullAuto(wsArgs) : []) pushWord(w, false);
    for (const w of await pullAuto({})) pushWord(w, false);
    return { ws: asrWsKey(cwd), list: merged };
  } catch (e) {
    try { console.warn("[aiti-ai-input] 热词拉取失败（降级空列表）", e); } catch {}
    return { ws: asrWsKey(cwd), list: [] };
  }
}

/** 取热词（per-workspace TTL 缓存 + 单飞；过期才重新拉取） */
async function asrGetHotwords(cwd?: string): Promise<{ ws: string; list: string[] }> {
  const now = Date.now();
  const wsKey = asrWsKey(cwd);
  const cached = asrHotwordsCache.get(wsKey);
  if (cached && now - cached.at < HOTWORDS_TTL_MS) return { ws: wsKey, list: cached.list };
  let inflight = asrHotwordsInflight.get(wsKey);
  if (!inflight) {
    inflight = asrFetchHotwords(cwd).then((r) => {
      if (asrHotwordsCache.size > 40) asrHotwordsCache.clear(); // 防御：多 ws 长跑不限涨（词表重拉成本低）
      asrHotwordsCache.set(r.ws, { list: r.list, at: Date.now() });
      asrHotwordsInflight.delete(r.ws);
      return r;
    }).catch((e) => {
      asrHotwordsInflight.delete(wsKey);
      throw e;
    });
    asrHotwordsInflight.set(wsKey, inflight);
  }
  return inflight;
}

/** 推送热词到 ASR 服务（per-workspace：ws=哈希 key，8767 侧按 ws 存多套热词互不冲突） */
async function asrPushHotwords(cwd?: string): Promise<void> {
  try {
    // 热词是 builtin 的模型级偏置；云引擎不消费（voice.fix 修复层与引擎无关，照常工作）
    if (asrProviderId(asrReadModelConfig()) !== "builtin") return;
    const { ws, list } = await asrGetHotwords(cwd);
    if (!list.length) return;
    const now = Date.now();
    // 防抖：该 ws 参数未变 TTL 内不重复推；但 8767 重启/清空后（remote=0）无视防抖立即补推
    let remoteZero = false;
    try {
      const ctrl0 = new AbortController();
      const t0 = setTimeout(() => ctrl0.abort(), 1500);
      const h = await fetch(`${ASR_STREAM_BASE}/health`, { signal: ctrl0.signal });
      clearTimeout(t0);
      if (h.ok) { const hj = await h.json().catch(() => null); remoteZero = Number((hj as { hotwords?: unknown } | null)?.hotwords ?? -1) === 0; }
    } catch { /* 8767 不通：走下面 fetch 失败路径 */ }
    const pushedAt = asrHotwordsPushedAt.get(ws) || 0;
    if (!remoteZero && now - pushedAt < HOTWORDS_TTL_MS) return;
    if (asrHotwordsPushedAt.size > 80) asrHotwordsPushedAt.clear(); // 防抖 map 防涨
    asrHotwordsPushedAt.set(ws, now);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`${ASR_STREAM_BASE}/hotwords`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ws, hotwords: list }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
  } catch (e) {
    try { console.warn("[aiti-ai-input] 热词推送失败（服务端可能未启用热词）", e); } catch {}
  }
}

// ASR 启动状态机（进程内；dev/prod 各自独立）
interface AsrLaunchState { status: "idle" | "starting" | "failed"; at: number; sessionId?: string; error?: string; }
let asrLaunch: AsrLaunchState = { status: "idle", at: 0 };
// ---- ASR 稳定器（被动自处理，无定时器）----
// 逻辑挂在 asrEnsure（用户每次语音/任意 /asr/info 请求触发）：
//   ① health 不通 → 既有机制自动拉起（asrLaunchViaCmd）
//   ② health 通但 offline 模型未加载齐且服务运行超 5min → 视为 GPU 崩/卡死 → 自动 restart
// 无需轮询——服务不常用来，用到时自愈即可。
let asrLaunchInFlight = false; // 互斥：ensure/control 并发时只允许一个正在发起拉起（防双 PTY 会话端口冲突）

/** 探测 8767 健康（2s 超时） */
async function asrProbe(): Promise<{ up: boolean; data?: Record<string, unknown> }> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${ASR_STREAM_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return { up: false };
    return { up: true, data: (await res.json().catch(() => null)) || {} };
  } catch {
    return { up: false };
  }
}

/** cache 区路径（<extRoot>/cache/<rel>；venv/录音等可再生大文件）。
 *  数据分层：configDir = <extRoot>/config → cache 在 dirname(configDir) 下；
 *  兜底禁用 "."（CWD 相对路径会把垃圾写进进程工作目录——pi-prod 根实证），未初始化时落数据根约定路径。 */
function cachePath(rel: string) {
  return join(dirname(configDir || asrDataDirFallback()), "cache", rel);
}

/** ASR 配置文件路径（扩展 configDir 下，随用户数据走；不写程序目录） */
function asrConfigPath(): string {
  // configDir 可能为 ""（未 init）；兜底禁用 "."（CWD 污染），落数据根约定路径
  return join(configDir || asrDataDirFallback(), "asr-config.json");
}

function asrDataDirFallback(): string {
  // 三目录对称（2026-09-13）：扩展配置区 = <dataRoot>/<extId>/config
  return process.env.PI_WEB_DATA_DIR
    ? join(process.env.PI_WEB_DATA_DIR, "aiti-ai-input", "config")
    : join(homedir(), ".pi", "web", "data", "aiti-ai-input", "config");
}

/** 读 ASR 配置文件（configDir/asr-config.json）——不存在/损坏返回 {}。 */
function asrReadModelConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(asrConfigPath(), "utf8") || "{}") || {};
  } catch { return {}; }
}

/** 写 ASR 配置文件（configDir/asr-config.json）——模型/限额持久化，服务启动读取，不用环境变量。
 *  保留已有全部字段（max_seconds/model_hotwords_max/env 等），只覆盖已知模型键。 */
function asrWriteModelConfig(): void {
  try {
    const m = asrModelChoice();
    const cfgPath = asrConfigPath();
    try { mkdirSync(configDir, { recursive: true }); } catch {}
    const prev = asrReadModelConfig();
    const cfg: Record<string, unknown> = {
      // 已有字段（含 max_seconds/model_hotwords_max/env/自定义键）全部保留
      ...prev,
      // 服务端 WS 流式模型固定 paraformer（chunk 流式）；SenseVoice 是前端伪实时引擎（/voice/quick），不进服务端配置
      stream_model: "paraformer-zh-streaming",
      offline_model: m.offline,
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) { try { console.warn("[aiti-ai-input] 写 ASR 配置失败", e); } catch {} }
}

/** 读模型 feature（流式 / 2-pass）：流式返回前端引擎选择（SenseVoice=伪实时 / paraformer=WS），
 *  2-pass 返回精修模型；feature 优先，其次读当前配置文件，再默认。 */
function asrModelChoice(): { stream: string; offline: string } {
  let s = "", o = "";
  try {
    // DI 方案 P1：ctx.features 收口（featureGet 内含旧通道兜底）
    s = String(featureGet("asr.model.stream", "") || "");
    o = String(featureGet("asr.model.offline", "") || "");
  } catch {}
  // feature 未设 → 读配置文件实际值
  if (!s || !o) {
    try {
      const cfg: Record<string, unknown> = JSON.parse(readFileSync(asrConfigPath(), "utf8") || "{}");
      if (!s) s = String(cfg.stream_model || "");
      if (!o) o = String(cfg.offline_model || "");
    } catch {}
  }
  // 默认：流式引擎 SenseVoice（伪实时）；2-pass Qwen3
  return { stream: s || "iic/SenseVoiceSmall", offline: o || "Qwen/Qwen3-ASR-0.6B" };
}

/** 生成静音 WAV（16k/16bit/单声道）——/asr/test 用：不必说话即可验证引擎连通与耗时。 */
function silenceWav(ms: number): Uint8Array {
  const rate = 16000;
  const bytes = Math.floor(rate * ms / 1000) * 2;
  const buf = new Uint8Array(44 + bytes);
  const dv = new DataView(buf.buffer);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + bytes, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, bytes, true);
  return buf;   // 数据区全 0 = 静音
}

/** 按请求体大小估算音频时长（16k/16bit 单声道 wav ≈ 32KB/s；非 wav 为估算值，仅用于用量统计） */
function estAudioSeconds(bytes: number): number {
  return Math.round(Math.max(0, (bytes - 300) / 32000) * 10) / 10;
}

/** env 对象校验：键名必须符合 [A-Za-z_][A-Za-z0-9_]*，值非空字符串（空值=删除该项）。 */
function asrSanitizeEnv(input: unknown): Record<string, string> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return null;   // 非法键名 → 整体拒绝
    if (v === null || v === undefined) continue;             // 空值跳过（相当于删）
    const sv = String(v);
    if (sv === "") continue;
    out[k] = sv;
  }
  return out;
}

/** 重启 8767（模型切换/用户触发）：先写配置再 stop（精确端口）拉起（同自愈机制）。 */
async function asrControlRestart(): Promise<void> {
  try {
    asrWriteModelConfig();
    await _asrStopByPort();
    // 给端口释放一点时间（避免立即拉起抢端口）
    await new Promise((r) => setTimeout(r, 800));
    await asrLaunchViaCmd(null as unknown as Request);
    // 重启后等 8767 就绪（模型加载可能 10-50s），补推缓存 ws 的热词（服务重启清空了热词表）
    void asrWaitUpAndPushHotwords();
  } catch { /* 忽略：下次 ensure/语音自动自愈 */ }
}

/** 等 8767 health ok（有限次探测），就绪后清防抖——下次 ensure/语音 会带 cwd 强制补推热词。
 *  注：不在这里主动拉词（扩展无当前 cwd；缓存可能未建），真正的补推在 /asr/ensure（带 cwd）自动完成。 */
async function asrWaitUpAndPushHotwords(): Promise<void> {
  let up = false;
  for (let i = 0; i < 30; i++) { // 最多 ~60s（模型加载）
    const probe = await asrProbe();
    if (probe.up) { up = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!up) return;
  asrHotwordsPushedAt.clear(); // 清防抖：服务重启清了 hotwords，下次 push 强制重推
}

/** 按端口精确停止 8767（start-stream.sh stop 语义；reload 后孤儿进程兜底）。 */
async function _asrStopByPort(): Promise<void> {
  try {
    const { execFile } = await import("node:child_process");
    const script = process.platform === "win32" ? `${ASR_SERVER_DIR}/start-stream.ps1` : `${ASR_SERVER_DIR}/start-stream.sh`;
    const cmd = process.platform === "win32" ? "powershell" : "bash";
    await new Promise<void>((resolve) => {
      execFile(cmd, [script, "stop"], { cwd: ASR_SERVER_DIR }, () => resolve());
    });
  } catch { /* 忽略 */ }
}

/** 经 aiti-cmd 拉起（PTY 会话：日志面板可见，与 pi-web 同进退）
 *  走 ctx.services.get("aiti-cmd.runner")（aiti-cmd-exec-integration-plan.md §3.2：跨扩展后端建会话
 *  统一出口，进程内直调、零 HTTP 自环；旧实现经 __piWebExt.api 模拟 HTTP 自环已删）。
 *  source="asr-selfheal"（§3.1 基线白名单内，审计可归因）。 */
async function asrLaunchViaCmd(_req: Request): Promise<{ ok: boolean; sessionId?: string; queued?: boolean; position?: number; error?: string }> {
  try {
    const svc = hostSvc?.get?.("aiti-cmd.runner") as
      | { run?: (opts: Record<string, unknown>) => Promise<{ ok?: boolean; sessionId?: string; queued?: boolean; position?: number; error?: string }> | { ok?: boolean; sessionId?: string; queued?: boolean; position?: number; error?: string } }
      | undefined;
    if (!svc?.run) return { ok: false, error: "aiti-cmd.runner 服务不可用（aiti-cmd 未加载或旧版）" };
    // 模型/限额从 configDir/asr-config.json 读取（voice-asr-stream.py 启动时按 ASR_CONFIG_PATH 解析），
    // 不在命令行/环境变量暴露模型，避免进程列表泄漏。
    const r = await svc.run({
      // venv/录音目录走 env 覆盖指到 cache/（数据分层：可再生大文件不进配置区；asr-config.json 仍在 configDir 根）
      command: `ASR_CONFIG_PATH=${asrConfigPath()} AITI_ASR_VENV_DIR=${cachePath("asr-venv")} AITI_ASR_GLM_VENV=${cachePath("glm-venv")} AITI_ASR_RECORDINGS_DIR=${cachePath("recordings")} ${ASR_CTL_CMD} ${ASR_SERVER_DIR}/${ASR_CTL_SCRIPT}`,
      cwd: ASR_SERVER_DIR,
      name: "ASR 流式服务（8767）",
      source: "asr-selfheal",
      ttlMs: 24 * 3600 * 1000,
    });
    if (!r || !r.ok) return { ok: false, error: r?.error || "aiti-cmd 拒绝执行" };
    return { ok: true, sessionId: r.sessionId, queued: r.queued === true, position: r.position };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// ---- 讯飞真流式桥（进程内监听 8768：客户端 /ws/vad → 本桥 → 讯飞 iat WSS）----
// 宿主没有 WS 端点能力（只有 middleware rewrite），所以云引擎真流式 = 扩展进程内起一个 WS 服务，
// middleware 把客户端 WS rewrite 过去；桥只做「签名 + PCM 转发」，凭据每条会话现读。
// 见 docs/aiti-ai-input-asr-provider-plan.md §十。
// 端口随机（listen(0)）：每个 pi-web 实例各起各的桥，不存在双实例抢端口；env 可指定固定端口便于调试
const XF_BRIDGE_PORT = Number(process.env.AITI_XF_BRIDGE_PORT || 0);

/** asr/ensure 核心：探测 → 已通则回 ready；不通则按状态机自动拉起 */
async function asrEnsure(req: Request): Promise<{ running: boolean; starting: boolean; sessionId?: string; error?: string; hint?: string; data?: Record<string, unknown>; provider?: string; providerLabel?: string }> {
  // 云引擎：不需要本地 8767——探测/自愈/拉起整套跳过（客户端据此不弹「服务未运行」告警）
  const cfgP = asrReadModelConfig();
  const pidP = asrProviderId(cfgP);
  // 讯飞：真流式链路需要本地桥在跑（客户端 /ws/vad → 桥 → 讯飞）；桥不在就拉起
  if (pidP === "xfyun") {
    const specP = asrProviderSpec(pidP);
    const br = await ensureXfBridge({ port: XF_BRIDGE_PORT, configPath: asrConfigPath() });
    return {
      running: br.ok,
      starting: false,
      provider: pidP,
      providerLabel: specP.label,
      error: br.ok ? undefined : (br.error || "讯飞真流式桥未启动（下次按 🎤 会重试）"),
      hint: br.ok ? `真流式：/ws/vad → 桥:${br.port} → 讯飞` : undefined,
      bridgePort: br.port,
    };
  }
  if (pidP !== "builtin") {
    const specP = asrProviderSpec(pidP);
    const ready = asrProviderReady(cfgP, pidP);
    return {
      running: ready,
      starting: false,
      provider: pidP,
      providerLabel: specP.label,
      error: ready ? undefined : `${specP.label} 未配置（POST /asr/config 写 API Key）`,
      hint: ready ? `云引擎 ${specP.label} · 无需本地服务` : undefined,
    };
  }
  const probe = await asrProbe();
  if (probe.up) {
    // 自处理：health 通但模型未加载齐（offline_loaded=false）且服务运行已超 5min
    // → 模型加载卡死/GPU 崩（"自身崩而 health 仍绿"的场景）→ 自动重启
    const d = probe.data || {};
    const dl = d.offline_loaded === true;   // offline 模型是否加载
    // 自愈判定时钟：优先服务端 health.uptime（外部脚本拉起的进程也计时准确；旧逻辑用
    // asrLaunch.at，外部拉起时 at 为旧值恒超时 → 每请求重启循环，GLM 5.5G 权重下载反复被打断）。
    // GLM 首次下载远超 5min → GLM 模式阈值放宽到 30min（权重落盘后启动秒级，只影响首装）。
    // 旧版服务无 uptime 时退回 asrLaunch.at，且要求非 idle（idle=外部拉起不自动重启）。
    const upSec = Number((d as any).uptime);
    const isGlm = String(d.offline_model || "").toUpperCase().includes("GLM");
    const staleMs = isGlm ? 30 * 60_000 : 5 * 60_000;
    const matured = Number.isFinite(upSec) && upSec > 0
      ? upSec * 1000 > staleMs
      : asrLaunch.status !== "idle" && Date.now() - (asrLaunch.at || 0) > staleMs;
    if (!dl && matured && asrLaunch.status !== "starting" && !asrLaunchInFlight) {
      try { console.warn("[aiti-ai-input] ASR 探测：模型未加载齐（疑似崩），自动重启"); } catch {}
      await asrControlRestart();
      return { running: true, starting: true, hint: "检测到模型未加载（疑似 GPU 崩），已自动重启" };
    }
    if (asrLaunch.status !== "idle") asrLaunch = { status: "idle", at: Date.now() };
    return { running: true, starting: false, data: probe.data };
  }
  const now = Date.now();
  if (asrLaunch.status === "starting" && now - asrLaunch.at < ASR_LAUNCH_START_TTL_MS) {
    return { running: false, starting: true, sessionId: asrLaunch.sessionId, hint: "ASR 服务启动中，日志见 ⚡命令 面板" };
  }
  if (asrLaunch.status === "failed" && now - asrLaunch.at < ASR_LAUNCH_COOLDOWN_MS) {
    return { running: false, starting: false, error: asrLaunch.error, hint: "上次自动拉起失败（熔断中），稍后重试或到 ⚡命令 面板手动启动" };
  }
  if (asrLaunchInFlight) return { running: false, starting: true, hint: "ASR 服务拉起中（并发请求合并）" };
  asrLaunchInFlight = true;
  let r: { ok: boolean; sessionId?: string; error?: string };
  try {
    r = await asrLaunchViaCmd(req);
  } finally {
    asrLaunchInFlight = false;
  }
  if (r.ok) {
    asrLaunch = { status: "starting", at: now, sessionId: r.sessionId };
    return { running: false, starting: true, sessionId: r.sessionId, hint: "ASR 服务未运行，已自动拉起（⚡命令 面板可看日志）" };
  }
  asrLaunch = { status: "failed", at: now, error: r.error };
  return { running: false, starting: false, error: r.error, hint: `自动拉起失败：${r.error || "未知错误"}` };
}

// ASR 服务地址：ASR_STREAM_BASE = 实时流式 WS + 离线二次识别（voice-asr-stream.py，端口 8767）。
const ASR_STREAM_BASE = process.env.AITI_ASR_STREAM_BASE || "http://127.0.0.1:8767";
// ASR 服务自愈（同进退模型）：探测 8767 不通 → 经 aiti-cmd PTY 自动拉起，日志在 ⚡命令 面板
// ⚠ 自包含：server 代码随扩展部署（deploy 拷 server/ → 扩展目录/server/），
//   由此推导（不硬编码源码路径、不依赖环境变量——设备迁移零改动）。
//   环境变量 AITI_ASR_SERVER_DIR 仍可覆盖（调试/特殊布局用）。
const ASR_SERVER_DIR = process.env.AITI_ASR_SERVER_DIR || (() => {
  try {
    // index.ts 在 <extDir>/index.ts；server 在 <extDir>/server/
    return dirname(fileURLToPath(import.meta.url)) + "/server";
  } catch { return ""; }
})();
// 平台对应启停脚本：Linux bash .sh；Windows powershell .ps1（等同进退模型 + 管理语义）
const ASR_CTL_SCRIPT = process.platform === "win32" ? "start-stream.ps1" : "start-stream.sh";
const ASR_CTL_CMD = process.platform === "win32" ? "powershell" : "bash";
const ASR_START_CMD = process.env.AITI_ASR_START_CMD || `${ASR_CTL_CMD} ${ASR_SERVER_DIR}/${ASR_CTL_SCRIPT}`;
// 启动状态防重：starting 态 120s 内不重复拉起（服务可能在预热）；失败后熔断 60s
const ASR_LAUNCH_START_TTL_MS = 120_000;
const ASR_LAUNCH_COOLDOWN_MS = 60_000;
// WebSocket 路由前缀（浏览器经 pi-web middleware 代理 → ASR_STREAM_BASE；只匹配 ws 路径，
// 避免误吞 /api/extensions/aiti-ai-input/asr/* 业务端点）
const ASR_WS_MARKER = "/aiti-ai-input/asr/ws/";
const ASR_WS_PATH = ASR_WS_MARKER + "stream";

// 自足直连模型（当 core 未暴露 invokeAI / 未升级时兜底；读 <agentDir>/models.json + raw OpenAI 兼容）
// agentDir：PI_CODING_AGENT_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/agent 原行为
const MODELS_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "models.json");

async function selfInvoke(sys: string, user: string, opts: { maxTokens: number; provider?: string; modelId?: string; reasoning?: string }): Promise<{ text: string; provider: string; model: string; usage?: { input?: number; output?: number; cacheRead?: number } }> {
  let { provider: pProv = COMPLETE_MODEL.provider, modelId: pModel = COMPLETE_MODEL.modelId, maxTokens, reasoning } = opts;
  const models = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
  let prov = models.providers[pProv];
  // 会话模型若不在 models.json（无直连凭据）→ 回退默认档（deepseek）
  if (!prov && pProv !== COMPLETE_MODEL.provider) {
    pProv = COMPLETE_MODEL.provider; pModel = COMPLETE_MODEL.modelId;
    prov = models.providers[pProv];
  }
  if (!prov) throw new Error("provider-not-found:" + pProv);
  const base = String(prov.baseUrl || "").replace(/\/$/, "");
  const apiKey = prov.apiKey
    ? String(prov.apiKey)
    : (process.env[String(prov.apiKeyEnv || "")] || "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: pModel, messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.2, ...(reasoning && reasoning !== "off" && pProv === "deepseek" ? { thinking: { type: "enabled" } } : {}) }),
    signal: AbortSignal.timeout(8000),
  });
  // 429 限流/5xx 抖动：退避重试最多 2 次（语音/补全场景遇限流直接失败会让用户觉得“没识别”）
  if (res.status === 429 || res.status >= 500) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 200));
      const r2 = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: pModel, messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.2, ...(reasoning && reasoning !== "off" && pProv === "deepseek" ? { thinking: { type: "enabled" } } : {}) }),
        signal: AbortSignal.timeout(8000),
      });
      if (r2.ok) return parseCompletions(await r2.json(), pProv, pModel);
      if (r2.status !== 429 && r2.status < 500) break;
    }
  }
  if (!res.ok) throw new Error("http:" + res.status);
  return parseCompletions(await res.json(), pProv, pModel);
}
function parseCompletions(data: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } }, pProv: string, pModel: string): { text: string; provider: string; model: string; usage?: { input?: number; output?: number; cacheRead?: number } } {
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    provider: pProv, model: pModel,
    usage: data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens, cacheRead: data.usage.prompt_cache_hit_tokens } : undefined,
  };
}

// 旧 feature id 一次性迁移：asr.hotwords.panel（埋在 voice/asr/hotwords 组）→ 顶级 toolbar.enabled。
// features.json 只存「与默认不同的显式设置」（core registry 负责读写）；未声明的旧 id 用 featureEnabled
// 查不到真值（未知一律视为启用），故直接读盘判断旧键是否有显式布尔值。
// 顺序：先改盘（删旧键，使 registry mtime 缓存失效）→ 再用 registry setter 写新键（它会重读最新盘再落）。
// best-effort：任何异常都只是退回默认值，不影响启动。
function migrateToolbarFeatureId(): void {
  try {
    if (!configDir) return;
    const file = join(dirname(dirname(configDir)), "features.json"); // <dataRoot>/features.json（configDir = <dataRoot>/aiti-ai-input/config）
    let all: Record<string, Record<string, boolean | string>>;
    try { all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, boolean | string>>; } catch { return; }
    const per = all && typeof all["aiti-ai-input"] === "object" && all["aiti-ai-input"] ? all["aiti-ai-input"] : null;
    if (!per) return;
    const legacy = per["asr.hotwords.panel"];
    if (typeof legacy !== "boolean") return; // 无显式旧设置 → 无需迁移
    const needCopy = typeof per["toolbar.enabled"] !== "boolean";
    delete per["asr.hotwords.panel"];         // 退役键清理（避免残留）
    writeFileSync(file, JSON.stringify(all, null, 2), "utf8"); // 先落盘 → registry mtime 缓存自动失效
    if (needCopy) {
      const reg = (globalThis as Record<string, unknown>).__piWebExt as { setFeatureFlag?: (extId: string, fid: string, enabled: boolean) => boolean } | undefined;
      try { reg?.setFeatureFlag?.("aiti-ai-input", "toolbar.enabled", legacy); } catch {}
      console.log("[aiti-ai-input] feature 迁移：asr.hotwords.panel=" + legacy + " → toolbar.enabled");
    }
  } catch { /* 迁移失败不致命 */ }
}

// ==================== AI 补全/语音 服务端（全部在本扩展；只依赖 core 暴露的 ctx.invokeAI） ====================
// 设计：core 只提供通用 invokeAI；prompt 组装/项目现场/上下文/后处理 全在本扩展；token 统计在 core。
// 提示词 = 共享基础段(BASE) + 各场景分叉（续写/修复）；BASE 在最前，公共信息只在基础段出现一次。
const COMPLETE_MODEL = { provider: "deepseek", modelId: "deepseek-v4-flash" }; // 补全/语音专用档（官方 API 配额稳定；flash 价格低；可环境变量覆盖）
const CTX_BUDGET: Record<string, { historyChars: number; inputChars: number; maxTokens: number }> = {
  small: { historyChars: 2000, inputChars: 800, maxTokens: 160 },
  medium: { historyChars: 8000, inputChars: 1600, maxTokens: 256 },
  large: { historyChars: 16000, inputChars: 3200, maxTokens: 384 },
};
// 共享基础段（公共信息，不含置信度规则——续写/修复的置信度策略不同，各自在分叉段声明）
const SYS_BASE = [
  "你是编程开发场景的 AI 助手（coding agent），在帮用户处理代码、工程、调试、性能等开发事务。",
  "保持用户语言与文风；不解释、不评价、不换行、不加编号、不用 markdown；不输出元话语（如「我们需要…」）；",
  "术语措辞：优先采用【项目现场】给出的语言/框架用惯用术语续写；托管内存语言（JS/TS、Python、Java 等）把 null/undefined 风险表述为「空值/未定义访问」，不用 C/C++ 的「指针」措辞。",
].join(" ");
const SYS_COMPLETE = SYS_BASE + " " + [
  "下面这条 user 消息是一整段内容：前部是本会话历史上下文，最后是用户当前正在输入的文字。",
  "任务：直接续写最后一段——像 IDE 补全一样短小精悍，只输出紧接着它的极短下句（一般 8–20 字，可省略主语），保持在编程场景内，绝不发散成完整长句。",
  "置信度（宁缺毋滥）：只有确实能给出自然、高质量、与上下文相关的内容才输出；无把握只输出：无（不要硬凑/重复/元话语）。",
  "示例：<审核代码>→<列出空值和并发写风险。> <改成TS>→<补函数返回类型。> <列表卡>→<考虑虚拟滚动。>",
].join(" ");
const SYS_VOICE = SYS_BASE + " " + [
  "下面这条 user 消息最后是【语音转写】的一段文本（系统语音输入转写的结果，可能带错字/音译词）。",
  "任务（语音修复，不是续写）：只把这段【语音转写】修复为最可能想说的原句——中英文都修：英文/代码词音译还原（太空脚本→TypeScript、飞车→fetch、it AI input→aiti-ai-input、多克→docker），中文重复词去重、同音错字纠正（这个这个→这个、没做呢没做呢→没做呢）。",
  "修复原则（重要）：保持原转写句子的语序与整体结构，只做最小必要改动——换错字、去重复、补/删个别虚词，绝不整句重排或重写（用户要能一眼看出哪里被改，差异越小越好）。",
  "输出约束（重要）：只输出修复后的这段文本本身，不解释、不加引号/编号/前缀后缀、不输出任何其他内容（不要复述/续写别的内容）。",
  "置信度（语音修复专用，宁缺毋滥不适用）：语音转写几乎总有错，宁可给出修复句（用户可一键接受或忽略），也不要漏掉明显错误；",
  "只有当你能逐字确认整句完全自然通顺才输出：无。",
  "示例：<这断代码改成太空脚本>→<这段代码改成 TypeScript> <多克容器>→<docker 容器> <我的这个it AI input是什么情况>→<我的这个 aiti-ai-input 是什么情况> <这个这个飞车加进里面>→<把这个 fetch 加进去> <没做呢没做呢好吗>→<没做呢，好吗>。",
].join(" ");
const LOW_QUAL = /^(无|没|N\/A|none|我需要|请提供|请您|请把|我们没有|无法判断|不确定|我不知道|没有上下文|抱歉)/i;
const LANG_BY_EXT: Record<string, string> = {
  ".java": "Java", ".kt": "Kotlin", ".py": "Python", ".go": "Go", ".rs": "Rust",
  ".ts": "TypeScript", ".tsx": "TypeScript/React", ".js": "JavaScript", ".jsx": "React", ".vue": "Vue", ".svelte": "Svelte",
  ".c": "C", ".cpp": "C++", ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".sh": "Shell", ".sql": "SQL",
};
let projCache = { cwd: "", ts: 0, sig: "" };
function projectSignals(cwd: string): string {
  if (!cwd) return "";
  const now = Date.now();
  if (projCache.cwd === cwd && now - projCache.ts < 300000) return projCache.sig;
  let sig = "";
  try {
    const base = cwd.split(/[\\/]+/).filter(Boolean).pop() || "";
    let pkgName = "", fw = "";
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      pkgName = typeof pkg.name === "string" ? pkg.name : "";
      const deps: string[] = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
      if (deps.some((d) => /^(react|vue|svelte|angular|next|nuxt)$/.test(d))) fw = "Web前端";
      else if (deps.some((d) => /^(@?nest|express|koa|fastify|hono|prisma|typeorm)$/.test(d))) fw = "Node/服务端";
    } catch { /* 无 package.json */ }
    let counts: Record<string, number> = {}; let scanned = 0;
    const scan = (dir: string, depth: number) => {
      if (scanned > 800 || depth > 1) return;
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith(".") || /node_modules|dist|build|out|\.git|vendor|target|coverage/.test(e.name)) continue;
        if (e.isDirectory()) { if (depth < 1) scan(join(dir, e.name), depth + 1); }
        else if (e.isFile()) { scanned++; const m = /\.([A-Za-z0-9]+)$/.exec(e.name); if (m && LANG_BY_EXT["." + m[1]]) counts["." + m[1]] = (counts["." + m[1]] || 0) + 1; }
      }
    };
    try { scan(cwd, 0); } catch {}
    let dl = "", n = 0; for (const [ext, c] of Object.entries(counts)) if (c > n) { n = c; dl = LANG_BY_EXT[ext]; }
    let mods: string[] = [];
    try { mods = readdirSync(cwd, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((x) => !x.startsWith(".") && !/node_modules|dist|build|out|target|vendor/.test(x)).slice(0, 3); } catch {}
    const parts = [pkgName || base];
    if (fw || dl) parts.push([dl, fw].filter(Boolean).join("/"));
    if (mods.length) parts.push("模块:" + mods.join("/"));
    sig = parts.join(" · ");
  } catch { sig = ""; }
  projCache = { cwd, ts: now, sig };
  return sig;
}
function trimToSentence(s: string): string {
  let t = s.trim(); if (!t) return "";
  t = t.replace(/```/g, "").trim();
  const m = t.match(/[^。！？!?…\r\n]*[。！？!?…]?/);
  return m ? m[0].trim() : "";
}
function stripRepeat(c: string, input: string): string {
  const tail = input.slice(-120);
  for (let i = Math.min(c.length, tail.length); i > 0; i--) if (tail.endsWith(c.slice(0, i))) return c.slice(i);
  return c;
}

// 语音修复差异：按 Unicode 码点做 LCS diff → [{op: equal|del|ins, value}]，
// 前端据此把「调整处（新增/替换的字）」加粗高亮，用户一眼看到修复改了什么。
interface DiffSeg { op: "equal" | "del" | "ins"; value: string; }
function textDiff(a: string, b: string): DiffSeg[] {
  const A = [...a], B = [...b];
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: DiffSeg[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { raw.push({ op: "equal", value: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ op: "del", value: A[i] }); i++; }
    else { raw.push({ op: "ins", value: B[j] }); j++; }
  }
  while (i < n) { raw.push({ op: "del", value: A[i] }); i++; }
  while (j < m) { raw.push({ op: "ins", value: B[j] }); j++; }
  // 合并相邻同类段（前端渲染成连续的高亮，不碎成单字符）
  const merged: DiffSeg[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === s.op) last.value += s.value;
    else merged.push({ op: s.op, value: s.value });
  }
  return merged;
}

// 上下文：core.listSessions/readSession（client 传 cwd → 定位最近会话 → 读 user/assistant 消息；
// localComplete 在其上方使用本函数，函数声明提升可用）
// ---------- L0 本地层（零模型秒出）：输入尾段 → 收藏 prompt + 会话历史 前缀匹配 → 补全余段 ----------
// 数据源：① aiti-prompts 的 suggest 进程内处理器（__aitiSuggestHandlers，零 HTTP 自环）发现候选；
//        ② 当前会话历史 user 输入（contextHistory）。
// 匹配：needle（输入末段 ≤40 字）的最长后缀 == 候选 name/text 的前缀 → 余段 = candidate.slice(命中长)。
// 命中即灰字秒出（client 带 ↦收藏/↦历史 角标），不再发 AI 请求；无命中才走 L1 AI。
interface LocalCand { text: string; name: string; source: "prompt" | "history"; use: number; }

// 从输入末段提取候选发现查询词：完整末词 → 过长（中文无词边界）则缩短到尾 2 字兜底。
// 不用 1 字查询（召回太宽，1 字前缀匹配误报率高——单字前缀联想交给 SUG 弹窗）
function localQueryWords(needle: string): string[] {
  const run = /([\u4e00-\u9fa5A-Za-z0-9_\-]{1,24})$/.exec(needle)?.[1] ?? needle;
  const qs: string[] = [run];
  if (run.length > 2) qs.push(run.slice(-2));
  return [...new Set(qs)].filter(Boolean);
}

// 最小字符数加权长度（与 client logic.ts acEffLen 同步）：CJK/全角算 1.5、其他算 1 —— 阈值 3 时英文 3 字符 / 中文 2 字触发
function acEffLen(v: string): number {
  const re = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3040-\u30FF\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/u;
  let n = 0;
  for (const ch of v.trim()) n += re.test(ch) ? 1.5 : 1;
  return n;
}

async function localComplete(
  core: { listSessions(): Promise<unknown[]>; readSession(id: string): Promise<unknown | null> },
  cwd: string,
  input: string,
): Promise<{ text: string; source: string; name: string } | null> {
  const needle = input.trim().slice(-40); // 只取末段（补全只看输入尾部的最近意图）
  if (!needle) return null;
  const cands: LocalCand[] = [];
  // ① 收藏 prompt（aiti-prompts 注册的进程内 handler；substring 发现 → 此处精确前缀匹配收敛）
  const handlers = (globalThis as Record<string, unknown>).__aitiSuggestHandlers as
    Map<string, (q: string, limit: number) => Promise<unknown[]> | unknown[]> | undefined;
  const hPrompt = handlers?.get("aiti-prompts");
  if (hPrompt) {
    let rows: unknown[] = [];
    for (const q of localQueryWords(needle)) {
      try {
        rows = (await Promise.resolve(hPrompt(q, 8))) as unknown[];
        if (rows.length) break; // 有候选即停（更长的查询词召回更准）
      } catch { continue; }
    }
    for (const r of rows) {
      const rr = r as Record<string, unknown> | null;
      if (!rr) continue;
      const t = String(rr.text ?? "").trim();
      const n = String(rr.name ?? "").trim();
      if (!t && !n) continue;
      cands.push({ text: t || n, name: n || t, source: "prompt", use: Number(rr.useCount || 0) });
    }
  }
  // ② 会话历史 user 输入（最近会话；L0 用「我写过的话」续写；跳过【最近回答】伪条目）
  const hist = await contextHistory({ core }, cwd);
  for (const h of hist.slice(0, 8)) {
    const t = String(h || "").trim();
    if (!t || t.startsWith("【最近回答】")) continue;
    cands.push({ text: t, name: t.slice(0, 20), source: "history", use: 0 });
  }
  if (!cands.length) return null;
  // ③ 最长后缀前缀匹配：needle 的某后缀 == 候选 name/text 的前缀 → 余段 = 候选剩余部分
  const srcW = { prompt: 300, history: 100 };
  let best: { text: string; source: string; name: string } | null = null;
  let bestScore = -1;
  for (const c of cands) {
    for (const target of [c.name, c.text]) {
      if (!target) continue;
      if (input.endsWith(target)) continue; // 候选全文已在输入末尾（已写完）→ 不提示
      const tl = target.length, nl = needle.length;
      for (let len = Math.min(tl, nl); len >= 2; len--) { // 至少 2 字才算有效补全（防 1 字误报）
        if (needle.slice(nl - len).toLowerCase() !== target.slice(0, len).toLowerCase()) continue;
        const rem = target.slice(len).trim();
        if (!rem || !/[A-Za-z0-9\u4e00-\u9fa5]/.test(rem)) break; // 无实际余段/纯标点：不补全
        const score = len * 1000 + (srcW[c.source] ?? 100) + Math.min(c.use, 999) + (target === c.name ? 50 : 0);
        if (score > bestScore) { bestScore = score; best = { text: rem, source: c.source, name: c.name }; }
        break; // 该 target 取最长命中即可
      }
    }
  }
  return best;
}

// contextHistory 结果短 TTL 复用（开页方案 §6）：complete/suggest 每请求都 listSessions()+readSession()
// 整会话读、无 TTL——打字期高频触发下是服务端最大重复成本。4s 内同 cwd 直接复用（LRU 上限 16）。
const HIST_TTL_MS = 4000;
const histCache = new Map<string, { at: number; out: string[] }>();

async function contextHistory(ctx: { core: { listSessions(): Promise<unknown[]>; readSession(id: string): Promise<unknown | null> } }, cwd: string): Promise<string[]> {
  if (!cwd) return [];
  const hit = histCache.get(cwd);
  if (hit) {
    if (Date.now() - hit.at <= HIST_TTL_MS) { hit.at = Date.now(); return hit.out; }
    histCache.delete(cwd);
  }
  try {
    const sessions = ((await ctx.core.listSessions()) || []) as Array<{ id?: string; cwd?: string; modified?: string }>;
    const mine = sessions.filter((s) => s.cwd === cwd).sort((a, b) => ((b.modified || "") < (a.modified || "") ? -1 : 1))[0]
      || [...sessions].sort((a, b) => ((b.modified || "") < (a.modified || "") ? -1 : 1))[0]; // 兜底：取最近修改会话（语音修复需要上下文，宁可宽）
    if (!mine?.id) return [];
    const sess = await ctx.core.readSession(mine.id) as { messages?: Array<{ role?: string; content?: unknown }> } | null;

    if (!sess?.messages) return [];
    const out: string[] = []; let lastAsst = "";
    for (const m of sess.messages) {
      const c = m.content; let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) t = c.filter((b) => (b as { type?: string; text?: string }).type === "text").map((b) => (b as { text: string }).text).join("");
      if (!t || !t.trim()) continue;
      if (m.role === "user") out.push(t); else if (m.role === "assistant") lastAsst = t;
    }
    if (lastAsst) out.push("【最近回答】" + lastAsst);

    histCache.set(cwd, { at: Date.now(), out });
    while (histCache.size > 16) histCache.delete(histCache.keys().next().value);
    return out;
  } catch { return []; }
}

export default {
  id: "aiti-ai-input",
  name: "AI input",
  version: "0.4.2",
  icon: "icon.svg",
  client: "dist/aiti-ai-input-client.mjs",

  // AI 自管理清单（docs/aiti-ai-helper-plan.md §3.2）：skills/asr-server 分平台运维手册（一键修复）
  ai: {
    manage: true,
    intro: "AI 能帮我运维语音识别服务器（8767）：状态检查、启停、热词补推、故障排查（分平台脚本，见 skill asr-server）",
    skills: "skills",
  },

  ui: {
    // 图标声明式（"@mic" token → deploy 时嵌入 lucide 线图，宿主自动绘制标准 36×36 按钮；feature 由 client registerItems 同 id 门控，宿主统一过滤）
    toolbar: [{ id: "aiti-asr-open", label: "语音识别引擎管理", icon: "icons/mic.svg" }],
    dialogs: [{ id: "aiti-asr-panel", label: "语音识别引擎管理" }],
    // aiti-float dock：左栏区块 + 右栏 tab 静态声明（id 与 client 注册一致；懒扩展物化触发 + 静态入口）
    // 左栏不静态声明：面板默认**浮窗**（静态声明会让宿主直接物化左栏区块 → 默认出现在左栏）；
    // 用户可点浮窗 ⇱ 手动停靠到左栏/右栏
    sidebarExplorerDock: [],
    rightFileDock: [{ id: "asr", label: "语音识别" }, { id: "asr-usage", label: "语音流量统计" }],
    chatInputTop: [
      { id: "aiti-ai-input-voice-tag", label: "语音/高速输入感知条（识别语音或高速输入·正在修复提示）" },
      { id: "aiti-ai-input-autocomplete", label: "AI 行内自动补全（灰字续句）" },
      { id: "aiti-ai-input-suggest", label: "收藏联想（prompt + 命令，静态优先）" },
    ],
    sessionStats: [
      { id: "aiti-ai-input-aux-usage", label: "其他辅助 AI 用量统计行（会话统计下拉内）" },
    ],
  },

  // 功能管理（aiti-extman 详情面板逐项启停；core 持久化 features.json）
  features: [
    // ===== 两个顶级总闸（不分组 → extman 功能管理最上方两行，分别控两个界面入口）=====
    // ① 顶部工具条图标（🎙️ 语音识别引擎管理入口）——原埋在 voice/asr/hotwords 组的 asr.hotwords.panel，
    //    提到顶级并换 id；旧 id 的显式设置由 startup 里 migrateToolbarFeatureId 一次性搬迁，用户状态不丢。
    { id: "toolbar.enabled", label: "顶部工具条图标（语音识别引擎管理入口）", default: false, description: "控制页面顶部工具条是否出现图标按钮（点开 = 引擎切换 + 引擎参数 + 通用配置（链路开关/环境变量））。关掉只收起这个入口，不影响语音输入本身（见 voice.enabled）。" },
    // ② 语音输入法（🎤 按钮贴在输入框上，按住说话）
    { id: "voice.enabled", label: "语音输入法（按钮，贴在输入框上）", default: false, description: "控制输入框上的 🎤 语音输入按钮（按住说话 → 实时识别/二次识别上屏整条录入链路）。**未完全测好→默认关**，需到 extman 手动开；关闭时按钮不挂载、也不会申请麦克风；转写文本的拼写修复另有 voice.fix 开关。" },
    // 组：自动补全
    { id: "autocomplete.enabled", label: "AI 行内自动补全", group: "auto-complete", default: true },
    { id: "autocomplete.localOnly", label: "仅本地补全（不用模型，0 出网）", group: "auto-complete", default: false },
    // 最小字符数：输入不足该字符数时不尝试自动补全（string 类型，extman 面板文本框可改）
    { id: "autocomplete.minChars", type: "string", label: "最小字符数（低于不自动补全）", group: "auto-complete", value: "3", placeholder: "3", description: "输入加权长度不足时不出灰字、不发请求（CJK/全角按 1.5 计——英文 3 字符 / 中文 2 字触发；0=不限制）" },
    // 组：上下文预算（互斥三选一，默认 medium；全关回落 medium）
    { id: "autocomplete.ctx.small", label: "上下文：小（~0.8k/次）", group: "auto-complete/context", default: false },
    { id: "autocomplete.ctx.medium", label: "上下文：中（~2.9k/次，默认）", group: "auto-complete/context", default: true },
    { id: "autocomplete.ctx.large", label: "上下文：大（~5.5k/次）", group: "auto-complete/context", default: false },
    // 组：收藏联想（建议区内嵌候选，词云端显示收藏/命令；关则仅剩 AI 续写与语音修复）
    { id: "suggest.enabled", label: "收藏/命令联想（建议区显示）", group: "suggest", default: true },
    // 短输入严格模式阈值：查询不超过该字符数时走严格过滤（防 1-2 字符英文/中文 substring 命中大量长尾候选）
    { id: "suggest.looseLen", type: "string", label: "短输入严格过滤阈值（字符数，超过才宽松匹配）", group: "suggest", value: "10", placeholder: "10", description: "查询长度 ≤ 该值时走严格过滤：英文≥3字符/中文≥2字，且查询需达标题或内容长度的 1/4 才弹出（防短词命中长正文噪音）；> 该值按 substring 宽松匹配。0=关闭严格过滤。" },
    // suggest ⚡ 一键执行（aiti-cmd-exec-integration-plan.md §3.4；默认关——联想出的命令不自动跑，
    // 用户显式点 ⚡ 才执行；命令已在前端 → 直接前端 POST aiti-cmd /run，不绕本扩展服务端）
    { id: "ai-input.suggestRun", label: "suggest 命令 ⚡ 一键执行（候选项旁加执行按钮，危险命令二次确认）", group: "suggest", default: false, description: "开启后命令联想候选项旁出现 ⚡：点击直接执行该命令（走 aiti-cmd /run + 两段式确认；不自动触发）。" },
    // 组：语音与高速输入优化（默认关：修复误判偶尔打扰正常打字，需要时显式开启）
    { id: "voice.fix", label: "语音与高速输入拼写修复（识别到语音或高速输入后修复错字/代码词音译）", group: "voice", default: false },
    { id: "voice.indicator", label: "语音/高速输入感知条（识别到语音或高速输入时顶部提示正在修复）", group: "voice", default: false },
    // 组：语音 ASR（实时流式 + 二次识别，见 docs/aiti-voice-input-realtime-asr-plan.md）
    { id: "asr.streaming", label: "实时识别（按住麦克风边说边出；SenseVoice 伪实时分句秒出 / paraformer WS）", group: "voice/asr", default: true, description: "实时识别开。流式模型选 SenseVoice（默认）= VAD 停顿分句 + SenseVoice 秒出逐句上屏（快，纯中文好）；选 paraformer = 老 WS 逐 chunk 实时（质量差）。" },
    { id: "asr.vad", label: "VAD 自动切句（说话停顿自动切句识别）", group: "voice/asr", default: true, description: "按住 🎤 说话，停顿约 0.7s 自动切句并识别上屏；不需要时可关。" },
    { id: "asr.vad.rms", type: "string", label: "静音判定阈值（RMS，越小越灵敏）", group: "voice/asr", value: "0.005", placeholder: "0.005", description: "本地 VAD 切句的静音判据：某帧 RMS 低于该值即算静音。实测参考：正常说话 RMS≈0.02~0.10，小声/离麦远≈0.010，很低声≈0.003，安静房间底噪≈0.002~0.003。默认 0.005：够灵敏又高于底噪；安静环境可 0.003，嘈杂/键盘声多改 0.01~0.02。只影响「本地切句」链路（云引擎 + 伪实时分句），走服务端 /ws/vad 时由服务端判定。" },
    { id: "asr.inputGain", type: "string", label: "麦克风输入增益（倍）", group: "voice/asr", value: "1", placeholder: "1", description: "1–8 倍，只作用于送识别的音频（不写入录音文件，不改系统音量）。小声说话可设 2–4；过大会削波失真，>8 无效。" },
    { id: "asr.split", label: "伪实时分句（按住麦克风说话停顿自动切句，SenseVoice 秒出逐句上屏，松手收尾）", group: "voice/asr", default: true, description: "按住说话，停顿 ~0.7s 自动把该句发 SenseVoice 识别上屏（~0.3s/句），不用松手等整段；松手提交尾句。SenseVoice 纯中文快，术语/英文会拆字母。" },
    { id: "asr.pass2", label: "语音二次识别（松手后稍延离线精修再上屏，2-pass 更准）", group: "voice/asr", default: true },
    { id: "asr.model.stream", type: "string", label: "实时流式模型", group: "voice/asr/model", value: "iic/SenseVoiceSmall", placeholder: "iic/SenseVoiceSmall", description: "实时识别模型：SenseVoice（默认·伪实时分句·快）或 paraformer-zh-streaming（老 WS chunk 流式）；改后服务重启生效。" },
    { id: "asr.model.offline", type: "string", label: "2-pass 精修模型", group: "voice/asr/model", value: "Qwen/Qwen3-ASR-0.6B", placeholder: "Qwen/Qwen3-ASR-0.6B", description: "松手后离线精修模型（标点/术语大小写/语种；Qwen3 带 context 热词）; 改后服务重启生效。" },
    // 组：热词（All Sessions 历史词 → funasr postprocess 纠偏；配 session-manager 提取）
    { id: "asr.hotwords.count", type: "string", label: "热词提取数量（中英文各 N）", group: "voice/asr/hotwords", value: "100", placeholder: "100", description: "从 All Sessions 历史消息提取的中文/英文热词各 N 个（0=关闭热词；越大越全面但可能稀释）" },
    // （工具条 🎙️ 入口已提升为顶级开关 toolbar.enabled；旧 asr.hotwords.panel 退役 + startup 迁移）
    { id: "asr.hotwords.includeUser", label: "热词提取包含：用户输入", group: "voice/asr/hotwords", default: true },
    { id: "asr.hotwords.includeAi", label: "热词提取包含：AI 输入", group: "voice/asr/hotwords", default: true },
  ],

  server: {
    startup(ctx) {
      configDir = (ctx as { configDir?: string }).configDir || (ctx as { dataDir?: string }).dataDir || ""; // 新旧 core 双轨（新 core dataDir 访问即抛，configDir 在前短路）
      // 用量统计落 state 层（不可再生数据）；旧 core 无 stateDir → 回退扩展数据根下的 state/（configDir = <extRoot>/config）
      stateDir = (ctx as { stateDir?: string }).stateDir || (configDir ? join(dirname(configDir), "state") : "");
      setUsageDir(stateDir);
      // lazy migrate（数据分层双保险）：旧根级 venv/录音/审计 → cache/（同盘 rename 瞬时；防迁移脚本漏网）
      for (const rel of ["asr-venv", "glm-venv", "recordings", "audit.jsonl"]) {
        const from = join(configDir, rel), to = join(dirname(configDir), "cache", rel); // 数据分层：cache 在扩展数据根下
        try { if (existsSync(from) && !existsSync(to)) { mkdirSync(join(to, ".."), { recursive: true }); renameSync(from, to); } } catch {}
      }
      // DI 方案 P1：features/services 通道捕获（featureGet 与 hotwords 消费走新通道）
      hostFeatures = ctx.features ?? null;
      hostSvc = ctx.services ?? null;
      //（ASR 稳定器为被动模式：无定时器——见 asrEnsure 内的模型未加载自处理逻辑）
      // 初始化 ASR 模型配置文件（server/asr-config.json）——默认模型，服务启动据此加载；
      // 模型 feature 变化时重写（set-feature → asrControlRestart → asrWriteModelConfig）
      try { asrWriteModelConfig(); } catch {}
      // 讯飞引擎：先把真流式桥起好（首次按 🎤 不必等；起不来也只影响流式，HTTP 链路照常）
      try { if (asrProviderId(asrReadModelConfig()) === "xfyun") void ensureXfBridge({ port: XF_BRIDGE_PORT, configPath: asrConfigPath() }); } catch {}
      // 旧 feature id 迁移（asr.hotwords.panel → 顶级 toolbar.enabled），best-effort，失败不致影响启动
      try { migrateToolbarFeatureId(); } catch {}
      console.log("[aiti-ai-input] 就绪 · 顶级开关(工具条🎙️/语音🎤) + 语音标记 + 自动补全 + 收藏联想(suggest) + 实时流式 ASR(WS)");
    },

    async api(req, ctx) {
      const p = ctx.path || [];
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { "content-type": "application/json", "cache-control": "no-store" },
      });

      // ---------- AI 补全/语音判定（业务全在本扩展；模型调用走 core ctx.invokeAI，token 统计在 core） ----------
      // POST /complete { input, mode?: complete|voice-fix, ctx?: small|medium|large, cwd? }
      if (p[0] === "complete" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const input = body && typeof body.input === "string" ? (body.input as string).trim() : "";
        if (!input) return json({ ok: false, error: "empty-input" }, 400);
        const mode = body && body.mode === "voice-fix" ? "voice-fix" : (body && body.mode === "local" ? "local" : "complete");
        const size = (body && (body.ctx === "small" || body.ctx === "large") ? body.ctx : "medium") as keyof typeof CTX_BUDGET;
        const cwd = body && typeof body.cwd === "string" ? (body.cwd as string) : "";

        // L0 本地层（零模型秒出）：收藏/历史前缀匹配 → 命中即返回余段 + 来源，client 灰字直出不再请求 AI
        if (mode === "local") {
          const local = await localComplete(ctx.core as never, cwd, input);
          return json({ ok: true, ...(local ? { text: local.text, source: local.source, name: local.name } : { text: "" }) });
        }
        // 模型：跟随当前会话（client 传 body.model = ChatInput 的 model prop）；不传才回退默认档
        // 最小字符数兜底：低于阈值不调模型（客户端已门控，此处防直连绕过；CJK 1.5 加权同 client；0=不限制）
        if (mode === "complete") {
          const mc = parseInt(String(featureGet("autocomplete.minChars", "")), 10);
          const minChars = Number.isFinite(mc) && mc >= 0 ? mc : 3;
          if (acEffLen(input) < minChars) return json({ ok: true, text: "" });
        }
        const reqModel = body && body.model && typeof body.model === "object"
          && typeof (body.model as any).provider === "string" && typeof (body.model as any).modelId === "string"
          ? { provider: (body.model as any).provider, modelId: (body.model as any).modelId } : null;
        const model = reqModel || { ...COMPLETE_MODEL };
        const b = CTX_BUDGET[size] || CTX_BUDGET.medium;
        const sys = mode === "voice-fix" ? SYS_VOICE : SYS_COMPLETE;
        const proj = projectSignals(cwd);
        // 语音修复只处理当前这一句：不拼整段会话历史（避免“整段提交给 AI 翻译”导致作用域失控）
        let histStr = "";
        if (mode !== "voice-fix") {
          // 存量 bug 修复（开页方案 §6 治理时发现）：原传 ctx.core，而本函数期望 {core} 包装
          // ——内部 ctx.core.listSessions 变成 core.core 抛 TypeError 被 catch 吞掉 → AI 补全
          // 的会话历史永远为空（histStr 恒空串）。修正为与 localComplete 相同的包装形态。
          const hist = await contextHistory({ core: ctx.core } as never, cwd);
          const histTexts = hist.filter((h) => h && h.trim()).map((h) => h.trim());
          histStr = histTexts.join("\n\n");
          if (histStr.length > b.historyChars) histStr = histStr.slice(0, b.historyChars);
        }
        const inputTail = input.slice(-b.inputChars);
        const inputText = inputTail.length < input.length ? `…${inputTail}` : inputTail;
        const tailLabel = mode === "voice-fix" ? "【语音转写】" : "【当前正在输入】";
        const block = [proj ? `【项目现场】${proj}` : "", histStr ? `【历史上下文】\n${histStr}` : "", `${tailLabel}\n${inputText}`].filter(Boolean).join("\n\n");
        const invoke = (ctx as { invokeAI?: (p: any) => Promise<any> }).invokeAI;
        const res = invoke
          ? await invoke({ provider: model.provider, modelId: model.modelId, system: sys, messages: [{ role: "user", content: block || inputText }], maxTokens: b.maxTokens, temperature: 0.2, reasoning: mode === "voice-fix" ? "high" : "off", caller: mode === "voice-fix" ? "aiti-ai-input/voice-fix" : "aiti-ai-input/complete", sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined })
          : await selfInvoke(sys, block || inputText, { ...model, maxTokens: b.maxTokens, reasoning: mode === "voice-fix" ? "high" : "off" }); // core 未升级时兜底直连（dev/prod 兼容）
        let text = "";
        let diff: DiffSeg[] = [];
        if (mode === "voice-fix") {
          text = (res.text || "").replace(/```[a-zA-Z0-9]*\s*/g, "").replace(/```\s*$/g, "").trim();
          if (/^(无|没|N\/A|none|no)$/i.test(text) || text === inputText || text === input) {
            text = "";
          } else {
            // 差异基于完整语音段（input，非截断的 inputText）——前端据此高亮删/增
            diff = textDiff(input, text);
            if (!diff.some((s) => s.op !== "equal")) text = ""; // 修复=原文（纯 equal）：无需打扰
          }
        } else {
          text = stripRepeat(trimToSentence(res.text || ""), inputText);
          if (!text || LOW_QUAL.test(text) || text.length < 2) text = "";
        }
        return json({ ok: true, text, ...(diff.length ? { diff } : {}), provider: res.provider, model: res.model, usage: res.usage }); // 记账在 core，此处仅透传 usage
      }

      // GET /features → 自动补全相关 feature 状态（client 启动读取；extman 改完 5s 内重拉生效）
      if (p[0] === "features" && p.length === 1) {
        // DI 方案 P1：feature 读收口走 featureGet（ctx.features 优先 + 旧通道兜底）
        const enabled = (fid: string, fallback = true) => featureGet(fid, fallback) !== false;
        const sval = (fid: string) => String(featureGet(fid, ""));
        const size = featureGet("autocomplete.ctx.large", false) === true ? "large"
          : featureGet("autocomplete.ctx.small", false) === true ? "small" : "medium"; // 互斥三选一；全关回落 medium
        const minCharsParsed = parseInt(sval("autocomplete.minChars"), 10);
        const hwCountRaw = parseInt(sval("asr.hotwords.count"), 10);
        // ASR 引擎（可插拔）：当前引擎 + 是否已配置可用（key 本身绝不回传前端）
        const cfgPV = asrReadModelConfig();
        const pv = asrProviderView(cfgPV);
        const asrEngines = pv.providers.map((e) => ({ id: e.id, label: e.label, ready: e.ready }));
        return json({ ok: true, asrProvider: pv.provider, asrProviderReady: pv.providerReady, asrEngines, autoComplete: enabled("autocomplete.enabled", true), localOnly: enabled("autocomplete.localOnly", false), suggest: enabled("suggest.enabled", false), suggestRun: featureGet("ai-input.suggestRun", false) === true, ctx: size, minChars: Number.isFinite(minCharsParsed) && minCharsParsed >= 0 ? minCharsParsed : 3, voiceFix: enabled("voice.fix", false), voiceIndicator: enabled("voice.indicator", false), asrStreaming: enabled("asr.streaming", true), asrVad: enabled("asr.vad", true), asrSplit: enabled("asr.split", true), asrPass2: enabled("asr.pass2", true), asrHotwordsCount: Number.isFinite(hwCountRaw) && hwCountRaw >= 0 ? hwCountRaw : 100, asrHotwordsIncludeUser: enabled("asr.hotwords.includeUser", true), asrHotwordsIncludeAi: enabled("asr.hotwords.includeAi", true), toolbar: enabled("toolbar.enabled", false), voiceInput: enabled("voice.enabled", false), asrModelStream: sval("asr.model.stream") || "iic/SenseVoiceSmall", asrModelOffline: sval("asr.model.offline") || "Qwen/Qwen3-ASR-0.6B",
        // 小声识别辅助：静音判定阈值 + 输入增益（面板「通用配置」可调）
        asrVadRms: sval("asr.vad.rms") || "0.005", asrInputGain: sval("asr.inputGain") || "1" });
      }

      // ---------- ASR 二次识别代理（2-pass 第二遍，离线精修，最终文本） ----------
      // POST /voice-asr2 { audio: wav } → 当前引擎 transcribe(mode:"final")
      //   builtin：原样透传 8767 /voice/transcribe；云引擎：整段转写后返回（客户端零改动）
      if (p[0] === "voice-asr2" && p.length === 1 && req.method === "POST") {
        const cwd = req.headers.get("x-aiti-cwd") || undefined; // cwd 走 header：不进 URL/access log
        const raw = await req.arrayBuffer().catch(() => null);
        if (!raw || raw.byteLength === 0) return json({ ok: false, error: "missing-audio" }, 400);
        const ct = req.headers.get("content-type") || "";
        const cfg = asrReadModelConfig();
        const pid = asrProviderId(cfg);
        const spec = asrProviderSpec(pid);
        if (pid === "builtin") void asrPushHotwords(cwd); // 2-pass 前确保热词新鲜（per-ws 懒拉 + TTL；推送与识别并行）
        // 接口级热词（讯飞）：builtin 走 8767 推送；其余只对声明 hotwords 能力的云引擎注入
        let hotwords: string[] | undefined;
        if (pid !== "builtin" && spec.capabilities.hotwords) {
          try { hotwords = (await asrGetHotwords(cwd)).list; } catch { hotwords = undefined; }
        }
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), spec.timeout.final);
        try {
          const r = await spec.transcribe({
            raw, contentType: ct, mode: "final",
            base: ASR_STREAM_BASE, ws: cwd ? asrWsKey(cwd) : undefined,
            pcfg: asrProviderCfg(cfg, pid), hotwords, timeoutMs: spec.timeout.final, signal: ctrl.signal,
          });
          clearTimeout(to);
          // 上游业务码（百度 err_no / 讯飞 code）不是 HTTP 状态码 → 夹紧到 4xx/5xx，否则 Response 构造会抛
          const httpStatus = typeof r.status === "number" && r.status >= 400 && r.status <= 599 ? r.status : 500;
          recordUsage({ provider: pid, mode: "final", seconds: estAudioSeconds(raw.byteLength), ok: r.ok, error: r.ok ? undefined : r.error });
          if (!r.ok) return json({ ok: false, error: r.error, hint: r.hint, status: r.status }, httpStatus);
          return json(r.data ?? { ok: true, text: r.text });
        } catch (e) {
          clearTimeout(to);
          recordUsage({ provider: pid, mode: "final", seconds: estAudioSeconds(raw.byteLength), ok: false, error: "proxy-failed" });
          return json({ ok: false, error: pid === "builtin" ? "asr2-proxy-failed" : `${pid}-failed: ${String((e as Error)?.message || e)}` }, 500);
        }
      }

      // ---------- ASR 快速识别代理（伪实时分句：VAD 停顿→SenseVoice 整句秒出） ----------
      // POST /voice-quick { audio: wav } → 当前引擎 transcribe(mode:"quick")
      //   builtin：透传 8767 /voice/quick；云引擎：同一段音频走云转写（VAD 伪实时分句链自动适用）
      if (p[0] === "voice-quick" && p.length === 1 && req.method === "POST") {
        const raw = await req.arrayBuffer().catch(() => null);
        if (!raw || raw.byteLength === 0) return json({ ok: false, error: "missing-audio" }, 400);
        const ct = req.headers.get("content-type") || "";
        const cfg = asrReadModelConfig();
        const pid = asrProviderId(cfg);
        const spec = asrProviderSpec(pid);
        // 接口级热词（讯飞）：quick 每句都很短，热词意义不大且要等缓存 —— 只在 final（整段精修）注入
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), spec.timeout.quick);
        try {
          const r = await spec.transcribe({
            raw, contentType: ct, mode: "quick",
            base: ASR_STREAM_BASE, pcfg: asrProviderCfg(cfg, pid), timeoutMs: spec.timeout.quick, signal: ctrl.signal,
          });
          clearTimeout(to);
          // 上游业务码（百度 err_no / 讯飞 code）不是 HTTP 状态码 → 夹紧到 4xx/5xx，否则 Response 构造会抛
          const httpStatus = typeof r.status === "number" && r.status >= 400 && r.status <= 599 ? r.status : 500;
          recordUsage({ provider: pid, mode: "quick", seconds: estAudioSeconds(raw.byteLength), ok: r.ok, error: r.ok ? undefined : r.error });
          if (!r.ok) return json({ ok: false, error: r.error, hint: r.hint, status: r.status }, httpStatus);
          return json(r.data ?? { ok: true, text: r.text });
        } catch (e) {
          clearTimeout(to);
          recordUsage({ provider: pid, mode: "quick", seconds: estAudioSeconds(raw.byteLength), ok: false, error: "proxy-failed" });
          return json({ ok: false, error: pid === "builtin" ? "quick-proxy-failed" : `${pid}-failed: ${String((e as Error)?.message || e)}` }, 500);
        }
      }

      // ---------- ASR 引擎配置（可插拔引擎：builtin 8767 / 云 API；见 docs/aiti-ai-input-asr-provider-plan.md） ----------
      // GET /asr/config → 引擎总览（脱敏：key 只回 configured + 尾 4 位，绝不回传完整 key）
      if (p[0] === "asr" && p[1] === "config" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, ...asrProviderView(asrReadModelConfig()) });
      }
      // POST /asr/config { provider?: "builtin"|"siliconflow", providers?: { <id>: { apiKey?, model? } } }
      //   → 白名单合并写入 asr-config.json（空串 = 删除该项），即时生效（无重启概念）
      if (p[0] === "asr" && p[1] === "config" && p.length === 2 && req.method === "POST") {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return json({ ok: false, error: "body 必须是 JSON 对象" }, 400);
        const merged = asrMergeProviderCfg(asrReadModelConfig(), body);
        if (merged.error) return json({ ok: false, error: merged.error }, 400);
        try {
          try { mkdirSync(configDir, { recursive: true }); } catch {}
          writeFileSync(asrConfigPath(), JSON.stringify(merged.cfg, null, 2), "utf8");
          return json({ ok: true, ...asrProviderView(asrReadModelConfig()), hint: "已保存 · 下次按 🎤 即生效" });
        } catch (e) {
          return json({ ok: false, error: "写配置失败" }, 500);
        }
      }
      // ---------- ASR 用量统计（云引擎计费口径；按天：请求数 / 音频时长 / 错误数） ----------
      // GET /asr/usage → 今日 + 累计（per 引擎）+ 单价 + 最近使用
      if (p[0] === "asr" && p[1] === "usage" && p.length === 2 && req.method === "GET") {
        return json(readUsage());
      }
      // GET /asr/usage/series?days=30 → 趋势（按天 × 引擎 × 模式）+ 全期汇总（报表一次拉全，避免分块多次请求）
      if (p[0] === "asr" && p[1] === "usage" && p[2] === "series" && p.length === 3 && req.method === "GET") {
        const n = parseInt(String(new URL(req.url || "http://localhost").searchParams.get("days") || "30"), 10);
        return json(readSeries(Number.isFinite(n) ? n : 30));
      }
      // POST /asr/usage { action: "reset" } | { price: { <provider>: 元/分钟 } }
      if (p[0] === "asr" && p[1] === "usage" && p.length === 2 && req.method === "POST") {
        const body = await req.json().catch(() => null) as { action?: string; price?: Record<string, unknown> } | null;
        if (body?.action === "reset") { resetUsage(); return json({ ...readUsage(), hint: "已清空用量（单价保留）" }); }
        if (body?.price && typeof body.price === "object") {
          const price = setUsagePrice(body.price);
          return json({ ...readUsage(), price, hint: "单价已保存" });
        }
        return json({ ok: false, error: '需要 action:"reset" 或 price:{<provider>: 元/分钟}' }, 400);
      }
      // POST /asr/test → 1s 静音 wav 走当前引擎转写：不用说话即可验证 key / 网络 / 服务连通与耗时
      if (p[0] === "asr" && p[1] === "test" && p.length === 2 && req.method === "POST") {
        const cfg = asrReadModelConfig();
        const pid = asrProviderId(cfg);
        const spec = asrProviderSpec(pid);
        if (!asrProviderReady(cfg, pid)) {
          return json({ ok: false, provider: pid, error: `${spec.label} 未配置`, hint: "先填好该引擎的参数再测试" }, 400);
        }
        if (pid === "builtin") {
          const probe = await asrProbe();
          if (!probe.up) return json({ ok: false, provider: pid, error: "自建 8767 未运行", hint: "点「启动」，或下次按 🎤 会自动拉起" });
        }
        const mp = encodeMultipart([{ name: "audio", filename: "silence.wav", type: "audio/wav", value: silenceWav(1000) }]);
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), spec.timeout.quick);
        const t0 = Date.now();
        try {
          const r = await spec.transcribe({
            raw: mp.body, contentType: mp.contentType, mode: "quick",
            base: ASR_STREAM_BASE, pcfg: asrProviderCfg(cfg, pid), timeoutMs: spec.timeout.quick, signal: ctrl.signal,
          });
          clearTimeout(to);
          const ms = Date.now() - t0;
          if (!r.ok) return json({ ok: false, provider: pid, error: r.error, hint: r.hint, ms });
          return json({ ok: true, provider: pid, ms, text: r.text, note: r.text ? undefined : "连通正常（静音 → 空文本符合预期）" });
        } catch (e) {
          clearTimeout(to);
          return json({ ok: false, provider: pid, error: String((e as Error)?.message || e), ms: Date.now() - t0 }, 500);
        }
      }

      // GET /asr/env → 读配置 env 对象（环境变量管理弹窗用；无则空对象，绝不 500）
      if (p[0] === "asr" && p[1] === "env" && p.length === 2 && req.method === "GET") {
        const cfg = asrReadModelConfig();
        const env = (cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)) ? cfg.env : {};
        return json({ ok: true, env });
      }

      // PUT /asr/env { env: {KEY: "value", ...} } → 合并写回 config.env（空对象=清空；非法键名整体拒绝）
      if (p[0] === "asr" && p[1] === "env" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        const sanitized = asrSanitizeEnv(body ? (body as Record<string, unknown>).env : null);
        if (sanitized === null) return json({ ok: false, error: "env 必须是键值对象（键名 [A-Za-z_][A-Za-z0-9_]*，值非空字符串）" }, 400);
        try {
          const cfg = asrReadModelConfig();
          cfg.env = sanitized;
          try { mkdirSync(configDir, { recursive: true }); } catch {}
          writeFileSync(asrConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
          return json({ ok: true, env: sanitized, hint: "已保存 · 重启 ASR 服务后生效" });
        } catch (e) {
          return json({ ok: false, error: "写配置失败" }, 500);
        }
      }

      // GET /asr/info → 实时 ASR 状态（探测 + 自愈状态机 + 热词/workspace 统计；管理面板用）
      if (p[0] === "asr" && p[1] === "info" && p.length === 2) {
        const cfg = asrReadModelConfig();
        const pid = asrProviderId(cfg);
        const view = asrProviderView(cfg);
        // 云引擎：不探测 8767（本就没跑），返回引擎自身状态
        if (pid !== "builtin") {
          const spec = asrProviderSpec(pid);
          const ready = asrProviderReady(cfg, pid);
          return json({
            ok: true, running: ready, starting: false, lastError: null,
            provider: pid, providerLabel: spec.label, providerReady: ready,
            capabilities: spec.capabilities, engines: view, wsPath: ASR_WS_PATH,
            bridgeUp: pid === "xfyun" ? xfBridgePort() !== 0 : undefined, bridgePort: pid === "xfyun" ? xfBridgePort() : undefined,
          });
        }
        const probe = await asrProbe();
        const st = { running: probe.up, starting: asrLaunch.status === "starting", lastError: asrLaunch.error || null, wsPath: ASR_WS_PATH };
        if (probe.up && probe.data) {
          return json({ ok: true, ...probe.data, ...st, streamingBase: ASR_STREAM_BASE, provider: pid, providerReady: true, engines: view });
        }
        // 被动探测：服务未运行是「状态」而非「错误」——返回 200 + wrapper（ok:false/running:false），
        // 避免浏览器把正常的状态查询当成网络错误（503 触发 conn-guard 噪音/控制台红色告警）。
        return json({ ok: false, error: "asr-stream-unreachable", ...st, provider: pid, providerReady: true, engines: view });
      }

      // ---------- ASR 服务管理（启停；经 aiti-cmd PTY 会话——与语音自愈同一套机制） ----------
      // POST /asr/control { action: "start" | "stop" | "restart" }
      if (p[0] === "asr" && p[1] === "control" && p.length === 2 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const action = body && typeof body.action === "string" ? body.action : "";
        // 启停只对 builtin 有意义（云引擎没有本地进程可管）
        if (asrProviderId(asrReadModelConfig()) !== "builtin") {
          return json({ ok: false, error: "当前引擎是云引擎，启停不适用（切回 builtin 才可启停 8767）" }, 400);
        }
        const reg = (globalThis as Record<string, unknown>).__piWebExt as { api?: (req: Request, path: string[]) => Promise<Response | null> } | undefined;
        if (action === "start") {
          if (asrLaunchInFlight) return json({ ok: true, starting: true, hint: "已有拉起在途，合并" });
          asrLaunchInFlight = true;
          let r: { ok: boolean; sessionId?: string; error?: string };
          try { r = await asrLaunchViaCmd(req); } finally { asrLaunchInFlight = false; }
          if (r.ok) { asrLaunch = { status: "starting", at: Date.now(), sessionId: r.sessionId }; return json({ ok: true, starting: true, sessionId: r.sessionId }); }
          return json({ ok: false, error: r.error }, 500);
        }
        if (action === "stop" || action === "restart") {
          let killed = 0;
          // 主路径：直接执行 stop 脚本（按端口精确杀 pid——reload 后 aiti-cmd 会话可能已丢（孤儿进程），
          // 会话 kill 仅作补充；stop 脚本幂等：不在监听则直接退出）
          try {
            const { execFile } = await import("node:child_process");
            await new Promise<void>((resolve) => {
              execFile(ASR_CTL_CMD, [join(ASR_SERVER_DIR, ASR_CTL_SCRIPT), "stop"], { timeout: 25000 }, () => resolve());
            });
            killed = 1;
          } catch { /* 脚本执行失败：继续走会话 kill */ }
          try {
            const res = await reg?.api?.(new Request("http://internal/api/extensions/aiti-cmd/sessions", { method: "GET" }), ["aiti-cmd", "sessions"]);
            const list = await res?.json().catch(() => null);
            const sessions = (list?.sessions || []) as Array<{ id: string; cmd: string; status: string }>;
            for (const s of sessions) {
              if (s.status === "running" && s.cmd.includes("start-stream.sh")) {
                await reg?.api?.(new Request("http://internal/api/extensions/aiti-cmd/sessions/" + s.id + "/kill", { method: "POST" }), ["aiti-cmd", "sessions", s.id, "kill"]);
                killed++;
              }
            }
          } catch { /* 会话查询失败：依赖 ensure 自愈 */ }
          // 置状态：stop 后允许自愈重新拉起（同进退模型）；restart 直接再拉起
          asrLaunch = { status: "idle", at: Date.now() };
          if (action === "restart") {
            if (asrLaunchInFlight) return json({ ok: true, killed, starting: true, hint: "已有拉起在途，合并" });
            asrLaunchInFlight = true;
            let r: { ok: boolean; sessionId?: string; error?: string };
            try { r = await asrLaunchViaCmd(req); } finally { asrLaunchInFlight = false; }
            if (r.ok) { asrLaunch = { status: "starting", at: Date.now(), sessionId: r.sessionId }; return json({ ok: true, killed, starting: true, sessionId: r.sessionId }); }
            return json({ ok: false, killed, error: r.error }, 500);
          }
          return json({ ok: true, killed, stopped: true });
        }
        return json({ ok: false, error: "action 必须为 start|stop|restart" }, 400);
      }

      // ---------- 弹窗内 feature 修改（进程内直调 registry setter——与 extman 同一持久化/广播机制） ----------
      // POST /asr/set-feature { featureId, enabled?, value? } → 白名单校验 + 写 features.json + 广播变更
      if (p[0] === "asr" && p[1] === "set-feature" && p.length === 2 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const fid = body && typeof body.featureId === "string" ? body.featureId : "";
        const ALLOWED = new Set(["asr.hotwords.count", "asr.hotwords.includeUser", "asr.hotwords.includeAi", "asr.streaming", "asr.vad", "asr.split", "asr.pass2", "asr.model.stream", "asr.model.offline", "asr.vad.rms", "asr.inputGain"]);
        if (!ALLOWED.has(fid)) return json({ ok: false, error: "featureId 不在可改清单" }, 400);
        const reg = (globalThis as Record<string, unknown>).__piWebExt as {
          setFeatureValue?: (extId: string, fid: string, v: boolean | string) => boolean | string;
          setFeatureFlag?: (extId: string, fid: string, enabled: boolean) => boolean;
        } | undefined;
        if (!reg?.setFeatureValue) return json({ ok: false, error: "registry setter 不可用" }, 500);
        if (typeof body.value === "string") {
          reg.setFeatureValue("aiti-ai-input", fid, body.value);
        } else {
          reg.setFeatureFlag("aiti-ai-input", fid, body.enabled !== false);
        }
        // 热词相关变化 → 拉取缓存失效 + 防抖清空 + 立即重拉重推（当前 workspace；服务在跑才推）
        if (fid.startsWith("asr.hotwords.")) {
          asrHotwordsCache.clear();
          asrHotwordsPushedAt.clear();
          const cwdH = req.headers.get("x-aiti-cwd") || undefined;
          // 立即刷新：改 count/包含范围后马上按新参数重新提取并推送（不等下次语音/10min TTL）
          if (cwdH) { try { void asrPushHotwords(cwdH); } catch {} }
        }
        // 模型切换 → 需重启 8767 生效（模型在服务端加载）。异步触发 restart，不阻塞请求。
        // model.offline（2-pass 精修模型）变更 → 服务端模型变，重启 8767 生效
        // model.stream（前端引擎 SenseVoice/paraformer）变更 → 服务端 stream 固定 paraformer 不变，
        // 只重写配置持久化（asrWriteModelConfig），不重启；前端读 feature 自行切伪实时/WS。
        if (fid.startsWith("asr.model.")) {
          asrWriteModelConfig();
          // 模型是 builtin 概念：云引擎下只持久化配置，不重启 8767（也没必要拉起本地服务）
          if (fid === "asr.model.offline" && asrProviderId(asrReadModelConfig()) === "builtin") {
            try { void asrControlRestart(); } catch {}
          }
        }
        return json({ ok: true, featureId: fid });
      }

      // GET /asr/effective-hotwords → 当前 workspace 最终生效热词（合并后；读 8767 实际存储）
      if (p[0] === "asr" && p[1] === "effective-hotwords" && p.length === 2 && req.method === "GET") {
        const cwd = req.headers.get("x-aiti-cwd") || undefined;
        // 热词是 builtin 的模型级偏置；云引擎不支持（面板显示「当前引擎不支持热词」）
        const cfgH = asrReadModelConfig();
        if (asrProviderId(cfgH) !== "builtin") {
          return json({ ok: false, error: "当前引擎不支持热词（仅自建 8767 生效）", unsupported: true, provider: asrProviderId(cfgH) });
        }
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 3000);
          const res = await fetch(`${ASR_STREAM_BASE}/hotwords?ws=${encodeURIComponent(asrWsKey(cwd))}`, { signal: ctrl.signal });
          clearTimeout(to);
          const d = await res.json().catch(() => null);
          if (!res.ok || !d) return json({ ok: false, error: "服务未运行或不可达" }, 503);
          return json({ ok: true, ws: d.ws, count: Number(d.count ?? 0), words: d.words || [] });
        } catch (e) {
          return json({ ok: false, error: String((e as Error)?.message || e) }, 503);
        }
      }

      // ---------- 用户热词库（弹窗编辑/导入/导出；与自动收取词合并，用户词优先） ----------
      // GET /asr/user-hotwords → { ok, words }
      if (p[0] === "asr" && p[1] === "user-hotwords" && p.length === 2 && req.method === "GET") {
        const words = readUserHotwords();
        return json({ ok: true, words, max: USER_HOTWORDS_MAX });
      }
      // PUT /asr/user-hotwords { words: [...] } → 规范化保存 + 拉取缓存失效（下次 push 带新用户词）
      if (p[0] === "asr" && p[1] === "user-hotwords" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        const words = Array.isArray(body?.words) ? (body.words as unknown[]).map(String) : [];
        const saved = saveUserHotwords(words);
        return json({ ok: true, words: saved, count: saved.length });
      }

      // POST /asr/ensure → 探测 8767；不通则经 aiti-cmd 自动拉起（同进退：日志在 ⚡命令 面板）。
      // 客户端每次按下 🎤 时调用（异步不阻塞录音）；防重/熔断由服务端状态机保证。
      if (p[0] === "asr" && p[1] === "ensure" && p.length === 2 && req.method === "POST") {
        // cwd 走 POST body（不进 URL/access log；ws key 由其哈希派生）
        const body = await req.json().catch(() => null);
        const cwd = body && typeof body.cwd === "string" ? body.cwd : undefined;
        const st = await asrEnsure(req);
        if (st.running) void asrPushHotwords(cwd); // 服务在跑 → 顺便确保热词已下发（懒拉 + TTL）
        return json({ ok: true, ...st });
      }

      // ---------- 收藏联想 provider（静态优先，无静态命中 → aiFallback 走 AI 动态） ----------
      // 后端扩展点（仿 aiti-msg-smart 的 topic/registerRecognizer 注册模式）：
      //   扩展在 server 里 POST /api/extensions/aiti-ai-input/providers { id, path, label?, rank? }
      //   → 本扩展 /suggest 聚合时并行调它。内置 aiti-cmd（命令⚡，rank 0）+ aiti-prompts（📌，rank 1）。
      interface SuggestProvider { id: string; path: string; label: string; rank: number; }
      const providerStore = (globalThis as Record<string, unknown>).__aitiSuggestProviders as
        Map<string, SuggestProvider> | undefined;
      if (!providerStore) (globalThis as Record<string, unknown>).__aitiSuggestProviders = new Map();
      const providers = (globalThis as Record<string, unknown>).__aitiSuggestProviders as Map<string, SuggestProvider>;
      // 内置静态 provider（命令优先——有匹配就不走 AI）
      const builtin: Record<string, SuggestProvider> = {
        "aiti-cmd": { id: "aiti-cmd", path: "commands/suggest", label: "命令", rank: 0 },
        "aiti-prompts": { id: "aiti-prompts", path: "prompts/suggest", label: "Prompt", rank: 1 },
      };
      for (const [k, v] of Object.entries(builtin)) if (!providers.has(k)) providers.set(k, v);

      // 单 provider 拉取（限时 2s，失败/404 跳过）——server 端 fetch 需要绝对 URL：由 req.url 取 origin + basePath
      const reqUrl = new URL(req.url || "http://localhost", "http://localhost");
      const basePath = (reqUrl.pathname.match(/^(\/[^/]*)?\/api\/extensions\//) || [])[1] || "";
      const fetchProvider = async (prov: SuggestProvider, q: string, limit: number) => {
        const url = `${reqUrl.origin}${basePath}/api/extensions/${prov.id}/${prov.path}?q=${encodeURIComponent(q)}&limit=${limit}`;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2000);
          const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
          clearTimeout(timer);
          if (!res.ok) return [];
          const body = await res.json().catch(() => null);
          const rows = body && Array.isArray(body.results) ? body.results : [];
          return rows.map((r: any) => ({ ...r, provider: prov.id, providerLabel: prov.label, rank: prov.rank }));
        } catch { return []; }
      };

      // 聚合资源：进程内 handler（全局注册表，aiti-cmd/aiti-prompts 启动时注册）优先——零 HTTP 零自环
      const handlers = (globalThis as Record<string, unknown>).__aitiSuggestHandlers as
        Map<string, (q: string, limit: number) => Promise<unknown[]> | unknown[]> | undefined;
      const fromHandler = async (prov: SuggestProvider, q: string, limit: number): Promise<unknown[] | null> => {
        const h = handlers?.get(prov.id);
        if (!h) return null;
        try {
          const rows = await Promise.resolve(h(q, limit));
          return (Array.isArray(rows) ? rows : []).map((r: any) => ({ ...r, provider: prov.id, providerLabel: prov.label, rank: prov.rank }));
        } catch { return null; }
      };
      // ---------- 短输入严格过滤（suggest 降噪，2026-09） ----------
      // 问题：provider 匹配是 substring（name/cmd/text/tags 含查询即命中），1-2 个字符的
      // 英文/中文输入会命中大量长尾候选（正文随便含个 "re" 就弹），噪音远多于有用提示。
      // 规则：q 长度（trim 后）> 阈值（feature suggest.looseLen，默认 10；0=关闭严格过滤）
      //   → 宽松（现有匹配直接放行）；否则每条候选需同时满足：
      //   ① q 加权长度 ≥ 3（CJK/全角 1.5 计——英文 3 字符 / 中文 2 字起步，与 autocomplete.minChars 同口径）；
      //   ② 覆盖度：q 长度 ≥ 标题(name)与主内容(cmd/text)中较短者的 1/4，即 len(q)*4 ≥ min(name, content)——
      //      短词打不中长候选（长 prompt 正文含 "re" 不再弹）；标题短所以覆盖易达标（「重启服务」2 字即过）。
      // 只作用于 /suggest 聚合（输入弹提示场景）；L0 补全链路有自己的后缀前缀收敛，不受影响。
      const SUGGEST_MIN_WEIGHT = 3; // ①加权长度下限
      const SUGGEST_COVER_NUM = 4; // ②覆盖分母（1/4）
      const suggestStrictPass = (q: string, row: Record<string, unknown> | null): boolean => {
        const looseRaw = parseInt(String(featureGet("suggest.looseLen", "")), 10);
        const threshold = Number.isFinite(looseRaw) && looseRaw >= 0 ? looseRaw : 10;
        if (threshold <= 0 || q.length > threshold) return true; // 长输入/关闭严格过滤 → 现有匹配
        let weight = 0; // ①加权长度（同 acEffLen：CJK/全角 1.5、其他 1）
        const cjk = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3040-\u30FF\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/u;
        for (const ch of q) weight += cjk.test(ch) ? 1.5 : 1;
        if (weight < SUGGEST_MIN_WEIGHT) return false;
        if (!row) return false;
        const name = String(row.name ?? "").trim();
        const content = String(row.cmd ?? row.text ?? "").trim(); // 主内容：命令正文 / prompt 正文
        const base = Math.min(name.length || Infinity, content.length || Infinity);
        if (!Number.isFinite(base)) return false; // 只有 tags 命中（无标题无正文）→ 短输入不放行
        return q.length * SUGGEST_COVER_NUM >= base; // ②覆盖度：q 达标题/内容较短者的 1/4
      };

      // GET /suggest?q=<前缀>&limit=<n> → 静态 provider 聚合；无命中 → aiFallback
      // POST /suggest { q, limit? } —— q 走 body 不进 URL：nginx access_log 记录完整请求行，
      // GET ?q= 会把用户正在输入的词明文落日志；与 aiti-folder file-index（dd0ae6f）同款整改
      if (p[0] === "suggest" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const q = (body && typeof body.q === "string" ? body.q : "").trim();
        const limit = Math.min(Math.max(parseInt(String(body && body.limit), 10) || 8, 1), 20);
        if (!q) return json({ ok: true, results: [], aiFallback: false, note: "空查询不联想" });
        const per = Math.max(1, Math.ceil(limit / Math.max(providers.size, 1)));
        const provs = [...providers.values()].sort((a, b) => a.rank - b.rank);
        const batches = await Promise.all(provs.map(async (prov) =>
          (await fromHandler(prov, q, per)) ?? (await fetchProvider(prov, q, per))));
        // 短输入严格过滤（见上方 suggestStrictPass）：先过滤再排序/统计，避免空转
        const filtered = batches.flat().filter((r: any) => suggestStrictPass(q, r && typeof r === "object" ? r as Record<string, unknown> : null));
        const results = filtered.sort(
          (a, b) => (a.rank - b.rank) || ((b.useCount || 0) - (a.useCount || 0)) || ((b.runCount || 0) - (a.runCount || 0)));
        const staticHits = results.length;
        // 审计只留长度+哈希，不落原文（与「输入词不进日志」同一隐私口径）；审计流水→cache（可再生）。
        // 开页方案 §6：改异步落盘——原 appendFileSync 每请求同步写（审计文件已 ~8 万行，
        // 打字期高频联想会放大事件循环停顿）；写失败静默（审计可选）。
        void (async () => {
          try {
            const auditDir = join(dirname(configDir), "cache");
            await mkdir(auditDir, { recursive: true });
            await appendFile(join(auditDir, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), action: "suggest", qLen: q.length, qHash: createHash("sha256").update(q).digest("hex").slice(0, 12), staticHits, aiFallback: staticHits === 0 }) + "\n");
          } catch { /* 审计可选 */ }
        })();
        return json({ ok: true, q, results: results.slice(0, limit), staticHits, aiFallback: staticHits === 0 });
      }

      // GET /providers → 注册表
      if (p[0] === "providers" && p.length === 1 && req.method === "GET") {
        return json({ ok: true, providers: [...providers.values()].sort((a, b) => a.rank - b.rank) });
      }
      // POST /providers → 扩展注册自己的 suggest 端点（后端扩展点）
      if (p[0] === "providers" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.id || !body.path) return json({ ok: false, error: "需要 id + path" }, 400);
        providers.set(String(body.id), {
          id: String(body.id), path: String(body.path),
          label: body.label ? String(body.label) : String(body.id),
          rank: typeof body.rank === "number" ? body.rank : providers.size,
        });
        return json({ ok: true, provider: providers.get(String(body.id)) }, 201);
      }
      // DELETE /providers?id= → 注销
      if (p[0] === "providers" && p.length === 1 && req.method === "DELETE") {
        const id = String(ctx.searchParams.get("id") || "");
        return json({ ok: true, removed: providers.delete(id) });
      }

      return json({ ok: false, error: "not-found" }, 404);
    },

    // ---------- WebSocket 代理（实时流式 ASR） ----------
    // 浏览器连 /aiti-ai-input/asr/ws/stream → 本中间件 rewrite 到 ASR_STREAM_BASE/ws/stream。
    // 机制与 aiti-ui-env 的 VNC/RDP 一致：返回带 x-middleware-rewrite 头的空 Response，
    // Next 内部执行 rewrite，WS 升级走编译进 http-proxy 的 proxy.ws()（已实测）。
    async middleware(req) {
      try {
        const url = new URL(req.url || "http://localhost");
        const idx = url.pathname.indexOf(ASR_WS_MARKER);
        if (idx < 0) return { handled: false };
        // 非 builtin 引擎：没有本地 8767 可 rewrite（云引擎走 HTTP quick/asr2 链）
        const pidW = asrProviderId(asrReadModelConfig());
        if (pidW !== "builtin" && pidW !== "xfyun") return { handled: false };
        // 浏览器路径 /aiti-ai-input/asr/ws/<rest> → 上游 /ws/<rest>（如 stream）
        // xfyun 引擎：rewrite 到本地真流式桥（8768），由桥签名转发讯飞 WSS
        const rest = url.pathname.slice(idx + ASR_WS_MARKER.length);
        // xfyun 引擎 → 真流式桥（端口随机，ensure 返回实际端口）；其余（builtin）→ 8767
        let target = `${ASR_STREAM_BASE}/ws/${rest}${url.search}`;
        if (pidW === "xfyun") {
          const br = await ensureXfBridge({ port: XF_BRIDGE_PORT, configPath: asrConfigPath() });
          if (!br.ok) return { handled: false };
          target = `http://127.0.0.1:${br.port}/ws/${rest}${url.search}`;
        }
        return { handled: true, response: new Response(null, { headers: { "x-middleware-rewrite": target } }) };
      } catch (e) {
        return { handled: false };
      }
    },
  },
};