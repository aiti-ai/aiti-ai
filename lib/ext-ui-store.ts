/**
 * Client-side extension UI store — a tiny registry on window.__piWebExtUI.
 *
 * The extension client bundles call ctx.registerItems(slot, items) during
 * module registration; core components render them via <ExtSlot name=.../>.
 * A version counter lets React hooks re-render when items are registered.
 *
 * DSH 反哺（docs/dsh-adapter-assessment.md §5.2）：
 *  - 注册按扩展隔离（extId 标记），reload/HMR 可逐扩展反卷（disposer 语义），
 *    替代全量 reset + 重新 import。
 *  - registerExtUiItems 返回 disposer：effect 语义，调用即精确移除该次注册。
 */
"use client";

import type { ReactNode } from "react";
import type { ExtSlotName, ExtUiItemIcon } from "@/lib/ext/types";

export interface ExtRenderProps {
  /** Current selected session (null for a fresh new-session composer). */
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  [key: string]: unknown;
}

export interface ExtUiItemRegistered {
  id: string;
  /** 注册来源扩展 id（反卷/HMR 精确移除用）。 */
  extId?: string;
  /** 门控该条目的 boolean feature id（扩展在 ctx.registerItems 里声明）。
   *  feature 关闭时宿主统一不渲染此条目（条目仍在注册表中，extman「打开」
   *  可虚空创建触发）；无需扩展自己在组件内写门控代码。 */
  feature?: string;
  /** Component receiving ExtRenderProps (currentSession etc.).
   *  可选：toolbar 插槽支持声明式条目——不提供 render 时宿主用 meta.icon + meta.onClick
   *  统一渲染标准按钮（其余插槽仍必须提供 render，消费方按 typeof render === "function" 过滤）。 */
  render?: (props: ExtRenderProps) => ReactNode;
  meta?: {
    label?: string;
    title?: string;
    badge?: boolean;
    noMenuLabel?: boolean;
    /** 声明式图标（toolbar）：宿主统一渲染（⋯ 菜单图标槽 + 无 render 时的标准条按钮）；
     *  提供后扩展 render 的 menu 分支不再被使用。 */
    icon?: ExtUiItemIcon;
    /** 声明式条目点击回调（toolbar，与 meta.icon 配套；仅客户端注册可带，服务端 ui: 意图声明不可序列化）：
     *  ⋯ 菜单行点击 / 标准条按钮点击都会回调（参数为点击事件）。 */
    onClick?: (e?: unknown) => void;
    /** fileViewer 接管判定（aiti-editor）：核心 FileViewer 跳板调用——
     *  文件是否交给该扩展渲染（缺省视为不接管 → 核心原查看器兜底，零回归）。 */
    match?: (filePath: string, opts: { cwd?: string; kind?: "file" | "folder" }) => boolean;
  };
}

/** render 是否存在（render 可选化后的类型收窄谓词；消费方统一用它过滤声明式条目）。 */
export function hasExtRender<T extends ExtUiItemRegistered>(it: T): it is T & { render: (props: ExtRenderProps) => ReactNode } {
  return typeof it.render === "function";
}

/** 扩展级元数据（manifest：name/icon），供宿主 UI 标注扩展身份。 */
export interface ExtMeta {
  name: string;
  icon?: string | null;
  /** 能力接管声明（manifest ui.provides，如 ["session-delete"]）——
   *  宿主据此隐藏对应内置 UI。 */
  provides?: string[];
}

export interface ExtUiStore {
  items: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>>;
  /** extId → manifest 元数据（name/icon） */
  metas: Record<string, ExtMeta>;
  version: number;
  listeners: Set<() => void>;
}

declare global {
  var __piWebExtUI: ExtUiStore | undefined;
}

function getStore(): ExtUiStore {
  if (!globalThis.__piWebExtUI) {
    globalThis.__piWebExtUI = { items: {}, metas: {}, version: 0, listeners: new Set() };
  }
  return globalThis.__piWebExtUI;
}

function bump(): void {
  const store = getStore();
  store.version += 1;
  for (const l of store.listeners) l();
}

/** 覆盖式写入 manifest 扩展元数据（loadExtensions 拉取 manifest 后调用）。 */
export function registerExtMetas(metas: Record<string, ExtMeta>): void {
  const store = getStore();
  store.metas = metas;
  bump();
}

export function getExtMetas(): Record<string, ExtMeta> {
  return getStore().metas;
}

/**
 * 注册一组 slot items（归入给定 extId）。返回 disposer：调用即从 store 精确
 * 移除本次注册的 items（DSH effect 语义——注册与反卷成对，reload 逐扩展反卷）。
 */
export function registerExtUiItems(
  slot: ExtSlotName,
  items: ExtUiItemRegistered[],
  extId?: string,
): () => void {
  const store = getStore();
  const stamped = items.map((it) => ({ ...it, ...(extId ? { extId } : {}) }));
  // 幂等注册：同 (extId, id) 覆盖旧项（保位）而非追加。Fast Refresh 会重建
  // ExtSlots/ext-client-loader 模块（loadStarted/modules 归零）但本 store 挂在
  // globalThis 上跨 HMR 存活——provider remount 会再次 materialize 全部扩展，
  // 纯 append 会累积同 key 项（React "two children with the same key"；扩展
  // 逐一自带幂等标记不是合理要求）。覆盖语义让重复注册天然收敛，且刷新后
  // 拿到新 render 闭包；内容完全一致时跳过 bump，避免无谓重渲染。
  const existing = store.items[slot] ?? [];
  const keyed = new Map(existing.map((it) => [`${it.extId ?? ""}\u0000${it.id}`, it]));
  for (const it of stamped) keyed.set(`${it.extId ?? ""}\u0000${it.id}`, it);
  const next = [...keyed.values()];
  const unchanged =
    next.length === existing.length &&
    next.every(
      (it, i) =>
        it.id === existing[i].id &&
        it.extId === existing[i].extId &&
        it.render === existing[i].render &&
        it.meta === existing[i].meta,
    );
  if (!unchanged) {
    store.items[slot] = next;
    bump();
  }
  return () => {
    const cur = store.items[slot] ?? [];
    const stampedIds = new Set(stamped.map((s) => s.id));
    store.items[slot] = cur.filter((it) => !(stampedIds.has(it.id) && it.extId === extId));
    bump();
  };
}

/** 清除某扩展在指定 slot 注册的指定 items（disposer 语义，精确反卷）。 */
export function disposeExtUiItems(slot: ExtSlotName, extId: string, ids: string[]): void {
  const store = getStore();
  const idSet = new Set(ids);
  const cur = store.items[slot] ?? [];
  const next = cur.filter((it) => !(it.extId === extId && idSet.has(it.id)));
  if (next.length !== cur.length) {
    store.items[slot] = next;
    bump();
  }
}

/** 清除某扩展在全部 slot 注册的 items（HMR 反卷 / 扩展失效）。 */
export function removeExtUiItems(extId: string): void {
  const store = getStore();
  let changed = false;
  for (const slot of Object.keys(store.items) as ExtSlotName[]) {
    const cur = store.items[slot] ?? [];
    const next = cur.filter((it) => it.extId !== extId);
    if (next.length !== cur.length) {
      store.items[slot] = next;
      changed = true;
    }
  }
  if (changed) bump();
}

/** Clear all items for every slot (used when re-importing bundles on reload). */
export function resetExtUiItems(): void {
  const store = getStore();
  store.items = {};
  bump();
}

const NO_UI_ITEMS: ExtUiItemRegistered[] = [];

// 读取时按 feature 门控过滤（带缓存保引用稳定——快照稳定性要求，见 NO_UI_ITEMS 注释）。
// 缓存键含 store 实例 + version：feature 变更经 patchExtFeature → bump() 推进 version；
// 测试/HMR 里 globalThis 重置换新 store 时实例不同也自然失效。
let gatedCache: { store: ExtUiStore; version: number; items: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>> } | null = null;

export function getExtUiItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  const store = getStore();
  const raw = store.items[slot] ?? NO_UI_ITEMS;
  if (!gatedCache || gatedCache.store !== store || gatedCache.version !== store.version) {
    const next: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>> = {};
    for (const s of Object.keys(store.items) as ExtSlotName[]) {
      next[s] = (store.items[s] ?? []).filter((it) => !(it.feature && it.extId && !getExtFeature(it.extId, it.feature)));
    }
    gatedCache = { store, version: store.version, items: next };
  }
  return gatedCache.items[slot] ?? NO_UI_ITEMS;
}

export function subscribeExtUi(cb: () => void): () => void {
  const store = getStore();
  store.listeners.add(cb);
  return () => store.listeners.delete(cb);
}

export function extUiVersion(): number {
  return getStore().version;
}

// ── 扩展功能状态（extman 管理）：host 统一拉取一次填满（manifest），扩展只读 + 订阅变更——
//    无独立请求/轮询。变更：extman set-feature → 广播 pi-web:ext-features-changed →
//    host 监听后 patchExtFeature 原地更新 → subscribeExtFeatures 订阅者收到通知。 ──
let featureState: Record<string, Record<string, boolean | string>> = {};
const featureListeners = new Set<() => void>();

/** 全量写入某扩展的功能状态（manifest 拉取时 host 调用；空/无声明则移除）。 */
export function setExtFeatures(extId: string, features: Record<string, boolean | string> | null): void {
  const next = { ...featureState };
  if (features && Object.keys(features).length > 0) next[extId] = features;
  else delete next[extId];
  featureState = next;
  bump(); // 同步推进 ui-store 版本：feature 门控的插槽条目即时显隐
}

/** 就地更新单个功能项（extman 变更事件 → host patch，不重新拉取）。boolean 传布尔，string 传字符串。 */
export function patchExtFeature(extId: string, featureId: string, value: boolean | string): void {
  const per = { ...(featureState[extId] ?? {}) };
  per[featureId] = value;
  featureState = { ...featureState, [extId]: per };
  for (const l of featureListeners) l();
  bump(); // 同步推进 ui-store 版本：feature 门控的插槽条目即时显隐
}

/** 同步读某扩展的功能状态（未声明/未知 → undefined !== false → 视为启用）。 */
export function getExtFeaturesOf(extId: string): Record<string, boolean | string> {
  return featureState[extId] ?? {};
}

/** 同步读单个功能项是否启用（boolean）。string 类型恒 true。 */
export function getExtFeature(extId: string, featureId: string): boolean {
  const v = featureState[extId]?.[featureId];
  if (typeof v === "string") return v !== "";
  return v !== false;
}

/** 订阅功能状态变更（返回退订函数）。 */
export function subscribeExtFeatures(cb: () => void): () => void {
  featureListeners.add(cb);
  return () => { featureListeners.delete(cb); };
}
