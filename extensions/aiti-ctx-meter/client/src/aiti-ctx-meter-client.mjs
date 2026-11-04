/**
 * aiti-ctx-meter client（纯 mjs，ctx.h + ctx hooks，免 vite——范式照 aiti-msg-smart/aiti-draft-keeper）。
 *
 * 插槽消费（docs/aiti-ctx-meter-plan.md §6）：
 *   - compactLead   桌面比例条（压缩按钮左邻位，v0.1.2 自 composerTools 迁此）
 *   - modelInfoLead  小屏比例条（展开态输入行 + InfoSheet 模型行，宿主渲染点）
 *
 * 红线：无轮询（percent 由宿主 state 事件驱动经 extra 直达）；
 *       工具条禁 emoji（指示条为内联 SVG，extman 条目图标走 icons/meter-vertical.svg）。
 */

// ── ctx 捕获（register 注入后组件才可用）──
let h = null;
let ctxT = null;

// ── 纯函数（aiti-ctx-meter.test.mjs 钉住）──

/** percent（0-100）→ 填充高度 px；clamp 0-100、下限 2px 可见、非数字 0。 */
export function barFillHeight(percent, innerH) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  const p = Math.max(0, Math.min(100, percent));
  if (p <= 0) return 0;
  return Math.min(innerH, Math.max(2, Math.round((p / 100) * innerH)));
}

/** 比例条旁整数百分比；无数据 "--"。 */
export function barPercentLabel(percent) {
  return typeof percent === "number" && Number.isFinite(percent) ? String(Math.round(percent)) : "--";
}

/** 窗口大小紧凑格式（200000→200K / 1500000→1.5M）。 */
export function formatWindow(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n >= 1e6) return (n % 1e6 ? (n / 1e6).toFixed(1) : String(n / 1e6)) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

/**
 * 小屏（modelInfoLead，宿主 extra.isMobile）只显示比例条本体——数字文案省位，
 * 给右侧按钮排让宽（瓶颈位）；桌面 compactLead 仍显示整数百分比。
 * 百分比数值仍保留在 title/aria-label（悬浮可见，无障碍不丢信息）。
 */
export function shouldShowPercentLabel(isMobile) {
  return !isMobile;
}

/** tooltip：percent 一位小数 + 窗口 + 压缩三态附加行；无数据走 i18n meter.none。 */
export function barTitleText(context, compact, tr) {
  if (!context) return (tr && tr("meter.none")) || "暂无上下文数据（空闲会话或外部后端）";
  const percent = typeof context.percent === "number" && Number.isFinite(context.percent)
    ? context.percent.toFixed(1)
    : "--";
  let s = `${percent}% · 窗口 ${formatWindow(context.contextWindow) || "--"}`;
  if (compact && compact.isCompacting) s += " · " + ((tr && tr("meter.compacting")) || "压缩中…");
  else if (compact && compact.compactQueued) s += " · " + ((tr && tr("meter.queued")) || "压缩已排队");
  return s;
}

// ── 呼吸动画（critical 档；prefers-reduced-motion 关——对齐宿主 ctx-urgency-breathe 先例）──
const BREATHE_CSS =
  "@keyframes aiti-ctx-meter-breathe{from{opacity:1}to{opacity:.45}}" +
  "@media (prefers-reduced-motion:reduce){[data-aiti-ctx-breathe]{animation:none!important}}";
let styleInjected = false;
function ensureBreatheStyle() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const el = document.createElement("style");
  el.textContent = BREATHE_CSS;
  document.head.appendChild(el);
}

// ctx.t 未命中返回 key 原文 → 经 tr() 归空串交给调用方中文兜底（aiti-msg-smart 同款）
function makeTr() {
  if (typeof ctxT !== "function") return () => "";
  return (k) => {
    const v = ctxT(k);
    return typeof v === "string" && v !== k ? v : "";
  };
}

const FALLBACK_URGENCY = { level: "calm", color: "var(--text-muted)", bg: "none", border: "var(--border)" };

// ── 比例条 SVG（方正块：轨道 + 自底向上填充，无拟物描边/触点；viewBox 10×12，与其他图标比例一致）──
function BarGlyph({ percent, color, w, h: sh }) {
  const innerH = 8.5;
  const innerBottom = 10.25;
  const fh = barFillHeight(percent, innerH);
  return h("svg", { width: w, height: sh, viewBox: "0 0 10 12", "aria-hidden": "true", style: { flexShrink: 0 } },
    h("rect", { x: 0.5, y: 0.5, width: 9, height: 11, rx: 2.25, fill: "var(--border)" }),
    fh > 0 ? h("rect", { x: 1.75, y: innerBottom - fh, width: 6.5, height: fh, rx: 1.25, fill: color }) : null,
  );
}

/**
 * 竖向比例条（compactLead / modelInfoLead 共用）。
 * @param {object} props 插槽 extra：{ sessionId, cwd, context, compact, openSessionInfo, isMobile }
 *   context 为 null（外部后端/idle）→ 空轨道灰态不可点；
 *   isMobile（modelInfoLead）→ 只渲染条本体（v0.1.4，数字省位，tooltip 仍含数值）。
 *   openSessionInfo 已服务化（宿主 extra 不再喂）：rp 优先 → "pi-web.composer"
 *   服务兜底（slot extra 回调解耦方案批次 B，2026-09-16）。
 */
/** 扩展 ctx（register 时存）——MeterBar 经 ctx.getExtService 读宿主 "pi-web.composer" 服务。 */
let meterExtCtx = null;
function resolveOpenSessionInfo(rp) {
  if (typeof rp?.openSessionInfo === "function") return rp.openSessionInfo;
  try {
    const getSvc = meterExtCtx?.getExtService;
    const svc = getSvc ? getSvc("pi-web.composer") : null;
    const fn = svc?.get ? svc.get("openSessionInfo") : null;
    if (typeof fn === "function") return fn;
  } catch { /* 服务缺席/未就绪——不可点降级 */ }
  return undefined;
}
function MeterBar(props) {
  ensureBreatheStyle();
  const { context, compact, isMobile } = props || {};
  const openSessionInfo = resolveOpenSessionInfo(props);
  const has = !!context;
  const percent = has ? context.percent : null;
  const urg = (has && context.urgency) || FALLBACK_URGENCY;
  const breathe = has && urg.level === "critical" && !(compact && compact.isCompacting) && !(compact && compact.compactQueued);
  const clickable = has && typeof openSessionInfo === "function";
  const tr = makeTr();
  const title = barTitleText(context, compact, tr);
  const showLabel = shouldShowPercentLabel(isMobile);
  return h("button", {
    type: "button",
    title,
    "aria-label": title,
    "data-aiti-ctx-breathe": breathe ? "1" : undefined,
    "data-aiti-ctx-meter": "1",
    onClick: clickable ? () => openSessionInfo() : undefined,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: showLabel ? 4 : 0,
      height: 32,
      padding: isMobile ? "0 3px" : "0 5px",
      background: "none",
      border: "none",
      borderRadius: 9,
      cursor: clickable ? "pointer" : "default",
      color: urg.color,
      fontSize: 12,
      whiteSpace: "nowrap",
      animation: breathe ? "aiti-ctx-meter-breathe 1.2s ease-in-out infinite alternate" : undefined,
      touchAction: "manipulation",
    },
    onMouseEnter: (e) => { if (clickable) e.currentTarget.style.background = "var(--bg-hover, rgba(128,128,128,0.12))"; },
    onMouseLeave: (e) => { e.currentTarget.style.background = "none"; },
  },
    h(BarGlyph, { percent, color: urg.color, w: isMobile ? 9 : 10, h: isMobile ? 10.8 : 12 }),
    showLabel ? h("span", { style: { whiteSpace: "nowrap" } }, barPercentLabel(percent)) : null,
  );
}

export default function register(ctx) {
  h = ctx.h;
  ctxT = ctx.t;
  meterExtCtx = ctx; // MeterBar 服务兜底用（getExtService("pi-web.composer")）

  const disposes = [];
  const safeRegister = (slot, items) => {
    try {
      const d = ctx.registerItems(slot, items);
      if (typeof d === "function") disposes.push(d);
    } catch (e) {
      // 宿主过旧（缺 modelInfoLead 等新插槽）→ 降级为不显示，不抛不白屏
      console.warn(`[aiti-ctx-meter] registerItems(${slot}) 失败:`, (e && e.message) || e);
    }
  };
  // 桌面比例条：压缩按钮左邻位（compactLead，v0.1.2 自 composerTools 行尾迁此）
  safeRegister("compactLead", [{ id: "ctx-meter", render: MeterBar }]);
  // 小屏比例条：展开态输入行 + InfoSheet 模型行（宿主 modelInfoLead 两处渲染点）
  safeRegister("modelInfoLead", [{ id: "ctx-meter", render: MeterBar }]);
  return () => {
    for (const d of disposes) {
      try { d(); } catch { /* ignore */ }
    }
  };
}
