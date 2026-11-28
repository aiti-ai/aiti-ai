/**
 * highlight —— 跟读高亮：正在读的句子在消息流中圈选 + 自动滚动（听书式）
 *
 * 算法：
 * 1. 前端基于 sourceId 把 DOM 拆成行，记录每行的 x/y/w/h
 * 2. 后端把 markdown 拆成短句
 * 3. 按顺序匹配，精确匹配用该行坐标；匹配不上按顺序插入
 * 4. 所有信息输出到 console.log
 */

let layer = null;
let activeRects = [];

/** 归一：去全部空白（朗读侧/DOM 侧统一口径，高亮比对不受空白差异影响） */
export function normKey(s) { return String(s || "").replace(/[\s]+/g, ""); }
/** 输入聚焦（composer/任一输入框）：跟随滚动暂停、高亮保持（不打断打字） */
function inputFocused() {
  try {
    const a = document.activeElement;
    if (!a) return false;
    const tag = String(a.tagName || "");
    return tag === "INPUT" || tag === "TEXTAREA" || a.isContentEditable === true;
  } catch { return false; }
}

export function splitSentencesWithOffset(text) {
  const out = [];
  let cur = "";
  let curStart = 0;
  let i = 0;
  const t = String(text || "");
  for (const ch of t) {
    cur += ch;
    if (/[。！？!?…；;]/.test(ch) || ch === "\n") {
      const s = cur.replace(/\n+/g, " ").trim();
      if (s) out.push({ s, start: curStart, end: i + 1 });
      cur = "";
      curStart = i + 1;
    }
    i++;
  }
  if (cur) { const s = cur.replace(/\n+/g, " ").trim(); if (s) out.push({ s, start: curStart, end: i }); }
  return out;
}

function leanText(text) {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, "…")
    .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])[ \t\u00a0\u3000]+/g, "$1")
    .replace(/[ \t\u00a0\u3000]+([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 公式口播化（与 toSpeechText.js 一致：朗读 seg 已 verbalize，DOM 侧也需同口径） */
function verbalize(text) {
  return String(text || "")
    .replace(/√/g, "根号").replace(/≥/g, "大于等于").replace(/≤/g, "小于等于")
    .replace(/≠/g, "不等于").replace(/≈/g, "约等于").replace(/×/g, "乘").replace(/÷/g, "除以");
}

/** 统一口径：leanText + verbalize（与朗读 seg 文本一致） */
function cleanMarkdown(text) {
  return verbalize(leanText(text));
}

/**
 * STEP 2: 基于 sourceId 从 DOM 获取行信息和坐标
 * 改为按 block 元素切分：每个 p/li/h1..h6/pre/tr/td 视为一行
 */
function extractDOMRows(sourceId) {
  const rows = [];
  const el = sourceId ? document.querySelector('[data-entry-id="' + sourceId + '"]') : null;
  if (!el) {
    return { status: 'no-element', rows: [] };
  }
  const body = el.querySelector('.markdown-body') || el;   // .markdown-body 是 data-entry-id 元素的后代，不是祖先
  // 取所有块级元素作为"行"
  const blocks = Array.from(body.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,tr,td'));
  if (!blocks.length) {
    // 如果没有子块，就把整个 body 当作一行
    blocks.push(body);
  }


  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const text = (block.textContent || '').trim();
    if (!text) continue; // 跳过空块
    const clean = leanText(text);
    let rect = null;
    try {
      const br = block.getBoundingClientRect();
      // 仅保留可见行（折叠收起/display:none 的块 rect=0 → 跳过）——
      // 否则折叠内行会以全 0 坐标命中行匹配（score=1）而画不出，折叠头兜底也永远不触发
      if (br.width > 0 && br.height > 0) {
        rect = { left: br.left, top: br.top, width: br.width, height: br.height };
      }
    } catch (e) {
      // ignore
    }
    if (!rect) continue; // 不可见行不参与行匹配

    const row = {
      lineIndex: bi,
      text,
      lean: clean,
      coordinates: rect,
      element: block   // 保留 DOM 元素引用，供每帧重读坐标
    };
    rows.push(row);
  }

  return { status: 'ok', rows, body, element: el };
}

/**
 * 行匹配打分（纯函数，供 locateInMessages 与单测）：输入任意文案（内部自动去空白）。
 *   1=精确；0.9=包含；否则最长公共子串比例；行首编号两侧同剥（markdown "2." vs 朗读「二，」）。
 *   阈值判定（≥0.6 才画）在调用方——宁缺毋滥，避免高亮错位。
 */
export function scoreRowMatch(curText, rowText) {
  const stripNum = (s) => s.replace(/^[0-9一二三四五六七八九十]+[、.．，,:：]?/, "");
  const rn = stripNum(normKey(rowText)), cn = stripNum(normKey(curText));
  if (!rn || !cn) return 0;
  if (rn === cn) return 1;
  if (rn.includes(cn) || cn.includes(rn)) return 0.9;
  // 最长公共子串比例（行内中间命中：朗读句是行的一个片段）
  const a = rn.length <= cn.length ? rn : cn, b = a === rn ? cn : rn;
  let bestL = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + bestL; j <= a.length; j++) {
      if (b.includes(a.slice(i, j))) bestL = Math.max(bestL, j - i); else break;
    }
  }
  return a.length ? bestL / a.length : 0;
}

function locateInMessages(text, sourceId, rawMarkdown) {
  if (sourceId && rawMarkdown) {
    const el = document.querySelector('[data-entry-id="' + sourceId + '"]');
    if (el) {
      const step2 = extractDOMRows(sourceId);
      if (step2.status === 'ok' && step2.rows.length) {
        // 逐句匹配：把当前朗读句与每个 DOM block 比较（统一 cleanMarkdown 口径）
        const curNorm = normKey(cleanMarkdown(text || ''));
        if (curNorm) {
          let best = null, bestScore = 0;
          for (const row of step2.rows) {
            const score = scoreRowMatch(curNorm, cleanMarkdown(row.text));
            if (score > bestScore) { bestScore = score; best = row; }
          }
          // 阈值：≥0.6 才算命中；否则不画（宁缺毋滥，避免高亮错位）
          if (best && bestScore >= 0.6) {
            return {
              rects: [{ ...best.coordinates }],
              rowElement: best.element || null,   // 匹配行的 DOM 元素（每帧重读坐标用）
              startNode: null,
              body: step2.body
            };
          } else {
          }
        }
      }
    }
    // 兜底：朗读目标在折叠块内（未展开、行不可见）→ 高亮消息内可见的折叠头
    // （如「处理详情 · 37 条消息 · 36 次工具调用」）——找不到折叠头才放弃
    const toggle = findVisibleCollapsedHeader(el);
    if (toggle) return toggle;
  }
  return null;
}

/** 全局最近可见折叠头（处理详情/工具/思考折叠按钮）——DOM 无目标 entry 时的兜底高亮 */
function findAnyVisibleToggle() {
  try {
    let best = null, bestDist = Infinity;
    const vh = window.innerHeight;
    for (const b of document.querySelectorAll("button, [role=button]")) {
      const t = (b.textContent || "").trim();
      if (!t || t.length < 4 || t.length > 80) continue;
      if (!/处理详情|工具调用|次工具调用|思考|bash|\bcmd\b|shell|\d+s$/.test(t)) continue;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const center = r.top + r.height / 2;
      const dist = Math.abs(center - vh / 2);
      if (dist < bestDist) { bestDist = dist; best = b; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return {
      rects: [{ left: r.left, top: r.top, width: r.width, height: r.height }],
      rowElement: best, startNode: null, body: best.closest("[data-entry-id]") || document.body,
      collapsedHeader: true,
    };
  } catch { return null; }
}

/** 消息内可见折叠头探测（处理详情/工具调用折叠器）；未展开内容时高亮它 */
function findVisibleCollapsedHeader(rootEl) {
  try {
    const roots = [rootEl, ...Array.from(rootEl.querySelectorAll("details, section, div, summary, button"))];
    let best = null;
    for (const el of roots) {
      const t = (el.textContent || "").trim();
      if (!t || t.length > 90) continue;
      // 折叠头特征：处理详情/工具调用聚合 与 单条工具/思考折叠（bash cd … 7s / 思考 3s / tool …）
      if (!/处理详情|工具调用|次工具调用|tool call|tool|工具结果|思考|bash|\bcmd\b|shell|\d+s$/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        // 取最浅层（面积最小/字符最短）的命中——优先标题行本身
        if (!best || t.length < best.t.length) { best = { el, t, r }; }
      }
    }
    if (!best) return null;
    const r = best.r;
    return {
      rects: [{ left: r.left, top: r.top, width: r.width, height: r.height }],
      rowElement: best.el,
      startNode: null,
      body: rootEl,
      collapsedHeader: true,
    };
  } catch { return null; }
}

/** 合并同一行（top/height 相近）的相邻 rect */
export function mergeRowRects(rects) {
  if (!rects.length) return [];
  const norm = rects
    .filter((r) => r && typeof r.left === "number" && typeof r.top === "number" && r.width > 0 && r.height > 0)
    .map((r) => ({ ...r, right: r.left + r.width }))
    .sort((a, b) => (a.top - b.top) || (a.left - b.left));
  if (!norm.length) return [];
  const merged = [];
  let row = { ...norm[0] };
  for (let i = 1; i < norm.length; i++) {
    const r = norm[i];
    const sameRow = Math.abs(r.top - row.top) < 4 && Math.abs(r.height - row.height) < 4;
    if (sameRow && r.left <= row.right + 4) {
      row.right = Math.max(row.right, r.right);
      row.width = row.right - row.left;
      row.height = Math.max(row.height, r.height);
    } else {
      merged.push(row);
      row = { ...r };
    }
  }
  merged.push(row);
  return merged.map(({ right, ...rest }) => rest);
}

function drawLayer(rects) {
  if (!layer) {
    layer = document.createElement("div");
    layer.setAttribute("data-aiti-speek-hl", "1");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147482000;";
    document.body.appendChild(layer);
  }
  layer.innerHTML = "";
  const merged = mergeRowRects(rects);
  for (const r of merged) {
    if (!r.width || !r.height) continue;
    const box = document.createElement("div");
    box.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
      "border-radius:3px;background:color-mix(in srgb,var(--accent,#3b82f6) 24%,transparent);" +
      "box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#3b82f6) 55%,transparent);";
    layer.appendChild(box);
  }
  activeRects = merged;
}

// ── 智能滚动跟随（可点击进度/设置三态：smart|always|off）──────────────────────
let lastUserScrollAt = 0;
let programmaticScrollFlag = false;
/** 漂移锁存：用户滚远（朗读行距视口 ≥1 屏）后持续「不自动拉回」，直到 a/b 跳回 / 读本页 / 行回到视口附近 */
let driftLatched = false;
/** 用户滚动上报（scroll 事件）：程序滚动后 150ms 内视为程序自身，不算用户操作 */
export function noteUserScroll() {
  if (programmaticScrollFlag) { programmaticScrollFlag = false; return; }
  lastUserScrollAt = Date.now();
}
export function scrollProgrammatic() {
  programmaticScrollFlag = true;
  setTimeout(() => { programmaticScrollFlag = false; }, 150);
}
/** 一屏距离判定：行完全离开视口，且距最近视口边 ≥ 1 屏高（轻微滚动不触发漂移） */
export function isFarFromViewport(rowEl) {
  if (!rowEl) return false;
  try {
    const r = rowEl.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    if (r.height > 0 && r.bottom > 0 && r.top < vh) return false; // 可见
    return r.top - vh > vh || r.bottom < -vh; // 距视口边 ≥ 1 屏
  } catch { return false; }
}
/** 智能滚动：smart=视口内不动/用户手动滚动过永不拉回（尊重用户，直到 a/b 跳回/读本页 resolveDrift 清零）/
 *  漂移锁存永不拉回；always=出视口即拉回（用户明确选了始终跟随）；off=不滚 */
export function smartScrollToRow(rowEl, mode) {
  if (!rowEl || mode === "off") return false;
  if (inputFocused()) return false; // 正在打字（composer/输入框聚焦）→ 不滚动跟随，不打断
  try {
    const vh = window.innerHeight;
    const r = rowEl.getBoundingClientRect();
    const inView = r.height > 0 && r.bottom > 0 && r.top < vh;
    if (mode === "smart") {
      if (inView) return false;                 // 可见：不动（不打扰阅读）
      if (lastUserScrollAt > 0) return false;   // 用户手动滚动过：永不自动拉回（尊重播放/阅读历史）
      if (driftLatched) return false;           // 漂移锁存：不自动拉回（等 a/b 跳回 / 读本页）
    }
    scrollProgrammatic();
    const container = findScrollableContainer(rowEl);
    if (container) {
      const cr = container.getBoundingClientRect();
      const rowCenterY = r.top + r.height / 2;
      container.scrollTo({ top: container.scrollTop + (rowCenterY - cr.top - cr.height / 2), behavior: "auto" });
    } else {
      window.scrollTo(0, window.scrollY + (r.top + r.height / 2 - window.innerHeight / 2));
    }
    return true;
  } catch { /* noop */ }
  return false;
}
/** 用户滚远判定（锁存）：进入 = 用户手动滚过 + 当前朗读行距视口 ≥1 屏；
 *  行不在 DOM（虚拟列表窗口外 = 不在视口）时：用户手动滚动过 → 视为滚远（显示跳回/读本页）
 *  锁存后持续为 true（smart 不再自动拉回）；解除 = 行回到视口附近（自动） / resolveDrift（a/b 跳回/读本页）
 *  手动导航期（上一条/下一条/进度跳转后 4s）→ 不视为漂移：目标行是用户要去的位置，自动跟随 */
export function isUserDrifted(currentRowEl) {
  const manualNavAt = (typeof window !== "undefined" && window.__speekManualNav) || 0;
  if (Date.now() - manualNavAt < 4000) { driftLatched = false; return false; }
  if (!currentRowEl) {
    // 行不在 DOM：虚拟窗口外=不在视口。用户手动滚动过 → 滚远（否则跟随窗口会自动滚过去，不打扰）
    return lastUserScrollAt > 0;
  }
  if (!isFarFromViewport(currentRowEl)) { driftLatched = false; return false; }
  if (lastUserScrollAt > 0) driftLatched = true; // 用户有手动滚动 → 锁存漂移
  return driftLatched;
}
/** 解除漂移锁（a/b 跳回 / 读本页 / 停止跟读时调用） */
export function resolveDrift() {
  driftLatched = false;
  lastUserScrollAt = 0;
}

/** 用户点击 a/b（漂移态）：滚回当前朗读行，恢复跟随；不影响朗读/高亮 */
export function jumpToPlayRow(rowEl, mode) {
  resolveDrift();
  scrollProgrammatic();
  if (!rowEl) return;
  try {
    const container = findScrollableContainer(rowEl);
    const rr = rowEl.getBoundingClientRect();
    if (container) {
      const cr = container.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + (rr.top + rr.height / 2 - cr.top - cr.height / 2), behavior: "smooth" });
    } else {
      window.scrollTo({ top: window.scrollY + (rr.top + rr.height / 2 - window.innerHeight / 2), behavior: "smooth" });
    }
  } catch { /* noop */ }
}

function findScrollableContainer(el) {
  let current = el.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

let hlCtx = null;
let hlBound = false;
const hlOnScroll = () => { if (!hlCtx) return; cancelAnimationFrame(hlRaf); hlRaf = requestAnimationFrame(() => { try { recomputeAndDraw(); } catch { /* noop */ } }); };
// capture 捕获内部滚动容器的 scroll（scroll 不冒泡，pi-web 消息列表在 overflow-y-auto 容器里滚）：
// 用户滚动 / 输入新内容导致页面滚动时，高亮框都要重新定位
function bindRedrawOnScroll() { if (!hlBound) { try { window.addEventListener("scroll", hlOnScroll, { capture: true, passive: true }); } catch { /* noop */ } hlBound = true; } }
function unbindRedrawOnScroll() { if (hlBound) { try { window.removeEventListener("scroll", hlOnScroll, { capture: true }); } catch { /* noop */ } hlBound = false; } }
let hlRaf = 0;
let hlTick = 0;
const HL_MAX_TICKS = 0; // 已弃用（scroll 驱动重绘，无固定 rAF 风暴）

function recomputeAndDraw() {
  if (!hlCtx) return;
  let drawRects = [];
  // 每帧重读匹配行的实时坐标（滚动是异步的，滚动前快照会漂移）
  if (hlCtx.rowElement) {
    try {
      const r = hlCtx.rowElement.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        drawRects = [{ left: r.left, top: r.top, width: r.width, height: r.height }];
      }
    } catch { /* noop */ }
  }
  if (!drawRects.length && hlCtx.coordinates) {
    drawRects = [hlCtx.coordinates];
  }
  if (!drawRects.length) {
    const br = hlCtx.body.getBoundingClientRect();
    if (br.width && br.height) drawRects = [{ left: br.left, top: br.top, width: br.width, height: br.height }];
  }
  if (!drawRects.length) return;
  drawLayer(drawRects);
}


/** 消息流滚动容器：任意已渲染消息向上找可滚动祖先；退化用主滚动 */
function findMessageContainer() {
  try {
    const any = document.querySelector('[data-entry-id] .markdown-body, [data-entry-id]');
    if (any) return findScrollableContainer(any) || findScrollableContainer(document.body);
  } catch { /* noop */ }
  return null;
}
/** 自动切滑动窗口：目标消息不在渲染窗口（虚拟列表）时，按 msgList 顺序迭代滚动直到其 DOM 出现。
 *  list = msgList（{id} 数组）；resolve({ el|null, moved }) */
export function ensureEntryVisible(sourceId, list) {
  return new Promise((resolve) => {
    if (!sourceId || !Array.isArray(list)) return resolve({ el: null, moved: false });
    let tries = 0;
    const step = () => {
      const el = document.querySelector('[data-entry-id="' + sourceId + '"]');
      if (el) return resolve({ el, moved: tries > 0 });
      // 尊重用户：滚动跟随 off / 用户手动滚动过（lastUserScrollAt>0）/ 已漂移锁存 → 绝不自动切窗口滚动
      // （否则高亮 miss 时每句都把手动滚动拽走——「谁在阻止我滚动」的根因）。
      // 手动导航期（上一条/下一条/进度跳转后 4s）除外：用户自己点了跳哪就滚到哪。
      const manualNavAt = (typeof window !== "undefined" && window.__speekManualNav) || 0;
      const mode = typeof window !== "undefined" ? (window.__speekScrollMode || "smart") : "smart";
      if (Date.now() - manualNavAt >= 4000 && (mode === "off" || lastUserScrollAt > 0 || driftLatched)) {
        return resolve({ el: null, moved: false });
      }
      const container = findMessageContainer();
      if (!container) { if (++tries < 12) { setTimeout(step, 250); return; } return resolve({ el: null, moved: false }); }
      // 探测窗口范围（渲染中的 entryId 索引）
      const idxs = [];
      try {
        for (const n of container.querySelectorAll('[data-entry-id]')) {
          const id = n.getAttribute('data-entry-id');
          const k = list.findIndex((m) => m.id === id);
          if (k >= 0) idxs.push(k);
        }
      } catch { /* noop */ }
      const curIdx = list.findIndex((m) => m.id === sourceId);
      const inWin = idxs.length && idxs[0] <= curIdx && curIdx <= idxs[idxs.length - 1];
      if (inWin) { if (++tries < 12) { setTimeout(step, 250); return; } return resolve({ el: null, moved: false }); }
      // 未在窗口 → 滚动：手动导航期首跳按索引比例大跳（一次基本到位，跳远不渐进耗时）；
      // 后续微调；普通跟随按方向滚一屏（近似）；再等重渲染
      const manualNavActive = Date.now() - manualNavAt < 4000;
      if (manualNavActive && tries === 0 && list.length > 1) {
        const ratio = Math.max(0, Math.min(1, curIdx / (list.length - 1)));
        container.scrollTop = Math.max(0, Math.round(ratio * (container.scrollHeight - container.clientHeight)));
      } else if (!idxs.length) { // 窗口探测不到 → 按页码估算方向：默认先向下跳一屏宽
        if (++tries > 30) return resolve({ el: null, moved: false });
        container.scrollTop += container.clientHeight * 0.9;
      } else {
        if (++tries > 30) return resolve({ el: null, moved: false });
        const dir = curIdx < idxs[0] ? -1 : 1;
        container.scrollTop += dir * container.clientHeight * 0.9;
      }
      setTimeout(step, 280);
    };
    step();
  });
}

function applyHit(hit, text, sourceId) {
  // 滚动目标 = 正在读的行元素（而非整条消息）：按智能策略滚动（smart/always/off，见导出函数）
  const rowEl = hit.rowElement || hit.body;
  if (rowEl) {
    try {
      // 手动导航（上一条/下一条/进度跳转，speaker 设 window.__speekManualNav）→ 4s 内强制 always
      // 跟随到目标位置：用户自己点了跳哪，我们就滚到哪（无视 smart/off/用户滚动保护）
      const manualNavAt = (typeof window !== "undefined" && window.__speekManualNav) || 0;
      const mode = (Date.now() - manualNavAt < 4000)
        ? "always"
        : (typeof window !== "undefined" ? (window.__speekScrollMode || "smart") : "smart");
      smartScrollToRow(rowEl, mode);
    } catch { /* noop */ }
  }
  hlCtx = { body: hit.body, text, sourceId, coordinates: hit.rects[0], rowElement: hit.rowElement || null };
  // 重绘改「scroll 驱动」：不再 180 帧 rAF 重绘风暴（曾占 CPU 影响打字）；滚动时才会节流重绘
  recomputeAndDraw();
  bindRedrawOnScroll();
}
export function highlightSegment(text, sourceId, rawMarkdown) {
  clearHighlight();
  if (!text) return false;
  let hit = locateInMessages(text, sourceId, rawMarkdown);
  if (hit) { applyHit(hit, text, sourceId); return true; }
  // 目标消息不在渲染窗口（虚拟列表）→ 自动切滑动窗口：渐进滚动直至其 DOM 出现，再重试定位绘制
  try {
    const list = (typeof window !== "undefined" && window.__speekListForHighlight) ? window.__speekListForHighlight : null;
    if (list && sourceId) {
      ensureEntryVisible(sourceId, list).then((res) => {
        let hit2 = locateInMessages(text, sourceId, rawMarkdown);
        if (hit2) { applyHit(hit2, text, sourceId); return; }
        // 行匹配仍 miss（note 概要段/折叠内/窗口不给力）→ 兜底 ① 消息内折叠头 ② 任意可见折叠头
        if (res.el) {
          const inMsg = findVisibleCollapsedHeader(res.el);
          if (inMsg) { applyHit(inMsg, text, sourceId); return; }
        }
        const anyToggle = findAnyVisibleToggle();
        if (anyToggle) applyHit(anyToggle, text, sourceId);
      }).catch(() => { /* noop */ });
      return true; // 已排入窗口切换，画面稍后跟上
    }
  } catch { /* noop */ }
  return false;
}

export function clearHighlight() {
  if (layer) { try { layer.remove(); } catch { /* noop */ } layer = null; }
  activeRects = [];
  hlCtx = null;
  hlTick = 0;
  if (hlRaf) { cancelAnimationFrame(hlRaf); hlRaf = 0; }
  unbindRedrawOnScroll();
}

export function highlightCount() { return activeRects.length; }
