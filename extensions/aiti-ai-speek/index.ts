/**
 * aiti-ai-speek —— pi-web「跟读模式」扩展（AI 输出语音朗读）
 *
 * 一句话：用户不方便看屏幕时，开启「跟读模式」让 pi-web 把 AI 的主要输出
 * 顺序朗读出来——可切音色、可暂停/跳过/停止、刷屏不慌。
 *
 * 架构（前端为主，后端极薄）：
 *   - agent.onAgentSettled：agent 一轮执行完 → 把最终回答文本广播给订阅该会话的
 *     SSE 客户端（浏览器）。这正是「消息完成才进队列」的信号源，比前端解析
 *     message_update 流式增量可靠得多。
 *   - GET /events?session=<sid>：SSE 流。客户端跟读开启时订阅；连接时先补发该会话
 *     最近若干条已完成的回答（ring buffer），开启跟读即读到当前屏上的回复。
 *   - POST /steer：开启跟读时向会话注入「朗读模式提示词」（可选，feature 门控）。
 *   - GET /tts + GET /voices: two server-side quality tiers (feature gated):
 *     edge-tts (CLI) and the local engine (OpenAI-compatible /v1/audio/speech, providers such as
 *     Hojo-TTS-Light; selecting it bootstraps venv/deps/model automatically and the service
 *     exits after an idle timeout).
 *
 * Reuse principle: cleaning/segmenting/playback stay in the frontend (client/src/toSpeechText.ts);
 * the backend never interprets messages. edge-tts reuses the same CLI approach + SHA-256 cache;
 * the local engine = server/tts-service/ (Python, swappable provider) + extension-side proxy/cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { filterByMode, flagMessage } from "./server/speech-filter.ts";
import { ttsCacheDir, cleanExpired, lruEvict, cacheStats, findCacheFile, contentTypeOf } from "./server/tts-cache.ts";
import { synthesizeLocal, probeLocal, LocalTtsError } from "./server/tts-local.ts";
import {
  localPaths, readPrepare, readRuntime, readReady, startService, stopService, tailLog,
  dirBytes, readVoiceEntries, saveVoice, deleteVoiceEntry, slugifyVoice, SERVICE_DIR,
} from "./server/tts-local-service.ts";

/** statSync 的容错包装（文件不存在/竞态删 → 返回 null） */
function statSyncSafe(p: string) { try { return statSync(p); } catch { return null; } }

// ── 每会话 steer 函数（onAgentSession 捕获；POST /steer 时注入）──────────────
const steerFns = new Map<string, (text: string) => Promise<void>>();
// 已注入记录：内存 Set + 持久化文件（跨 pi-web 重启保留）；防止朗读提示词重复注入。
const injectedSessions = new Set<string>();
const STEER_RECORD_FILE = "steer-injected.json";
/** configDir 兜底（ctx.configDir 缺席时）：PI_WEB_DATA_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/web/data 原行为 */
function fallbackDataDir(): string {
  return join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-ai-speek", "config");
}
function steerRecordPath(configDir?: string) {
  return join(configDir || fallbackDataDir(), STEER_RECORD_FILE);
}
function readSteerRecord(configDir?: string): Record<string, number> {
  try {
    const p = steerRecordPath(configDir);
    if (existsSync(p)) {
      const obj = JSON.parse(readFileSync(p, "utf8"));
      if (obj && typeof obj === "object") return obj;
    }
  } catch { /* 损坏回落空 */ }
  return {};
}
function writeSteerRecord(configDir: string | undefined, rec: Record<string, number>): void {
  try {
    const p = steerRecordPath(configDir);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(rec));
  } catch { /* 写失败不阻塞 */ }
}
function markSteerInjected(configDir: string | undefined, sessionId: string): void {
  injectedSessions.add(sessionId);
  try {
    const rec = readSteerRecord(configDir);
    rec[sessionId] = Date.now();
    writeSteerRecord(configDir, rec);
  } catch { /* 持久化失败忽略 */ }
}

// ── 朗读过程收集（feature process.enabled）：订阅 message_end 来收集本轮
//    assistant 消息的 text 块（过程叙述 + 最终汇总），跳过 thinking / toolCall ──
//    按 sessionId 分桶；agent_start 重置，onAgentSettled 结算后清。
const turnTextBySession = new Map<string, string>();

// ── SSE 广播（按 sessionId 分桶）────────────────────────────────────────────
const sseBySession = new Map<string, Set<(frame: string) => void>>();

// ── 幽灵连接防护（2026-09-05）────────────────────────────────────────────
// 扩展服务端 reload/重启会重建 sseBySession（变空），但已连接的客户端 EventSource
// 连接（底层 HTTP 流）仍然存活——客户端 ES 收不到广播却自以为连着（不报错、不重连），
// 消息列表从此永不自动刷新（只能靠刷新页面重新订阅）。
// 解决：活跃 SSE 流 controller 挂 globalThis；模块每次加载（含 reload）先主动 error()
// 掉旧流 → 客户端 EventSource 收到错误 → 原生自动重连 → 重新订阅 + onopen 全量对账刷新。
// 事件驱动、零轮询（服务端本就用 20s ping 保活传输，这是同等的断连自愈）。
const G_SSE = "__aitiSpeekSseStreams";
function killStaleSseStreams() {
  const g = globalThis as { [G_SSE]?: Set<ReadableStreamDefaultController<Uint8Array>> };
  const old = g[G_SSE];
  if (old) {
    for (const c of old) { try { c.error(new Error("extension reload")); } catch { /* 已断开 */ } }
    old.clear();
  }
  g[G_SSE] = new Set();
}
killStaleSseStreams();
/** 每会话最近已完成回答（连接时补发；容量 RECENT_MAX） */
const recentBySession = new Map<string, { text: string; ts: number }[]>();
const RECENT_MAX = 5;
const pings: ReturnType<typeof setInterval>[] = [];

// ── 朗读模式提示词（PLAN §7 设计稿）──────────────────────────────────────────
const READING_PROMPT = [
  "【朗读模式提示】用户正在听语音朗读你的回复。请按以下方式输出，方便朗读：",
  "1. 开头先用一两句话给出核心结论/总结；",
  "2. 需要展示表格、代码或复杂结构时，务必先加一句口语化说明概要（表格：\"下面是一张对比表，主要对比A和B，结论是…\"；代码：\"这是一段实现xx功能的代码\"）；",
  "3. 需要用户回答时，把问题明确放在回复末尾（如\"…您觉得呢？\"）；",
  "4. 优先短句、口语化，避免超长嵌套句。",
].join("\n");

// ── edge-tts 后端（feature tts.edge 门控；feature tts.edge.bin 可指定可执行路径）────
// 音色表不写死：从 edge-tts --list-voices 动态读取（按表头列边界解析），自动跟上音色增/下架
//（如 zh-CN-YunfengNeural 已下架——若写死会在列表里读到但合成必报错）。
const VOICE_CN: Record<string, string> = {
  Xiaoxiao: "晓晓", Xiaoyi: "晓伊", Yunjian: "云健", Yunxi: "云希",
  Yunxia: "云夏", Yunyang: "云扬", Xiaobei: "晓北（东北）", Xiaoni: "晓妮（陕西）",
};
const STYLE_CN: Record<string, string> = {
  Warm: "温和", Lively: "活泼", Sunshine: "阳光", Passion: "激情", Cute: "可爱",
  Professional: "专业", Reliable: "可靠", Humorous: "幽默", Bright: "明亮",
  Friendly: "友好", Positive: "积极", News: "新闻", Novel: "小说", Cartoon: "卡通",
  Dialect: "方言", Sports: "体育", General: "通用",
};
let edgeVoicesCache: { at: number; items: { id: string; label: string; sample: string }[] | null } = { at: 0, items: null };
/** 解析 --list-voices 输出（同步/异步路径共用）：按表头列边界定位（不写死宽度），只保留 zh-CN */
function parseVoicesOutput(out: string): { id: string; label: string; sample: string }[] {
  const lines = out.split(/\r?\n/);
  if (!lines.length) return [];
  // 表头列边界（按空白分词定位每列起点）
  const hdr = lines[0];
  const cols: { name: string; s: number; e: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hdr)) !== null) cols.push({ name: m[0], s: m.index, e: m.index + m[0].length });
  if (!cols.length) return [];
  const items: { id: string; label: string; sample: string }[] = [];
  for (const ln of lines.slice(2)) {
    if (!ln.trim() || /^-+\s*$/.test(ln.trim())) continue;
    const rec: Record<string, string> = {};
    for (let i = 0; i < cols.length; i++) {
      const nxt = cols[i + 1] ? cols[i + 1].s : ln.length;
      rec[cols[i].name] = ln.slice(cols[i].s, nxt).trim();
    }
    const id = rec.Name || "";
    if (!id.startsWith("zh-CN")) continue;
    const gender = rec.Gender === "Male" ? "男" : "女";
    const personalities = (rec.VoicePersonalities || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const styles = personalities.map((p) => STYLE_CN[p] || p).join("/") || "";
    const short = id.replace(/^zh-CN-/, "").replace(/Neural$/, "");
    const cnRaw = short.split("-").pop() || short;
    const cn = VOICE_CN[cnRaw] || cnRaw;
    const cnPure = cn.replace(/[（(].*?[)）]/g, ""); // 方言标注（东北）等去括号，试听/朗读更自然
    items.push({
      id,
      label: `${cn} · ${gender}${styles ? "（" + styles + "）" : ""}`,
      sample: `我是${cnPure}，很高兴为你朗读，期待为你服务。`,
    });
  }
  // 稳定排序：默认音色（晓晓）优先，其余按 id
  items.sort((a, b) => (a.id === "zh-CN-XiaoxiaoNeural" ? -1 : b.id === "zh-CN-XiaoxiaoNeural" ? 1 : a.id.localeCompare(b.id)));
  return items;
}

/** 音色表缓存 TTL（2026-09-13 性能修复：5min → 30min，降低冷探测频率） */
const VOICES_TTL_MS = 30 * 60 * 1000;

/**
 * 同步版音色表（2026-09-12 execSync→async 改造）：纯缓存读——冷缓存返回 []，绝不同步 spawn
 * （--list-voices 8s 曾冻结主线程）。探测统一走 voicesPayloadAsync（结果写回本缓存）。
 */
function listEdgeVoices(_force = false): { id: string; label: string; sample: string }[] {
  if (edgeVoicesCache.items && Date.now() - edgeVoicesCache.at < VOICES_TTL_MS) return edgeVoicesCache.items;
  return edgeVoicesCache.items || [];
}

/** 异步 execFile（Promise 化；/voices 冷路径用，避免 execFileSync 冻结主线程）。 */
function execFileP(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ""))));
  });
}

/**
 * GET /voices 的全异步探测（性能修复 2026-09-13）：
 * 原实现一次请求内链式调用 edgeInstalled/listEdgeVoices/edgeVersion/defaultEdgeVoice，
 * 冷缓存时以 execFileSync 同步 spawn（which 3s + --list-voices 8s + --version 5s），
 * 页面加载必打 /voices——实测同步阻塞 1.27s，冻结整个 pi-web 主线程。
 * 现将探测全部改 execFile 异步（结果写回同一批缓存，同步调用点后续零 spawn）。
 */
async function voicesPayloadAsync(force: boolean): Promise<Record<string, unknown>> {
  // ① which 定位（冷缓存或 force）
  if (force || edgeWhichCache === undefined || Date.now() - edgeWhichAt > 30_000) {
    try {
      const out = await execFileP(process.platform === "win32" ? "where" : "which", ["edge-tts"], 3000);
      edgeWhichCache = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
    } catch { edgeWhichCache = null; }
    edgeWhichAt = Date.now();
  }
  const installed = !!resolveEdgeBin(force);
  // ② 音色表（冷缓存或 force）
  let voices: { id: string; label: string; sample: string }[] = [];
  if (installed) {
    const bin = resolveEdgeBin(force)!;
    if (force || !edgeVoicesCache.items || Date.now() - edgeVoicesCache.at > VOICES_TTL_MS) {
      try {
        const out = await execFileP(bin, ["--list-voices"], 8000);
        edgeVoicesCache = { at: Date.now(), items: parseVoicesOutput(out) };
      } catch { edgeVoicesCache = { at: Date.now(), items: edgeVoicesCache.items }; }
    }
    voices = edgeVoicesCache.items || [];
  }
  // ③ version（冷缓存或 force）
  let version: string | null = null;
  if (installed) {
    if (force || edgeVerCache.v === null || Date.now() - edgeVerCache.at > 60_000) {
      try {
        const out = await execFileP(resolveEdgeBin(force)!, ["--version"], 5000);
        const mv = /edge-tts\s+v?([\d.]+)/i.exec(out);
        edgeVerCache = { v: mv ? mv[1] : (out.trim().slice(0, 40) || null), at: Date.now() };
      } catch { edgeVerCache = { v: edgeVerCache.v, at: Date.now() }; }
    }
    version = edgeVerCache.v;
  }
  const defaultVoice = installed
    ? (voices.find((v) => v.id === "zh-CN-XiaoxiaoNeural")?.id || voices[0]?.id || "zh-CN-XiaoxiaoNeural")
    : null;
  const binPath = installed ? resolveEdgeBin(force) : null;
  return {
    ok: true,
    voices,
    installed,
    edgeAvailable: installed,
    bin: binPath,
    version,
    platform: process.platform,
    featureOn: featureEnabled("aiti-ai-speek", "tts.edge"),
    edgeBin: featureValue("aiti-ai-speek", "tts.edge.bin"),
    defaultVoice,
    installHint: installed
      ? ("已安装" + (version ? " · edge-tts v" + version : " · edge-tts") + (binPath ? " · " + binPath : ""))
      : installHintText(false),
  };
}
/** 默认音色：晓晓存在则用它，否则列表第一个（前端默认选项/服务端合成兜底共用） */
function defaultEdgeVoice(): string {
  const items = listEdgeVoices();
  const hit = items.find((v) => v.id === "zh-CN-XiaoxiaoNeural");
  return hit ? hit.id : (items[0]?.id || "zh-CN-XiaoxiaoNeural");
}

// edge-tts 可执行文件定位（跨平台：feature 指定 → env AITI_EDGE_TTS_BIN → PATH/where → 常见用户路径 ~/.local/bin 兜底 → pipx venvs）
// （~/.local/bin 在 Windows 不存在，故 PATH 查找先于固定路径；AITI_EDGE_TTS_BIN 供 Docker/Windows 部署显式指向）
let edgeWhichCache: string | null | undefined;
let edgeWhichAt = 0;
/**
 * PATH 定位（2026-09-12 execSync→async 改造）：纯缓存读——冷缓存返回 null，绝不同步 spawn
 * （which 3s 曾冻结主线程）。which 探测统一走 voicesPayloadAsync（结果写回本缓存）。
 */
function findOnPath(_force = false): string | null {
  if (edgeWhichCache !== undefined && Date.now() - edgeWhichAt < 30000) return edgeWhichCache;
  return null; // 冷缓存：交由 resolveEdgeBin 的纯 fs 兜底路径（~/.local/bin、pipx）判定
}
function resolveEdgeBin(force = false): string | null {
  const cfg = featureValue("aiti-ai-speek", "tts.edge.bin").trim();
  if (cfg) { try { if (existsSync(cfg)) return cfg; } catch { /* 非法路径忽略 */ } }
  const envBin = (process.env.AITI_EDGE_TTS_BIN || "").trim();
  if (envBin) { try { if (existsSync(envBin)) return envBin; } catch { /* 非法路径忽略 */ } }
  const onPath = findOnPath(force);
  if (onPath) return onPath;
  const home = homedir();
  for (const p of [join(home, ".local", "bin", "edge-tts"), join(home, ".local", "bin", "edge-tts.exe")]) {
    if (existsSync(p)) return p;
  }
  if (process.platform !== "win32") {
    const pipx = join(home, ".local", "pipx", "venvs", "edge-tts", "bin", "edge-tts");
    if (existsSync(pipx)) return pipx;
  }
  return null;
}
function edgeInstalled(force = false): boolean { return !!resolveEdgeBin(force); }
let edgeVerCache: { v: string | null; at: number } = { v: null, at: 0 };
/**
 * 版本探测（2026-09-12 execSync→async 改造）：纯缓存读——冷缓存返回 null，绝不同步 spawn
 * （--version 5s 曾冻结主线程）。探测统一走 voicesPayloadAsync（结果写回本缓存）。
 */
function edgeVersion(_force = false): string | null {
  if (edgeVerCache.v !== null && Date.now() - edgeVerCache.at < 60000) return edgeVerCache.v;
  return null;
}

// 安装提示（设置面板展示；各平台简要命令）
function installHintText(installed: boolean): string {
  if (installed) {
    const bin = resolveEdgeBin();
    const v = edgeVersion();
    return "已安装" + (v ? " · edge-tts v" + v : " · edge-tts") + (bin ? " · " + bin : "");
  }
  const p = process.platform;
  if (p === "win32") return "未安装 · PowerShell：pip install edge-tts（或 pipx install edge-tts）";
  if (p === "darwin") return "未安装 · brew install edge-tts（或 pipx install edge-tts）";
  return "未安装 · pipx install edge-tts（或 pip install --user edge-tts / uv tool install edge-tts）";
}

// 自动启用 edge 引擎（仅一次：edge-tts 已装 → tts.edge feature 自动开；用户此后关掉不会被覆盖）
const EDGE_AUTO_STATE = "edge-auto-enabled.json";
function edgeAutoStatePath(configDir?: string): string {
  return join(configDir || fallbackDataDir(), EDGE_AUTO_STATE);
}
function autoEnableEdge(configDir?: string): void {
  if (!edgeInstalled() || featureEnabled("aiti-ai-speek", "tts.edge")) return;
  try {
    const p = edgeAutoStatePath(configDir);
    if (existsSync(p)) { const o = JSON.parse(readFileSync(p, "utf8")); if (o?.autoEnabled) return; }
    const reg = (globalThis as Record<string, unknown>).__piWebExt as
      { setFeatureFlag?: (extId: string, fid: string, enabled: boolean) => void } | undefined;
    if (!reg?.setFeatureFlag) return;
    reg.setFeatureFlag("aiti-ai-speek", "tts.edge", true);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ autoEnabled: true, at: Date.now() }));
  } catch { /* 失败不阻塞 */ }
}


/** 页面可见块序号（对齐 ChatWindow 渲染：锚行 + 折叠组块(1) + 正文块(1)）；idx=-1 返回总数 */
function pageRankOf(sess: { messages?: Array<{ role?: string; content?: unknown; customType?: string }> }, idx: number): number {
  const msgs = sess?.messages || [];
  let rank = 0;
  let groupCounted = false;
  let target = -1;
  for (let i = 0; i <= (idx < 0 ? msgs.length - 1 : idx); i++) {
    const m = msgs[i];
    if (!m || (m.role !== "assistant" && m.role !== "user" && m.role !== "custom")) continue;
    if (m.role === "user" || (m.role === "custom" && m.customType === "compaction")) { rank++; groupCounted = false; continue; }
    if (m.role !== "assistant") continue;
    const c = m.content;
    const hasText = typeof c === "string"
      ? (c as string).trim().length > 0
      : Array.isArray(c) ? c.some((b) => b && b.type === "text" && typeof (b as { text?: unknown }).text === "string" && ((b as { text: string }).text || "").trim().length > 0) : false;
    if (hasText) { rank++; groupCounted = false; }
    else if (!groupCounted) { rank++; groupCounted = true; } // process 条（工具/思考）→ 折叠组块只计一次
    if (i === idx) target = rank;
  }
  return idx < 0 ? rank : target;
}

let hostFeatures: any = null; // DI 方案 P1：startup 捕获 ctx.features
function featureEnabled(extId: string, fid: string): boolean {
  try {
    const v = hostFeatures?.get?.(extId, fid);
    if (typeof v === "boolean") return v;
    const reg = (globalThis as Record<string, unknown>).__piWebExt as
      { featureEnabled?: (extId: string, fid: string) => boolean } | undefined;
    return reg?.featureEnabled ? !!reg.featureEnabled(extId, fid) : true;
  } catch { return true; }
}
function featureValue(extId: string, fid: string): string {
  try {
    const v = hostFeatures?.get?.(extId, fid);
    if (typeof v === "string") return v;
    const reg = (globalThis as Record<string, unknown>).__piWebExt as
      { featureValue?: (extId: string, fid: string) => boolean | string } | undefined;
    const v2 = reg?.featureValue ? reg.featureValue(extId, fid) : "";
    return typeof v2 === "string" ? v2 : "";
  } catch { return ""; }
}

// ── local TTS engine (OpenAI-compatible service; feature tts.local) ──────────
// One shell (this extension) + a swappable provider (hojo-40m / hojo-80m / qwen3-* / stub) behind
// `/v1/audio/speech`. The browser only sees "engine=local": synthesis, cache key and voice list
// are provided by the Python service, the panel shows its preparation phases.
interface LocalCfg {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  voice: string;
  format: string;
  sampleRate: number;
  apiKey: string;
  autoStart: boolean;
  idleTimeout: number;
  hfEndpoint: string;
  threads: number;
}
function localCfg(): LocalCfg {
  return {
    enabled: featureEnabled("aiti-ai-speek", "tts.local"),
    provider: featureValue("aiti-ai-speek", "tts.local.provider").trim() || "hojo-40m",
    baseUrl: featureValue("aiti-ai-speek", "tts.local.baseUrl").trim(),
    model: featureValue("aiti-ai-speek", "tts.local.model").trim(),
    voice: featureValue("aiti-ai-speek", "tts.local.voice").trim(),
    format: featureValue("aiti-ai-speek", "tts.local.format").trim() || "pcm",
    sampleRate: parseInt(featureValue("aiti-ai-speek", "tts.local.sampleRate"), 10) || 24000,
    apiKey: featureValue("aiti-ai-speek", "tts.local.apiKey").trim(),
    autoStart: featureEnabled("aiti-ai-speek", "tts.local.autoStart"),
    idleTimeout: parseInt(featureValue("aiti-ai-speek", "tts.local.idleTimeout"), 10) || 1800,
    hfEndpoint: featureValue("aiti-ai-speek", "tts.local.hfEndpoint").trim(),
    threads: parseInt(featureValue("aiti-ai-speek", "tts.local.threads"), 10) || 0,
  };
}
interface ApiCtxLike {
  method: string;
  path: string[];
  searchParams: URLSearchParams;
  configDir?: string;
  cacheDir?: string;
  stateDir?: string;
  core?: { readSession?: (id: string) => Promise<{ messages?: Array<{ role?: string; content?: unknown }> } | null> };
  services?: { get?: (name: string) => unknown };
}
type TtsDirs = Pick<ApiCtxLike, "configDir" | "cacheDir" | "stateDir">;
function ttsPaths(ctx: TtsDirs) {
  return localPaths({ configDir: ctx.configDir, cacheDir: ctx.cacheDir, stateDir: ctx.stateDir });
}
// ── cross-extension backend service (`aiti-ai-speek.tts`) ────────────────────
// Other extensions (e.g. aiti-video-studio) need the local TTS engine without going through the
// panel: ensure/status/stop/restart/synthesize. The sound itself is played by the browser, which
// is what the *client* service `aiti-ai-speek.speak` is for.
let svcState: { dirs: TtsDirs; services?: ApiCtxLike["services"] } = { dirs: {} };
/** Context-shaped object for the shared helpers (dirs always, services when the host provides them). */
function svcCtx() {
  return { ...svcState.dirs, services: svcState.services };
}
/** Build the backend service object handed to ctx.services.provide(). */
function buildTtsService() {
  const dirs = () => svcState.dirs;
  return {
    version: 1,
    /** Probe/launch the local service (bootstrap included). `starting` means "come back later". */
    ensure: async (opts?: { provider?: string }) => {
      const st = await localEnsure(svcCtx(), opts?.provider);
      return { ...st, baseUrl: st.baseUrl };
    },
    status: async () => {
      const paths = ttsPaths(dirs());
      const cfg = localCfg();
      const health = await localHealth(paths, cfg);
      return {
        running: !!health?.ok,
        status: health?.status || "stopped",
        provider: health?.provider || cfg.provider,
        providerLabel: health?.providerLabel || null,
        baseUrl: localBaseUrl(paths, cfg),
        prepare: readPrepare(paths),
        voices: (health?.voiceCount as number) || 0,
      };
    },
    stop: () => stopService(ttsPaths(dirs())),
    restart: async (opts?: { provider?: string }) => {
      await stopService(ttsPaths(dirs()));
      await new Promise((r) => setTimeout(r, 800));
      localStart = { status: "idle", at: 0 };
      localProbeCache = { at: 0, baseUrl: "", health: null };
      const st = await localEnsure(svcCtx(), opts?.provider);
      return { ...st };
    },
    /** Synthesize into the extension cache; returns per-item cache keys (serve via /tts-cache/<key>). */
    synthesize: async (opts: { texts: string[]; voice?: string }) => {
      const texts = (opts?.texts || []).map((t) => String(t || "").trim()).filter(Boolean);
      if (!texts.length) return { ok: false, code: "bad-input", error: "need texts", items: [] as unknown[] };
      return localSynthesizeBatch(dirs(), texts, opts?.voice);
    },
    voices: async () => localVoices(ttsPaths(dirs()), localCfg(), true),
    /** Read a synthesized file straight from the cache (no HTTP auth hop for backend consumers). */
    readCached: async (key: string) => {
      const k = String(key || "");
      if (!/^[a-f0-9]{64}$/.test(k)) return null;
      const hit = findCacheFile(ttsCacheDir(svcState.dirs.configDir), k);
      if (!hit) return null;
      try {
        return { buffer: readFileSync(hit.file), ext: hit.ext, contentType: contentTypeOf(hit.ext) };
      } catch {
        return null;
      }
    },
    baseUrl: () => localBaseUrl(ttsPaths(dirs()), localCfg()),
    /** Where a consumer should point the user when the service cannot start. */
    panel: { extId: "aiti-ai-speek", dialog: "settings", localFeature: "tts.local" },
  };
}

/** Persist a feature value through the host registry (same store the panel writes). */
function setFeatureValueSafe(id: string, value: string): void {
  try {
    const reg = (globalThis as Record<string, unknown>).__piWebExt as
      { setFeatureValue?: (extId: string, fid: string, value: boolean | string) => void } | undefined;
    reg?.setFeatureValue?.("aiti-ai-speek", id, value);
  } catch { /* non-blocking */ }
}
/** Effective base URL: explicit feature value, else the port recorded by the last start (8768 default). */
function localBaseUrl(paths: ReturnType<typeof ttsPaths>, cfg: LocalCfg): string {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/+$/, "");
  const rt = readRuntime(paths);
  const port = Number(rt?.port) || 8768;
  return `http://127.0.0.1:${port}`;
}
interface LocalHealth {
  ok?: boolean; status?: string; provider?: string; providerLabel?: string; model?: string;
  model_loaded?: boolean; sample_rate?: number; supportsClone?: boolean; voiceCount?: number;
  idleTimeout?: number; rssMb?: number | null; rtfLast?: number | null; port?: number; pid?: number;
  error?: string | null; uptime?: number;
}
// Short-lived probe cache: the panel/player ask several times in a burst, the service state cannot
// change meaningfully inside this window. Never a timer — always request-driven.
let localProbeCache: { at: number; baseUrl: string; health: LocalHealth | null } = { at: 0, baseUrl: "", health: null };
async function localHealth(paths: ReturnType<typeof ttsPaths>, cfg: LocalCfg, force = false): Promise<LocalHealth | null> {
  const baseUrl = localBaseUrl(paths, cfg);
  const now = Date.now();
  if (!force && localProbeCache.baseUrl === baseUrl && now - localProbeCache.at < 10000) return localProbeCache.health;
  const health = await probeLocal(baseUrl);
  localProbeCache = { at: now, baseUrl, health };
  return health;
}
let localVoicesCache: { at: number; baseUrl: string; data: { voices?: Array<{ id: string; label: string; sample?: string; builtin?: boolean; provider?: string; language?: string }>; provider?: string; providerLabel?: string; supportsClone?: boolean } | null } = { at: 0, baseUrl: "", data: null };
async function localVoices(paths: ReturnType<typeof ttsPaths>, cfg: LocalCfg, force = false) {
  const baseUrl = localBaseUrl(paths, cfg);
  const now = Date.now();
  if (!force && localVoicesCache.baseUrl === baseUrl && now - localVoicesCache.at < 60000) return localVoicesCache.data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(baseUrl + "/voices", { signal: ctrl.signal });
    clearTimeout(timer);
    const data = res.ok ? await res.json().catch(() => null) : null;
    localVoicesCache = { at: now, baseUrl, data };
    return data;
  } catch {
    localVoicesCache = { at: now, baseUrl, data: null };
    return null;
  }
}
/** Resolve the voice to synthesize with: explicit request > feature > first service voice. */
async function localResolveVoice(paths: ReturnType<typeof ttsPaths>, cfg: LocalCfg, requested?: string): Promise<string> {
  const wanted = (requested || cfg.voice || "").trim();
  if (wanted) return wanted;
  const data = await localVoices(paths, cfg);
  return String(data?.voices?.[0]?.id || "");
}

// Start state machine (in-process; dev and prod instances are independent)
let localStart: { status: "idle" | "starting" | "failed"; at: number; sessionId?: string; error?: string } = { status: "idle", at: 0 };
let localStartInFlight = false;
const LOCAL_START_TTL_MS = 20 * 60_000; // first run downloads venv + model; do not give up early
const LOCAL_START_COOLDOWN_MS = 60_000;

async function localLaunch(ctx: TtsDirs & Pick<ApiCtxLike, "services">, provider: string, prepping = false): Promise<{ ok: boolean; sessionId?: string; mode?: string; error?: string }> {
  const paths = ttsPaths(ctx);
  const cfg = localCfg();
  const runner = (ctx.services?.get?.("aiti-cmd.runner") || undefined) as { run?: (o: Record<string, unknown>) => unknown } | undefined;
  const r = await startService({
    paths,
    provider,
    port: Number(readRuntime(paths)?.port) || 8768,
    idleTimeout: cfg.idleTimeout,
    hfEndpoint: cfg.hfEndpoint,
    runner,
  });
  if (r.ok) {
    localStart = { status: "starting", at: Date.now(), sessionId: r.sessionId };
    localProbeCache = { at: 0, baseUrl: "", health: null };
  } else {
    localStart = { status: "failed", at: Date.now(), error: r.error };
  }
  if (prepping) console.log("[aiti-ai-speek] local TTS launch", { provider, mode: r.mode, ok: r.ok, err: r.error });
  return r;
}

/** Probe -> ready | starting (launch) | stopped. Never blocks for the whole bootstrap. */
async function localEnsure(ctx: TtsDirs & Pick<ApiCtxLike, "services">, providerHint?: string) {
  const paths = ttsPaths(ctx);
  const cfg = localCfg();
  const provider = (providerHint || cfg.provider || "hojo-40m").trim();
  const health = await localHealth(paths, cfg, true);
  if (health?.ok) {
    localStart = { status: "idle", at: Date.now() };
    return { running: true, starting: false, health, baseUrl: localBaseUrl(paths, cfg), prepare: readPrepare(paths), provider: health.provider };
  }
  if (health && (health.status === "loading" || health.status === "starting")) {
    return { running: false, starting: true, health, baseUrl: localBaseUrl(paths, cfg), prepare: readPrepare(paths), provider: health.provider };
  }
  // Process alive but the model failed to load: `start` would consider the port healthy and skip,
  // so an ensure must restart it (the panel's explicit restart does the same thing).
  if (health && health.status === "error") {
    if (localStartInFlight) return { running: false, starting: true, prepare: readPrepare(paths), baseUrl: localBaseUrl(paths, cfg), provider };
    localStartInFlight = true;
    try {
      await stopService(paths);
      await new Promise((r) => setTimeout(r, 800));
      const r = await localLaunch(ctx, provider, true);
      localProbeCache = { at: 0, baseUrl: "", health: null };
      return { running: false, starting: !!r.ok, sessionId: r.sessionId, error: r.ok ? undefined : r.error, prepare: readPrepare(paths), baseUrl: localBaseUrl(paths, cfg), provider };
    } finally {
      localStartInFlight = false;
    }
  }
  const now = Date.now();
  if (localStart.status === "starting" && now - localStart.at < LOCAL_START_TTL_MS) {
    // A bootstrap we launched may have already failed: report it instead of "starting" for 20min.
    const prep = readPrepare(paths);
    if (String(prep?.phase || "") === "failed") {
      localStart = { status: "failed", at: now, error: prep?.message };
      return { running: false, starting: false, error: prep?.message, prepare: prep, baseUrl: localBaseUrl(paths, cfg), provider };
    }
    return { running: false, starting: true, sessionId: localStart.sessionId, prepare: prep, baseUrl: localBaseUrl(paths, cfg), provider };
  }
  if (localStart.status === "failed" && now - localStart.at < LOCAL_START_COOLDOWN_MS) {
    return { running: false, starting: false, error: localStart.error, prepare: readPrepare(paths), baseUrl: localBaseUrl(paths, cfg), provider };
  }
  if (localStartInFlight) {
    return { running: false, starting: true, prepare: readPrepare(paths), baseUrl: localBaseUrl(paths, cfg), provider };
  }
  localStartInFlight = true;
  let launch: { ok: boolean; sessionId?: string; mode?: string; error?: string };
  try {
    launch = await localLaunch(ctx, provider, true);
  } finally {
    localStartInFlight = false;
  }
  // Fast path: already bootstrapped -> the service usually answers within a few seconds.
  // Cold bootstrap (venv/deps/download) can take minutes: return "starting" right away and let
  // /tts/progress drive the panel instead of holding the request open.
  if (launch.ok) {
    const prep = readPrepare(paths);
    const phase = String(prep?.phase || "");
    const coldStart = ["venv", "deps", "download"].includes(phase);
    for (let i = 0; i < (coldStart ? 0 : 10); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await localHealth(paths, cfg, true);
      if (h?.ok) return { running: true, starting: false, health: h, baseUrl: localBaseUrl(paths, cfg), prepare: readPrepare(paths), provider: h.provider };
    }
  }
  return {
    running: false,
    starting: launch.ok,
    sessionId: launch.sessionId,
    error: launch.ok ? undefined : launch.error,
    mode: launch.mode,
    prepare: readPrepare(paths),
    baseUrl: localBaseUrl(paths, cfg),
    provider,
  };
}

interface LocalItem { text: string; key: string; cached: boolean; ext?: string; speakable: boolean; code?: string; retryable?: boolean; error?: string; degraded?: boolean }

/** Synthesize a batch through the local service (serial: local inference is CPU bound). */
async function localSynthesizeBatch(ctx: TtsDirs, texts: string[], voiceIn?: string): Promise<{
  ok: boolean; engine: "local"; voice: string; provider: string; items: LocalItem[]; error?: string; code?: string;
}> {
  const paths = ttsPaths(ctx);
  const cfg = localCfg();
  const baseUrl = localBaseUrl(paths, cfg);
  const cacheDir = ttsCacheDir(ctx.configDir);
  mkdirSync(cacheDir, { recursive: true });
  // The running service wins over the feature value: the cache key must describe the audio
  // that was actually produced (a provider can be started with an explicit override).
  const health = await localHealth(paths, cfg);
  const providerId = String(health?.provider || cfg.provider);
  const voice = await localResolveVoice(paths, cfg, voiceIn);
  if (!voice) {
    // A provider without voices is NOT "starting": hojo-80m has no built-ins, so cloning is a
    // prerequisite. Report it separately so the UI can guide the user instead of waiting.
    const ready = !!health?.ok;
    return {
      ok: false, engine: "local", voice: "", provider: providerId, items: [],
      code: ready ? "no-voice" : "not-ready",
      error: ready
        ? `provider ${providerId} has no voices yet (create a cloned voice in the settings panel)`
        : "local TTS is not running",
    };
  }
  const items: LocalItem[] = [];
  for (const text of texts) {
    const speakable = /[\u4e00-\u9fffA-Za-z0-9]/.test(text);
    const key = createHash("sha256").update(`local|${providerId}|${cfg.model}|${voice}|${text}`).digest("hex");
    const hit = findCacheFile(cacheDir, key);
    if (hit) {
      const st = statSyncSafe(hit.file);
      if (st && st.size > 0) { items.push({ text, key, cached: true, ext: hit.ext, speakable }); continue; }
      try { unlinkSync(hit.file); } catch { /* ignore */ }
    }
    if (!speakable) { items.push({ text, key, cached: false, speakable }); continue; }
    try {
      const r = await synthesizeLocal({
        baseUrl,
        apiKey: cfg.apiKey || undefined,
        model: cfg.model || undefined,
        text,
        voice,
        format: (cfg.format as "pcm" | "wav" | "mp3"),
        sampleRate: cfg.sampleRate,
        // 80M on CPU runs ~1x realtime and the first request after startup also loads the model.
        timeoutMs: 45000,
      });
      writeFileSync(join(cacheDir, key + r.ext), r.buf);
      items.push({ text, key, cached: true, ext: r.ext, speakable });
    } catch (e) {
      const err = e as LocalTtsError;
      items.push({
        text, key, cached: false, speakable,
        code: err?.code || "http", retryable: !!err?.retryable,
        error: String(err?.message || e).slice(0, 300),
      });
      // Readiness problems affect the whole batch; stop after the first one (no retry storm).
      if (err?.code === "not-ready" || err?.code === "network" || err?.code === "timeout") break;
    }
  }
  lruEvict(cacheDir);
  const firstErr = items.find((it) => it.error);
  return { ok: true, engine: "local", voice, provider: providerId, items, ...(firstErr && items.every((it) => !it.cached) ? { code: firstErr.code, error: firstErr.error } : {}) };
}

/** Enable the tts.local feature once when the service is detected (same semantics as edge). */
const LOCAL_AUTO_STATE = "local-auto-enabled.json";
function autoEnableLocal(configDir?: string): void {
  if (featureEnabled("aiti-ai-speek", "tts.local")) return;
  try {
    const p = join(configDir || fallbackDataDir(), LOCAL_AUTO_STATE);
    if (existsSync(p)) return;
    const reg = (globalThis as Record<string, unknown>).__piWebExt as
      { setFeatureFlag?: (extId: string, fid: string, enabled: boolean) => void } | undefined;
    if (!reg?.setFeatureFlag) return;
    reg.setFeatureFlag("aiti-ai-speek", "tts.local", true);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ autoEnabled: true, at: Date.now() }));
  } catch { /* non-blocking */ }
}

/**
 * GET /tts/progress — SSE stream of prepare.json phases (fs.watch, no polling).
 * Closes itself after a terminal phase so the panel can re-read /tts/info once.
 */
function sseLocalProgress(paths: ReturnType<typeof ttsPaths>, req: Request): Response {
  const encoder = new TextEncoder();
  let watcher: ReturnType<typeof fsWatch> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let send: ((frame: string) => void) | null = null;
  let closed = false;
  let lastFrame = "";
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch { /* noop */ }
    if (ping) { clearInterval(ping); ping = null; }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (frame: string) => { try { controller.enqueue(encoder.encode(frame)); } catch { /* disconnected */ } };
      const emit = () => {
        const p = readPrepare(paths);
        const frame = JSON.stringify(p || { phase: "unknown" });
        if (frame === lastFrame) return; // fs.watch fires twice per write (rename + change)
        lastFrame = frame;
        send?.(`event: prepare\ndata: ${frame}\n\n`);
        if (p && ["ready", "failed", "idle-stop"].includes(String(p.phase))) {
          // Terminal phase: let the client react (panel toast) and end the stream.
          setTimeout(() => { try { controller.close(); } catch { /* noop */ } cleanup(); }, 50);
        }
      };
      emit();
      try {
        watcher = fsWatch(paths.home, { persistent: false }, (evt, filename) => {
          if (!filename || String(filename) !== "prepare.json") return;
          if (evt === "rename" || evt === "change") emit();
        });
        watcher.on?.("error", cleanup);
      } catch { /* dir missing: initial snapshot only */ }
      send(": connected\n\n");
      ping = setInterval(() => send?.(": ping\n\n"), 20000); // transport keepalive (not state polling)
      ping.unref?.();
      req.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch { /* noop */ } }, { once: true });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

function broadcast(sessionId: string, event: { type?: string }): void {
  // SSE 事件名用帧自身 type（settled/updating）——旧实现一律叫 settled，
  // 客户端 addEventListener("updating") 永远收不到（updating 帧在 settled 监听里因无 text 被丢弃）
  const name = event?.type || "settled";
  const frame = `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
  const subs = sseBySession.get(sessionId);
  if (subs) for (const send of [...subs]) send(frame);
}

function sseStream(req: Request, sessionId: string): Response {
  const encoder = new TextEncoder();
  let send: ((chunk: string) => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const g = globalThis as { [G_SSE]?: Set<ReadableStreamDefaultController<Uint8Array>> };
  const cleanup = () => {
    if (ctrl) { try { g[G_SSE]?.delete(ctrl); } catch { /* noop */ } ctrl = null; }
    if (ping) { clearInterval(ping); const i = pings.indexOf(ping as ReturnType<typeof setInterval>); if (i >= 0) pings.splice(i, 1); }
    ping = null;
    if (send) { const subs = sseBySession.get(sessionId); subs?.delete(send); if (subs && subs.size === 0) sseBySession.delete(sessionId); }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      (g[G_SSE] ||= new Set()).add(controller);
      send = (chunk: string) => {
        try { controller.enqueue(encoder.encode(chunk)); } catch { /* 断开 */ }
      };
      let subs = sseBySession.get(sessionId);
      if (!subs) { subs = new Set(); sseBySession.set(sessionId, subs); }
      subs.add(send);
      // 补发该会话最近已完成回答（开启跟读即读到当前屏回复）
      const recent = recentBySession.get(sessionId) || [];
      for (const r of recent) {
        const frame = `event: settled\ndata: ${JSON.stringify({ type: "settled", sessionId, text: r.text, ts: r.ts })}\n\n`;
        send(frame);
      }
      send(": connected\n\n");
      ping = setInterval(() => send?.(": ping\n\n"), 20000); // 传输保活（非状态轮询）
      ping.unref?.();
      pings.push(ping);
      // 连接断开（fetch aborted）时清理
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function ratePercent(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return (pct >= 0 ? "+" : "") + pct + "%";
}

export default {
  id: "aiti-ai-speek",
  name: "跟读模式（AI 输出朗读）",
  icon: "icon.svg",
  client: "dist/aiti-ai-speek-client.mjs",

  // AI 自管理清单（ai-helper 聚合；skills/ 目录 → index.json + SKILL.md）
  // 帮助点：edge-tts 各平台安装/验证/排障——设置面板右上角 🤖 即可呼起
  ai: {
    manage: true,
    intro: "AI 能帮我：安装/验证 edge-tts 后端（各平台）、查看跟读模式引擎状态、排障",
    skills: "skills",
  },

  // 定时任务（注册给 aiti-ai-schedule 聚合执行；不重复造 setInterval）
  // Daily tts-cache cleanup: expired 30d audio (mp3/wav) + 0-byte corrupt files + LRU down to 80%
  // Path: ~/.pi/web/data/aiti-ai-speek/cache/tts-cache/
  schedules: [
    {
      id: "tts-cache-gc",
      name: "tts 缓存清理（过期 30 天 + 1GB LRU）",
      intervalSec: 86400, // 1 天
      enabled: true,
      run: (ctx: { configDir?: string }) => {
        const dir = ttsCacheDir(ctx.configDir);
        const exp = cleanExpired(dir);
        const lru = lruEvict(dir);
        if (exp.cleaned || lru.removed) {
          console.log(`[aiti-ai-speek] tts-cache 清理：过期 ${exp.cleaned} 个（${(exp.bytes/1048576).toFixed(2)}MB）+ 超容 LRU ${lru.removed} 个（${(lru.bytes/1048576).toFixed(2)}MB）`);
        }
      },
    },
  ],

  ui: {
    // 🔊 跟读开关（全局顶栏）
    toolbar: [{ id: "follow", label: "i18n:speek.followMode.label", title: "i18n:speek.followMode.title", icon: "icons/volume-2.svg" }],
    // 播放条（会话顶栏，常驻不消失）
    sessionTopbar: [{ id: "bar", label: "i18n:it.bar.label" }],
    // assistant 消息 hover 操作区：朗读这条/停止朗读
    assistantMessageActions: [{ id: "read", label: "i18n:it.read.label" }],
    // 设置面板（dialogs 插槽）
    dialogs: [{ id: "settings", label: "i18n:it.settings.label" }],
    i18n: {
      "zh-CN": {
        "it.read.label": "朗读这条回复",
        "it.settings.label": "跟读设置",
        "it.bar.label": "跟读播放条",
        "ext.displayName": "AI 语音朗读",        "speek.followMode.label": "跟读模式",
        "speek.followMode.title": "跟读模式：AI 回复自动朗读（可暂停/跳过/切音色）",
        "speek.followOn": "跟读模式已开启，AI 回复将自动朗读",
        "speek.followOff": "开启跟读模式：AI 回复自动朗读",
        "speek.followHidden": "跟读进行中（播放条已隐藏）",
        "speek.followOffMsgs": "（会话 {n} 条消息）",
        "speek.followRestoreHint": "（点按恢复播放条）",
        "speek.followDisableHint": "（点按关闭跟读）",
        "speek.play": "播放",
        "speek.pause": "暂停",
        "speek.prev": "上一条消息",
        "speek.next": "下一条消息",
        "speek.replay": "重新读当前页",
        "speek.stop": "停止并清空队列",
        "speek.queue": "{cur}/{total} 在排队",
        "speek.settings": "跟读设置",
        "speek.readThis": "开始朗读",
        "speek.stopReading": "停止朗读",
        "speek.shellOff": "跟读模式：AI 回复自动朗读（点按开启）",
        "speek.shellPending": "跟读模式：开启中（引擎模块加载后接管播放条）",
        "speek.backgroundContinue": "允许后台继续朗读（浏览器切到后台标签页时不停读）",

        // engines + dialog (local TTS / voice management included)
        "speek.engine.label": "引擎",
        "speek.engine.title": "自动 = edge-tts 可用则用它，其次本地引擎，最后浏览器 Web Speech",
        "speek.engine.auto": "自动",
        "speek.engine.browser": "浏览器",
        "speek.engine.edge": "edge-tts",
        "speek.engine.local": "本地",
        "speek.browserUnsupported": "⚠ 当前浏览器不支持本地朗读（Web Speech），已自动切换到服务端语音生成。",
        "speek.voice.label": "音色",
        "speek.voice.defaultLocal": "本地默认音色",
        "speek.voice.defaultName": "默认（{name}）",
        "speek.voice.defaultBrowser": "浏览器默认中文",
        "speek.voice.localHint": "本地音色在下方「音色管理」中查看/新建/删除（克隆音色需 Hojo 80M 或 Qwen3）。",
        "speek.voice.noVoices": "无可用音色（需新建克隆音色）",
        "speek.local.noVoicesHint": "当前 provider 没有可用音色：Hojo 80M 只有克隆音色，请在「音色管理」新建后再朗读。",
        "speek.toast.noVoice": "本地 provider（{provider}）还没有可用音色：Hojo 80M 只有克隆音色，请到设置 → 音色管理新建。",
        "speek.toast.unknownVoice": "本地音色「{voice}」不存在（provider 可能已切换），请在音色管理里重新选择。",
        "speek.voice.lang.zh": "中文",
        "speek.voice.lang.en": "English",
        "speek.voice.sex.f": "女声",
        "speek.voice.sex.m": "男声",
        "speek.voice.builtin": "{lang} · {sex} {n}",
        "speek.local.title": "本地 TTS 服务",
        "speek.local.running": "● 运行中",
        "speek.local.preparing": "◌ 准备中",
        "speek.local.failed": "⚠ 失败",
        "speek.local.stopped": "○ 未运行",
        "speek.local.preparingLine": "正在准备：{text}",
        "speek.local.provider": "provider",
        "speek.local.provider.hojo40": "Hojo 40M · CPU · 17 内置音色（~240MB）",
        "speek.local.provider.hojo80": "Hojo 80M · 克隆音色（~458MB）",
        "speek.local.provider.qwen3": "Qwen3 0.6B · 需 torch（GPU 推荐）",
        "speek.local.provider.stub": "stub · 链路排障（无模型）",
        "speek.local.runningHint": "本地服务运行中 · {label} · pid {pid}",
        "speek.local.stoppedHint": "本地服务未运行（{provider}）— 选中「本地」引擎或点「检查/准备」会自动准备并启动",
        "speek.local.baseUrl": "服务地址",
        "speek.local.baseUrlPh": "留空 = 127.0.0.1:8768（自动选端口）",
        "speek.local.meta": "model {model} · 端口 {port} · pid {pid} · RTF {rtf} · RSS {rss} · 最近活动 {time}",
        "speek.local.modelSize": " · 模型占用 {mb}MB",
        "speek.local.start": "启动",
        "speek.local.stop": "停止",
        "speek.local.restart": "重启",
        "speek.local.ensure": "检查/准备",
        "speek.local.ensureTitle": "探测并准备（venv/依赖/模型），不动已在运行的服务",
        "speek.local.voices": "音色管理",
        "speek.local.logShow": "查看日志",
        "speek.local.logHide": "隐藏日志",
        "speek.local.failedTitle": "⚠ 准备失败：{msg}",
        "speek.local.repro": "可复现命令：{cmd}",
        "speek.local.idleStopped": "空闲已退出（模型已释放）；下次朗读或点「检查/准备」会自动再起。",
        "speek.local.idleTimeout": "空闲自动退出（秒，0=常驻）",
        "speek.local.autoStart": "自动准备并启动",
        "speek.local.autoStartTitle": "选中「本地」引擎时自动准备并启动服务（关闭后只探测，不自动下载/安装）",
        "speek.local.hint": "启动脚本：server/tts-service/start-tts.sh（Windows 为 .ps1）；空闲退出后下次使用自动再起。",
        "speek.local.phase.venv": "Python 环境",
        "speek.local.phase.deps": "依赖安装",
        "speek.local.phase.download": "模型下载",
        "speek.local.phase.load": "模型加载",
        "speek.local.phase.ready": "就绪",
        "speek.local.phase.failed": "失败",
        "speek.local.phase.idle": "已空闲退出",
        "speek.local.phase.unknown": "启动中…",
        "speek.edge.status": "后端引擎状态（edge-tts）",
        "speek.edge.installed": "● 已安装",
        "speek.edge.missing": "○ 未安装",
        "speek.edge.installedLine": "已安装 · edge-tts {version} · {bin}",
        "speek.edge.featureOff": "⚠ tts.edge feature 未开启（可在扩展管理器开启；已装会自动开）",
        "speek.edge.installHint": "点右上角 🤖，让 AI 按你的平台（Linux/macOS/Windows）帮我安装 edge-tts。",
        "speek.edge.binLabel": "edge-tts 路径（可空）",
        "speek.edge.binTitle": "留空自动探测 ~/.local/bin、PATH、pipx；Windows 可填 pip install 后的 Scripts 路径",
        "speek.edge.binPh": "自动探测",
        "speek.edge.reprobe": "重新探测",
        "speek.edge.reprobeTitle": "绕过缓存重新探测 edge-tts（AI 刚帮你装好时点这个）",
        "speek.edge.notReady": "⚠ edge-tts 后端未就绪（未装或 feature 未开启），将自动回落浏览器朗读。",
        "speek.process.label": "朗读过程",
        "speek.process.title": "把 AI 的中间叙述也读出来（如「让我看一下…」）；跳过思考与工具执行",
        "speek.content.label": "朗读内容",
        "speek.content.full": "全文概要化",
        "speek.content.essentials": "仅要点",
        "speek.speed.label": "语速",
        "speek.speed.titleLocal": "本地引擎用 audio.playbackRate 实现，不进缓存 key",
        "speek.speed.titleEdge": "edge-tts 服务端语速",
        "speek.minChars.label": "忽略短回复（少于 N 字不读）",
        "speek.steer.label": "开启跟读时注入「朗读模式」提示词（让 AI 输出自带朗读优化）",
        "speek.background.label": "允许后台继续朗读",
        "speek.background.title": "浏览器标签页切换到后台时，是否允许继续朗读（默认会暂停）",
        "speek.queue.label": "队列语义：新回复进队尾不打断当前朗读；⏹ 停止清队列；关闭 🔊 即恢复纯阅读。",
        "speek.common.close": "关闭",
        "speek.bar.grip": "拖动移动 · 双击复位",
        "speek.bar.starting": "启动中…",
        "speek.bar.waiting": "等待",
        "speek.bar.startingFile": "📖 {name} · 启动中…",
        "speek.bar.picker": "点按弹出：跳转到任意消息（树形分组）",
        "speek.bar.driftJump": "跳回当前朗读位置（不影响朗读）",
        "speek.bar.readPage": "读本页",
        "speek.bar.readPageTitle": "从当前页第一条可见消息开始读",
        "speek.bar.hide": "隐藏播放条（跟读继续）",
        "speek.picker.title": "跳转到消息（共 {n} 条 · 每组 {g}）",
        "speek.picker.group": "消息 {start}–{end} · {count}",
        "speek.picker.groups": "{n} 组",
        "speek.picker.items": "{n} 条",
        "speek.picker.msg": "消息 {n}",
        "speek.picker.current": "当前",
        "speek.picker.currentPos": "消息 {n} · 当前播放位置",
        "speek.picker.hover": "（划过加载概要…）",
        "speek.voices.title": "🎙 本地音色管理（{provider}）",
        "speek.voices.intro": "内置音色由 provider 直接提供（不可删除）；克隆音色保存在 state 目录（voices.json + 参考音频），切换 provider 后仍可复用。",
        "speek.voices.empty": "（服务未运行或该 provider 暂无音色 — 先启动本地服务）",
        "speek.voices.clone": "克隆",
        "speek.voices.preview": "▶ 试听",
        "speek.voices.create": "＋ 新建克隆音色",
        "speek.voices.name": "音色名",
        "speek.voices.namePh": "如 我的声音",
        "speek.voices.provider": "用于 provider",
        "speek.voices.switchProvider": "切到该 provider",
        "speek.voices.refAudio": "参考音频",
        "speek.voices.upload": "上传文件",
        "speek.voices.record": "🎙 录音 15s",
        "speek.voices.stopRecord": "停止录音",
        "speek.voices.micUnsupported": "（非安全上下文/不支持录音 → 请上传 wav）",
        "speek.voices.selected": "已选：{name}（{kb}KB）",
        "speek.voices.fileSelected": "已选择：{name}",
        "speek.voices.refHint": "支持 wav/mp3/webm（webm 需服务端有 ffmpeg）；时长 3-30 秒、≤10MB。",
        "speek.voices.refText": "参考文本（音频里说的内容；克隆质量关键）",
        "speek.voices.refTextPh": "例：现在的外卖确实坑多，要不咱换家稍微贵点的？",
        "speek.voices.language": "语言",
        "speek.voices.lang.zh": "中文",
        "speek.voices.lang.en": "English",
        "speek.voices.lang.auto": "自动",
        "speek.voices.xvec": "仅音色向量",
        "speek.voices.save": "保存音色",
        "speek.voices.saving": "保存中…",
        "speek.voices.saved": "已保存音色：{name}",
        "speek.voices.savedProvider": "已保存。切换到 provider {provider} 后即可使用该克隆音色。",
        "speek.voices.recorded": "录音完成（{kb}KB）— 建议 3-10 秒",
        "speek.voices.recording": "录音中… 再点停止（最长 15 秒）",
        "speek.voices.micError": "无法访问麦克风：{err}",
        "speek.voices.errName": "请填写音色名",
        "speek.voices.errAudio": "请上传参考音频或现场录音（3-30 秒）",
        "speek.voices.errRefText": "请填写参考音频对应的文字（转录）",
        "speek.voices.errSave": "保存失败",
        "speek.voices.errDelete": "删除失败",
        "speek.voices.deleted": "已删除 {id}",
        "speek.voices.deleteTitle": "删除该克隆音色",
        "speek.voices.providerHint": "提示：当前 provider 为 {provider}，克隆音色需要 Hojo 80M 或 Qwen3；保存后可在上方「启动/重启」切换。",
        "speek.toast.localNotReady": "本地语音未就绪（正在自动启动），这句先用浏览器朗读；稍后再读即可用本地音色。",
        "speek.toast.localFailed": "本地语音合成失败：{err}（已用浏览器朗读这句）",
        "speek.toast.localFailedShort": "本地语音合成失败（已用浏览器朗读这句）",
        "speek.toast.browserUnavailable": "当前环境无法朗读：浏览器语音不可用。请在设置中开启 edge-tts 后端或本地引擎，或换用支持 Web Speech 的浏览器。",
        "speek.toast.edgeFailed": "语音合成失败（edge-tts 无法生成音频），请检查后端或换引擎。",
        "speek.toast.playFailed": "语音播放失败。",
        "speek.notice.edgeDetected": "已检测到 edge-tts，引擎默认切到 edge-tts（更自然）。",
        "speek.notice.noWebSpeechEdge": "浏览器不支持本地朗读，已自动切换到服务端语音生成。",
        "speek.notice.noWebSpeechLocal": "浏览器不支持本地朗读，已切换到本地 TTS 引擎。",
        "speek.notice.noEngineAtAll": "浏览器不支持本地朗读，且服务端语音（edge-tts / 本地 TTS）未就绪，无法朗读。请安装 edge-tts 或在设置里启动本地引擎。",
      },
      "en": {
        "it.settings.label": "Read-aloud settings",
        "it.read.label": "Read this reply aloud",
        "it.bar.label": "Read-aloud bar",
        "ext.displayName": "AI Read Aloud",
        "feat.bar": "Read-aloud playback bar",
        "feat.read": "Read this reply aloud",
        "feat.settings": "Read-aloud settings",
        "feat.steer.enabled": "Read-aloud prompt injection (when on, prompts the AI to optimize output, e.g. conclusion first / conversational)",
        "feat.tts.edge": "edge-tts backend quality tier (auto-enabled when installed; better than browser Web Speech)",
        "feat.tts.edge.bin": "edge-tts executable path (empty = auto-detect ~/.local/bin, PATH, pipx)",
        "feat.process.enabled": "Read the process aloud (also reads AI narration like \"Let me check…\"; skips thinking and tool runs)",
        "feat.minChars": "Ignore threshold (replies shorter than N chars are not read)",
      
        "speek.followMode.label": "Read aloud",
        "speek.followMode.title": "Read aloud: AI replies are read out automatically (pause / skip / voice)",
        "speek.followOn": "Read aloud on: AI replies will be spoken",
        "speek.followOff": "Turn on read-aloud (AI replies read automatically)",
        "speek.followHidden": "Read aloud active (bar hidden)",
        "speek.followOffMsgs": " ({n} messages in session)",
        "speek.followRestoreHint": " (click to restore the bar)",
        "speek.followDisableHint": " (click to turn off)",
        "speek.play": "Play",
        "speek.pause": "Pause",
        "speek.prev": "Previous message",
        "speek.next": "Next message",
        "speek.replay": "Re-read current page",
        "speek.stop": "Stop & clear queue",
        "speek.queue": "{cur}/{total} queued",
        "speek.settings": "Read-aloud settings",
        "speek.readThis": "Read aloud",
        "speek.stopReading": "Stop reading",
        "speek.shellOff": "Read aloud: AI replies are read out automatically (click to turn on)",
        "speek.shellPending": "Read aloud: turning on (playback bar takes over once the engine module loads)",
        "speek.backgroundContinue": "Continue reading in background (don't stop when tab loses focus)",

        // engines + dialog (local TTS / voice management included)
        "speek.engine.label": "Engine",
        "speek.engine.title": "Auto = edge-tts when available, then the local engine, then browser Web Speech",
        "speek.engine.auto": "Auto",
        "speek.engine.browser": "Browser",
        "speek.engine.edge": "edge-tts",
        "speek.engine.local": "Local",
        "speek.browserUnsupported": "⚠ This browser has no local speech (Web Speech); server-side synthesis is used instead.",
        "speek.voice.label": "Voice",
        "speek.voice.defaultLocal": "Local default voice",
        "speek.voice.defaultName": "Default ({name})",
        "speek.voice.defaultBrowser": "Browser default (Chinese)",
        "speek.voice.localHint": "Manage local voices in \u201cVoice management\u201d below (cloned voices need Hojo 80M or Qwen3).",
        "speek.voice.noVoices": "No voices yet (create a cloned voice)",
        "speek.local.noVoicesHint": "This provider has no voices: Hojo 80M only has cloned voices — create one in Voice management before reading.",
        "speek.toast.noVoice": "The local provider ({provider}) has no voices yet — Hojo 80M only has cloned voices; create one in Settings → Voice management.",
        "speek.toast.unknownVoice": "Local voice \"{voice}\" does not exist (the provider may have changed); pick another one in Voice management.",
        "speek.voice.lang.zh": "Chinese",
        "speek.voice.lang.en": "English",
        "speek.voice.sex.f": "Female",
        "speek.voice.sex.m": "Male",
        "speek.voice.builtin": "{lang} · {sex} {n}",
        "speek.local.title": "Local TTS service",
        "speek.local.running": "● Running",
        "speek.local.preparing": "◌ Preparing",
        "speek.local.failed": "⚠ Failed",
        "speek.local.stopped": "○ Stopped",
        "speek.local.preparingLine": "Preparing: {text}",
        "speek.local.provider": "Provider",
        "speek.local.provider.hojo40": "Hojo 40M · CPU · 17 built-in voices (~240MB)",
        "speek.local.provider.hojo80": "Hojo 80M · voice cloning (~458MB)",
        "speek.local.provider.qwen3": "Qwen3 0.6B · needs torch (GPU recommended)",
        "speek.local.provider.stub": "stub · pipeline debugging (no model)",
        "speek.local.runningHint": "Local service running · {label} · pid {pid}",
        "speek.local.stoppedHint": "Local service is not running ({provider}) — selecting \u201cLocal\u201d or \u201cCheck / prepare\u201d bootstraps and starts it automatically",
        "speek.local.baseUrl": "Service URL",
        "speek.local.baseUrlPh": "empty = 127.0.0.1:8768 (port auto-picked)",
        "speek.local.meta": "model {model} · port {port} · pid {pid} · RTF {rtf} · RSS {rss} · last activity {time}",
        "speek.local.modelSize": " · models {mb}MB",
        "speek.local.start": "Start",
        "speek.local.stop": "Stop",
        "speek.local.restart": "Restart",
        "speek.local.ensure": "Check / prepare",
        "speek.local.ensureTitle": "Probe and prepare (venv/deps/model) without touching a running service",
        "speek.local.voices": "Voice management",
        "speek.local.logShow": "Show log",
        "speek.local.logHide": "Hide log",
        "speek.local.failedTitle": "⚠ Preparation failed: {msg}",
        "speek.local.repro": "Reproduce with: {cmd}",
        "speek.local.idleStopped": "Exited while idle (model released); the next playback or \u201cCheck / prepare\u201d starts it again.",
        "speek.local.idleTimeout": "Idle exit (seconds, 0 = stay resident)",
        "speek.local.autoStart": "Prepare and start automatically",
        "speek.local.autoStartTitle": "Bootstrap and start the service when \u201cLocal\u201d is selected (off = probe only, never download/install)",
        "speek.local.hint": "Launcher: server/tts-service/start-tts.sh (start-tts.ps1 on Windows); it starts again on next use after an idle exit.",
        "speek.local.phase.venv": "Python environment",
        "speek.local.phase.deps": "Installing dependencies",
        "speek.local.phase.download": "Downloading model",
        "speek.local.phase.load": "Loading model",
        "speek.local.phase.ready": "Ready",
        "speek.local.phase.failed": "Failed",
        "speek.local.phase.idle": "Idle-exited",
        "speek.local.phase.unknown": "Starting…",
        "speek.edge.status": "edge-tts status",
        "speek.edge.installed": "● Installed",
        "speek.edge.missing": "○ Not installed",
        "speek.edge.installedLine": "Installed · edge-tts {version} · {bin}",
        "speek.edge.featureOff": "⚠ tts.edge feature is off (enable it in the extension manager; it turns on automatically when installed)",
        "speek.edge.installHint": "Use 🤖 (top right) to let the AI install edge-tts for your platform (Linux/macOS/Windows).",
        "speek.edge.binLabel": "edge-tts path (optional)",
        "speek.edge.binTitle": "Empty = auto-detect ~/.local/bin, PATH, pipx; on Windows use the Scripts path from pip install",
        "speek.edge.binPh": "auto-detect",
        "speek.edge.reprobe": "Re-probe",
        "speek.edge.reprobeTitle": "Bypass the cache and probe edge-tts again (use after the AI installed it)",
        "speek.edge.notReady": "⚠ edge-tts backend is not ready (missing or feature off); playback falls back to the browser.",
        "speek.process.label": "Read the process aloud",
        "speek.process.title": "Also read the AI's narration (e.g. \u201clet me check…\u201d); thinking and tool runs are skipped",
        "speek.content.label": "Content",
        "speek.content.full": "Full (summarized)",
        "speek.content.essentials": "Essentials only",
        "speek.speed.label": "Speed",
        "speek.speed.titleLocal": "The local engine applies speed via audio.playbackRate (not part of the cache key)",
        "speek.speed.titleEdge": "edge-tts server-side rate",
        "speek.minChars.label": "Skip short replies (shorter than N characters)",
        "speek.steer.label": "Inject the read-aloud prompt when follow mode is enabled (AI optimizes output for listening)",
        "speek.background.label": "Keep reading in the background",
        "speek.background.title": "Whether reading continues when the tab goes to the background (default: pause)",
        "speek.queue.label": "Queue: new replies append without interrupting; ⏹ stops and clears; turning 🔊 off returns to reading silently.",
        "speek.common.close": "Close",
        "speek.bar.grip": "Drag to move · double-click to reset",
        "speek.bar.starting": "Starting…",
        "speek.bar.waiting": "Waiting",
        "speek.bar.startingFile": "📖 {name} · starting…",
        "speek.bar.picker": "Click to jump to any message (tree grouped)",
        "speek.bar.driftJump": "Jump back to the line being read (playback unaffected)",
        "speek.bar.readPage": "Read this page",
        "speek.bar.readPageTitle": "Read from the first visible message on this page",
        "speek.bar.hide": "Hide the bar (reading continues)",
        "speek.picker.title": "Jump to message ({n} total · {g} per group)",
        "speek.picker.group": "Messages {start}–{end} · {count}",
        "speek.picker.groups": "{n} groups",
        "speek.picker.items": "{n} items",
        "speek.picker.msg": "Message {n}",
        "speek.picker.current": "current",
        "speek.picker.currentPos": "Message {n} · current position",
        "speek.picker.hover": "(hover to load a summary…)",
        "speek.voices.title": "🎙 Local voices ({provider})",
        "speek.voices.intro": "Built-in voices come from the provider (not deletable); cloned voices live in the state area (voices.json + reference audio) and stay usable after switching providers.",
        "speek.voices.empty": "(service not running, or this provider has no voices — start the local service first)",
        "speek.voices.clone": "clone",
        "speek.voices.preview": "▶ Preview",
        "speek.voices.create": "＋ New cloned voice",
        "speek.voices.name": "Voice name",
        "speek.voices.namePh": "e.g. My voice",
        "speek.voices.provider": "For provider",
        "speek.voices.switchProvider": "Switch to it",
        "speek.voices.refAudio": "Reference audio",
        "speek.voices.upload": "Upload file",
        "speek.voices.record": "🎙 Record 15s",
        "speek.voices.stopRecord": "Stop recording",
        "speek.voices.micUnsupported": "(insecure context / recorder unsupported → upload a wav)",
        "speek.voices.selected": "Selected: {name} ({kb}KB)",
        "speek.voices.fileSelected": "Selected: {name}",
        "speek.voices.refHint": "wav/mp3/webm (webm needs ffmpeg on the server); 3-30 seconds, ≤10MB.",
        "speek.voices.refText": "Reference transcript (what the audio says; matters for clone quality)",
        "speek.voices.refTextPh": "e.g. It is raining again, let us take a taxi home.",
        "speek.voices.language": "Language",
        "speek.voices.lang.zh": "Chinese",
        "speek.voices.lang.en": "English",
        "speek.voices.lang.auto": "Auto",
        "speek.voices.xvec": "Speaker vector only",
        "speek.voices.save": "Save voice",
        "speek.voices.saving": "Saving…",
        "speek.voices.saved": "Saved voice: {name}",
        "speek.voices.savedProvider": "Saved. Switch the provider to {provider} to use this cloned voice.",
        "speek.voices.recorded": "Recording captured ({kb}KB) — 3-10 seconds works best",
        "speek.voices.recording": "Recording… click stop when done (max 15s)",
        "speek.voices.micError": "Cannot access the microphone: {err}",
        "speek.voices.errName": "Please enter a voice name",
        "speek.voices.errAudio": "Please upload or record reference audio (3-30s)",
        "speek.voices.errRefText": "Please enter the reference transcript",
        "speek.voices.errSave": "Save failed",
        "speek.voices.errDelete": "Delete failed",
        "speek.voices.deleted": "Deleted {id}",
        "speek.voices.deleteTitle": "Delete this cloned voice",
        "speek.voices.providerHint": "Note: the current provider is {provider}; cloning needs Hojo 80M or Qwen3 — switch with Start/Restart above.",
        "speek.toast.localNotReady": "Local speech is not ready (starting up) — this sentence uses the browser; try again in a moment.",
        "speek.toast.localFailed": "Local synthesis failed: {err} (this sentence used the browser)",
        "speek.toast.localFailedShort": "Local synthesis failed (this sentence used the browser)",
        "speek.toast.browserUnavailable": "Cannot read aloud here: browser speech is unavailable. Enable edge-tts or the local engine in the settings, or use a browser with Web Speech support.",
        "speek.toast.edgeFailed": "Synthesis failed (edge-tts produced no audio); check the backend or switch engines.",
        "speek.toast.playFailed": "Audio playback failed.",
        "speek.notice.edgeDetected": "edge-tts detected; the engine now defaults to edge-tts (more natural).",
        "speek.notice.noWebSpeechEdge": "This browser has no local speech; switched to server-side synthesis.",
        "speek.notice.noWebSpeechLocal": "This browser has no local speech; switched to the local TTS engine.",
        "speek.notice.noEngineAtAll": "This browser has no local speech and no server engine is ready (edge-tts / local TTS); install edge-tts or start the local engine in the settings.",
      },
    },
  },

  // 功能管理（extman 逐项启停；core 持久化 features.json）
  features: [
    { id: "steer.enabled", label: "朗读提示词注入（开启跟读时提示 AI 优化输出，如先给结论/口语化）", group: "AI 优化", default: true },
    { id: "tts.edge", label: "edge-tts 后端音质档（已安装时自动开启；效果好于浏览器 Web Speech）", group: "引擎", default: false },
    { id: "tts.edge.bin", type: "string", label: "edge-tts 可执行文件路径（留空自动探测 ~/.local/bin、PATH、pipx）", group: "引擎", value: "", placeholder: "如 C:\\Python312\\Scripts\\edge-tts.exe" },
    { id: "tts.local", label: "本地 TTS 引擎（本机 CPU 合成，服务就绪时自动开启）", group: "引擎", default: false },
    { id: "tts.local.provider", type: "string", label: "本地 provider（hojo-40m / hojo-80m / qwen3-0.6b / stub；切换后需重启服务）", group: "本地引擎", value: "hojo-40m", placeholder: "hojo-40m" },
    { id: "tts.local.baseUrl", type: "string", label: "本地服务地址（留空 = 127.0.0.1:8768 自动选端口；也可指向任意 OpenAI 兼容 TTS）", group: "本地引擎", value: "", placeholder: "http://127.0.0.1:8768" },
    { id: "tts.local.model", type: "string", label: "本地模型名（透传 model 字段；留空由 provider 决定）", group: "本地引擎", value: "" },
    { id: "tts.local.voice", type: "string", label: "本地音色 ID（留空 = 服务端第一个音色）", group: "本地引擎", value: "" },
    { id: "tts.local.format", type: "string", label: "请求音频格式（pcm 优先，服务不支持时自动降级 wav/mp3）", group: "本地引擎", value: "pcm", placeholder: "pcm | wav | mp3" },
    { id: "tts.local.sampleRate", type: "string", label: "PCM 采样率（封装 WAV 头用，默认 24000）", group: "本地引擎", value: "24000" },
    { id: "tts.local.apiKey", type: "string", label: "本地服务 API Key（回环地址留空即可；指向远端时才需要）", group: "本地引擎", value: "" },
    { id: "tts.local.autoStart", label: "选中本地引擎时自动准备并启动服务（首次会联网下载约 300MB）", group: "本地引擎", default: true },
    { id: "tts.local.idleTimeout", type: "string", label: "空闲自动退出秒数（0 = 常驻；默认 1800 = 30 分钟）", group: "本地引擎", value: "1800" },
    { id: "tts.local.hfEndpoint", type: "string", label: "模型下载源（留空自动探测：官方 → hf-mirror；也可填镜像/代理地址）", group: "本地引擎", value: "" },
    { id: "tts.local.threads", type: "string", label: "ONNX 线程数（0 = 自动；CPU 少核机器可调低）", group: "本地引擎", value: "0" },
    { id: "process.enabled", label: "朗读过程（把 AI 的中间叙述也读出来，如「让我看一下…」「我先确认…」；跳过 thinking 与工具执行）", group: "朗读内容", default: false },
    { id: "minChars", type: "string", label: "忽略阈值（回复少于 N 字不朗读，避免“好的”“收到”刷屏）", group: "队列", value: "8", placeholder: "8" },
  ],

  server: {
    async startup(ctx?: {
      configDir?: string;
      stateDir?: string;
      cacheDir?: string;
      features?: { get(extIdOrFid?: string, fid?: string): boolean | string | undefined };
      services?: ApiCtxLike["services"];
    }) {
      hostFeatures = (ctx as any)?.features ?? null; // DI 方案 P1
      // Capture dirs + the service locator so the cross-extension TTS API works without a request.
      svcState = {
        dirs: { configDir: ctx?.configDir, stateDir: ctx?.stateDir, cacheDir: ctx?.cacheDir },
        services: ctx?.services,
      };
      try {
        (ctx?.services as { provide?: (name: string, impl: unknown) => void } | undefined)?.provide?.("aiti-ai-speek.tts", buildTtsService());
        console.log("[aiti-ai-speek] services 已注册：aiti-ai-speek.tts（ensure/status/stop/restart/synthesize/voices/readCached）");
      } catch (e) {
        console.warn("[aiti-ai-speek] services.provide(aiti-ai-speek.tts) 失败", e);
      }
      // edge-tts 已装 → 自动开 tts.edge feature（仅一次；用户此后显式关掉不会被覆盖）
      try { autoEnableEdge(ctx?.configDir); } catch { /* 不阻塞启动 */ }
      console.log("[aiti-ai-speek] 跟读模式就绪 · onAgentSettled→SSE + steer + edge-tts" + (edgeInstalled() ? "(已安装)" : "(未安装)") + " + 本地引擎(按需启动)");
      // tts-cache 清理不靠 startup（避免拖慢启动 / 双实例 restart race），改由 aiti-ai-schedule 聚合 1 天一次跑（下方 schedules）
    },

    async shutdown() {
      for (const p of pings) clearInterval(p);
      pings.length = 0;
      sseBySession.clear();
      recentBySession.clear();
      steerFns.clear();
      // 不清 injectedSessions——持久化记录文件保留（steer-injected.json），跨重启防重发
    },

    agent: {
      onAgentSession(info) {
        // 捕获 steer 用于后续提示词注入（idle GC → 重建会再次 onAgentSession，幂等覆盖）
        if (info.sessionId && typeof info.steer === "function") {
          steerFns.set(info.sessionId, info.steer);
        }
        // 朗读过程：订阅 message_end 收集本轮 assistant 消息的 text 块（跳过 thinking/toolCall）
        // agent_start 重置本轮 buffer；agent_settled 由 onAgentSettled 结算后清。
        if (info.sessionId && typeof info.subscribeEvent === "function") {
          info.subscribeEvent((evt: { type: string } & Record<string, unknown>) => {
            const sid = info.sessionId;
            if (evt.type === "agent_start") {
              turnTextBySession.set(sid, "");
            } else if (evt.type === "message_end") {
              const msg = evt.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
              if (msg?.role === "assistant" && Array.isArray(msg.content)) {
                const texts = msg.content
                  .filter((b) => b.type === "text" && (b.text ?? "").trim().length > 0)
                  .map((b) => b.text!);
                if (texts.length) {
                  const prev = turnTextBySession.get(sid) || "";
                  turnTextBySession.set(sid, prev ? prev + "\n" + texts.join("\n") : texts.join("\n"));
                  // 正文消息已完成（未必转 settled）：广播 updating——客户端刷新列表并继续追读
                  broadcast(sid, { type: "updating", sessionId: sid, ts: Date.now() });
                }
              }
            }
          });
        }
      },
      onAgentSessionEnd({ sessionId }) {
        steerFns.delete(sessionId);
        // 不清 injectedSessions/持久化记录——onAgentSessionEnd 因 idle GC/fork 触发而非
        // 会话真正删除，清了会导致朗读提示词重发。记录随会话文件长期保留。
        recentBySession.delete(sessionId);
        turnTextBySession.delete(sessionId);
      },
      // 关键信号：agent 一轮执行完 → 广播最终回答（消息完成才进队列）
      onAgentSettled({ sessionId, text }) {
        if (!sessionId || !text || !text.trim()) return;
        // feature process.enabled 开 → 用收集的完整轮文本（含过程叙述）；关 → 仅最终汇总
        const full = turnTextBySession.get(sessionId) || "";
        const useProcess = full.trim().length > 0 && featureEnabled("aiti-ai-speek", "process.enabled");
        const outText = useProcess ? full : text;
        turnTextBySession.delete(sessionId); // 结算后清（下一轮 agent_start 重建）
        // ring buffer（连接补发用）
        let recent = recentBySession.get(sessionId);
        if (!recent) { recent = []; recentBySession.set(sessionId, recent); }
        recent.push({ text: outText, ts: Date.now() });
        if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
        broadcast(sessionId, { type: "settled", sessionId, text: outText, ts: Date.now() });
      },
    },

    async api(req: Request, ctx: ApiCtxLike) {
      const [action] = ctx.path;

      // ── local engine: progress SSE, info, ensure, control, voice management ────────────
      // GET /tts/progress — prepare.json phase stream (fs.watch; no polling, closes on terminal)
      if (action === "tts" && ctx.path[1] === "progress" && ctx.method === "GET") {
        return sseLocalProgress(ttsPaths(ctx), req);
      }

      // GET /tts/info — local service snapshot (health + prepare + runtime + ready + paths + log tail)
      if (action === "tts" && ctx.path[1] === "info" && ctx.method === "GET") {
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        const health = await localHealth(paths, cfg, true);
        const prepare = readPrepare(paths);
        const runtime = readRuntime(paths);
        const ready = readReady(paths);
        try { if (health?.ok) autoEnableLocal(ctx.configDir); } catch { /* non-blocking */ }
        const wantSizes = ctx.searchParams.get("sizes") === "1";
        const modelsBytes = wantSizes ? dirBytes(paths.models, 3) : dirBytes(paths.models, 1);
        const venvBytes = wantSizes ? dirBytes(paths.venvHojo, 4) + dirBytes(paths.venvQwen3, 4) : 0;
        return json({
          ok: true,
          baseUrl: localBaseUrl(paths, cfg),
          featureOn: cfg.enabled,
          provider: cfg.provider,
          providerActual: health?.provider || ready?.provider || null,
          autoStart: cfg.autoStart,
          idleTimeout: cfg.idleTimeout,
          model: health?.model || null,
          running: !!health?.ok,
          health,
          prepare,
          runtime,
          ready,
          paths: { home: paths.home, models: paths.models, venv: ready?.venv || paths.venvHojo, log: paths.log, voicesJson: paths.voicesJson, service: SERVICE_DIR },
          sizes: { modelsMB: +(modelsBytes / 1048576).toFixed(1), venvMB: +(venvBytes / 1048576).toFixed(1) },
          logTail: ctx.searchParams.get("log") === "1" ? tailLog(paths, 40) : undefined,
          installHint: health?.ok
            ? `本地服务运行中 · ${health.providerLabel || health.provider || cfg.provider} · pid ${health.pid ?? "?"}`
            : `本地服务未运行（${cfg.provider}）— 选中「本地」引擎或运行 start-tts.sh start 自动准备`,
        });
      }

      // POST /tts/ensure { provider? } — probe, then bootstrap+launch when needed; returns starting
      if (action === "tts" && ctx.path[1] === "ensure" && ctx.method === "POST") {
        let body: { provider?: string; } = {};
        try { body = await req.json(); } catch { /* empty body tolerated */ }
        const st = await localEnsure(ctx, typeof body?.provider === "string" ? body.provider : undefined);
        return json({ ok: true, ...st });
      }

      // POST /tts/control { action: start|stop|restart } — panel buttons (logs via aiti-cmd or file)
      if (action === "tts" && ctx.path[1] === "control" && ctx.method === "POST") {
        let body: { action?: string; provider?: string; } = {};
        try { body = await req.json(); } catch { /* empty */ }
        const act = String(body?.action || "").trim();
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        const provider = (typeof body?.provider === "string" && body.provider.trim()) || cfg.provider;
        if (act === "stop") {
          const r = await stopService(paths);
          localStart = { status: "idle", at: Date.now() };
          localProbeCache = { at: 0, baseUrl: "", health: null };
          return json({ ok: r.ok, stopped: r.ok, error: r.error });
        }
        if (act === "start" || act === "restart") {
          if (act === "restart") {
            await stopService(paths);
            await new Promise((r) => setTimeout(r, 800));
          }
          // Keep the feature in sync with the provider that is actually being started.
          if (provider !== cfg.provider) setFeatureValueSafe("tts.local.provider", provider);
          localStart = { status: "idle", at: 0 };
          localProbeCache = { at: 0, baseUrl: "", health: null };
          const r = await localEnsure(ctx, provider);
          return json({ ok: true, ...r });
        }
        return json({ ok: false, error: "action must be start|stop|restart" }, 400);
      }

      // GET /tts/voices — local voice list (returns [] instead of failing when the service is down)
      if (action === "tts" && ctx.path[1] === "voices" && !ctx.path[2] && ctx.method === "GET") {
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        const health = await localHealth(paths, cfg);
        const data = health?.ok ? await localVoices(paths, cfg, ctx.searchParams.get("force") === "1") : null;
        const entries = readVoiceEntries(paths);
        return json({
          ok: true, running: !!health?.ok, provider: health?.provider || cfg.provider,
          supportsClone: !!data?.supportsClone, voices: data?.voices || [],
          custom: entries.length, voicesJson: paths.voicesJson,
        });
      }

      // POST /tts/voices — create a clone voice (multipart: name/refText/language/xvecOnly/provider/audio)
      if (action === "tts" && ctx.path[1] === "voices" && !ctx.path[2] && ctx.method === "POST") {
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        let form: FormData;
        try { form = await req.formData(); } catch { return json({ ok: false, error: "expected multipart/form-data" }, 400); }
        const name = String(form.get("name") || "").trim();
        const provider = String(form.get("provider") || cfg.provider).trim();
        const refText = String(form.get("refText") || "").trim();
        const language = String(form.get("language") || "Chinese").trim();
        const xvecOnly = String(form.get("xvecOnly") || "") === "true" || String(form.get("xvecOnly") || "") === "1";
        const audio = form.get("audio");
        if (!name) return json({ ok: false, error: "need name" }, 400);
        const id = slugifyVoice(name);
        if (!id) return json({ ok: false, error: "name must contain letters or digits" }, 400);
        const cloneCapable = /hojo-80m|qwen3/.test(provider);
        if (!cloneCapable) return json({ ok: false, error: `provider ${provider} does not support voice cloning` }, 400);
        if (!refText && !(xvecOnly && provider.startsWith("qwen3"))) {
          return json({ ok: false, error: "need refText (transcript of the reference audio)" }, 400);
        }
        if (!audio || typeof (audio as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
          return json({ ok: false, error: "need audio file" }, 400);
        }
        try {
          const buf = Buffer.from(await (audio as File).arrayBuffer());
          const entry = await saveVoice({
            paths, id, label: name, refText, language, xvecOnly, provider,
            audio: { buf, name: (audio as File).name, type: (audio as File).type },
          });
          // Hot reload the service voice list (when it is running).
          const baseUrl = localBaseUrl(paths, cfg);
          let reloaded: unknown = null;
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch(baseUrl + "/admin/load", { method: "POST", signal: ctrl.signal });
            clearTimeout(timer);
            reloaded = res.ok ? await res.json().catch(() => null) : null;
          } catch { /* service down: voice is stored, next start picks it up */ }
          localVoicesCache = { at: 0, baseUrl: "", data: null };
          return json({ ok: true, voice: entry, reloaded });
        } catch (e) {
          return json({ ok: false, error: String((e as Error)?.message || e) }, 400);
        }
      }

      // DELETE /tts/voices/<id> — remove a clone voice (built-ins refused; id whitelist blocks traversal)
      if (action === "tts" && ctx.path[1] === "voices" && ctx.path[2] && ctx.method === "DELETE") {
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        const id = String(ctx.path[2] || "");
        if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(id)) return json({ ok: false, error: "bad id" }, 400);
        const hit = readVoiceEntries(paths).find((v) => v.id === id);
        if (!hit) {
          // Distinguish built-in voices from unknown ids for a clearer panel message.
          const data = await localVoices(paths, cfg, true);
          const builtin = (data?.voices || []).some((v) => v.id === id && v.builtin !== false);
          return json({ ok: false, error: builtin ? "built-in voices cannot be deleted" : "voice not found" }, builtin ? 409 : 404);
        }
        deleteVoiceEntry(paths, id);
        try {
          const baseUrl = localBaseUrl(paths, cfg);
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          await fetch(baseUrl + "/admin/load", { method: "POST", signal: ctrl.signal }).catch(() => null);
          clearTimeout(timer);
        } catch { /* service down */ }
        localVoicesCache = { at: 0, baseUrl: "", data: null };
        return json({ ok: true, id });
      }

      // GET /engine-status — availability snapshot for both engines (panel opener; reused for 10s)
      if (action === "engine-status" && ctx.method === "GET") {
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        const health = await localHealth(paths, cfg);
        try { if (health?.ok) autoEnableLocal(ctx.configDir); } catch { /* non-blocking */ }
        return json({
          ok: true,
          edge: { available: edgeInstalled(), featureOn: featureEnabled("aiti-ai-speek", "tts.edge"), version: edgeVersion() },
          local: {
            featureOn: cfg.enabled,
            up: !!health?.ok,
            status: health?.status || "stopped",
            provider: health?.provider || cfg.provider,
            providerLabel: health?.providerLabel || null,
            baseUrl: localBaseUrl(paths, cfg),
            prepare: readPrepare(paths),
            autoStart: cfg.autoStart,
          },
        });
      }

      // GET /messages?session=<sid>[&idsOnly=1] —— 返回 assistant 消息
      //   idsOnly=1：仅返回 [{id, key}]（key=true 表示含要点），文本按需走 /messages-content 省内存
      //   默认：返回 [{id, text}]（与原行为一致）
      if (action === "messages" && ctx.method === "GET") {
        const sessionId = ctx.searchParams.get("session") || "";
        const idsOnly = ctx.searchParams.get("idsOnly") === "1";
        if (!sessionId) return json({ ok: false, error: "need session" }, 400);
        if (!ctx.core?.readSession) return json({ ok: false, error: "readSession 不可用" }, 501);
        const sess = await ctx.core.readSession(sessionId);
        const msgs = sess?.messages || [];
        const ids = sess?.entryIds || [];
        const out = [];
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.role !== "assistant") continue;
          const id = ids[i] ?? (m as { id?: string }).id ?? null;
          if (!id) continue;
          if (idsOnly) {
            // 只取文本用于 flagMessage（不进响应体）
            const c = m.content;
            let t = "";
            if (typeof c === "string") t = c as string;
            else if (Array.isArray(c)) t = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
            if (!t.trim()) continue;
            const flags = flagMessage(t);
            // pageRank：与 ChatWindow 渲染一致的正经数据（页面可见块序号）——
            //   user/compaction 锚 = 1 块；turn 内 process 条（工具/思考）折叠成「处理详情」组 = 1 块；正文条 = 1 块。
            //   播放条 x/y 用 rank（与页面行号对齐），不再是 msgList 索引（会把 process 条折叠错位）。
            const rank = pageRankOf(sess, i);
            const pageTotal = pageRankOf(sess, -1);
            out.push({ id, key: !!(flags.summary || flags.question || flags.heading), r: rank, rt: pageTotal });
            continue;
          }
          const c = m.content;
          let text = "";
          if (typeof c === "string") text = (c as string).trim() ? (c as string) : "";
          else if (Array.isArray(c)) text = c.filter((b) => b && b.type === "text" && typeof b.text === "string" && (b.text as string).trim()).map((b) => b.text as string).join("\n");
          if (!text) continue;
          out.push({ id, text });
        }
        return json({ ok: true, messages: out });
      }

      // POST /messages-content { session, ids: [], mode? } —— 按 id 批量取 assistant 消息文本（只取请求的；mode=essentials 只返回要点）
      if (action === "messages-content" && ctx.method === "POST") {
        let body: { session?: string; ids?: unknown; mode?: string } = {};
        try { body = await req.json(); } catch { /* 空 JSON */ }
        const sessionId = body?.session || "";
        const wanted = Array.isArray(body?.ids) ? body.ids.map(String) : [];
        const mode = body?.mode === "essentials" ? "essentials" : "full";
        if (!sessionId || !wanted.length) return json({ ok: false, error: "need session + ids" }, 400);
        if (!ctx.core?.readSession) return json({ ok: false, error: "readSession 不可用" }, 501);
        const sess = await ctx.core.readSession(sessionId);
        const msgs = sess?.messages || [];
        const ids = sess?.entryIds || [];
        const map = new Map<string, string>();
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          const id = ids[i] ?? (m as { id?: string }).id ?? null;
          if (!id || m.role !== "assistant") continue;
          const c = m.content;
          let text = "";
          if (typeof c === "string") text = (c ?? "").trim() ? (c as string) : "";
          else if (Array.isArray(c)) text = c.filter((b) => b && b.type === "text" && typeof b.text === "string" && (b.text as string).trim()).map((b) => b.text as string).join("\n");
          // 按 mode 只返回需要的（essentials 只留总结/问题/标题）
          map.set(id, text ? filterByMode(text, mode) : "");
        }
        const items = wanted.map((id) => ({ id, text: map.get(id) ?? "" })).filter((it) => it.text);
        return json({ ok: true, items });
      }

      // GET /events?session=<sid> —— SSE 流（浏览器跟读订阅）
      if (action === "events" && ctx.method === "GET") {
        const sessionId = ctx.searchParams.get("session") || "";
        if (!sessionId) return json({ ok: false, error: "need session" }, 400);
        return sseStream(req, sessionId);
      }

      // POST /steer { sessionId } —— 注入朗读模式提示词（feature 门控；每会话一次）
      if (action === "steer" && ctx.method === "POST") {
        let body: { sessionId?: string } = {};
        try { body = await req.json(); } catch { /* 空 body 容忍 */ }
        const sessionId = body?.sessionId || "";
        if (!sessionId) return json({ ok: false, error: "need sessionId" }, 400);
        if (!featureEnabled("aiti-ai-speek", "steer.enabled")) return json({ ok: false, error: "steer disabled by feature" }, 409);
        // 去重：内存 Set + 持久化文件（跨重启保留）。已注过 → 不再重发。
        if (injectedSessions.has(sessionId) || readSteerRecord(ctx.configDir)[sessionId]) {
          return json({ ok: true, injected: false, note: "already injected" });
        }
        const steer = steerFns.get(sessionId);
        if (!steer) return json({ ok: false, error: "no steer fn for session (may be a placeholder/non-live session)" }, 404);
        markSteerInjected(ctx.configDir, sessionId); // 先记（防并发重入）
        try { await steer(READING_PROMPT); } catch (e) {
          injectedSessions.delete(sessionId);
          return json({ ok: false, error: String(e) }, 500);
        }
        return json({ ok: true, injected: true });
      }

      // GET /voices — voice lists (edge CLI parse + local service) plus both engine states
      if (action === "voices" && ctx.method === "GET") {
        try { autoEnableEdge(ctx.configDir); } catch { /* non-blocking */ }
        // ?force=1 bypasses the --list-voices / which caches (panel "re-probe" button)
        const force = ctx.searchParams.get("force") === "1";
        const payload = await voicesPayloadAsync(force);
        const paths = ttsPaths(ctx);
        const cfg = localCfg();
        const health = await localHealth(paths, cfg, force);
        const localData = health?.ok ? await localVoices(paths, cfg, force) : null;
        try { if (health?.ok) autoEnableLocal(ctx.configDir); } catch { /* non-blocking */ }
        return json({
          ...payload,
          engines: {
            edge: { available: !!payload.installed, featureOn: featureEnabled("aiti-ai-speek", "tts.edge") },
            local: {
              available: !!health?.ok,
              featureOn: cfg.enabled,
              status: health?.status || "stopped",
              provider: health?.provider || cfg.provider,
              providerLabel: health?.providerLabel || null,
              baseUrl: localBaseUrl(paths, cfg),
              supportsClone: !!localData?.supportsClone,
              prepare: readPrepare(paths),
            },
          },
          // undefined (service down) keeps the client's cached list instead of blanking it
          localVoices: localData ? (localData.voices || []) : undefined,
          localVoiceSource: localData ? (health?.provider || cfg.provider) : null,
        });
      }

      // GET /features —— 朗读相关 feature 状态（前端设置面板展示/同步）
      if (action === "features" && ctx.method === "GET") {
        const cfg = localCfg();
        return json({
          ok: true,
          process: featureEnabled("aiti-ai-speek", "process.enabled"),
          steer: featureEnabled("aiti-ai-speek", "steer.enabled"),
          edge: featureEnabled("aiti-ai-speek", "tts.edge"),
          edgeBin: featureValue("aiti-ai-speek", "tts.edge.bin"),
          local: cfg.enabled,
          localProvider: cfg.provider,
          localBaseUrl: cfg.baseUrl,
          localVoice: cfg.voice,
          localAutoStart: cfg.autoStart,
          localIdleTimeout: cfg.idleTimeout,
        });
      }

      // POST /feature { id, enabled?, value? } —— 前端切换布尔 feature，或写入 string feature（tts.edge.bin）
      if (action === "feature" && ctx.method === "POST") {
        let body: { id?: string; enabled?: boolean; value?: unknown } = {};
        try { body = await req.json(); } catch { /* 空 body 容忍 */ }
        const id = body?.id;
        if (!id) return json({ ok: false, error: "need id" }, 400);
        // 仅允许本扩展声明的可控 feature（防任意 id 注入）
        const ALLOWED = new Set([
          "process.enabled", "steer.enabled", "tts.edge", "tts.edge.bin",
          "tts.local", "tts.local.provider", "tts.local.baseUrl", "tts.local.model", "tts.local.voice",
          "tts.local.format", "tts.local.sampleRate", "tts.local.apiKey", "tts.local.autoStart",
          "tts.local.idleTimeout", "tts.local.hfEndpoint", "tts.local.threads",
        ]);
        if (!ALLOWED.has(id)) return json({ ok: false, error: "unknown id" }, 400);
        const reg = (globalThis as Record<string, unknown>).__piWebExt as
          { setFeatureFlag?: (extId: string, fid: string, enabled: boolean) => void;
            setFeatureValue?: (extId: string, fid: string, value: boolean | string) => void } | undefined;
        if (!reg?.setFeatureFlag || !reg?.setFeatureValue) return json({ ok: false, error: "setFeature 不可用" }, 501);
        if (typeof body?.value === "string" || id === "tts.edge.bin") {
          const v = String(body?.value ?? "").trim();
          reg.setFeatureValue("aiti-ai-speek", id, v);
          return json({ ok: true, id, value: v });
        }
        reg.setFeatureFlag("aiti-ai-speek", id, body?.enabled !== false);
        return json({ ok: true, id, enabled: body?.enabled !== false });
      }

      // GET /tts?text&voice&rate&engine=edge|local — single-sentence synthesis (SHA-256 cache; preview)
      if (action === "tts" && ctx.method === "GET") {
        const text = (ctx.searchParams.get("text") || "").trim();
        if (!text) return json({ ok: false, error: "need text" }, 400);
        const engineParam = (ctx.searchParams.get("engine") || "edge").trim();
        if (engineParam === "local") {
          const voice = ctx.searchParams.get("voice") || undefined;
          const r = await localSynthesizeBatch(ctx, [text], voice);
          const it = r.items[0];
          if (!it || !it.cached || !it.ext) {
            return json({ ok: false, engine: "local", error: it?.error || r.error || "local synthesis failed", code: it?.code || r.code, voice: r.voice }, it?.code === "not-ready" ? 503 : 502);
          }
          const file = join(ttsCacheDir(ctx.configDir), it.key + it.ext);
          try {
            const buf = readFileSync(file);
            return new Response(buf, { headers: { "content-type": contentTypeOf(file), "cache-control": "public, max-age=86400", "x-tts-cache": "miss", "x-tts-engine": "local", "accept-ranges": "bytes" } });
          } catch (e) {
            return json({ ok: false, error: String(e) }, 500);
          }
        }
        if (!featureEnabled("aiti-ai-speek", "tts.edge")) return json({ ok: false, error: "edge-tts disabled by feature" }, 409);
        const bin = resolveEdgeBin();
        if (!bin) return json({ ok: false, error: "edge-tts 未安装" }, 501);
        const voice = ctx.searchParams.get("voice") || defaultEdgeVoice();
        const rate = Math.min(2, Math.max(0.5, parseFloat(ctx.searchParams.get("rate") || "1") || 1));
        const cacheDir = ttsCacheDir(ctx.configDir);
        const key = createHash("sha256").update(`edge|${voice}|${rate}|${text}`).digest("hex");
        const file = join(cacheDir, `${key}.mp3`);
        // Cache hit with >0B -> serve; 0B counts as corrupt and is re-synthesized.
        if (existsSync(file)) {
          const st = statSyncSafe(file);
          if (st && st.size > 0) {
            return new Response(readFileSync(file), { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "x-tts-cache": "hit" } });
          }
          try { unlinkSync(file); } catch { /* ignore */ }
        }
        // 合成（edge-tts CLI；限时 30s）
        try {
          mkdirSync(cacheDir, { recursive: true });
          await new Promise<void>((resolve, reject) => {
            execFile(bin, ["--voice", voice, "--rate=" + ratePercent(rate), "--text", text, "--write-media", file], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
          });
        } catch (e) {
          return json({ ok: false, error: "edge-tts 合成失败: " + String(e) }, 500);
        }
        // 写盘后做一次 LRU 评估（删除够 80% MAX_BYTES 停止）
        lruEvict(cacheDir);
        return new Response(readFileSync(file), { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "x-tts-cache": "miss" } });
      }

      // GET /tts-cache-stats —— 缓存状态（设置面板展示：文件数/总大小/使用率）
      if (action === "tts-cache-stats" && ctx.method === "GET") {
        const dir = ttsCacheDir(ctx.configDir);
        const stats = cacheStats(dir);
        const maxBytes = 1024 * 1024 * 1024;
        return json({
          ok: true, count: stats.count, totalBytes: stats.bytes,
          totalMB: (stats.bytes / 1048576).toFixed(2), maxMB: "1024.00",
          usagePercent: ((stats.bytes / maxBytes) * 100).toFixed(1),
          byExt: stats.byExt,
        });
      }

      // GET /tts-cache/<key> — serve cached audio (.mp3 / .wav; used directly by <audio>)
      // ⚠ Range 支持：Chromium 播 <audio> 会发 Range 请求（seek/流式），未返回 206 时部分浏览器
      //   触发 onerror → 前端误报「语音播放失败」。无 Range → 全量 200 + accept-ranges。
      if (action === "tts-cache" && ctx.method === "GET") {
        const key = ctx.path[1] || "";
        if (!/^[a-f0-9]{64}$/.test(key)) return json({ ok: false, error: "bad key" }, 400);
        const cacheDir = ttsCacheDir(ctx.configDir);
        const hit = findCacheFile(cacheDir, key);
        if (!hit) return json({ ok: false, error: "not cached" }, 404);
        const { file, ext } = hit;
        const st = statSyncSafe(file);
        if (!st || st.size === 0) { try { unlinkSync(file); } catch { /* */ } return json({ ok: false, error: "corrupted (empty), regenerate" }, 410); }
        const size = st.size;
        const ctype = contentTypeOf(ext);
        const range = req.headers.get("range");
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          if (m && (m[1] || m[2])) {
            let start = m[1] ? parseInt(m[1], 10) : 0;
            let end = m[2] ? parseInt(m[2], 10) : size - 1;
            if (m[1] === "" && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; } // bytes=-N（尾部段）
            if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
            end = Math.min(end, size - 1);
            const buf = readFileSync(file).subarray(start, end + 1);
            return new Response(buf, {
              status: 206,
              headers: {
                "content-type": ctype, "cache-control": "public, max-age=86400", "x-tts-cache": "hit",
                "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(end - start + 1),
              },
            });
          }
        }
        return new Response(readFileSync(file), { headers: { "content-type": ctype, "cache-control": "public, max-age=86400", "x-tts-cache": "hit", "accept-ranges": "bytes" } });
      }

      // POST /tts-batch { texts: [], voice?, rate?, engine? } — batch synthesis (cache hits return instantly)
      //   Returns [{ key, text, cached, ext }]; the frontend plays /tts-cache/<key>.
      if (action === "tts-batch" && ctx.method === "POST") {
        let body: { texts?: unknown; voice?: string; rate?: number; engine?: string; provider?: string; } = {};
        try { body = await req.json(); } catch { /* 空 JSON 容忍 */ }
        const texts = Array.isArray(body?.texts) ? body.texts.map((t) => String(t).trim()).filter(Boolean) : [];
        if (!texts.length) return json({ ok: false, error: "need texts" }, 400);
        // Local engine: same response shape, produced by the OpenAI-compatible local service.
        if (String(body?.engine || "").trim() === "local") {
          return json(await localSynthesizeBatch(ctx, texts, body?.voice));
        }
        if (!featureEnabled("aiti-ai-speek", "tts.edge")) return json({ ok: false, error: "edge-tts disabled by feature" }, 409);
        const bin = resolveEdgeBin();
        if (!bin) return json({ ok: false, error: "edge-tts 未安装" }, 501);
        const voice = body?.voice || defaultEdgeVoice();
        const rate = Math.min(2, Math.max(0.5, parseFloat(String(body?.rate)) || 1));
        const cacheDir = ttsCacheDir(ctx.configDir);
        mkdirSync(cacheDir, { recursive: true });
        // 纯符号文本（如 "）。"）edge-tts CLI 直接 Traceback：不可读 → 放弃合成（cached:false），
        // 不走 CLI、不浪费 30s×2 重试；前端对不可读句本就应跳过（speakable 过滤）
        const speakables = texts.filter((t) => /[\u4e00-\u9fffA-Za-z0-9]/.test(t));
        // 先算 key，区分命中/未命中（0KB 视为损坏，等同未命中，合成时重写覆盖）
        const items = texts.map((text) => {
          const key = createHash("sha256").update(`edge|${voice}|${rate}|${text}`).digest("hex");
          const st = statSyncSafe(join(cacheDir, `${key}.mp3`));
          const speakable = /[\u4e00-\u9fffA-Za-z0-9]/.test(text);
          return { text, key, cached: !!st && st.size > 0, speakable };
        });
        // 未命中的并发合成（限并发，避免 edge CLI 进程风暴）；纯符号不合成
        const missing = items.filter((it) => !it.cached && it.speakable);
        if (missing.length) {
          const CONC = 4;
          let cursor = 0;
          const synthOne = (text: string, v: string, r: number, out: string) =>
            new Promise<void>((resolve, reject) => {
              execFile(bin, ["--voice", v, "--rate=" + ratePercent(r), "--text", text, "--write-media", out], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
            });
          const worker = async () => {
            while (cursor < missing.length) {
              const it = missing[cursor++];
              // 重试链：原音色×2（隔 800ms）→ 默认音色×1（隔 800ms）。偶发网络/微软端不稳定的
              // 失败常可在重试后成功；每次失败都记录原因（text/attempt/voice/err）。
              const attempts = [
                { voice, label: "primary", delay: 0 },
                { voice, label: "primary-retry", delay: 800 },
                { voice: defaultEdgeVoice(), label: "fallback", delay: 800 },
              ];
              for (let ai = 0; ai < attempts.length; ai++) {
                const a = attempts[ai];
                if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
                try {
                  await synthOne(it.text, a.voice, rate, join(cacheDir, `${it.key}.mp3`));
                  it.cached = true;
                  if (a.label === "fallback") it.degraded = true;
                  if (ai > 0) console.log("[aiti-ai-speek][tts-synth-recov]", { text: String(it.text || "").slice(0, 50), attempt: ai + 1, voice: a.voice });
                  break;
                } catch (e) {
                  console.log("[aiti-ai-speek][tts-synth-fail]", { text: String(it.text || "").slice(0, 60), attempt: ai + 1, voice: a.voice, err: String(e && e.message ? e.message : e).slice(0, 200) });
                }
              } /* 单条失败不阻断；该条 cached 保持 false，前端回落浏览器 */
            }
          };
          await Promise.all(Array.from({ length: Math.min(CONC, missing.length) }, () => worker()));
        }
        // 一批合成后做一次 LRU 评估（单批几千句也要撑住）
        lruEvict(cacheDir);
        return json({ ok: true, voice, rate, items });
      }

      return json({ ok: false, error: "not-found" }, 404);
    },
  },
};
