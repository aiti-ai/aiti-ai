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

import { Component, createElement, memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "@/lib/base-path";
import { getHostApi, type OpenFileOptions, type OpenFolderOptions } from "@/lib/ext/host-api";
import { registerComposerEnhancement } from "@/lib/composer/bus";
import type { ComposerEnhancement, RecoveryItemsProvider } from "@/lib/composer/types";
import type { QueuePanelController } from "@/lib/composer/queue-api";
import { registerRecoveryItemsProvider } from "@/lib/composer/recovery";
import { registerDraftApi } from "@/lib/composer/draft-api";
import type { DraftApi } from "@/lib/composer/draft-api";
import { registerQueuePanelController, getQueuePanelController } from "@/lib/composer/queue-api";
import type { ExtSlotName, ExtSlotProps, ParagraphClickHandler, SessionForkGate } from "@/lib/ext/types";
import { registerSessionForkGate as registerSessionForkGateBus } from "@/lib/ext/fork-gates";
import {
  getExtMetas,
  getExtUiItems,
  registerExtMetas,
  disposeExtUiItems,
  registerExtUiItems,
  removeExtUiItems,
  subscribeExtUi,
  setExtFeatures,
  patchExtFeature,
  getExtFeaturesOf,
  subscribeExtFeatures,
  hasExtRender,
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
  useLayoutEffect: typeof useLayoutEffect;
  useRef: typeof useRef;
  useCallback: typeof useCallback;
  useMemo: typeof useMemo;
  /**
   * Render children into a DOM node outside the extension's host position
   * (React portal, typically document.body). Needed for fixed-position
   * overlays rendered from inside transformed ancestors (e.g. the CWD picker
   * dropdown's slide animation creates a containing block that traps
   * position:fixed) — portal escapes it entirely.
   */
  createPortal: (children: ReactNode, container: Element | DocumentFragment) => ReactNode;
  /**
   * Translate using the extension's own i18n table (from the manifest).
   * 类型契约：扩展在 LocaleNamespaceMap 声明 key 表后可获得 key 检查；未声明
   * 时退化为 string（向后兼容）。
   */
  t(key: string, params?: Record<string, string | number>): string;
  apiUrl(path: string): string;
  registerItems(slot: ExtSlotName, items: Array<{ id: string; render?: (props: ExtRenderProps) => ReactNode; meta?: Record<string, unknown>; feature?: string }>): void;
  /** 注册时返回 disposer：调用即精确移除本次注册（DSH effect 语义，HMR 反卷用）。 */
  disposeItems(slot: ExtSlotName, ids: string[]): void;
  /** 注册聊天输入钩子（aiti-devtools：发送前 [元素N]/[回答N]/[错误N] 替换 + 收集候选元素） */
  registerChatHook(hook: { preSend?: (text: string) => { text?: string; elements?: unknown[] } | null }): void;
  /** 程序化发送一条消息（与用户输入同链路：preSend 钩子生效；空闲直发，流式按 mode 插队/排队；不清空输入框）
   *  images 可选：携带图片的 follow-up 排队（草稿恢复多条残留等场景） */
  sendChatMessage(text: string, mode: "steer" | "followUp", images?: { data: string; mimeType: string }[]): void;
  /** 仅入队不触发（草稿恢复「Re-queue」语义）：空闲也只进 follow-up 队列，不直发。
   *  preSend 钩子（[元素N]/[回答N]/[错误N]）同样生效；images 随队列项携带。 */
  queueFollowUp(text: string, images?: { data: string; mimeType: string }[]): void;
  /** 注册消息段落点击接管 handler（消息点击识别薄宿主：core 广播段落点击事件，弹层 UI 全在扩展侧） */
  registerParagraphClick(handler: ParagraphClickHandler): void;
  /** 注册会话 fork 前置门（aiti-git-trace 回撤前置门等）：发起 fork 前依次 await，
   *  返回 false/抛错即取消。返回 disposer（effect 返回值直接用，HMR 重载时精确移除）。 */
  registerSessionForkGate(gate: SessionForkGate): () => void;
  /** 同步读本扩展全部功能状态（extman 管理；host 已统一拉取，扩展零独立请求）。boolean feature 为布尔，string feature 为字符串值。 */
  getFeatures?(): Record<string, boolean | string>;
  /** 订阅本扩展功能状态变更（extman 改 feature 后触发；返回退订函数） */
  onFeatureChange?(cb: () => void): () => void;
  /** 主题条目注册（扩展间间接耦合）：发布条目到抽象主题（如 "msg-popover-action"），
   *  返回 disposer。主题 id + 载荷结构由消费方定义（core 不解释内容）。 */
  registerTopicItem<T>(topic: string, item: T): () => void;
  /** 同步读取主题全部条目（消费方在交互时刻调用）。 */
  getTopicItems<T>(topic: string): T[];
  /** 打开文件标签页（宿主公共接口，同步调用；返回 void/Promise） */
  openFile?(path: string, fileName?: string, options?: OpenFileOptions): void | Promise<void>;
  /** 打开文件夹标签页（右侧面板 FolderViewer；display-only，不影响 cwd） */
  openFolder?(path: string, folderName?: string, options?: OpenFolderOptions): void | Promise<void>;
  /** 侧栏文件树定位目录 */
  revealDir?(absPath: string): void | Promise<void>;
  /** 读取当前打开 tab 清单（数组序=打开序；含 kind/pinned 透传）——批量关闭/容量控制原语 */
  getFileTabs?(): { id: string; filePath: string; kind?: "file" | "folder"; pinned?: boolean }[];
  /** 关闭指定 tab（仅状态移除+激活位重排；脏确认/钉住保护由扩展负责） */
  closeFileTabs?(ids: string[]): void;
  /** 输入框追加文本不发送（引用回复预填用） */
  appendText?(text: string): void | Promise<void>;
  /** 注册 composer 增强器（值观测/会话 key 切换/发送前链式钩子；见 docs/composer-enhancement-contract.md）。
   *  返回 disposer。 */
  registerComposerEnhancement(enh: ComposerEnhancement): () => void;
  /** 程序化写值（composer 契约受控路径：state → DOM 同步 effect，tracker 同步）。
   *  返回是否真正写入（composer 未挂载时 false）。 */
  writeComposerValue?(text: string): boolean | Promise<boolean>;
  /** 完整还原草稿进输入框（文本 + 图片，raw 不跑钩子——与 core 恢复第一条一致）。
   *  返回是否真正还原（composer 未挂载时 false——调用方不应消费草稿）。 */
  restoreComposerDraft?(draft: { value: string; images: { data: string; mimeType: string }[] }): boolean | Promise<boolean>;
  /** 注册恢复项提供者（残留输入并入恢复对话框；决议经 onResolve 回流）。返回 disposer。 */
  registerRecoveryItemsProvider?(provider: RecoveryItemsProvider): () => void;
  /** 注册草稿存储 API（core 经 getDraftApi() 访问；草稿功能全部归 keeper）。 */
  registerDraftApi?(api: DraftApi): void;
  /** 注册队列面板控制器（ext → core 反向通道：core 恢复/导入解析后调用 expand）。
   *  返回 disposer。无接管时 core 兜底 banner（无折叠态），expand 为 no-op。 */
  registerQueuePanelController?(ctrl: QueuePanelController | null): () => void;
  /** 同步读当前队列面板控制器（无接管返回 null）。 */
  getQueuePanelController?(): QueuePanelController | null;
  /** 触发宿主侧扩展重载（拉新 manifest + 图对账 + 反卷 materialize）——扩展管理器场景
   *  （服务端热重载后刷新已安装/启停变更；optional 兼容旧宿主）。opts.resyncOnly：
   *  跳过 POST /reload 全量重载（调用方已在服务端重载过，如 extman ops），只补拉
   *  manifest + 反卷 client 缓存；旧宿主忽略参数降级为全量 reload。 */
  reloadExtensions?(opts?: { resyncOnly?: boolean }): Promise<{ invalidated: string[] }>;
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
type ChatSendHandler = (text: string, mode: "steer" | "followUp" | "queue", images?: { data: string; mimeType: string }[]) => void;
let chatSendHandler: ChatSendHandler | null = null;
export function registerChatSend(fn: ChatSendHandler | null): void {
  chatSendHandler = fn;
}
export function dispatchChatSend(text: string, mode: "steer" | "followUp" | "queue", images?: { data: string; mimeType: string }[]): void {
  chatSendHandler?.(text, mode, images);
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
  features?: { id: string; type?: "boolean" | "string"; label?: string; placeholder?: string; enabled: boolean; value?: string }[] | null;
}

interface ManifestData {
  extensions: ManifestExt[];
  graph: PiWebBootGraph;
  /** server 侧加载/启动失败清单（registry errors：jiti 解析错/entry 校验/startup throw）。
   *  页面打开即可见（左下角错误指示器），不必再开 extman 查 /status。 */
  failed?: { id: string; error: string }[];
}

// ---- server 侧扩展加载失败 → 前端可见 ----
// registry errors 原本只在 extman 的 /status 里能看到；现在随 manifest 带给页面，
// 注册进 ExtErrorIndicator（左下角 ⚠）。修复后 reload → failed 清单更新 → 自动消失。
const registeredLoadErrors = new Set<string>();
function syncLoadErrors(failed: { id: string; error: string }[] | undefined): void {
  const next = new Set<string>();
  for (const f of failed ?? []) {
    const key = `ext-load-${f.id}`;
    next.add(key);
    // startup/shutdown 前缀（startAll/shutdown catch）→ 标签更准确；其余为 entry 加载失败
    const label = f.error.startsWith("startup: ") ? "启动失败" : f.error.startsWith("shutdown: ") ? "关闭失败" : "加载失败";
    registerExtSlotError({
      id: key, extId: f.id, slot: "(load)", itemId: label,
      message: f.error, kind: "load", reset: () => {},
    });
  }
  for (const key of registeredLoadErrors) if (!next.has(key)) unregisterExtSlotError(key);
  registeredLoadErrors.clear();
  for (const k of next) registeredLoadErrors.add(k);
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

// 统一通知管道：extman set-feature 成功后广播 → host 原地 patch 共享 feature store →
// subscribeExtFeatures 订阅者（扩展）收到通知（不重新拉取、不轮询）。
const FEATURES_CHANGED_EVENT = "pi-web:ext-features-changed";
if (typeof window !== "undefined") {
  window.addEventListener(FEATURES_CHANGED_EVENT, (e) => {
    const d = (e as CustomEvent)?.detail;
    if (d && d.extId && d.featureId) {
      // string feature 带 value（字符串）；boolean feature 带 enabled（布尔）
      const v = (d.value !== undefined) ? d.value : (d.enabled !== false);
      patchExtFeature(String(d.extId), String(d.featureId), v as boolean | string);
    }
  });
}

/** 为某扩展构造 register ctx（i18n 表 + 宿主 hooks + 注册 API）。 */

const EMPTY_I18N_TABLE: Record<string, string> = {};

/** 语言切换事件（useI18n.setLocale 派发；扩展 client 监听它重渲染）。 */
export const LOCALE_CHANGED_EVENT = "pi-web:locale-changed";

/** 当前界面语言（localStorage pi-locale，与 useI18n 同源；缺省 en）。 */
export function currentUiLocale(): string {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v === "zh-CN" || v === "en") return v;
  } catch { /* 存储不可用时用缺省 */ }
  return "en";
}

function makeClientContext(ext: ManifestExt): ExtClientContext {
  // i18n 表按当前语言动态取（切语言后 t() 立即生效）：
  // 当前语言 → 同语言短码（zh）→ en → 任一可用表（避免只有 zh 表时 en 用户看到裸 key）。
  const ui18n = ext.ui?.i18n;
  const tableFor = (): Record<string, string> => {
    if (!ui18n) return EMPTY_I18N_TABLE;
    const loc = currentUiLocale();
    return ui18n[loc] ?? ui18n[loc.split("-")[0]] ?? ui18n.en ?? Object.values(ui18n)[0] ?? EMPTY_I18N_TABLE;
  };
  const ctx: ExtClientContext = {
    h: createElement,
    useState,
    useEffect,
    useLayoutEffect,
    useRef,
    useCallback,
    useMemo,
    createPortal: (children, container) => createPortal(children, container),
    t: (key, params) => interpolate(tableFor()[key] ?? key, params),
    apiUrl,
    registerItems: (slot, items) => {
      registerExtUiItems(
        slot,
        items.map((it) => ({
          id: `${ext.id}:${it.id}`,
          // render 可选：toolbar 声明式条目（meta.icon + meta.onClick）由宿主渲染标准按钮
          render: it.render,
          meta: it.meta,
          ...(it.feature ? { feature: it.feature } : {}),
        })),
        ext.id,
      );
    },
    disposeItems: (slot, ids) => {
      disposeExtUiItems(slot, ext.id, ids.map((raw) => `${ext.id}:${raw}`));
    },
    registerChatHook: (hook) => registerChatHooks(hook),
    sendChatMessage: (text, mode, images) => dispatchChatSend(text, mode, images),
    queueFollowUp: (text, images) => dispatchChatSend(text, "queue", images),
    registerParagraphClick: (h) => registerParagraphClick(h),
    registerSessionForkGate: (gate) => registerSessionForkGateBus(gate),
    registerTopicItem: (topic, item) => registerTopicItem(topic, item),
    getTopicItems: (topic) => getTopicItems(topic),
    getFeatures: () => getExtFeaturesOf(ext.id),
    onFeatureChange: (cb) => subscribeExtFeatures(cb),
    // 宿主公共接口（AppShell 经 registerHostApi 注册原样能力；fileName 兜底适配在框架层）
    openFile: (path: string, fileName?: string, options?: OpenFileOptions) =>
      getHostApi().openFile?.(path, fileName ?? path.split("/").pop() ?? path, options),
    openFolder: (path: string, folderName?: string, options?: OpenFolderOptions) =>
      getHostApi().openFolder?.(path, folderName ?? path.split("/").pop() ?? path, options),
    revealDir: (absPath) => getHostApi().revealDir?.(absPath),
    getFileTabs: () => getHostApi().getFileTabs?.() ?? [],
    closeFileTabs: (ids: string[]) => getHostApi().closeFileTabs?.(ids),
    appendText: (text) => getHostApi().appendText?.(text),
    registerComposerEnhancement: (enh: ComposerEnhancement) => registerComposerEnhancement(enh),
    writeComposerValue: (text: string) => getHostApi().writeComposerValue?.(text) ?? false,
    restoreComposerDraft: (draft) => getHostApi().restoreComposerDraft?.(draft) ?? false,
    registerRecoveryItemsProvider: (provider) => registerRecoveryItemsProvider(provider),
    registerDraftApi: (api) => registerDraftApi(api),
    registerQueuePanelController: (ctrl) => registerQueuePanelController(ctrl),
    getQueuePanelController: () => getQueuePanelController(),
    reloadExtensions: (opts?: { resyncOnly?: boolean }) => reloadExtensions(opts),
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
  return <>{children}<ExtErrorIndicator /></>;
}

/** 拉取 manifest 并刷新 client 侧缓存（manifestCache / declaredSlots / metas）。
 *  返回 { extensions, graph }；失败返回 null（不抛）。reload 后必须重拉——
 *  否则新安装扩展的元数据/i18n/声明的插槽停留在旧值，client bundle 加载不到。 */
async function fetchManifestData(): Promise<ManifestData | null> {
  try {
    const res = await fetch(apiUrl("/api/extensions/manifest"), { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as ManifestData;
    // manifest 元数据（name/icon/provides）→ 宿主 UI 标注扩展身份（顶栏自定义面板等）、
    // 并驱动内置 UI 的能力接管开关（useExtProvides）
    const metas: Record<string, ExtMeta> = {};
    for (const ext of data.extensions) {
      manifestCache.set(ext.id, ext);
      metas[ext.id] = { name: ext.name, icon: ext.icon ?? null, provides: ext.ui?.provides };
      // 功能状态统一写入共享 store（extman 管理；扩展经 ctx.getFeatures 读，零独立请求）
      setExtFeatures(ext.id, ext.features ? Object.fromEntries(ext.features.map((f) => [f.id, f.type === "string" ? (f.value ?? "") : (f.enabled !== false)])) : null);
      // 按需加载登记：声明了哪些 UI 插槽（ui 定义里非空数组的 slot 键）。
      registerDeclaredSlots(ext.id, ext.ui ? Object.keys(ext.ui).filter((k) => k !== "i18n" && k !== "provides" && k !== "clientDependsOn") : []);
    }
    registerExtMetas(metas);
    // 已卸载/禁用的扩展不再出现在 manifest——清除其残留的 slot 声明，
    // 防止 pendingForSlot 把不存在的扩展列为按需加载候选。
    pruneDeclaredSlots(data.extensions.map((e) => e.id));
    // server 侧加载失败 → 错误指示器（同 id 覆盖去重；修复后自动移除）
    syncLoadErrors(data.failed);
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
 *  client 缓存（新安装扩展的元数据/i18n/声明的插槽）→ 以最新图比 rev 只反卷变更扩展。
 *  opts.resyncOnly：跳过 POST /reload（调用方——extman ops——已在同一请求内完成服务端
 *  全量重载并在响应里带了最新状态；再 POST 一次是重复的全量 shutdown→loadAll→startAll，
 *  实测多花 ~4s）。这里只补拉 manifest + 反卷 client 缓存。 */
export async function reloadExtensions(opts?: { resyncOnly?: boolean }): Promise<{ invalidated: string[] }> {
  if (reloadInFlight) return reloadInFlight;
  reloadInFlight = (async () => {
    try {
      if (!opts?.resyncOnly) {
        const res = await fetch(apiUrl("/api/extensions/reload"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`reload failed: ${res.status}`);
      }
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
    const unsubUi = subscribeExtUi(update);
    // 语言切换 → 重拉 items（数组身份变化）→ 已注册的扩展 UI 重渲染（t() 读新语言表）
    window.addEventListener(LOCALE_CHANGED_EVENT, update);
    return () => { unsubUi(); window.removeEventListener(LOCALE_CHANGED_EVENT, update); };
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
    const unsubUi = subscribeExtUi(update);
    window.addEventListener(LOCALE_CHANGED_EVENT, update);
    return () => { unsubUi(); window.removeEventListener(LOCALE_CHANGED_EVENT, update); };
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

// ---- 扩展 slot 渲染错误：全局注册表 + 常驻指示器（aiti-ext-client-hardening-plan 层 3）----
// item 渲染 throw 不再放插槽内占位（插槽可能隐藏，占位看不见也操作不了）；
// 改为 boundary 静默收起 + 上报本注册表，由页面左下角常驻小按钮（有错误才显示）统一操作。
export type ExtSlotError = {
  id: string;
  extId?: string;
  slot: string;
  itemId: string;
  message: string;
  stack?: string;
  reset: () => void;   // 忽略：重试渲染（仅 render 期错误有意义；uncaught/load 为 no-op）
  kind: "render" | "uncaught" | "load";
};
const extSlotErrors = new Map<string, ExtSlotError>();
const errorListeners = new Set<() => void>();
const EMPTY_ERRORS: ExtSlotError[] = [];
let errorSnapshot: ExtSlotError[] = EMPTY_ERRORS;
function notifyErrorListeners() {
  errorSnapshot = Array.from(extSlotErrors.values());
  for (const l of [...errorListeners]) l();
}
export function registerExtSlotError(e: ExtSlotError) {
  extSlotErrors.set(e.id, e);
  notifyErrorListeners();
}
export function unregisterExtSlotError(id: string) {
  extSlotErrors.delete(id);
  notifyErrorListeners();
}
let globSeq = 0;
function findExtSlotError(extId: string, message: string): ExtSlotError | undefined {
  for (const e of extSlotErrors.values()) if (e.extId === extId && e.message === message) return e;
  return undefined;
}
function useExtSlotErrors(): ExtSlotError[] {
  return useSyncExternalStore(
    (cb) => { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; },
    () => errorSnapshot,
    () => EMPTY_ERRORS,
  );
}

/** 页面左下角常驻错误指示器：有 slot 渲染错误时显示小按钮，点开列错（复制/忽略/关闭）；无错不显示。 */
function ExtErrorIndicator() {
  const errors = useExtSlotErrors();
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; sLeft: number; sTop: number; moved: boolean; left: number; top: number } | null>(null);
  const dragMoved = useRef(false);
  const [idx, setIdx] = useState(0);
  const prevLen = useRef(0);
  // 🚑 急救 AI 状态（独立会话，不走 chat UI；原样输出）
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSid, setAiSid] = useState<string | null>(null);
  const [aiLog, setAiLog] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  // 多错误翻页：新错误到达 → 跳到最新；错误减少 → 夹紧 idx
  useEffect(() => {
    if (errors.length > prevLen.current) setIdx(errors.length - 1);
    else if (idx > errors.length - 1) setIdx(Math.max(0, errors.length - 1));
    prevLen.current = errors.length;
  }, [errors.length, idx]);
  // 全局接管扩展 client 的非 render 期 JS 错误（事件处理器/异步/Promise rejection）
  // ——boundary 只捕 render throw，这些穿透到 window.onerror/unhandledrejection
  useEffect(() => {
    const onErr = (event: ErrorEvent | PromiseRejectionEvent) => {
      const err = event instanceof ErrorEvent ? event.error : event.reason;
      const msg = (err instanceof Error ? err.message : String(err ?? "")) || "unknown error";
      const stack = err instanceof Error ? err.stack : "";
      const src = event instanceof ErrorEvent ? event.filename ?? "" : "";
      // 归属扩展：堆栈/源 URL 含 /api/extensions/<id>/；非扩展来源不接管
      const m = `${stack || ""}\n${src}`.match(/\/api\/extensions\/([^/]+)\//);
      if (!m) return;
      const extId = m[1];
      if (findExtSlotError(extId, msg)) return;  // 去重：同扩展同消息不重复堆
      registerExtSlotError({
        id: `ext-glob-${++globSeq}`,
        extId, slot: "(uncaught)", itemId: msg.slice(0, 60),
        message: msg, stack, reset: () => {}, kind: "uncaught",
      });
    };
    window.addEventListener("error", onErr as EventListener);
    window.addEventListener("unhandledrejection", onErr as EventListener);
    return () => {
      window.removeEventListener("error", onErr as EventListener);
      window.removeEventListener("unhandledrejection", onErr as EventListener);
    };
  }, []);
  // 位置持久化（localStorage）——参照 launcher fab 可移动 + 刷新恢复
  useEffect(() => {
    try {
      const s = localStorage.getItem("ext-err-btn-pos");
      if (s) { const p = JSON.parse(s); if (typeof p?.left === "number" && typeof p?.top === "number") setPos(p); }
    } catch {}
  }, []);
  // 拖拽移动（makePointerDrag 同款语义：threshold 6px 区分点击/拖、late 捕获、持久化）
  // 切换面板靠 onClick：拖动后按钮移位 → mouseup 落别处 → 不产生 click → 自然不切换；
  // 纯点击 → click 触发 → 切换。dragMoved ref 防“极小拖动仍产 click”误触。
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    dragMoved.current = false;
    dragRef.current = { sx: e.clientX, sy: e.clientY, sLeft: r.left, sTop: r.top, moved: false, left: r.left, top: r.top };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) <= 6) return;
      if (!d.moved) d.moved = true;
      dragMoved.current = true;
      const left = Math.max(4, Math.min(window.innerWidth - 40, d.sLeft + dx));
      const top = Math.max(4, Math.min(window.innerHeight - 40, d.sTop + dy));
      d.left = left; d.top = top;  // 存最终值供 up 持久化（React 重渲染异步，btnRef 此刻还是旧值）
      setPos({ left, top });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = dragRef.current; dragRef.current = null;
      if (!d?.moved) return;  // 纯点击 → 不持久化（onClick 管切换）
      try { localStorage.setItem("ext-err-btn-pos", JSON.stringify({ left: d.left, top: d.top })); } catch {}  // 持久化最终位置
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onToggle = () => {
    if (dragMoved.current) { dragMoved.current = false; return; }  // 拖动刚结束 → 不切换
    setOpen((v) => !v);
  };
  const copy = (e: ExtSlotError) => {
    const kindLabel = e.kind === "load" ? "加载失败" : e.kind === "uncaught" ? "未捕获错误" : "渲染失败";
    const text = `[ext] ${e.extId ?? "?"} ${e.kind === "load" ? kindLabel : `${e.slot}/${e.itemId} ${kindLabel}`}\n${e.message}\n\n${e.stack || ""}`;
    navigator.clipboard?.writeText(text).finally(() => {
      setCopiedId(e.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
    });
  };
  if (errors.length === 0) return null;
  const ci = Math.min(idx, errors.length - 1);
  const cur = errors[ci];
  // 🚑 急救 AI：POST /api/emergency（独立会话，含 aiti-configs 工具）；首轮自动带错误上下文
  const sendAi = async () => {
    const text = aiInput.trim();
    if (!text || aiBusy) return;
    const cwd = (window as unknown as { __piWebCwd?: string | null }).__piWebCwd;
    const kindWord = cur?.kind === "load" ? "加载失败" : "崩溃";
    const msg = aiSid ? text : `[急救上下文] 扩展 ${cur?.extId ?? "?"} ${cur?.slot}/${cur?.itemId} ${kindWord}：${cur?.message}\n堆栈：${cur?.stack || "(无)"}\n\n用户指令：${text}`;
    // 占位空 AI 消息——流式持续追加（全显示）
    setAiLog(l => [...l, { role: "user", text }, { role: "ai", text: "" }]);
    setAiInput(""); setAiBusy(true);
    const setLastAi = (updater: (t: string) => string) =>
      setAiLog(l => { const n = [...l]; const li = n.length - 1; if (li >= 0 && n[li].role === "ai") n[li] = { role: "ai", text: updater(n[li].text) }; return n; });
    try {
      const r = await fetch(apiUrl("/api/emergency"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, cwd: cwd || undefined, sessionId: aiSid || undefined, ...(aiSid ? {} : { errors: errors.map((e) => ({ message: e.message, stack: e.stack || "", extId: e.extId || "", slot: e.slot || "", itemId: e.itemId || "" })) }) }) });
      const sid = r.headers.get("x-session-id");
      if (sid) setAiSid(sid);
      const reader = r.body?.getReader();
      const dec = new TextDecoder();
      let acc = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          setLastAi(() => acc);
        }
        acc += dec.decode();
        setLastAi(() => acc);
      }
      if (!acc) setLastAi(() => "(无输出)");
    } catch (e) {
      setLastAi((t) => `${t}${t ? "\n" : ""}[网络错误] ${e instanceof Error ? e.message : String(e)}`);
    } finally { setAiBusy(false); }
  };
  const btn: Record<string, string | number> = {
    fontSize: 11, padding: "1px 6px", borderRadius: 5, cursor: "pointer",
    border: "1px solid rgba(245,158,11,0.5)", background: "transparent",
    color: "var(--text-muted, #888)", flexShrink: 0, lineHeight: 1.4,
  };
  return (
    <>
      <button
        ref={btnRef}
        onPointerDown={onPointerDown}
        onClick={onToggle}
        title={`扩展错误（${errors.length}）— 点击查看 / 可拖动`}
        style={{
          position: "fixed",
          left: pos ? pos.left : 12,
          top: pos ? pos.top : undefined,
          bottom: pos ? undefined : 64,
          zIndex: 2147483600,
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "4px 10px", borderRadius: 9, cursor: "grab",
          touchAction: "none",
          fontSize: 12, fontWeight: 700, color: "#fff",
          background: "#f59e0b", border: "1px solid rgba(0,0,0,0.2)",
          boxShadow: "0 2px 10px rgba(245,158,11,0.45)",
        }}
      >
        ⚠ {errors.length}
      </button>
      {open && errors.length > 0 && (
        <div
          data-ext-float="1"
          data-ext-float-autoh="1"
          data-ext-float-w="460"
          style={{
            position: "fixed",
            ...(pos
              ? (pos.top < window.innerHeight / 2
                  ? { left: pos.left, top: pos.top + 32 }
                  : { left: pos.left, bottom: window.innerHeight - pos.top + 8 })
              : { left: 12, bottom: 100 }),
            zIndex: 2147483600,
            maxWidth: 480, minWidth: 300, maxHeight: "85vh", overflowY: "auto",
            background: "var(--bg-panel, #1a1a1a)",
            border: "1px solid rgba(245,158,11,0.5)", borderRadius: 10,
            boxShadow: "0 14px 44px rgba(0,0,0,0.5)",
            padding: 8, display: "flex", flexDirection: "column", gap: 6,
          }}
        >
          {/* 顶栏：标题+翻页+动作按钮全归此处（删底栏重复）；首个子元素=aiti-float 拖拽把手。
              data-ext-float-autoh="1"：高度不固定不持久化（随内容自适应），保留 aiti-float 的
              拖拽/宽度缩放/持久化/最大化；不写 overflow:hidden——面板自己的 maxHeight 85vh +
              overflowY auto 生效（AI 面板开时弹窗自动撑开，超 85vh 则内部滚动）。 */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted, #aaa)", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>扩展错误</span>
            {errors.length > 1 ? (
              <>
                <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={ci === 0} title="上一条" style={{ ...btn, opacity: ci === 0 ? 0.4 : 1 }}>‹</button>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{ci + 1}/{errors.length}</span>
                <button onClick={() => setIdx((i) => Math.min(errors.length - 1, i + 1))} disabled={ci === errors.length - 1} title="下一条" style={{ ...btn, opacity: ci === errors.length - 1 ? 0.4 : 1 }}>›</button>
              </>
            ) : null}
            <span style={{ marginLeft: "auto" }} />
            <button onClick={() => copy(cur)} title="复制完整错误（含堆栈）" style={btn}>{copiedId === cur.id ? "已复制 ✓" : "复制"}</button>
            {cur.kind === "render" && (
              <button onClick={() => { unregisterExtSlotError(cur.id); cur.reset(); }} title="忽略：重试渲染（错误若持续会重新捕获）" style={btn}>忽略</button>
            )}
            <button onClick={() => setAiOpen(v => !v)} title="急救 AI：独立会话修复此错误（含 aiti-configs 工具）" style={btn}>🚑</button>
            <button onClick={() => setOpen(false)} title="关闭：收起面板（错误保留）" style={btn}>✕</button>
          </div>
          {/* 内容区：flex:1 + minHeight:0 + overflowY auto（aiti-float 约定：标题栏自然高 + 内容区 flex:1 自己滚）——最大化/缩放时内容跟随高度，不撑破/不空白 */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {cur && (
            <div
              key={cur.id}
              style={{
                flex: 1, minHeight: 0,
                display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: "var(--text, #eee)",
                background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)",
                borderRadius: 7, padding: "6px 8px",
              }}
            >
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", lineHeight: 1.5 }} title={cur.stack || cur.message}>
                <strong style={{ fontWeight: 700, color: "#f59e0b" }}>{cur.extId ?? "?"}</strong>{cur.kind === "uncaught" ? " · 未捕获" : cur.kind === "load" ? ` · ${cur.itemId}` : `/${cur.itemId}`}：{cur.message}
              </div>
              {cur.stack && (
                <pre style={{ margin: 0, maxHeight: 140, overflow: "auto", fontSize: 11, lineHeight: 1.45, color: "var(--text, #e8e8e8)", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", background: "rgba(0,0,0,0.06)", border: "1px solid var(--border, #444)", padding: "5px 7px", borderRadius: 5 }}>
                  {cur.stack}
                </pre>
              )}
              {/* 动作按钮已移至顶栏；此处不再重复底栏 */}
              {aiOpen && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
                  {/* AI 输出区：flex:1 随高度增长（≥10 行 minHeight 160），发送前显示占位提示 */}
                  <div style={{ flex: 1, minHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "2px 0" }}>
                    {aiLog.length === 0 && !aiBusy ? <span style={{ fontSize: 10, color: "var(--text-dim, #6b7280)", lineHeight: 1.5 }}>发送后 AI 输出原样显示于此（可多轮）。首轮自动带上错误上下文。</span> : null}
                    {aiLog.map((m, i) => (
                      <div key={i} style={{ fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", lineHeight: 1.4, color: m.role === "user" ? "var(--text-muted, #888)" : "var(--text, #eee)", borderLeft: `2px solid ${m.role === "user" ? "var(--border, #444)" : "#f59e0b"}`, paddingLeft: 5 }}>{m.text}</div>
                    ))}
                    {aiBusy && <div style={{ fontSize: 10, color: "var(--text-muted, #888)" }}>思考中…</div>}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <input value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } }} placeholder="急救指令（Enter 发送）…" disabled={aiBusy} style={{ flex: 1, fontSize: 11, padding: "3px 6px", background: "var(--bg, #1a1a1a)", color: "var(--text, #eee)", border: "1px solid var(--border, #444)", borderRadius: 4, outline: "none" }} />
                    <button onClick={sendAi} disabled={aiBusy || !aiInput.trim()} style={btn}>{aiBusy ? "…" : "发送"}</button>
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      )}
    </>
  );
}

let ebSeq = 0;
/** 扩展 item 渲染错误边界（aiti-ext-client-hardening-plan 层 3）。
 *  item 组件渲染 throw（如 .mjs 里 TS 残留的 ReferenceError）静默收起（render null），
 *  不冒泡打崩整页（crash-rescue §4.2：sidebar/composerTools 等插槽无祖先 boundary，
 *  崩则穿透 root）。错误上报全局注册表，由 ExtErrorIndicator 常驻按钮统一操作。 */
class ExtItemBoundary extends Component<
  { extId?: string; slot: string; itemId: string; children: ReactNode },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  private bid = `ext-eb-${++ebSeq}`;
  private mounted = true;
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error) {
    const { extId, slot, itemId } = this.props;
    console.error(`[ext] ${extId ?? "?"} item ${slot}/${itemId} 渲染失败（已静默收起，左下角指示器可操作）:`, err);
    registerExtSlotError({
      id: this.bid,
      extId, slot, itemId,
      message: err.message,
      stack: err.stack,
      reset: () => { if (this.mounted) this.setState({ err: null }); },
      kind: "render",
    });
  }
  componentWillUnmount() {
    this.mounted = false;
    if (this.state.err) unregisterExtSlotError(this.bid);
  }
  render() {
    if (this.state.err) return null;
    return this.props.children;
  }
}

export function ExtSlot<S extends ExtSlotName>({
  name,
  currentSession = null,
  extra,
}: {
  name: S;
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  /** 插槽额外 props——类型从 ExtSlotContractMap 契约取（未声明 → 宽松对象）。 */
  extra?: ExtSlotProps<S>;
}) {
  const items = useExtSlotItems(name)
    // render 可选（toolbar 声明式条目归宿主渲染）；其余插槽只消费带 render 的条目
    .filter(hasExtRender);
  // 框架级标注扩展身份：只在「弹窗类」插槽（dialogs/pages，都是 position:fixed 覆盖层）
  // 给每个 item 包一层 display:contents 的 div，盖上 data-ext-id/data-ext-slot/data-ext-item——
  // 不产生盒子、不影响布局（fixed 定位子元素照常脱离），但 DOM 上可被外部脚本（aiti-helper
  // 全局弹窗 AI 按钮）用 closest('[data-ext-id]') 反查到 owning 扩展。
  // 只限 dialogs/pages：sidebar/sidebarFooter/chatInputTop/userMessageActions 等内联布局插槽
  // 不包（display:contents 仍会破坏它们的 `>` 直系子代 CSS 与 flex 子项语义）。
  const stamp = name === "dialogs" || name === "pages";
  if (!stamp) {
    return (
      <>
        {items.map((it) => (
          <ExtItemBoundary key={it.id} extId={it.extId} slot={name} itemId={it.id}>
            <it.render currentSession={currentSession} {...(extra as Record<string, unknown>)} />
          </ExtItemBoundary>
        ))}
      </>
    );
  }
  return (
    <>
      {items.map((it) => (
        <div
          key={it.id}
          data-ext-id={it.extId ?? undefined}
          data-ext-slot={name}
          data-ext-item={it.id}
          style={{ display: "contents" }}
        >
          <ExtItemBoundary extId={it.extId} slot={name} itemId={it.id}>
            <it.render currentSession={currentSession} {...(extra as Record<string, unknown>)} />
          </ExtItemBoundary>
        </div>
      ))}
    </>
  );
}

/** Convenience: memoized slot for use inside tight render loops (rows). */
export const MemoExtSlot = memo(ExtSlot, (prev, next) =>
  prev.name === next.name && prev.currentSession?.id === next.currentSession?.id
);
