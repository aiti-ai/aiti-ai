/**
 * aiti-extman · 模块级状态 + 数据操作 + 宿主定位逻辑（自手写版迁移，逻辑一比一）。
 *
 * 渲染层在 extman-ui.tsx；本模块只管状态机/网络操作/DOM 定位辅助。
 * 宿主能力（t/apiUrl）经 host-shim 委托；reloadExtensions/extLoaderState 由 entry.tsx 注入。
 */
import { t, apiUrl } from "./host-shim";
import { EXT_DISPLAY_NAMES } from "../../../_shared/ext-display-names";
import { openFloat, closePanel } from "../../../_shared/ext-float-dock";
// extman-ui.tsx 从本模块取展示名（保持旧 import 面不变）
export { extDisplayName } from "../../../_shared/ext-display-names";

// ---------- 模块级状态（跨组件共享；listener 模式） ----------
export const state = {
  open: false,
  status: null as any,        // /status 载荷 { extensions: {id: entry}, extensionsRoot, ... }
  loader: { materialized: [] as string[], prefetched: [] as string[] },
  selected: null as any,      // { kind: "local"|"online"|"source"|"add", id }
  hoverLocal: null as string | null, // 本地列表悬停行 id（悬停显示启停开关）
  q: "",                      // 搜索词（空 = 只显示本地）
  busyKey: null as string | null, // `${action}:${id}` | "*"
  applying: null as string | null, // 操作进行中的全局反馈文案（如「正在应用变更…」，完成/失败后清除）
  error: null as string | null,
  message: null as string | null,
  registryData: null as any,  // aiti.pw /extensions.json
  registryError: null as string | null,
  registryLoaded: false,
  isMobile: false,
  // VSCode 式 trust：待确认的发行者（{kind:"source"|"zip", source, docsUrl?, id?, publisher, file?, zipName?}）
  pendingTrust: null as any,
  // 已信任发行者列表 [{name,url,source,trustedAt}]（管理 UI + 信任状态展示）
  trustedPublishers: [] as any[],
  trustedLoaded: false,
  // 功能打开提示（打开/定位结果；自动消失）
  openHint: null as any,
  // 小屏面板行为：listCollapsed=扩展列表折叠（给详情区让空间）；maximized=全屏展开（小屏打开默认开）。
  // mobileView：小屏导航视图——list=列表，detail=详情（点击扩展时切换，带返回按钮）
  listCollapsed: false,
  maximized: false,
  mobileView: "list" as "list" | "detail",
  // 层级管理：打开其他弹窗后把自己降到后面（新弹窗置前），zBack=true 时面板 z-index 降到 300；可手动置顶恢复
  zBack: false,
  // 虚空创建：插槽条目已注册但未渲染到宿主（如被 feature 隐藏）时，「打开」离屏挂载其组件并触发 click。
  // { render, key }；由 UI 层的 VirtualClick 消费，触发完成后置回 null。
  virtualClick: null as any,
  // 依赖影响确认：禁用/卸载仍被已启用扩展声明依赖（clientDependsOn / 硬依赖边）时，
  // 待确认数据 { action: "disable"|"remove", id, clientDeps: string[], hardDeps: Array<{id, via?}> }
  // 由 UI 层的 DependentsDialog 消费。
  pendingDependents: null as any,
  // 依赖与能力模型视图：exts=扩展列表（现状）|caps=能力视图|conflicts=冲突/版本管理
  view: "exts" as "exts" | "caps" | "conflicts",
  // 能力视图选中项（能力名）；冲突视图选中项（"multi:<id>" | "takeover:<cap>"）
  selCap: null as string | null,
  selConflict: null as string | null,
};

/**
 * 依赖边表（依赖与能力模型）：扫全量 status 构建 { from, to, kind, cap? } 边集。
 * kind：client=clientDependsOn 预取边；hard-ext/optional-ext=功能级依赖 id 命中；
 * hard-cap/optional-cap=能力名解析后的边（to=生效提供者；cap=能力名；missing 边 to=null）。
 * status 未就绪或旧宿主（无 depsResolved 字段）自动降级为仅 client 边。
 */
export type DepEdge = { from: string; to: string | null; kind: "client" | "hard-ext" | "hard-cap" | "optional-ext" | "optional-cap"; cap?: string };

export function depEdges(): DepEdge[] {
  const exts = state.status && state.status.extensions || {};
  const edges: DepEdge[] = [];
  for (const id of Object.keys(exts)) {
    const e = exts[id];
    for (const dep of (Array.isArray(e.clientDependsOn) ? e.clientDependsOn : []) as string[]) {
      edges.push({ from: id, to: dep, kind: "client" });
    }
    for (const d of (Array.isArray(e.depsResolved) ? e.depsResolved : []) as any[]) {
      if (d.kind === "ext") {
        edges.push({ from: id, to: d.target, kind: d.hard ? "hard-ext" : "optional-ext" });
      } else {
        edges.push({ from: id, to: d.target ?? null, kind: d.hard ? "hard-cap" : "optional-cap", cap: d.name });
      }
    }
  }
  return edges;
}

/** 硬依赖者（警告口径）：id 直连 + 能力解析（含生效提供者链）两类 hard 边，启用中的依赖者。 */
export function hardDependents(id: string): Array<{ id: string; via?: string }> {
  const out = new Map<string, { id: string; via?: string }>();
  for (const e of depEdges()) {
    if (e.to !== id || (e.kind !== "hard-ext" && e.kind !== "hard-cap")) continue;
    const prev = out.get(e.from);
    out.set(e.from, { id: e.from, via: e.kind === "hard-cap" ? e.cap : prev && prev.via });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** client 注入依赖者（现状警告口径，启用中）。 */
export function clientDependents(id: string): string[] {
  return depEdges().filter((e) => e.to === id && e.kind === "client").map((e) => e.from).sort();
}

/**
 * 反向依赖：「谁依赖我」——默认警告口径（client + 硬依赖边，不含 optional；启用中）。
 * opts.includeDisabled=true 含禁用者；opts.allKinds=true 全边类型（详情「被依赖」视图，
 * optional/client 都含，禁用者灰显）。status 未就绪时兜底返回 []。
 */
export function dependentsOf(id: string, opts?: { includeDisabled?: boolean; allKinds?: boolean }): string[] {
  const exts = state.status && state.status.extensions || {};
  return depEdges().filter((e) => {
    if (e.to !== id || e.from === id) return false;
    if (!opts?.allKinds && e.kind.startsWith("optional")) return false; // 可选边永不警告
    if (!opts?.includeDisabled && exts[e.from] && exts[e.from].enabled === false) return false;
    return true;
  }).map((e) => e.from).filter((v, i, arr) => arr.indexOf(v) === i).sort();
}
const listeners = new Set<() => void>();
function notify() { for (const l of listeners) l(); }
// aiti-float dock v3（P1 批）：面板显隐收口展示状态机——patch.open 路由到 openFloat/closePanel，
// state.open 不再是渲染开关（extman-ui 渲染门控走 useGate）；其余字段照旧合并。
export const EXTMAN_KEY = "aiti-extman:panel";
export function setState(patch: Partial<typeof state>) {
  if ("open" in patch) {
    const { open, ...rest } = patch;
    if (open) openFloat(EXTMAN_KEY); else closePanel(EXTMAN_KEY);
    patch = rest as Partial<typeof state>;
    if (Object.keys(patch).length === 0) return;
  }
  Object.assign(state, patch);
  notify();
}
/** 组件订阅模块状态变化（force update）。返回退订函数。 */
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

// register 时注入的宿主能力（entry.tsx 调 setHostCaps）。
let ctxReload: ((opts?: { resyncOnly?: boolean }) => unknown) | null = null;
let ctxLoaderState: (() => typeof state.loader) | null = null;
let ctxFull: any = null; // DI 方案 P2：完整 ctx（getExtService 用）
export function setHostCaps(caps: { reloadExtensions?: unknown; extLoaderState?: unknown; ctx?: any }) {
  ctxReload = typeof caps.reloadExtensions === "function" ? (caps.reloadExtensions as (opts?: { resyncOnly?: boolean }) => unknown) : null;
  ctxLoaderState = typeof caps.extLoaderState === "function" ? (caps.extLoaderState as () => typeof state.loader) : null;
  ctxFull = caps?.ctx ?? ctxFull;
}

// 当前会话（dialogs 插槽经 ExtRenderProps.currentSession 传入，渲染时顺手记下；context 插槽打开时的上下文）
export let currentSessionVal: any = null;
export function setCurrentSession(s: any) { currentSessionVal = s; }

// 自我保护：管理器不允许禁用/卸载自己（服务端 ops 同样拒绝）。
export const SELF_ID = "aiti-extman";

export const AITI_DOCS_BASE = "https://aiti.pw";
export const AITI_REGISTRY_PAGE = AITI_DOCS_BASE + "/extensions/";

export const SOURCE_LABELS: Record<string, string> = { user: "user", extra: "extra", dev: "dev", bundled: "bundled" };
export const SOURCE_COLORS: Record<string, string> = {
  user: "rgba(99,102,241,0.85)",
  extra: "rgba(14,165,233,0.85)",
  dev: "rgba(217,119,6,0.85)",
  bundled: "rgba(120,120,120,0.9)",
};

export const btnStyle: Record<string, unknown> = {
  padding: "5px 12px", background: "var(--bg-hover)", border: "1px solid var(--border)",
  borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
};
export const chipStyle = (color: string, bg: string) => ({
  fontSize: 10, padding: "1px 6px", borderRadius: 8, background: bg, color, whiteSpace: "nowrap", flexShrink: 0,
});

export function shortenPath(p: unknown) { return String(p ?? "").replace(/^\/(?:Users|home)\/[^/]+/, "~"); }

export function statusDotColor(e: any) {
  if (e.error) return "var(--danger, #ef4444)";
  if (e.enabled === false) return "var(--text-dim)";
  if (!e.loaded) return "var(--warn, #f59e0b)";
  return "var(--accent)";
}

/** 状态点悬浮提示（与 statusDotColor 对应）。 */
export function statusDotTitle(e: any) {
  if (e.error) return "状态：异常";
  if (e.enabled === false) return "状态：已停用";
  if (!e.loaded) return "状态：未加载";
  return "状态：运行中";
}

/** 搜索词是否像一个安装来源（git: / npm: / https git / git@ / 本地路径 / @scope/pkg）。 */
export function looksLikeSource(q: string) {
  const s = q.trim();
  if (!s) return false;
  if (/^(git:|npm:|https?:\/\/|git@)/i.test(s)) return true;
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^@[A-Za-z0-9-][\w.-]*\//.test(s)) return true; // @scope/pkg
  return false;
}

/** 发行者是否已信任（有名按 name，未知按 fingerprint）。 */
export function publisherTrusted(pub: any) {
  if (!pub) return false;
  const k = (pub.name && pub.name.trim()) || pub.fingerprint;
  return (state.trustedPublishers || []).some((x) => ((x.name && x.name.trim()) || x.fingerprint) === k);
}

export async function refreshTrusted() {
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-extman/publishers"), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    setState({ trustedPublishers: d.trusted || [], trustedLoaded: true });
  } catch {
    setState({ trustedPublishers: state.trustedPublishers || [], trustedLoaded: true });
  }
}

/** 发行者来源中文标签。 */
export function publisherSourceLabel(src?: string) {
  const map: Record<string, string> = { npm: "npm", github: "GitHub", gitlab: "GitLab", git: "git", "package.json": "package.json", registry: "registry", manual: "manual", unknown: "?" };
  return map[src || ""] || src || "package.json";
}

/** 显示一条自动消失的提示（功能打开结果 / 上下文提示）。 */
export function showOpenHint(text: string, ms?: number) {
  setState({ openHint: { text, at: Date.now() } });
  setTimeout(() => {
    // 只清掉自己那条（并发提示不互相误删）
    if (state.openHint && state.openHint.text === text) setState({ openHint: null });
  }, ms || 2600);
}

/** 按 label/title/文本找页面上可点击元素（通用 fallback 触发；contains 宽松匹配）。 */
export function findButtonByLabel(label: string, { contains = false } = {}): HTMLElement | null {
  if (!label) return null;
  const norm = String(label).trim();
  const normL = norm.toLowerCase();
  const nodes = [...document.querySelectorAll<HTMLElement>("button, [role=button], [data-topbar-id]")];
  const exact = nodes.find((b) =>
    (b.getAttribute("title") || "") === norm ||
    (b.getAttribute("aria-label") || "") === norm ||
    (b.textContent || "").trim() === norm ||
    (b.getAttribute("data-topbar-id") || "").split(":").pop() === norm,
  );
  if (exact) return exact;
  if (!contains) return null;
  return nodes.find((b) =>
    ((b.getAttribute("title") || "") + " " + (b.getAttribute("aria-label") || "") + " " +
      (b.textContent || "") + " " + (b.getAttribute("data-topbar-id") || ""))
      .toLowerCase().includes(normL),
  ) || null;
}

/** 点击宿主顶栏条目（data-topbar-id 容器或其内 button）。 */
function clickTopbarEntry(el: HTMLElement) {
  const btn = el.matches("button") ? el : (el.querySelector("button") as HTMLElement || el);
  btn.click();
}

/** data-topbar-id 容器里是否有真实可点的控件（组件渲染 null 时容器仍在但为空）。 */
function entryClickable(el: HTMLElement): boolean {
  return !!(el.matches("button") || el.querySelector("button, [role='button']"));
}

/** 读宿主客户端注册表（window.__piWebExtUI）某扩展在某插槽的注册条目（含 meta.label/title，比 manifest 声明准确）。 */
export function regItemsOf(slot: string, extId: string): any[] {
  const store = typeof window !== "undefined" ? (window as any).__piWebExtUI : undefined;
  const items = (store && store.items && store.items[slot]) || [];
  return items.filter((it: any) => it.extId === extId || (typeof it.id === "string" && it.id.indexOf(extId + ":") === 0));
}

export function topbarRegs(extId: string) {
  return [...regItemsOf("toolbar", extId), ...regItemsOf("sessionTopbar", extId)];
}

/** 在元素上打短暂高亮并滚动到可见（定位"打开"结果的视觉反馈）。 */
export function flashElement(el: Element | null) {
  if (!el || typeof el.getBoundingClientRect !== "function") return;
  const h = el as HTMLElement;
  const prev = {
    outline: h.style.outline, outlineOffset: h.style.outlineOffset,
    boxShadow: h.style.boxShadow, transition: h.style.transition,
  };
  h.style.transition = "outline 0.15s, box-shadow 0.15s";
  h.style.outline = "2px solid rgba(217,119,6,0.9)";
  h.style.outlineOffset = "2px";
  h.style.boxShadow = "0 0 0 4px rgba(217,119,6,0.25)";
  try { h.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch {}
  setTimeout(() => {
    h.style.outline = prev.outline;
    h.style.outlineOffset = prev.outlineOffset;
    h.style.boxShadow = prev.boxShadow;
    h.style.transition = prev.transition;
  }, 2200);
}

/** 会话级插槽的常驻 UI 定位元素（chatInputTop→输入区；sessionRowActions→当前会话行）。 */
export function locateContextElement(slot: string, currentSession: any): HTMLElement | null {
  if (slot === "chatInputTop") {
    const input = document.querySelector("[data-chat-input]");
    if (input) return (input.closest("div") as HTMLElement) || (input as HTMLElement);
    return null;
  }
  if (slot === "sessionRowActions") {
    if (!currentSession || !currentSession.cwd) return null;
    const cwd = currentSession.cwd;
    const short = cwd.replace(/^\/home\/[^/]+/, "~");
    const base = cwd.split("/").pop();
    const cands = [...document.querySelectorAll("div")].filter((d) => {
      const x = (d.textContent || "").replace(/\s+/g, " ");
      if (x.indexOf(cwd) === -1 && x.indexOf(short) === -1 && !(base && x.indexOf(base) !== -1)) return false;
      if (d.querySelectorAll("button").length === 0) return false;
      const r = d.getBoundingClientRect();
      return r.width > 30 && r.width < 420 && r.height > 10 && r.height < 200;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return cands[0];
  }
  return null;
}

/** 常驻插槽（pages/banners）的宿主渲染容器定位。 */
export function locateSlotHost(slot: string): Element | null {
  if (slot === "banners") {
    const b = document.querySelector("[class*='banner'], [class*='Banner']");
    return b || null;
  }
  if (slot === "pages") {
    const main = document.querySelector("main, [class*='main'], [class*='Main']");
    return main || document.body;
  }
  return null;
}

/** 打开 ⋯ 溢出菜单并点扩展注册条目；命中调 onHit、失败调 onMiss（异步 120ms 后执行）。 */
function openTopbarOverflow(regs: any[], label: string, where: string, onHit: () => void, onMiss: () => void) {
  const more = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "更多" || b.getAttribute("title") === "更多",
  );
  if (!more) { onMiss(); return; }
  const wasOpen = !!document.querySelector("[data-topbar-dropdown]");
  if (!wasOpen) more.click();
  setTimeout(() => {
    const menu = document.querySelector("[data-topbar-dropdown]");
    if (!menu) { if (!wasOpen) more.click(); onMiss(); return; }
    const keys = [label];
    for (const r of regs) {
      if (r && r.meta) {
        if (r.meta.title) keys.push(String(r.meta.title));
        if (r.meta.label) keys.push(String(r.meta.label));
      }
      if (r && r.id) keys.push(String(r.id).split(":").pop()!);
    }
    const hit = [...menu.querySelectorAll("[role=menuitem]")].find((mi) => {
      const btn = mi.querySelector("button");
      const hay = ((btn && (btn.getAttribute("title") || btn.getAttribute("aria-label") || "")) || "") +
        " " + (mi.textContent || "").replace(/\s+/g, " ");
      return keys.some((k) => k && hay.indexOf(k) !== -1);
    });
    const btn = hit && (hit.querySelector("button") || hit);
    if (btn) { (btn as HTMLElement).click(); onHit(); return; }
    if (!wasOpen) more.click();
    onMiss();
  }, 120);
}

/** 打开其他弹窗后把自己降到后面（新弹窗置前；面板头部「置于顶层」可恢复）。 */
export function dropToBack() {
  if (!state.zBack) setState({ zBack: true });
}

/** 触发扩展顶栏入口：精确 data-topbar-id → 注册项同后缀优先 → 目标在 ⋯ 溢出则异步开菜单点它。
 *  所有路径自带反馈提示；返回是否已触发（溢出异步发起也视为触发）。 */
function openTopbarEntry(extId: string, item: any, label: string, where: string) {
  let el = document.querySelector<HTMLElement>('[data-topbar-id="' + (extId + ":" + item.id) + '"]');
  if (el && entryClickable(el)) { clickTopbarEntry(el); showOpenHint(t("ext.slotOpened", { label })); dropToBack(); return true; }
  const regs = topbarRegs(extId);
  const want = item && item.id;
  // 优先注册 id 与声明 id 同后缀的项（声明↔注册可能不一致，同后缀才最可能是目标）
  const preferred = want ? regs.find((r) => String(r.id).split(":").pop() === want) : null;
  const target = preferred || regs[0];
  if (target) {
    el = document.querySelector<HTMLElement>('[data-topbar-id="' + target.id + '"]');
    // 注意：容器 div 可能存在但内部组件渲染了 null（如被 feature 隐藏）——entryClickable
    // 检出无真实可点控件时不能当成功，应落到虚空创建
    if (el && entryClickable(el)) { clickTopbarEntry(el); showOpenHint(t("ext.slotOpened", { label })); dropToBack(); return true; }
    // 虚空创建：条目已注册但未渲染到顶栏（如被 feature 门控）→ 离屏挂载其组件并自动触发
    // 原点击行为；严格优于溢出菜单猜测（组件不在 DOM 时菜单里必然也没有）。另传
    // virtual:true 约定：组件若有自身显隐逻辑可据此放行渲染真实控件
    if (target.render && typeof target.render === "function") {
      setState({ virtualClick: { render: target.render, key: Date.now() } });
      showOpenHint(t("ext.slotOpened", { label }));
      dropToBack();
      return true;
    }
    // 目标在 ⋯ 溢出：异步开菜单点它
    openTopbarOverflow([target], label, where,
      () => { showOpenHint(t("ext.slotOpened", { label })); dropToBack(); },
      () => showOpenHint(t("ext.slotNoDirect", { where })),
    );
    return true;
  }
  return false;
}

/** 直接打开扩展插槽条目（不依赖按钮可见性）：
 *  1) 注册条目自带的 meta.open（扩展显式自注册，最可靠）
 *  2) services 约定 <extId>.open（DI 方案 P2：getExtService("<extId>.open")，model-check / model-wizard / ai-schedule / git-review 等已注册）
 *  3) 全局约定 window.__<extIdCamel>Open（旧通道兜底，生产旧 core 过渡期）
 *  命中并调用成功返回 true。 */
function tryDirectOpen(extId: string, slot: string, item: any) {
  if (!extId || !item) return false;
  const want = item.id;
  // 1) 该插槽注册条目自带的 meta.open
  const regs = regItemsOf(slot, extId);
  const hit = want ? regs.find((r) => String(r.id).split(":").pop() === want) : regs[0];
  if (hit && hit.meta && typeof hit.meta.open === "function") {
    try { hit.meta.open(); return true; } catch {}
  }
  // 2) services 约定 <extId>.open（DI 方案 P2）
  const svcOpen = ctxFull?.getExtService?.(extId + ".open");
  if (typeof svcOpen === "function") {
    try { svcOpen(); return true; } catch {}
  }
  // 3) 全局约定 __<extIdCamel>Open（旧通道兜底）
  const camel = String(extId).replace(/-([a-z0-9])/g, (_, c: string) => String(c).toUpperCase());
  const g = typeof window !== "undefined" ? (window as any)["__" + camel + "Open"] : undefined;
  if (typeof g === "function") {
    try { g(); return true; } catch {}
  }
  return false;
}

/** 打开扩展的某个插槽功能：global 直接触发；context 以当前会话为上下文定位（滚动+高亮）。
 *  [懒加载 v2 §4.8] 目标扩展未物化（懒加载）→ 先经 ensureMaterialized 按需物化再走打开链路：
 *  物化前其注册条目 / services / 全局通道全部缺席，直接走旧链路只会落「定位不到」死胡同。
 *  旧宿主（无 ensureMaterialized）原样降级。 */
export function openSlotItem(extId: string, slot: string, item: any, currentSession: any) {
  const label = (item && (item.label || item.title || item.id)) || "";
  const where = (item && item.where) || slot;
  const loader = ctxFull?.extLoaderState?.();
  if (extId && loader && !loader.materialized.includes(extId)) {
    void Promise.resolve(ctxFull?.ensureMaterialized?.(extId))
      .catch(() => {})
      .then(() => { openSlotItemNow(extId, slot, item, currentSession); });
    return;
  }
  openSlotItemNow(extId, slot, item, currentSession);
}

function openSlotItemNow(extId: string, slot: string, item: any, currentSession: any) {
  const label = (item && (item.label || item.title || item.id)) || "";
  const where = (item && item.where) || slot;

  // 会话级插槽（chatInputTop / sessionRowActions 等）：无开关，是当前会话内的常驻 UI。
  // 打开 = 以当前会话为上下文，定位到功能实际位置（滚动 + 高亮），不再是死胡同提示。
  if (item && item.context === "context") {
    if (!currentSession) {
      showOpenHint(t("ext.slotNeedSession", { where }) + "：" + label);
      return;
    }
    const el = locateContextElement(slot, currentSession);
    if (el) {
      flashElement(el);
      showOpenHint(t("ext.slotLocated", { where }) + "：" + label);
    } else {
      showOpenHint(t("ext.slotNeedSession", { where }) + "：" + label);
    }
    return;
  }

  // 直接打开优先：扩展在注册条目上自带的 meta.open / 全局约定 window.__<extId>Open
  if (tryDirectOpen(extId, slot, item)) {
    showOpenHint(t("ext.slotOpened", { label }));
    dropToBack();
    return;
  }

  // toolbar / sessionTopbar：顶栏入口（行内 data-topbar-id → 注册项 → ⋯ 溢出）。
  if (slot === "toolbar" || slot === "sessionTopbar") {
    if (openTopbarEntry(extId, item, label, where)) return;
    const btn = findButtonByLabel(label, { contains: true });
    if (btn) { btn.click(); showOpenHint(t("ext.slotOpened", { label })); dropToBack(); return; }
    // 虚空创建：条目已注册但不在 DOM（如被 feature 隐藏）→ 离屏挂载组件并自动触发其 click
    const regs2 = regItemsOf(slot, extId);
    const wantId2 = item && item.id;
    const hit = (wantId2 ? regs2.find((r: any) => String(r.id).split(":").pop() === wantId2) : null) || regs2[0];
    if (hit && typeof hit.render === "function") {
      setState({ virtualClick: { render: hit.render, key: Date.now() } });
      showOpenHint(t("ext.slotOpened", { label }));
      dropToBack();
      return;
    }
    showOpenHint(t("ext.slotNoDirect", { where }));
    return;
  }

  // dialogs：弹窗由扩展入口按钮（通常是顶栏）开关——触发该入口打开面板。
  if (slot === "dialogs") {
    if (openTopbarEntry(extId, item, label, where)) return;
    const btn = findButtonByLabel(label, { contains: true });
    if (btn) { btn.click(); showOpenHint(t("ext.slotOpened", { label })); dropToBack(); return; }
    showOpenHint(t("ext.slotNoDirect", { where }));
    return;
  }

  // sidebar / sidebarFooter / 其他 global：按 label/title 找按钮点击。
  const btn = findButtonByLabel(label, { contains: true });
  if (btn) { btn.click(); showOpenHint(t("ext.slotOpened", { label })); return; }
  if (openTopbarEntry(extId, item, label, where)) return;

  // 常驻渲染（pages/banners）或无独立入口：定位到渲染位置（滚动 + 高亮）。
  const host = locateSlotHost(slot);
  if (host) {
    flashElement(host);
    showOpenHint(t("ext.slotLocated", { where }) + "：" + label);
    return;
  }
  showOpenHint(t("ext.slotNoDirect", { where }));
}

// ---------- 数据操作 ----------
export async function refreshStatus() {
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-extman/status"), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    let sel = state.selected;
    if (!sel || sel.kind !== "local" || !d.extensions[sel.id]) {
      if (!sel || sel.kind !== "online") {
        const ids = Object.keys(d.extensions || {})
          .filter((id) => d.extensions[id].enabled !== false)
          .sort();
        sel = ids[0] || { kind: "local", id: Object.keys(d.extensions || {}).sort()[0] };
        if (sel) sel = { kind: "local", id: sel };
        else sel = null;
      }
    }
    setState({ status: d, selected: sel });
  } catch (e) {
    const errMsg = String((e as any) && (e as any).message || e);
    console.error("[aiti-extman] ❌ " + errMsg);
    setState({ error: errMsg });
  }
}

export function sortedLocalIds(status: any) {
  const exts = (status && status.extensions) || {};
  return Object.keys(exts).sort((a, b) => {
    const da = exts[a].enabled === false ? 1 : 0;
    const db = exts[b].enabled === false ? 1 : 0;
    return da - db || a.localeCompare(b);
  });
}

export async function loadRegistry() {
  if (state.registryLoaded) return;
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-extman/registry"), { cache: "no-store" });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "HTTP " + r.status);
    setState({ registryData: d, registryError: null, registryLoaded: true });
  } catch (e) {
    setState({ registryError: String((e as any) && (e as any).message || e), registryLoaded: true });
  }
}

/**
 * 操作入口（UI 层统一走这里）：disable/remove 前做依赖影响检查——
 * 存在已启用依赖者（clientDependsOn 指向它）时改弹自绘确认（pendingDependents），
 * 确认后由 DependentsDialog 直接调 execOp 绕过本检查（避免死循环）。
 */
export function runOp(action: string, extra: Record<string, unknown>) {
  if ((action === "disable" || action === "remove") && extra && typeof extra.id === "string") {
    // 警告口径（依赖与能力模型 §5.3）：client 预取边 + 硬依赖边（含能力解析链）；optional 永不警告
    const clientDeps = clientDependents(extra.id);
    const hardDeps = hardDependents(extra.id);
    if (clientDeps.length > 0 || hardDeps.length > 0) {
      setState({ pendingDependents: { action, id: extra.id, clientDeps, hardDeps } });
      return Promise.resolve();
    }
  }
  return execOp(action, extra);
}

export async function execOp(action: string, extra: Record<string, unknown>) {
  const key = action + ":" + ((extra as any) && ((extra as any).busyId || (extra as any).id || (extra as any).source) || "");
  // 立即给用户「处理中」反馈：ops（尤其 enable/disable/install）服务端要全量重载扩展，
  // 秒级耗时；banner + 开关 spinner 让用户知道点击已生效、正在后台应用。
  setState({ busyKey: key, applying: t("ext.applying"), error: null, message: null });
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-extman/ops"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = await r.json();
    if (!r.ok && !d.needsTrust) throw new Error(d.error || "HTTP " + r.status);
    // VSCode 式 trust：发行者未信任 → 弹信任确认（不视为错误），确认后带 trust:true 重发。
    if (d.needsTrust) {
      setState({
        pendingTrust: {
          kind: "source",
          source: d.source || extra.source,
          docsUrl: d.docsUrl || extra.docsUrl,
          id: d.id,
          publisher: d.publisher,
          publisherHint: (extra as any).publisherHint,
          zipName: d.zipName,
        },
        busyKey: null, applying: null, error: null, message: null,
      });
      return;
    }
    if (d.error) throw new Error(d.error);
    // 响应带全量状态则直接采用（enable/disable 旧响应不带时退回主动拉取）。
    if (d.extensions) {
      let sel = state.selected;
      if (action === "install" && d.id) sel = { kind: "local", id: d.id };
      else if ((action === "remove" || action === "enable" || action === "disable") && d.id) sel = { kind: "local", id: d.id };
      if (!sel || (sel.kind === "local" && !d.extensions[sel.id])) {
        const ids = Object.keys(d.extensions || {}).filter((id) => d.extensions[id].enabled !== false).sort();
        sel = ids[0] ? { kind: "local", id: ids[0] } : null;
      }
      setState({ status: d, selected: sel });
    } else {
      await refreshStatus();
    }
    // 功能管理变更 → 经统一通知管道（window CustomEvent 总线）广播，扩展客户端监听后按 detail 更新（不轮询）
    if (action === "set-feature" && d && d.id && d.featureId) {
      const detail = (d.value !== undefined && typeof d.value === "string")
        ? { extId: d.id, featureId: d.featureId, value: d.value }
        : { extId: d.id, featureId: d.featureId, enabled: d.enabled !== false };
      try { window.dispatchEvent(new CustomEvent("pi-web:ext-features-changed", { detail })); } catch {}
    }
    await syncClient();
    const msgs: Record<string, string> = {
      install: "ext.msgInstalled", remove: "ext.msgRemoved",
      enable: "ext.msgEnabled", disable: "ext.msgDisabled", reload: "ext.msgReloaded",
      "set-feature": "ext.msgFeatureSet",
      "set-pin": "ext.msgPinned", "set-dev-priority": "ext.msgPinned",
      trust: "ext.msgTrusted", untrust: "ext.msgUntrusted",
    };
    setState({ message: installProtocolHint(t(msgs[action] || "ext.msgReloaded"), action === "install" ? (d as any)?.protocolCheck : null), busyKey: null, applying: null });
    if (action === "trust" || action === "untrust" || action === "install") void refreshTrusted();
  } catch (e) {
    setState({ error: String((e as any) && (e as any).message || e), busyKey: null, applying: null });
    console.error('[aiti-extman] ❌ ' + String((e as any) && (e as any).message || e))
  }
}

async function syncClient() {
  // resyncOnly：extman 所有 ops（install/remove/enable/disable/reload）服务端都已在
  // 同一请求内完成全量重载并在响应里带了最新状态——这里只需补拉 manifest + 反卷
  // client 缓存；再 POST /reload 会重复一轮全量 shutdown→loadAll→startAll（白等数秒）。
  // 旧宿主不认参数（忽略 → 全量 reload），兼容降级只是变慢不变错。
  try { if (ctxReload) await ctxReload({ resyncOnly: true }); } catch {}
  if (ctxLoaderState) setState({ loader: ctxLoaderState() as typeof state.loader });
}

/** 打开面板时同步一次 client 加载状态（旧 register 内联逻辑）。 */
export function syncLoader() {
  if (ctxLoaderState) setState({ loader: ctxLoaderState() as typeof state.loader });
}

/** zip 上传安装：multipart POST install-zip（与 runOp 同响应处理）。trust=true 表示已确认信任发行者。 */
export async function runInstallZip(file: File, trust?: boolean) {
  setState({ busyKey: "install:zip:" + file.name, applying: t("ext.applying"), error: null, message: null });
  try {
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (trust) fd.append("trust", "1");
    const r = await fetch(apiUrl("/api/extensions/aiti-extman/install-zip"), { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok && !d.needsTrust) throw new Error(d.error || "HTTP " + r.status);
    // 发行者未信任 → 弹信任确认（保留 File 以便确认后重发）。
    if (d.needsTrust) {
      setState({
        pendingTrust: { kind: "zip", file, id: d.id, publisher: d.publisher, zipName: d.zipName },
        busyKey: null, applying: null, error: null, message: null,
      });
      return;
    }
    if (d.error) throw new Error(d.error);
    if (d.extensions) {
      let sel = state.selected;
      if (d.id) sel = { kind: "local", id: d.id };
      if (!sel || (sel.kind === "local" && !d.extensions[sel.id])) {
        const ids = Object.keys(d.extensions).filter((id) => d.extensions[id].enabled !== false).sort();
        sel = ids[0] ? { kind: "local", id: ids[0] } : null;
      }
      setState({ status: d, selected: sel });
    } else {
      await refreshStatus();
    }
    await syncClient();
    setState({ message: installProtocolHint(t("ext.msgInstalled"), (d as any)?.protocolCheck), busyKey: null, applying: null });
    void refreshTrusted();
  } catch (e) {
    setState({ error: String((e as any) && (e as any).message || e), busyKey: null, applying: null });
    console.error('[aiti-extman] ❌ ' + String((e as any) && (e as any).message || e))
  }
}

/** 安装结果附协议检查提示（docs/pi-web-ext-protocol.md；仅非 ok 时追加，纯增项不 bump 无提示）。 */
function installProtocolHint(base: string, protocolCheck: any): string {
  const pc = protocolCheck;
  if (!pc || !pc.state || pc.state === "ok") return base;
  const stateKey: Record<string, string> = {
    stale: "ext.protocolStale", incompatible: "ext.protocolIncompatible",
    missing: "ext.protocolMissing", invalid: "ext.protocolInvalid", too_new: "ext.protocolTooNew",
  };
  return pc.state === "too_new"
    ? base + " · " + t("ext.protocolInstallTooNew", { declared: pc.declared ?? "?", current: pc.current })
    : base + " · " + t("ext.protocolInstallWarn", { declared: pc.declared ?? "(legacy)", current: pc.current, state: t(stateKey[pc.state] || "ext.protocol") });
}

/** 订阅核心状态 + 界面语言变化：语言切换时也强刷（展示名/t() 文案跟随）。 */
export function subscribeAll(fn: () => void): () => void {
  const unsubState = subscribe(fn);
  const onLocale = () => fn();
  window.addEventListener("pi-web:locale-changed", onLocale);
  return () => { unsubState(); window.removeEventListener("pi-web:locale-changed", onLocale); };
}

/** 本地条目是否命中搜索（id / name / 描述字段；双语名都参与匹配）。 */
export function localMatches(id: string, e: any, q: string) {
  if (!q) return true;
  const s = q.toLowerCase();
  const names = EXT_DISPLAY_NAMES[id] ? EXT_DISPLAY_NAMES[id].en + " " + EXT_DISPLAY_NAMES[id].zh : "";
  return (id + " " + (e.name || "") + " " + names + " " + ((e.packageInfo && e.packageInfo.name) || "")).toLowerCase().includes(s);
}

/** 在线条目是否命中搜索（双语名都参与匹配）。 */
export function onlineMatches(ext: any, q: string) {
  if (!q) return false; // 空搜索只显示本地
  const s = q.toLowerCase();
  const names = EXT_DISPLAY_NAMES[ext.id] ? EXT_DISPLAY_NAMES[ext.id].en + " " + EXT_DISPLAY_NAMES[ext.id].zh : "";
  return [ext.id, ext.name, names, ext.description, ext.category, (ext.tags || []).join(" ")]
    .filter(Boolean).join(" ").toLowerCase().includes(s);
}

// ---------- 在线注册表辅助 ----------
export function registryDocUrl(ext: any) {
  return ext.docs ? AITI_DOCS_BASE + ext.docs : AITI_REGISTRY_PAGE + ext.id + ".html";
}

export function registryInstallSource(ext: any): string | null {
  if (ext.npm && ext.npm.trim()) return "npm:" + ext.npm.trim();
  if (ext.repo && ext.repo.trim()) {
    const repo = ext.repo.trim();
    return /^https?:\/\//.test(repo) ? repo : "git:https://github.com/" + repo;
  }
  return null;
}

/** 在线条目 → 发行者（优先注册表 publisher/website 元数据，回退 author + repo/npm 推导）。 */
export function onlinePublisher(ext: any) {
  // 注册表显式 publisher/website（aiti-docs frontmatter 元数据）优先。
  if (ext.publisher && ext.publisher.trim()) {
    return {
      name: ext.publisher.trim(),
      url: (ext.website && ext.website.trim()) || null,
      source: "registry",
      fingerprint: ext.publisher.trim(),
    };
  }
  const name = (ext.author && ext.author.trim()) || null;
  let url = null as string | null;
  let source = "registry";
  if (ext.repo && ext.repo.trim()) {
    url = /^https?:\/\//.test(ext.repo) ? ext.repo.trim() : "https://github.com/" + ext.repo.trim();
    source = "github";
  } else if (ext.npm && ext.npm.trim()) {
    url = "https://www.npmjs.com/package/" + ext.npm.trim();
    source = "npm";
  }
  return { name, url, source, fingerprint: name || url || ext.id };
}

// ---------- ai-helper 唤起（协议升级等 AI 入口） ----------

/**
 * 唤起 aiti-helper 弹窗（懒加载安全：aiti-helper 未物化先 ensureMaterialized 再重试；
 * 未装/旧宿主无 ensureMaterialized → 提示并返回 false）。返回是否已受理。
 */
export function invokeHelper(opts: Record<string, unknown>): boolean {
  const inv = typeof window !== "undefined" ? (window as any).__aitiHelperInvoke : null;
  if (typeof inv === "function") {
    try { inv(opts); return true; } catch { return false; }
  }
  const p = ctxFull?.ensureMaterialized?.("aiti-helper");
  if (p && typeof p.then === "function") {
    void Promise.resolve(p)
      .catch(() => {})
      .then(() => {
        const inv2 = typeof window !== "undefined" ? (window as any).__aitiHelperInvoke : null;
        if (typeof inv2 === "function") inv2(opts);
        else { try { (window as any).alert?.("aiti-helper 未安装或未就绪，无法唤起 AI。"); } catch {} }
      });
    return true;
  }
  try { (window as any).alert?.("aiti-helper 未安装或未就绪，无法唤起 AI。"); } catch {}
  return false;
}
