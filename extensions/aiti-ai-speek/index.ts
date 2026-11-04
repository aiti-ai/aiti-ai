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
 *   - GET /tts + GET /voices：edge-tts 后端音质档（可选，feature 门控；
 *     默认引擎 = 浏览器 Web Speech，零后端）。
 *
 * 复用原则：朗读清洗/分段/播放全在前端（client/src/toSpeechText.ts），
 * 后端不参与消息识别；edge-tts 复用 novel-web 同款命令行方案 + SHA-256 缓存。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { filterByMode, flagMessage } from "./server/speech-filter.ts";
import { ttsCacheDir, cleanExpired, lruEvict } from "./server/tts-cache.ts";

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
  version: "0.1.0",
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
  // 每天一次清理 tts-cache：过期 30d 的 mp3 + 0KB 损坏 + 超 1GB 时 LRU 删到 80%
  // 路径：~/.pi/web/data/aiti-ai-speek/tts-cache/
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
    toolbar: [{ id: "follow", label: "跟读模式", title: "跟读模式：AI 回复自动朗读（可暂停/跳过/切音色）", icon: "icons/volume-2.svg" }],
    // 播放条（会话顶栏，常驻不消失）
    sessionTopbar: [{ id: "bar", label: "跟读播放条" }],
    // assistant 消息 hover 操作区：朗读这条/停止朗读
    assistantMessageActions: [{ id: "read", label: "朗读这条回复" }],
    // 设置面板（dialogs 插槽）
    dialogs: [{ id: "settings", label: "跟读设置" }],
    i18n: {
      "zh-CN": {
        "speek.followOn": "跟读模式已开启，AI 回复将自动朗读",
        "speek.followOff": "开启跟读模式：AI 回复自动朗读",
        "speek.followHidden": "跟读进行中（播放条已隐藏）",
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
        "speek.backgroundContinue": "允许后台继续朗读（浏览器切到后台标签页时不停读）",
      },
      "en": {
        "speek.followOn": "Follow-along on: AI replies will be read aloud",
        "speek.followOff": "Turn on follow-along reading",
        "speek.followHidden": "Follow-along active (bar hidden)",
        "speek.play": "Play",
        "speek.pause": "Pause",
        "speek.prev": "Previous message",
        "speek.next": "Next message",
        "speek.replay": "Re-read current page",
        "speek.stop": "Stop & clear queue",
        "speek.queue": "{cur}/{total} queued",
        "speek.settings": "Follow-along settings",
        "speek.readThis": "Start reading",
        "speek.stopReading": "Stop reading",
        "speek.backgroundContinue": "Continue reading in background (don't stop when tab loses focus)",
      },
    },
  },

  // 功能管理（extman 逐项启停；core 持久化 features.json）
  features: [
    { id: "steer.enabled", label: "朗读提示词注入（开启跟读时提示 AI 优化输出，如先给结论/口语化）", group: "AI 优化", default: true },
    { id: "tts.edge", label: "edge-tts 后端音质档（已安装时自动开启；效果好于浏览器 Web Speech）", group: "引擎", default: false },
    { id: "tts.edge.bin", type: "string", label: "edge-tts 可执行文件路径（留空自动探测 ~/.local/bin、PATH、pipx）", group: "引擎", value: "", placeholder: "如 C:\\Python312\\Scripts\\edge-tts.exe" },
    { id: "process.enabled", label: "朗读过程（把 AI 的中间叙述也读出来，如「让我看一下…」「我先确认…」；跳过 thinking 与工具执行）", group: "朗读内容", default: false },
    { id: "minChars", type: "string", label: "忽略阈值（回复少于 N 字不朗读，避免“好的”“收到”刷屏）", group: "队列", value: "8", placeholder: "8" },
  ],

  server: {
    async startup(ctx?: { configDir?: string; features?: { get(extIdOrFid?: string, fid?: string): boolean | string | undefined } }) {
      hostFeatures = (ctx as any)?.features ?? null; // DI 方案 P1
      // edge-tts 已装 → 自动开 tts.edge feature（仅一次；用户此后显式关掉不会被覆盖）
      try { autoEnableEdge(ctx?.configDir); } catch { /* 不阻塞启动 */ }
      console.log("[aiti-ai-speek] 跟读模式就绪 · onAgentSettled→SSE + steer + edge-tts" + (edgeInstalled() ? "(已安装)" : "(未安装)"));
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

    async api(req: Request, ctx: { method: string; path: string[]; searchParams: URLSearchParams; configDir?: string; core?: { readSession?: (id: string) => Promise<{ messages?: Array<{ role?: string; content?: unknown }> } | null> } }) {
      const [action] = ctx.path;

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

      // GET /voices —— edge-tts 音色表（动态：--list-voices 解析）+ 后端状态（设置面板展示）
      if (action === "voices" && ctx.method === "GET") {
        try { autoEnableEdge(ctx.configDir); } catch { /* 不阻塞 */ }
        // ?force=1：绕过 --list-voices 缓存与 which 探测缓存（设置面板「重新探测」用，AI 刚装好即见效）
        const force = ctx.searchParams.get("force") === "1";
        // 全异步探测（性能修复：冷缓存不再 execFileSync 冻结主线程；结果写回同步路径缓存）
        return json(await voicesPayloadAsync(force));
      }

      // GET /features —— 朗读相关 feature 状态（前端设置面板展示/同步）
      if (action === "features" && ctx.method === "GET") {
        return json({
          ok: true,
          process: featureEnabled("aiti-ai-speek", "process.enabled"),
          steer: featureEnabled("aiti-ai-speek", "steer.enabled"),
          edge: featureEnabled("aiti-ai-speek", "tts.edge"),
          edgeBin: featureValue("aiti-ai-speek", "tts.edge.bin"),
        });
      }

      // POST /feature { id, enabled?, value? } —— 前端切换布尔 feature，或写入 string feature（tts.edge.bin）
      if (action === "feature" && ctx.method === "POST") {
        let body: { id?: string; enabled?: boolean; value?: unknown } = {};
        try { body = await req.json(); } catch { /* 空 body 容忍 */ }
        const id = body?.id;
        if (!id) return json({ ok: false, error: "need id" }, 400);
        // 仅允许本扩展声明的可控 feature（防任意 id 注入）
        const ALLOWED = new Set(["process.enabled", "steer.enabled", "tts.edge", "tts.edge.bin"]);
        if (!ALLOWED.has(id)) return json({ ok: false, error: "unknown id" }, 400);
        const reg = (globalThis as Record<string, unknown>).__piWebExt as
          { setFeatureFlag?: (extId: string, fid: string, enabled: boolean) => void;
            setFeatureValue?: (extId: string, fid: string, value: boolean | string) => void } | undefined;
        if (!reg?.setFeatureFlag || !reg?.setFeatureValue) return json({ ok: false, error: "setFeature 不可用" }, 501);
        if (id === "tts.edge.bin") {
          const v = String(body?.value ?? "").trim();
          reg.setFeatureValue("aiti-ai-speek", id, v);
          return json({ ok: true, id, value: v });
        }
        reg.setFeatureFlag("aiti-ai-speek", id, body?.enabled !== false);
        return json({ ok: true, id, enabled: body?.enabled !== false });
      }

      // GET /tts?text&voice&rate —— edge-tts 合成（SHA-256 缓存）
      if (action === "tts" && ctx.method === "GET") {
        if (!featureEnabled("aiti-ai-speek", "tts.edge")) return json({ ok: false, error: "edge-tts disabled by feature" }, 409);
        const bin = resolveEdgeBin();
        if (!bin) return json({ ok: false, error: "edge-tts 未安装" }, 501);
        const text = (ctx.searchParams.get("text") || "").trim();
        if (!text) return json({ ok: false, error: "need text" }, 400);
        const voice = ctx.searchParams.get("voice") || defaultEdgeVoice();
        const rate = Math.min(2, Math.max(0.5, parseFloat(ctx.searchParams.get("rate") || "1") || 1));
        const cacheDir = ttsCacheDir(ctx.configDir);
        const key = createHash("sha256").update(`edge|${voice}|${rate}|${text}`).digest("hex");
        const file = join(cacheDir, `${key}.mp3`);
        // 命中且 >0B 直接返回；0B 视为损坏，删了重新合成
        if (existsSync(file)) {
          const st = statSyncSafe(file);
          if (st && st.size > 0) {
            return new Response(readFileSync(file), { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "x-tts-cache": "hit" } });
          }
          try { unlinkSync(file); } catch { /* 删失败忽略 */ }
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
        if (!existsSync(dir)) return json({ ok: true, count: 0, totalBytes: 0, totalMB: "0.00", maxMB: "1024.00", usagePercent: "0.0" });
        let count = 0, total = 0;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".mp3")) continue;
          const st = statSyncSafe(join(dir, f));
          if (st) { count++; total += st.size; }
        }
        const maxBytes = 1024 * 1024 * 1024;
        return json({ ok: true, count, totalBytes: total, totalMB: (total / 1048576).toFixed(2), maxMB: "1024.00", usagePercent: ((total / maxBytes) * 100).toFixed(1) });
      }

      // GET /tts-cache/<key> —— 返回已合成的缓存 mp3 文件（前端 <audio> 直接用；命中秒回）
      // ⚠ Range 支持：Chromium 播 <audio> 会发 Range 请求（seek/流式），未返回 206 时部分浏览器
      //   触发 onerror → 前端误报「语音播放失败」。无 Range → 全量 200 + accept-ranges。
      if (action === "tts-cache" && ctx.method === "GET") {
        const key = ctx.path[1] || "";
        if (!/^[a-f0-9]{64}$/.test(key)) return json({ ok: false, error: "bad key" }, 400);
        const cacheDir = ttsCacheDir(ctx.configDir);
        const file = join(cacheDir, `${key}.mp3`);
        if (!existsSync(file)) return json({ ok: false, error: "not cached" }, 404);
        const st = statSyncSafe(file);
        if (!st || st.size === 0) { try { unlinkSync(file); } catch { /* */ } return json({ ok: false, error: "corrupted (empty), regenerate" }, 410); }
        const size = st.size;
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
                "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "x-tts-cache": "hit",
                "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(end - start + 1),
              },
            });
          }
        }
        return new Response(readFileSync(file), { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "x-tts-cache": "hit", "accept-ranges": "bytes" } });
      }

      // POST /tts-batch { texts: [], voice?, rate? } —— 一次批量合成多句（命中缓存秒回，未命合并发）
      //   返回 [{ key, text, cached }]，前端 <<audio>> 用 /tts-cache/<key> 播。
      if (action === "tts-batch" && ctx.method === "POST") {
        if (!featureEnabled("aiti-ai-speek", "tts.edge")) return json({ ok: false, error: "edge-tts disabled by feature" }, 409);
        const bin = resolveEdgeBin();
        if (!bin) return json({ ok: false, error: "edge-tts 未安装" }, 501);
        let body: { texts?: unknown; voice?: string; rate?: number } = {};
        try { body = await req.json(); } catch { /* 空 JSON 容忍 */ }
        const texts = Array.isArray(body?.texts) ? body.texts.map((t) => String(t).trim()).filter(Boolean) : [];
        if (!texts.length) return json({ ok: false, error: "need texts" }, 400);
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
