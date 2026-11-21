/**
 * speaker —— 跟读模式核心 store + 播放器（模块级单例，非 React）
 *
 * 架构（极简版）：
 *   - msgList[sessionId] = [{ id, key }] —— 持久消息索引，只存 id+要点标记
 *   - textCache[sessionId][id] = text —— 按需从服务端拉的文本缓存
 *   - 当前播放位置 = state.curIndex（msgList 中的索引）+ state.curSeg（当前句索引）
 *   - 切消息 = 改 curIndex，调 playAt(idx)
 *   - 切句子 = 改 curSeg，调 playCur()
 *   - 播放器：默认浏览器 Web Speech，可选 edge-tts（<audio>）
 *   - SSE 订阅：收到 settled → 追加到 msgList 末尾 + 立即入播
 *
 * 组件经 subscribe() 订阅变化（React useSyncExternalStore / useState+useEffect）。
 */

import { toSpeechSegments, filterSegments, chunkFileForSpeech } from "./toSpeechText.js";
import { extSvc, t } from "./host-shim.ts";

const LS_SETTINGS = "aiti-ai-speek:settings";
const LS_FOLLOW = "aiti-ai-speek:follow";
const LS_BAR = "aiti-ai-speek:bar";
const LS_PROGRESS = "aiti-ai-speek:progress";
const LS_READPOS = "aiti-ai-speek:readpos";
const LS_ENGINE_UPGRADED = "aiti-ai-speek:engine-upgraded";

// 引擎语义：auto = 已装 edge-tts 时优先（效果好），否则浏览器 Web Speech
const DEFAULT_SETTINGS = {
  voice: "",
  rate: 1,
  mode: "full",
  engine: "auto",
  minChars: 8,
  steer: true,
  backgroundContinue: false,
  followScroll: "smart", // smart=智能跟随(默认) | always=始终拉回 | off=只高亮不滚（点进度数字跳回）
};

const READ_LIMIT = 20; // 单次最多连续播的条数（防止巨长会话一次入播太深）

const state = {
  followOn: false,
  barVisible: false,
  settings: { ...DEFAULT_SETTINGS },
  // 会话消息索引 { [sessionId]: [{ id, key }] } —— 持久，切换 session 时释放
  msgList: {},
  allMessagesLoaded: {}, // { [sessionId]: boolean }
  // 文本缓存 { [sessionId]: { [id]: text } } —— 切换 session 时释放
  textCache: {},
  // wire 帧观察账本 { [sessionId]: 有序 id 数组 } —— cacheMessageText 记账；
  // 外部后端会话（/messages 空列表）在 ensureSessionLoaded 合成朗读列表的唯一数据源
  wireMsgIds: {},
  // 当前播放位置（-1 = 未开始）
  curIndex: -1,        // msgList[activeSessionId] 中的索引
  curSeg: 0,           // 当前消息的第几句
  curSegs: [],         // 当前消息分好的句子（避免每次重切都重算）
  playing: false,
  paused: false,
  starting: false,
  audio: null,         // edge 引擎的 <audio>
  edgePool: {},        // { [key]: { loaded, loading, errored, audioSrc } }  TTS prefetch pool (edge + local)
  scrollListener: null,    // 滚动事件监听器句柄
  voices: [],
  edgeVoices: [],
  edgeAvailable: false,
  // local engine (OpenAI-compatible service) state
  localStatus: "stopped",   // stopped | starting | loading | ready | error | unsupported
  localProvider: "",        // provider reported by the service (hojo-40m ...)
  localProviderLabel: "",
  localSupportsClone: false,
  localVoices: [],          // [{ id, label, sample, builtin, provider, language }]
  localPrepare: null,       // prepare.json snapshot { phase, percent, message }
  localInfo: null,          // GET /tts/info snapshot
  localBaseUrl: "",
  localVm: null,            // engines.local status block from /voices
  // { installed, bin, version, platform, featureOn, installHint } —— /voices 富状态
  edgeStatus: null,
  browserUnsupported: false,
  engineUpgraded: false,
  processOn: false,
  processLoaded: false,
  backlog: 0,
  lastError: null,
  pageFocused: true,
  apiUrl: (p) => p,
  // file-read bucket (aiti-editor 🔊 read entry; null = not fileMode)
  // { id: "file:<path>", path, name, returnTo, chunkStartLine: { [chunkId]: startLine } }
  fileBucket: null,
};

const listeners = new Set();
function notify() {
  try {
    // 鬼态自愈：跟读已关却仍处于播放态（无音频、无窗口）→ 清理，避免界面显示「播放中」却不读
    if (!state.followOn && state.playing && !state.audio && !state.curSegs.length) {
      state.playing = false; state.paused = false; state.starting = false;
      state.curIndex = -1; state.curSeg = 0;
    }
  } catch { /* noop */ }

  try {
    const seg = state.curSegs[state.curSeg] || null;
    window.__speekDebug = {
      curIndex: state.curIndex, curSeg: state.curSeg,
      curId: curId(), segText: seg ? seg.text : null, segMatch: seg ? seg.match : null,
      msgListLen: activeSessionId ? (state.msgList[activeSessionId] || []).length : 0,
      followOn: state.followOn, playing: state.playing,
      sseSettledCount: typeof sseSettledCount === "number" ? sseSettledCount : -1,
      sseConnectedMs: sseConnectedAt ? (Date.now() - sseConnectedAt) : -1,
      esClosed: !esRef,
    };
  } catch { /* noop */ }
  for (const l of [...listeners]) l();
}
export function subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function getState() { return state; }
export function setApiUrl(fn) { state.apiUrl = fn; }

function persist() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch { /* noop */ }
  try { localStorage.setItem(LS_FOLLOW, state.followOn ? "1" : "0"); } catch { /* noop */ }
  try { localStorage.setItem(LS_BAR, state.barVisible ? "1" : "0"); } catch { /* noop */ }
  try { localStorage.setItem(LS_ENGINE_UPGRADED, state.engineUpgraded ? "1" : "0"); } catch { /* noop */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "null");
    if (s && typeof s === "object") state.settings = { ...DEFAULT_SETTINGS, ...s };
  } catch { /* 损坏回落默认 */ }
  try { state.followOn = localStorage.getItem(LS_FOLLOW) === "1"; } catch { /* noop */ }
  try { state.barVisible = localStorage.getItem(LS_BAR) === "1"; } catch { /* noop */ }
  try { state.engineUpgraded = localStorage.getItem(LS_ENGINE_UPGRADED) === "1"; } catch { /* noop */ }
}
load();

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
  notify();
}
export function setFollow(on) {
  const wasOn = state.followOn;
  state.followOn = !!on;
  if (on) {
    state.barVisible = true;
    // 跟读开启即自动开播（不依赖 React effect 时序/页面焦点——首次点跟读必须立刻有声音）；
    // 置抑制标志防 PlaybackBar「开启即自动读」再启一轮。
    if (!wasOn && activeSessionId) {
      readOnFollowSuppress = true;
      lastIntentionalStartAt = Date.now();
      startFollowFromPageTop(activeSessionId);
    }
  } else {
    stop(); state.barVisible = false; readOnFollowSuppress = false;
    // Turning off follow-read = ending file-read semantics: clear the bucket + clear editor follow highlights
    if (state.fileBucket) { state.fileBucket = null; clearEditorFollow(); }
  }
  persist();
  notify();
}
export function setBarVisible(v) {
  state.barVisible = !!v;
  persist();
  notify();
}
export function toggleFollow() {
  if (!state.followOn) { setFollow(true); return; }
  // 条没显示 → 只打开条（无条件，不依赖 playing：启动中/自然播完/失焦恢复间隙都不误关跟读）
  if (!state.barVisible) { setBarVisible(true); return; }
  setFollow(false);
}
export function setEdgeInfo(available, voices) {
  state.edgeAvailable = !!available;
  if (Array.isArray(voices)) {
    state.edgeVoices = voices;
    // Prune a stale edge voice only while the edge engine is actually the one playing.
    // Local/clone voice ids never appear in the edge list, so validating unconditionally reset
    // the user's local selection to default on every /voices refresh (settings open / init).
    if (resolvedEngine() === "edge" && state.settings.voice && !voices.some((v) => v && v.id === state.settings.voice)) {
      state.settings.voice = "";
      persist();
    }
  }
  notify();
}
/** 记录 /voices 富状态（安装/版本/路径/平台/feature/安装提示）——设置面板展示用 */
export function setEdgeStatus(status) {
  if (!status || typeof status !== "object") return;
  state.edgeStatus = status;
  if (typeof status.edgeAvailable === "boolean" || typeof status.installed === "boolean") {
    setEdgeInfo(status.edgeAvailable ?? status.installed, status.voices || state.edgeVoices);
  }
  notify();
}
// ── local engine (OpenAI-compatible service @127.0.0.1:8768) ──────────────────
/** Apply the `engines.local` block returned by /voices (or /engine-status). */
export function setLocalStatus(block) {
  if (!block || typeof block !== "object") return;
  state.localVm = block;
  state.localProvider = block.provider || state.localProvider || "";
  state.localProviderLabel = block.providerLabel || state.localProviderLabel || "";
  state.localBaseUrl = block.baseUrl || state.localBaseUrl || "";
  if (typeof block.supportsClone === "boolean") state.localSupportsClone = block.supportsClone;
  if (block.prepare) state.localPrepare = block.prepare;
  if (block.available) state.localStatus = "ready";
  else if (block.status === "loading" || block.status === "starting") state.localStatus = "loading";
  else if (block.status === "error") state.localStatus = "error";
  else state.localStatus = "stopped";
  notify();
}
/** Replace the local voice list (keep the previous result while the service is not ready). */
export function setLocalVoices(list) {
  if (Array.isArray(list)) {
    state.localVoices = list;
    // Symmetric pruning: a local provider switch (40M <-> 80M) invalidates built-in ids.
    // Only prune while local is playing and the list is non-empty (a stopped service keeps
    // the previous list so the dropdown is never blanked out).
    if (resolvedEngine() === "local" && list.length && state.settings.voice
        && !list.some((v) => v && v.id === state.settings.voice)) {
      state.settings.voice = "";
      persist();
    }
  }
  notify();
}
/** Voice list for the active engine (settings panel dropdown). */
export function engineVoices() {
  return ttsBackendNow() === "local"
    ? (state.localVoices || []).map((v) => ({ id: v.id, label: v.label || v.id, sample: v.sample }))
    : (state.edgeVoices || []).map((v) => ({ id: v.id, label: v.label, sample: v.sample }));
}

/** GET /tts/info — full local service snapshot (health/prepare/paths/sizes). */
export async function fetchLocalInfo(opts) {
  try {
    const q = opts && opts.log ? "?log=1" : "";
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts/info") + q);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.ok) return null;
    state.localInfo = d;
    state.localPrepare = d.prepare || state.localPrepare;
    if (d.running) state.localStatus = "ready";
    else if (d.health && (d.health.status === "loading" || d.health.status === "starting")) state.localStatus = "loading";
    else if (d.health && d.health.status === "error") state.localStatus = "error";
    else if (d.prepare && ["venv", "deps", "download"].includes(String(d.prepare.phase))) state.localStatus = "loading";
    else state.localStatus = "stopped";
    if (d.providerActual) state.localProvider = d.providerActual;
    if (d.health && d.health.providerLabel) state.localProviderLabel = d.health.providerLabel;
    if (d.health && d.health.provider) state.localProvider = d.health.provider;
    if (d.baseUrl) state.localBaseUrl = d.baseUrl;
    notify();
    return d;
  } catch {
    return null;
  }
}

/**
 * POST /tts/ensure — probe, then bootstrap+start when needed.
 * Returns { running } | { starting } | { error }. Progress arrives via /tts/progress (SSE).
 */
export async function ensureLocal(provider) {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts/ensure"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: provider || undefined }),
    });
    const d = await res.json().catch(() => null);
    if (!d) return { running: false, error: "ensure failed" };
    if (d.prepare) state.localPrepare = d.prepare;
    if (d.provider) state.localProvider = d.provider;
    if (d.running) {
      state.localStatus = "ready";
      notify();
      fetchLocalVoices(true);
      return d;
    }
    if (d.starting) {
      state.localStatus = "loading";
      notify();
      subscribeLocalProgress();
      return d;
    }
    state.localStatus = d.error ? "error" : "stopped";
    if (d.error) state.lastError = d.error;
    notify();
    return d;
  } catch (e) {
    return { running: false, error: String((e && e.message) || e) };
  }
}

/** POST /tts/control { action: start|stop|restart }. */
export async function controlLocal(action, provider) {
  try {
    if (action === "stop") state.localStatus = "stopped";
    else state.localStatus = "loading";
    notify();
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts/control"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, provider: provider || undefined }),
    });
    const d = await res.json().catch(() => null);
    if (!d || !d.ok) {
      state.localStatus = "error";
      state.lastError = (d && d.error) || `${action} failed`;
      notify();
      return d || { ok: false };
    }
    if (action === "stop") {
      state.localStatus = "stopped";
      state.localVoices = [];
      notify();
      return d;
    }
    if (d.running) { state.localStatus = "ready"; notify(); fetchLocalInfo(); fetchLocalVoices(true); }
    else { state.localStatus = "loading"; notify(); subscribeLocalProgress(); }
    return d;
  } catch (e) {
    state.localStatus = "error";
    state.lastError = String((e && e.message) || e);
    notify();
    return { ok: false, error: state.lastError };
  }
}

/** GET /tts/voices — local voice list (+ custom count). */
export async function fetchLocalVoices(force) {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts/voices") + (force ? "?force=1" : ""));
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.ok) return null;
    // Running service wins even when the list is empty (a provider switch to 80M has no built-ins);
    // a stopped service keeps the previous list so the dropdown is not blanked out.
    if (Array.isArray(d.voices) && (d.running || !state.localVoices.length)) state.localVoices = d.voices;
    if (typeof d.supportsClone === "boolean") state.localSupportsClone = d.supportsClone;
    if (d.provider) state.localProvider = d.provider;
    state.localCustomVoices = typeof d.custom === "number" ? d.custom : state.localCustomVoices;
    notify();
    return d;
  } catch {
    return null;
  }
}

/** POST /tts/voices (multipart) — create a clone voice; audio is a Blob or File. */
export async function createLocalVoice({ name, refText, language, xvecOnly, provider, blob, filename }) {
  try {
    const fd = new FormData();
    fd.append("name", String(name || ""));
    fd.append("refText", String(refText || ""));
    fd.append("language", String(language || "Chinese"));
    fd.append("xvecOnly", xvecOnly ? "true" : "false");
    if (provider) fd.append("provider", provider);
    fd.append("audio", blob, filename || "ref.wav");
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts/voices"), { method: "POST", body: fd });
    const d = await res.json().catch(() => null);
    if (d && d.ok) { await fetchLocalVoices(true); return d; }
    return d || { ok: false, error: `upload failed (${res.status})` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** DELETE /tts/voices/<id>. */
export async function deleteLocalVoice(id) {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts/voices/") + encodeURIComponent(id), { method: "DELETE" });
    const d = await res.json().catch(() => null);
    if (d && d.ok) { await fetchLocalVoices(true); return d; }
    return d || { ok: false, error: `delete failed (${res.status})` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── preparation progress (SSE on prepare.json; event driven, no polling) ──────
let localProgressEs = null;
let localProgressDone = false;
export function subscribeLocalProgress() {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;
  if (localProgressEs) return;
  localProgressDone = false;
  try {
    const es = new EventSource(state.apiUrl("/api/extensions/aiti-ai-speek/tts/progress"));
    localProgressEs = es;
    es.addEventListener("prepare", (ev) => {
      try {
        const p = JSON.parse(ev.data || "null");
        if (!p) return;
        state.localPrepare = p;
        const phase = String(p.phase || "");
        if (phase === "ready") {
          localProgressDone = true;
          state.localStatus = "ready";
          notify();
          closeLocalProgress();
          fetchLocalInfo().then(() => fetchLocalVoices(true));
          return;
        }
        if (phase === "failed") {
          localProgressDone = true;
          state.localStatus = "error";
          state.lastError = p.message || "local TTS preparation failed";
          notify();
          closeLocalProgress();
          return;
        }
        if (phase === "idle-stop") {
          state.localStatus = "stopped";
          notify();
          closeLocalProgress();
          return;
        }
        state.localStatus = "loading";
        notify();
      } catch { /* bad frame ignored */ }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; stop trying once a terminal phase was seen.
      if (localProgressDone) closeLocalProgress();
    };
  } catch { /* EventSource unavailable */ }
}
function closeLocalProgress() {
  if (!localProgressEs) return;
  try { localProgressEs.close(); } catch { /* noop */ }
  localProgressEs = null;
}

/** Feature writers used by the settings panel (boolean / string). */
export async function setFeatureFlagApi(id, enabled) {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/feature"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, enabled: !!enabled }),
    });
    return res.ok;
  } catch { return false; }
}
export async function setFeatureValueApi(id, value) {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/feature"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, value: String(value ?? "") }),
    });
    return res.ok;
  } catch { return false; }
}

/** Engine actually in use: auto = edge -> local -> browser (Q1=A); explicit edge without the CLI falls back to browser; explicit local stays local (failures surface). */
export function resolvedEngine() {
  const e = state.settings.engine;
  if (e === "local") return "local";
  if (e === "edge") return state.edgeAvailable ? "edge" : "browser";
  if (e === "auto") {
    if (state.edgeAvailable) return "edge";
    if (localReady()) return "local";
    return "browser";
  }
  return "browser";
}
/** True when the local service answered /health (ready). */
export function localReady() {
  return state.localStatus === "ready";
}
/** Which non-browser backend carries playback right now (null = browser Web Speech). */
function ttsBackendNow() {
  const e = resolvedEngine();
  if (e === "local") return "local";
  if (e === "edge" || (state.browserUnsupported && state.edgeAvailable)) return "edge";
  return null;
}
/** Voice id used for the active backend (local falls back to the service's first voice). */
function activeVoiceId() {
  if (ttsBackendNow() === "local") {
    return state.settings.voice || (state.localVoices && state.localVoices[0] && state.localVoices[0].id) || "";
  }
  return state.settings.voice || defaultEdgeVoice();
}
/** Pool key for one sentence under the active backend (local omits rate: playbackRate carries it). */
function ttsPoolKey(seg) {
  const backend = ttsBackendNow();
  if (backend === "local") {
    return `local|${state.localProvider || ""}|${activeVoiceId()}|${seg.text}`;
  }
  return `edge|${activeVoiceId()}|${state.settings.rate}|${seg.text}`;
}
/** 朗读失败提示（一次性 toast）：失败即告知用户，不静默降级 */
export function failToast(text) {
  state.failToast = { text, ts: Date.now() };
  failToastAt = Date.now(); // 失败窗口：5s 内自动追读（settle/updating）不重启（防失败风暴）
  if (state.playing) { state.playing = false; state.starting = false; }
  try { if (state.audio) { state.audio.pause(); state.audio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  notify();
}
/** 默认 edge 音色：动态列表第一个（服务端已把晓晓排到首位；列表空则兜底晓晓 id） */
export function defaultEdgeVoice() {
  return (state.edgeVoices && state.edgeVoices[0] && state.edgeVoices[0].id) || "zh-CN-XiaoxiaoNeural";
}
export async function fetchFeatures() {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/features"));
    if (!res.ok) return;
    const d = await res.json();
    if (d && typeof d.process === "boolean") { state.processOn = d.process; state.processLoaded = true; notify(); }
    if (d && typeof d.edge === "boolean") setEdgeInfo(d.edge, state.edgeVoices);
    if (d && typeof d.edgeBin === "string") { if (state.edgeStatus) state.edgeStatus = { ...state.edgeStatus, edgeBin: d.edgeBin }; }
  } catch { /* 静默 */ }
}
export async function setEdgeBinPath(path) {
  const v = String(path ?? "").trim();
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/feature"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tts.edge.bin", value: v }),
    });
    if (res.ok) { if (state.edgeStatus) state.edgeStatus = { ...state.edgeStatus, edgeBin: v }; notify(); return true; }
  } catch { /* noop */ }
  return false;
}
export async function toggleProcess() {
  const next = !state.processOn;
  state.processOn = next; state.processLoaded = true; notify();
  try {
    await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/feature"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "process.enabled", enabled: next }),
    });
  } catch { /* noop */ }
}
export function setVoices(voices) { state.voices = Array.isArray(voices) ? voices : []; notify(); }

/** 点读抑制标志：readMessageFrom 刚发起过点读时置位，PlaybackBar「开启即自动读」跳过（防止双启动） */
let readOnFollowSuppress = false;
/** 播放令牌：每次重启动（点读/换条/停止）自增；语音回调只认当前令牌，防取消后残留 onend 再推进 → 双声 */
let playToken = 0;
function bumpPlayToken() { return ++playToken; }

// ── 播放中屏幕唤醒（Screen Wake Lock）──────────────
// 跟读播放时保持屏幕常亮（手机锁屏/自动息屏会中断听书）；
// 页面隐藏时浏览器自动释放 → visibilitychange 回前台且仍播放时重新获取。
let wakeLockSentinel = null;
async function acquireWakeLock() {
  try {
    if (!state.playing || state.paused) return;
    if (wakeLockSentinel) return; // 已持有
    if (!("wakeLock" in navigator)) return; // 不支持（桌面浏览器常见）静默跳过
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    // 浏览器（如手机熄屏前）可能不经 stop 直接释放 → 哨兵失效时置空以便重新申请
    wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = null; });
  } catch { /* 权限/兼容问题忽略：不阻塞朗读 */ }
}
async function releaseWakeLock() {
  try { if (wakeLockSentinel) { await wakeLockSentinel.release(); wakeLockSentinel = null; } } catch { /* noop */ }
}
// 页面回前台且仍在播 → 重新获取（隐藏期间浏览器已自动释放）
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.playing && !state.paused) acquireWakeLock();
});

// ── 会话与当前会话 ──
let activeSessionId = null;
let lastIntentionalStartAt = 0; // 主动启动（恢复/开跟读/点读）时刻；SSE settle 不与其竞争
let resumeOnFocusReturn = false;
let readerBC = null;
let failToastAt = 0; // 最近失败时刻（自动追读抑制窗口）
const MY_ID = Math.random().toString(36).slice(2);

// ── 句级进度（停止时记录，下次续读从该句继续） ──
let progress = {};
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(LS_PROGRESS) || "{}") || {}; } catch { return {}; }
}
function saveProgress() { try { localStorage.setItem(LS_PROGRESS, JSON.stringify(progress)); } catch { /* noop */ } }
// 防抖持久化：播放中每句 recordProgress 会高频调用——合并为 400ms 一次写（progress 含多会话键，
// 每句整对象 stringify+setItem 在大会话下有累加开销）。关键点（stop/END/跳转）仍走同步 saveProgress。
let progressSaveTimer = 0;
function saveProgressDebounced() {
  if (progressSaveTimer) return;
  progressSaveTimer = setTimeout(() => { progressSaveTimer = 0; saveProgress(); }, 400);
}
progress = loadProgress();

// ── 消息级书签（续读用） ──
let lastReadPos = {}; // { [sessionId]: sourceId }
function loadLastReadPos() {
  try { const o = JSON.parse(localStorage.getItem(LS_READPOS) || "{}"); if (o && typeof o === "object") lastReadPos = o; } catch { /* noop */ }
}
function saveLastReadPos() { try { localStorage.setItem(LS_READPOS, JSON.stringify(lastReadPos)); } catch { /* noop */ } }
loadLastReadPos();

function recordProgress() {
  // per-message 句序（旧版以 curId() 为键存整批合并句号：换批/续读会串到别的消息）
  const id = curSegId() || curId();
  if (id) { progress[id] = segIndexInMessage(); saveProgressDebounced(); }
}
function clearProgressFor(id) {
  if (id && progress[id] != null) { delete progress[id]; saveProgress(); }
}
/** 读完标记：该消息全部句已播完 → progress[id] = "e"（读完了）。
 *  resume 读到该消息时不再重读（跳到下一条/等待新消息）；AI 继续追加新消息（index 更大）正常续读。 */
function markProgressDone(id) {
  if (id) { progress[id] = "e"; saveProgress(); }
}

// ── 工具 ──
function curId() {
  const list = activeSessionId ? state.msgList[activeSessionId] : null;
  if (!list || state.curIndex < 0 || state.curIndex >= list.length) return null;
  return list[state.curIndex].id;
}

/** 当前句所属的消息 id（按 curSegs[curSeg]._id 实时判断，不依赖 curIndex 是否已同步） */
function curSegId() {
  const seg = state.curSegs[state.curSeg];
  return seg && seg._id ? seg._id : null;
}

/**
 * 把 state.curIndex 同步到「当前句所属消息」在 msgList 中的真实索引。
 * 旧实现把 curIndex 固定为批次起点（from），导致 curId()/高亮/prev/skip/进度
 * 全部停留在批次第一条——已改为逐句同步。同步时顺带把 lastReadPos 维护为「当前消息」
 * （任何瞬态空基准的 prev/skip/停止恢复都能拿到真实当前值）。
 */
function syncCurIndex() {
  const segId = curSegId();
  if (!segId) return;
  const list = activeSessionId ? state.msgList[activeSessionId] : null;
  if (!list || !list.length) return;
  const idx = list.findIndex((it) => it.id === segId);
  if (idx >= 0) {
    if (idx !== state.curIndex) state.curIndex = idx;
    lastReadPos[activeSessionId] = segId; // 实时基准（不只在批载/stop 时写）
    saveLastReadPos(); // 必须持久化：刷新后恢复（否则页面加载时基准丢失 → 220/220 而非 214/220）
    recordProgress(); // 句级进度变化即记录（第几段第几句）：随时中断/刷新，下次 resume 从该句续读
  }
}

/** 当前句在其所属消息内的句序（0 起）。progress 按此记录（per-message），跨批不串。
 *  O(1)：curSegs 按消息连续分组（窗口加载/追加时同消息句连续），句序 = curSeg - curSegStartMap[segId]；
 *  之前每句遍历 < curSeg（O(N)）——长句多消息播放开销大。 */
function segIndexInMessage() {
  const segId = curSegId();
  if (!segId) return 0;
  const start = state.curSegStartMap && state.curSegStartMap[segId];
  if (typeof start === "number" && state.curSeg >= start) return state.curSeg - start;
  // 兜底（无映射）：遍历
  let n = 0;
  for (let i = 0; i < state.curSeg && i < state.curSegs.length; i++) {
    if (state.curSegs[i]._id === segId) n++;
  }
  return n;
}

/** 清空当前批次窗口状态（stop/换批/换消息时用，防止陈旧 segStartMap 误判 in-window） */
function resetWindow() {
  state.curSegIds = [];
  state.curSegStartMap = {};
  state.curSegFrom = 0;
}

/** 当前视口内第一条可见的 assistant 消息 entryId（跟读/续播定位用） */
function visibleEntryId() {
  try {
    const vh = window.innerHeight;
    const bodies = Array.from(document.querySelectorAll(".markdown-body:not(.markdown-user-message)"));
    const hit = bodies.find((b) => {
      const r = b.getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < vh;
    }) || bodies.find((b) => {
      const r = b.getBoundingClientRect();
      return r.height > 0;
    });
    if (!hit) return null;
    const wrap = hit.closest("[data-entry-id]") || hit;
    return wrap.getAttribute("data-entry-id") || null;
  } catch {
    return null;
  }
}

/** 清除率 (速度裁剪) */
function clampRate(r) { const n = parseFloat(r) || 1; return Math.min(2, Math.max(0.5, n)); }

// ── 服务端交互 ──
/** 拉取消息索引（id + key 标记），持久到 msgList[sessionId]；force=true 忽略缓存强制刷新（SSE settled 后以服务端为准） */
export function ensureSessionLoaded(sessionId, force) {
  return new Promise((resolve) => {
    if (!force && state.allMessagesLoaded[sessionId] && Array.isArray(state.msgList[sessionId])) {
      resolve(state.msgList[sessionId]);
      return;
    }
    bumpBaseline("messagesIdsOnly");
    fetch(state.apiUrl("/api/extensions/aiti-ai-speek/messages") + "?session=" + encodeURIComponent(sessionId) + "&idsOnly=1")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!d || !d.ok || !Array.isArray(d.messages)) { resolve([]); return; }
        let ids = d.messages.filter((it) => it && it.id).map((it) => ({ id: it.id, key: !!it.key, r: typeof it.r === "number" ? it.r : null, rt: typeof it.rt === "number" ? it.rt : null }));
        if (!ids.length) {
          // 外部后端会话（zcode/codex…）：服务端无会话文件 → 空列表。用 wire 帧观察账本合成
          // （cacheMessageText 已把 message_end 正文写进 textCache，fetchTextBatch cache 命中
          // 即播，服务端 messages-content 空返回无碍）。跟读开启前的历史不可见——渐进增强边界。
          const wire = state.wireMsgIds[sessionId];
          if (Array.isArray(wire) && wire.length) {
            ids = wire.map((id) => ({ id, key: false, r: null, rt: null }));
          }
        }
        state.msgList[sessionId] = ids;
        state.allMessagesLoaded[sessionId] = true;
        notify();
        resolve(ids);
      })
      .catch(() => resolve(state.msgList[sessionId] || []));
  });
}

/** 按 id 批量取文本（按 mode 过滤），结果缓存到 textCache */
function fetchTextBatch(sessionId, ids) {
  return new Promise((resolve) => {
    if (!sessionId || !ids || !ids.length) return resolve({});
    if (!state.textCache[sessionId]) state.textCache[sessionId] = {};
    const cache = state.textCache[sessionId];
    const missing = ids.filter((id) => !(id in cache));
    if (!missing.length) {
      const out = {}; ids.forEach((id) => { out[id] = cache[id]; }); return resolve(out);
    }
    bumpBaseline("messagesContent");
    fetch(state.apiUrl("/api/extensions/aiti-ai-speek/messages-content"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId, ids: missing, mode: state.settings.mode === "essentials" ? "essentials" : "full" }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d && d.ok && Array.isArray(d.items)) {
          for (const it of d.items) { if (it && it.id && typeof it.text === "string") cache[it.id] = it.text; }
        }
        const out = {}; ids.forEach((id) => { out[id] = cache[id] || ""; }); resolve(out);
      })
      .catch(() => { const out = {}; ids.forEach((id) => { out[id] = cache[id] || ""; }); resolve(out); });
  });
}

/** 朗读内容过滤：按模式 + 忽略阈值（消息文本 ≤ minChars 字 → 整条不读，仅自动跟读应用）
 *  opts.noMinChars=true（手动导航 prev/skip/点读）：不管长短都读——跳上一条就是上一条，不被过滤掉 */
function readableSegs(raw, opts) {
  const min = Math.max(0, parseInt(String(state.settings.minChars), 10) || 0);
  const t = String(raw || "");
  if (!opts?.noMinChars && min > 0 && t.trim().length <= min) return [];
  // trackLines: file-bucket sentence-level follow needs line numbers (the AI-message path doesn't pass them — zero impact)
  return filterSegments(toSpeechSegments(t, opts?.trackLines ? { trackLines: true } : undefined), state.settings.mode);
}

/** 选择器 hover 补拉：确保一组消息文本已缓存（缺失一次拉取，回填 textCache）——返回 { id: text } */
export function ensureTexts(sessionId, ids) {
  if (!sessionId || !ids || !ids.length) return Promise.resolve({});
  return fetchTextBatch(sessionId, ids);
}

/** 把 msgList 中 [from, from+READ_LIMIT] 一批文本入「待播」（拉文本 → 分句 → 推入 curSegs 链）
 *  token = 启动令牌：加载属某次启动；期间被更新的启动（点读/换条/停止）超越 → 丢弃本批（防双声/防“停止后突然出声”）
 *  opts.noMinChars=true：手动导航（prev/skip/点读）——目标消息不被长度过滤剔除（跳哪就停哪） */
function loadRangeIntoCur(sessionId, from, token, opts) {
  console.log('[speek][loadRangeIntoCur] start', { sessionId, from, listLen: state.msgList[sessionId]?.length });
  const list = state.msgList[sessionId] || [];
  if (!list.length) return;
  if (from < 0) from = Math.max(0, list.length - READ_LIMIT);
  const slice = list.slice(from, from + READ_LIMIT);
  const ids = slice.map((it) => it.id);
  fetchTextBatch(sessionId, ids).then((textMap) => {
    if (token != null && token !== playToken) { console.log('[speek][loadRangeIntoCur] superseded (newer start)', { token, playToken }); return; }
    console.log('[speek][loadRangeIntoCur] textMap', { ids, textMapKeys: Object.keys(textMap), hasText: Object.values(textMap).some(v => v) });
    // 把这些消息的句合并到 curSegs（保持连续播放体验）
    const allSegs = [];
    const idOrder = [];
    const segStartMap = {}; // id → 在 allSegs 中的起始句索引
    const fb = fileBucketOf(sessionId); // file bucket: sentences get _line attached (for follow)
    for (const it of slice) {
      const raw = textMap[it.id];
      if (!raw) continue;
      const segs = readableSegs(raw, fb ? { ...opts, trackLines: true } : opts);
      if (!segs.length) continue;
      segStartMap[it.id] = allSegs.length;
      idOrder.push(it.id);
      const blockStart = fb ? (fb.chunkStartLine[it.id] || 1) : 1;
      for (const s of segs) {
        allSegs.push(fb
          ? { ...s, _id: it.id, _line: (s.line || 1) + blockStart - 1 } // absolute line = in-block line + block start - 1
          : { ...s, _id: it.id });
      }
    }
    console.log('[speek][loadRangeIntoCur] segs', { allSegsLen: allSegs.length, idOrder });
    // 手动导航（opts.direction）：目标消息（窗口第一条）必须落在它上面——无内容 → 同方向继续找，直到有内容为止
    if (opts?.direction && slice.length && segStartMap[slice[0].id] == null) {
      const next = from + opts.direction;
      if (next >= 0 && next < list.length) { loadRangeIntoCur(sessionId, next, token, opts); return; }
      // 方向尽头仍无内容：停在边界（不播、不胜足跳开）
      state.playing = false; state.paused = false;
      state.curIndex = Math.max(0, Math.min(from, list.length - 1));
      state.curSeg = 0; state.curSegs = [];
      resetWindow();
      notify();
      return;
    }
    if (!allSegs.length) {
      // 自动跟读：本窗口全部无可读内容（空消息/过滤后为空）→ 顺延到下一窗口，避免中途哑火
      if (from + READ_LIMIT < list.length) { loadRangeIntoCur(sessionId, from + READ_LIMIT, token, opts); return; }
      stop(); return;
    }
    // 切到 first seg（按 progress 续读）。⚠ 只在「续读该消息」时恢复句级进度：
    //   lastReadPos == firstId（上次读到/停在该消息 = resume 语义）才从 progress 的句继续；
    //   否则（显式点读/跳转/新开始）从头读该消息（progress 留给「上次停在这」的续读）
    const firstId = idOrder[0];
    const firstSegStart = segStartMap[firstId] || 0;
    let startSeg = firstSegStart;
    // 读完标记 "e"（9e=该消息全部句已读完）：仅【续读该消息】（lastReadPos==firstId）时跳过不重读；
    // 点读/跳转（lastReadPos≠）→ 清 e 从头读该消息（用户明确要读它）
    if (firstId && progress[firstId] === "e") {
      if (lastReadPos[sessionId] === firstId) {
        const next = from + 1;
        if (next >= 0 && next < list.length) { loadRangeIntoCur(sessionId, next, token, opts); return; }
        // 已是最后一条（全读完）→ END 等待新消息（不重播 9e）
        state.playing = false; state.paused = false; state.starting = false;
        state.curSeg = 0; state.curSegs = [];
        notify();
        return;
      }
      delete progress[firstId]; saveProgress(); // 点读/跳转：清 e，从头读
    }
    if (firstId && progress[firstId] != null && lastReadPos[sessionId] === firstId) {
      // 该消息在本批内的句数 = 下一消息的 segStart（或批末）− 本消息 segStart；钳位防越界
      const segEnd = (idOrder[1] != null && segStartMap[idOrder[1]] != null)
        ? segStartMap[idOrder[1]]
        : allSegs.length;
      startSeg = Math.min(firstSegStart + Math.max(0, progress[firstId]), Math.max(firstSegStart, segEnd - 1));
    }
    state.curSegs = allSegs;
    state.curSeg = startSeg;
    state.curSegStartMap = segStartMap;
    state.curSegIds = idOrder;
    state.curSegFrom = from;
    windowPrefetchFrom = -1; // 新窗口就绪：允许对下一窗口重新预载
    // curIndex 不再停在批次起点：同步到起始句所属消息的真实索引（prev/skip/高亮/进度都依赖它）
    state.curIndex = from;
    syncCurIndex();
    // 不再写 lastReadPos=批首（历史残留曾把停止态 prev/skip 基准污染成妖孽数字——如 181→40）；
    // 基准只由 syncCurIndex（每句实时）/END（最后一条）/stop（当前）维护。
    // 文本已到手 → 立即逐句预读（当前句 + 后续 3 句），首次响应不额外变慢
    enqueueWindowPrefetch();
    console.log('[speek][loadRangeIntoCur] playCurrentSeg', { curSegsLen: allSegs.length, startSeg, firstId, curIndex: state.curIndex });
    playCurrentSeg();
  });
}

// ── File read (aiti-editor 🔊 read entry; docs/aiti-ai-speek-file-read-plan.md §3.1/§3.2) ──
/** fileMode check: sessionId points at the current file bucket */
function fileBucketOf(sessionId) {
  const fb = state.fileBucket;
  return fb && sessionId === fb.id ? fb : null;
}
/** Line-follow debounce (no repeated reveal for the same line) */
let lastFollowLine = -1;
/** Clear editor follow highlights (on stop / return-switch / follow-off; silent when the service is absent) */
function clearEditorFollow() {
  lastFollowLine = -1;
  try { extSvc("aiti-editor.speekFollow")?.clearFollow?.(); } catch { /* noop */ }
}
/**
 * Read file text aloud (the editor "read" button entry; text is passed in by the editor, including
 * unsaved edits). Installs a virtual session bucket (file:<path>) → auto-enters follow-read state →
 * plays from the first block; the whole playback chain (sentence split / edge prefetch / pause-skip /
 * progress) reuses the existing machinery.
 * @returns {Promise<{ok: boolean, chunks?: number, error?: string}>}
 */
export async function readFileText(payload) {
  const p = payload || {};
  const path = String(p.path || "").trim();
  const name = String(p.name || (path ? path.split(/[\\/]/).pop() : "") || "未命名文件");
  const chunks = chunkFileForSpeech(p.text, name);
  if (!chunks) return { ok: false, error: "文件内容为空，无可朗读内容" };
  const fileId = "file:" + (path || name);
  // capture the return-switch target: reading another file consecutively keeps the original AI session
  const prevFb = state.fileBucket;
  const returnTo = prevFb ? prevFb.returnTo : activeSessionId;
  // install the bucket (textCache prefilled → loadRangeIntoCur's fetchTextBatch hits fully, zero
  // network; install the bucket before setCurrentSession so its ensureSessionLoaded hits directly
  // and sends no request)
  state.msgList[fileId] = chunks.map((c) => ({ id: c.id, key: false }));
  state.textCache[fileId] = {};
  for (const c of chunks) state.textCache[fileId][c.id] = c.text;
  state.allMessagesLoaded[fileId] = true;
  state.fileBucket = {
    id: fileId, path, name, returnTo,
    chunkStartLine: Object.fromEntries(chunks.map((c) => [c.id, c.startLine])),
  };
  setCurrentSession(fileId); // clears old playback / old session cache (the file: prefix does not trigger fileBucket cleanup; the new bucket overwrites right after)
  if (!state.followOn) state.followOn = true;
  if (!state.barVisible) state.barVisible = true;
  persist();
  readOnFollowSuppress = true; // self-started this time; "auto-read on enable" will not kick off another round (prevents double start)
  lastIntentionalStartAt = Date.now();
  // engine readiness gate: on first use (heavy chunk just loaded) the /voices probe is still in
  // flight; not waiting for it would mis-select the browser engine (hard error on phones without
  // Web Speech)
  await ensureEngineReady();
  // defense: if the bucket was cleared externally during the await (in theory already excluded by
  // the HeavyFollowToggle effect's fileMode early return) → reinstall to recover
  if (!state.fileBucket || state.fileBucket.id !== fileId) {
    state.msgList[fileId] = chunks.map((c) => ({ id: c.id, key: false }));
    state.textCache[fileId] = {};
    for (const c of chunks) state.textCache[fileId][c.id] = c.text;
    state.allMessagesLoaded[fileId] = true;
    state.fileBucket = {
      id: fileId, path, name, returnTo,
      chunkStartLine: Object.fromEntries(chunks.map((c) => [c.id, c.startLine])),
    };
    setCurrentSession(fileId);
    console.log("[speek][readFile] 桶在引擎等待期间被外部清理，已重装", { fileId });
  }
  playAtSourceId(fileId, chunks[0].id, { noMinChars: true });
  notify();
  return { ok: true, chunks: chunks.length };
}

// ── 三个对外入口 ──
/** 进入/切 session：从上次读完位置续读 */
export function resumeSessionFromLastPos(sessionId) {
  if (!sessionId) return;
  lastIntentionalStartAt = Date.now(); // 主动恢复——settle 不抢
  const lastPos = lastReadPos[sessionId];
  if (lastPos) playAtSourceId(sessionId, lastPos);
  else startFollowFromPageTop(sessionId);
}

/** 跟读按钮：从当前页可见的第一条 assistant 消息开始读 */
export function startFollowFromPageTop(sessionId) {
  if (!sessionId) return;
  ensureSessionLoaded(sessionId).then(() => {
    // DOM 就绪重试：消息流未渲染完时 visibleEntryId 拿不到（页面刚加载）
    // → 等几个 tick 再取，避免误兑底到「最后一条」（220/220 而非视口的 214/220）
    let tries = 0;
    const pick = () => {
      const vis = visibleEntryId();
      if (vis) { playAtSourceId(sessionId, vis); return; }
      if (++tries < 6) { setTimeout(pick, 200); return; }
      if (state.msgList[sessionId] && state.msgList[sessionId].length) {
        playAtSourceId(sessionId, state.msgList[sessionId][state.msgList[sessionId].length - 1].id);
      }
    };
    pick();
  });
}

/** 点击「朗读这条」：从指定消息开始读 */
export function readMessageFrom(text, sourceId, sessionId) {
  if (!sourceId || !sessionId) return;
  lastReadPos[sessionId] = sourceId; saveLastReadPos();
  // 点读即进入跟读态并弹出控制条（否则无声朗读无控制；工具栏再点跟读会再启一轮 → 双声）
  if (!state.followOn) {
    readOnFollowSuppress = true; // 本次点读自己负责启动，避免「开启即自动读」再启一轮
    state.followOn = true;
  }
  if (!state.barVisible) state.barVisible = true;
  persist();
  notify();
  if (!state.pageFocused) { pendingReadOnFocus = sessionId; return; }
  playAtSourceId(sessionId, sourceId, { noMinChars: true });
}

/** 核心：从 msgList 里 sourceId 对应的位置开始播一整批（READ_LIMIT 条） */
export function playAtSourceId(sessionId, sourceId, opts) {
  if (!sessionId || !sourceId) return;
  // 不再因页面失焦而吞掉「用户主动播放」：失焦只影响自动播（SSE 跟读有 followOn+playing 门控与
  // blur 时 stop 的兜底）；主动点读/跟读必须立刻开播。
  if (activeSessionId && sessionId !== activeSessionId) return;
  console.log('[speek][playAtSourceId]', { sessionId, sourceId });
  try { if (state.audio) { state.audio.pause(); state.audio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  const tok = bumpPlayToken(); // 旧语音回调失效 + 使在途加载（若有）作废
  state.playing = false; state.paused = false; state.starting = false;
  state.curSeg = 0; state.curSegs = [];
  resetWindow();
  ensureSessionLoaded(sessionId).then(() => {
    const list = state.msgList[sessionId] || [];
    console.log('[speek][playAtSourceId] loaded', { listLen: list.length, sourceId });
    if (!list.length) return;
    let from = list.findIndex((it) => it.id === sourceId);
    if (from < 0) { const vis = visibleEntryId(); if (vis) { const i = list.findIndex((it) => it.id === vis); if (i >= 0) from = i; } }
    if (from < 0) from = Math.max(0, list.length - READ_LIMIT);
    console.log('[speek][playAtSourceId] from', from);
    // opts.noMinChars（仅用户主动点读）：短消息也读 + 目标无内容时向后继续找；自动跟读不传（minChars 生效）
    loadRangeIntoCur(sessionId, from, tok, opts && opts.noMinChars ? { noMinChars: true, direction: 1 } : undefined);
  }).catch((e) => { console.log('[speek][playAtSourceId] err', e); });
}

/** 旧名兼容：组件层仍可能调 readCurrentSession → 转发到 playAtSourceId */
export function readCurrentSession(sessionId, sourceId) { playAtSourceId(sessionId, sourceId); }

// ── 播放器：句级 ──
async function playCurrentSeg() {
  const seg = state.curSegs[state.curSeg];
  if (!seg) { advanceToNextMessage(); return; }
  // 每句开播前同步 curIndex → 高亮/prev/skip/进度始终指向真实消息（而非批次起点）
  syncCurIndex();
  state.playing = true; state.paused = false; state.starting = true;
  // 播放中保持屏幕常亮（听书不灭屏）
  acquireWakeLock();
  // file bucket: sentence-level follow (the editor/preview scrolls to the line being read; same-line debounce; silent when the service is absent)
  const fb = fileBucketOf(activeSessionId);
  if (fb && seg && seg._line && lastFollowLine !== seg._line) {
    lastFollowLine = seg._line;
    try {
      const svc = extSvc("aiti-editor.speekFollow");
      if (!svc || typeof svc.followLine !== "function") {
        if (!fb._svcWarned) { fb._svcWarned = true; console.log("[speek][follow] speekFollow 服务缺席（editor 未开/旧版 client）", { path: fb.path }); }
      } else {
        const ok = svc.followLine(fb.path, seg._line, seg.match || "");
        console.log("[speek][follow]", { line: seg._line, match: String(seg.match || "").slice(0, 20), ok });
      }
    } catch (e) { console.log("[speek][follow] err", String(e)); }
  }
  if (!readerBC) { /* 首次进入播放时声明一次 */ }
  else broadcastClaim();
  const useServer = ttsBackendNow() !== null;
  if (useServer) {
    // Warm pool hit -> speak immediately; miss -> request in the background (ordered prefetch)
    prefetchSeg(seg); // fire & forget: idempotent (ready / in flight / failed are not re-requested)
  }
  state.starting = false;
  notify();
  speakSeg(seg);
  // 本句已开播 → 后台续读后续 3 句 + 批末预载下一窗口
  schedulePrefetch();
}

function speakSeg(seg) {
  const backend = ttsBackendNow();
  if (backend === "local") speakLocal(seg);
  else if (backend === "edge") speakEdge(seg);
  else speakBrowser(seg);
}

function speakBrowser(seg) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) throw new Error("speechSynthesis 不可用");
    const u = new SpeechSynthesisUtterance(seg.text);
    // 设置面板可能从未打开（state.voices 空）→ 现场拉列表按语言兜底挑，避免落到浏览器 default（可能是非中文音色）
    const v = pickBrowserVoice() || preferLangVoice(sortBrowserVoices((synth.getVoices?.() || []).filter((x) => /zh/i.test(x.lang || ""))));
    if (v) u.voice = v;
    u.lang = v?.lang || "zh-CN";
    u.rate = clampRate(state.settings.rate);
    u.pitch = 1;
    const myToken = playToken;
    u.onend = () => { if (state.playing && myToken === playToken) advanceSeg(); };
    u.onerror = () => { if (state.playing && myToken === playToken) advanceSeg(); };
    synth.speak(u);
    // 兜底：系统无语音/语音引擎异常时 onend 可能永不触发 → 30s 无进度强制推进（令牌校验）
    setTimeout(() => {
      try {
        if (state.playing && myToken === playToken && window.speechSynthesis && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
          advanceSeg();
        }
      } catch { /* noop */ }
    }, 30000);
    notify();
  } catch (e) {
    // 引擎不可用：弹提示并停止（不降级、不空转）
    failToast(t("speek.toast.browserUnavailable"));
  }
}

// 音色排序档：zh-CN（普通话）最高优先，其余 zh/yue 系随原序，非中文最后
function zhVoiceRank(lang) {
  const l = String(lang || "").toLowerCase().replace(/_/g, "-");
  if (/^zh-cn/.test(l)) return 0;
  if (/^zh|^yue/i.test(l)) return 1;
  return 2;
}
/** 浏览器音色列表排序：普通话排前（getVoices 返回序不定——Edge 把 zh-HK 粤语排在 zh-CN 前） */
export function sortBrowserVoices(list) {
  return (Array.isArray(list) ? [...list] : []).sort((a, b) => zhVoiceRank(a.lang) - zhVoiceRank(b.lang));
}
/** 无指定音色时按语言挑：界面语言（navigator.language，精确→前缀）→ zh-CN → 任意 zh/yue → 首个（修 Edge zh-HK 粤语排前被误选） */
export function preferLangVoice(list) {
  if (!list || !list.length) return null;
  const norm = (l) => String(l || "").toLowerCase().replace(/_/g, "-");
  const ui = norm(typeof navigator !== "undefined" ? navigator.language : "");
  const base = ui.split("-")[0];
  return (
    (ui && list.find((v) => norm(v.lang) === ui)) ||
    (ui && list.find((v) => norm(v.lang).startsWith(ui + "-"))) ||
    (base === "zh" && list.find((v) => norm(v.lang).startsWith("zh-cn"))) ||
    (base && list.find((v) => norm(v.lang).startsWith(base))) ||
    list.find((v) => norm(v.lang).startsWith("zh-cn")) ||
    list.find((v) => zhVoiceRank(v.lang) === 1) ||
    list[0]
  ) || null;
}

function pickBrowserVoice() {
  const list = state.voices || [];
  const want = state.settings.voice;
  if (want) { const hit = list.find((v) => v.name === want || v.voiceURI === want); if (hit) return hit; }
  return preferLangVoice(list);
}

function advanceSeg() {
  // 切句前停掉当前 audio（watchdog 提前推进时旧 audio 可能仍在放——两 audio 并发即双声）
  try { if (state.audio) { state.audio.pause(); state.audio = null; } } catch { /* noop */ }
  state.curSeg++;
  if (state.curSeg >= state.curSegs.length) {
    advanceToNextMessage();
    return;
  }
  notify();
  playCurrentSeg();
}

/** 当前批播完 → 推进 msgList 索引到下一批（避免一次性把 100 条全入 curSegs 占内存）
 *  2026-09 修复：旧实现以「批次首条」当当前位置（curIndex=from），批末推进 nextIdx=from+1
 *  → 每换一批重读 19/20 条（整条会话被循环朗读）。现以「本批已读的最后一条消息」的下一条为起点。
 */
function advanceToNextMessage() {
  const consumedIds = state.curSegIds || [];
  const lastId = consumedIds.length ? consumedIds[consumedIds.length - 1] : curId();
  // 本批消息已全文读完 → 标记「读完 e」（不清除：resume 读到它时跳过、不重读；
  // 续读会从半句跳进的问题由 lastReadPos==firstId 才恢复 + e 跳过双重保证）
  for (const cid of consumedIds) markProgressDone(cid);
  if (!activeSessionId) { state.playing = false; notify(); return; }
  const list = state.msgList[activeSessionId] || [];
  let nextListIdx = -1;
  if (lastId) {
    const lastIdx = list.findIndex((it) => it.id === lastId);
    if (lastIdx >= 0) nextListIdx = lastIdx + 1;
  }
  if (nextListIdx < 0) nextListIdx = (state.curSegFrom || 0) + READ_LIMIT; // 兜底（旧 enqueue 路径 id 不在列表）
  if (nextListIdx >= list.length) {
    // 已到最后一条 → 等 SSE 新消息或用户手动操作
    state.playing = false;
    state.paused = false;
    // 不重置位置：进度显示保持「x/总数」（已读完最后一条 = total/total），避免误显示 0/117
    state.curSeg = state.curSegs.length ? Math.max(0, state.curSegs.length - 1) : 0;
    state.curSegs = [];
    resetWindow();
    if (lastId) {
      lastReadPos[activeSessionId] = lastId; saveLastReadPos();
      const lastIdx = list.findIndex((it) => it.id === lastId);
      if (lastIdx >= 0) state.curIndex = lastIdx; // 保留在最后一条上（prev 有基准、显示不归零）
    }
    // 播完了 → 释放屏幕唤醒锁
    releaseWakeLock();
    notify();
    // file bucket finished → auto return-switch to returnTo (AI-session follow read resumes
    // naturally; null = stay stopped); files have no "new message" concept so handleSettledResume
    // is skipped (its fileMode early return already went dead when the fileBucket was cleared)
    const fb = state.fileBucket;
    if (fb && fb.id === activeSessionId) {
      state.fileBucket = null;
      clearEditorFollow();
      if (fb.returnTo) { setCurrentSession(fb.returnTo); return; } // setCurrentSession does stop + notify + list preload internally
      notify();
      return;
    }
    // 末条播完：保守续读——拉一次服务端最新列表，若有新消息（lastId 变了）则继续播；
    // 没有则 handleSettledResume 的 lastReadPos===lastId / 防循环守卫拦下（不重播、不循环）。
    handleSettledResume(activeSessionId);
    return;
  }
  if (lastId) { lastReadPos[activeSessionId] = lastId; saveLastReadPos(); }
  // 把 msgList 窗口往后推（从下一未读条起再取 READ_LIMIT 条），重新加载到 curSegs。
  // 传当前 playToken：期间被 restart/stop 超越则本批作废。
  loadRangeIntoCur(activeSessionId, nextListIdx, playToken);
}

// ── TTS prefetch and playback (edge-tts + local service) ──
// Pool key for the current backend (one entry per sentence; see ttsPoolKey).
function edgeKey(seg) {
  return ttsPoolKey(seg);
}

/**
 * Local service prefetch — same idempotent contract as the edge path.
 * Serialization happens server-side (one inference at a time), so the queue stays simple.
 */
function prefetchSegLocal(seg) {
  if (!seg || !seg.text) return Promise.resolve({ ok: false });
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(seg.text)) return Promise.resolve({ ok: true, skip: true });
  const key = ttsPoolKey(seg);
  const existing = state.edgePool[key];
  if (existing) {
    if (existing.loaded) return Promise.resolve({ ok: true, src: existing.audioSrc });
    if (existing.loading && existing.promise) return existing.promise;
  }
  const entry = { loaded: false, loading: true, errored: false, audioSrc: null, promise: null };
  state.edgePool[key] = entry;
  const voice = state.settings.voice || (state.localVoices[0] && state.localVoices[0].id) || "";
  entry.promise = new Promise((resolve) => {
    const t0 = Date.now();
    const attemptOnce = (attempt) => fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts-batch"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: [seg.text], voice, engine: "local" }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        const it = d && Array.isArray(d.items) ? d.items[0] : null;
        if (d && d.ok && it && it.cached) {
          entry.loaded = true; entry.loading = false;
          entry.audioSrc = state.apiUrl("/api/extensions/aiti-ai-speek/tts-cache/" + it.key);
          resolve({ ok: true, src: entry.audioSrc });
          return;
        }
        if (it && it.speakable === false) { entry.loading = false; resolve({ ok: true, skip: true }); return; }
        const code = (it && it.code) || (d && d.code);
        const retryable = !!(it && it.retryable) || code === "not-ready" || code === "network" || code === "timeout";
        console.log("[speek][tts-fail-local]", { ms: Date.now() - t0, attempt, voice, code, text: (seg.text || "").slice(0, 30), err: it && it.error });
        if (attempt < 2 && retryable) { setTimeout(() => attemptOnce(attempt + 1), 1200); return; }
        entry.loading = false; entry.errored = true;
        resolve({ ok: false, code, retryable, error: (it && it.error) || (d && d.error) });
      })
      .catch((e) => {
        console.log("[speek][tts-fail-local]", { ms: Date.now() - t0, attempt, err: String(e && e.message ? e.message : e) });
        if (attempt < 2) { setTimeout(() => attemptOnce(attempt + 1), 1200); return; }
        entry.loading = false; entry.errored = true;
        resolve({ ok: false, code: "network", retryable: true });
      });
    attemptOnce(1);
  });
  return entry.promise;
}

/** Dispatch to the active backend's prefetch implementation. */
function prefetchSeg(seg) {
  const backend = ttsBackendNow();
  if (backend === "local") return prefetchSegLocal(seg);
  if (backend === "edge") return prefetchSegEdge(seg);
  return Promise.resolve({ ok: false });
}

/**
 * Single-sentence TTS prefetch — one request per sentence (batch waits for the slowest one).
 * Idempotent: loaded -> resolve now; in flight -> reuse the same promise; else start one request.
 */
function prefetchSegEdge(seg) {
  if (!seg || !seg.text) return Promise.resolve({ ok: false });
  // 纯符号不可读（如 "）。"）：edge-tts CLI 无法合成会 Traceback——不请求 TTS，直接视为合成成功（skip，不失败不提示）
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(seg.text)) return Promise.resolve({ ok: true, skip: true });
  const key = edgeKey(seg);
  const existing = state.edgePool[key];
  // 真幂等：loaded → 直接好；loading → 复用同一 promise（杜绝并发覆盖竞态——曾致「请求成功却报失败」）
  if (existing) {
    if (existing.loaded) return Promise.resolve({ ok: true, src: existing.audioSrc });
    if (existing.loading && existing.promise) return existing.promise;
  }
  const entry = { loaded: false, loading: true, errored: false, audioSrc: null, promise: null };
  state.edgePool[key] = entry;
  const voice = state.settings.voice || defaultEdgeVoice();
  const rate = state.settings.rate;
  entry.promise = new Promise((resolve) => {
    const t0 = Date.now();
    // 请求层失败重试 1 次（网络抖动/瞬时 5xx）：两次都失败才记 tts-fail 日志 + 回落
    const doFetch = () => fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts-batch"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: [seg.text], voice, rate }),
    });
    const attemptOnce = (attempt) => doFetch()
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        // 一律写闭包 entry（不读全局——它可能已被并发请求覆盖）
        if (d && d.ok && Array.isArray(d.items) && d.items[0] && d.items[0].cached) {
          entry.loaded = true; entry.loading = false; entry.audioSrc = state.apiUrl("/api/extensions/aiti-ai-speek/tts-cache/" + d.items[0].key);
          resolve({ ok: true, src: entry.audioSrc });
        } else {
          // 合成未成功（cached:false / speakable:false 属不可读，跳过不视为失败）
          const unreadable = d && Array.isArray(d.items) && d.items[0] && d.items[0].speakable === false;
          if (unreadable) { entry.loading = false; resolve({ ok: true, skip: true }); return; }
          entry.loading = false; entry.errored = true;
          console.log("[speek][tts-fail]", { ms: Date.now() - t0, attempt, voice, rate, text: (seg.text || "").slice(0, 30), d, url: state.apiUrl("/api/extensions/aiti-ai-speek/tts-batch") });
          // 合成失败（服务端已重试链）：再请求一次（服务端缓存/重试后可能成功）
          if (attempt < 2) { setTimeout(() => attemptOnce(attempt + 1), 600); return; }
          resolve({ ok: false });
        }
      })
      .catch((e) => {
        console.log("[speek][tts-fail]", { ms: Date.now() - t0, attempt, voice, rate, text: (seg.text || "").slice(0, 30), err: String(e && e.message ? e.message : e) });
        if (attempt < 2) { setTimeout(() => attemptOnce(attempt + 1), 600); return; }
        entry.loading = false; entry.errored = true;
        resolve({ ok: false });
      });
    attemptOnce(1);
  });
  return entry.promise;
}

// ── 提前预读（听书无感衔接：池子常热，读到下一句时音频已就绪）──
const PREFETCH_AHEAD = 3;             // 最多保留 3 个预读在内存（当前句 + 后续 3 句滑动窗口）
const PREFETCH_MAX_INFLIGHT = 3;      // 并发上限：逐句请求防 edge CLI 进程风暴
const WINDOW_PREFETCH_THRESHOLD = 4;  // 距批末剩 N 句 → 预载下一窗口文本
let windowPrefetchFrom = -1;
let prefetchQueue = [];
let prefetchInFlight = 0;
const prefetchQueued = new Set(); // 池 key → 已排队（防重复入队；完成/失败后释放）

function edgeUseNow() {
  // Backwards-compatible name: true when a server-backed engine (edge or local) is active.
  return ttsBackendNow() !== null;
}

/** Queue sentence prefetch for the active backend (skips loaded/in-flight/queued/failed). */
function enqueuePrefetch(segs) {
  if (!segs || !segs.length || !ttsBackendNow()) return;
  let n = 0;
  for (const seg of segs) {
    if (!seg || !seg.text) continue;
    const key = ttsPoolKey(seg);
    const p = state.edgePool[key];
    if (p && (p.loaded || p.loading || p.errored)) continue; // already ready / loading / failed
    if (prefetchQueued.has(key)) continue;
    prefetchQueued.add(key);
    prefetchQueue.push(seg);
    if (++n >= PREFETCH_AHEAD + 1) break; // current sentence + 3 ahead
  }
  pumpPrefetch();
}

function pumpPrefetch() {
  while (prefetchInFlight < PREFETCH_MAX_INFLIGHT && prefetchQueue.length) {
    const seg = prefetchQueue.shift();
    prefetchInFlight++;
    const key = ttsPoolKey(seg);
    prefetchSeg(seg).then(() => {
      prefetchInFlight--;
      prefetchQueued.delete(key); // hit -> skipped by pool; failure can be queued again
      pumpPrefetch();
    });
  }
}

/** 内存池裁剪：只保留当前句 + 后续 3 句（+ 在途/排队）；播完的旧句丢弃，池不膨胀 */
function trimEdgePool() {
  const keep = new Set();
  const to = Math.min(state.curSegs.length, state.curSeg + PREFETCH_AHEAD + 1);
  for (let i = Math.max(0, state.curSeg); i < to; i++) {
    const s = state.curSegs[i];
    if (s && s.text) keep.add(edgeKey(s));
  }
  for (const k of prefetchQueued) keep.add(k);
  for (const k of Object.keys(state.edgePool)) {
    if (state.edgePool[k].loading) continue;
    if (!keep.has(k)) delete state.edgePool[k];
  }
}

/** 批载后预读：当前句起往后 PREFETCH_AHEAD 句入队（最早启动请求） */
function enqueueWindowPrefetch() {
  if (!state.curSegs.length) return;
  enqueuePrefetch(state.curSegs.slice(state.curSeg));
}

/** 预读调度（每句开播后调用）：续读后续 3 句 + 批末逼近时预载下一窗口 */
function schedulePrefetch() {
  if (!state.playing || state.paused) return;
  if (edgeUseNow()) {
    enqueuePrefetch(state.curSegs.slice(state.curSeg + 1, state.curSeg + 1 + PREFETCH_AHEAD));
    trimEdgePool();
  }
  if (state.curSegs.length - state.curSeg <= WINDOW_PREFETCH_THRESHOLD) prefetchNextWindow();
}

/** 预载下一批窗口文本（进 textCache；换批时 loadRangeIntoCur 命中即秒载）+ 预热其首 3 句 */
function prefetchNextWindow() {
  if (!activeSessionId) return;
  const list = state.msgList[activeSessionId] || [];
  const nextFrom = (state.curSegFrom || 0) + READ_LIMIT;
  if (nextFrom >= list.length || windowPrefetchFrom === nextFrom) return;
  windowPrefetchFrom = nextFrom;
  const slice = list.slice(nextFrom, nextFrom + READ_LIMIT);
  if (!slice.length) return;
  const ids = slice.map((it) => it.id);
  const tok = playToken;
  fetchTextBatch(activeSessionId, ids).then((textMap) => {
    if (tok !== playToken) return;
    const all = [];
    for (const it of slice) {
      const raw = textMap[it.id];
      if (!raw) continue;
      for (const s of readableSegs(raw)) all.push({ ...s, _id: it.id });
    }
    // 只预热下批首 3 句：衔接处零等待，且符合「最多 3 个预读」
    enqueuePrefetch(all.slice(0, PREFETCH_AHEAD));
  });
}

function speakEdge(seg) {
  const key = ttsPoolKey(seg);
  try { if (state.audio) { state.audio.pause(); state.audio = null; } } catch { /* noop */ }
  const p = state.edgePool[key];
  if (p && p.audioSrc) { playEdgeAudio(p.audioSrc, seg); return; }
  // Pool miss -> wait for synthesis (only path; failures are reported, never silently downgraded)
  state.starting = true;
  notify();
  const myToken = playToken;
  const t0 = Date.now();
  // "starting" stays until audio actually plays (playEdgeAudio onplaying) or the attempt fails.
  const clearStarting = () => {
    const remain = Math.max(0, 150 - (Date.now() - t0));
    setTimeout(() => { if (state.playing && myToken === playToken) { state.starting = false; notify(); } }, remain);
  };
  prefetchSegEdge(seg).then((r) => {
    if (!state.playing || myToken !== playToken) return;
    if (r && r.skip) { clearStarting(); advanceToNextMessage(); return; } // unreadable sentence: skip
    if (r && r.ok && r.src) { playEdgeAudio(r.src, seg, clearStarting); return; }
    clearStarting();
    failToast(t("speek.toast.edgeFailed"));
  }).catch(() => {
    if (!state.playing || myToken !== playToken) return;
    clearStarting();
    failToast(t("speek.toast.edgeFailed"));
  });
}

/**
 * Local-engine playback: audio already sits in the extension cache, speed comes from
 * playbackRate (the service does not implement `speed`; the cache key stays rate-free).
 * Failures degrade that single sentence to the browser engine with a toast (plan R20).
 */
function speakLocal(seg) {
  const key = ttsPoolKey(seg);
  try { if (state.audio) { state.audio.pause(); state.audio = null; } } catch { /* noop */ }
  const p = state.edgePool[key];
  if (p && p.audioSrc) { playLocalAudio(p.audioSrc, seg); return; }
  state.starting = true;
  notify();
  const myToken = playToken;
  const t0 = Date.now();
  const clearStarting = () => {
    const remain = Math.max(0, 150 - (Date.now() - t0));
    setTimeout(() => { if (state.playing && myToken === playToken) { state.starting = false; notify(); } }, remain);
  };
  prefetchSegLocal(seg).then((r) => {
    if (!state.playing || myToken !== playToken) return;
    if (r && r.skip) { clearStarting(); advanceToNextMessage(); return; }
    if (r && r.ok && r.src) { playLocalAudio(r.src, seg, clearStarting); return; }
    clearStarting();
    // Service asleep -> wake it once and tell the user; the current sentence uses the browser.
    if (r && (r.code === "not-ready" || r.code === "network")) {
      state.localStatus = "loading";
      notify();
      ensureLocal();
      failToast(t("speek.toast.localNotReady"));
    } else {
      failToast(t("speek.toast.localFailed", { err: String((r && r.error) || t("speek.local.stopped")) }));
    }
    speakBrowser(seg);
  }).catch(() => {
    if (!state.playing || myToken !== playToken) return;
    clearStarting();
    failToast(t("speek.toast.localFailedShort"));
    speakBrowser(seg);
  });
}

/** Local audio playback with playbackRate-based speed (pitch preserved). */
function playLocalAudio(src, seg, onStart) {
  try { if (state.audio) { state.audio.pause(); } } catch { /* noop */ }
  const audio = new Audio(src);
  audio.preload = "auto";
  try {
    audio.playbackRate = clampRate(state.settings.rate);
    audio.preservesPitch = true;
  } catch { /* older browsers */ }
  state.audio = audio;
  const myToken = playToken;
  let attempts = 0;
  const tryPlay = () => {
    audio.onended = () => { if (state.playing && myToken === playToken) advanceSeg(); };
    audio.onplaying = () => { try { onStart && onStart(); } catch { /* noop */ } };
    audio.onerror = () => {
      if (attempts < 1) { attempts++; try { audio.load(); audio.play().catch(() => {}); } catch { /* noop */ } return; }
      try { onStart && onStart(); } catch { /* noop */ }
      failToast(t("speek.toast.playFailed"));
    };
    audio.play().catch(() => {
      if (attempts < 1) { attempts++; try { audio.load(); audio.play().catch(() => {}); } catch { /* noop */ } return; }
      try { onStart && onStart(); } catch { /* noop */ }
      failToast(t("speek.toast.playFailed"));
    });
  };
  tryPlay();
}

/** edge 音频播放（唯一路径）：切句停旧（防双声）；onended → 推进；失败 → 重试 1 次再弹提示。
 *  onStart（可选）：音频真正开始出声（onplaying）时回调——speakEdge 用它清「启动中」（不提前消失）。 */
function playEdgeAudio(src, seg, onStart) {
  try { if (state.audio) { state.audio.pause(); } } catch { /* noop */ }
  const audio = new Audio(src);
  audio.preload = "auto";
  state.audio = audio;
  const myToken = playToken;
  let attempts = 0;
  const tryPlay = () => {
    audio.onended = () => { if (state.playing && myToken === playToken) advanceSeg(); };
    audio.onplaying = () => { try { onStart && onStart(); } catch { /* noop */ } }; // 真正出声才清「启动中」
    audio.onerror = () => {
      if (attempts < 1) { attempts++; try { audio.load(); audio.play().catch(() => {}); } catch { /* noop */ } return; }
      try { onStart && onStart(); } catch { /* noop */ }
      failToast(t("speek.toast.playFailed"));
    };
    audio.play().catch(() => {
      if (attempts < 1) { attempts++; try { audio.load(); audio.play().catch(() => {}); } catch { /* noop */ } return; }
      try { onStart && onStart(); } catch { /* noop */ }
      failToast(t("speek.toast.playFailed"));
    });
  };
  tryPlay();
}
/**
 * 跳到目标消息：一律从目标消息开头重载窗口（不依赖 curSegStartMap 残留——它是窗口加载/SSE
 * 追加时更新的，任何一秒错位都会导致「先跳当前段」。⏮/⏭ = 直接退/进一条，从那条开头重新读。
 */
function jumpToMsgIdx(target, dir) {
  const list = state.msgList[activeSessionId] || [];
  const t = list[target];
  if (!t) return;
  // 跳转即记录播放基准：下次播放（resume）从当前显示的位置继续，而不是旧 lastReadPos
  lastReadPos[activeSessionId] = t.id; saveLastReadPos();
  // 手动导航标记：上一条/下一条/进度跳转后 4s 内滚动强制 always 跟随到目标行
  // （用户自己点的：点完跳哪行就滚到哪行，无视 smart/off/用户滚动保护）
  try { window.__speekManualNav = Date.now(); } catch { /* noop */ }
  // 停旧播放
  try { if (state.audio) { state.audio.pause(); state.audio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  const tok = bumpPlayToken(); // 旧语音残留回调失效 + 让在途加载作废（双声根因）
  state.playing = false; state.paused = false; state.starting = false;
  // 不继承目标消息进度：从头读（“不要管当前段的进度，直接跳前段”）
  delete progress[t.id];
  // 不归零：立即显示目标位置（target/total）——绝不出现 0/xxxx 瞬态；加载完成后 loadRangeIntoCur 精确同步
  state.curIndex = target; state.curSeg = 0; state.curSegs = [];
  resetWindow();
  // 手动导航：noMinChars（短消息也读）+ 目标无内容 → 沿 dir 方向继续找（直到有内容为止）
  loadRangeIntoCur(activeSessionId, target, tok, { noMinChars: true, direction: dir || 1 });
}
function readAdjacent(delta) {
  if (!activeSessionId) return;
  const list = state.msgList[activeSessionId] || [];
  if (!list.length) return;
  ensureSessionLoaded(activeSessionId).then(() => {
    const l = state.msgList[activeSessionId] || [];
    if (!l.length) return;
    // ⛰ 单一基准：state.curIndex（当前消息位置，一个数字）——prev = 它-1，skip = 它+1。
    //    lastReadPos 只在「停止态（curIndex 无效）」反查一次；查不到 → 不动。
    let curIdx = state.curIndex;
    if (curIdx < 0 || curIdx >= l.length) {
      // 停止态/未播放基准链：① 页面视口第一条可见 assistant 消息（用户「看着的」那条）
      //   ② lastReadPos（最后读到）③ 都没有 → 不动
      const visId = visibleEntryId();
      let posIdx = visId ? l.findIndex((it) => it.id === visId) : -1;
      if (posIdx < 0) {
        const lastPos = lastReadPos[activeSessionId];
        posIdx = lastPos ? l.findIndex((it) => it.id === lastPos) : -1;
      }
      if (posIdx < 0) { console.log('[speek][adj] no anchor → noop', { delta, visId }); notify(); return; }
      curIdx = posIdx;
    }
    const step = delta > 0 ? 1 : -1;
    const target = curIdx + step;
    console.log('[speek][adj]', { delta, curIdx, target, lastPos: lastReadPos[activeSessionId], listLen: l.length });
    if (target < 0 || target >= l.length) {
      // 边界：skip 到最后一条（或 prev 到第一条）。保守处理——去服务端拉一次最新列表，
      // 若确实有新消息（列表变长）则跳到新的下一条继续；没有新消息则 noop（尊重用户，不循环）。
      if (delta > 0) {
        ensureSessionLoaded(activeSessionId, true).then((fresh) => {
          const fl = state.msgList[activeSessionId] || [];
          const nt = curIdx + 1;
          if (fl.length > nt) {
            console.log('[speek][adj] boundary + new message', { nt, freshLen: fl.length });
            notify();
            jumpToMsgIdx(nt, delta);
            return;
          }
          console.log('[speek][adj] boundary no new'); notify();
        });
        return;
      }
      console.log('[speek][adj] no target'); notify(); return;
    }
    notify(); // 先反馈再加载（上一条/下一条要“立刻跟随”，不等 fetch）
    jumpToMsgIdx(target, delta);
  }).catch((e) => { console.log('[speek][adj] err', e); notify(); });
}
export function prev() { console.log('[speek][prev] clicked', { activeSessionId, msgListLen: state.msgList[activeSessionId] ? state.msgList[activeSessionId].length : -1 }); readAdjacent(-1); }
/** 消息跳转（选择器点选）：跳到指定消息索引，从该消息开头读 */
export function jumpToMessage(idx) {
  if (!activeSessionId || !Number.isInteger(idx)) return;
  const list = state.msgList[activeSessionId] || [];
  if (idx < 0 || idx >= list.length) return;
  const dir = idx > state.curIndex ? 1 : -1;
  jumpToMsgIdx(idx, dir);
}
export function skip() {
  try { if (state.audio) { state.audio.pause(); state.audio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  readAdjacent(1);
}

// ── 暂停 / 继续 / 停止 ──
export function pause() {
  if (!state.playing) return;
  // 暂停 = 屏保回来（用户已停，不必再保亮）
  releaseWakeLock();
  if (state.audio && ttsBackendNow()) { state.audio.pause(); state.paused = true; notify(); return; }
  try { window.speechSynthesis.pause(); state.paused = true; notify(); } catch { /* noop */ }
}
export function resume() {
  if (!state.playing || !state.paused) return;
  // 恢复播放 = 继续保亮
  acquireWakeLock();
  if (state.audio && ttsBackendNow()) { state.audio.play().catch(() => {}); state.paused = false; notify(); return; }
  try { window.speechSynthesis.resume(); state.paused = false; notify(); } catch { /* noop */ }
}
export function stop() {
  // 先记最后读到哪条（停止态 prev/skip/resume 的基准；勿用批次首条）
  if (activeSessionId) {
    const id = curId();
    if (id) { lastReadPos[activeSessionId] = id; saveLastReadPos(); }
  }
  recordProgress();
  saveProgress(); // 停止 = 关键点：立即落盘（progress 防抖 400ms，停止时必须立刻持久化）
  // file bucket: clear editor follow highlights (stopping mid-read leaves no highlight behind; the
  // fileBucket is kept — progress / block navigation stay usable)
  if (state.fileBucket) clearEditorFollow();
  // 停止 = 释放屏幕唤醒锁
  releaseWakeLock();
  try { if (state.audio) { state.audio.pause(); state.audio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  bumpPlayToken(); // 停止后残留回调一律失效
  // 保留当前朗读位置（curIndex/curSeg/curSegs 不归零）：进度显示「最后读到哪」（如 251/255 · 3/8）
  // 而非 0/xxx——用户反馈停止后位置丢失不合理；prev/skip 也有准确基准。只在从未播过时保持默认。
  // 仅清映射窗口（curSegIds/StartMap/From 与旧窗口绑定，下次播放 playAtSourceId 会重建）。
  state.playing = false; state.paused = false; state.starting = false;
  resetWindow();
  notify();
}

// ── 当前会话门控 ──
let pendingReadOnFocus = null;
export function setPageFocused(focused) {
  const f = !!focused;
  if (state.pageFocused === f) return;
  state.pageFocused = f;
  if (!f) {
    // 允许后台继续读：不停止，也不标记恢复（根本没停，回到前台无需重开）
    if (!state.settings.backgroundContinue) {
      // ⚠ 切外部时 blur+visibilitychange 会先后触发两次：第一次（还在播）标记恢复，
      // 第二次（已 stop）若直接赋值会把标记覆盖成 false → 回前台不续读、停在 0/233。用 || 保持。
      resumeOnFocusReturn = resumeOnFocusReturn || (state.followOn && state.playing);
      stop();
    }
  } else {
    const wantRead = resumeOnFocusReturn || pendingReadOnFocus;
    resumeOnFocusReturn = false;
    const target = pendingReadOnFocus || activeSessionId;
    pendingReadOnFocus = null;
    if (wantRead && state.followOn && target) resumeSessionFromLastPos(target);
  }
  notify();
}
export function bindFocusGating() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const update = () => {
    let focused = false;
    try { focused = !document.hidden && (typeof document.hasFocus === "function" ? document.hasFocus() : true); } catch { focused = true; }
    setPageFocused(focused);
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
}
export function bindReaderCoordination() {
  try {
    readerBC = new BroadcastChannel("aiti-ai-speek:reader");
    readerBC.onmessage = (e) => {
      const m = e && e.data;
      if (!m || m.type !== "claim" || m.from === MY_ID) return;
      if (state.playing && !state.pageFocused && !state.settings.backgroundContinue) stop();
    };
  } catch { /* noop */ }
}
function broadcastClaim() {
  try { readerBC?.postMessage({ type: "claim", from: MY_ID, sessionId: activeSessionId, ts: Date.now() }); } catch { /* noop */ }
}

// ── SSE 订阅 ──
let esRef = null;
let esSessionId = null;
let sseSettledCount = 0;
let sseConnectedAt = 0;
let lastForceRefreshAt = 0;
let lastAutoResumeId = null; // 防循环重播：自动续读的最后一条 id
let lastAutoResumeAt = 0;    // 防循环重播：上次自动续读时刻（同一条 15s 内不重复续读）

// ── [双SSE去重·方案A] settled 轮账本（docs/todo-aiti-ai-speek-dual-sse-redundancy.md）──
// runtime 会话上扩展 settled 与 agent 流 agent_settled 同刻双推（同源同事件）：
// 只放行先到的一路做 force 全量解析 + 续读判定，后到的一路 15s 内视为同一轮合并跳过
// ——消除每轮 ≥2 次并发全量 readSession 与双 resume 启动竞态（§3.1/§3.2）。
// 约束（§3.5）：正文缓存写入不进本账本——message_end 路无条件直写 textCache（带真实
// message.id），settled 路直写保留在自身 force 分支内，合并跳过时文本仍可命中缓存。
let settledTurnId = null;
let settledTurnAt = 0;
export function claimSettledTurn(listId) {
  const now0 = Date.now();
  if (settledTurnId === listId && now0 - settledTurnAt < 15000) return false;
  settledTurnId = listId;
  settledTurnAt = now0;
  return true;
}
/** 上一轮认领失效（新一轮活动：assistant 块完成）。账本只该合并「同一轮」的
 *  settled/agent_settled 对（近似同时到达）；不清则连续快速轮次（<15s）的 settle 对
 *  会被上一轮认领整对压制（本轮刷新+续读双双丢失）。导出供测试与诊断。 */
export function resetSettledTurn() {
  settledTurnId = null;
  settledTurnAt = 0;
}

/** [双SSE去重·方案A 附带] message_end 事件自带完整 assistant 正文 → 无条件直写 textCache
 *  （不进 1.5s/2s 节流、不进 settled 轮账本——settled 被 message_end 抢窗时文本仍可命中）。
 *  ⚠ 机会主义直写：键 = 事件 message.id，**仅当 wire message 自带 id 且与服务端 entryId
 *  同键时** fetchTextBatch 才命中省一次 /messages-content；实测 pi runtime 会话消息【无】
 *  message.id（entry.id 是唯一 id）→ 对 runtime 会话本函数为 no-op，不作收益承诺。
 *  仅 full 模式：essentials 的要点过滤在服务端 filterByMode，客户端不复刻（直写会绕过过滤）。 */
export function cacheMessageText(listId, m) {
  try {
    if (!m || typeof m.id !== "string" || !m.id) return;
    if (state.settings.mode === "essentials") return;
    const c = m.content;
    let text = "";
    if (typeof c === "string") text = (c || "").trim() ? c : "";
    else if (Array.isArray(c)) text = c.filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim()).map((b) => b.text).join("\n");
    if (!text.trim()) return;
    if (!state.textCache[listId]) state.textCache[listId] = {};
    state.textCache[listId][m.id] = text;
    // wire 观察账本（保序去重）：外部会话合成朗读列表用（见 ensureSessionLoaded）
    const wire = (state.wireMsgIds[listId] ??= []);
    if (!wire.includes(m.id)) wire.push(m.id);
  } catch { /* noop */ }
}

/** updating 统一处理：刷新列表 + 在播追加队尾 / 未在播续读。
 *  触发源（均为块级完成事件，非流式 delta）：agent 流 `message_end`（assistant 正文块完成）
 *  与扩展 SSE `updating`（正文块完成）。流式 delta（message_update）已改为直接忽略——
 *  否则逐字推送期间每 1.5s 打一次 ids 全量对账（2026-09-05 用户反馈）。
 *  铁律不变：delta 级事件【绝不】触发网络请求与续读。块级完成事件：
 *  在播 → 新正文追加队尾（追读）；未在播+跟读开 → 按 settled 同护栏续读
 *  （长 turn 多工具调用不再等到 settle 才出声）；暂停 → 只刷列表不打断。
 *  内部 1.5s 节流合并连续帧。 */
function handleUpdating(listId) {
  if (state.fileBucket) return; // during file read: AI message updates neither append to the queue nor preempt playback (onopen reconciliation fallback)
  resetSettledTurn(); // 新一轮活动：上一轮的 settled 认领失效（先于节流早退）
  try {
    const now2 = Date.now();
    if (now2 - lastForceRefreshAt < 1500) return;
    lastForceRefreshAt = now2;
    ensureSessionLoaded(listId, true).then((updList) => {
      const lastId = updList && updList.length ? updList[updList.length - 1].id : null;
      if (!lastId) return;
      if (!state.textCache[listId]) state.textCache[listId] = {};
      notify();
      if (!state.followOn) return;
      if (state.playing && !state.paused) {
        // 在播：拉新正文并追加队尾（追读）。
        // ⚠ 整队列查重：同一消息（lastId）已在队列任意位置就不重复追加（否则反复 settle/updating
        //   会把同样 10 条重复押入 → 读完 10 条再读同样 10 条）
        if (state.curSegIds.includes(lastId)) return;
        // 文本按 lastId 现拉（cacheMessageText 若已按真实 id 直写过则 fetchTextBatch 缓存命中零网络）
        fetchTextBatch(listId, [lastId]).then((tm) => {
          const rw = tm[lastId];
          if (!rw || state.playing === false) return;
          const segs = filterSegments(toSpeechSegments(rw), state.settings.mode);
          if (!segs.length) return;
          state.curSegStartMap[lastId] = state.curSegs.length;
          state.curSegIds.push(lastId);
          for (const sg of segs) state.curSegs.push({ ...sg, _id: lastId });
          enqueuePrefetch(segs);
          notify();
        });
        return;
      }
      if (state.paused) return; // 暂停：不打断、不自动续（尊重播放历史）
      // 未在播+跟读开：正文块完成即续读（不等 settle——长 turn 不哑火）。
      // 与 handleSettledResume 同护栏：不抢主动启动/失败窗口/已读末条（续读从当前位置顺延，不拽到最新）。
      if (Date.now() - lastIntentionalStartAt < 1500) return;
      if (Date.now() - failToastAt < 5000) return;
      if (lastReadPos[listId] === lastId) return;
      resumeFromCurrentPos(listId);
    });
  } catch { /* 坏帧忽略 */ }
}

/** 一轮 agent 真正完成（agent_settled / 扩展 settled）→ 刷新列表；跟读开且未在播且非暂停
 *  且不在末条时才续读最新一次。尊重用户播放历史：正播/暂停/手动停止/已到末条 → 不跳、不重播。
 *  [双SSE去重·方案A] 与 settled/updating 同账本：2s 内已有任一路 force 过 → 本路整跳
 *  （同一轮的追加/续读判定已由上一路做过）；settled 轮账本已认领（15s 内同会话）→ 跳过。
 *  本路无 text 可写，跳过零损失——消除 agent_settled 与 settled 双推的二次全量解析 + 双 resume 竞态。 */
function handleSettledResume(listId) {
  if (state.fileBucket) return; // during file read: no preempting
  const now2 = Date.now();
  if (now2 - lastForceRefreshAt < 2000) return;
  if (!claimSettledTurn(listId)) return;
  lastForceRefreshAt = now2;
  ensureSessionLoaded(listId, true).then((list) => {
    if (!list || !list.length) return;
    notify();
    if (!state.followOn || state.playing || state.paused) return; // 正播/暂停/未开跟读：不跳
    if (Date.now() - lastIntentionalStartAt < 1500) return;        // 刚主动启动/恢复：不抢
    if (Date.now() - failToastAt < 5000) return;                   // 失败窗口：不自动重启
    const lastId = list[list.length - 1].id;
    if (lastReadPos[listId] === lastId) return;                    // 已读到末条：无新内容不重播
    // 续播：从当前位置继续（progress/e 机制顺序推进 391→392…，不跳最后 396）
    resumeFromCurrentPos(listId);
  });
}

// ── pi-web 原生 agent 事件流（2026-09-05）─────────────────────────────
// 蹭 ChatWindow 同款推送 /api/agent/<sid>/events：页面实时接收 agent 会话事件
// （message_end 正文块完成 / agent_settled 一轮完成…）。不依赖扩展服务端
// onAgentSettled（外部来源/未结算的 agent 消息更新到不了扩展）。事件驱动、零轮询。
// ⚠ 流式 delta（message_update）绝不触发网络请求：正文逐字推送期间若刷列表，会退化成
//   每 1.5s 一次的 /messages?idsOnly=1 全量对账（2026-09-05 用户实测：多个标签页未跟读
//   也持续狂打该接口+服务端每次全量解析会话）。只在正文块完成/一轮完成时各刷一次。
let agEsRef = null;
let agEsSessionId = null;
// ── A05 基线计数仪表（docs/todo-aiti-ai-speek-dual-sse-redundancy.md §5/E）：
// 双 SSE 冗余治理的自动观测面。真实跟读会话跑一轮即产出基线（console 每轮 dump 一行，
// 或控制台读 window.__aiSpeekBaseline），B/C 是否立项据此数据拍板，无需人工数帧。──
const baseline = {
  turns: 0,
  agentFrames: 0,
  agentFramesByType: {},
  extSseFrames: 0,
  messagesIdsOnly: 0,
  messagesContent: 0,
  startedAt: Date.now(),
};
function bumpBaseline(key) { baseline[key] = (baseline[key] || 0) + 1; }
function dumpBaseline(reason) {
  try {
    console.log("[ai-speek 基线] " + (reason || "") + " " + JSON.stringify({
      turns: baseline.turns,
      agentFrames: baseline.agentFrames,
      byType: baseline.agentFramesByType,
      extSseFrames: baseline.extSseFrames,
      idsOnly: baseline.messagesIdsOnly,
      content: baseline.messagesContent,
    }));
  } catch { /* noop */ }
}
try {
  window.__aiSpeekBaseline = baseline;
  window.__aiSpeekBaselineDump = dumpBaseline;
} catch { /* non-DOM */ }

function subscribeAgentEventStream(sessionId, listId) {
  if (!sessionId) return;
  if (agEsRef && agEsSessionId === sessionId) return;
  try { if (agEsRef) agEsRef.close(); } catch { /* noop */ }
  agEsSessionId = sessionId;
  try {
    const es = new EventSource(state.apiUrl("/api/agent/" + encodeURIComponent(sessionId) + "/events"));
    agEsRef = es;
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data || "{}"); } catch { return; }
      const t = d && d.type;
      // A05 基线：agent 流帧解析量（噪音主体：message_update/tool_execution_update）
      baseline.agentFrames++;
      if (t) baseline.agentFramesByType[t] = (baseline.agentFramesByType[t] || 0) + 1;
      if (t === "turn_end") dumpBaseline("turn_end");
      if (t === "turn_start") baseline.turns++;
      // message_end=assistant 正文块完成（含正文才计，与扩展服务端 updating 同粒度）：
      // 刷一次列表+续读；agent_settled=一轮完成：才谨慎续读；message_update（流式 delta）：忽略
      if (t === "message_end") {
        const m = d && d.message;
        const hasText = !!m && m.role === "assistant" && Array.isArray(m.content)
          && m.content.some((c) => c && c.type === "text" && String(c.text || "").trim().length > 0);
        if (!hasText) return;
        // [A 附带] 正文无条件直写缓存（带事件真实 id；不进任何节流/账本——settled 被抢窗
        //   时文本仍可命中）。full 模式才可客户端复刻服务端提取；essentials 置 null 走原路。
        cacheMessageText(listId, m);
        try { handleUpdating(listId); } catch { /* noop */ }
      } else if (t === "agent_settled") {
        try { handleSettledResume(listId); } catch { /* noop */ }
      }
    };
    es.onerror = () => { /* EventSource 自愈重连 */ };
  } catch { /* noop */ }
}
function unsubscribeAgentEventStream() {
  if (agEsRef) { try { agEsRef.close(); } catch { /* noop */ } agEsRef = null; }
  agEsSessionId = null;
}
export function subscribeSession(sessionId, listSessionId) {
  // 订阅跟随 followOn（由 FollowToggle effect 统一开关）：跟读关闭不建 SSE、不拉列表（0 请求）；
  // 开启时由 onopen 对账 + settled/updating/agent 事件流维持列表与续读。
  // ⚠ 双 id：sessionId = SSE 广播桶键（agent 侧 id，onAgentSettled 按它广播）；
  //   listSessionId = 列表/文本/播放键（root uuid，readSession 按它可读消息）——两者在不同页面形态下不同。
  const listId = listSessionId || sessionId;
  if (!sessionId) { unsubscribeSession(); return; }
  if (esRef && esSessionId === sessionId) return;
  unsubscribeSession();
  esSessionId = sessionId;
  try {
    const url = state.apiUrl("/api/extensions/aiti-ai-speek/events") + "?session=" + encodeURIComponent(sessionId);
    const es = new EventSource(url);
    esRef = es;
    sseConnectedAt = Date.now();
    es.onmessage = () => { bumpBaseline("extSseFrames"); };
    es.onopen = () => {
      try { window.__sseOpen = Date.now(); } catch { /* noop */ }
      // 连接建立时全量对账：覆盖「页面打开前 AI 已生成但错过 settled 广播」的消息
      // （settled 只在完成时发一次，错过不补发；这里以服务端列表为准）
      ensureSessionLoaded(listId, true).then((list) => {
        // 重连对账后自动续读最新：幽灵期/断线期错过的 settled 不补发，onopen 是全量对账
        // ——列表有新消息但未在播 → 直接续读最新（与 settled 未在播分支同条件：不抢主动启动/失败窗口）
        if (!state.followOn || state.playing || state.paused) return;
        const lastId = list && list.length ? list[list.length - 1].id : null;
        if (!lastId) return;
        if (Date.now() - lastIntentionalStartAt < 1500) return; // 刚主动启动/恢复：不抢
        if (Date.now() - failToastAt < 5000) return;            // 失败窗口：不自动重启
        if (lastReadPos[listId] === lastId) return;             // 已读到末条：无新消息不打扰
        resumeFromCurrentPos(listId); // 从当前位置续播（progress/e 顺序推进 391→392…，不跳最后 396）
      });
    };
    es.addEventListener("settled", (ev) => {
      sseSettledCount++;
      if (state.fileBucket) return; // during file read: AI messages never mix into the file queue (fileMode)
      try {
        const d = JSON.parse(ev.data || "{}");
        const text = d && d.text;
        if (!text) return;
        // 以服务端全量列表为准强制刷新（id 是真实 entryId；SSE 帧无 id → 手动拼的
        // sse-<ts> 伪 id 不可靠且会重复入列。刷新后新消息已含在列表末尾）
        // force 刷新节流：readSession 全量解析较慢（大会话 2-3s），连续 settle 合并为一次对账；
        // [A] settled 轮账本：agent_settled 路 15s 内已认领本轮（先到且隔窗 2s+）→ 整路跳过
        //（text 已由 message_end 直写缓存兜住，这里只需防二次全量解析 + 双 resume 竞态）
        const now = Date.now();
        if (now - lastForceRefreshAt > 2000) {
          if (!claimSettledTurn(listId)) return;
          lastForceRefreshAt = now;
          ensureSessionLoaded(listId, true).then((list) => {
            const lastId = list && list.length ? list[list.length - 1].id : null;
            // 立即缓存文本（不依赖服务端再拉）；若列表已含该条则覆盖缓存
            if (lastId) {
              if (!state.textCache[listId]) state.textCache[listId] = {};
              state.textCache[listId][lastId] = text;
            }
            notify();
            // 仅跟读开启时自动入播：未在播 → 读最新一条；在播 → 追加到 curSegs 末尾
            if (!state.followOn) return;
            if (!state.playing && !state.paused) {
              // 主动恢复/开启后 1.5s 内的 settle（含重连 recent 补发帧）不抢启动——避免 resume 被 supersede；
              // 失败后 5s 不自动重启（防重复失败循环——用户拍卡住）；已读到末条不重播（防 settle 循环重播最后一条）；
              // 同一条 15s 内不重复自动续读（防循环）。尊重用户播放历史。
              if (lastId && Date.now() - lastIntentionalStartAt > 1500 && Date.now() - failToastAt > 5000
                  && lastReadPos[listId] !== lastId
                  && !(lastId === lastAutoResumeId && Date.now() - lastAutoResumeAt < 15000)) {
                lastAutoResumeId = lastId; lastAutoResumeAt = Date.now();
                resumeFromCurrentPos(listId); // 从当前位置续播，不跳最后（读了 391 续 392…）
              }
            } else {
            const segs = readableSegs(text);
            if (segs.length) {
              // 记录新消息在批次中的位置（批末推进/句内定位用），避免换批时把这条再读一遍。
              // ⚠ 整队列查重：同一消息已在队列任意位置 → 整段跳过（curSegIds + 句都不可重复追加）
              if (!state.curSegIds.includes(lastId)) {
                state.curSegStartMap[lastId] = state.curSegs.length;
                state.curSegIds.push(lastId);
                for (const s of segs) state.curSegs.push({ ...s, _id: lastId });
                // 新消息句立即入队预读（跟在队尾自然衔接）
                enqueuePrefetch(segs);
              }
            }
          }
        });
        }
      } catch { /* 坏帧忽略 */ }
    });
    // updating：正文本块完成（turn 未 settle）→ 刷新列表并继续追读（中间块后不再卡住）
    es.addEventListener("updating", () => { handleUpdating(listId); });
    // pi-web 原生 agent 事件流（ChatWindow 同款推送）：agent 消息更新不依赖扩展 SSE 也能刷新/续读
    subscribeAgentEventStream(listId, listId);
    es.onerror = () => { /* EventSource 自愈重连 */ };
  } catch (e) {
    state.lastError = String(e && e.message ? e.message : e);
    notify();
  }
}
export function unsubscribeSession() {
  if (esRef) { try { esRef.close(); } catch { /* noop */ } esRef = null; }
  esSessionId = null;
  unsubscribeAgentEventStream();
}

// ── steer 注入（每会话一次） ──
const LS_STEER = "aiti-ai-speek:steer";
function steerDone(sessionId) { try { const rec = JSON.parse(localStorage.getItem(LS_STEER) || "{}") || {}; return !!rec[sessionId]; } catch { return false; } }
function markSteerDone(sessionId) { try { const rec = JSON.parse(localStorage.getItem(LS_STEER) || "{}") || {}; rec[sessionId] = Date.now(); localStorage.setItem(LS_STEER, JSON.stringify(rec)); } catch { /* noop */ } }
export async function steerSession(sessionId) {
  if (!sessionId || !state.settings.steer) return;
  if (steerDone(sessionId)) return;
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/steer"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const d = await res.json().catch(() => null);
    if (d && d.ok && (d.injected === true || d.injected === false)) markSteerDone(sessionId);
  } catch { /* noop */ }
}

// ── edge-tts 可用性 ──
export async function fetchEdgeInfo(force = false) {
  try {
    const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/voices") + (force ? "?force=1" : ""));
    if (!res.ok) return;
    const d = await res.json();
    if (d && d.ok) {
      // Rich status (panel) + voice list (with preview samples) + local engine block
      setEdgeStatus({ ...d, voices: d.voices || [] });
      if (d.engines && d.engines.local) setLocalStatus(d.engines.local);
      if (Array.isArray(d.localVoices)) setLocalVoices(d.localVoices);
    }
  } catch { /* noop */ }
}
export function browserSpeechSupported() {
  try { return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function"; } catch { return false; }
}
/**
 * 引擎初始选择（entry 启动时调用）：
 *   - edge-tts 已装 → 默认引擎 auto（优先 edge，效果好）——新用户直接生效；
 *     老用户持久化过 browser（旧默认）→ 一次性升级到 auto（edge 可用时优先），用户可再手选回落。
 *   - edge 未装 / 浏览器不支持 → 引擎回落 browser（或报错提示）。
 *   in-flight dedupe: autoSelectEngine started by entry and readFileText's ensureEngineReady share
 *   one probe when concurrent (/voices is not requested twice).
 */
let initEngineInflight = null;
export async function initEngine() {
  if (initEngineInflight) return initEngineInflight;
  initEngineInflight = (async () => {
  const supported = browserSpeechSupported();
  state.browserUnsupported = !supported;
  // Probe both server engines (/voices carries edge + local status); auto-enable features once.
  await fetchEdgeInfo();
  const s = state.settings.engine;
  if (state.edgeAvailable && (s === "auto" || (s === "browser" && !state.engineUpgraded))) {
    // auto (default) stays auto (resolved prefers edge); legacy browser default upgrades once
    state.engineUpgraded = true;
    if (s === "browser") { state.settings.engine = "auto"; state.lastError = t("speek.notice.edgeDetected"); }
  } else if (s === "auto") {
    // auto = edge -> local -> browser: keep "auto" so a later local start is picked up on reload
    state.settings.engine = localReady() ? "auto" : "browser";
  }
  // No Web Speech on this device (common on mobile): an engine that needs the browser must be
  // replaced by a server-side one — but never override an explicit "local" choice (it is the
  // user's persistent selection and would look like the settings reset on every reload).
  if (state.browserUnsupported && (state.settings.engine === "auto" || state.settings.engine === "browser")) {
    if (state.edgeAvailable) {
      state.settings.engine = "edge";
      state.lastError = t("speek.notice.noWebSpeechEdge");
    } else if (localReady()) {
      state.settings.engine = "local";
      state.lastError = t("speek.notice.noWebSpeechLocal");
    }
  }
  if (state.browserUnsupported && !state.edgeAvailable && !localReady() && state.settings.engine === "browser") {
    state.lastError = t("speek.notice.noEngineAtAll");
  }
  persist();
  notify();
  })();
  try { await initEngineInflight; } finally { initEngineInflight = null; }
}
/** Engine readiness gate (once the first probe settles, state lives in state/settings and later
 *  calls pass through) — awaited before file-read playback starts: avoids the "probe not back →
 *  mis-select browser → error" race on phones without Web Speech */
let engineReadyOnce = null;
function ensureEngineReady() {
  if (!engineReadyOnce) engineReadyOnce = initEngine().catch(() => { /* probe failure never blocks (browser fallback semantics) */ });
  return engineReadyOnce;
}
/** 旧名保留（entry.tsx 仍引用） */
export async function autoSelectEngine() { return initEngine(); }

// ── 音色试听（切换音色时读一句：“我是 xxx，期待为你服务”）──
let previewAudio = null;
let previewToken = 0;
function previewSampleText(voiceId) {
  const pool = ttsBackendNow() === "local" ? (state.localVoices || []) : (state.edgeVoices || []);
  const v = pool.find((x) => x.id === voiceId);
  if (v && v.sample) return v.sample;
  const name = String(voiceId || "")
    .replace(/^zh-CN-/, "").replace(/Neural$/i, "").replace(/[-_]/g, "");
  return "我是" + (name || "当前音色") + "，期待为你服务。";
}
export function previewVoice(voiceId) {
  const tok = ++previewToken;
  // Stop the previous preview
  try { if (previewAudio) { previewAudio.pause(); previewAudio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  const backend = ttsBackendNow();
  const rate = state.settings.rate || 1;
  if (backend === "local" || (backend === "edge" && state.edgeAvailable)) {
    const text = previewSampleText(voiceId);
    const voice = voiceId || (backend === "local" ? ((state.localVoices[0] || {}).id || "") : defaultEdgeVoice());
    const url = state.apiUrl("/api/extensions/aiti-ai-speek/tts") +
      "?text=" + encodeURIComponent(text) +
      "&voice=" + encodeURIComponent(voice) +
      "&rate=" + encodeURIComponent(String(rate)) +
      (backend === "local" ? "&engine=local" : "");
    fetch(url).then((r) => (r.ok ? r.blob() : null)).then((blob) => {
      if (tok !== previewToken || !blob) return;
      try {
        const src = URL.createObjectURL(blob);
        const a = new Audio(src);
        if (backend === "local") { try { a.playbackRate = clampRate(rate); a.preservesPitch = true; } catch { /* noop */ } }
        previewAudio = a;
        a.play().catch(() => { URL.revokeObjectURL(src); if (previewAudio === a) previewAudio = null; });
        a.onended = () => { if (previewAudio === a) previewAudio = null; URL.revokeObjectURL(src); };
      } catch { /* noop */ }
    }).catch(() => { /* preview failures stay silent */ });
    return;
  }
  // Browser engine: speak one sentence via speechSynthesis
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const list = sortBrowserVoices((synth.getVoices?.() || []).filter((v) => /zh/i.test(v.lang || "")));
    const v = list.find((x) => x.name === voiceId || x.voiceURI === voiceId) || preferLangVoice(list);
    const u = new SpeechSynthesisUtterance("我是当前音色，期待为你服务。");
    if (v) { u.voice = v; u.lang = v.lang || "zh-CN"; }
    u.rate = rate;
    synth.speak(u);
  } catch { /* noop */ }
}

/** Preview one local voice regardless of the selected engine (voice management dialog). */
export async function previewLocalVoice(voiceId) {
  const tok = ++previewToken;
  try { if (previewAudio) { previewAudio.pause(); previewAudio = null; } window.speechSynthesis?.cancel(); } catch { /* noop */ }
  const text = previewSampleText(voiceId);
  const url = state.apiUrl("/api/extensions/aiti-ai-speek/tts")
    + "?engine=local&text=" + encodeURIComponent(text)
    + "&voice=" + encodeURIComponent(voiceId || "");
  try {
    const r = await fetch(url);
    if (!r.ok || tok !== previewToken) return false;
    const blob = await r.blob();
    if (!blob || tok !== previewToken) return false;
    const src = URL.createObjectURL(blob);
    const a = new Audio(src);
    previewAudio = a;
    a.onended = () => { if (previewAudio === a) previewAudio = null; URL.revokeObjectURL(src); };
    a.play().catch(() => { URL.revokeObjectURL(src); if (previewAudio === a) previewAudio = null; });
    return true;
  } catch {
    return false;
  }
}

// ── one-shot announcements (cross-extension `aiti-ai-speek.speak`) ────────────
// Other extensions need "say this now" without touching the follow-read queue/settings.
// This path owns its own <audio>, reuses the server cache, and opens the settings panel when the
// local service cannot be started (the panel is where venv/model problems get fixed).
let settingsOpener = null;
/** components.tsx registers the panel opener once the heavy chunk loads. */
export function setSettingsOpener(fn) { settingsOpener = typeof fn === "function" ? fn : null; }
/** Open the read-aloud settings dialog (failure recovery entry for other extensions). */
export function openSettingsUI() {
  try { settingsOpener?.(); return !!settingsOpener; } catch { return false; }
}

let announceAudio = null;
let announceToken = 0;
let announceResumeMain = false;

function killAnnounceAudio() {
  try { if (announceAudio) { announceAudio.pause(); announceAudio = null; } } catch { /* noop */ }
  try { if (typeof window !== "undefined") window.speechSynthesis?.cancel?.(); } catch { /* noop */ }
}
function resumeMainAnnouncePause() {
  if (!announceResumeMain) return;
  announceResumeMain = false;
  try { resume(); } catch { /* noop */ }
}
/** Stop the current one-shot announcement (follow-read state is restored). */
export function stopAnnounce() {
  announceToken++;
  killAnnounceAudio();
  resumeMainAnnouncePause();
  notify();
}

/**
 * Wait for the local service to reach `ready` via the prepare.json SSE stream.
 * Event driven (no polling); resolves on ready / failed / idle-stop / timeout.
 */
function waitLocalReady(ms = 0) {
  if (localReady()) return Promise.resolve({ ready: true });
  if (!ms || ms <= 0 || typeof EventSource === "undefined") return Promise.resolve({ ready: false });
  return new Promise((resolve) => {
    let es = null;
    let done = false;
    let timer = 0;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { es?.close(); } catch { /* noop */ }
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    try {
      es = new EventSource(state.apiUrl("/api/extensions/aiti-ai-speek/tts/progress"));
      es.addEventListener("prepare", (ev) => {
        let p = null;
        try { p = JSON.parse(ev.data || "null"); } catch { /* bad frame */ }
        const phase = String(p?.phase || "");
        if (phase === "ready") { state.localStatus = "ready"; finish({ ready: true }); }
        else if (phase === "failed") { state.localStatus = "error"; state.lastError = p?.message || "local TTS failed"; finish({ ready: false, failed: true, error: p?.message }); }
        else if (phase === "idle-stop") finish({ ready: false });
      });
      es.onerror = () => { /* EventSource reconnects; the timeout closes the loop */ };
    } catch { /* EventSource unavailable */ }
    timer = setTimeout(() => finish({ ready: false, timeout: true }), Math.max(1000, ms));
  });
}

/**
 * Make an engine ready for an announcement.
 * Only the local engine can be "started" (it bootstraps its own venv/model); edge/browser are probed.
 */
export async function ensureSpeak(opts = {}) {
  const want = String(opts.engine || "").trim();
  let engine;
  if (want === "local") engine = "local";
  else if (want === "edge" || want === "browser") engine = want;
  else engine = localReady() ? "local" : resolvedEngine(); // auto: never bootstrap on its own
  if (engine !== "local") {
    if (engine === "edge" && !state.edgeAvailable) return { ok: false, engine, code: "edge-unavailable", error: "edge-tts is not installed" };
    if (engine === "browser" && state.browserUnsupported) return { ok: false, engine, code: "browser-unsupported", error: "browser speech is unavailable" };
    return { ok: true, engine };
  }
  const r = await ensureLocal(opts.provider);
  if (r?.running) return { ok: true, engine: "local", provider: r.provider, baseUrl: r.baseUrl };
  if (r?.starting) {
    const w = await waitLocalReady(opts.waitMs ?? 0);
    if (w.ready) return { ok: true, engine: "local", provider: r.provider };
    if (w.failed) return { ok: false, engine: "local", code: "service-start-failed", error: w.error || "local TTS preparation failed" };
    return { ok: false, engine: "local", starting: true, code: "starting", error: "local TTS is being prepared" };
  }
  return { ok: false, engine: "local", code: "service-start-failed", error: r?.error || "local TTS failed to start" };
}

/** Snapshot for consumers (no side effects). */
export function speakStatus() {
  return {
    engine: resolvedEngine(),
    followOn: state.followOn,
    playing: state.playing,
    paused: state.paused,
    edgeAvailable: !!state.edgeAvailable,
    browserSupported: !state.browserUnsupported,
    local: {
      status: state.localStatus,
      provider: state.localProvider || "",
      baseUrl: state.localBaseUrl || "",
    },
  };
}

function playAudioOnce(src, token, rate) {
  return new Promise((resolve, reject) => {
    if (token !== announceToken) { resolve({ cancelled: true }); return; }
    const a = new Audio(src);
    a.preload = "auto";
    try { a.playbackRate = clampRate(rate); a.preservesPitch = true; } catch { /* older browsers */ }
    announceAudio = a;
    const done = () => { if (announceAudio === a) announceAudio = null; resolve({}); };
    a.onended = done;
    a.onerror = () => { if (announceAudio === a) announceAudio = null; reject(new Error("audio playback failed")); };
    a.play().catch((e) => { if (announceAudio === a) announceAudio = null; reject(new Error(String(e?.message || e))); });
  });
}

function speakBrowserOnce(text, token) {
  return new Promise((resolve, reject) => {
    if (token !== announceToken) { resolve({ cancelled: true }); return; }
    try {
      const synth = window.speechSynthesis;
      if (!synth) throw new Error("speechSynthesis unavailable");
      const u = new SpeechSynthesisUtterance(text);
      const v = pickBrowserVoice();
      if (v) { u.voice = v; u.lang = v.lang || "zh-CN"; }
      u.rate = clampRate(state.settings.rate);
      const myToken = announceToken;
      u.onend = () => resolve({});
      u.onerror = () => { if (myToken === announceToken) reject(new Error("browser speech failed")); else resolve({ cancelled: true }); };
      synth.speak(u);
    } catch (e) {
      reject(e);
    }
  });
}

/** Synthesize one segment through the extension endpoint and play it (cache hit = instant). */
async function announceServerSeg(seg, engine, voice, token, rate) {
  const body = engine === "local"
    ? { texts: [seg.text], voice, engine: "local" }
    : { texts: [seg.text], voice, rate };
  const res = await fetch(state.apiUrl("/api/extensions/aiti-ai-speek/tts-batch"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => null);
  const it = d && Array.isArray(d.items) ? d.items[0] : null;
  if (!it || !it.cached) {
    const err = new Error((it && it.error) || (d && d.error) || "synthesis failed");
    err.code = (it && it.code) || (d && d.code);
    throw err;
  }
  const src = state.apiUrl("/api/extensions/aiti-ai-speek/tts-cache/" + it.key);
  return playAudioOnce(src, token, rate);
}

/**
 * Speak a piece of text once (cross-extension API).
 *
 * opts: {
 *   engine?: "auto" | "edge" | "local" | "browser"   // default: the user's resolved engine
 *   voice?: string                                   // default: the current voice setting
 *   rate?: number                                    // default: the current speed setting
 *   start?: boolean                                  // allow bootstrapping the local service
 *   waitMs?: number                                  // how long to wait for the service (default 10000)
 *   interrupt?: boolean                              // stop the previous announcement (default true)
 *   wait?: boolean                                   // false = return as soon as playback starts
 *   showSettingsOnError?: boolean                    // open the settings panel on startup failure (default true)
 * }
 * @returns {Promise<{ok: boolean, engine?: string, segments?: number, code?: string, error?: string}>}
 */
export async function speakOnce(rawText, opts = {}) {
  const text = String(rawText || "").trim();
  if (!text) return { ok: false, code: "empty", error: "empty text" };
  const token = ++announceToken;
  killAnnounceAudio();
  resumeMainAnnouncePause();
  const showPanel = opts.showSettingsOnError !== false;
  const fail = (code, error) => {
    failToast(error || code);
    if (code === "service-start-failed" && showPanel) openSettingsUI();
    return { ok: false, code, error };
  };

  // Engine resolution: explicit > user setting (auto = edge -> local -> browser).
  const want = String(opts.engine || "").trim();
  let engine = want && want !== "auto" ? want : resolvedEngine();
  if (engine === "browser" && state.browserUnsupported) engine = localReady() ? "local" : (state.edgeAvailable ? "edge" : "local");
  if (engine !== "edge" && engine !== "local" && engine !== "browser") engine = "browser";

  if (engine === "local" || engine === "edge") {
    const allowStart = opts.start !== false && (engine === "local" || want === "" || want === "auto");
    if (engine === "local") {
      if (!localReady()) {
        if (!allowStart) return fail("not-ready", "local TTS is not running");
        const ready = await ensureSpeak({ engine: "local", waitMs: opts.waitMs ?? 10000 });
        if (!ready.ok) {
          if (ready.code === "service-start-failed") return fail("service-start-failed", ready.error);
          return fail(ready.code || "starting", ready.error || "local TTS is starting");
        }
      }
    } else if (!state.edgeAvailable) {
      return fail("edge-unavailable", "edge-tts is not installed");
    }
  }

  const segs = filterSegments(toSpeechSegments(text), "full");
  if (!segs.length) return { ok: false, code: "empty", error: "nothing speakable" };

  // Take the audio channel: pause an ongoing follow-read and restore it afterwards.
  if (state.playing && !state.paused) { announceResumeMain = true; try { pause(); } catch { /* noop */ } }

  const rate = opts.rate ?? state.settings.rate;
  const voice = String(opts.voice || state.settings.voice || "");

  const run = async () => {
    for (const seg of segs) {
      if (token !== announceToken) return { ok: true, cancelled: true };
      if (engine === "browser") await speakBrowserOnce(seg.text, token);
      else await announceServerSeg(seg, engine, voice, token, rate);
    }
    if (token === announceToken) { killAnnounceAudio(); resumeMainAnnouncePause(); notify(); }
    return { ok: true, engine, segments: segs.length };
  };

  if (opts.wait === false) {
    run().catch((e) => { console.log("[speek][announce]", String(e?.message || e)); });
    return { ok: true, engine, started: true, segments: segs.length };
  }
  try {
    return await run();
  } catch (e) {
    const code = (e && e.code) || "playback-failed";
    resumeMainAnnouncePause();
    if (code === "not-ready" || code === "network") {
      // The service died mid-announcement: report the preparation reason when we have one, wake
      // the service once, and let fail() open the panel so the user can fix it.
      const prep = state.localPrepare;
      const reason = prep && prep.phase === "failed" ? String(prep.message || "") : "";
      state.localStatus = "error";
      notify();
      void ensureLocal();
      return fail("service-start-failed", reason || String(e?.message || e));
    }
    return fail(code, String(e?.message || e));
  }
}

// ── 兼容旧名（组件层可能仍引用） ──
/** 旧 enqueue 接口：直接以单条文本塞入当前 curSegs 末尾 */
export function enqueue(text, sessionId, sourceId, startSeg) {
  const raw = String(text || "").trim();
  if (!raw) return;
  if (activeSessionId && sessionId && sessionId !== activeSessionId) return;
  if (!state.pageFocused) return;
  const segs = readableSegs(raw);
  if (!segs.length) return;
  const id = sourceId || ("enq-" + Date.now());
  for (const s of segs) state.curSegs.push({ ...s, _id: id });
  if (!state.playing) {
    state.curSeg = 0;
    if (!state.curSegs.length) return;
    playCurrentSeg();
  } else notify();
}
export function currentSourceId() { return curId(); }
export function replayCurrentPage(sessionId) { startFollowFromPageTop(sessionId); }
/** 停止态「播放」：从当前保留的位置继续（用户停止 + 点了几次下一条后，再次播放就从当前显示的位置读，
 *  不跳回旧 lastReadPos/页首）；无位置（从未播/刚切会话）才从当前页第一条可见开始。 */
export function resumeFromCurrentPos(sessionId) {
  if (!sessionId) return;
  const list = state.msgList[sessionId] || [];
  const idx = state.curIndex;
  const target = (idx >= 0 && list[idx]) ? list[idx].id : null;
  if (target) playAtSourceId(sessionId, target);
  else startFollowFromPageTop(sessionId);
}
/** 点读抑制消费：PlaybackBar「开启即自动读」询问是否刚由点读发起（已自行启动，勿再启动） */
export function consumeReadOnFollow() {
  const v = readOnFollowSuppress;
  readOnFollowSuppress = false;
  return v;
}
export function speakMessage(text, sourceId, sessionId) { readMessageFrom(text, sourceId, sessionId); }

// ── 诊断 ──
if (typeof window !== "undefined") {
  window.__speek = { state, playAtSourceId, prev, skip, stop, resumeSessionFromLastPos };
}

export function setCurrentSession(sessionId) {
  const next = sessionId || null;
  const changed = next !== activeSessionId;
  // 只有 sessionId 真的变化时，才释放旧缓存
  if (changed) {
    // 只有当旧 session 存在时才删除，防止都为 null 时也删
    if (activeSessionId) {
      delete state.msgList[activeSessionId];
      delete state.allMessagesLoaded[activeSessionId];
      delete state.textCache[activeSessionId];
    }
    activeSessionId = next;
    // switching back to a real session (non-file: bucket) = file-read semantics end: clear the
    // bucket + clear follow highlights (not cleared when readFileText installs a file: bucket — the
    // new bucket overwrites right after; the END return-switch clears first, then setCurrentSession)
    if (state.fileBucket && (!next || !String(next).startsWith("file:"))) {
      state.fileBucket = null;
      clearEditorFollow();
    }
    // 切会话：只有【从未读过】的会话才置零（0/新总数）；
    // 【读过的】等列表加载后直接恢复 lastReadPos 历史进度显示（用户要求：读完过就该显示读到哪）
    state.curIndex = -1; state.curSeg = 0; state.curSegs = [];
  }
  // 同一个 session，也要重置播放状态，确保 prev/skip 按钮可用；同会话停止保留当前位置
  stop();
  // 自动预加载当前 session 的消息索引（只拉 id+key，不拉文本），保证 prev/skip 按钮始终可用
  if (next) {
    ensureSessionLoaded(next).then((list) => {
      // 已读过的会话：恢复历史进度（lastReadPos → msgList 索引），进度显示「上次读到 x/y」而非 0／新总数
      const pos = lastReadPos[next];
      if (pos && Array.isArray(list)) {
        const idx = list.findIndex((m) => m.id === pos);
        if (idx >= 0) { state.curIndex = idx; notify(); }
      }
    });
  }
  notify();
}
