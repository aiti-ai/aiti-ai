/**
 * 新会话欢迎页「顶部/底部小组件」布局与偏好 — pure logic, SSR-safe.
 *
 * 欢迎页上下两个 widget 区（top = 消息区上方，bottom = composer 下方）由扩展或
 * 宿主内置功能经 `newSessionWidgets` 插槽注册 widget（meta 标注允许区域与栅格尺寸，
 * 见 lib/ext/types.ts `NewSessionWidgetMeta`）。本模块拥有：
 *   - localStorage 偏好读写（单 key JSON：top/bottom 两个用户序 + hidden 集合），
 *   - `resolveWidgetLayout()` — 把偏好与当前在场条目合并成两区的最终渲染序。
 *
 * 设计要点（对标 lib/topbar-order.ts 的自定义顺序范式）：
 *   - 偏好按区分列表（top/bottom 各一条用户序），面板操作（区内移动/跨区移动/显隐）
 *     都是 O(列表) 的简单splice；未知 id（扩展卸载等）在解析时丢弃，不回写膨胀。
 *   - 未入偏好的新条目按 meta.priority 升序（缺省按注册序）补尾到 defaultArea。
 *   - 用户序里的条目若不再被允许落该区（meta 收紧），解析时跳过——它会经「未入偏好」
 *     路径回到自己当前允许的 defaultArea，而不是消失。
 */

export const NSW_PREF_KEY = "pi-new-session-widgets";
export const NSW_PREF_EVENT = "pi-new-session-widgets-changed";

export type NswArea = "top" | "bottom";

/** 用户偏好（单 key JSON）。空列表/缺失 = 该维度无定制。 */
export interface NewSessionWidgetPref {
  top: string[];
  bottom: string[];
  hidden: string[];
}

export const EMPTY_NSW_PREF: NewSessionWidgetPref = Object.freeze({ top: [], bottom: [], hidden: [] });

/** 布局解析的输入条目（宿主把插槽 items + 内置条目归一化成这个形态）。 */
export interface NewSessionWidgetItem {
  /** 复合 id：扩展条目 "extId:itemId"；内置条目 "builtin:recent" 等。 */
  id: string;
  /** 来源扩展 id（内置条目缺省；面板「来自扩展」标注用）。 */
  extId?: string;
  title: string;
  /** 允许区域集合（归一化后非空）。 */
  areas: NswArea[];
  defaultArea: NswArea;
  /** 栅格列宽 1..8（手机 4 列 / 桌面 8 列）。 */
  w: number;
  /** 栅格行高 1..3。 */
  h: number;
  /** 默认序权重（升序稳定）。 */
  priority: number;
}

/** 解析结果：两区渲染序 + 有效隐藏集 + 是否无任何定制。 */
export interface NewSessionWidgetLayout {
  top: string[];
  bottom: string[];
  hidden: string[];
  isDefault: boolean;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 归一化 meta 各维（宿主与测试共用：越界/非法值落缺省，areas 空 → both）。 */
export function normalizeWidgetItem(
  raw: Partial<NewSessionWidgetItem> & { id: string; title?: string },
): NewSessionWidgetItem {
  const areas: NswArea[] = [];
  for (const a of raw.areas ?? []) {
    if ((a === "top" || a === "bottom") && !areas.includes(a)) areas.push(a);
  }
  if (areas.length === 0) areas.push("top", "bottom");
  const defaultArea: NswArea =
    raw.defaultArea === "top" || raw.defaultArea === "bottom"
      ? raw.defaultArea
      : areas[0];
  return {
    id: raw.id,
    extId: raw.extId,
    title: raw.title ?? raw.id,
    areas,
    defaultArea: areas.includes(defaultArea) ? defaultArea : areas[0],
    w: clampInt(raw.w ?? 4, 1, 8, 4),
    h: clampInt(raw.h ?? 1, 1, 3, 1),
    priority: typeof raw.priority === "number" && Number.isFinite(raw.priority) ? raw.priority : 0,
  };
}

export function readNewSessionWidgetPref(): NewSessionWidgetPref | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(NSW_PREF_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const pickList = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    return {
      top: pickList(obj.top),
      bottom: pickList(obj.bottom),
      hidden: pickList(obj.hidden),
    };
  } catch {
    return null;
  }
}

export function writeNewSessionWidgetPref(pref: NewSessionWidgetPref): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NSW_PREF_KEY, JSON.stringify(pref));
  } catch {
    // storage full / disabled — non-fatal
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(NSW_PREF_EVENT));
    } catch { /* non-browser */ }
  }
}

/** 恢复默认 = 删 key + 事件（_zones/面板订阅后即时回默认布局）。 */
export function resetNewSessionWidgetPref(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(NSW_PREF_KEY);
  } catch { /* non-fatal */ }
  try {
    window.dispatchEvent(new CustomEvent(NSW_PREF_EVENT));
  } catch { /* non-browser */ }
}

/** 订阅偏好变化（本页写事件 + 其他 tab storage 回灌）。返回退订函数。 */
export function subscribeNewSessionWidgetPref(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === NSW_PREF_KEY || e.key === null) cb();
  };
  window.addEventListener(NSW_PREF_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(NSW_PREF_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * 合并偏好与在场条目成两区最终序：
 *   1. 每区先按用户序取（过滤：不在场 / 不允许该区 / 已隐藏）；
 *   2. 未入任何用户序且未隐藏的条目，按 defaultArea 归属、priority 升序稳定补尾；
 *   3. hidden = 偏好 ∩ 在场（陈旧 id 丢弃）。
 * isDefault = 三张偏好列表全空（与默认布局等价）。
 */
export function resolveWidgetLayout(
  items: NewSessionWidgetItem[],
  pref: NewSessionWidgetPref | null,
): NewSessionWidgetLayout {
  const byId = new Map(items.map((it) => [it.id, it]));
  const hiddenPref = new Set((pref?.hidden ?? []).filter((id) => byId.has(id)));
  const placed = new Set<string>();
  const out: NewSessionWidgetLayout = { top: [], bottom: [], hidden: [...hiddenPref], isDefault: false };

  const userList = (area: NswArea): string[] => {
    const list: string[] = [];
    for (const id of pref?.[area] ?? []) {
      if (placed.has(id) || hiddenPref.has(id)) continue;
      const item = byId.get(id);
      if (!item || !item.areas.includes(area)) continue;
      placed.add(id);
      list.push(id);
    }
    return list;
  };

  out.top = userList("top");
  out.bottom = userList("bottom");

  // 默认补尾：未入偏好的在场条目 → defaultArea（priority 升序稳定；注册序 = Array.sort 稳定性）
  const rest = items
    .filter((it) => !placed.has(it.id) && !hiddenPref.has(it.id))
    .sort((a, b) => a.priority - b.priority);
  for (const area of ["top", "bottom"] as const) {
    for (const it of rest) {
      if (it.defaultArea !== area) continue;
      out[area].push(it.id);
      placed.add(it.id);
    }
  }

  out.isDefault = (pref?.top.length ?? 0) === 0 && (pref?.bottom.length ?? 0) === 0 && (pref?.hidden.length ?? 0) === 0;
  return out;
}
