/**
 * In-page dialog shared module (replaces the browser-native alert/confirm/prompt).
 *
 * Background: native window.confirm/alert/prompt are the browser's default dialogs — they block the
 * main thread, their style is disconnected from the app, and they behave inconsistently in some
 * embedded environments (webview/headless). This module provides Promise-style replacements:
 *
 *   const ok = await uiConfirm({ message: "Delete group X?", danger: true });
 *   await uiAlert("Plan created");                       // string shortcut
 *   await uiAlert({ message: "Save failed", kind: "error" });
 *   const name = await uiPrompt({ message: "Enter a name:", value: "Draft" });  // cancel → null
 *
 * Implementation: zero-dependency pure DOM (works for both React extensions and native h()
 * extensions; await directly inside event handlers).
 * Contract (see docs/aiti-web-ext-float-dialogs.md):
 *   - data-ext-float="1"          → aiti-float takes over drag/raise/persistence; falls back to a
 *                                    flex-centered overlay when not installed
 *   - data-ext-float-full="1"     → small screens (≤640px) auto-fill the viewport (physical fit)
 *   - data-ext-float-keepmask="1" → true modal: mask stays, outside clicks don't close (the side
 *                                    effect is the intent)
 *   - data-ext-float-max="0"      → exempt from maximize-button injection (small confirm boxes
 *                                    don't need it)
 *   - data-ext-float-persist="0"  → no position persistence (one-shot dialogs don't pollute
 *                                    persistence slots)
 * Only one dialog shows at a time (internal Promise-chain queue), so they never stack.
 *
 * Layering: mount prefers <dialog>.showModal() — the browser top layer beats any
 * self-managed huge z-index an extension panel may set (e.g. model wizard 2147483101 /
 * extman 2147483645 used to bury the confirm dialog, so it only showed up after closing
 * the panel). Environments without showModal (legacy browsers / DOM stubs) fall back to a
 * top-level body div with Z_BASE=2147483600 (same tier as session-manager confirm-dialog).
 */

export type UiDialogKind = "info" | "success" | "error" | "warn";

export interface UiConfirmOptions {
  title?: string;
  message?: string;
  /** Optional monospace code block (e.g. the command text about to run) */
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** Danger confirm: ⚠ icon + red confirm button */
  danger?: boolean;
}

export interface UiAlertOptions {
  title?: string;
  message?: string;
  detail?: string;
  kind?: UiDialogKind;
  confirmText?: string;
}

export interface UiChoiceItem {
  /** Resolved value for this button ("cancel" is normally null/default). */
  id: string;
  label: string;
  /** Visual weight: primary = accent fill, danger = red fill, default = plain. */
  tone?: "primary" | "danger" | "default";
}

export interface UiChoiceOptions {
  title?: string;
  message?: string;
  detail?: string;
  /** Buttons in display order (right-aligned). */
  choices: UiChoiceItem[];
  /** Esc / backdrop behaviour: resolved value for the "cancel" path (default null). */
  cancelId?: string | null;
}

export interface UiPromptOptions {
  title?: string;
  message?: string;
  value?: string;
  placeholder?: string;
  /** Disable the OK button when the input is empty (default false: empty-string confirm allowed) */
  required?: boolean;
}

/** Fallback stacking tier (top-level body div when showModal is unavailable): must sit above
 * the huge z-indices extension panels manage themselves (model wizard 2147483101 / schedule
 * 2147483300 / menus 2147483500 / dock + session menus 2147483600) — same tier as the
 * session-manager confirm dialog. With showModal the tier is irrelevant (top layer wins). */
const Z_BASE = 2147483600;

/** Common CSS variable fallbacks (the host is always a pi-web themed page; fallbacks are purely defensive) */
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
  error: "var(--danger, #ef4444)",
  warn: "var(--warn, #f59e0b)",
};

/** Linear stroke icon (24 viewBox), follows the color */
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
  kind: "confirm" | "alert" | "prompt" | "choice";
  opts: any;
  resolve: (v: unknown) => void;
}

/** Dialog queue: only one visible at a time (first come first shown, the rest queue) */
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
    // Extreme defense: when the DOM is unavailable, settle as canceled so the queue never wedges
    next.resolve(next.kind === "prompt" ? null : next.kind === "confirm" ? false : undefined);
    showing = false;
    drain();
  }
}

/* Modal-hosting capability probe (once per mount; stubs / legacy browsers → false → z-index fallback) */
function canUseTopLayer(): boolean {
  try {
    const probe = document.createElement("dialog") as any;
    return !!probe && typeof probe.showModal === "function";
  } catch { return false; }
}

/** The modal host draws its own rgba mask; the UA `::backdrop` would darken the page twice
 * (0.45 + ~0.1) and drift from the pre-top-layer look. One idempotent rule, injected once. */
const BACKDROP_STYLE_ID = "ui-dialogs-backdrop";
function ensureBackdropStyle(): void {
  try {
    if (document.getElementById(BACKDROP_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = BACKDROP_STYLE_ID;
    st.textContent = "[data-ui-dialog-overlay]::backdrop{background:transparent;}";
    (document.head || document.body).appendChild(st);
  } catch { /* headless / stub: the mask alone still reads fine */ }
}

/** Top-level mount: document.body level, independent of any extension panel DOM.
 * With <dialog> → showModal() enters the browser top layer (above every z-index, so a dialog
 * opened from an ultra-high-z panel stays visible); otherwise a div + Z_BASE fallback. */
function mount(): { overlay: HTMLDivElement; panel: HTMLDivElement } {
  const modal = canUseTopLayer();
  const overlay = document.createElement(modal ? "dialog" : "div") as HTMLDivElement;
  overlay.setAttribute("data-ui-dialog-overlay", "1");
  // dialog UA defaults (border/padding/margin/max-width, width/height fit-content) must be reset —
  // inset:0 + width/height auto is what makes the overlay fill the viewport; display:flex serves the fallback path
  overlay.style.cssText =
    "position:fixed;inset:0;margin:0;border:0;padding:20px;width:auto;height:auto;max-width:none;max-height:none;" +
    "background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:" + Z_BASE + ";";
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
  if (modal) {
    ensureBackdropStyle();
    try {
      (overlay as any).showModal();   // top layer: above any in-page z-index
    } catch {
      /* already in a modal stack / headless: keep the plain-block semantics (display:flex + Z_BASE) */
    }
  }
  return { overlay, panel };
}

function buildBody(panel: HTMLDivElement, spec: PendingSpec, finish: (v: unknown) => void): HTMLInputElement | null {
  const o = spec.opts || {};
  const kind: UiDialogKind = spec.kind === "confirm"
    ? "info"
    : ((o.kind === "success" || o.kind === "error" || o.kind === "warn" || o.kind === "info" ? o.kind : "info") as UiDialogKind);
  const color = spec.kind === "confirm" && o.danger ? KIND_COLOR.error : KIND_COLOR[kind];
  const iconKind: "warn" | UiDialogKind = spec.kind === "confirm" && o.danger ? "warn" : kind;

  // Title bar (aiti-float treats the first child element as the drag handle)
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:10px;padding:14px 18px 0;";
  const icon = iconSvg(iconKind, color);
  icon.style.width = "20px";
  icon.style.height = "20px";
  head.appendChild(icon);
  const titleEl = document.createElement("div");
  titleEl.style.cssText = "flex:1;min-width:0;font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  titleEl.textContent = o.title || (spec.kind === "confirm" ? (o.danger ? "Confirm dangerous operation" : "Confirm") : spec.kind === "prompt" ? "Input" : spec.kind === "choice" ? "Choose" : "Notice");
  head.appendChild(titleEl);
  panel.appendChild(head);

  // Body
  if (o.message) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:12px 18px 0;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:" + V.text + ";";
    msg.textContent = String(o.message);
    panel.appendChild(msg);
  }
  // Monospace detail block (commands etc.)
  if (o.detail) {
    const det = document.createElement("pre");
    det.style.cssText =
      "margin:10px 18px 0;padding:10px 12px;border-radius:8px;background:" + V.hover + ";border:1px solid " + V.border +
      ";font-family:" + V.mono + ";font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;color:" + V.text + ";";
    det.textContent = String(o.detail);
    panel.appendChild(det);
  }
  // prompt input
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

  // Footer
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
  if (spec.kind === "choice") {
    const items: UiChoiceItem[] = Array.isArray(o.choices) ? o.choices : [];
    for (const item of items) {
      mk(item.label || item.id, item.tone === "primary", item.tone === "danger", () => finish(item.id));
    }
    if (items.length === 0) finish(o.cancelId ?? null);
  } else if (spec.kind === "alert") {
    const ok = mk(o.confirmText || "OK", true, false, () => finish(undefined));
    (ok as any).__primary = true;
  } else {
    mk(o.cancelText || "Cancel", false, false, () => finish(spec.kind === "prompt" ? null : spec.kind === "choice" ? (o.cancelId ?? null) : false));
    const ok = mk(o.confirmText || (spec.kind === "confirm" && o.danger ? "Confirm" : "OK"), true, !!(spec.kind === "confirm" && o.danger), () =>
      finish(spec.kind === "prompt" ? (input && o.required && !input.value.trim() ? undefined : input!.value) : true));
    (ok as any).__primary = true;
  }
  panel.appendChild(foot);

  // Keyboard: Esc=cancel; Enter=confirm (when focus is on a non-button element)
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); finish(spec.kind === "prompt" || spec.kind === "choice" ? null : spec.kind === "confirm" ? false : undefined); }
    else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      (foot.querySelector("button") ? Array.from(foot.querySelectorAll("button")).at(-1) : null)?.click();
    }
  });
  return input;
}

/** Render one dialog instance; done is called back by the queue after resolve (deferred one tick so the DOM leaves first) */
function showDialog(spec: PendingSpec, done: () => void) {
  const { overlay, panel } = mount();
  const prevFocus = document.activeElement as HTMLElement | null;
  let settled = false;
  const finish = (v: unknown) => {
    if (settled) return;
    settled = true;
    spec.resolve(v);
    try { (overlay as any).close?.(); } catch {}   // leave the top layer (div fallback has no close)
    try { overlay.remove(); } catch {}
    try { prevFocus && typeof prevFocus.focus === "function" && prevFocus.focus(); } catch {}
    setTimeout(done, 0);
  };
  // Native Esc (modal dialog "cancel"): intercept the browser close and route through finish
  try {
    (overlay as any).addEventListener?.("cancel", (e: any) => {
      try { e?.preventDefault?.(); } catch {}
      finish(spec.kind === "prompt" || spec.kind === "choice" ? null : spec.kind === "confirm" ? false : undefined);
    });
  } catch { /* no event system in DOM stubs */ }
  const input = buildBody(panel, spec, finish);
  // Initial focus: prompt → input (select-all); confirm/alert → primary button
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

// ---------- Public API ----------

/** Confirm dialog (replaces window.confirm): OK → true, cancel/Esc → false */
export function uiConfirm(opts: UiConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return enqueue<boolean>("confirm", o);
}

/** Alert dialog (replaces window.alert): OK/Esc closes */
export function uiAlert(opts: UiAlertOptions | string): Promise<void> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return enqueue<void>("alert", o);
}

/** Input dialog (replaces window.prompt): OK → string (possibly empty), cancel/Esc → null */
export function uiPrompt(opts: UiPromptOptions | string): Promise<string | null> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  return enqueue<string | null>("prompt", o);
}

/**
 * Multi-choice dialog (three-way decisions such as mask / send as-is / cancel).
 * Clicking an item resolves its id; Esc or the mask resolves `cancelId` (default
 * null). One dialog at a time (queued internally).
 */
export function uiChoice(opts: UiChoiceOptions): Promise<string | null> {
  return enqueue<string | null>("choice", opts);
}
