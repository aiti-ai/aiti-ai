/**
 * _shared/ext-float-dock-core.ts — 左栏 dock 区块栈的**纯状态层**（零 react import）。
 *
 * 拆分动机（sidebar 统一 dock 方案 §3.8）：aiti-float 自身 bundle 不做 react alias
 * （产物零 React 引用），其 DockStack 容器需要折叠/排序的读写与迁移逻辑——这些是
 * 纯 localStorage + window 事件，不含任何 React；React 绑定（useBlockCollapsed /
 * useDockOrder / DockBody）留在 ext-float-dock.ts（各扩展 bundle 内联，react alias
 * → host-shim）。
 *
 * 单一事实源 = localStorage（跨 bundle/跨扩展零共享模块实例也收敛）；变更以 window
 * 事件广播（事件驱动零轮询）。订阅方 = aiti-float DockStack 容器 + DockBody 头行。
 *
 * 图标排（v5，方案 docs/pi-web-dock-icon-row-plan.md）：位置菜单/移动操作由文字项改
 * 一排无歧义图标（图标数据在 ./dock-icons.ts）；本文件的 positionMenuModel/positionMenuItems
 * 产出统一模型，appendDockIconRow 供 DOM 端（D2 aiti-float / D3 降级层）共用渲染。
 */
import { dockIconOfZone, createDockIconSvg, type DockIconName } from "./dock-icons.ts";

/* ── 左栏区块 zone 泛化（sidebar 统一 dock 方案 §3.8）──
 * 规范 zone 值 = `sidebar:<itemKey>`（每面板一个区块身份，blockKey 即 itemKey——
 * 折叠/排序记忆直接按 itemKey 落 key）；旧值 "sidebar-explorer" 永远兼容读
 * （旧 dockpref 持久化 / 在网面板）。DockStack 以 isSidebarDockState 判定成员资格。 */
export type DockZone = "sidebar-explorer" | "right-panel" | `sidebar:${string}`;
export type PresentState = "closed" | "floating" | `docked:${string}`;

export function sidebarZoneOf(itemKey: string): `sidebar:${string}` {
  return `sidebar:${itemKey}`;
}
/** 展示状态是否落在左栏区块（规范 sidebar:* 或旧值 sidebar-explorer）。 */
export function isSidebarDockState(state: PresentState | string): boolean {
  return state === "docked:sidebar-explorer" || state.startsWith("docked:sidebar:");
}

/* ── 拖拽入位落点解析（aiti-float-dock-drag-drop-unify-plan §3.1）──
 * 落点标记是公共 DOM（谁拥有停泊区谁盖 data-ext-float-dock-zone），而 sidebar 的
 * zone 值是每面板私有的 sidebar:<itemKey>——公共落点只能盖通配值。标记值 = 通配
 * "sidebar"，拖拽命中后按拖拽面板自己声明的 zones 解析出真实落位。 */
export const SIDEBAR_DROP_ZONE = "sidebar";

/** 落点标记 zone → 拖拽面板真实落位：marker 在面板声明 zones 里原样返回（现有行为）；
 *  通配 "sidebar" → 面板声明的第一个 sidebar:* zone（旧值 sidebar-explorer 一并认）；
 *  无可落位返回 null（松手不入位，浮窗回原处）。 */
export function resolveDropZone(markerZone: string, declaredZones: readonly string[]): DockZone | null {
  if (!markerZone) return null;
  if (declaredZones.includes(markerZone)) return markerZone as DockZone;
  if (markerZone === SIDEBAR_DROP_ZONE) {
    const hit = declaredZones.find((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
    return (hit as DockZone | undefined) ?? null;
  }
  return null;
}

/* ── 左栏区块对齐分组（v4 补录设计：dock 区块上对齐 / 下对齐）──
 *  核心区块（项目、定时任务）上对齐——钉在左栏顶部；重要性次级的区块（文件夹、
 *  停靠面板、消息类）下对齐——钉在左栏底部；两组之间留弹性空隙。对齐是区块的
 *  声明属性（props.blocks.align / slot item meta.align），不是用户可切换态（v1）。
 *  DockStack 以 splitBlockAlign 分组渲染：组内保持有效序，组界 = 排序硬边界。 */
export type BlockAlign = "top" | "bottom";

/** 按对齐属性分组（保持输入序 = 有效序的组内相对序）。defaultAlign：未声明 align
 *  时的兜底（常驻 blocks 缺省 top；dockable items 在构造期已填默认 bottom）。 */
export function splitBlockAlign<T extends { align?: BlockAlign }>(entries: T[], defaultAlign: BlockAlign = "top"): { top: T[]; bottom: T[] } {
  const top: T[] = [];
  const bottom: T[] = [];
  for (const e of entries) {
    if ((e.align ?? defaultAlign) === "bottom") bottom.push(e);
    else top.push(e);
  }
  return { top, bottom };
}

/* ── 左栏区块栈：折叠 / 排序 / 旧折叠 key 迁移（sidebar 统一 dock 方案 §3.1/§3.6）── */
export const SIDEBAR_COLLAPSE_PREFIX = "pi:sidebar-dock:collapsed:";
export const SIDEBAR_ORDER_KEY = "pi:sidebar-dock:order";
export const SIDEBAR_COLLAPSE_EVENT = "pi:sidebar-dock:collapsed-changed";
export const SIDEBAR_ORDER_EVENT = "pi:sidebar-dock:order-changed";
/** 上下移请求（DockBody ⋮ 菜单发出；DockStack 容器监听——全栈键集只有容器知道）。 */
export const SIDEBAR_MOVE_EVENT = "pi:sidebar-dock:move";
/** 拖拽排序落点请求（排序 v2：DockBody 头行 HTML5 DnD 发出；键集裁决同上）。 */
export const SIDEBAR_DROP_EVENT = "pi:sidebar-dock:drop";

export function readBlockCollapsed(blockKey: string): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSE_PREFIX + blockKey) === "1"; } catch { return false; }
}
export function writeBlockCollapsed(blockKey: string, collapsed: boolean): void {
  try { localStorage.setItem(SIDEBAR_COLLAPSE_PREFIX + blockKey, collapsed ? "1" : "0"); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(SIDEBAR_COLLAPSE_EVENT, { detail: { key: blockKey, collapsed } })); } catch { /* ignore */ }
}

/** 播种默认折叠态（仅当该区块尚无折叠记录时写入；与 seedDockDefault 同模式）。
 *  默认显示的常驻区块（项目/文件夹）据此获得「首次出现即折叠/展开」的规定默认态；
 *  用户手动折叠/展开后（writeBlockCollapsed 已写 key）尊重用户操作，永不覆盖。 */
export function seedBlockCollapsedDefault(blockKey: string, collapsed: boolean): void {
  try {
    const k = SIDEBAR_COLLAPSE_PREFIX + blockKey;
    if (localStorage.getItem(k) === null) localStorage.setItem(k, collapsed ? "1" : "0");
  } catch { /* ignore */ }
}

export function readDockOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
export function writeDockOrder(order: string[]): void {
  try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(SIDEBAR_ORDER_EVENT)); } catch { /* ignore */ }
}

/** 有效序：用户改序数组在前（∩ 在场键），其余按 priority 稳定补尾（默认 项目0→任务1→文件2→停靠3+）。 */
export function effectiveBlockOrder<T extends { key: string; priority?: number }>(entries: T[], order: string[]): T[] {
  const byKey = new Map(entries.map((e) => [e.key, e] as const));
  const head: T[] = [];
  for (const k of order) {
    const e = byKey.get(k);
    if (e) { head.push(e); byKey.delete(k); }
  }
  const rest = [...byKey.values()];
  const withIdx = rest.map((e, i) => ({ e, i }));
  withIdx.sort((a, b) => (a.e.priority ?? 3) - (b.e.priority ?? 3) || a.i - b.i);
  return [...head, ...withIdx.map((x) => x.e)];
}

/** 计算移动后的全栈键序（delta ±1；邻居交换），持久化并广播。 */
export function moveBlockKey(key: string, delta: number, allKeys: string[]): void {
  const cur = effectiveBlockOrder(allKeys.map((k) => ({ key: k })), readDockOrder()).map((e) => e.key);
  const idx = cur.indexOf(key);
  if (idx < 0) return;
  const to = idx + delta;
  if (to < 0 || to >= cur.length) return;
  const next = [...cur];
  next.splice(idx, 1);
  next.splice(to, 0, key);
  writeDockOrder(next);
}

/** 拖拽排序落位（v2）：把 key 移到 target 的前/后（其余键相对序不变），持久化并广播。 */
export function moveBlockTo(key: string, target: string, allKeys: string[], before: boolean): void {
  if (key === target) return;
  const cur = effectiveBlockOrder(allKeys.map((k) => ({ key: k })), readDockOrder()).map((e) => e.key);
  const from = cur.indexOf(key);
  const to = cur.indexOf(target);
  if (from < 0 || to < 0) return;
  const next = cur.filter((k) => k !== key);
  let idx = next.indexOf(target);
  if (!before) idx += 1;
  next.splice(idx, 0, key);
  writeDockOrder(next);
}

/** 旧折叠 key 一次性迁移（方案 §3.1：四旧 key 读一次迁入 pi:sidebar-dock:collapsed:*；
 *  旧 key 保留不删——回滚旧宿主仍可读；新 key 已存在时不覆盖，模块级 once 守卫）。 */
let legacyCollapsedMigrated = false;
export function migrateLegacyCollapseKeys(): void {
  if (legacyCollapsedMigrated || typeof localStorage === "undefined") return;
  legacyCollapsedMigrated = true;
  const legacy: Array<[string, string, (v: string) => boolean]> = [
    // [旧 key, 新 blockKey, 值→折叠语义]（sm 项目区写 "1"/"0"，宿主区块写 "true"/"false"）
    ["pi-web:sidebar-projects-collapsed", "projects", (v) => v === "1" || v === "true"],
    ["pi-sidebar-tasks-collapsed", "tasks", (v) => v === "true" || v === "1"],
    ["pi-web:sidebar-explorer-dock-collapsed", "docks", (v) => v === "true" || v === "1"],
    // 宿主 saveExplorerOpen 存「展开」语义 → 折叠取反
    ["pi-web:file-explorer:open", "files", (v) => v === "false" || v === "0"],
  ];
  for (const [oldKey, blockKey, parse] of legacy) {
    try {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal === null) continue;
      if (localStorage.getItem(SIDEBAR_COLLAPSE_PREFIX + blockKey) === null) {
        localStorage.setItem(SIDEBAR_COLLAPSE_PREFIX + blockKey, parse(oldVal) ? "1" : "0");
      }
    } catch { /* ignore */ }
  }
}

/* ── dock 头工具条 store（v3；公开服务 / 本地回落两层承载） ──
 *
 * 机制（方案 docs/pi-web-dock-header-toolbar-plan.md §2.3/§2.7）：
 *   · 按钮定义（actions）由扩展自己声明（face prop / 服务 register），DockBody 自适应渲染；
 *   · 命令实现（commands）与状态（state）由内容组件注册（useDockCommands/useDockHeaderState）；
 *   · 菜单项（menuItems）由内容注册（head/sep/item，渲染进 ⋮ 菜单，供复杂菜单使用）；
 *   · 未命中命令 → pending（TTL 10s）+ 展开区块，命令注册时补跑一次。
 *
 * 承载：aiti-float 安装时用本工厂创建宿主级 store（ctx 服务 aiti-float.dock-header +
 * window.__piweFloat.dockHeader core 保留口）；服务缺席时 _shared 层回落 lazy 本地单例。
 * 纯逻辑零 react（服务端/测试可直接导入）。
 */

export type DockHeaderVisibility = "always" | "expanded";

/** dock 头按钮定义（扩展声明）。badge=角标（变更数等）；active=高亮态；done=完成绿态。 */
export type DockHeaderAction = {
  id: string;
  title: string;
  icon?: unknown;
  badge?: number | string;
  active?: boolean;
  done?: boolean;
  disabled?: boolean;
  /** 缺省 always：收起与展开都显示；"expanded" 仅展开时显示 */
  visibility?: DockHeaderVisibility;
  /** 点击回调；DockBody 会传原始事件（face 可据此取按钮矩形做弹层锚点） */
  onClick: (ev?: unknown) => void;
};

/** 内容上报的状态（纯数据：标量/数组/普通对象——签名比较用 JSON）。 */
export type DockHeaderState = Record<string, unknown>;

/** 命令实现表（id → 函数）；payload 可用于传递锚点矩形等参数。 */
export type DockHeaderCommands = Record<string, ((payload?: unknown) => void) | undefined>;

/** ⋮ 菜单附加项（内容注册，渲染在「工具」组之后的扩展分组）。 */
export type DockMenuItem =
  | { kind: "item"; id?: string; label: string; icon?: unknown; hint?: string; active?: boolean; alwaysRun?: boolean; disabled?: boolean; run: () => void }
  | { kind: "sep"; id?: string }
  | { kind: "head"; label: string; id?: string };

export type DockHeaderRegistration = {
  actions?: DockHeaderAction[] | null;
  commands?: DockHeaderCommands | null;
  state?: DockHeaderState | null;
  menuItems?: DockMenuItem[] | null;
};

export type DockHeaderStore = {
  /** 部分字段合并更新（仅更新传入字段）；返回反注册（仅清本次提供字段）。 */
  register(key: string, reg: DockHeaderRegistration): () => void;
  /** 有命令→立即执行（payload 透传）返回 true；无→展开区块+pending 返回 false。 */
  request(key: string, id: string, payload?: unknown): boolean;
  actionsOf(key: string): DockHeaderAction[] | null;
  commandsOf(key: string): DockHeaderCommands | null;
  stateOf(key: string): DockHeaderState;
  menuItemsOf(key: string): DockMenuItem[] | null;
  subscribe(key: string, cb: () => void): () => void;
};

/** aiti-float 安装完成事件（install() 末尾广播；服务上线重解析信号）。 */
export const FLOAT_INSTALLED_EVENT = "piwe-float-installed";

/** pending 命令存活时长（命令注册晚于点击的窗口；超时丢弃——避免久后挂载意外执行）。 */
export const DOCK_HEADER_PENDING_TTL = 10_000;

function actionSig(list: DockHeaderAction[] | null): string {
  if (!list) return "";
  return list.map((a) => `${a.id}|${a.title}|${a.badge ?? ""}|${a.active ? 1 : 0}|${a.done ? 1 : 0}|${a.disabled ? 1 : 0}|${a.visibility ?? "always"}`).join("§");
}
function menuSig(list: DockMenuItem[] | null): string {
  if (!list) return "";
  return list.map((m) => m.kind === "item"
    ? `i:${m.id ?? m.label}:${m.label}:${m.hint ?? ""}:${m.active ? 1 : 0}:${m.alwaysRun ? 1 : 0}:${m.disabled ? 1 : 0}`
    : m.kind === "head" ? `h:${m.label}` : "s").join("§");
}
function stateSig(s: DockHeaderState): string {
  try { return JSON.stringify(s); } catch { return `keys:${Object.keys(s).length}`; }
}

type DockHeaderKeyState = {
  actions: DockHeaderAction[] | null;
  commands: DockHeaderCommands | null;
  state: DockHeaderState;
  menuItems: DockMenuItem[] | null;
  pending: { id: string; at: number; payload?: unknown } | null;
  sig: { actions: string; state: string; menu: string };
};

export function createDockHeaderStore(): DockHeaderStore {
  const keys = new Map<string, DockHeaderKeyState>();
  const subs = new Map<string, Set<() => void>>();
  const keyState = (k: string): DockHeaderKeyState => {
    let s = keys.get(k);
    if (!s) {
      s = { actions: null, commands: null, state: {}, menuItems: null, pending: null, sig: { actions: "", state: "{}", menu: "" } };
      keys.set(k, s);
    }
    return s;
  };
  const notify = (k: string): void => {
    const set = subs.get(k);
    if (!set) return;
    for (const cb of [...set]) { try { cb(); } catch { /* ignore */ } }
  };
  /** 命令注册后补跑排队命令（TTL 内、id 命中才执行；执行一次即清）。 */
  const tryConsumePending = (k: string): void => {
    const s = keyState(k);
    const p = s.pending;
    if (!p) return;
    if (Date.now() - p.at > DOCK_HEADER_PENDING_TTL) { s.pending = null; return; }
    const fn = s.commands?.[p.id];
    if (typeof fn !== "function") return;
    s.pending = null;
    try { fn(p.payload); } catch { /* ignore */ }
  };
  return {
    register(key, reg) {
      const s = keyState(key);
      if ("actions" in reg) {
        const next = reg.actions ?? null;
        s.actions = next;
        const sig = actionSig(next);
        if (sig !== s.sig.actions) { s.sig.actions = sig; notify(key); }
      }
      if ("state" in reg) {
        const next = reg.state ?? {};
        s.state = next; // 引用始终更新（闭包读最新值）
        const sig = stateSig(next);
        if (sig !== s.sig.state) { s.sig.state = sig; notify(key); }
      }
      if ("menuItems" in reg) {
        const next = reg.menuItems ?? null;
        s.menuItems = next;
        const sig = menuSig(next);
        if (sig !== s.sig.menu) { s.sig.menu = sig; notify(key); }
      }
      if ("commands" in reg) {
        s.commands = reg.commands ?? null;
        tryConsumePending(key);
      }
      return () => {
        const cur = keys.get(key);
        if (!cur) return;
        if ("actions" in reg && cur.actions === (reg.actions ?? null)) {
          cur.actions = null; cur.sig.actions = ""; notify(key);
        }
        if ("menuItems" in reg && cur.menuItems === (reg.menuItems ?? null)) {
          cur.menuItems = null; cur.sig.menu = ""; notify(key);
        }
        if ("commands" in reg && cur.commands === (reg.commands ?? null)) cur.commands = null;
        if ("state" in reg) { cur.state = {}; cur.sig.state = "{}"; notify(key); }
      };
    },
    request(key, id, payload) {
      const s = keyState(key);
      const fn = s.commands?.[id];
      if (typeof fn === "function") { try { fn(payload); } catch { /* ignore */ } return true; }
      s.pending = { id, at: Date.now(), payload };
      try { writeBlockCollapsed(key, false); } catch { /* ignore */ }
      return false;
    },
    actionsOf(key) { return keys.get(key)?.actions ?? null; },
    commandsOf(key) { return keys.get(key)?.commands ?? null; },
    stateOf(key) { return keys.get(key)?.state ?? {}; },
    menuItemsOf(key) { return keys.get(key)?.menuItems ?? null; },
    subscribe(key, cb) {
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(cb);
      return () => { const cur = subs.get(key); if (!cur) return; cur.delete(cb); if (cur.size === 0) subs.delete(key); };
    },
  };
}

/** 本地回落单例（aiti-float 服务缺席时 _shared 层使用；模块级 = 同 bundle 共享）。 */
let localHeaderStore: DockHeaderStore | null = null;
export function localDockHeaderStore(): DockHeaderStore {
  if (!localHeaderStore) localHeaderStore = createDockHeaderStore();
  return localHeaderStore;
}


/* ── 展示状态机（present store）——P1-3 自 ext-float-dock.ts 下沉（方案
 * pi-web-eager-ext-split-plan.md §6 P1-3）：纯 localStorage + window 事件，零 react。
 * 下沉动机：扩展薄壳（eager 侧）只须 usePresent/openFloat/seedDockDefault 这层小 API，
 * 不该连带 DockBody/头行 UI——薄壳 import ext-float-dock-lite（hooks + 本层 re-export）
 * 即可，重 UI 留在 ext-float-dock.ts 由懒 chunk 携带。aiti-float 本体仍只消费本 core
 * （产物零 React 引用的红线不破）。 ── */

const ITEM_KEY_GLOBAL = "__piweFloat";
export const CHANGE_EVENT = "piwe-float-present-change";
const DOCKPREF_KEY = (k: string) => `pi-web:ext-float:dockpref:v1:${k}`;

type FloatApi = {
  present(k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }): void;
  presented(k: string): PresentState;
  onPresentChange(cb: (detail: { key: string; state: PresentState }) => void): () => void;
  dockPref(k: string): string | null;
  /** 「新窗口打开」能力注册表（面板声明自己能否开独立窗口；位置菜单据此显隐图标） */
  registerWindowOpener?(k: string, fn: (() => void) | null): void;
  windowOpenerOf?(k: string): (() => void) | null;
};

/** float 服务探测（ext-float-dock.ts 头行 store 也用；内部共享出口）。 */
export function floatApi(): FloatApi | null {
  const api = (window as any)[ITEM_KEY_GLOBAL] as FloatApi | undefined;
  return api && typeof api.present === "function" ? api : null;
}

/* ── 降级 store（未装 aiti-float）：无浮窗形态，open 直达停靠（嵌入可用） ──
 * ⚠ 状态必须落 localStorage（跨 bundle 单一事实源）：本模块被各扩展 vite 构建内联，
 * 每个 bundle 各持一份模块实例——内存 Map 会出现「open 走 A 副本（session-manager 内联份）、
 * close 走 B 副本（aiti-folder 内联份）」的分叉：close 在 B 副本里 prev===next 走 no-op 分支
 * 不发事件 → gate 永远 floating → 面板关不掉 + 自带遮罩挡屏（实证：folder 浮窗幽灵态）。
 * 同源同 tab 的 localStorage 全 bundle 共享，本 Map 只是写穿缓存；跨刷新残留无害
 * （closed/docked 残留与重 open 落位一致；floating 仅用户显式选浮窗才产生）。 */
const LOCAL_STATES_KEY = "pi-web:ext-float:localstates:v1";
const LOCAL_STATES_REV_KEY = "pi-web:ext-float:localstates-rev:v1";
function loadLocalStates(): Map<string, PresentState> {
  try {
    const raw = localStorage.getItem(LOCAL_STATES_KEY);
    const obj = raw ? JSON.parse(raw) as Record<string, PresentState> : null;
    return new Map(Object.entries(obj ?? {}));
  } catch { return new Map(); }
}
const localStates = loadLocalStates();
/** 本副本已加载的版本戳：另一副本写入后 rev 变化 → 下次读前重拉（写穿读穿）。 */
let localStatesRev = "";
try { localStatesRev = localStorage.getItem(LOCAL_STATES_REV_KEY) ?? ""; } catch { /* ignore */ }
function syncLocalStates(): void {
  let rev = "";
  try { rev = localStorage.getItem(LOCAL_STATES_REV_KEY) ?? ""; } catch { /* ignore */ }
  if (rev === localStatesRev) return;
  localStatesRev = rev;
  const loaded = loadLocalStates();
  localStates.clear();
  for (const [lk, lv] of loaded) localStates.set(lk, lv);
}
function persistLocalStates(): void {
  const rev = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(LOCAL_STATES_KEY, JSON.stringify(Object.fromEntries(localStates)));
    localStorage.setItem(LOCAL_STATES_REV_KEY, rev);
  } catch { /* ignore */ }
  localStatesRev = rev;
}
const localSubs = new Set<(detail: { key: string; state: PresentState }) => void>();
/** 降级层 activate 事件（与 aiti-float dock.ts 的 piwe-float-present-activate 同名同语义）：
 *  同态 docked 再 open 时宿主右栏据此置前对应 tab——降级模式不缺失「不置前」修复。 */
const ACTIVATE_EVENT = "piwe-float-present-activate";

function localPresent(k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }) {
  syncLocalStates();
  const prev = localStates.get(k) ?? "closed";
  let next: PresentState = prev;
  if (mode === "open") {
    // open 直达停靠（本层语义原意，aiti-float 缺席时不弹自带遮罩的模态浮窗）：
    // 已停靠保持原位（激活由下方 activate 广播兜底）；关闭态按
    // 用户 pref（zone；"float" 不认）> 扩展默认位 > 首个声明 zone 落位；
    // 全无声明才 floating 兜底（未接入 dock 声明的老面板）。
    if (prev.startsWith("docked:")) next = prev;
    else {
      const pref = dockPref(k);
      const zones = localZones.get(k) ?? [];
      const zone = pref && pref !== "float" && (zones.includes(pref as DockZone) || isSidebarDockState(`docked:${pref}`))
        ? pref
        : (localDefaults.get(k) ?? zones[0]);
      next = (zone ? `docked:${zone}` : "floating") as PresentState;
    }
  } else if (mode === "float") next = "floating";
  else if (mode === "close") next = "closed";
  else if (mode.startsWith("dock:")) {
    const zone = mode.slice(5);
    // 与 float 状态机 dock.ts 同语义：用户显式停靠即记忆偏好（下次 open 回该位）
    try { localStorage.setItem(DOCKPREF_KEY(k), zone); } catch { /* ignore */ }
    next = `docked:${zone}` as PresentState; // 规范态 docked:<zone>（旧实现误存 dock:<zone> → gate 永假，停靠 face 不渲染）
  }
  if (next === prev) {
    // 同态 docked 再打开：与 float 状态机同语义——广播 activate 供宿主置前。
    // auto 透传（与 dock.ts 一致）：恢复性入栈的 activate 不得把宿主小屏抽屉拉起。
    if (prev.startsWith("docked:")) {
      try { window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: { key: k, state: prev, ...(opts?.auto ? { auto: true } : {}) } })); } catch { /* ignore */ }
    }
    return;
  }
  localStates.set(k, next);
  persistLocalStates();
  const detail = { key: k, state: next, ...(opts?.auto ? { auto: true } : {}) };
  for (const cb of localSubs) { try { cb(detail); } catch { /* ignore */ } }
  try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail })); } catch { /* ignore */ }
}

/* ── 公共 API ── */

export function present(k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }): void {
  const api = floatApi();
  if (api) { api.present(k, mode, opts); return; }
  localPresent(k, mode, opts);
}

export function presentState(k: string): PresentState {
  const api = floatApi();
  if (api) return api.presented(k) ?? "closed";
  syncLocalStates();
  return localStates.get(k) ?? "closed";
}

export function onPresentChange(cb: (detail: { key: string; state: PresentState }) => void): () => void {
  const api = floatApi();
  if (api) return api.onPresentChange(cb);
  localSubs.add(cb);
  return () => localSubs.delete(cb);
}

export function dockPref(k: string): string | null {
  const api = floatApi();
  if (api) return api.dockPref(k) ?? null;
  try { return localStorage.getItem(DOCKPREF_KEY(k)); } catch { return null; }
}

/* ── 语义糖 ── */

/** docked 态重复 open 的容器 flash 提示（方案 §3.2：不开第二个，提示面板在哪）。
 *  定位 DockBody 根上的 data-ext-item 标注（自删 CSS class，零宿主逻辑）。 */
function flashDockContainer(k: string): void {
  try {
    const el = document.querySelector(`[data-ext-float-dock-body="${k}"]`);
    if (!el) return;
    el.classList.remove("piwe-dock-flash");
    // 触发 reflow 重启动画
    void (el as HTMLElement).offsetWidth;
    el.classList.add("piwe-dock-flash");
    setTimeout(() => el.classList.remove("piwe-dock-flash"), 2000);
  } catch { /* ignore */ }
}

export function openFloat(k: string) {
  // docked 态幂等 open：不开第二个，flash 提示（方案 §3.2）；float 状态机内部同样幂等
  const st = presentState(k);
  if (st.startsWith("docked:")) flashDockContainer(k);
  present(k, "open");
}

// 降级命令监听：未装 aiti-float 时由本层响应宿主命令事件（TabBar ✕ 等）；
// float 在场时由 float 的监听处理（本层不重复执行）
if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-present-command", ((e: CustomEvent<{ key: string; mode: "open" | "float" | `dock:${string}` | "close" }>) => {
      if (floatApi()) return; // float 在场 → float 的监听已处理
      if (!e.detail || !e.detail.key || !e.detail.mode) return;
      localPresent(e.detail.key, e.detail.mode);
    }) as EventListener);
  } catch { /* ignore */ }
}
export function dockTo(k: string, zone: DockZone) { present(k, `dock:${zone}`); }
/** dock 到左栏区块（zone = sidebar:<itemKey>；sidebar 统一 dock 方案 §3.8）。 */
export function dockToSidebar(k: string) { present(k, `dock:${sidebarZoneOf(k)}`); }
/** 拉回浮窗（v3 Q1：同时记住浮窗偏好——下次 open 仍回浮窗；dock.ts present("float") 内已写） */
export function undockToFloat(k: string) { present(k, "float"); }
export function closePanel(k: string) { present(k, "close"); }
/** 直接写用户形态偏好（zone | "float"），不迁移状态——偏好下次 open 生效。 */
export function setDockPref(k: string, pref: "float" | DockZone) {
  const api = floatApi();
  if (api && typeof (api as any).setPref === "function") { (api as any).setPref(k, pref); return; }
  try { localStorage.setItem(DOCKPREF_KEY(k), pref); } catch { /* ignore */ }
}

/** 清除用户形态偏好（不迁移状态）。用于「关闭即忘」语义的面板（文件夹区块拍板：
 *  任何路径关闭后清偏好，下次 open/刷新自动入栈回落默认位——避免拉成浮窗关掉后
 *  刷新又弹出）。float 状态机 dockprefOf 每次直读 localStorage 无缓存，删 key 即生效
 *  （float 在场/降级层同 key，两态通用）。 */
export function clearDockPref(k: string): void {
  try { localStorage.removeItem(DOCKPREF_KEY(k)); } catch { /* ignore */ }
}

/** 播种扩展声明默认落位（v3 §2-B 实现修正）：仅当用户尚无偏好时写 dockPref=zone。
 *  为什么不是只靠面板属性：default 需要在**首次 open 时**生效，而面板 JSX 只在渲染后
 *  存在（open 前状态机拿不到 DOM 属性，鸡生蛋）——故扩展 register 时调本函数预填。
 *  用户 ⇲/选浮窗后偏好被覆盖，本函数永不再次覆盖（尊重用户选择）。
 *  createDockFaces 工厂自动调；手写接入在 register() 里显式调一次。 */
export function seedDockDefault(k: string, zone: DockZone) {
  try { if (!localStorage.getItem(DOCKPREF_KEY(k))) localStorage.setItem(DOCKPREF_KEY(k), zone); } catch { /* ignore */ }
  // 默认位进注册表（TabBar ⇱ 菜单「默认」尾标；v3.1）——与 declareDockZones 互不覆盖：
  // 本函数只补 default，不动 zones 集合
  const api = floatApi() as any;
  if (api && typeof api.registerDefaultZone === "function") { try { api.registerDefaultZone(k, zone); } catch { /* ignore */ } }
  localDefaults.set(k, zone);
}

/* ── 降级 ⇱ 菜单：未装 aiti-float 时宿主 TabBar ⇱ 也得出菜单（float 在场由其监听处理）。
 *  数据源 = 降级注册表；动作 = localPresent（同态激活语义由宿主 activate 监听兜）。 ── */
let fbMenuKey: string | null = null;
let fbMenuEl: HTMLElement | null = null;
let fbDismiss: { key: string; at: number } | null = null;

if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-dock-menu", ((e: CustomEvent<{ key: string; rect?: { left: number; bottom: number } }>) => {
      if (floatApi()) return; // float 在场 → float 的监听已处理
      const k = e.detail?.key;
      if (!k) return;
      // 同 key toggle（含锚按钮 mousedown dismiss 后 click 再触发的场景）
      if (fbMenuKey === k || (fbDismiss && fbDismiss.key === k && Date.now() - fbDismiss.at < 350)) {
        if (fbMenuEl) fbMenuEl.remove();
        fbMenuEl = null; fbMenuKey = null;
        return;
      }
      if (fbMenuEl) fbMenuEl.remove();
      const zones = (localZones.get(k)?.length ? localZones.get(k)! : (presentState(k).startsWith("docked:") ? [presentState(k).slice(7) as DockZone] : []));
      const def = localDefaults.get(k);
      const cur = presentState(k);
      const menu = document.createElement("div");
      menu.setAttribute("data-ext-dock-menu", "1");
      menu.style.cssText = "position:fixed;z-index:2147483600;background:var(--bg-panel,#1a1a1a);border:1px solid var(--border,#444);"
        + "border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:190px;";
      const rect = e.detail?.rect;
      menu.style.left = Math.max(8, (rect?.left ?? window.innerWidth / 2 - 70) - 60) + "px";
      menu.style.top = (rect?.bottom ?? 140) + 4 + "px";
      // v5 图标排（方案 §3.4）：统一模型（浮窗 + 各停靠位），共享 DOM 行构造
      const items = positionMenuModel(k, zones as DockZone[], def, cur, { onNewWindow: dockWindowOpenerOf(k) });
      appendDockIconRow(menu, items, { label: "停靠方位", onPick: () => { if (fbMenuEl === menu) { fbMenuEl = null; fbMenuKey = null; } } });
      document.body.appendChild(menu);
      fbMenuKey = k;
      fbMenuEl = menu;
      const dismiss = (ev: MouseEvent) => {
        if (menu.contains(ev.target as Node)) return;
        fbDismiss = { key: k, at: Date.now() };
        menu.remove();
        if (fbMenuEl === menu) { fbMenuEl = null; fbMenuKey = null; }
        document.removeEventListener("mousedown", dismiss, true);
      };
      setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
    }) as EventListener);
  } catch { /* ignore */
  }
}

/* ── 位置菜单（v3 §2-D：DockBody 头行 📍，停靠态一键换位） ──
 *  数据源 = 调用方传入的 zones/defaultZone（扩展自己知道自己声明了什么；
 *  createDockFaces 自动传）。float 状态机不存 DOM 属性，故不经全局查询。 */
export const DOCK_ZONE_LABELS: Record<string, string> = {
  "sidebar-explorer": "左栏 · 区块",
  "right-panel": "右栏 · 面板",
};

/** ── 图标排模型（v5，方案 docs/pi-web-dock-icon-row-plan.md §3.4）──────────────────
 *  D1/D2/D3 位置菜单与 D1 ⋮「移动」行共用同一形状（2026-09-15 用户拍板：移动回归单行图标排，
 *  行首补 move-diagonal-2 行图标——行图标由 React 端 DockMenuRow 承载，不在本模型内）。
 *  · active：当前态（高亮 + 锁定，点击不生效）——语义同旧文字菜单 active；
 *  · isDefault：扩展声明默认位（右上角圆点角标；tooltip 后缀「（默认）」）。 */
export interface DockIconRowItem {
  /** 稳定键（位置键 / move-up 等；DOM 端写 data-ext-dock-icon 供 e2e 断言） */
  key: string;
  icon: DockIconName;
  /** tooltip / aria-label 文案 */
  label: string;
  active?: boolean;
  isDefault?: boolean;
  run: () => void;
}

/** 位置菜单项（v5 图标排）：`key` = 位置键（"float" 或 zone 值；sidebar 族折叠成一项）。 */
export interface PositionMenuItem extends DockIconRowItem {
  /** 位置键："float" 或 DockZone（sidebar 族多项折叠为 "sidebar-explorer"） */
  key: string;
  /** 兼容字段（旧文字菜单「默认」尾标；图标排用 isDefault 圆点） */
  hint?: string;
}

/** 位置菜单项构建（v4 统一 + v5 图标化）：sidebar 族 zone 折叠成单个「左栏 · 区块」条目
 *  （栈内各区块行为一致，具体 zone 值无用户语义）；active 按状态族判定
 *  （兼容旧 docked:sidebar-explorer）。浮窗/各物理位一族一项。 */
export function positionMenuItems(k: string, zones: DockZone[], defaultZone: DockZone | undefined, cur: PresentState): PositionMenuItem[] {
  const hasSidebar = zones.some((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
  const items: PositionMenuItem[] = [];
  if (hasSidebar) {
    const isDef = defaultZone === "sidebar-explorer" || !!defaultZone?.startsWith("sidebar:");
    items.push({
      key: "sidebar-explorer",
      icon: "panel-left",
      label: DOCK_ZONE_LABELS["sidebar-explorer"],
      hint: isDef ? "默认" : undefined,
      isDefault: isDef,
      active: isSidebarDockState(cur),
      run: () => dockToSidebar(k),
    });
  }
  for (const z of zones) {
    if (z === "sidebar-explorer" || z.startsWith("sidebar:")) continue;
    items.push({
      key: z,
      icon: dockIconOfZone(z),
      label: DOCK_ZONE_LABELS[z] ?? z,
      hint: z === defaultZone ? "默认" : undefined,
      isDefault: z === defaultZone,
      active: cur === `docked:${z}`,
      run: () => dockTo(k, z),
    });
  }
  return items;
}

/** 完整位置菜单模型（含浮窗项；序 = 浮窗 → 各停靠位）——D1/D2/D3 三处菜单共用，
 *  消灭三份「浮窗 + zones」手工拼装。run 走本层动作糖（float 在场自动转 api 状态机）。
 *  opts.onNewWindow：面板支持「新窗口打开」时传打开函数——该项排最前（序：新窗口 →
 *  浮窗 → 各停靠位）；不传/无注册 → 不显示（「有些暂时不支持」由能力注册决定）。 */
export function positionMenuModel(k: string, zones: DockZone[], defaultZone: DockZone | undefined, cur: PresentState, opts?: { onNewWindow?: (() => void) | null }): PositionMenuItem[] {
  const newWindow = opts?.onNewWindow ?? dockWindowOpenerOf(k);
  return [
    ...(newWindow ? [{ key: "new-window", icon: "new-window" as const, label: "新窗口打开", run: newWindow }] : []),
    { key: "float", icon: "float", label: "浮窗", active: cur === "floating", run: () => undockToFloat(k) },
    ...positionMenuItems(k, zones, defaultZone, cur),
  ];
}

/* ── 「新窗口打开」能力注册表（跨 bundle 收敛）──
 *  面板挂载/实例创建时调 declareDockWindowOpener(k, fn) 声明支持；位置菜单模型
 *  据此显隐 B 图标（aiti-folder 文件夹面支持；文件走工具条入口）。
 *  float 在场 → 存 float 单例注册表（D2 TabBar ⇱ 菜单跨 bundle 可读）；
 *  缺席 → 本 bundle local map 兑底（D1 内联菜单同 bundle 可读；D3 降级菜单读不到
 *  其他 bundle 的注册，故降级模式不显示该项——接受）。 */
const localWindowOpeners = new Map<string, () => void>();
export function declareDockWindowOpener(k: string, fn: (() => void) | null): void {
  const api = floatApi() as (FloatApi & { registerWindowOpener?: (k2: string, f: (() => void) | null) => void }) | null;
  if (api && typeof api.registerWindowOpener === "function") { try { api.registerWindowOpener(k, fn); } catch { /* ignore */ } }
  if (typeof fn === "function") localWindowOpeners.set(k, fn);
  else localWindowOpeners.delete(k);
}
/** 查面板「新窗口打开」能力（无注册返回 null）。 */
export function dockWindowOpenerOf(k: string): (() => void) | null {
  const api = floatApi() as (FloatApi & { windowOpenerOf?: (k2: string) => (() => void) | null }) | null;
  if (api && typeof api.windowOpenerOf === "function") {
    try { const fn = api.windowOpenerOf(k); if (typeof fn === "function") return fn; } catch { /* ignore */ }
  }
  return localWindowOpeners.get(k) ?? null;
}

/** 图标排 DOM 渲染（D2 aiti-float / D3 降级层共用）：一行「名称 + 右对齐图标组」
 *  （名称 12px 灰字居左；图标 28×28、gap 6、右对齐；当前态高亮锁定、默认位圆点、hover tooltip）。
 *  label 缺省时仅渲染图标组（兼容纯图标行）。onPick 在「可点项」点击时先于 run 调用
 *  （消费方用于关菜单）。返回行元素。 */
export function appendDockIconRow(parent: HTMLElement, items: DockIconRowItem[], opts?: { label?: string; onPick?: (it: DockIconRowItem) => void }): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-ext-dock-icon-row", "1");
  row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:5px 10px;";
  if (opts?.label) {
    const lab = document.createElement("span");
    lab.setAttribute("data-ext-dock-icon-row-label", "1");
    lab.textContent = opts.label;
    lab.style.cssText = "font-size:12px;color:var(--text-dim,#888);flex-shrink:0;user-select:none;white-space:nowrap;";
    row.appendChild(lab);
  }
  const group = document.createElement("div");
  group.setAttribute("data-ext-dock-icon-group", "1");
  group.style.cssText = "display:flex;gap:6px;margin-left:auto;flex-shrink:0;";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    const tip = it.isDefault ? `${it.label}（默认）` : it.label;
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
    if (it.active === true || it.active === false) {
      btn.setAttribute("role", "menuitemradio");
      btn.setAttribute("aria-checked", it.active ? "true" : "false");
    } else {
      btn.setAttribute("role", "menuitem");
    }
    btn.setAttribute("data-ext-dock-icon", it.key);
    btn.style.cssText = "position:relative;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;"
      + "border:none;background:none;border-radius:6px;padding:0;font-family:inherit;cursor:pointer;color:var(--text-muted,#888);"
      + (it.active ? "cursor:default;background:var(--bg-selected,#2a2a2a);color:var(--accent,#2563eb);" : "");
    btn.appendChild(createDockIconSvg(it.icon, 16));
    if (!it.active) {
      btn.addEventListener("mouseenter", () => { btn.style.background = "var(--bg-hover,#262626)"; btn.style.color = "var(--text,#ddd)"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "none"; btn.style.color = "var(--text-muted,#888)"; });
      btn.addEventListener("click", () => { opts?.onPick?.(it); it.run(); });
    }
    if (it.isDefault) {
      const dot = document.createElement("span");
      dot.setAttribute("data-ext-dock-icon-default", "1");
      dot.style.cssText = "position:absolute;top:3px;right:3px;width:4px;height:4px;border-radius:50%;background:var(--accent,#2563eb);pointer-events:none;";
      btn.appendChild(dot);
    }
    group.appendChild(btn);
  }
  row.appendChild(group);
  parent.appendChild(row);
  return row;
}
/* ── zones/default 集中注册（v3.1）：TabBar dock tab ⇱ 菜单的数据源。面板停靠 face
 *  未挂载（后台 tab）时菜单只能靠这里；DOM 属性是兜底（DockBody 根上也有同名属性）。 */
const localZones = new Map<string, DockZone[]>();
const localDefaults = new Map<string, DockZone>();

/** 声明面板可停靠位 + 默认位（register 时调一次；createDockFaces 自动调）。
 *  float 在场 → 进状态机注册表；缺席 → 本层降级表（降级 ⇱ 菜单同源）。 */
export function declareDockZones(k: string, zones: DockZone[], defaultZone?: DockZone) {
  const api = floatApi() as any;
  if (api && typeof api.registerZones === "function") {
    try { api.registerZones(k, zones); } catch { /* ignore */ }
    if (defaultZone && typeof api.registerDefaultZone === "function") { try { api.registerDefaultZone(k, defaultZone); } catch { /* ignore */ } }
  }
  localZones.set(k, zones.filter(Boolean));
  if (defaultZone) localDefaults.set(k, defaultZone);
}
