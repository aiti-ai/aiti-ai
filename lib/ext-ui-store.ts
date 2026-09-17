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
import type { ExtSlotName, ExtUiItem, ExtUiItemIcon, NewSessionPrepareResult } from "@/lib/ext/types";

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
  /** [懒加载 v2] 静态条目标记（manifest ui[slot][] 声明、client 物化前由宿主渲染
   *  的零 bundle 入口）。注册条目同 (extId,id) 到场后静态条目自动退场。 */
  static?: boolean;
  /** [懒加载 v2] 静态条目点击加载进行中（ExtToolbarIconButton 显示加载态 + 防连点）。 */
  pending?: boolean;
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
    /** sessionRequestCard 路由（agent 能力 UI 去核化）：本条目认领的请求 kind 集合
     *  （`interaction:plan_approval` / `permission` / `provider_headers` / 后端自定义…）。
     *  宿主按 request.kind ∈ kinds && (backend 未声明 | "*" | == 会话 backendSource) 过滤，
     *  priority 最高者接管；未命中落宿主兜底卡。 */
    kinds?: string[];
    backend?: string | "*";
    priority?: number;
    /** newSessionPreparers 注册面（分支/Worktree picker 等）：新会话创建前管道回调——
     *  ensureNewSession 在 POST 前依序 await meta.prepare({cwd})：{cwd} 改写目标目录 /
     *  {abort} 中止创建（走既有 throw→notice 通道；docs/pi-web-new-session-branch-worktree-plan.md §3）。 */
    prepare?: (ctx: { cwd: string }) => Promise<NewSessionPrepareResult>;
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
  /** [懒加载 v2] manifest 静态条目（物化前可渲染的零 bundle 入口；注册条目按
   *  (extId,id) 覆盖之）。与 items 分 open 存，getExtUiItems 合并输出。 */
  staticItems: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>>;
  /** extId → manifest 元数据（name/icon） */
  metas: Record<string, ExtMeta>;
  version: number;
  listeners: Set<() => void>;
}

declare global {
  var __piWebExtUI: ExtUiStore | undefined;
}

function getStore(): ExtUiStore {
  // 本模块挂在 globalThis 上跨 HMR 存活；结构升级（如 v2 加 staticItems）后，
  // 旧版本留下的残缺 store 过不了纯 truthy 检查 → getExtUiItems 的 Object.keys
  // 炸 "Cannot convert undefined or null to object"（SSR 直接崩）。此处逐字段补齐。
  const s = globalThis.__piWebExtUI ?? (globalThis.__piWebExtUI = {} as ExtUiStore);
  s.items ??= {};
  s.staticItems ??= {};
  s.metas ??= {};
  s.version ??= 0;
  s.listeners ??= new Set();
  return s;
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

// ── 扩展稳定顺序（manifest 清单序）：client bundle 的注册完成序随机（启动批量与
//    slot 按需加载两条 materialize 流水线交错，谁先到 register 谁先进 store），
//    store 内 items 数组序不能作为展示序——顶栏/状态条等按数组序渲染的插槽
//    每次加载顺序都会变。host 拉到 manifest 后写入清单序（≈ 安装/注册顺序，稳定），
//    getExtUiItems 返回前按它稳定排序；清单外的扩展（动态注册）保持注册序排最后。──
let extOrder: Record<string, number> = {};

/** 写入扩展稳定顺序（manifest extensions 数组序）。变化时 bump（重排已注册 items）。 */
export function setExtOrder(ids: string[]): void {
  const next: Record<string, number> = {};
  for (let i = 0; i < ids.length; i++) next[ids[i]] = i;
  const prevKeys = Object.keys(extOrder);
  const changed =
    prevKeys.length !== Object.keys(next).length ||
    prevKeys.some((k) => extOrder[k] !== next[k]);
  extOrder = next;
  if (changed) bump(); // 推进 version：getExtUiItems 缓存失效 → 按新序重排
}

/** 扩展展示排序键：清单序优先；未知/无 extId 排最后（保持注册序）。 */
function extSortKey(extId: string | undefined): number {
  if (extId === undefined) return Number.MAX_SAFE_INTEGER - 1;
  return extOrder[extId] ?? Number.MAX_SAFE_INTEGER;
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

// ── [懒加载 v2] manifest 静态条目（零 bundle 入口）──
// 数据在 manifest（id/label/title/icon/feature，可序列化）、行为在 client（onClick
// 物化后由注册条目提供）。宿主在 client 物化前渲染静态条目；点击 → 转发器物化 →
// 注册条目按 (extId,id) 覆盖静态条目（同 id 顶格，顶栏排序/⋯菜单/按钮外观无缝切换）。
// 详见 docs/aiti-ext-lazy-loading-plan.md §4.3。

/** 静态条目点击转发器（ExtSlots loadExtensions 时注入一次；本 store 不反向依赖 loader）。
 *  slot 供转发器回查注册条目所在插槽；ev 为原始点击事件（物化后转发给注册条目 onClick）。 */
let staticClickHandler: ((extId: string, itemId: string, slot: ExtSlotName, ev?: unknown) => Promise<void>) | null = null;

export function setStaticClickHandler(fn: ((extId: string, itemId: string, slot: ExtSlotName, ev?: unknown) => Promise<void>) | null): void {
  staticClickHandler = fn;
}

/** 静态条目 pending 态（key `extId\0id`）——转发器物化期间置位，按钮显示加载态 + 防连点。 */
const staticPending = new Set<string>();

/** 转发器专用：翻转某静态条目 pending 态并 bump（渲染层即时反映）。 */
export function setStaticItemPending(extId: string, itemId: string, pending: boolean): void {
  const key = `${extId}\u0000${itemId}`;
  if (pending === staticPending.has(key)) return;
  if (pending) staticPending.add(key);
  else staticPending.delete(key);
  bump();
}

/**
 * 注册某扩展在某插槽的静态条目（manifest ui[slot][] 拉取后调用；覆盖写——同扩展
 * 同插槽旧声明整组替换，与 manifest 恒一致）。条目 id 为扩展内 raw id，合并输出时
 * 呈现复合 id「extId:rawId」（与注册条目 id 规则一致，消费方零感知）。
 */
export function registerStaticItems(
  slot: ExtSlotName,
  items: (ExtUiItem & { meta?: ExtUiItemRegistered["meta"] })[],
  extId: string,
): void {
  const store = getStore();
  const built: ExtUiItemRegistered[] = items.map((decl) => {
    const compositeId = `${extId}:${decl.id}`;
    return {
      ...decl,
      id: compositeId,
      extId,
      static: true,
      meta: {
        label: decl.meta?.label ?? decl.label,
        title: decl.meta?.title ?? decl.title,
        badge: decl.meta?.badge ?? decl.badge,
        noMenuLabel: decl.meta?.noMenuLabel,
        icon: decl.meta?.icon ?? decl.icon,
        onClick: (e?: unknown) => {
          void Promise.resolve(staticClickHandler?.(extId, compositeId, slot, e)).catch(() => {});
        },
      },
    };
  });
  const prev = (store.staticItems[slot] ?? []).filter((it) => it.extId !== extId);
  const next = [...prev, ...built];
  const cur = store.staticItems[slot] ?? [];
  store.staticItems[slot] = next;
  if (next.length !== cur.length || next.some((it, i) => it !== cur[i])) bump();
}

/** 清除不在 activeIds 里的静态条目（manifest 重拉后调用；与 pruneDeclaredSlots 同点）。 */
export function pruneStaticItems(activeIds: Iterable<string>): void {
  const store = getStore();
  const active = new Set(activeIds);
  let changed = false;
  for (const slot of Object.keys(store.staticItems) as ExtSlotName[]) {
    const cur = store.staticItems[slot] ?? [];
    const next = cur.filter((it) => it.extId !== undefined && active.has(it.extId));
    if (next.length !== cur.length) {
      store.staticItems[slot] = next;
      changed = true;
    }
  }
  if (changed) bump();
}

/** 清除某扩展在全部插槽的静态条目（扩展从懒翻回即时后调用——静态入口随之退役，
 *  不清则注册条目到场后仍可能残留幽灵按钮/占位）。 */
export function removeStaticItems(extId: string): void {
  const store = getStore();
  let changed = false;
  for (const slot of Object.keys(store.staticItems) as ExtSlotName[]) {
    const cur = store.staticItems[slot] ?? [];
    const next = cur.filter((it) => it.extId !== extId);
    if (next.length !== cur.length) {
      store.staticItems[slot] = next;
      changed = true;
    }
  }
  if (changed) bump();
}

const NO_UI_ITEMS: ExtUiItemRegistered[] = [];

// 读取时按 feature 门控过滤（带缓存保引用稳定——快照稳定性要求，见 NO_UI_ITEMS 注释）。
// 缓存键含 store 实例 + version：feature 变更经 patchExtFeature → bump() 推进 version；
// 测试/HMR 里 globalThis 重置换新 store 时实例不同也自然失效。
let gatedCache: { store: ExtUiStore; version: number; items: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>> } | null = null;

// [懒加载 v2] 静态/注册条目 id 不对齐告警（双按钮风险，§7-R1）——每 (slot,extId,id) 只 warn 一次。
const staticIdMismatchWarned = new Set<string>();

export function getExtUiItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  const store = getStore();
  if (!gatedCache || gatedCache.store !== store || gatedCache.version !== store.version) {
    const next: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>> = {};
    const slotKeys = new Set([...Object.keys(store.items), ...Object.keys(store.staticItems)] as ExtSlotName[]);
    for (const s of slotKeys) {
      const registered = store.items[s] ?? [];
      const statics = store.staticItems[s] ?? [];
      // [懒加载 v2] 合并：注册条目按 (extId,id) 覆盖静态条目——带 render/onClick 的注册
      // 条目到场后静态条目自然退场（物化前后同 id，顶栏排序/⋯菜单/按钮无缝切换）。
      let merged = registered;
      if (statics.length > 0) {
        const regKeys = new Set(registered.map((it) => `${it.extId ?? ""}\u0000${it.id}`));
        const tail = statics.filter((st) => !regKeys.has(`${st.extId ?? ""}\u0000${st.id}`));
        if (tail.length > 0) {
          merged = [...registered, ...tail];
          // dev 断言：同扩展在该插槽已有注册条目但无一与静态 id 对齐 → 双按钮风险
          for (const st of tail) {
            const hasOther = registered.some((it) => it.extId === st.extId);
            const wkey = `${s}\u0000${st.extId ?? ""}\u0000${st.id}`;
            if (hasOther && !staticIdMismatchWarned.has(wkey)) {
              staticIdMismatchWarned.add(wkey);
              console.warn(`[ext] static/registered item id mismatch in slot "${s}" for ${st.extId}: static "${st.id}" has no matching registered item — check ui declaration vs ctx.registerItems id (double-button risk)`);
            }
          }
        }
        // pending 态注入（新对象身份仅在翻转时产生，渲染层经 bump 重取快照）
        merged = merged.map((it) => (it.static && it.extId !== undefined && staticPending.has(`${it.extId}\u0000${it.id}`) ? { ...it, pending: true } : it));
      }
      // 先 feature 门控过滤，再按 manifest 清单序稳定排序（注册完成序随机，见
      // setExtOrder 注释）。带原索引兜底：同扩展内保持注册序，且不依赖引擎稳定排序。
      const filtered = merged.filter((it) => !(it.feature && it.extId && !getExtFeature(it.extId, it.feature)));
      next[s] = filtered
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => (extSortKey(a.it.extId) - extSortKey(b.it.extId)) || (a.idx - b.idx))
        .map((x) => x.it);
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
