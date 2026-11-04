/**
 * AI input · 语音来源标记 + 行内自动补全 + 收藏联想 —— 核心逻辑层（自手写单文件版拆分）。
 *
 * 命令式 DOM 逻辑保持与原实现一比一（事件委托、模块级状态、ghost overlay/建议条直操 DOM）；
 * 渲染组件在 components.tsx（JSX），入口装配在 entry.tsx。
 *
 * 能力与设计依据见 README / docs/aiti-voice-input-plan.md / docs/aiti-input-autocomplete-plan.md。
 */

/**
 * AI input · 语音来源标记（最小切片）—— client bundle
 *
 * 能力（单一功能）：
 *   1. 检测【系统输入法语音输入】（Gboard 听写 / iOS 听写 / 桌面系统听写）：
 *      document capture 监听 beforeinput/composition，按特征打分——
 *        insertReplacementText（整段替换）          +3
 *        deleteContent 大范围（getTargetRanges>5）  +2
 *        insertText 整句上屏（data.length≥15）      +2
 *        insertFromDictation（iOS 听写专用）        +3
 *        极短间隔大段（<100ms 且 >8 字）            +1
 *      累计 ≥2 → 置 voicePending（保持到发送/手动清除）
 *      介入门槛：语音段 ≥15 字才提示/修复（少量输入用户自己解决，防空/短输入误报）
 *      排除：拼音组词（composition 期间/结束 2s 内）、粘贴/拖放
 *   2. 检测到 → chatInputTop 显示「🎤 疑似语音输入」标记条（用户可 ✕ 删除）
 *   3. 不删除 → preSend 在消息末尾附加 [语音输入：…] 标记（与 [发自:] 并列、幂等）
 *
 * 设计依据：docs/aiti-voice-input-plan.md §9（先行最小版）
 */

// ---------- 模块级状态（跨组件共享；listener 模式） ----------
import { extSvc } from "./host-shim";
import { uiAlert, uiConfirm } from "../../../_shared/ui-dialogs";

let voicePending = false;
// 语音段边界 {prefix, suffix}：语音输入作用前输入框中已存在的内容（语音插入位置之前/之后）
// —— 语音修复只作用于「语音段」（最后一段），保留先前内容；边界校验失败才回落整段替换
let voiceSeg = null;
const listeners = new Set();
function notify() { for (const l of listeners) l(); }
function setVoicePending(v) {
  if (v) {
    // 每次置位都重新调度（debounce 重置）：语音流式持续增长时，停顿 1.5s 后修的是**最新**文本（长句修完整句，不修中途）
    voiceFixSchedule();
  }
  if (voicePending !== v) { voicePending = v; notify(); }
  if (!v) { score = 0; voiceSeg = null; } // 关闭时重置特征分（防长期漂移误触发）+ 清边界（候选已存 VOICE_ITEMS，下次语音重新捕获）
  // 注意：不在此 barClear("voice")——感知条与替换建议条已解耦；建议条由 voiceFixReset/替换/发送清理
}

// 中/英随界面语言（与 aiti-devtools 同款判定：localStorage pi-locale 权威，fallback <html lang>）
// （语音修复现走主动修复+建议条，不再附发送标签——VOICE_TAG 已无引用）

// ---------- 语音输入检测（document capture，事件委托，不依赖 React 内部） ----------
const VOICE_MIN_LEN = 15; // 介入门槛：语音段 ≥15 字才提示/修复（少量输入用户自己解决，防空/短输入误报）
let lastTs = 0;          // 上次非组词 input 事件时间（节奏特征）
let compEndAt = 0;       // 最近一次 compositionend 时间（拼音整句上屏排除）
let score = 0;           // 特征累计分
// composition 型语音流式跟踪（鸿蒙/部分 Android 输入法语音 = 组词式流式上屏，实测形态：
// compositionstart → insertCompositionText 逐字递增（"我"→"我要"→"我要输"…整句）→ compositionend）
let compTrack = { active: false, maxLen: 0, events: 0, firstTs: 0, lastTs: 0, lastLen: 0 };

// 目标输入框判定：优先 ChatInput textarea 的 data-chat-input 锚点（pi-web 一行改动）；
// fallback = 正在聚焦的可编辑 textarea（dev/生产未同步锚点时兜底）
function isChatInput(t) {
  if (!t || t.nodeType !== 1) return false;
  try {
    if (t.closest && t.closest("[data-chat-input]")) return true;
  } catch (e) {}
  return t.tagName === "TEXTAREA" && document.activeElement === t && !t.readOnly && !t.disabled;
}

// 捕获语音段边界：当前 beforeinput 事件【作用前】输入框已有内容 = prefix + suffix
// （target range 给出将被替换/插入的范围；语音文本 = 最终值中的 prefix..suffix 之间那一段）
function captureVoiceSeg(ta, e) {
  let s, en;
  try {
    const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
    const r = ranges && ranges[0];
    if (r) { s = r.startOffset; en = r.endOffset; }
  } catch (e2) {}
  if (s == null) s = (ta && ta.selectionStart) ?? 0;
  if (en == null) en = (ta && ta.selectionEnd) ?? (ta ? ta.value.length : 0);
  voiceSeg = { prefix: (ta ? ta.value : "").slice(0, s), suffix: (ta ? ta.value : "").slice(en) };
}

function onBeforeInput(e) {
  if (!isChatInput(e.target)) return;
  const it = e.inputType || "";
  const now = performance.now();
  const dataLen = (e.data && e.data.length) || 0;

  // composition 期间（拼音组词 / 语音流式）：只做流式语音检测，不参与非组词打分
  if (e.isComposing || it === "insertCompositionText") {
    if (compTrack.active) {
      compTrack.events++;
      const gap = now - compTrack.lastTs;
      compTrack.lastTs = now;
      const monotonic = dataLen >= compTrack.lastLen; // 语音流式纯追加；拼音选词可能回退/跳跃
      compTrack.lastLen = dataLen;
      if (dataLen > compTrack.maxLen) compTrack.maxLen = dataLen;
      // 流式语音特征：事件密集 + 长度单调增长到整句——拼音打字有人的节奏（间隔 300ms+、常停顿选词），语音流式均匀密集；且整句 ≥15 字才介入（短句不打扰）
      if (compTrack.events >= 3 && compTrack.maxLen >= VOICE_MIN_LEN && monotonic &&
          (now - compTrack.firstTs) / compTrack.events < 900) {
        if (AC.feats.voiceFix) {
          // 组词式流式语音：整句在 composition 内追加 → 边界 = composition 开始前输入框内容
          voiceSeg = { prefix: compTrack.pre || "", suffix: "" };
          setVoicePending(true);
        }
      }
    }
    return;
  }

  // composition 结束 2s 内的 insertText：短段（<15 字）当拼音候选上屏忽略；大段（≥15 字）视为语音整句上屏（采样一次）
  if (it === "insertText" && now - compEndAt < 2000) {
    if (dataLen >= VOICE_MIN_LEN) { if (AC.feats.voiceFix) { captureVoiceSeg(e.target, e); setVoicePending(true); } }
    return;
  }
  // 粘贴/拖放/自动填充不算
  if (it === "insertFromPaste" || it === "insertFromPasteAsQuotation" || it === "insertFromDrop") return;

  const gap = now - lastTs;
  lastTs = now;

  let affected = 0;
  try {
    const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
    for (const r of ranges) affected += (r.endOffset - r.startOffset);
  } catch (e3) {}

  let s = 0;
  if (it === "insertReplacementText") s += 3;                       // 整段替换（语音纠错最典型）
  else if (it === "deleteContent" && affected > 5) s += 2;          // 大范围删除（整段删 vs 逐字删）
  if (it === "insertFromDictation") s += 3;                         // iOS 听写专用 inputType
  if (it === "insertText" && dataLen >= VOICE_MIN_LEN) s += 2;    // 整句上屏（打字 1-2 字）
  if (gap < 100 && dataLen > 8) s += 1;                             // 极短间隔大段（语音流式分段）
  if (s > 0) {
    score += s;
    if (!voicePending) captureVoiceSeg(e.target, e); // 首个特征事件：记住语音段起点（该事件作用前的输入框内容）
    // 介入门槛：本次语音段（prefix..suffix 区间）预计长度 ≥15 字才提示/修复——空/短输入不打扰（少量输入用户自己解决）
    const v0 = e.target.value || "";
    const segLen = voiceSeg ? Math.max(0, v0.length - (voiceSeg.prefix || "").length - (voiceSeg.suffix || "").length) + dataLen : dataLen;
    if (score >= 2 && AC.feats.voiceFix && segLen >= VOICE_MIN_LEN) setVoicePending(true);
  }
}

function onCompositionStart(e) {
  compTrack = { active: true, maxLen: 0, events: 0, firstTs: performance.now(), lastTs: performance.now(), lastLen: 0, pre: (e.target && e.target.value) || "" };
}
function onCompositionEnd(e) {
  compTrack.active = false;
  compEndAt = performance.now();
}

// ==================== 自动补全（inline autocomplete） ====================
// 设计：docs/aiti-input-autocomplete-plan.md §3/§4/§8
// 交互：打字静止 700ms 且光标在文本末尾 → 灰字显示下一句；Tab/→ 接受一句 →
//       250ms 后自动续下一句（逐句流）；Esc/继续打字/光标移动取消。
// 两层（L0 本地秒出 → L1 AI）：
//   L0：输入停顿 250ms 即**先查本地**（收藏 prompt + 会话历史，服务端零模型前缀匹配）——命中即灰字直出
//       + ↦收藏/↦历史 角标，**不请求 AI**；豁免 IME 冷却（拼音组合结束即出），与收藏弹窗共存
//       （localOnly=只跑 L0，0 出网）；
//   L1：L0 未命中才在完整 700ms 时请求同款模型小请求（0.4–2s 后出灰字，在途时灰字先空着，弹窗开着时让位）。
// 请求：POST /api/extensions/aiti-ai-input/complete（扩展 server；L0 零模型 / L1 走 core.invokeAI）
const AC_DEBOUNCE = 700;       // L1 AI 触发延迟（ms）
const AC_DEBOUNCE_L0 = 500;    // L0 本地层触发延迟（ms）——本地秒出，打字停顿即出灰字，不等 AI
// 开页方案 §6：原 250ms 与 suggest 的 150ms 各自成链路 → 实测打字期 ~2 请求/击键
//（20-60 次/分钟）。400-500ms 仍属“停顿即出”，但把相邻击键合并成一次请求。
const AC_ACCEPT_REDELAY = 250; // 接受后续下一句延迟（ms）
const AC_IME_COOLDOWN = 1500;  // composition 结束后冷却
const AC = {
  ta: null, extra: null, ghost: null, pendingValue: null,
  timer: null, aborter: null, localAborter: null, lastKey: null, lastCompEnd: 0, composing: false, stamp: 0,
  overlay: null, mirror: null, apiUrl: null,
  anchor: null, // 灰字显示时的输入框视口快照（scroll 时比对锚点是否真移动）
  // features（extman 管理）：host 统一维护共享 store（manifest 一次拉取，ctx.getFeatures 读）；
  // extman 变更 → host patch store → ctx.onFeatureChange 通知 → 重读——零请求/零轮询。
  feats: { autoComplete: true, localOnly: false, minChars: 3, suggest: false, suggestRun: false, ctx: "medium", voiceEnabled: false, voiceFix: false, voiceIndicator: false, asrStreaming: true, asrVad: true, asrSplit: true, asrPass2: true, asrModelStream: "iic/SenseVoiceSmall" },
  getFeatures: null, onFeatureChange: null,
};
// 当前会话模型（跟聊天界面的 model 走，不写死）：ChatInput props → AC.extra.model
function curModel() {
  try {
    const m = AC.extra && AC.extra.model;
    if (m && m.provider && m.modelId) return { provider: String(m.provider), modelId: String(m.modelId) };
  } catch (e) {}
  return null;
}

// ---------- 小屏建议条（文档流，替代 fixed 弹窗/ghost overlay；touch 点按生效） ----------
let ACbar = null;      // 建议条容器（chatInputTop 内，组件渲染，模块填充）
let isCoarse = false;  // pointer:coarse（触控/无精确指针）→ 小屏模式
let sugActive = false; // 收藏联想（SUG）保有结果显示时，AC 让位、不覆盖建议条
// 双 keydown handler 都在 document capture（acHandleKey 先注册、sugOnKey 后注册），
// stopPropagation 拦不住同节点后注册者——同一 keydown 只允许一个 handler 落地（Tab/Esc/箭头）
let keyConsumedAt = 0;
function acUpdateCoarse() {
  try {
    isCoarse = !!window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
  } catch (e) { isCoarse = false; }
  if (ACbar) ACbar.style.display = isCoarse ? "flex" : "none";
  if (!isCoarse) acHideBar();
}
// 建议条内容：由调用方（AC/SUG）先 acRenderBar 再填充；整体重建避免残留
function acRenderBar() {
  if (!ACbar) return null;
  ACbar.innerHTML = "";
  return ACbar;
}
function acHideBar() { if (ACbar) ACbar.innerHTML = ""; }

// ---------- 建议聚合区（词云换行；多来源归一为统一候选抽象） ----------
// 一条候选 = { type, short, full }：type=ai/voice/prompt/cmd/suggest-empty · short=简短名（占位符/标签用） · full=完整内容。
// 渲染、点按全部按统一规则处理，不因来源分叉。
const BARP = { items: [], markMap: {}, marks: [] }; // marks: [{mark,name,text,type,id}] 已插入待选区（供 chips 展示与发送展开）
const BARP_LABEL = { ai: "续写", voice: "语音", prompt: "收藏", cmd: "命令", "suggest-empty": "AI", local: "收藏", history: "历史" };
// 收藏/命令 的点按分派由 register 内注入（其依赖 SUG 闭包状态，不能在模块级直调）；
// 注入实现：短→填入 · 长→[short] 占位。
let pickPromptUser = null;   // prompt/cmd 点按分派（register 注入）
let pickEmptyUser = null;    // suggest-empty（“让 AI 生成”）分派（register 注入）
let runCmdUser = null;       // cmd 候选 ⚡ 一键执行分派（register 注入；依赖 SUG 闭包与 AC.apiUrl）
function barSet(kind, list) {
  BARP.items = [...BARP.items.filter((x) => x.tag !== kind), ...list.map((i) => ({ tag: kind, type: i.type, short: i.short, full: i.full, rich: i.rich, item: i.item }))];
  barRender();
}
function barClear(kind) {
  if (kind) BARP.items = BARP.items.filter((x) => x.tag !== kind);
  else BARP.items = [];
  barRender();
}
// 语音修复候选条是否正在显示（有「替换」候选）：是 → AC 让位互斥；否 → 放行/收起感知条
function voiceItemsActive() {
  return BARP.items.some((x) => x.tag === "voice");
}
// 摘除一个已插占位符（待选区 chip ✕）：从输入框移除 [名称] 并清元数据
function barRemoveMark(m) {
  const ta = document.querySelector("textarea[data-chat-input]");
  if (ta) {
    const nv = ta.value.split(m.mark).join("");
    if (nv !== ta.value) acSetTaValue(ta, nv);
  }
  BARP.marks = BARP.marks.filter((x) => x.mark !== m.mark);
  delete BARP.markMap[m.mark];
}
// 统一显示文本：full 短 → 显示 full；full 长 → 显示 short（配合占位符）；无 full → short
function barDisplay(it) {
  const f = it.full || "";
  if (it.type === "suggest-empty") return it.short;
  if (f && f.length <= 60) return f;
  return it.short || f;
}
function barIsLong(it) { return !!it.full && it.full.length > 60 && it.type !== "ai" && it.type !== "voice"; }
function barMulti(it) { return it.type === "voice" || (it.full || "").length > 30; }
// 统一点按：按 type 分派（不因来源写多份）
function barPick(it) {
  if (it.type === "ai" || it.type === "local" || it.type === "history") { AC.ghost = { text: it.full || "", source: it.type === "ai" ? "ai" : "local" }; acAcceptGhost(); }
  else if (it.type === "voice") { voiceFixApply(it.item); }
  else if (it.type === "suggest-empty" && pickEmptyUser) pickEmptyUser();
  else if (pickPromptUser) pickPromptUser(it); // prompt/cmd：由 register 注入的实现分派（短→填入 · 长→占位）
}
function barRender() {
  if (!ACbar) return;
  if (!BARP.items.length) { acHideBar(); return; }
  const bar = acRenderBar();
  for (const it of BARP.items) {
    const tail = it.type === "ai" ? "↘" : it.type === "voice" ? "替换" : barIsLong(it) ? "⊕ 占位" : "";
    const row = acBarRow(BARP_LABEL[it.type] || "?", barDisplay(it), () => barPick(it), { tail, long: barIsLong(it), multiLine: barMulti(it), rich: it.rich });
    // suggest ⚡ 一键执行（§3.4；cmd 候选 + feature 开）：独立小胶囊（button 不嵌套），
    // 点按分派 runCmdUser（sugRunCmd 两段式确认），与「填入」胶囊并列
    if (it.type === "cmd" && AC.feats.suggestRun && runCmdUser && it.item) {
      const wrap = document.createElement("span");
      wrap.style.cssText = "display:inline-flex;gap:4px;align-items:stretch;max-width:100%;";
      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.textContent = "⚡";
      runBtn.title = "执行此命令（危险命令会二次确认）";
      runBtn.style.cssText = "border:1px solid var(--border,#e0e0e0);background:var(--bg,#ffffff);color:var(--text,#1a1a1a);border-radius:999px;padding:5px 9px;font-size:13px;line-height:1.5;cursor:pointer;touch-action:manipulation;";
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
      runBtn.addEventListener("pointerdown", (e) => { swallow(e); runCmdUser(it.item); });
      runBtn.addEventListener("touchend", swallow, { passive: false });
      runBtn.addEventListener("click", swallow);
      wrap.appendChild(row);
      wrap.appendChild(runBtn);
      bar.appendChild(wrap);
      continue;
    }
    bar.appendChild(row);
  }
}

// ---------- 语音歧义修复（主动：检测语音输入 → AI 判定 → 仅当有歧义才显示替换建议） ----------
// 复用自动完成服务（mode=voice-fix）与建议条；无歧义静默（并自动关语音标记，发送不再附标签）。
const VOICE_FIX = { active: false, timer: null, dismissTimer: null, aborter: null, text: "", snapshot: "", seg: null, segText: null, diff: null, orig: null, loc: null };
const VOICE_FIX_DEBOUNCE = 1500; // 语音上屏稳定后触发（等完整句，避免中途残缺句误判）
const VOICE_PENDING = new Map(); // key → AbortController：在途语音修复请求（同句去重 + voiceFixReset 可取消）
const VOICE_ITEMS = new Map();   // id → 候选条目：多实例多句并行，各自展示/替换（voiceItemsActive 读 BARP 判定显示）
let voiceSeq = 0;                // 候选条目自增 id（多句并行不冲突）

// ---------- 语音段定位工具（只处理/替换当前这一句，绝不整段/整框替换） ----------
// 编辑距离（Levenshtein，字符级）
function editDist(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  if (n > m) { const t = a; a = b; b = t; }
  const row = new Array(m + 1);
  for (let j = 0; j <= m; j++) row[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[m];
}
// 全文定位与 orig 最相似的子串（内容优先，期望位置做 tie-break → 倾向「第几句」原位）
// 搜索范围限定在原位附近（锚失效时语音段大概率只在原位小幅改动）——超长输入框不卡 UI
function fuzzyLocate(haystack, needle, expectedPos) {
  const n = needle.length;
  if (!haystack || !n) return null;
  const w = Math.max(2, Math.round(n * 0.2));   // 允许的窗口长度浮动
  const maxD = Math.max(1, Math.round(n * 0.2)); // 高精度阈值（20% 容错）
  const R = Math.max(300, n * 4);               // 搜索半径（字符）
  let lo = 0, hi = haystack.length;
  if (expectedPos != null) { lo = Math.max(0, expectedPos - R); hi = Math.min(haystack.length, expectedPos + R + n); }
  else if (haystack.length > 800) { lo = Math.max(0, haystack.length - Math.max(600, n * 6)); } // 无位置提示且超长：只搜末尾（语音段通常是最后一句）
  let best = null;
  for (let len = Math.max(1, n - w); len <= n + w; len++) {
    for (let s = lo; s + len <= hi; s++) {
      const cand = haystack.slice(s, s + len).trim();
      if (!cand) continue;
      const d = editDist(cand, needle);
      const posPen = expectedPos == null ? 0 : Math.min(Math.abs(s - expectedPos), 500);
      const score = d * 100 + posPen;
      if (!best || score < best.score) best = { start: s, end: s + len, d, score };
    }
  }
  if (!best) return null;
  return { start: best.start, end: best.end, d: best.d, ok: best.d <= maxD };
}
// 取最后一句（语音段兜底）：按换行/句末标点切分，返回 {text, start, sentNo}
function lastSentence(text) {
  if (!text) return null;
  let start = 0, sentNo = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" || /[。！？!?…；;]/.test(text[i])) { start = i + 1; sentNo++; }
  }
  const seg = text.slice(start).trim();
  if (!seg) return null;
  return { text: seg, start, sentNo };
}
// prefix 内完整句数（语音段为其后第 sentNo+1 句）
function sentNoOf(prefix) {
  let n = 1;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] === "\n" || /[。！？!?…；;]/.test(prefix[i])) n++;
  return n;
}
// 提取待修语音段（只处理「最后一句」）：优先 prefix/suffix 锚定区间，区间含多句（两次快速语音竞态
// 把多句包进来）时收敛到最后一句；锚失效 → 取整段最后一句。绝不整框提交/整框替换。
function extractVoiceSeg(v) {
  const seg = voiceSeg;
  if (seg && (seg.prefix || seg.suffix)) {
    const P = seg.prefix, S = seg.suffix;
    if (v.startsWith(P) && v.endsWith(S) && v.length >= P.length + S.length) {
      const mid = v.slice(P.length, S ? v.length - S.length : v.length);
      const last = lastSentence(mid);
      const P2 = last && last.start > 0 ? v.slice(0, P.length + last.start) : P;
      const segText = (last && last.start > 0 ? last.text : mid).trim();
      if (segText) return { segText, loc: { prefix: P2, suffix: S, expectedPos: P2.length, sentNo: sentNoOf(P2), mode: "anchor" } };
    }
  }
  const last = lastSentence(v);
  if (last) return { segText: last.text, loc: { prefix: "", suffix: "", expectedPos: last.start, sentNo: last.sentNo, mode: "sentence" } };
  return null;
}
function voiceFixSchedule() {
  if (VOICE_FIX.timer) clearTimeout(VOICE_FIX.timer);
  VOICE_FIX.timer = setTimeout(() => {
    const ta = document.querySelector("textarea[data-chat-input]");
    if (!ta) return;
    const v = ta.value || "";
    const txt = v.trim();
    if (!txt) return;
    if (txt === VOICE_FIX.snapshot) return; // 文本没变：不重复修复（防同一句反复发请求）
    VOICE_FIX.snapshot = txt;
    const ex = extractVoiceSeg(v);
    if (!ex || ex.segText.length < VOICE_MIN_LEN) return; // 无待修句 或 语音段 <15 字：不介入（少量输入用户自己解决）
    const key = (ex.loc ? ex.loc.expectedPos : -1) + "|" + ex.segText;
    if (VOICE_PENDING.has(key)) return;   // 同一句已在途：不重复请求
    if ([...VOICE_ITEMS.values()].some((it) => it.key === key)) return; // 已显示候选：不重复
    voiceFixRun(ex.segText, ex.loc, key);
  }, VOICE_FIX_DEBOUNCE);
  // 兜底：结果最晚几秒内出（有歧义给了替换建议则感知条已随 setVoicePending(false) 消失）；
  // 若一直没结果（网络失败等）也在此超时后收起，避免感知条长驻
  if (VOICE_FIX.dismissTimer) clearTimeout(VOICE_FIX.dismissTimer);
  VOICE_FIX.dismissTimer = setTimeout(() => { if (!voiceItemsActive()) setVoicePending(false); }, 6000);
}
// 多实例：每个待修句一个独立请求（并行不 abort），返回后各自成为一条候选，同时展示、各自替换各自位置。
async function voiceFixRun(text, loc, key) {
  const ab = new AbortController();
  if (key) VOICE_PENDING.set(key, ab);
  const id = ++voiceSeq;
  try {
    const r = await fetch(AC.apiUrl("/api/extensions/aiti-ai-input/complete"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "voice-fix", input: text, ctx: AC.feats.ctx || "medium", cwd: AC.extra && AC.extra.cwd, model: curModel(), sessionId: AC.extra && AC.extra.sessionId }),
      signal: ab.signal,
    });
    if (!r.ok) return;
    const d = await r.json();
    if (ab.signal.aborted || !ACbar) return;
    const fix = d && typeof d.text === "string" ? d.text.trim() : "";
    if (!fix) {
      // 无歧义：不打扰（仅清本句在途）
      setVoicePending(false);
      return;
    }
    VOICE_ITEMS.set(id, {
      id, key, orig: text, loc,
      text: fix,
      diff: Array.isArray(d.diff) && d.diff.length ? d.diff : null,
    });
    // 多候选同时展示：所有待修句各自一条，互不覆盖；点哪条替换哪句
    barSet("voice", [...VOICE_ITEMS.values()].map((it) => ({ type: "voice", short: "", full: it.text, rich: it.diff, item: it })));
    if (ACbar) ACbar.style.display = "flex";
    setVoicePending(false); // 结果已出：感知条随之消失，仅留下方替换建议条
  } catch (e) { /* 静默（网络失败/中断：本句不产生候选） */ }
  finally { if (key) VOICE_PENDING.delete(key); }
}
function voiceFixApply(item) {
  const ta = document.querySelector("textarea[data-chat-input]");
  if (!ta || !item || !item.text) return;
  const v = ta.value;
  const fix = item.text;
  const orig = item.orig;
  const loc = item.loc;
  let range = null; // 待替换区间（只替换语音段这一句）
  // 1) 位置锚定（首选）：prefix/suffix 仍能定位 → 区间即当前语音段所在位置，直接替换。
  //    用户可能微调过这句（改字/删字/加字），只要前后锚还在，位置就是它——按用户选择整体换成修复句。
  if (loc && (loc.prefix || loc.suffix)) {
    const P = loc.prefix, S = loc.suffix;
    if (v.startsWith(P) && v.endsWith(S) && v.length >= P.length + S.length) {
      const s = P.length, e = S ? v.length - S.length : v.length;
      const mid = v.slice(s, e);
      // 区间非空 + 长度合理（防语音段中间被插入大段新内容 → 降级模糊）
      if (e > s && mid.trim() && mid.length <= Math.max(orig ? orig.length * 2.5 : 0, (orig ? orig.length : 0) + 12)) {
        range = { start: s, end: e };
      }
    }
  }
  // 2) 全文模糊：锚定失效（用户改了前后文/追加了内容）→ 按「第几句 + 原句关键词」高精度找回，宁缺毋滥
  if (!range && orig) {
    const f = fuzzyLocate(v, orig, loc ? loc.expectedPos : null);
    if (f && f.ok) range = { start: f.start, end: f.end };
  }
  // 3) 仍找不到：不覆盖用户已有内容，把修复句直接插入到输入框末尾（用户可自行整理/删除）
  if (!range) range = { start: v.length, end: v.length, append: true };
  const sep = range.append && v && v.length && !/\n\s*$/.test(v) ? "\n" : ""; // 末尾追加：非空且未以换行结尾 → 换行隔开
  acSetTaValue(ta, v.slice(0, range.start) + sep + fix + v.slice(range.end));
  acPlaceCaret(ta, range.start + sep.length + fix.length); // 光标到修复句后面
  try { console.log("[AI input] voice-fix #" + item.id + (range.append
    ? " 未定位 → 插入末尾: " + JSON.stringify(fix)
    : " 替换第 " + (loc ? loc.sentNo : "?") + " 句 [" + range.start + "," + range.end + "] " + JSON.stringify(v.slice(range.start, range.end)) + " → " + JSON.stringify(fix))); } catch (e) {}
  // 只移除并刷新这一个候选（其他待修句候选保留，可继续分别替换各自位置）
  VOICE_ITEMS.delete(item.id);
  barSet("voice", [...VOICE_ITEMS.values()].map((it) => ({ type: "voice", short: "", full: it.text, rich: it.diff, item: it })));
  if (!VOICE_ITEMS.size) setVoicePending(false); // 全部处理完：清语音标记（顺带清 voiceSeg）
  acUpdateCoarse();                              // 恢复 桌面隐藏/小屏空折叠 裁决
}
function voiceFixReset() {
  if (VOICE_FIX.timer) clearTimeout(VOICE_FIX.timer);
  for (const ab of VOICE_PENDING.values()) ab.abort();
  VOICE_PENDING.clear();
  VOICE_ITEMS.clear();
  voiceSeg = null;
  barClear("voice");
}
// 建议条通用胶囊行（横向滑动候选：input 法候选词条样式——一行高度、不推输入区、点按接受、超出横向滑动）
// 建议条统一行（AC 续写 / 收藏候选同款样式）：整行横条、一次一条、无滚动条、点按接受
// 建议胶囊行（词云式，可换行收尾相连；类型用文字前缀区分）——短内容直插，长内容由调用方改占位符
function acBarRow(label, text, onClick, opts) {
  const b = document.createElement("button");
  b.type = "button";
  const isLong = !!opts && opts.long;
  const isMulti = !!opts && opts.multiLine;
  b.style.cssText = [
    "display:inline-flex;align-items:baseline;gap:6px;vertical-align:top;max-width:100%;box-sizing:border-box;",
    "padding:5px 10px;border:1px solid " + (isLong ? "var(--accent,#2563eb)" : "var(--border,#e0e0e0)") + ";",
    "background:var(--bg,#ffffff);color:var(--text,#1a1a1a);font-size:13px;line-height:1.5;border-radius:999px;",
    "cursor:pointer;touch-action:manipulation;" + (isMulti ? "flex-wrap:wrap;height:auto;" : "white-space:nowrap;overflow:hidden;") + " transition:background .12s;",
  ].join("");
  const tag = document.createElement("span");
  tag.textContent = label;
  tag.style.cssText = "flex-shrink:0;font-size:11px;font-weight:600;color:var(--accent,#2563eb);";
  const main = document.createElement("span");
  // 富文本候选（语音修复差异·简单版）：被删的字不显示（只呈现修复后的文本），
  // 新增/替换的字加粗+高亮提示"这地方调整了"；未改动部分正常显示。
  if (opts && Array.isArray(opts.rich) && opts.rich.length) {
    for (const seg of opts.rich) {
      if (seg.op === "del") continue; // 旧字不渲染，避免跟修复后文本混在一起
      const sp = document.createElement("span");
      sp.textContent = seg.value;
      if (seg.op === "ins") {
        sp.style.fontWeight = "700";
        sp.style.background = "color-mix(in srgb, #10b981 20%, transparent)";
        sp.style.color = "var(--text, #1a1a1a)";
        sp.style.borderRadius = "3px";
      }
      main.appendChild(sp);
    }
  } else {
    main.textContent = text;
  }
  main.style.cssText = "flex:1 1 auto;min-width:0;" + (isMulti ? "white-space:pre-wrap;word-break:break-word;" : "overflow:hidden;text-overflow:ellipsis;") + "color:var(--text,#1a1a1a);";
  const tail = document.createElement("span");
  tail.textContent = opts && opts.tail ? opts.tail : "";
  tail.style.cssText = "flex-shrink:0;font-size:11px;color:var(--text-dim,#9ca3af);align-self:center;";
  b.appendChild(tag); b.appendChild(main); b.appendChild(tail);
  let done = false;
  const go = () => { if (!done) { done = true; onClick && onClick(); } };
  // preventDefault + stopPropagation 双拦：不拦冒泡会触发宿主父级/下方元素的点击处理。
  // 另注意 pointerdown 里 go() 会同步重建建议条（按钮移出 DOM），浏览器随后合成的 click
  // 目标已脱离文档、可能穿透落到下方元素 —— touchend preventDefault（passive:false）掐断
  // 合成 click；touchstart 不拦，保留从按钮上滑动滚动手势。done 幂等保证动作只执行一次。
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  b.addEventListener("pointerdown", (e) => { swallow(e); go(); });
  b.addEventListener("touchend", swallow, { passive: false });
  b.addEventListener("click", (e) => { swallow(e); go(); });
  return b;
}

// 从 host 共享 feature store 同步 AC.feats（不请求网络；ctx 为 null 时保持默认全开/中档）
function syncAcFeatures() {
  const map = typeof AC.getFeatures === "function" ? AC.getFeatures() : {};
  const mc = parseInt(String(map["autocomplete.minChars"] ?? ""), 10);
  AC.feats = {
    autoComplete: map["autocomplete.enabled"] !== false,
    localOnly: map["autocomplete.localOnly"] === true,
    minChars: Number.isFinite(mc) && mc >= 0 ? mc : 3,
    suggest: map["suggest.enabled"] === true,
    // suggest ⚡ 一键执行（§3.4 默认关：显式开启才在命令候选旁加执行按钮）
    suggestRun: map["ai-input.suggestRun"] === true,
    ctx: map["autocomplete.ctx.large"] === true ? "large" : map["autocomplete.ctx.small"] === true ? "small" : "medium",
    // 顶级总闸：语音输入法（🎤 贴在输入框上的按钮）——**默认关**（未完全测好，显式开启才挂按钮）
    voiceEnabled: map["voice.enabled"] === true,
    // 语音与高速输入优化（修复 + 感知条）——**默认关**（误判偶尔打扰正常打字，extman 显式开启才生效）
    voiceFix: map["voice.fix"] === true,
    voiceIndicator: map["voice.indicator"] === true,
    asrStreaming: map["asr.streaming"] !== false,
    asrModelStream: String(map["asr.model.stream"] || "") || "iic/SenseVoiceSmall",
    asrVad: map["asr.vad"] !== false,
    asrSplit: map["asr.split"] !== false,
    asrPass2: map["asr.pass2"] !== false,
  };
  return AC.feats;
}

// 最小字符数加权长度：CJK/全角字符算 1.5、其他算 1 —— 阈值 3 时英文 3 字符 / 中文 2 字触发
const CJK_WEIGHT_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3040-\u30FF\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/u;
function acEffLen(v) {
  let n = 0;
  for (const ch of v.trim()) n += CJK_WEIGHT_RE.test(ch) ? 1.5 : 1;
  return n;
}
// feature 变更后强制执行最小字符数：当前输入低于新阈值 → 立即清灰字 + 取消在途请求
function acEnforceMinChars() {
  const v = acCurrentText();
  if (v && acEffLen(v) < AC.feats.minChars) { acClearTimer(); acAbort(); acClearGhost(); }
}

async function acFeatures(force) { return AC.feats; }

function acActiveTa() {
  try {
    const refTa = AC.extra && AC.extra.textareaRef && AC.extra.textareaRef.current;
    if (refTa && refTa.tagName === "TEXTAREA") return refTa;
  } catch (e) {}
  try {
    const t = document.querySelector("textarea[data-chat-input]");
    if (t) return t;
  } catch (e) {}
  return null;
}
function acCurrentText() {
  if (AC.pendingValue !== null) return AC.pendingValue;
  const ta = acActiveTa();
  return ta ? ta.value : "";
}
/** 候选/灰字 UI 的锚点快照：这类 UI 都是 fixed 视口坐标锚定 textarea；
 *  灰字还随 caret 走，所以 textarea 自身滚动（内部 scrollTop）也算锚点变动。 */
function taAnchor(ta) {
  const r = ta.getBoundingClientRect();
  return { ta, left: r.left, top: r.top, scrollTop: ta.scrollTop };
}
/** 滚动是否真动了锚点输入框：聊天区流式滚动不改 textarea 的屏幕位置——
 *  候选词/灰字不该被这种滚动误杀（否则 AI 一有新输出就清一次，正在浏览的候选
 *  直接消失）。锚点缺失/真移动（软键盘弹起/布局变化/输入框内部滚动）才返回 true。 */
export function anchorMoved(anchor: { ta: HTMLTextAreaElement; left: number; top: number; scrollTop: number } | null): boolean {
  if (!anchor || !anchor.ta || !anchor.ta.isConnected) return true;
  const r = anchor.ta.getBoundingClientRect();
  return Math.abs(anchor.left - r.left) > 1 || Math.abs(anchor.top - r.top) > 1
    || anchor.scrollTop !== anchor.ta.scrollTop;
}
function acClearGhost() {
  AC.ghost = null;
  AC.anchor = null;
  AC.lastKey = null;
  if (AC.overlay) AC.overlay.style.display = "none";
  barClear("ai"); // 只清 AC 续写/本地补全候选（保留收藏/语音候选）
  barClear("local");
  barClear("history");
}
function acClearTimer() { if (AC.timer) { clearTimeout(AC.timer); AC.timer = null; } }
function acAbort() {
  if (AC.aborter) { AC.aborter.abort(); AC.aborter = null; }
  // 开页方案 §6：L0 在途请求一并取消（原来它只挂在 acLocalComplete 局部变量上，
  // acAbort() 只能取消 L1——每次击键的 L0 都在服务端跑完：同步审计写 + 整会话读）。
  if (AC.localAborter) { AC.localAborter.abort(); AC.localAborter = null; }
}
function acResetPending() {
  AC.pendingValue = null;
  requestAnimationFrame(() => { AC.pendingValue = null; });
}

// 输入变化 → 清旧灰字 + 取消在途 + 重新防抖调度
// 两层触发：L0 本地层 250ms 即触发（零模型秒出，打字停顿即出灰字，不等 AI）；
// L0 未命中才在完整 debounce（700ms）时发 L1 AI 请求。
function acReschedule() {
  acClearTimer();
  acAbort();
  acClearGhost();
  AC.stamp = performance.now();
  AC.timer = setTimeout(acTriggerLocal, AC_DEBOUNCE_L0);
}

// L0 本地层触发：豁免 IME 冷却（本地零模型，组合结束即可出灰字）；弹窗打开时让位（acShowGhost 内统一判定，rAF 晚到也拦住）
async function acTriggerLocal() {
  const ta = acActiveTa();
  if (!ta || ta !== document.activeElement) return;
  const v = acCurrentText();
  if (!v || !v.trim()) return;
  if (acEffLen(v) < AC.feats.minChars) return; // 最小字符数（CJK 1.5 加权）：太短不出灰字、不发请求（0=不限制）
  if (ta.selectionEnd !== v.length) return;             // 有选区
  if (AC.composing) return;                             // 拼音组合中不打扰（组合结束即放行，无 1500ms 冷却）
  if (AC.extra && AC.extra.isStreaming) return;         // agent 回复中不打扰
  if (AC.extra && AC.extra.menuOpen) return;            // slash/@/历史 picker 打开不打扰
  if (AC.lastKey === v && AC.ghost) return;             // 同输入已有灰字
  if (voiceItemsActive()) return;                       // 语音修复建议显示时 AC 让位（互斥）
  const feats = AC.feats;
  if (!feats.autoComplete) return;                      // extman 总开关关闭
  AC.lastKey = v;
  // L0 本地层（收藏/历史，零模型秒出）：命中即灰字 + ↦来源 角标，不再请求 AI
  const local = await acLocalComplete(v);
  if (local && local.text) {
    requestAnimationFrame(() => acShowGhost(local.text, "local", local.source, local.name));
    return;
  }
  if (feats.localOnly) return;                          // 仅本地：L0 未命中就不出灰字（0 出网，不发模型请求）
  // L0 未中 → L1 AI：等足完整 debounce（保证打字节奏不被提前打断）
  const remain = AC.stamp + AC_DEBOUNCE - performance.now();
  if (remain > 30) { acClearTimer(); AC.timer = setTimeout(acTriggerAI, remain); return; }
  acTriggerAI();
}

// L1 AI 层触发：慢（0.4–2s），保持 IME 冷却 + 弹窗让位
async function acTriggerAI() {
  const ta = acActiveTa();
  if (!ta || ta !== document.activeElement) return;
  const v = acCurrentText();
  if (!v || !v.trim()) return;
  if (acEffLen(v) < AC.feats.minChars) return; // 最小字符数（CJK 1.5 加权）：太短不打扰模型（0=不限制）
  if (ta.selectionEnd !== v.length) return;             // 有选区
  if (performance.now() - AC.lastCompEnd < AC_IME_COOLDOWN) return; // IME 冷却
  if (AC.extra && AC.extra.isStreaming) return;         // agent 回复中不打扰
  if (AC.extra && AC.extra.menuOpen) return;            // slash/@/历史 picker 打开不打扰
  if (AC.lastKey === v && AC.ghost) return;             // 同输入已有灰字
  if (sugActive || voiceItemsActive()) return;             // 收藏联想/语音修复显示时 L1 AI 让位（互斥）
  const feats = AC.feats;
  if (!feats.autoComplete) return;                      // extman 总开关关闭
  AC.lastKey = v;
  acAbort();
  const ab = new AbortController();
  AC.aborter = ab;
  const body = { input: v, ctx: feats.ctx, cwd: AC.extra && AC.extra.cwd, model: curModel(), sessionId: AC.extra && AC.extra.sessionId };
  fetch(AC.apiUrl("/api/extensions/aiti-ai-input/complete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ab.signal,
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("http" + r.status))))
    .then((d) => {
      if (ab.signal.aborted) return;
      const ta2 = acActiveTa();
      if (!ta2 || ta2 !== document.activeElement) return;
      if (acCurrentText() !== v) return;                // 输入已变，丢弃
      if (AC.lastKey === v && d && typeof d.text === "string" && d.text.trim()) {
        requestAnimationFrame(() => acShowGhost(d.text, "ai"));
      }
    })
    .catch(() => {});
}

// ---------- 请求级缓存 + 在途合流（开页方案 §6 后续） ----------
// L0 本地补全（30s / 50 条）与 suggest（10s / 30 条）同 key 结果复用 + in-flight 共享：
// 删字重打、停顿后重触发不再重复打服务端（服务端每请求都有审计写 + contextHistory 整会话读）。
// 只覆盖只读幂等查询；TTL 内同 key 命中零网络，同 key 在途共享同一次往返（LRU 淘汰最老）。
const REQ_CACHE_TTL = { l0: 30000, sug: 10000 };
const REQ_CACHE_MAX = { l0: 50, sug: 30 };
const reqCache = { l0: new Map(), sug: new Map(), inflight: new Map() };
function reqCacheGet(kind, key) {
  const store = reqCache[kind];
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > REQ_CACHE_TTL[kind]) { store.delete(key); return null; }
  store.delete(key); store.set(key, hit); // LRU touch
  return hit.d;
}
function reqCachePut(kind, key, d) {
  const store = reqCache[kind];
  store.set(key, { at: Date.now(), d });
  while (store.size > REQ_CACHE_MAX[kind]) store.delete(store.keys().next().value);
}

// L0 本地补全请求（mode=local，服务端零模型：收藏/历史前缀匹配）——本地秒回，命中灰字直出
async function acLocalComplete(v) {
  const key = ((AC.extra && AC.extra.cwd) || "") + "\n" + v;
  let d = reqCacheGet("l0", key);
  if (!d) {
    const inflightKey = "l0\n" + key;
    const infl = reqCache.inflight.get(inflightKey);
    // 在途合流：同 key 共享同一次网络往返（不重复 abort/重发）
    d = infl ? await infl : await acLocalFetch(v, inflightKey, key);
  }
  // 请求期间输入已变/失焦/光标移动 → 丢弃（保证灰字永远对应当前输入）
  const ta = acActiveTa();
  if (!ta || ta !== document.activeElement) return null;
  if (acCurrentText() !== v) return null;
  return d;
}

// L0 真网络请求（无上下文判定——丢弃判定统一在 acLocalComplete 出口做，缓存/合流路径共用）
async function acLocalFetch(v, inflightKey, cacheKey) {
  let ctrl = null;
  let timer = null;
  const p = (async () => {
    try {
      ctrl = new AbortController();
      acAbort(); // 开页方案 §6：在途 L0/L1 一并取消（旧实现 L0 只挂局部变量，每次击键都跑完）
      AC.localAborter = ctrl;
      timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 2500);
      const r = await fetch(AC.apiUrl("/api/extensions/aiti-ai-input/complete"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "local", input: v, cwd: AC.extra && AC.extra.cwd }),
        signal: ctrl.signal,
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.ok === true ? d : null;
    } catch (e) { return null; }
    finally {
      if (timer) clearTimeout(timer);
      if (AC.localAborter === ctrl) AC.localAborter = null;
    }
  })();
  reqCache.inflight.set(inflightKey, p);
  try {
    const d = await p;
    if (d) reqCachePut("l0", cacheKey, d);
    return d;
  } finally { reqCache.inflight.delete(inflightKey); }
}

// 灰字渲染：镜像测量光标像素坐标 → fixed overlay + 灰字 span（L0 本地命中附 ↦来源 角标）
function acShowGhost(text, source, lsource, lname) {
  const ta = acActiveTa();
  if (!ta || ta !== document.activeElement) return;
  // 收藏联想/语音修复显示时灰字一律让位（互斥）——L0 本地灰字也不例外：
  // 弹窗(下拉/建议条)与灰字并存会 Tab 归属不明（双提示都吃 Tab→冲突），弹窗优先
  if (sugActive || voiceItemsActive()) return;
  // 小屏：文档流建议条（多候选词云端），不覆盖 fixed overlay 定位
  if (isCoarse && ACbar) {
    const t = source === "local" ? (lsource === "history" ? "history" : "local") : "ai";
    barSet(t, [{ type: t, short: "", full: text, item: { lsource, lname } }]);
    AC.ghost = { text, source };
    AC.anchor = taAnchor(ta);
    if (ACbar) ACbar.style.display = "flex";
    return;
  }
  const pos = acCaretOffset(ta);
  if (!pos) return;
  let ov = AC.overlay;
  if (!ov) {
    ov = document.createElement("div");
    ov.setAttribute("data-complete-ghost", "1");
    ov.setAttribute("aria-hidden", "true");
    ov.style.cssText = "position:fixed;pointer-events:none;z-index:2147483000;display:flex;align-items:flex-start;";
    document.body.appendChild(ov);
    AC.overlay = ov;
  }
  const css = getComputedStyle(ta);
  ov.style.top = pos.y + "px";
  ov.style.left = pos.x + "px";
  ov.style.display = "flex";
  ov.style.font = css.font;
  ov.style.fontFamily = css.fontFamily;
  ov.style.fontSize = css.fontSize;
  ov.style.lineHeight = css.lineHeight;
  ov.style.letterSpacing = css.letterSpacing;
  ov.style.maxWidth = Math.max(80, ta.getBoundingClientRect().right - pos.x - 12) + "px";
  const span = document.createElement("span");
  span.style.cssText = "white-space:pre;overflow:hidden;text-overflow:ellipsis;opacity:.55;color:var(--text-dim, #9ca3af);pointer-events:none;";
  span.textContent = text;
  ov.innerHTML = "";
  ov.appendChild(span);
  // 本地来源角标（与灰字同 overlay、不落字）：↦收藏 / ↦历史（标识提示来源）
  if (source === "local") {
    const mk = document.createElement("span");
    mk.textContent = " ↦" + (lsource === "history" ? "历史" : "收藏");
    mk.style.cssText = "white-space:nowrap;font-size:10px;opacity:.8;color:var(--accent,#2563eb);pointer-events:none;align-self:flex-end;margin:0 0 2px 2px;";
    ov.appendChild(mk);
  }
  AC.ghost = { text, source };
  AC.anchor = taAnchor(ta);
}

function acCaretOffset(ta) {
  const css = getComputedStyle(ta);
  const rect = ta.getBoundingClientRect();
  let mirror = AC.mirror;
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    document.body.appendChild(mirror);
    AC.mirror = mirror;
  }
  mirror.style.cssText =
    "position:absolute;visibility:hidden;left:-100000px;top:0;pointer-events:none;" +
    "white-space:pre-wrap;word-break:break-word;box-sizing:" + css.boxSizing + ";" +
    "width:" + rect.width + "px;" +
    "font-family:" + css.fontFamily + ";font-size:" + css.fontSize + ";font-weight:" + css.fontWeight + ";" +
    "font-style:" + css.fontStyle + ";line-height:" + css.lineHeight + ";letter-spacing:" + css.letterSpacing + ";";
  for (const p of ["padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]) {
    mirror.style[p] = css[p];
  }
  const prefix = document.createElement("span");
  prefix.style.whiteSpace = "pre-wrap";
  prefix.style.wordBreak = "break-word";
  prefix.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement("span");
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  mirror.innerHTML = "";
  mirror.appendChild(prefix);
  mirror.appendChild(marker);
  const x = rect.left + marker.offsetLeft + marker.offsetWidth - ta.scrollLeft;
  const y = rect.top + marker.offsetTop - ta.scrollTop;
  return { x, y };
}

// 同步写 DOM 值（不派发 input，免 React onChange/值跟踪器回环）+ 同步 _valueTracker，
// 与宿主 pi-web ChatInput.writeTextareaValue 同款；DOM 值当帧生效，后续 setSelectionRange 才不会被钳到旧值长度。
function acWriteTaValueSync(ta, text) {
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (setter && setter.set) setter.set.call(ta, text);
    else ta.value = text;
  } catch (e) { ta.value = text; }
  try {
    const tracker = ta && (ta as any)._valueTracker;
    if (tracker && typeof tracker.setValue === "function") tracker.setValue(text);
  } catch (e) {}
  // 与宿主同口径广播程序化写值（DOM 已等于新值 → 宿主 [value] 同步 effect 会跳过覆写、
  // 也就不会再发这个事件；不补广播则占位符 chips 等订阅方不刷新）。
  try { window.dispatchEvent(new CustomEvent("pi-web:composer-value-written")); } catch (e) {}
}

export function acSetTaValue(ta, text) {  // 导出：ASR 语音上屏（entry l2Commit）复用——直写 ta.value 会同步 React tracker 吞 onChange，必须走这里
  // 优先 core 受控写入（ChatInput extra.setInputValue）；缺省回退原生 setter + input 事件
  if (AC.extra && typeof AC.extra.setInputValue === "function") {
    AC.pendingValue = text;
    acResetPending(); // rAF 后清（配合 setState 渲染完成）
    // 先同步落 DOM 再走受控 setState：setInputValue 的 React 提交是异步的，只排队 rAF 定位光标
    // 会抢在 commit 前跑 → setSelectionRange 被钳到旧值长度 → 光标停不到新文本后面
    //（与宿主 ChatInput.appendText 同坑）；DOM 已是新值时 React 提交跳过覆写，不打断我们设的光标。
    acWriteTaValueSync(ta, text);
    AC.extra.setInputValue(text);
    return;
  }
  try {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value");
    if (setter && setter.set) {
      setter.set.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      ta.value = text;
    }
  } catch (e) { ta.value = text; }
}

/** 光标落位：同步设一次（值已同步写入 DOM，位置有效）+ rAF 再兜一次（React 提交后按提交时的选区恢复）。 */
export function acPlaceCaret(ta, pos) {
  try { ta.setSelectionRange(pos, pos); } catch (e) {}
  requestAnimationFrame(() => { try { ta.setSelectionRange(pos, pos); } catch (e) {} });
}

/**
 * 在光标处插入文本（替换当前选区），插入后光标落到新文本末尾。
 * 未聚焦且没有可信光标位置（selectionStart 为 null）→ 退到文末追加（旧语义），避免把内容插到句首。
 */
export function acInsertAtCaret(ta, text) {
  const v = String(ta.value || "");
  const ins = String(text || "");
  const focused = ta === document.activeElement;
  let start = ta.selectionStart;
  let end = ta.selectionEnd;
  if (start == null || end == null || (!focused && start === 0 && end === 0 && v.length > 0)) {
    start = v.length; end = v.length;
  }
  if (end < start) { const t = start; start = end; end = t; }
  const next = v.slice(0, start) + ins + v.slice(end);
  acSetTaValue(ta, next);
  const caret = start + ins.length;
  acPlaceCaret(ta, caret);
  return caret;
}

function acAcceptGhost() {
  if (!AC.ghost) return;
  const ta = acActiveTa();
  if (!ta) return;
  const next = acCurrentText() + AC.ghost.text;
  const wasSrc = AC.ghost.source;
  acClearGhost(); // 立即清灰字 overlay + 候选（防接受后重影：旧灰字残留与新文字叠影）
  acClearTimer();
  if (isCoarse) acHideBar(); // 小屏：接受后清建议条（继续输入会再出新句）
  acSetTaValue(ta, next);
  if (ta === document.activeElement) acPlaceCaret(ta, next.length);
  // 逐句流：接受后自动续下一句（先 L0 本地，未中再 L1；stamp 重设保证 L1 仍等足 debounce）
  AC.stamp = performance.now();
  AC.timer = setTimeout(acTriggerLocal, AC_ACCEPT_REDELAY);
}

function acHandleKey(e) {
  // 收藏联想候选显示中：键盘全归 suggest 语义（Tab=接受候选/Enter=发送/↑↓=选择/Esc=关弹窗），AC 键盘静默。
  // 双 keydown 都在 document capture 阶段，stopPropagation 拦不住同节点后注册者——
  // 曾实测 Tab 同时接受 ghost+候选 → "深入审核完成度审核完成度"；状态互斥判定不依赖注册顺序
  if (sugActive) return;
  if (keyConsumedAt === e.timeStamp) return; // 已被另一个 handler（sugOnKey）消费
  const ta = acActiveTa();
  if (!AC.ghost || !ta || e.target !== ta) return;
  // slash/@/历史 picker 打开时键盘全归它们（含 Esc：关 picker 而非清灰字；Tab：选定文件而非接受灰字）
  // 必须在 Escape 之前判定——否则 stopPropagation 会吞掉 Esc，宿主 picker 收不到、关不掉
  if (AC.extra && AC.extra.menuOpen) return;
  if (e.key === "Escape") {
    // 灰字候选显示中：Esc 只清灰字，不落到宿主（pi-web：isStreaming 时 Esc=停止任务）
    keyConsumedAt = e.timeStamp;
    e.preventDefault();
    e.stopPropagation();
    acClearGhost();
    return;
  }
  if (e.key === "Tab") {
    keyConsumedAt = e.timeStamp;
    e.preventDefault();
    e.stopPropagation();
    acAcceptGhost();
    return;
  }
  if (e.key === "ArrowRight" && ta.selectionStart === ta.value.length) {
    keyConsumedAt = e.timeStamp;
    e.preventDefault();
    acAcceptGhost();
  }
}


// ---------- 导出（components.tsx / entry.tsx 装配用） ----------

/** 语音感知状态订阅（VoiceTagBar 用）：返回取消订阅函数。 */
export function subscribeVoice(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** 当前语音感知状态（订阅回调里读取最新值）。 */
export function isVoicePending(): boolean { return voicePending; }
/** 建议条容器绑定（AutocompleteHost 挂载/清理时调用；逻辑层经它填充候选）。 */
export function setAcBar(el: HTMLElement | null): void { ACbar = el; }

/** SUG 收藏联想子系统初始化：注入 apiUrl，装配点按分派，返回键盘/输入处理器。 */
export function initSuggest(apiUrl: (p: string) => string) {
  const SUG_DEBOUNCE = 350; // 开页方案 §6：150→350ms（与 L0 同思路，输入停顿才发建议请求）
  const SUG = {
    ta: null, items: [], idx: 0, q: "", anchorStart: 0, anchorCaret: 0,
    popup: null, moved: false, timer: null, aborter: null, apiUrl,
    anchor: null, // 候选显示时的输入框视口快照（scroll 时比对锚点是否真移动）
  };
  const sugActiveTa = () => {
    try {
      const t = document.querySelector("textarea[data-chat-input]");
      if (t && document.activeElement === t) return t;
    } catch (e) {}
    if (isChatInput(document.activeElement)) return document.activeElement;
    return null;
  };
  const sugWordAt = (value, caret) => {
    const head = value.slice(0, caret);
    const m = /([\u4e00-\u9fa5A-Za-z0-9_\-]{1,24})$/.exec(head);
    return m ? { word: m[1], start: caret - m[1].length } : null;
  };
  async function sugFetch(q) {
    // 开页方案 §6：同词 10s 内复用缓存 + 在途合流（删除重打同词不再打服务端）
    const cached = reqCacheGet("sug", q);
    if (cached) return cached;
    const inflightKey = "sug\n" + q;
    const infl = reqCache.inflight.get(inflightKey);
    if (infl) return infl;
    if (SUG.aborter) SUG.aborter.abort();
    const ctrl = new AbortController(); SUG.aborter = ctrl;
    const p = (async () => {
      try {
        // POST：q 走 body 不进 URL（GET ?q= 会把输入词明文落 nginx access_log）
        const r = await fetch(SUG.apiUrl("/api/extensions/aiti-ai-input/suggest"),
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, limit: 8 }),
            signal: ctrl.signal, cache: "no-store" });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    })();
    reqCache.inflight.set(inflightKey, p);
    try {
      const d = await p;
      if (d && d.ok) reqCachePut("sug", q, d);
      return d;
    } finally { reqCache.inflight.delete(inflightKey); }
  }
  // 当前锚定词（本次联想触发的词，sugApply 会替换它）——「业已完成输入」判定基准
  function sugAnchorWord() {
    const ta = SUG.ta;
    if (!ta) return "";
    if (SUG.anchorStart != null && SUG.anchorCaret != null) {
      return String(ta.value || "").slice(SUG.anchorStart, SUG.anchorCaret) || "";
    }
    return String(ta.value || "");
  }
  // 候选是否应显示：候选全文已出现在当前输入/当前词里（用户已完成该输入，再提示无意义）→ 不提示；
  // 已被 [名称] 占位符引用 → 不提示；大小屏共用同一判定（只显示方式不同，行为一致）。
  function sugCandShown(it, input, word) {
    const cand = it.kind === "cmd" ? (it.cmd || "") : (it.text || "");
    if (!cand && !it.name) return false;
    // 与整框输入一致=业已完成。注意只看「点选后会插入的内容」（全文，无全文则退到名称）：
    // 不能用 it.name === input 抑制——短名触发词（如收藏名叫 chd）恰恰要靠完整敲出名来联想出全文
    const insertable = cand || it.name || "";
    if (insertable && insertable === input) return false;
    if (input && input.includes("[" + it.name + "]")) return false;    // 已被占位符引用
    if (cand && word && word.includes(cand)) return false;             // 当前词已包含候选全文（业已完成）
    return true;
  }
  // 小屏：候选/空态渲染进文档流建议条（一次一条、与 AC 续写同款横条；无滚动条）
  function sugBuildBar() {
    SUG.popup = null;
    const input = SUG.ta ? SUG.ta.value : "";
    if (!SUG.items.length) {
      // 无命中：不显示「无收藏命中」空态胶囊（收藏未命中时就不占位，交给 AI 续写/语音）
      barClear("suggest");
      sugActive = false; // 无可见候选：放行 AC
      return;
    }
    const list = SUG.items.map((x) => {
      const t = x.kind === "cmd" ? (x.cmd || "") : (x.text || "");
      return { type: x.kind === "cmd" ? "cmd" : "prompt", short: x.name, full: t, item: x };
    });
    barSet("suggest", list);
    if (ACbar) ACbar.style.display = "flex";
  }
  // 候选点击：短内容直接填入；长内容 → 以 [名称] 占位符插入（发送时 preSend 展开真实内容，不灌输入框）
  function sugPick(it) {
    const prev = it.kind === "cmd" ? (it.cmd || it.name) : (it.text || it.name);
    if (prev.length > 60) { sugInsertMark(it); return; }
    sugApply(it);
  }
  // 注入统一候选抽象 {type,short,full} → 闭包内的 填入/占位 实现（供模块级 barPick 调用）
  pickPromptUser = (it) => {
    const obj = { kind: it.type, name: it.short, text: it.full, cmd: it.type === "cmd" ? it.full : "" };
    ((it.full || "").length > 60 ? sugInsertMark : sugApply)(obj);
  };
  runCmdUser = (it) => sugRunCmd(it);
  pickEmptyUser = () => sugAiFallback();
  function sugInsertMark(it) {
    const ta = SUG.ta || document.querySelector("textarea[data-chat-input]");
    if (!ta) return;
    const mark = "[" + (it.name || (it.kind === "cmd" ? "命令" : "收藏")) + "]";
    // 记录占位符 → 真实内容（发送展开）+ 元素数据（待选区 chips / 点开编辑）
    BARP.markMap[mark] = it.kind === "cmd" ? (it.cmd || "") : (it.text || "");
    const src = (SUG.items || []).find((s) => s.name === it.name);
    BARP.marks = BARP.marks.filter((m) => m.mark !== mark);
    BARP.marks.push({ mark, name: it.name, text: it.kind === "cmd" ? (it.cmd || "") : (it.text || ""), type: it.kind === "cmd" ? "cmd" : "prompt", id: (src && src.id) || null });
    acClearGhost(); // 插入占位符同理：旧灰字基于触发词已过期，防后续 →/Tab 接受过期续写拼错文本
    // 替换触发词（anchorStart..anchorCaret），而非在其后追加：点候选即替换用户刚打的触词
    const start = SUG.anchorStart ?? ta.selectionStart ?? 0;
    const end = SUG.anchorCaret ?? (ta.selectionStart ?? ta.value.length);
    const next = ta.value.slice(0, start) + mark + ta.value.slice(end);
    acSetTaValue(ta, next);
    acPlaceCaret(ta, start + mark.length); // 光标到新插入的占位符后面
    barClear("suggest");
    sugClose();
  }
  function sugBuildPopup() {
    const ta = SUG.ta; if (!ta) return;
    if (!SUG.items.length) {
      // 无可见候选（含刚接受完、输入已等于候选全文）→ 不弹框，放行 Enter/其它事件
      sugClose();
      return;
    }
    const rect = ta.getBoundingClientRect();
    const pop = document.createElement("div");
    pop.id = "aiti-suggest-popup";
    pop.style.cssText = [
      "position:fixed", "left:" + rect.left + "px", "top:-10000px", // 先离屏测量实际高度，下方空间不足再向上弹
      "width:" + Math.max(rect.width, 260) + "px", "maxHeight:240px", "overflow-y:auto",
      "z-index:2147483000", "background:var(--bg-panel, #f5f5f5)", "color:var(--text, #1a1a1a)",
      "border:1px solid var(--border, #e0e0e0)", "borderRadius:10px", "boxShadow:0 6px 24px rgba(0,0,0,.35)",
      "fontSize:13px", "lineHeight:1.4", "padding:4px", "boxSizing:border-box",
    ].join(";");
    document.body.appendChild(pop);
      SUG.items.forEach((it, i) => {
        // 候选已在上层（sugTrigger）过滤「业已完成输入」；此处直接渲染
        const input = SUG.ta ? SUG.ta.value : "";
        const row = document.createElement("div");
        row.style.cssText = "padding:7px 12px;borderRadius:8px;cursor:pointer;display:flex;gap:8px;align-items:baseline;min-width:0;font-size:13px;touch-action:manipulation;transition:background .12s";
        if (i === SUG.idx) {
          row.style.background = "color-mix(in srgb, var(--accent, #2563eb) 18%, transparent)";
          row.style.color = "var(--text, #1a1a1a)";
        } else {
          row.style.color = "inherit";
        }
        // 非高亮行 hover 轻量反馈（鼠标用户）
        row.addEventListener("mouseenter", () => {
          if (i !== SUG.idx) row.style.background = "color-mix(in srgb, var(--accent, #2563eb) 10%, transparent)";
        });
        row.addEventListener("mouseleave", () => {
          if (i !== SUG.idx) row.style.background = "";
        });
        // 名称优先完整显示（去掉图标、去掉 45% 截断）；预览才收缩省略
        const name = document.createElement("span");
        name.textContent = it.name;
        name.style.cssText = "font-weight:600;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        row.appendChild(name);
        // 预览文案与名称相同（收藏时常见：name=首行）→ 省略，避免小屏重复占两列；且与输入一致时已在上层过滤
        const prevText = it.kind === "cmd" ? (it.cmd || "") : (it.text || "");
        if (prevText && prevText !== it.name && prevText !== input) {
          const prev = document.createElement("span");
          prev.textContent = prevText;
          prev.style.cssText = "opacity:.65;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto";
          row.appendChild(prev);
        }
        // suggest ⚡ 一键执行（§3.4，feature ai-input.suggestRun 默认关）：命令文本已在联想结果
        // （前端持有）→ 直接前端 POST aiti-cmd /run，不绕本扩展服务端；用户显式点 ⚡ 才跑。
        if (it.kind === "cmd" && AC.feats.suggestRun) {
          const runBtn = document.createElement("button");
          runBtn.textContent = "⚡";
          runBtn.title = "执行此命令（危险命令会二次确认）";
          runBtn.style.cssText = "flex-shrink:0;border:1px solid var(--border,#e0e0e0);background:transparent;color:inherit;border-radius:6px;padding:1px 7px;cursor:pointer;font-size:12px;line-height:1.4";
          const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
          runBtn.addEventListener("pointerdown", (e) => { swallow(e); sugRunCmd(it); });
          runBtn.addEventListener("touchend", swallow, { passive: false });
          runBtn.addEventListener("click", swallow);
          row.appendChild(runBtn);
        }
        // touch/鼠标统一走 pointerdown（小屏点按即刻生效，无 300ms 延迟）
        // 同 acBarRow：stopPropagation 防冒泡触发宿主点击；touchend 掐断合成 click
        //（sugApply 同步移除 popup，合成 click 目标已脱离文档，防穿透到下方元素）
        row.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); sugApply(it); };
        row.addEventListener("touchend", (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
        pop.appendChild(row);
      });
    // 定位：下方空间不足则向上弹（输入框贴底时向下弹会被视口裁掉，候选看不全）
    const h = pop.scrollHeight;                    // 实际内容高度（含 maxHeight 截断）
    const below = rect.bottom + 4;
    pop.style.top = (window.innerHeight - below >= h) ? below + "px" : Math.max(8, rect.top - h - 4) + "px";
    SUG.popup = pop;
  }
  function sugRender() {
    if (SUG.popup) { SUG.popup.remove(); SUG.popup = null; }
    if (!SUG.ta) return;
    SUG.anchor = taAnchor(SUG.ta);
    if (isCoarse && ACbar) { sugBuildBar(); return; }
    sugBuildPopup();
    // 高亮跟随（重建后重设 idx 项背景——简化：重建即高亮 idx）
  }
  async function sugTrigger(q, ta, anchorStart, caret) {
    SUG.q = q; SUG.ta = ta; SUG.anchorStart = anchorStart; SUG.anchorCaret = caret;
    // idx=-1：不预选任何候选（选择权永远留给用户）——只有 ↑↓ 显式选择后才置 moved；
    // Enter 只认 moved，未选择时回车=正常发送消息（弹窗开着也发送，如单条候选场景不想补全）
    SUG.idx = -1; SUG.moved = false;
    const data = await sugFetch(q);
    if (!data || !data.ok || data.q !== SUG.q || SUG.ta !== ta) return;
    // 业已完成的输入不提示：候选全文已出现在当前词/整框输入里（如刚接受完、输入=候选全文）→
    // 过滤后再显示（大小屏同一判定；Enter 确认后不再弹同样提示，Enter 继续走发送/跟进）
    const input = ta.value || "";
    const word = sugAnchorWord();
    SUG.items = (data.results || [])
      .filter((r) => sugCandShown(r, input, word))
      .map((r) => ({ ...r, display: r.providerLabel || "" }));
    // 无可见候选：不弹空态（AI 兜底尚未接入——sugAiFallback 仅预留 hook，
    // 点了无实际功能，空态气泡只会误导；等 ai-helper invoke 接入后再恢复显示）
    if (!SUG.items.length) { sugClose(); return; }
    sugActive = true;   // 联想有结果显示：AC 让位互斥
    acClearGhost();     // 清 AC 旧灰字/建议，防双弹覆盖
    sugRender();
  }
  function sugClose() {
    sugActive = false;
    if (SUG.popup) { SUG.popup.remove(); SUG.popup = null; }
    if (SUG.aborter) SUG.aborter.abort();
    SUG.items = []; SUG.ta = null; SUG.q = ""; SUG.anchor = null;
    barClear("suggest"); // 只清收藏/命令候选项（保留 AI 续写 / 语音修复候选）
  }
  function sugSetTa(value, caret, ta) {
    const el = ta || sugActiveTa();
    if (!el) return;
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (setter && setter.set) { setter.set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }
      else el.value = value;
    } catch (e) { el.value = value; }
    requestAnimationFrame(() => { try { el.setSelectionRange(caret, caret); } catch (e) {} });
  }
  function sugApply(it) {
    const ta = SUG.ta; if (!ta) return;
    const insert = it.kind === "cmd" ? (it.cmd || it.name) : (it.text || it.name);
    const rest = ta.value.slice(SUG.anchorCaret);
    const next = ta.value.slice(0, SUG.anchorStart) + insert + rest;
    const caret = SUG.anchorStart + insert.length;
    const was = SUG.q;
    acClearGhost(); // 候选上屏：基于旧触发词的灰字续写已过期，清掉（后续 input 会自然重排新续写）
    sugClose();
    sugSetTa(next, caret, ta);
    // 命令命中：记录（后续可直接执行，不走 AI——本骨架先仅填入，/run 由 aiti-cmd 面板接管）
    try { console.log("[AI input] suggest 命中", was, "→", it.kind, it.name); } catch (e) {}
  }
  // suggest ⚡ 执行（§3.4）：命令文本已在联想结果里（前端持有）→ 直接前端 POST aiti-cmd /run
  // （source=suggest），不绕本扩展服务端；危险命令 403 needConfirm + 一次性 token 两段式照旧。
  // 成功后借 __aitiCmd.openSession 切到 ⚡命令 面板终端视图渲染 sid（扩展未加载时仅记控制台）。
  async function sugRunCmd(it) {
    const cmd = (it && it.cmd) || "";
    if (!cmd) return;
    const base = { command: cmd, name: it.name || undefined, source: "suggest", confirm: !!it.confirm, sandbox: "none" };
    const runUrl = typeof AC.apiUrl === "function" ? AC.apiUrl("/api/extensions/aiti-cmd/run") : "/api/extensions/aiti-cmd/run";
    const post = (payload) => fetch(runUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .then((x) => x.json().catch(() => ({ ok: false, error: "HTTP " + x.status })))
      .catch(() => ({ ok: false, error: "网络错误" }));
    let r = await post(base);
    if (r && r.needConfirm) {
      const danger = Array.isArray(r.danger) && r.danger.length ? r.danger.join(" / ") : "危险命令";
      if (!(await uiConfirm({ message: "执行危险命令？命中：" + danger, detail: cmd, danger: true }))) return;
      // 确认后重新走完整两段式：confirmToken 3s 用后即弃，而用户在确认弹窗停留期间
      // token 会过期（用户阅读危险命令常超 3s）——拿新鲜 token 立即回传，不做旧 token 重放。
      r = await post(base);
      if (r && r.needConfirm && r.confirmToken) r = await post({ ...base, confirmToken: r.confirmToken });
    }
    if (!r || !r.ok) {
      try { console.warn("[AI input] suggest ⚡ 执行失败：", (r && r.error) || "未知错误"); } catch (e) {}
      void uiAlert({ message: "命令执行失败：" + ((r && r.error) || "未知错误"), kind: "error" }).catch(() => {});
      return;
    }
    try { console.log("[AI input] suggest ⚡ 已执行 →", r.sessionId); } catch (e) {}
    sugClose();
    const openSession = (window as unknown as { __aitiCmd?: { openSession?: (sid: string, title?: string) => void } }).__aitiCmd?.openSession;
    if (typeof openSession === "function") openSession(r.sessionId, it.name || cmd);
  }
  function sugAiFallback() {
    const q = SUG.q;
    sugClose();
    // AI 动态建议（无静态命中）：弹窗 AI 按钮同源能力——先占位告知，ai-helper invoke 后续接入
    try { console.log("[AI input] suggest AI 兜底 q=", q); } catch (e) {}
    // DI 方案 P2：services 通道优先（aiti-helper.suggestFallback），旧全局兜底
    const fallback = (extSvc as (k: string) => ((q: string) => void) | undefined)("aiti-helper.suggestFallback") || window.__aitiSuggestAiFallback;
    fallback && fallback(q);
  }
  function sugOnKey(e) {
    if (keyConsumedAt === e.timeStamp) return; // 已被另一个 handler（acHandleKey）消费——防注册顺序变化导致 Tab 双落地
    // 候选显示中键盘全归 suggest 语义：大屏=popup；小屏=文档流建议条（SUG.popup 为 null，靠 sugActive 判定，
    // 否则小屏 Esc/Tab 全部漏到宿主——isStreaming 时 Esc 会被当成「停止任务」误停当前运行）
    if (!SUG.popup && !sugActive) return;
    // 锚定弹窗打开时的输入框（不依赖 activeElement：焦点在 iframe/其他元素时键盘仍作用于锚）
    const ta = SUG.ta;
    if (!ta || e.target !== ta) return;
    // slash/@/历史 picker 打开时键盘全归它们：不拦截 Tab/Enter/↑↓/Esc（否则 @文件 picker 的 Tab 选定/Enter 确认收不到）
    if (AC.extra && AC.extra.menuOpen) { sugClose(); return; }
    // Esc=只关候选不落到宿主：运行中任务不被误停（stopPropagation 后事件到不了 textarea 的 onKeyDown）
    if (e.key === "Escape") { keyConsumedAt = e.timeStamp; e.preventDefault(); e.stopPropagation(); sugClose(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      keyConsumedAt = e.timeStamp;
      e.preventDefault();
      const n = SUG.items.length || 1;
      // ↑↓=用户显式选择（只切高亮不上屏）：未选择时 ↓ 进入第一条、↑ 进入最后一条；已选择则循环步进
      SUG.moved = true;
      if (SUG.idx < 0) SUG.idx = e.key === "ArrowDown" ? 0 : n - 1;
      else SUG.idx = e.key === "ArrowDown" ? (SUG.idx + 1) % n : (SUG.idx - 1 + n) % n;
      sugRender(); return;
    }
    if (e.key === "Tab") { keyConsumedAt = e.timeStamp; e.preventDefault(); e.stopPropagation(); if (SUG.items.length) sugApply(SUG.items[SUG.idx < 0 ? 0 : SUG.idx]); else sugAiFallback(); return; }
    if (e.key === "Enter") {
      // Enter 默认=发送消息：仅当用户已用 ↑↓ 显式选择过某条（moved）才把选中候选上屏。
      // 系统绝不预选候选（idx=-1 无高亮）——单条候选也不高亮，此时按 ↑↓ 才选中它、再回车才上屏；
      // 用户没碰 ↑↓ 就回车 = 想发送：关弹窗、放行 Enter 正常发送。Tab（一键接受第一条/选中项）不受影响。
      if (SUG.moved && SUG.items.length) { keyConsumedAt = e.timeStamp; e.preventDefault(); e.stopPropagation(); sugApply(SUG.items[SUG.idx]); }
      else { sugClose(); }
      return;
    }
    if (e.key === " ") { if (SUG.moved && SUG.items.length) { keyConsumedAt = e.timeStamp; e.preventDefault(); sugApply(SUG.items[SUG.idx]); } else { sugClose(); } return; }
    if (e.key === "ArrowRight") { if (SUG.items.length && ta.selectionStart === ta.value.length) { keyConsumedAt = e.timeStamp; e.preventDefault(); sugApply(SUG.items[SUG.idx < 0 ? 0 : SUG.idx]); } return; }
  }
  // 输入捕捉 → 联想调度（input 事件在 AC 之前不冲突：suggest 弹窗开着时 AC 的灰字键由 sugOnKey 优先拦截）
  async function sugOnInput(e) {
    const ta = e.target;
    if (!isChatInput(ta)) return;
    if (AC.extra && AC.extra.menuOpen) { sugClose(); return; }  // slash/@/历史 picker 打开时不打扰（@文件输入不弹 SUG）
    await acFeatures(false); // 先确保 features 就绪（避免首次输入的竞态：suggest 开关未拉到就拦截）
    if (!AC.feats.suggest) { sugClose(); return; } // 收藏联想默认关闭（extman 开启才弹）
    // 拼音组合中的 input（isComposing=true）：不排程但清防抖；compositionend 补排程（真实输入法上屏后无 input:N）
    if (e.isComposing) { if (SUG.timer) clearTimeout(SUG.timer); return; }
    if (SUG.timer) clearTimeout(SUG.timer);
    SUG.timer = setTimeout(() => {
      const caret = ta.selectionStart ?? ta.value.length;
      const w = sugWordAt(ta.value, caret);
      if (!w || w.word.length < 1) { sugClose(); return; }
      // 客户端最小长度门（开页方案 §6，与服务端 SUGGEST_MIN_WEIGHT=3 同口径：CJK/全角 1.5 加权；
      // q 超宽松阈值 10 时服务端本就全放行，客户端同口径放行）——短词服务端必过滤为空，
      // 拦在客户端省一次往返；q.trim 后服务端还会做 per-候选覆盖度过滤，此处只挡「必空」的
      if (w.word.length <= 10) {
        const cjk = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3040-\u30FF\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/u;
        let weight = 0;
        for (const ch of w.word) weight += cjk.test(ch) ? 1.5 : 1;
        if (weight < 3) { sugClose(); return; }
      }
      sugTrigger(w.word, ta, w.start, caret);
    }, SUG_DEBOUNCE);
  }
  return { onInput: sugOnInput, onKeyDown: sugOnKey, sugClose, SUG };
}

export {
  AC,
  BARP,
  acFeatures,
  acReschedule,
  isChatInput,
  onBeforeInput,
  onCompositionStart,
  onCompositionEnd,
  acHandleKey,
  acClearGhost,
  acClearTimer,
  acAbort,
  acUpdateCoarse,
  barRemoveMark,
  setVoicePending,
  voiceFixReset,
  syncAcFeatures,
  acEnforceMinChars,
};
