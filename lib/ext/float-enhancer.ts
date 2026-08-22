/**
 * ext-float-enhancer —— 扩展弹窗「可拖拽 + 可缩放」自动增强器（框架级 UI 契约）。
 *
 * 目标：扩展开发者给弹窗**面板根节点**加一个属性，自动获得 AI 窗/ai-helper 窗同款的
 * 拖拽移动 + 缩放能力，零逻辑零状态（DOM 级增强，不侵入 React——同 aiti-helper
 * 全局弹窗 AI 按钮的扫描注入模式）。
 *
 * ── 扩展侧用法（全部可选，最小只需一行）──────────────────────────────────
 *   <div data-ext-float="1" ...>        ← 弹窗面板根节点（不是全屏遮罩层！）
 *     <div>标题栏…</div>                 ← 默认拖拽把手 = 面板第一个子元素
 *     <div>内容…</div>
 *   </div>
 *
 * 属性：
 *   data-ext-float          "1"（缺省 = 移动 + 缩放）| "drag"（仅移动）| "resize"（仅缩放）
 *   data-ext-float-drag     标在面板内某个子元素上 = 指定拖拽把手（缺省 = 第一个子元素）
 *   data-ext-float-w / -h   初始尺寸 px（缺省 = 增强时面板实际尺寸）
 *   data-ext-float-min-w / -min-h  最小尺寸（缺省 320×200）
 *   data-ext-float-key      持久化键（缺省按框架标注的 data-ext-item 反查，如 "ext:dialog"）
 *
 * ── 自动获得的能力 ────────────────────────────────────────────────────────
 *   - 标题栏拖拽移动（鼠标/触屏；按钮等交互元素上按下不触发拖拽）
 *   - 右/下/左缘 + 右下角缩放手柄（同 AI 窗体验；右下角常显斜纹角标）
 *   - 位置/尺寸持久化（localStorage，关掉重开/跨会话恢复；双击把手复位并清除）
 *   - 点按置前（多个浮动面板堆叠时 clicked 面板提到最前；自适应抬升所属遮罩层）
 *   - 窗口尺寸变化时夹回视口（面板永远可抓到）
 *
 * 注意（写给扩展作者）：
 *   - 属性加在「面板」上，不是全屏遮罩 div 上（遮罩继续负责点外部关闭）。
 *   - 声明 data-ext-float 后，位置/尺寸归框架管：不要在自己的 style 里写
 *     left/top/width/height（写了也会被覆盖；初始尺寸用 data-ext-float-w/-h）。
 *   - 已有自绘拖拽逻辑的弹窗（如 ai-helper）不必接入，避免两套手势打架。
 */

const DONE_ATTR = "data-ext-float-done";
const LS_PREFIX = "pi-web:ext-float:v1:";
const CSS_ID = "pi-web-ext-float-css";

const CSS_TEXT = `
.piwe-float-h { position: absolute; z-index: 5; touch-action: none; user-select: none; }
.piwe-float-se { right: -4px; bottom: -4px; width: 18px; height: 18px; cursor: nwse-resize; }
.piwe-float-e  { right: -4px; top: 14%; bottom: 14%; width: 8px; cursor: ew-resize; }
.piwe-float-s  { bottom: -4px; left: 14%; right: 14%; height: 8px; cursor: ns-resize; }
.piwe-float-w  { left: -4px; top: 14%; bottom: 14%; width: 8px; cursor: ew-resize; }
.piwe-float-se::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px;
  border-right: 2px solid rgba(128,128,128,.55); border-bottom: 2px solid rgba(128,128,128,.55);
  border-radius: 0 0 2px 0; }
.piwe-float-h:hover::after, .piwe-float-se:hover::after { border-color: var(--accent, #2563eb); }
.piwe-float-dragging, .piwe-float-dragging * { user-select: none !important; }
`;

interface FloatState { x: number; y: number; w: number; h: number }

/** 手势（拖拽/缩放共用）：pointerdown → move(rAF 合并) → end（up/cancel/blur 必达）。 */
interface GestureOpts {
  /** 按下即挡默认（缩放手柄用；会杀 click 的把手勿开） */
  preventStart?: boolean;
  /** 判定拖动的位移阈值 px（标题栏用 3：纯点击不被吞） */
  threshold?: number;
  onStart(): void;
  onMove(dx: number, dy: number): void;
  onEnd(moved: boolean): void;
}

const INTERACTIVE_SEL =
  'button, a, input, textarea, select, label, [contenteditable="true"], [contenteditable="plaintext-only"], [role="button"], [role="slider"], [role="tab"]';

function vw(): number { return window.innerWidth || document.documentElement.clientWidth || 1280; }
function vh(): number { return window.innerHeight || document.documentElement.clientHeight || 800; }

/** 单个元素的手势生命周期（对齐 launcher drag.js 的教训：window 级监听 + 多路兜底必达）。
 *  返回卸载函数。 */
function attachGesture(handle: HTMLElement, opts: GestureOpts): () => void {
  let pid: number | null = null;
  let sx = 0, sy = 0, moved = false, capped = false, frame = 0, lastEv: PointerEvent | null = null;
  const threshold = opts.threshold ?? 0;

  const applyMove = () => {
    if (!lastEv) return;
    opts.onMove(lastEv.clientX - sx, lastEv.clientY - sy);
  };
  const finish = (fire: boolean) => {
    if (pid === null) return;
    const wasMoved = moved;
    pid = null;
    if (frame) { // 冲刷末帧（rAF 排队中还没应用的目标值——onEnd 前状态收敛到最终）
      cancelAnimationFrame(frame); frame = 0;
      if (fire && wasMoved && lastEv) applyMove();
    }
    lastEv = null;
    try { opts.onEnd(wasMoved); } catch { /* 扩展面板可能已销毁 */ }
  };

  const onMove = (ev: PointerEvent) => {
    if (pid === null || ev.pointerId !== pid) return;
    if (!moved) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= threshold) return;
      moved = true;
      if (!capped) { capped = true; try { handle.setPointerCapture(pid); } catch { /* ignore */ } }
    }
    try { ev.preventDefault(); } catch { /* ignore */ }
    lastEv = ev;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (lastEv) applyMove(); });
  };
  const onUp = (ev: PointerEvent) => { if (pid !== null && ev.pointerId === pid) finish(true); };

  const onDown = (e: PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return; // 仅主键/触摸
    if (pid !== null) return; // 手势进行中（多点触控第二指）
    pid = e.pointerId; sx = e.clientX; sy = e.clientY;
    moved = threshold <= 0; capped = false;
    if (opts.preventStart) { try { e.preventDefault(); } catch { /* ignore */ } }
    try { opts.onStart(); } catch { /* ignore */ }
  };
  const onLostCapture = (ev: Event) => {
    if (ev.target !== handle) return; // 子元素隐式捕获转移，不算结束
    if (pid !== null && (ev as PointerEvent).pointerId === pid) finish(true);
  };
  const onBlur = () => finish(true);

  handle.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("blur", onBlur);
  handle.addEventListener("lostpointercapture", onLostCapture);
  return () => {
    handle.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("blur", onBlur);
    handle.removeEventListener("lostpointercapture", onLostCapture);
    if (frame) cancelAnimationFrame(frame);
  };
}

function attrPx(el: HTMLElement, name: string): number | null {
  const v = parseFloat(el.getAttribute(name) || "");
  return Number.isFinite(v) && v > 0 ? v : null;
}

function clampState(s: FloatState, minW: number, minH: number): FloatState {
  const W = vw(), H = vh();
  const w = Math.max(minW, Math.min(s.w, W - 16));
  const h = Math.max(minH, Math.min(s.h, H - 16));
  // 至少留 80×40 在屏内（面板永远可抓回），允许部分拖出屏
  const x = Math.max(-(w - 80), Math.min(s.x, W - 80));
  const y = Math.max(0, Math.min(s.y, H - 40));
  return { x, y, w, h };
}

function applyState(panel: HTMLElement, s: FloatState): void {
  const st = panel.style;
  // important：扩展 React style 里声明过这些键时，重渲染不至于把框架接管的状态冲掉
  st.setProperty("position", "fixed", "important");
  st.setProperty("left", s.x + "px", "important");
  st.setProperty("top", s.y + "px", "important");
  st.setProperty("right", "auto", "important");
  st.setProperty("bottom", "auto", "important");
  st.setProperty("width", s.w + "px", "important");
  st.setProperty("height", s.h + "px", "important");
  st.setProperty("max-width", "none", "important");
  st.setProperty("max-height", "none", "important");
  st.setProperty("margin", "0", "important");
  st.setProperty("box-sizing", "border-box", "important");
}

function persistenceKey(panel: HTMLElement): string | null {
  const k = panel.getAttribute("data-ext-float-key");
  if (k) return k;
  const item = panel.closest("[data-ext-item]");
  return item ? item.getAttribute("data-ext-item") : null; // 框架盖的 "extId:itemId"
}

function loadSaved(key: string | null): Partial<FloatState> | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<FloatState>;
    const n: Record<string, number> = { x: +(o.x ?? NaN), y: +(o.y ?? NaN), w: +(o.w ?? NaN), h: +(o.h ?? NaN) };
    if (!Object.values(n).every(Number.isFinite)) return null;
    return n as Partial<FloatState>;
  } catch { return null; }
}

function saveState(key: string | null, s: FloatState): void {
  if (!key) return;
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(s)); } catch { /* 隐私模式等 */ }
}

function clearSaved(key: string | null): void {
  if (!key) return;
  try { localStorage.removeItem(LS_PREFIX + key); } catch { /* ignore */ }
}

/** 点按置前：共享 z 计数器；面板自身 + 所属遮罩层（最近定位祖先）一起抬。 */
let topZ = 3000;
function bringToFront(panel: HTMLElement): void {
  const cur = Number(getComputedStyle(panel).zIndex) || 0;
  if (cur >= topZ) return; // 已在最前（或扩展自管超大 z，如 extman 的 2147483644——不碰）
  topZ = Math.min(topZ + 1, 2147483000);
  panel.style.setProperty("z-index", String(topZ), "important");
  // 遮罩层是真正的堆叠兄弟——不抬它，面板提不到别的弹窗之上
  let host = panel.parentElement;
  while (host && host !== document.body) {
    const cs = getComputedStyle(host);
    if (cs.position !== "static" || cs.transform !== "none") {
      const hz = Number(cs.zIndex) || 0;
      if (hz < topZ) host.style.setProperty("z-index", String(topZ), "important");
      break;
    }
    host = host.parentElement;
  }
}

/** 增强一个面板：定位接管 + 手势 + 持久化。返回清理函数（元素离场后调用无害）。 */
function enhancePanel(panel: HTMLElement): () => void {
  const modeRaw = (panel.getAttribute("data-ext-float") || "1").trim().toLowerCase();
  const drag = modeRaw === "1" || modeRaw === "drag" || modeRaw === "" || modeRaw === "true";
  const resize = modeRaw === "1" || modeRaw === "resize" || modeRaw === "" || modeRaw === "true";

  const minW = attrPx(panel, "data-ext-float-min-w") ?? 320;
  const minH = attrPx(panel, "data-ext-float-min-h") ?? 200;
  const rect = panel.getBoundingClientRect();
  const initW = attrPx(panel, "data-ext-float-w") ?? (Math.round(rect.width) || 360);
  const initH = attrPx(panel, "data-ext-float-h") ?? (Math.round(rect.height) || 240);
  const key = persistenceKey(panel);

  const initial: FloatState = clampState(
    { x: Math.round((vw() - initW) / 2), y: Math.round((vh() - initH) / 2), w: initW, h: initH },
    minW, minH,
  );
  let state: FloatState = { ...initial, ...pickFinite(loadSaved(key) ?? {}) };
  state = clampState(state, minW, minH);
  applyState(panel, state);
  panel.setAttribute(DONE_ATTR, "1");

  const disposers: Array<() => void> = [];
  const persist = () => saveState(key, state);

  // ── 缩放手柄（右/下/左缘 + 右下角，同 AI 窗）──
  if (resize) {
    const mk = (cls: string, dir: "e" | "s" | "w" | "se") => {
      const hEl = document.createElement("div");
      hEl.className = "piwe-float-h " + cls;
      hEl.setAttribute("aria-hidden", "true");
      panel.appendChild(hEl);
      const orig = { ...state };
      disposers.push(attachGesture(hEl, {
        preventStart: true,
        onStart: () => { orig.x = state.x; orig.y = state.y; orig.w = state.w; orig.h = state.h; panel.classList.add("piwe-float-dragging"); },
        onMove: (dx, dy) => {
          let { x, w } = orig;
          let { y, h } = orig;
          if (dir === "e" || dir === "se") w = orig.w + dx;
          if (dir === "w") { w = orig.w - dx; x = orig.x + dx; }
          if (dir === "s" || dir === "se") h = orig.h + dy;
          // 左缘夹最小宽：宽被夹住时左缘回跟（右缘不动）
          if (dir === "w" && w < minW) { x = orig.x + (orig.w - minW); w = minW; }
          state = clampState({ x, y, w, h }, minW, minH);
          applyState(panel, state);
        },
        onEnd: (moved) => { panel.classList.remove("piwe-float-dragging"); if (moved) persist(); },
      }));
    };
    mk("piwe-float-se", "se");
    mk("piwe-float-e", "e");
    mk("piwe-float-s", "s");
    mk("piwe-float-w", "w");
  }

  // ── 拖拽（把手 = [data-ext-float-drag] 标记 / 第一个子元素 / 面板自身）──
  if (drag) {
    const marked = panel.querySelector<HTMLElement>("[data-ext-float-drag]");
    const first = panel.firstElementChild instanceof HTMLElement ? panel.firstElementChild : null;
    const handle = marked || first || panel;
    try { handle.style.setProperty("cursor", "move"); } catch { /* ignore */ }
    if (!handle.getAttribute("title")) handle.setAttribute("title", "拖动移动 · 双击复位");
    const orig = { x: 0, y: 0 };
    disposers.push(attachGesture(handle, {
      threshold: 3,
      onStart: () => { orig.x = state.x; orig.y = state.y; },
      onMove: (dx, dy) => {
        panel.classList.add("piwe-float-dragging");
        state = clampState({ ...state, x: orig.x + dx, y: orig.y + dy }, minW, minH);
        applyState(panel, state);
      },
      onEnd: (moved) => { panel.classList.remove("piwe-float-dragging"); if (moved) persist(); },
    }));
    // 双击把手 = 复位（清持久化，回初始位置尺寸）
    const onDbl = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(INTERACTIVE_SEL)) return;
      clearSaved(key);
      state = { ...initial };
      applyState(panel, state);
    };
    handle.addEventListener("dblclick", onDbl);
    disposers.push(() => handle.removeEventListener("dblclick", onDbl));
  }

  // 点按置前（capture：任何子元素按下都算）
  const onFront = () => bringToFront(panel);
  panel.addEventListener("pointerdown", onFront, true);
  disposers.push(() => panel.removeEventListener("pointerdown", onFront, true));

  // 窗口尺寸变化时夹回视口（注册在全局列表，元素离场自动剪除）
  const reclamp = () => { state = clampState(state, minW, minH); applyState(panel, state); };
  liveReclamps.add(reclamp);
  disposers.push(() => liveReclamps.delete(reclamp));

  return () => disposers.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

function pickFinite(o: Partial<FloatState>): Partial<FloatState> {
  const out: Partial<FloatState> = {};
  for (const k of ["x", "y", "w", "h"] as const) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const liveReclamps = new Set<() => void>();
/** 已增强面板 → 清理函数（面板离场后调用无害，无需精确追踪）。 */
const cleanups = new WeakMap<HTMLElement, () => void>();

function scan(): void {
  document.querySelectorAll<HTMLElement>("[data-ext-float]").forEach((panel) => {
    if (panel.hasAttribute(DONE_ATTR)) return;
    const r = panel.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return; // 未渲染/隐藏——等下一次 mutation 再试
    cleanups.set(panel, enhancePanel(panel));
  });
}

/**
 * 安装增强器（幂等；在客户端挂载一次即可，ExtSlotsProvider 已接）。
 * 返回卸载函数。DOM 里出现 data-ext-float 面板 → 自动增强；带 data-ext-float-key
 * 可脱离扩展体系使用（内置弹窗也能标）。
 */
export function installExtFloatEnhancer(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (!document.getElementById(CSS_ID)) {
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const throttledScan = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 60);
  };

  const mo = new MutationObserver(throttledScan);
  mo.observe(document.body, { childList: true, subtree: true });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      liveReclamps.forEach((fn) => { try { fn(); } catch { /* 面板可能已离场 */ } });
    }, 120);
  };
  window.addEventListener("resize", onResize);

  scan();

  return () => {
    mo.disconnect();
    window.removeEventListener("resize", onResize);
    if (timer) clearTimeout(timer);
    if (resizeTimer) clearTimeout(resizeTimer);
    liveReclamps.clear();
  };
}
