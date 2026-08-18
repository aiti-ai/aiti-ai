/**
 * ExtSlots — client-side extension surface.
 *
 * - ExtSlotsProvider fetches /api/extensions/manifest, dynamically imports each
 *   extension's client bundle (prebuilt ESM) and calls its `register(ctx)`.
 * - <ExtSlot name=.../> renders every item an extension registered for that
 *   slot, passing currentSession (and any extra props) through.
 *
 * The client bundle never imports react itself: the host passes `h` (createElement)
 * and hooks through ctx, guaranteeing a single React instance. Extension
 * components are plain functions of (props) using ctx.h / ctx.useState etc.
 */
"use client";

import { createElement, memo, useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { apiUrl } from "@/lib/base-path";
import { getHostApi } from "@/lib/ext/host-api";
import type { ExtSlotName, ExtSlotProps, ParagraphClickHandler } from "@/lib/ext/types";
import {
  getExtMetas,
  getExtUiItems,
  registerExtMetas,
  disposeExtUiItems,
  registerExtUiItems,
  removeExtUiItems,
  subscribeExtUi,
  type ExtMeta,
  type ExtRenderProps,
  type ExtUiItemRegistered,
} from "@/lib/ext-ui-store";
import {
  entryOf,
  getBootGraph,
  immediateEntries,
  isImmediateEntry,
  materialize,
  materializedIds,
  pendingForSlot,
  prefetch,
  prefetchedIds,
  pruneDeclaredSlots,
  reconcileGraph,
  registerDeclaredSlots,
  setBootGraph,
} from "./ext-client-loader";
import type { PiWebBootGraph } from "@/lib/ext/client-modules";

/** The register(ctx) surface handed to a client bundle. */
export interface ExtClientContext {
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useRef: typeof useRef;
  useCallback: typeof useCallback;
  useMemo: typeof useMemo;
  /**
   * Translate using the extension's own i18n table (from the manifest).
   * 类型契约：扩展在 LocaleNamespaceMap 声明 key 表后可获得 key 检查；未声明
   * 时退化为 string（向后兼容）。
   */
  t(key: string, params?: Record<string, string | number>): string;
  apiUrl(path: string): string;
  registerItems(slot: ExtSlotName, items: Array<{ id: string; render: (props: ExtRenderProps) => ReactNode; meta?: Record<string, unknown> }>): void;
  /** 注册时返回 disposer：调用即精确移除本次注册（DSH effect 语义，HMR 反卷用）。 */
  disposeItems(slot: ExtSlotName, ids: string[]): void;
  /** 注册聊天输入钩子（aiti-devtools：发送前 [元素N]/[回答N]/[错误N] 替换 + 收集候选元素） */
  registerChatHook(hook: { preSend?: (text: string) => { text?: string; elements?: unknown[] } | null }): void;
  /** 程序化发送一条消息（与用户输入同链路：preSend 钩子生效；空闲直发，流式按 mode 插队/排队；不清空输入框） */
  sendChatMessage(text: string, mode: "steer" | "followUp"): void;
  /** 注册消息段落点击接管 handler（消息点击识别薄宿主：core 广播段落点击事件，弹层 UI 全在扩展侧） */
  registerParagraphClick(handler: ParagraphClickHandler): void;
  /** 主题条目注册（扩展间间接耦合）：发布条目到抽象主题（如 "msg-popover-action"），
   *  返回 disposer。主题 id + 载荷结构由消费方定义（core 不解释内容）。 */
  registerTopicItem<T>(topic: string, item: T): () => void;
  /** 同步读取主题全部条目（消费方在交互时刻调用）。 */
  getTopicItems<T>(topic: string): T[];
  /** 打开文件标签页（宿主公共接口，同步调用；返回 void/Promise） */
  openFile?(path: string, fileName?: string): void | Promise<void>;
  /** 侧栏文件树定位目录 */
  revealDir?(absPath: string): void | Promise<void>;
  /** 输入框追加文本不发送（引用回复预填用） */
  appendText?(text: string): void | Promise<void>;
  /** 触发宿主侧扩展重载（拉新 manifest + 图对账 + 反卷 materialize）——扩展管理器场景
   *  （服务端热重载后刷新已安装/启停变更；optional 兼容旧宿主）。 */
  reloadExtensions?(): Promise<{ invalidated: string[] }>;
  /** client loader 当前状态（materialized / prefetched 的扩展 id）——扩展管理界面展示用。 */
  extLoaderState?(): { materialized: string[]; prefetched: string[] };
}

/** 聊天输入钩子 store（扩展注册；ChatInput 发送时调用） */
interface ChatHook { preSend?: (text: string) => { text?: string; elements?: unknown[] } | null }
const chatHooks: ChatHook[] = [];
const EMPTY_CHAT_HOOKS: ChatHook[] = [];
const chatHookListeners = new Set<() => void>();
function registerChatHooks(hook: ChatHook) {
  chatHooks.push(hook);
  for (const l of chatHookListeners) l();
}
export function useChatHooks(): ChatHook[] {
  return useSyncExternalStore(
    (cb) => { chatHookListeners.add(cb); return () => { chatHookListeners.delete(cb); }; },
    () => chatHooks,
    () => EMPTY_CHAT_HOOKS,
  );
}

// ── 主题条目注册表（扩展间间接耦合：提供方 registerTopicItem 发布条目，消费方
//    getTopicItems 同步读取。core 只做中转（Map<topic, Set<item>>），不解释内容——
//    主题 id + 载荷结构是扩展间契约，由消费方（如 aiti-msg-smart 的
//    "msg-popover-action"）定义并文档化。加载时序无虞：条目持久，消费方在交互
//    时刻读（彼时各扩展均已注册）。）──
const topicItems = new Map<string, Set<unknown>>();
/** 注册主题条目；返回 disposer（精确移除本次注册）。 */
export function registerTopicItem<T>(topic: string, item: T): () => void {
  let set = topicItems.get(topic);
  if (!set) { set = new Set(); topicItems.set(topic, set); }
  set.add(item);
  return () => { set.delete(item); if (set.size === 0) topicItems.delete(topic); };
}
/** 同步读取主题全部条目（消费方在交互时刻调用；非响应式，无需订阅）。 */
export function getTopicItems<T>(topic: string): T[] {
  return Array.from(topicItems.get(topic) ?? []) as T[];
}

/** 聊天发送处理器 store（扩展 ctx.sendChatMessage 的统一出口；ChatInput mount 时注册） */
type ChatSendHandler = (text: string, mode: "steer" | "followUp") => void;
let chatSendHandler: ChatSendHandler | null = null;
export function registerChatSend(fn: ChatSendHandler | null): void {
  chatSendHandler = fn;
}
export function dispatchChatSend(text: string, mode: "steer" | "followUp"): void {
  chatSendHandler?.(text, mode);
}

// 段落点击接管 handler store（扩展注册；MarkdownBody 点击段落时广播）
const paragraphClickHandlers: ParagraphClickHandler[] = [];
const EMPTY_PCLICK: ParagraphClickHandler[] = [];
const paragraphClickListeners = new Set<() => void>();
function registerParagraphClick(h: ParagraphClickHandler) {
  paragraphClickHandlers.push(h);
  for (const l of paragraphClickListeners) l();
}
export function useParagraphClickHandlers(): ParagraphClickHandler[] {
  return useSyncExternalStore(
    (cb) => { paragraphClickListeners.add(cb); return () => { paragraphClickListeners.delete(cb); }; },
    () => paragraphClickHandlers,
    () => EMPTY_PCLICK,
  );
}

interface ManifestExt {
  id: string;
  name: string;
  version: string;
  clientUrl: string | null;
  ui: { i18n?: Record<string, Record<string, string>>; provides?: string[] } | null;
  icon?: string | null;
}

let loadStarted = false;
let reloadInFlight: Promise<{ invalidated: string[] }> | null = null;

function interpolate(message: string, params: Record<string, string | number> = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

declare global {
  interface Window { __extDebug?: string[]; }
}

/** 为某扩展构造 register ctx（i18n 表 + 宿主 hooks + 注册 API）。 */
function makeClientContext(ext: ManifestExt): ExtClientContext {
  const table = ext.ui?.i18n?.["zh-CN"] ?? ext.ui?.i18n?.en ?? {};
  const ctx: ExtClientContext = {
    h: createElement,
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    t: (key, params) => interpolate(table[key] ?? key, params),
    apiUrl,
    registerItems: (slot, items) => {
      registerExtUiItems(
        slot,
        items.map((it) => ({ id: `${ext.id}:${it.id}`, render: it.render, meta: it.meta })),
        ext.id,
      );
    },
    disposeItems: (slot, ids) => {
      disposeExtUiItems(slot, ext.id, ids.map((raw) => `${ext.id}:${raw}`));
    },
    registerChatHook: (hook) => registerChatHooks(hook),
    sendChatMessage: (text, mode) => dispatchChatSend(text, mode),
    registerParagraphClick: (h) => registerParagraphClick(h),
    registerTopicItem: (topic, item) => registerTopicItem(topic, item),
    getTopicItems: (topic) => getTopicItems(topic),
    // 宿主公共接口（AppShell 经 registerHostApi 注册原样能力；fileName 兜底适配在框架层）
    openFile: (path, fileName) => getHostApi().openFile?.(path, fileName ?? path.split("/").pop() ?? path),
    revealDir: (absPath) => getHostApi().revealDir?.(absPath),
    appendText: (text) => getHostApi().appendText?.(text),
    reloadExtensions: () => reloadExtensions(),
    extLoaderState: () => ({ materialized: materializedIds(), prefetched: prefetchedIds() }),
  };
  return ctx;
}

/** AppShell 注入的宿主能力（经 ExtSlotsProvider props；makeClientContext 包装下发）。 */
export function ExtSlotsProvider({ children }: { children: ReactNode }) {
  const [, force] = useState(0);
  useEffect(() => {
    void loadExtensions();
    const unsub = subscribeExtUi(() => force((v) => v + 1));
    return unsub;
  }, []);
  return <>{children}</>;
}

/** 拉取 manifest 并刷新 client 侧缓存（manifestCache / declaredSlots / metas）。
 *  返回 { extensions, graph }；失败返回 null（不抛）。reload 后必须重拉——
 *  否则新安装扩展的元数据/i18n/声明的插槽停留在旧值，client bundle 加载不到。 */
async function fetchManifestData(): Promise<{ extensions: ManifestExt[]; graph: PiWebBootGraph } | null> {
  try {
    const res = await fetch(apiUrl("/api/extensions/manifest"), { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { extensions: ManifestExt[]; graph: PiWebBootGraph };
    // manifest 元数据（name/icon/provides）→ 宿主 UI 标注扩展身份（顶栏自定义面板等）、
    // 并驱动内置 UI 的能力接管开关（useExtProvides）
    const metas: Record<string, ExtMeta> = {};
    for (const ext of data.extensions) {
      manifestCache.set(ext.id, ext);
      metas[ext.id] = { name: ext.name, icon: ext.icon ?? null, provides: ext.ui?.provides };
      // 按需加载登记：声明了哪些 UI 插槽（ui 定义里非空数组的 slot 键）。
      registerDeclaredSlots(ext.id, ext.ui ? Object.keys(ext.ui).filter((k) => k !== "i18n" && k !== "provides" && k !== "clientDependsOn") : []);
    }
    registerExtMetas(metas);
    // 已卸载/禁用的扩展不再出现在 manifest——清除其残留的 slot 声明，
    // 防止 pendingForSlot 把不存在的扩展列为按需加载候选。
    pruneDeclaredSlots(data.extensions.map((e) => e.id));
    return data;
  } catch (e) {
    console.error("[ext] failed to fetch extension manifest:", e);
    return null;
  }
}

/** 首次加载：拉 manifest → 写元数据 + 启动图 → 按图 prefetch + materialize。 */
async function loadExtensions(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const data = await fetchManifestData();
  if (!data) return;
  setBootGraph(data.graph ?? { rev: "", entries: [] });
  // 两阶段加载：prefetch 立即项（注册入口就绪，副作用未发生）→ materialize 立即项
  // （register(ctx) 调用，副作用发生）。immediately:false 的懒加载扩展既不预取也不
  // materialize——首次渲染到它声明的插槽时由 useExtSlotItems 按需触发（下载+注册）。
  // 失败隔离：单扩展失败不影响其他。
  const immediate = immediateEntries(data.graph ?? { rev: "", entries: [] });
  await Promise.allSettled(immediate.map((e) => prefetch(e.id)));
  for (const entry of immediate) {
    const ext = manifestCache.get(entry.id) ?? data.extensions.find((e) => e.id === entry.id);
    if (!ext) continue; // 图里有条目但 manifest 无对应扩展——跳过，不构造 ctx
    await materialize(entry.id, () => makeClientContext(ext));
  }
}

/** HMR 精确反卷：POST reload（服务端 shutdown→loadAll→startAll）→ 补拉 manifest 刷新
 *  client 缓存（新安装扩展的元数据/i18n/声明的插槽）→ 以最新图比 rev 只反卷变更扩展。 */
export async function reloadExtensions(): Promise<{ invalidated: string[] }> {
  if (reloadInFlight) return reloadInFlight;
  reloadInFlight = (async () => {
    try {
      const res = await fetch(apiUrl("/api/extensions/reload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`reload failed: ${res.status}`);
      // 服务端热重载成功后重拉 manifest——manifestCache/declaredSlots/metas 是首次加载
      // 时的快照，不刷新的话新安装扩展找不到元数据，client bundle 不会加载（B）。
      const data = await fetchManifestData();
      if (!data) return { invalidated: [] };
      const graph = data.graph ?? { rev: "", entries: [] };
      const oldGraph = getBootGraph();
      const invalidated = reconcileGraph(graph, (extId) => removeExtUiItems(extId));
      // 新增 entry（enable/install 后回到图里）也要加载——reconcileGraph 只反卷变更/移除项。
      const added = graph.entries
        .filter((e) => !oldGraph.entries.some((o) => o.id === e.id))
        .map((e) => e.id);
      // 反卷 + 新增的扩展重新 prefetch + materialize。懒加载（immediately:false）项保持
      // 懒——仅反卷清掉旧注册，新 bundle 留给插槽按需触发（与启动批量一致）。
      for (const id of [...invalidated, ...added]) {
        const ext = manifestCache.get(id);
        const entry = entryOf(id);
        if (!ext || !entry || !isImmediateEntry(entry)) continue;
        await prefetch(id);
        await materialize(id, () => makeClientContext(ext));
      }
      return { invalidated };
    } catch (e) {
      console.error("[ext] reload failed:", e);
      return { invalidated: [] };
    } finally {
      reloadInFlight = null;
    }
  })();
  return reloadInFlight;
}

/** manifest 缓存（reload 反卷后重新 materialize 需要原 ext 元数据/i18n 表）。 */
const manifestCache = new Map<string, ManifestExt>();

/** Read registered items for a slot, re-rendering when the store changes. */
export function useExtSlotItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  const [items, setItems] = useState<ExtUiItemRegistered[]>(() => getExtUiItems(slot));
  useEffect(() => {
    const update = () => setItems(getExtUiItems(slot));
    update(); // pick up items registered before this hook mounted
    return subscribeExtUi(update);
  }, [slot]);

  // 按需加载：声明了该 slot 但尚未 materialize 的扩展 → 首次渲染时触发
  // materialize（副作用 = register(ctx)），完成后 store bump → 重渲染。
  useEffect(() => {
    const pending = pendingForSlot(slot);
    if (pending.length === 0) return;
    let alive = true;
    void (async () => {
      for (const id of pending) {
        const ext = manifestCache.get(id);
        if (!ext) continue;
        await materialize(id, () => makeClientContext(ext));
      }
      if (alive) setItems(getExtUiItems(slot)); // materialize → store bump → 拉最新
    })();
    return () => { alive = false; };
  }, [slot]);

  return items;
}

/** extId → manifest 元数据（name/icon），随 store 版本变化重渲染。 */
export function useExtMetas(): Record<string, ExtMeta> {
  const [metas, setMetas] = useState<Record<string, ExtMeta>>(() => getExtMetas());
  useEffect(() => {
    const update = () => setMetas(getExtMetas());
    update();
    return subscribeExtUi(update);
  }, []);
  return metas;
}

/** 所有已加载扩展声明接管的能力名集合（manifest ui.provides 的并集）。
 *  内置 UI 用它决定是否让位：如侧栏删除按钮在有人声明 session-delete 时隐藏。 */
export function useExtProvides(): Set<string> {
  const metas = useExtMetas();
  return useMemo(() => {
    const provides = new Set<string>();
    for (const meta of Object.values(metas)) {
      for (const p of meta.provides ?? []) provides.add(p);
    }
    return provides;
  }, [metas]);
}

export function ExtSlot<S extends ExtSlotName>({
  name,
  currentSession = null,
  extra,
}: {
  name: S;
  currentSession?: { id: string; cwd: string; name?: string } | null;
  /** 插槽额外 props——类型从 ExtSlotContractMap 契约取（未声明 → 宽松对象）。 */
  extra?: ExtSlotProps<S>;
}) {
  const items = useExtSlotItems(name);
  return (
    <>
      {items.map((it) => (
        <it.render key={it.id} currentSession={currentSession} {...(extra as Record<string, unknown>)} />
      ))}
    </>
  );
}

/** Convenience: memoized slot for use inside tight render loops (rows). */
export const MemoExtSlot = memo(ExtSlot, (prev, next) =>
  prev.name === next.name && prev.currentSession?.id === next.currentSession?.id
);
