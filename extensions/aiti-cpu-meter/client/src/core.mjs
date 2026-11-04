// aiti-cpu-meter core.mjs —— 共享核心：主线程流畅度检测器（无 ctx / 无 features 依赖）
//
// 单一实现，供两个壳复用（esbuild 打包内联）：
//   - 内部版壳  client/internal-client.mjs → dist/aiti-cpu-meter-client.mjs（pi-web 扩展 client）
//   - 外部版壳  client/standalone.mjs      → dist/aiti-cpu-meter.js（任意网站 <script> 注入）
//
// createMeter(opts) → { dispose, report }：
//   opts = { pos, score, snaps, minimize, actions?, container? }
//     pos      "left-bottom" | "left-top" | "right-bottom" | "right-top"
//     score    是否显示流畅度评分行（默认 true）
//     snaps    是否记卡顿快照（默认 true）
//     minimize 是否支持最小化（默认 true；false = 只有展开态 + ✕）
//     actions  面板标题栏扩展动作按钮 [{ id, icon?, label, title, onClick({ report }) }]（问 AI 等；可选）
//     cookie   report() 是否携带同站 cookie（默认 false；外部版「问 AI」开，便于 AI 排查登录态类问题）
//     locale   "zh" | "en"（缺省自动检测：pi-web 读 localStorage pi-locale，外部站读 navigator.language）
//
// report() → 现场诊断快照（问 AI / 调试会话数据源）：评分与会话统计 + gap/EWMA/阻塞/冻结 +
//   longtask 计数与时刻表（ltLog）+ LoAF 长帧脚本归因（invoker/sourceURL，Chrome 123+）+ 卡顿快照 +
//   sources（页面脚本源码路径全集 + 主要大块区域——参照 aiti-devtools 诊断思路）+ doc 元信息。
//
// 能力：读秒（rAF 驱动，主线程卡死即冻结）+ gap/maxGap/longtask 统计 + 流畅度评分（Apdex 锚定
//   EWMA 平滑）+ 4 档颜色 + 双态 UI（展开面板 ⇄ 最小化 FAB）+ 自带拖动/位置持久化（不依赖
//   aiti-float）+ 会话统计（运行时长 / 最低·最高·平均 / 总·1分·5分·10分 窗口平均）+ 多语（zh/en）
//   + 后台标签页防误报 + 幂等 + dispose。
//
// 约定：挂载时写 window.__aitiCpuMeter = { dispose, report, opts }（幂等：已有先 dispose 旧的，防
//   service-tunnels / bookmarklet / client 多通道叠加）；dispose 后若句柄是自己则清空该全局。
//
// 图标：ICON_AI 统一 AI 图标（lucide sparkles，源 _shared/icons/sparkles.svg——与 aiti-helper
//   工具条/帮助点同一图形；stroke=currentColor 随按钮色）。
// float 模式（cfg.float，内部版）：面板标 data-ext-float="1" 交给 aiti-float 接管拖动/位置持久化
//   （统一契约；aiti-float 未装时静态停角位、无拖动），FAB 仍走自带拖动。

// lucide sparkles（单源 _shared/icons/sparkles.svg；stroke=currentColor 继承按钮颜色）
export const ICON_AI = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>';
//
// 说明：样式自持（自建 style 元素，aiti-cpu-meter 前缀，不污染宿主）；localStorage 键均带
//   aiti-cpu-meter 前缀（第三方网站各站域名隔离，无冲突）。

export function createMeter(opts) {
  if (typeof document === "undefined") return { dispose() {} };
  const root = (opts && opts.container) || document;

  // ── 幂等：已有实例先 dispose（防多通道重复注入叠加）──────────────────
  if (typeof window !== "undefined" && window.__aitiCpuMeter && typeof window.__aitiCpuMeter.dispose === "function") {
    try { window.__aitiCpuMeter.dispose(); } catch (e) {}
  }

  const cfg = {
    pos: opts && opts.pos ? opts.pos : "left-bottom",
    score: !opts || opts.score !== false,
    snaps: !opts || opts.snaps !== false,
    minimize: !opts || opts.minimize !== false,
    actions: Array.isArray(opts && opts.actions) ? opts.actions.filter(Boolean) : [],
    float: !!(opts && opts.float), // 内部版 true：面板接 aiti-float 契约（拖动/位置归它管）
    cookie: !!(opts && opts.cookie), // report() 携带同站 cookie（外部版问 AI 开）
    locale: opts && typeof opts.locale === "string" ? opts.locale : "",
  };

  // ── 多语（zh / en；内部版跟 pi-web 的 pi-locale + locale-changed 事件，外部站读 navigator.language）──
  const I18N = {
    zh: {
      title: "渲染流畅度",
      min: "最小化", close: "关闭（仅隐藏当前页）",
      fabTip: "渲染流畅度 · 点击展开",
      score: "流畅", unit: "分",
      avg: "平均", max: "最高", low: "最低", run: "运行",
      w1: "1分钟", w5: "5分钟", w10: "10分钟",
    },
    en: {
      title: "Render Fluency",
      min: "Minimize", close: "Close (this page only)",
      fabTip: "Render fluency · click to expand",
      score: "Fluency", unit: "",
      avg: "Avg", max: "Max", low: "Min", run: "Run",
      w1: "1min", w5: "5min", w10: "10min",
    },
  };
  let lang = cfg.locale;
  if (lang !== "zh" && lang !== "en") {
    // 自动检测：优先 pi-web（localStorage pi-locale + locale-changed 事件），回退 navigator.language
    try {
      const v = localStorage.getItem("pi-locale");
      if (v === "zh-CN" || v === "zh" || v === "zh-TW") lang = "zh";
      else if (v === "en") lang = "en";
    } catch (e) {}
    if (lang !== "zh" && lang !== "en") {
      try {
        const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "";
        lang = /^zh/i.test(nav) ? "zh" : "en";
      } catch (e) { lang = "zh"; }
    }
  }
  const t = function (k) { return (I18N[lang] || I18N.zh)[k]; };
  const ID = "aiti-cpu-meter";
  const STYLE_ID = "aiti-cpu-meter-style";
  const SCORE_ID = "aiti-cpu-meter-score";
  const WIN_ID = "aiti-cpu-meter-win";
  const BODY_ID = "aiti-cpu-meter-body";
  const FAB_ID = "aiti-cpu-meter-fab";

  let disposed = false;
  let raf = 0;
  let timer = 0;
  let lo = null; // longtask observer
  let el = null; // 展开面板
  let fab = null; // 最小化 FAB
  let fabDot = null, fabNum = null;
  let minBtn = null, closeBtn = null;

  // ── localStorage 键 ──
  const K_POS = "aiti-cpu-meter:pos";       // 面板位置
  const K_FAB = "aiti-cpu-meter:fab-pos";   // FAB 位置
  const K_UI = "aiti-cpu-meter:ui";         // "expanded" | "minimized"（FAB 状态记录，延迟写）
  const K_SNAP = "aiti-cpu-meter:snaps";
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  // 延迟写：UI 操作路径零同步 IO（localStorage 同步写 + 全局 storage 事件可能触发别的拓展/脚本重活——
  // 用户环境实测操作瞬间 6154ms longtask）。同 key 只保留最后一次待写；dispose 时立即冲刷。
  const _lsPending = new Map();
  function lsSet(k, v) { _lsPending.set(k, String(v)); if (lsTimer === 0) lsTimer = setTimeout(lsFlush, 250); }
  let lsTimer = 0;
  function lsFlush() { lsTimer = 0; for (const [k, v] of _lsPending) { try { localStorage.setItem(k, v); } catch (e) {} } _lsPending.clear(); }

  function loadPos(key) { try { const p = JSON.parse(lsGet(key) || "null"); if (p && typeof p.x === "number" && typeof p.y === "number") return p; } catch (e) {} return null; }
  function savePos(key, x, y) { lsSet(key, JSON.stringify({ x: x, y: y })); }

  // ── 采样状态 ──
  const t0 = performance.now();
  let lastRaf = t0;
  let maxGap = 0, gapCount = 0;
  let longTaskCount = 0, longTaskMax = 0;
  let blockMsAcc = 0;       // 本 tick 内 longtask 阻塞量累计（TBT 定义）
  let hidden = document.hidden || false;
  let started = false;      // 首载 2s 门控：只采集不评分
  let uiState = "expanded"; // "expanded" | "minimized"
  let closed = false;        // ✕ 关闭后停渲染（页面忙时不给主线程加负担，缩短其他交互排队）
  let opAt = 0;              // 上次 UI 操作时刻（minimize/expand/close；操作后 500ms 豁免评分采样）

  // 评分状态
  let sat = 0, tol = 0, fru = 0;   // 已不再用三分桶（改为 gap 幅值曲线）；保留声明以防误读
  let blockFrac = 0;               // 阻塞占比 EWMA
  let recentMax = 0;               // 最近最大帧间隔（衰减）
  let ewmaGap = 16.7;              // 帧间隔 EWMA（持续饱和信号；初始=理想一帧）
  let freezeCnt = 0;               // 近期冻结次数（衰减计数：>600ms 帧）
  let lastScoreAt = t0;            // 会话统计时间累计
  let scoreTotal = 0, scoreWeight = 0, runMs = 0, minScore = null, maxScore = null;
  const hist = [];              // 分数历史采样（1s 一条，窗口平均用；~660 条封顶）
  let histLast = 0;             // 距上次采样的累计 ms
  let curScore = null;             // 当前分（started 前为 null）
  // 渲染缓存（内容不变不写 DOM：忙碌大页面避免无谓 innerHTML 重写/样式计算）
  let lastHeadRun = "", lastScoreHtml = "", lastWinText = "", lastRawText = "";
  let fabColor = "", fabText = "";      // FAB 渲染缓存（同值不写样式/文本）
  const ltLog = [];                    // 长任务自捕获：{ at, dur }（诊断：操作是否由我们引起）

  // ── 样式（自持，不污染宿主）──────────────────────────────────────────
  function styleText() {
    const c = { dot: "#7CFF7C", dim: "rgba(255,255,255,.5)", warn: "#FFD24D", err: "#FF4D4D", bd: "#1a3" };
    return (
      "#" + ID + "{position:fixed;z-index:2147483646;background:rgba(10,10,10,.88);color:#7CFF7C;" +
        "font:12px/1.55 Menlo,Consolas,monospace;border:1px solid " + c.bd + ";border-radius:8px;" +
        "user-select:none;text-shadow:0 0 4px #7CFF7C;box-shadow:0 2px 10px rgba(0,0,0,.45);" +
        "min-width:230px;max-width:360px}" +
      "#" + ID + " .meter-head{display:flex;align-items:center;gap:6px;padding:3px 6px;cursor:move;" +
        "background:rgba(20,120,40,.25);border-radius:8px 8px 0 0;font-weight:bold;font-size:11px;" +
        "letter-spacing:.5px;pointer-events:auto;touch-action:none}" +
      "#" + ID + " .meter-head .dot{color:" + c.dot + "}" +
      "#" + ID + " .meter-head .head-run{color:" + c.dim + ";font-size:10px;font-weight:normal;margin-left:4px}" +
      "#" + ID + " .meter-head .sp{flex:1}" +
      "#" + ID + " .meter-btn{margin-left:auto;cursor:pointer;border:0;background:transparent;color:" + c.dot + ";" +
        "font-size:14px;line-height:1;padding:0 4px;border-radius:4px;pointer-events:auto}" +
      "#" + ID + " .meter-btn.min{margin-left:0}" +
      "#" + ID + " .meter-btn.act{margin-left:0;font-size:12px;display:flex;align-items:center}" +
      "#" + ID + " .meter-btn.act svg{width:13px;height:13px;display:block}" +
      "#" + ID + " .meter-btn:hover{background:rgba(255,60,60,.35);color:#fff}" +
      "#" + ID + " .meter-btn.act:hover{background:rgba(124,255,124,.2);color:#fff}" +
      "#" + ID + " .score-line{display:flex;align-items:center;gap:6px;font-weight:bold;font-size:13px;padding:3px 4px 0}" +
      "#" + ID + " .score-line .score-num{min-width:36px}" +
      "#" + ID + " .score-line .score-bar{letter-spacing:0}" +
      "#" + ID + " .score-line .meta{margin-left:auto;color:" + c.dim + ";font-size:11px;font-weight:normal;white-space:nowrap}" +
      "#" + ID + " .win-line{display:flex;align-items:center;gap:6px;color:" + c.dim + ";font-size:11px;padding:1px 4px 3px;border-bottom:1px solid rgba(124,255,124,.14)}" +
      "#" + ID + " .raw{white-space:pre;padding:4px 10px 8px}" +
      "#" + FAB_ID + "{position:fixed;z-index:2147483646;width:40px;height:40px;border-radius:50%;" +
        "background:rgba(10,10,10,.92);border:2px solid " + c.dot + ";display:flex;align-items:center;" +
        "justify-content:center;gap:1px;cursor:pointer;user-select:none;box-shadow:0 2px 10px rgba(0,0,0,.45);" +
        "font:bold 13px/1 Menlo,Consolas,monospace;color:#fff;pointer-events:auto;touch-action:none}" +
      "#" + FAB_ID + " .fab-dot{width:6px;height:6px;border-radius:50%;background:" + c.dot + "}" +
      "#" + FAB_ID + " .fab-num{color:" + c.dot + "}"
    );
  }
  function ensureStyle() {
    let st = document.getElementById(STYLE_ID);
    if (!st) { st = document.createElement("style"); st.id = STYLE_ID; document.head.appendChild(st); }
    st.textContent = styleText();
  }

  // ── 颜色分层（4 档）──────────────────────────────────────────────────
  function colorFor(s) {
    if (s >= 90) return "#7CFF7C";   // 绿 流畅
    if (s >= 75) return "#FFD24D";   // 黄 轻微
    if (s >= 50) return "#FF9A3D";   // 橙 明显
    return "#FF4D4D";                // 红 严重
  }

  // ── 拖动（面板标题栏 / FAB 各一套独立位置 key；不依赖 aiti-float）──────
  function attachDrag(handle, target, saveKey, tapFn) {
    let drag = null, moved = false, tapPending = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
      if (e.target && e.target.closest && e.target.closest(".meter-btn")) return; // 按钮不拖
      drag = { sx: e.clientX, sy: e.clientY, ox: target.offsetLeft, oy: target.offsetTop, id: e.pointerId };
      moved = false;
      tapPending = false; // 新交互开始：清上一轮 tap 标记
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) moved = true;
      const nx = Math.max(0, Math.min(window.innerWidth - 44, drag.ox + (e.clientX - drag.sx)));
      const ny = Math.max(0, Math.min(window.innerHeight - 34, drag.oy + (e.clientY - drag.sy)));
      target.style.left = nx + "px";
      target.style.top = ny + "px";
      target.style.right = "auto";
      target.style.bottom = "auto";
    });
    const endDrag = (e) => {
      if (drag && e.pointerId === drag.id) {
        savePos(saveKey, target.offsetLeft, target.offsetTop);
        drag = null;
        // tap 不在这里触发：合成 click 派发前若删除本元素（触屏/异步路径），浏览器会重新
        // hit-test 坐标 → click 落到下层元素（点击穿透）。只打标记，由下方 click 收口——
        // click 派发时目标已锁定本元素，此时再删 DOM/切状态不外漏事件。
        if (tapFn && !moved) tapPending = true;
      }
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    // click 收口：终止向 document/宿主冒泡（避免全局 click-away 监听误判点击外部）；
    // 仅「无位移 tap」触发 tapFn（拖动结束后的合成 click 不误触发，如 FAB 拖完不展开）
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tapPending) { tapPending = false; tapFn && tapFn(); }
    });
  }

  // ── 双态 UI：展开面板 ⇄ 最小化 FAB ──────────────────────────────────
  // ── 面板/FAB 构建与删除（全部走 createElement/removeChild，无 display 切换）──────
  // 最小化 = 删弹窗 + 建 FAB；展开 = 删 FAB + 重建弹窗；关闭 = 全删。
  function buildPanel() {
    ensureStyle();
    el = document.createElement("div");
    el.id = ID;
    const head = document.createElement("div");
    head.className = "meter-head";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = t("title");
    head.innerHTML = '<span class="dot">⣿</span>';
    head.appendChild(ttl);
    const headRun = document.createElement("span");
    headRun.className = "head-run";
    head.appendChild(headRun);
    const sp = document.createElement("span");
    sp.className = "sp";
    head.appendChild(sp);
    // 扩展动作按钮（如「问 AI」）：排最小化左边；icon(svg) 优先于 label；onClick({ report }) 传现场报告
    for (const a of cfg.actions) {
      if (!a || !(a.label || a.icon)) continue;
      const b = document.createElement("button");
      b.className = "meter-btn act";
      b.type = "button";
      if (a.icon) b.innerHTML = a.icon; else b.textContent = a.label;
      if (a.title) { b.title = a.title; b.setAttribute("aria-label", a.title); }
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        try { if (typeof a.onClick === "function") a.onClick({ report: report }); } catch (err) {}
      });
      head.appendChild(b);
    }
    // −（最小化：删弹窗 + 建 FAB）与 ✕（关闭：全删）
    if (cfg.minimize) {
      minBtn = document.createElement("button");
      minBtn.className = "meter-btn min";
      minBtn.type = "button";
      minBtn.textContent = "−";
      minBtn.title = t("min");
      minBtn.setAttribute("aria-label", t("min"));
      minBtn.addEventListener("click", (e) => { e.stopPropagation(); minimize(); });
      head.appendChild(minBtn);
    }
    closeBtn = document.createElement("button");
    closeBtn.className = "meter-btn";
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.title = t("close");
    closeBtn.setAttribute("aria-label", t("close"));
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closePanel(); });
    head.appendChild(closeBtn);
    const scoreLine = document.createElement("div");
    scoreLine.className = "score-line";
    scoreLine.id = SCORE_ID;
    scoreLine.style.display = "none";
    const winLine = document.createElement("div");
    winLine.className = "win-line";
    winLine.id = WIN_ID;
    winLine.style.display = "none";
    const body = document.createElement("div");
    body.className = "raw";
    body.id = BODY_ID;
    el.appendChild(head);
    el.appendChild(scoreLine);
    el.appendChild(winLine);
    el.appendChild(body);
    // 内部版：aiti-float 契约接管拖动/位置持久化（首个子元素 .meter-head 即拖拽把手；
    //   max=0 不注入最大化按钮——检测器是迷你面板，不需要；key 固定便于跨重建恢复位置）
    if (cfg.float) {
      el.setAttribute("data-ext-float", "1");
      el.setAttribute("data-ext-float-key", "aiti-cpu-meter-panel");
      el.setAttribute("data-ext-float-max", "0");
    }
    (document.body || document.documentElement).appendChild(el);
    // 拖拽（面板位置：core 自带持久化；float 模式让位给 aiti-float，避免双拖拽打架）
    if (!cfg.float) {
      attachDrag(head, el, K_POS);
      const p = loadPos(K_POS);
      if (p) { el.style.left = p.x + "px"; el.style.top = p.y + "px"; el.style.right = "auto"; el.style.bottom = "auto"; }
      else placeCorner(el, cfg.pos);
    } else {
      placeCorner(el, cfg.pos); // 初始落位（aiti-float 接管后按其存档覆盖）
    }
    updateFab();
  }
  function removePanel() { if (el && el.parentNode) el.parentNode.removeChild(el); el = null; }
  function buildFab() {
    fab = document.createElement("div");
    fab.id = FAB_ID;
    fab.title = t("fabTip");
    fab.innerHTML = '<span class="fab-dot"></span><span class="fab-num">--</span>';
    (document.body || document.documentElement).appendChild(fab);
    fabDot = fab.querySelector(".fab-dot");
    fabNum = fab.querySelector(".fab-num");
    const f = loadPos(K_FAB);
    if (f) { fab.style.left = f.x + "px"; fab.style.top = f.y + "px"; fab.style.right = "auto"; fab.style.bottom = "auto"; }
    else placeCorner(fab, cfg.pos);
    attachDrag(fab, fab, K_FAB, () => expand());
    updateFab();
  }
  function removeFab() { if (fab && fab.parentNode) fab.parentNode.removeChild(fab); fab = null; fabDot = null; fabNum = null; }

  function ensureDom() {
    ensureStyle();
    // FAB 状态记录恢复：上次最小化过 → 直接停在 FAB 原位（不弹窗）；否则默认弹窗
    const saved = lsGet(K_UI);
    if (cfg.minimize && saved === "minimized") { uiState = "minimized"; buildFab(); }
    else { uiState = "expanded"; buildPanel(); }
  }

  function placeCorner(target, pos) {
    target.style.left = "auto"; target.style.top = "auto"; target.style.right = "auto"; target.style.bottom = "auto";
    if (pos === "left-top") { target.style.left = "12px"; target.style.top = "12px"; }
    else if (pos === "right-bottom") { target.style.right = "12px"; target.style.bottom = "12px"; }
    else if (pos === "right-top") { target.style.right = "12px"; target.style.top = "12px"; }
    else { target.style.left = "12px"; target.style.bottom = "12px"; }
  }

  // 最小化 = 删弹窗 + 建 FAB；展开 = 删 FAB + 重建弹窗（全程 createElement/removeChild）
  // FAB 状态记录：延迟写（250ms 合并；操作路径零同步 IO）
  function minimize() { opAt = performance.now(); uiState = "minimized"; lsSet(K_UI, "minimized"); removePanel(); buildFab(); }
  function expand() { opAt = performance.now(); uiState = "expanded"; closed = false; lsSet(K_UI, "expanded"); removeFab(); buildPanel(); }
  function closePanel() {
    opAt = performance.now();
    closed = true; // 停 render：关闭后不再每 200ms 重写 DOM / 读 localStorage（页面忙时不加剧拥堵）
    // 最简单的删除：直接移除弹窗 + FAB 的 DOM 节点（无 display 隐藏、无状态保留）
    removePanel();
    removeFab();
  } // 刷新后面板重现（挂载逻辑重建 DOM）

  // ── 卡顿快照（localStorage 持久化；第三方网站各站隔离）────────────────
  // 快照不再记录「当时在处理谁」——bigRecentResource 全量遍历 performance resource
  // 条目，在 Android 大页面（几百上千资源）上同步遍历可致秒级长任务（用户实测卡顿依旧）。
  const SNAP_MAX = 6, SNAP_THRESHOLD = 500;
  let snapCache = []; // 快照内存缓存：render 每 200ms 不再同步读 localStorage（忙时最贵的一步），只在记录时刷新
  function loadSnaps() { return snapCache; }
  function refreshSnaps() { try { const r = JSON.parse(lsGet(K_SNAP) || "[]"); snapCache = Array.isArray(r) ? r : []; } catch (e) { snapCache = []; } }
  function persistSnaps(snaps) { lsSet(K_SNAP, JSON.stringify(snaps.slice(-SNAP_MAX))); }
  let lastSnapAt = 0;
  function recordSnap(gap) {
    const sec = (performance.now() - t0) / 1000;
    if (Math.abs(sec - lastSnapAt) < 1.5) return;
    const snap = {
      at: sec.toFixed(1), gap: Math.round(gap),
      lt: longTaskCount, ltMax: Math.round(longTaskMax),
    };
    const snaps = loadSnaps(); snaps.push(snap); persistSnaps(snaps); refreshSnaps(); lastSnapAt = sec;
  }

  // ── 采样循环（rAF）──────────────────────────────────────────────────
  // 操作豁免：minimize/expand/close 后 10s 内的大冻结（gap>1200ms）不计入评分——
  // 用户环境实测：点最小化/展开时产生 6154ms longtask（页面不忙、agent 无回复），
  // 这类「UI 操作引发的副动作」不该被判成页面卡顿；正常小帧照常采样。
  function frame() {
    if (disposed) return;
    const now = performance.now();
    const gap = now - lastRaf;
    lastRaf = now;
    const inOpWin = opAt > 0 && now - opAt < 10000;
    if (inOpWin && gap > 1200) {
      // 操作窗内大冻结：豁免评分采样（保留 maxGap/gapCount 记录供诊断，但不动评分状态）
      if (gap > maxGap) maxGap = gap;
      if (gap > 600) gapCount++;
      raf = requestAnimationFrame(frame);
      return;
    }
    if (gap > maxGap) maxGap = gap;
    if (gap > 600) gapCount++;
    if (gap > SNAP_THRESHOLD) recordSnap(gap);
    // 评分采样（非 hidden；hidden 时 rAF 停发，天然不采样）
    if (!hidden) {
      const sec = (now - t0) / 1000;
      if (sec > 2) started = true;
      if (started) {
        // 帧间隔 EWMA（时间常数 ≈2s：持续饱和信号，跟随帧率自适应）
        const k = Math.min(1, gap / 2000);
        ewmaGap = ewmaGap * (1 - k) + gap * k;
        // 最近最大帧间隔衰减（时间常数 10s）
        recentMax = Math.max(gap, recentMax * Math.exp(-gap / 10000));
        // 冻结次数衰减计数（时间常数 ≈15s：>600ms 帧；重复冻结 → 持续受压）
        if (gap > 600) freezeCnt = freezeCnt * (1 - 1 / 900) + 1;
        else freezeCnt = freezeCnt * (1 - 1 / 900);
      }
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // ── PerformanceObserver longtask（超 50ms 长任务 ≈ CPU 占用来源）──────
  try {
    if (typeof PerformanceObserver !== "undefined") {
      lo = new PerformanceObserver(function (list) {
        for (const e of list.getEntries()) {
          longTaskCount++;
          if (e.duration > longTaskMax) longTaskMax = e.duration;
          blockMsAcc += Math.max(0, e.duration - 50); // TBT 定义累计
          // 长任务时刻自捕获（>500ms 记一条；面板 raw 行展示，用户再测时用于对质来源）
          if (e.duration > 500 && ltLog.length < 20) ltLog.push({ at: Math.round((e.startTime - t0) / 1000), dur: Math.round(e.duration) });
        }
      });
      lo.observe({ entryTypes: ["longtask"] });
    }
  } catch (e) { lo = null; }

  // ── PerformanceObserver long-animation-frame（LoAF：长帧 + 脚本级归因，Chrome 123+）──
  // 比 longtask 多给「这一帧里谁跑的」：scripts[].invoker/sourceURL/sourceFunctionName 直接指认元凶。
  // 只记 ≥150ms 大帧（控内存），每帧保留耗时最高 3 个脚本；环形上限 10 条。
  const loafLog = [];
  let loaf = null;
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf("long-animation-frame") >= 0) {
      loaf = new PerformanceObserver(function (list) {
        for (const e of list.getEntries()) {
          if (e.duration < 150) continue;
          const scripts = (e.scripts || []).map(function (s) {
            let src = s.sourceURL ? String(s.sourceURL).split("/").pop() : "";
            if (src && s.sourceFunctionName) src += "#" + s.sourceFunctionName;
            return { invoker: s.invoker || s.invokerType || "", dur: Math.round(s.duration), src: src };
          }).sort(function (a, b) { return b.dur - a.dur; }).slice(0, 3);
          loafLog.push({
            at: Math.round((e.startTime - t0) / 100) / 10, dur: Math.round(e.duration),
            blocking: Math.round(e.blockingDuration || 0),
            styleLayout: e.styleAndLayoutStart ? 1 : 0, scripts: scripts,
          });
          if (loafLog.length > 10) loafLog.shift();
        }
      });
      loaf.observe({ type: "long-animation-frame", buffered: false });
    }
  } catch (e) { loaf = null; }

  // ── 后台标签页防误报 ────────────────────────────────────────────────
  function onVis() {
    hidden = document.hidden || false;
    if (!hidden) {
      lastRaf = performance.now(); // 恢复可见时重置基准，避免把隐藏时长当卡顿
      lastScoreAt = performance.now();
    }
  }
  document.addEventListener("visibilitychange", onVis);

  // 多语切换（pi-web 内 useI18n.setLocale 派发；外部站无此事件自然无效，语言启动时定型）
  const onLocale = () => {
    try {
      const v = localStorage.getItem("pi-locale");
      const next = (v === "zh-CN" || v === "zh" || v === "zh-TW") ? "zh" : (v === "en" ? "en" : null);
      if (next && next !== lang) {
        lang = next;
        const ttl = el && el.querySelector(".ttl"); if (ttl) ttl.textContent = t("title");
        if (minBtn) { minBtn.title = t("min"); minBtn.setAttribute("aria-label", t("min")); }
        if (closeBtn) { closeBtn.title = t("close"); closeBtn.setAttribute("aria-label", t("close")); }
        if (fab) fab.title = t("fabTip");
      }
    } catch (e) {}
  };
  document.addEventListener("pi-web:locale-changed", onLocale);

  // ── 评分计算（每 tick）──────────────────────────────────────────────
  // 锚定公开算法：Apdex（满意度阈值 50/200ms）+ INP（200/500ms）+ TBT（长任务阻塞量）。
  // 实现用「gap 幅值分段曲线」取代三分桶——三分桶会低估「持续 150ms 中等饱和」
  // （全程 tolerating 得 apdex=0.5 但观感是卡死）。短板原则：取持续(ewmaGap)与尖峰
  // (recentMax) 二者较差，再减阻塞与重复冻结惩罚。
  //
  //   gapScore(g): ≤33ms=100(≤2帧) · 200ms=40 · 1000ms=10 · 10000ms=0（分段线性）
  //   流畅度 = clamp( 100 − 0.60×(100−frameHealth) − 0.20×blockingPenalty − 0.20×freezePenalty )
  //            frameHealth = min(gapScore(ewmaGap), gapScore(recentMax))
  //            blockingPenalty = blockFrac×100；freezePenalty = min(50, freezeCnt×10)
  function gapScore(g) {
    if (g <= 33) return 100;
    if (g <= 200) return 100 - ((g - 33) / (200 - 33)) * 60;       // 200ms → 40
    if (g <= 1000) return 40 - ((g - 200) / (1000 - 200)) * 30;    // 1000ms → 10
    return Math.max(0, 10 - ((g - 1000) / 9000) * 10);             // 10000ms → 0
  }
  function computeScore() {
    const frameHealth = Math.min(gapScore(ewmaGap), gapScore(recentMax));
    const blockingPenalty = blockFrac * 100;
    const freezePenalty = Math.min(50, freezeCnt * 10);
    let s = 100 - 0.60 * (100 - frameHealth) - 0.20 * blockingPenalty - 0.20 * freezePenalty;
    if (s < 0) s = 0; if (s > 100) s = 100;
    return s;
  }

  // ── 渲染（200ms tick）───────────────────────────────────────────────
  function fmtDur(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? h + ":" + p(m) + ":" + p(sec) : p(m) + ":" + p(sec);
  }

  function updateFab() {
    if (!fab) return;
    const s = (cfg.score && curScore != null) ? Math.round(curScore) : null;
    const color = s == null ? "#7CFF7C" : colorFor(s);
    // 内容/颜色变化才写（Android 等低端机上每 tick 无谓样式写+重排很贵）
    if (color !== fabColor) { fabColor = color; fab.style.borderColor = color; if (fabDot) fabDot.style.background = color; if (fabNum) fabNum.style.color = color; }
    const txt = s == null ? "--" : String(s);
    if (txt !== fabText) { fabText = txt; if (fabNum) fabNum.textContent = txt; }
  }

  function render() {
    if (disposed || closed) return; // 关闭后完全停摆（零 DOM/存档开销）
    const now = performance.now();
    // 阻塞占比 EWMA（时间常数 ≈1.3s）
    const fraction = Math.min(1, blockMsAcc / 200);
    blockMsAcc = 0;
    blockFrac = blockFrac * (1 - 0.15) + fraction * 0.15;
    if (started) curScore = computeScore();
    // 会话统计（仅可见时累计；score 关闭则不统计）
    if (!hidden && started && curScore != null) {
      const dt = now - lastScoreAt;
      lastScoreAt = now;
      if (dt > 0) {
        runMs += dt;                       // 运行时长与 score 开关解耦（纯读秒模式标题栏也有）
        if (cfg.score) {
          scoreWeight += dt; scoreTotal += curScore * dt;
          if (maxScore == null || curScore > maxScore) maxScore = curScore;
          if (minScore == null || curScore < minScore) minScore = curScore;
          // 分数历史采样（1s 一条，窗口平均用；性能：数组尾部追加 + 头部裁剪）
          histLast += dt;
          if (histLast >= 1000) {
            histLast = 0;
            hist.push({ t: now, s: curScore });
            const cutoff = now - 10 * 60 * 1000 - 5000; // 保留 10 分钟窗口 + 余量
            while (hist.length && hist[0].t < cutoff) hist.shift();
          }
        }
      }
    }
    updateFab();
    // 标题栏运行时长（每 tick 刷新）
    const headRun = el && el.querySelector(".head-run");
    if (headRun) { const v = runMs > 0 ? t("run") + " " + fmtDur(runMs) : ""; if (v !== lastHeadRun) { lastHeadRun = v; headRun.textContent = v; } }
    if (!el || !el.isConnected || uiState !== "expanded") return;

    const body = document.getElementById(BODY_ID);
    const scoreLine = document.getElementById(SCORE_ID);
    const winLine = document.getElementById(WIN_ID);
    if (!body) return;
    const sec = (now - t0) / 1000;
    const idle = now - lastRaf;
    const frozen = idle > 600;
    // 第一行：流畅度分 + 10 格色条 + 运行/最低/最高（右侧小字）
    // 内容变化才写 DOM（忙碌页面避免无谓 innerHTML 重写/样式计算）
    if (cfg.score && curScore != null && scoreLine) {
      const s = Math.round(curScore);
      const color = colorFor(s);
      const seg = Math.round(s / 10);
      const bar = "█".repeat(seg) + "░".repeat(10 - seg);
      const metaBits = [];
      if (minScore != null) metaBits.push(t("low") + " " + Math.round(minScore));
      if (maxScore != null) metaBits.push(t("max") + " " + Math.round(maxScore));
      const html = '<span class="score-num">' + s + t("unit") + '</span><span class="score-bar">' + bar + "</span>"
        + (metaBits.length ? '<span class="meta">' + metaBits.join(" · ") + "</span>" : "");
      if (html !== lastScoreHtml) { lastScoreHtml = html; scoreLine.style.display = "flex"; scoreLine.style.color = color; scoreLine.innerHTML = html; }
    } else if (scoreLine && lastScoreHtml !== "") { lastScoreHtml = ""; scoreLine.style.display = "none"; }
    if (cfg.score && curScore != null) {
      // 第二行：四项 —— 平均（总平均） · 1分钟 · 5分钟 · 10分钟
      if (winLine) {
        const wbits = [];
        const winAvg = (winMs) => {
          if (!hist.length) return null;
          const cutoff = now - winMs;
          let sum = 0, n = 0;
          for (let i = hist.length - 1; i >= 0; i--) {
            if (hist[i].t < cutoff) break;   // 历史按时间升序，可提前退出
            sum += hist[i].s; n++;
          }
          return n ? Math.round(sum / n) : null;
        };
        const all = scoreWeight > 0 ? Math.round(scoreTotal / scoreWeight) : null;
        if (all != null) wbits.push(t("avg") + " " + all);
        const w1 = winAvg(60 * 1000);      if (w1 != null) wbits.push(t("w1") + " " + w1);
        const w5 = winAvg(5 * 60 * 1000);  if (w5 != null) wbits.push(t("w5") + " " + w5);
        const w10 = winAvg(10 * 60 * 1000); if (w10 != null) wbits.push(t("w10") + " " + w10);
        const wtxt = wbits.join(" · ");
        if (wtxt !== lastWinText) { lastWinText = wtxt; winLine.style.display = wbits.length ? "flex" : "none"; winLine.textContent = wtxt; }
      }
    } else if (winLine && lastWinText !== "") { lastWinText = ""; winLine.style.display = "none"; }
    // 原始诊断行（v0.1 保留；CPU/gap/max 合并一行）
    let txt = "CPU " + sec.toFixed(1) + "s · gap " + idle.toFixed(0) + "ms" + (frozen ? (" ❌" + idle.toFixed(0) + "ms") : "")
      + " · max " + maxGap.toFixed(0) + "ms x" + gapCount;
    if (longTaskCount > 0) txt += "\nlongtask " + longTaskCount + " (max " + Math.round(longTaskMax) + "ms)";
    if (cfg.snaps) {
      const snaps = loadSnaps();
      const last = snaps[snaps.length - 1];
      if (last) txt += "\n--- 上次卡顿 @" + last.at + "s gap" + last.gap + "ms";
    }
    // 长任务自捕获（>500ms 时刻表；诊断来源用，最多 3 条）
    if (ltLog.length) txt += "\nLT@" + ltLog.map((l) => l.at + "s(" + l.dur + "ms)").slice(-3).join(" ");
    if (txt !== lastRawText) { lastRawText = txt; body.textContent = txt; }
  }
  timer = setInterval(render, 200);

  // ── 现场报告（window.__aitiCpuMeter.report()；问 AI / 调试会话数据源）──────
  // 页面源码路径 + 主要大块区域（参照 aiti-devtools 诊断思路）：scripts = 源码路径全集，
  //   regions = 页面结构地图；配合 loaf[].scripts.src/invoker 把卡顿对号到代码与区域。
  function collectSources() {
    const scripts = [];
    try {
      const seen = new Set();
      const res = performance.getEntriesByType("resource") || [];
      for (const s of document.scripts) {
        if (!s.src) continue;
        let u = s.src;
        try { u = new URL(s.src, location.href).href; } catch (err) {}
        if (seen.has(u)) continue;
        seen.add(u);
        let r = null;
        for (let i = 0; i < res.length; i++) { if (res[i].name === u) { r = res[i]; break; } }
        scripts.push({
          src: u.slice(0, 220),
          defer: !!s.defer, async: !!s.async,
          kb: r && r.transferSize ? Math.round(r.transferSize / 102.4) / 10 : null,
          ms: r ? Math.round(r.duration) : null,
        });
        if (scripts.length >= 30) break;
      }
    } catch (err) {}
    const regions = [];
    try {
      const vp = (window.innerWidth || 1) * (window.innerHeight || 1);
      const cands = new Set();
      const body = document.body;
      if (body) for (const el of body.children) cands.add(el);
      const sels = ["main", "[role=main]", "#__next", "#root", "#app", "header", "footer", "nav", "aside"];
      for (const sel of sels) {
        let list = []; try { list = document.querySelectorAll(sel); } catch (err) {}
        for (let i = 0; i < list.length; i++) cands.add(list[i]);
      }
      for (const el of cands) {
        try {
          const r = el.getBoundingClientRect();
          if (r.width < 60 || r.height < 40) continue;
          regions.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || "",
            cls: String(el.className || "").trim().slice(0, 80),
            areaPct: Math.round((r.width * r.height) / vp * 100),
            h: Math.round(r.height),
            kids: el.children.length,
            textLen: (el.textContent || "").length,
          });
        } catch (err) {}
      }
      regions.sort((a, b) => b.areaPct - a.areaPct);
    } catch (err) {}
    return { scripts: scripts, regions: regions.slice(0, 8) };
  }
  function winAvgOf(winMs) {
    if (!hist.length) return null;
    const cutoff = performance.now() - winMs;
    let sum = 0, n = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].t < cutoff) break;
      sum += hist[i].s; n++;
    }
    return n ? Math.round(sum / n) : null;
  }
  function report() {
    const now = performance.now();
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const conn = nav.connection || {};
    return {
      ver: "0.3.1",
      at: new Date().toISOString(),
      pageSec: Math.round((now - t0) / 100) / 10,
      runMs: Math.round(runMs),
      page: {
        url: String(location.href).slice(0, 300),
        title: document.title ? String(document.title).slice(0, 120) : "",
        visible: !document.hidden,
        dpr: window.devicePixelRatio || 1, vw: window.innerWidth, vh: window.innerHeight,
      },
      doc: {
        referrer: String(document.referrer || "").slice(0, 200),
        contentType: String(document.contentType || ""),
        lastModified: String(document.lastModified || ""),
        compatMode: String(document.compatMode || ""), // BackCompat = 怪异模式（布局问题线索）
        charset: String(document.characterSet || ""),
      },
      cookie: cfg.cookie ? String(document.cookie || "").slice(0, 1000) : undefined, // HttpOnly 不可见
      env: {
        ua: String(nav.userAgent || "").slice(0, 200),
        cores: nav.hardwareConcurrency || null,
        deviceMem: nav.deviceMemory || null,
        net: conn.effectiveType || null,
      },
      score: curScore != null ? Math.round(curScore) : null,
      avg: scoreWeight > 0 ? Math.round(scoreTotal / scoreWeight) : null,
      min: minScore != null ? Math.round(minScore) : null,
      max: maxScore != null ? Math.round(maxScore) : null,
      win: { w1: winAvgOf(60000), w5: winAvgOf(300000), w10: winAvgOf(600000) },
      frame: {
        gapNow: Math.round(now - lastRaf),
        maxGap: Math.round(maxGap), freezeCount: gapCount,
        ewmaGap: Math.round(ewmaGap), recentMax: Math.round(recentMax),
      },
      blocking: { blockFrac: Math.round(blockFrac * 1000) / 1000, longtask: longTaskCount, longtaskMax: Math.round(longTaskMax) },
      freezeCnt: Math.round(freezeCnt * 10) / 10,
      ltLog: ltLog.slice(-6),
      loaf: loafLog.slice(-6),
      snaps: snapCache.slice(-6),
      sources: collectSources(),
    };
  }

  ensureDom();
  refreshSnaps(); // 挂载时读一次快照（此后走内存缓存，render 不再同步读 localStorage）
  updateFab();
  try { console.log("[aiti-cpu-meter] 检测器已挂载（" + cfg.pos + (cfg.minimize ? " · 支持最小化" : "") + (cfg.score ? " · 流畅度评分" : "") + "）"); } catch (e) {}

  // ── dispose ─────────────────────────────────────────────────────────
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearInterval(timer); timer = 0; }
    if (lo) { try { lo.disconnect(); } catch (e) {} lo = null; }
    if (loaf) { try { loaf.disconnect(); } catch (e) {} loaf = null; }
    document.removeEventListener("visibilitychange", onVis);
    document.removeEventListener("pi-web:locale-changed", onLocale);
    if (lsTimer) { clearTimeout(lsTimer); lsTimer = 0; try { lsFlush(); } catch (e) {} } // 冲刷未落的延迟写（位置/状态/快照）
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (fab && fab.parentNode) fab.parentNode.removeChild(fab);
    const st = document.getElementById(STYLE_ID);
    if (st && st.parentNode) st.parentNode.removeChild(st);
    if (typeof window !== "undefined" && window.__aitiCpuMeter === handle) window.__aitiCpuMeter = null;
    try { console.log("[aiti-cpu-meter] 已卸载"); } catch (e) {}
  }
  const handle = { dispose: dispose, report: report, opts: cfg };
  if (typeof window !== "undefined") window.__aitiCpuMeter = handle;
  return handle;
}
