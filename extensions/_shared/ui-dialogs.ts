/**
 * 内部弹窗共享模块（替代浏览器原生 alert/confirm/prompt）。
 *
 * 背景：原生 window.confirm/alert/prompt 是浏览器默认弹窗——阻塞主线程、样式与系统脱节、
 * 且在部分嵌入环境（webview/无头）表现不一致。本模块提供 Promise 风格替代：
 *
 *   const ok = await uiConfirm({ message: "删除分组 X？", danger: true });
 *   await uiAlert("已创建计划");                       // 字符串快捷
 *   await uiAlert({ message: "保存失败", kind: "error" });
 *   const name = await uiPrompt({ message: "输入名称：", value: "草稿" });  // 取消 → null
 *
 * 实现：零依赖纯 DOM（React 扩展与原生 h() 扩展通用；事件处理器里直接 await）。
 * 契约（详见 docs/aiti-web-ext-float-dialogs.md）：
 *   - data-ext-float="1"          → aiti-float 接管拖拽/置前/持久化；未装时回退 overlay flex 居中
 *   - data-ext-float-full="1"     → 小屏（≤640px）自动铺满视口（物理适配）
 *   - data-ext-float-keepmask="1" → 真模态：遮罩不去除、点外不关闭（副作用即所求）
 *   - data-ext-float-max="0"      → 豁免最大化按钮注入（小确认框不需要）
 *   - data-ext-float-persist="0"  → 不做位置持久化（一次性弹窗不污染持久化槽）
 * 同一时刻只显示一个弹窗（内部 Promise 链排队），保证不叠罗汉。
 */

export type UiDialogKind = "info" | "success" | "error" | "warn";

export interface UiConfirmOptions {
  title?: string;
  message?: string;
  /** 附加等宽代码块（如待执行的命令文本） */
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险确认：⚠ 图标 + 红色确认按钮 */
  danger?: boolean;
}

export interface UiAlertOptions {
  title?: string;
  message?: string;
  detail?: string;
  kind?: UiDialogKind;
  confirmText?: string;
}

export interface UiPromptOptions {
  title?: string;
  message?: string;
  value?: string;
  placeholder?: string;
  /** 输入为空时禁用确定按钮（默认 false：允许空串确认） */
  required?: boolean;
}

const Z_BASE = 6000;

/** 常用 CSS 变量兜底（宿主一定是 pi-web 主题页；fallback 仅为防御） */
const V = {
  panel: "var(--bg-panel, #1c1c20)",
  hover: "var(--bg-hover, #2a2a30)",
  border: "var(--border, #3a3a42)",
  text: "var(--text, #e8e8ec)",
  muted: "var(--text-muted, #9a9aa4)",
  accent: "var(--accent, #4f8ef7)",
  mono: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
};

const KIND_COLOR: Record<UiDialogKind, string> = {
  info: V.accent,
  success: "#10b981",
  error: "#ef4444",
  warn: "#f59e0b",
};

/** 线性 stroke 图标（24 viewBox），随色 */
function iconSvg(kind: "warn" | "info" | "success" | "error", color: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.style.flexShrink = "0";
  const common = { fill: "none", stroke: color, "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } as const;
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  };
  if (kind === "warn") {
    add("path", { ...common, d: "M12 3 L22 20 H2 Z" });
    add("line", { ...common, x1: "12", y1: "9.5", x2: "12", y2: "14" });
    add("line", { ...common, x1: "12", y1: "16.8", x2: "12", y2: "16.9" });
  } else if (kind === "error") {
    add("circle", { ...common, cx: "12", cy: "12", r: "9" });
    add("line", { ...common, x1: "9", y1: "9", x2: "15", y2: "15" });
    add("line", { ...common, x1: "15", y1: "9", x2: "9", y2: "15" });
  } else if (kind === "success") {
    add("circle", { ...common, cx: "12", cy: "12", r: "9" });
    add("path", { ...common, d: "M8 12.5 L11 15.5 L16.5 9.5" });
  } else {
    add("circle", { ...common, cx: "12", cy: "12", r: "9" });
    add("line", { ...common, x1: "12", y1: "11", x2: "12", y2: "16" });
    add("line", { ...common, x1: "12", y1: "8", x2: "12", y2: "8.01" });
  }
  return svg;
}

const btnBase = {
  border: "1px solid " + V.border,
  background: V.hover,
  borderRadius: 6,
  padding: "6px 16px",
  cursor: "pointer",
  fontSize: 13,
  color: V.text,
  fontFamily: "inherit",
} as const;

interface PendingSpec {
  kind: "confirm" | "alert" | "prompt";
  opts: any;
  resolve: (v: unknown) => void;
}

/** 弹窗队列：同一时刻只显示一个（先到先显，后续排队） */
let chain: Promise<unknown> = Promise.resolve();
const queue: PendingSpec[] = [];
let showing = false;

function enqueue<T>(specKind: PendingSpec["kind"], opts: any): Promise<T> {
  return new Promise<T>((resolve) => {
    queue.push({ kind: specKind, opts, resolve: resolve as (v: unknown) => void });
    drain();
  });
}

function drain() {
  if (showing) return;
  const next = queue.shift();
  if (!next) return;
  showing = true;
  try {
    showDialog(next, () => {
      showing = false;
      drain();
    });
  } catch (e) {
    // 极端防御：DOM 不可用时按取消收场，不让队列卡死
    next.resolve(next.kind === "prompt" ? null : next.kind === "confirm" ? false : undefined);
    showing = false;
    drain();
  }
}

/** 顶层挂载点：直接 document.body（最高层级，不依赖扩展面板 DOM） */
function mount(): { overlay: HTMLDivElement; panel: HTMLDivElement } {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-ui-dialog-overlay", "1");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:" + Z_BASE + ";";
  const panel = document.createElement("div");
  panel.setAttribute("data-ext-float", "1");
  panel.setAttribute("data-ext-float-w", "440");
  panel.setAttribute("data-ext-float-autoh", "1");
  panel.setAttribute("data-ext-float-full", "1");
  panel.setAttribute("data-ext-float-keepmask", "1");
  panel.setAttribute("data-ext-float-max", "0");
  panel.setAttribute("data-ext-float-persist", "0");
  panel.tabIndex = -1;
  panel.style.cssText =
    "width:440px;max-width:100%;border-radius:12px;background:" + V.panel + ";border:1px solid " + V.border +
    ";color:" + V.text + ";font-family:inherit;font-size:13px;box-shadow:0 20px 60px rgba(0,0,0,0.35);outline:none;overflow:hidden;";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  return { overlay, panel };
}

function buildBody(panel: HTMLDivElement, spec: PendingSpec, finish: (v: unknown) => void): HTMLInputElement | null {
  const o = spec.opts || {};
  const kind: UiDialogKind = spec.kind === "confirm"
    ? "info"
    : ((o.kind === "success" || o.kind === "error" || o.kind === "warn" || o.kind === "info" ? o.kind : "info") as UiDialogKind);
  const color = spec.kind === "confirm" && o.danger ? KIND_COLOR.error : KIND_COLOR[kind];
  const iconKind: "warn" | UiDialogKind = spec.kind === "confirm" && o.danger ? "warn" : kind;

  // 标题栏（aiti-float 把首个子元素当拖拽把手）
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:10px;padding:14px 18px 0;";
  const icon = iconSvg(iconKind, color);
  icon.style.width = "20px";
  icon.style.height = "20px";
  head.appendChild(icon);
  const titleEl = document.createElement("div");
  titleEl.style.cssText = "flex:1;min-width:0;font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  titleEl.textContent = o.title || (spec.kind === "confirm" ? (o.danger ? "危险操作确认" : "确认操作") : spec.kind === "prompt" ? "输入" : "提示");
  head.appendChild(titleEl);
  panel.appendChild(head);

  // 正文
  if (o.message) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:12px 18px 0;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:" + V.text + ";";
    msg.textContent = String(o.message);
    panel.appendChild(msg);
  }
  // 等宽 detail 块（命令等）
  if (o.detail) {
    const det = document.createElement("pre");
    det.style.cssText =
      "margin:10px 18px 0;padding:10px 12px;border-radius:8px;background:" + V.hover + ";border:1px solid " + V.border +
      ";font-family:" + V.mono + ";font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;color:" + V.text + ";";
    det.textContent = String(o.detail);
    panel.appendChild(det);
  }
  // prompt 输入框
  let input: HTMLInputElement | null = null;
  if (spec.kind === "prompt") {
    input = document.createElement("input");
    input.type = "text";
    input.value = typeof o.value === "string" ? o.value : "";
    if (o.placeholder) input.placeholder = String(o.placeholder);
    input.style.cssText =
      "display:block;margin:12px 18px 0;width:calc(100% - 36px);box-sizing:border-box;border:1px solid " + V.border +
      ";border-radius:6px;padding:7px 10px;font-size:13px;background:" + V.hover + ";color:" + V.text + ";font-family:inherit;outline:none;";
    input.addEventListener("focus", () => { input!.style.borderColor = V.accent; });
    input.addEventListener("blur", () => { input!.style.borderColor = V.border; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(input && o.required && !input.value.trim() ? undefined : input!.value); }
    });
    panel.appendChild(input);
  }

  // 页脚
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 18px;";
  const mk = (label: string, primary: boolean, dangerStyle: boolean, onClick: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = Object.entries({
      ...btnBase,
      ...(primary ? { background: dangerStyle ? KIND_COLOR.error : V.accent, borderColor: "transparent", color: "#fff", fontWeight: "600" } : {}),
    }).map(([k, v]) => k + ":" + v).join(";") + ";";
    b.addEventListener("click", onClick);
    foot.appendChild(b);
    return b;
  };
  if (spec.kind === "alert") {
    const ok = mk(o.confirmText || "确定", true, false, () => finish(undefined));
    (ok as any).__primary = true;
  } else {
    mk(o.cancelText || "取消", false, false, () => finish(spec.kind === "prompt" ? null : false));
    const ok = mk(o.confirmText || (spec.kind === "confirm" && o.danger ? "确认执行" : "确定"), true, !!(spec.kind === "confirm" && o.danger), () =>
      finish(spec.kind === "prompt" ? (input && o.required && !input.value.trim() ? undefined : input!.value) : true));
    (ok as any).__primary = true;
  }
  panel.appendChild(foot);

  // 键盘：Esc=取消；Enter=确认（焦点在非按钮元素时）
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); finish(spec.kind === "prompt" ? null : spec.kind === "confirm" ? false : undefined); }
    else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      (foot.querySelector("button") ? Array.from(foot.querySelectorAll("button")).at(-1) : null)?.click();
    }
  });
  return input;
}

/** 渲染一个弹窗实例；done 由队列在 resolve 后回调（放下一拍，让 DOM 先离场） */
function showDialog(spec: PendingSpec, done: () => void) {
  const { overlay, panel } = mount();
  const prevFocus = document.activeElement as HTMLElement | null;
  let settled = false;
  const finish = (v: unknown) => {
    if (settled) return;
    settled = true;
    spec.resolve(v);
    try { overlay.remove(); } catch {}
    try { prevFocus && typeof prevFocus.focus === "function" && prevFocus.focus(); } catch {}
    setTimeout(done, 0);
  };
  const input = buildBody(panel, spec, finish);
  // 初始焦点：prompt → 输入框（全选）；confirm/alert → 主按钮
  setTimeout(() => {
    try {
      if (input) { input.focus(); input.select(); }
      else {
        const btns = panel.querySelectorAll("button");
        (btns.length ? btns[btns.length - 1] : panel).focus();
      }
    } catch {}
  }, 0);
}

// ---------- 公开 API ----------

/** 确认框（替代 window.confirm）：确定 → true，取消/Esc → false */
export function uiConfirm(opts: UiConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return enqueue<boolean>("confirm", o);
}

/** 提示框（替代 window.alert）：确定/Esc 关闭 */
export function uiAlert(opts: UiAlertOptions | string): Promise<void> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return enqueue<void>("alert", o);
}

/** 输入框（替代 window.prompt）：确定 → 字符串（可能空串），取消/Esc → null */
export function uiPrompt(opts: UiPromptOptions | string): Promise<string | null> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return enqueue<string | null>("prompt", o);
}
