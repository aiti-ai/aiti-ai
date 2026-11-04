/**
 * aiti-float · dock 展示状态机（方案 aiti-web-ext-float-dock-plan.md §3/§5.2 +
 * position-picker-plan.md §2-B/§2-C，2026-09-12 Q1 拍板）。
 *
 * 单实例防双开核心：同 itemKey 任一时刻至多一个 face（closed/floating/docked:<zone>）。
 * 浮窗 DOM 的挂载/卸载由扩展 dialogs item 的 gate 渲染门控负责——本模块只管状态迁移、
 * 停靠偏好持久化与变化通知，不搬 DOM。
 *
 * 持久化拆两份（§3.3）：
 *   pi-web:ext-float:v1:<key>            浮窗盒 {x,y,w,h}（既有，float.ts 维护）
 *   pi-web:ext-float:dockpref:v1:<key>   用户形态偏好 zone | "float"（本模块写）
 * 形态本身不持久化——刷新回 closed。
 *
 * open 落位优先级（v3，Q1 拍板）：dockPref（用户上次选择，含 "float"）
 *   > dock-default（扩展声明默认落位） > floating（现状兑底）。
 */

export type PresentState = "closed" | "floating" | `docked:${string}`;
export type PresentMode = "open" | "float" | `dock:${string}` | "close";
/** 用户形态偏好值：zone 或 "float"（v3：⇲/选浮窗即记忆，Q1） */
export type DockPref = string;

export const CHANGE_EVENT = "piwe-float-present-change";
/** 同态再激活事件：已 docked 的面板重复 open/dock:same-zone 时无状态迁移（change 不发），
 *  但用户语义是「把它带到面前」——宿主右栏据此激活对应 tab（AppShell 监听）。 */
const ACTIVATE_EVENT = "piwe-float-present-activate";
/** 宿主→状态机命令事件（TabBar ✕ = close 等；解耦：宿主不 import 扩展代码） */
const COMMAND_EVENT = "piwe-float-present-command";
/** TabBar ⇱ → 位置菜单请求（宿主只报 key+锚点矩形，菜单由 float/降级层渲染） */
export const DOCK_MENU_EVENT = "piwe-float-dock-menu";

const DOCKPREF_PREFIX = "pi-web:ext-float:dockpref:v1:";

const states = new Map<string, PresentState>();
/** 扩展声明默认落位（float.ts 增强面板时读 data-ext-float-dock-default 注册；内存态不持久化） */
const defaultZones = new Map<string, string>();
/** 多 zone 面板可停靠位集中注册表（declareDockZones/工厂写入；TabBar ⇱ 菜单数据源，
 *  查不到再兜底 DockBody DOM 属性——面板停靠 face 挂载时才存在） */
const zonesReg = new Map<string, string[]>();
const subs = new Set<(detail: { key: string; state: PresentState }) => void>();

function dockprefOf(key: string): string | null {
  try { return localStorage.getItem(DOCKPREF_PREFIX + key); } catch { return null; }
}

function setState(key: string, state: PresentState, opts?: { auto?: boolean }): void {
  const prev = states.get(key) ?? "closed";
  if (prev === state) return;
  states.set(key, state);
  const detail = { key, state, ...(opts?.auto ? { auto: true } : {}) };
  for (const cb of subs) { try { cb(detail); } catch { /* ignore */ } }
  try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail })); } catch { /* ignore */ }
}

/** 状态机唯一迁移入口（§3.2）。opts.auto：非用户主动的恢复性入栈（如刷新后
 *  autoDock 常驻区块恢复），迁移照常但事件带 auto 标记——宿主据此不强制展开侧栏
 *  （小屏 overlay 抽屉否则会在加载时被恢复入栈误拉起）。 */
export function present(key: string, mode: PresentMode, opts?: { auto?: boolean }): void {
  const cur = states.get(key) ?? "closed";
  if (mode === "open") {
    // open 幂等；落位优先级（v3）：用户偏好（zone|"float"）> 扩展 default > floating（Q1 拍板）
    const pref = dockprefOf(key);
    if (pref === "float") setState(key, cur === "closed" ? "floating" : cur, opts);
    else if (pref) setState(key, `docked:${pref}`, opts);
    else {
      const def = defaultZones.get(key);
      if (def && cur === "closed") setState(key, `docked:${def}`, opts);
      else if (cur === "closed") setState(key, "floating", opts);
      else setState(key, cur, opts); // floating/docked 幂等（不开第二个；flash 提示由容器/helper 负责）
    }
  }
  else if (mode === "float") { setPref(key, "float"); setState(key, "floating", opts); return; } // v3：选浮窗=记忆偏好（Q1）
  else if (mode === "close") { setState(key, "closed", opts); return; } // dockPref 不清（重开=上次偏好）
  else if (mode.startsWith("dock:")) {
    const zone = mode.slice(5);
    try { localStorage.setItem(DOCKPREF_PREFIX + key, zone); } catch { /* ignore */ }
    setState(key, `docked:${zone}`, opts); // auto 必须透传：恢复性同步入栈不拉小屏抽屉
  }
  // 同态 docked 再打开（重复 open / dock:同区 / TabBar 菜单选当前区）：无状态迁移可广播，
  // 但用户语义 = 「带到面前」——发激活事件，宿主右栏据此置前对应 tab（floating 幂等不发）。
  // auto 透传：恢复性入栈（autoDock/项目联动同步）的激活不得把宿主小屏抽屉拉起。
  const after = states.get(key) ?? "closed";
  if (after === cur && after.startsWith("docked:")) {
    try { window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: { key, state: after, ...(opts?.auto ? { auto: true } : {}) } })); } catch { /* ignore */ }
  }
}

export function presented(key: string): PresentState {
  return states.get(key) ?? "closed";
}

export function onPresentChange(cb: (detail: { key: string; state: PresentState }) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function dockPref(key: string): string | null {
  return dockprefOf(key);
}

/** 直接写用户形态偏好（zone | "float"）不迁移状态——选择器/DockBody 菜单用。 */
export function setPref(key: string, pref: DockPref): void {
  try { localStorage.setItem(DOCKPREF_PREFIX + key, pref); } catch { /* ignore */ }
}

/** 注册扩展声明的默认落位（float.ts 增强面板时调；同 key 重注册覆盖）。 */
export function registerDefaultZone(key: string, zone: string): void {
  defaultZones.set(key, zone);
}

/** 查询默认落位声明（菜单「默认」标用）。 */
export function defaultZoneOf(key: string): string | null {
  return defaultZones.get(key) ?? null;
}

/** 注册面板可停靠 zone 全集（helper declareDockZones/createDockFaces 调；TabBar ⇱ 菜单数据源）。 */
export function registerZones(key: string, zones: string[]): void {
  const list = zones.filter(Boolean);
  if (list.length) zonesReg.set(key, list);
  else zonesReg.delete(key);
}

/** 查询注册的可停靠 zone 全集（未注册返回 []，调用方自行兜底 DOM 属性/当前区）。 */
export function zonesOf(key: string): string[] {
  return zonesReg.get(key) ?? [];
}

/** 「新窗口打开」能力注册表（面板声明自己能否开独立窗口；位置菜单据此显隐 B 图标）。
 *  key = 面板 itemKey；fn=null 注销。未注册 = 不支持（该项不出）。 */
const windowOpeners = new Map<string, () => void>();
export function registerWindowOpener(key: string, fn: (() => void) | null): void {
  if (typeof fn === "function") windowOpeners.set(key, fn);
  else windowOpeners.delete(key);
}
export function windowOpenerOf(key: string): (() => void) | null {
  return windowOpeners.get(key) ?? null;
}

export const ACTIVATE_EVENT_NAME = ACTIVATE_EVENT;

/** ⛵ 声明可停靠 zone（面板 data-ext-float-dock 属性，空格分隔）。 */
export function dockZonesOf(panel: HTMLElement): string[] {
  const raw = (panel.getAttribute("data-ext-float-dock") ?? "").trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

export const VERSION = 1;
export const COMMAND_EVENT_NAME = COMMAND_EVENT;

/** 安装命令事件监听（float install 时调用一次；helper 降级层同款监听，二选一生效） */
export function installCommandListener(): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ key: string; mode: PresentMode }>).detail;
    if (!detail || !detail.key || !detail.mode) return;
    present(detail.key, detail.mode);
  };
  window.addEventListener(COMMAND_EVENT, handler);
  return () => window.removeEventListener(COMMAND_EVENT, handler);
}
