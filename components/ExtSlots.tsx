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

import { Component, createElement, memo, forwardRef, createContext, useContext, useReducer, useImperativeHandle, useId, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "@/lib/base-path";
import { getHostApi, type OpenFileOptions, type OpenFolderOptions } from "@/lib/ext/host-api";
import { registerComposerEnhancement } from "@/lib/composer/bus";
import { useI18n } from "@/hooks/useI18n";
/** SidebarClone（@/ 宿主模块链）的 react 全 alias 到 host-shim——其 useI18n 的
 *  context 解析走 ctx.useContext → 这里缓存的宿主 useI18n() 快照（每渲染刷新）。
 *  hook 时机：快照更新在 ExtSlotsProvider 渲染体（合法 hook 调用），
 *  materialize（effect）只读快照，不在回调里调 hook。 */
let extI18nSnapshot: ReturnType<typeof useI18n> | null = null;
import type { ComposerEnhancement, RecoveryItemsProvider } from "@/lib/composer/types";
import type { QueuePanelController } from "@/lib/composer/queue-api";
import { registerRecoveryItemsProvider } from "@/lib/composer/recovery";
import { registerDraftApi } from "@/lib/composer/draft-api";
import type { DraftApi } from "@/lib/composer/draft-api";
import { registerQueuePanelController, getQueuePanelController } from "@/lib/composer/queue-api";
import type { ExtSlotName, ExtSlotProps, ParagraphClickHandler, SessionForkGate, ExtUiStaticSlots } from "@/lib/ext/types";
import { registerSessionForkGate as registerSessionForkGateBus } from "@/lib/ext/fork-gates";
import {
  getExtMetas,
  getExtUiItems,
  registerExtMetas,
  disposeExtUiItems,
  registerExtUiItems,
  removeExtUiItems,
  subscribeExtUi,
  extUiVersion,
  setExtFeatures,
  setExtOrder,
  patchExtFeature,
  getExtFeaturesOf,
  subscribeExtFeatures,
  hasExtRender,
  registerStaticItems,
  setStaticClickHandler,
  setStaticItemPending,
  pruneStaticItems,
  removeStaticItems,
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
  pendingForSlotAuto,
  slotDeclared,
  ensureMaterialized,
  ensureSlotMaterialized,
  INTERACTIVE_SLOTS,
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
  /** SidebarClone（宿主 SessionSidebar 复制版）经 @/ alias 引入宿主组件/hooks，
   *  这些模块的 react 全部 alias 到 host-shim —— 需在此补齐委托的真 hooks。 */
  useContext?: <T>(ctx: T) => T;
  useReducer?: (fn: (s: any, a: any) => any, init: any, initArg?: any) => [any, (a: any) => void];
  useSyncExternalStore?: (sub: () => () => void, get: () => unknown, getServer?: () => unknown) => unknown;
  useImperativeHandle?: (ref: unknown, fn: () => unknown, deps?: unknown[]) => void;
  useId?: () => string;
  createContext?: <T>(d: T) => { Provider: any; Consumer: any };
  forwardRef?: <P = {}, R = any>(fn: (props: P, ref: React.Ref<R>) => ReactNode) => any;
  memo?: <T>(fn: T) => T;
  /**
   * Render children into a DOM node outside the extension's host position
   * (React portal, typically document.body). Needed for fixed-position
   * overlays rendered from inside transformed ancestors (e.g. the CWD picker
   * dropdown's slide animation creates a containing block that traps
   * position:fixed) — portal escapes it entirely.
   */
  createPortal: (children: ReactNode, container: Element | DocumentFragment) => ReactNode;
  /**
   * 渲染任意宿主扩展插槽（返回宿主 ExtSlot 元素，供扩展组件嵌进自己的树——
   * 如 SidebarDock 会话行内的 sessionRowLeading/sessionRowMeta/sessionRowActions）。
   * 宿主组件宿主渲染，无跨 bundle 组件复制问题。
   */
  renderSlot?: (name: ExtSlotName, props?: { currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null; extra?: Record<string, unknown>; /** 只渲染注册 id 等于该值的 item（复合 id "extId:itemId"；DockStack 按 item 分格渲染用） */ only?: string }) => ReactNode;
  /** 插槽 items 响应式读取（hook——必须在组件渲染体调用；内部 = 宿主 useExtSlotItems，
   *  含懒加载拉起副作用与 store/语言订阅。返回条目 id 复合 "extId:itemId"，meta 可携
   *  title/priority 等。aiti-float DockStack 自编排容器的数据源。 */
  useSlotItems?: (slot: ExtSlotName) => ExtUiItemRegistered[];
  /** 读取全部扩展 ui.provides 声明集合（静态 manifest，运行时不变；非 hook）。 */
  getExtProvides?: () => Set<string>;
  /** 当前 UI 语言（formatRelativeTime 等 Intl 格式化用；跟随宿主语言设置）。 */
  getLocale?: () => string;
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
  /** 跨扩展客户端服务注册（依赖注入方案 §4-C，key 强制 "<extId>." 前缀；同页进程内直调，不走 HTTP）。
   *  返回 disposer。 */
  registerExtService?<T>(key: string, impl: T): () => void;
  /** 同步读跨扩展客户端服务（缺席 undefined——提供方懒加载未就绪时消费方必须降级）。 */
  getExtService?<T>(key: string): T | undefined;
  /** 订阅客户端服务上/下线（提供方 materialize/卸载）。返回退订函数。 */
  onExtServiceChange?(cb: (key: string, phase: "up" | "down") => void): () => void;
  /** 打开文件标签页（宿主公共接口，同步调用；返回 void/Promise） */
  openFile?(path: string, fileName?: string, options?: OpenFileOptions): void | Promise<void>;
  /** 打开文件夹标签页（右侧面板 FolderViewer；display-only，不影响 cwd） */
  openFolder?(path: string, folderName?: string, options?: OpenFolderOptions): void | Promise<void>;
  /** 侧栏文件树定位目录 */
  revealDir?(absPath: string): void | Promise<void>;
  /** 读取当前打开 tab 清单（数组序=打开序；含 kind/pinned 透传）——批量关闭/容量控制原语 */
  getFileTabs?(): { id: string; filePath: string; kind?: "file" | "folder" | "dock"; pinned?: boolean }[];
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
  /** [懒加载 v2] 确保某扩展 client 已物化（幂等；懒/即时通用）。返回是否本次真正完成注册。
   *  静态入口点击转发 / extman 虚空打开 / 跨扩展交互时刻拉起用。 */
  ensureMaterialized?(id: string): Promise<boolean>;
  /** [懒加载 v2] 确保声明了某插槽的全部懒扩展已物化（接管直读点跳板/交互时插槽用）。 */
  ensureSlotMaterialized?(slot: ExtSlotName): Promise<void>;
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

// ── 扩展服务注册表（依赖注入方案 §4-C：topicItems 同源升级版——同步本地直调，
//    不走 HTTP）── key 契约与服务端一致 "<extId>.<name>"（ctx 闭包校验前缀防冒充）。
//    同页进程内共享：页面级 Map，提供方 client materialize 时注册，消费方判空降级。
type ExtServicePhase = "up" | "down";
const extServices = new Map<string, { impl: unknown }>();
const extServiceListeners = new Set<(key: string, phase: ExtServicePhase) => void>();
function emitExtService(key: string, phase: ExtServicePhase) {
  for (const cb of [...extServiceListeners]) {
    try { cb(key, phase); } catch { /* 监听方错误不阻断 */ }
  }
}
/** 注册跨扩展客户端服务（key 强制 "<extId>." 前缀）。返回 disposer（反卷用）。 */
export function registerExtClientService<T>(extId: string, key: string, impl: T): () => void {
  // 与服务端 assertServiceKey 同契约：必须 "<extId>.<name>"，拒绝空 name 段（防冒充）
  if (typeof key !== "string" || key.length === 0 || !key.startsWith(extId + ".") || key === extId + ".") {
    throw new Error(`[ext] client service key 必须以 "<extId>.<name>" 形式（防冒充）：${extId} 试图 provide "${key}"`);
  }
  const wasAbsent = !extServices.has(key);
  extServices.set(key, { impl });
  if (wasAbsent) emitExtService(key, "up");
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const cur = extServices.get(key);
    if (cur && cur.impl === impl) {
      extServices.delete(key);
      emitExtService(key, "down");
    }
  };
}
/** 同步读跨扩展客户端服务（缺席 undefined——消费方判空降级）。 */
export function getExtClientService<T>(key: string): T | undefined {
  return extServices.get(key)?.impl as T | undefined;
}
/** 订阅客户端服务上/下线（提供方懒加载 materialize / 卸载时触发）。返回退订函数。 */
export function onExtClientServiceChange(cb: (key: string, phase: ExtServicePhase) => void): () => void {
  extServiceListeners.add(cb);
  return () => { extServiceListeners.delete(cb); };
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
// 注意：必须换新数组引用（不可原地 push）——useSyncExternalStore 以 getSnapshot 引用
// 判变；扩展 client 动态加载晚于消息首渲染时（如刷新后立即进会话），原地 push 会让
// 已渲染的段落永不重渲染包装（点击死区）。
let paragraphClickHandlers: ParagraphClickHandler[] = [];
const EMPTY_PCLICK: ParagraphClickHandler[] = [];
const paragraphClickListeners = new Set<() => void>();
function registerParagraphClick(h: ParagraphClickHandler) {
  paragraphClickHandlers = [...paragraphClickHandlers, h];
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
  // ui 随 manifest 全量序列化（registry.ts `ui: e.ext.ui ?? null`）：i18n/provides 之外
  // 还含各插槽的静态条目数组（ExtUiStaticSlots）——懒加载 v2 的零 bundle 入口数据源。
  ui: (ExtUiStaticSlots & { i18n?: Record<string, Record<string, string>>; provides?: string[]; clientImmediately?: boolean }) | null;
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
    // SidebarClone（宿主 SessionSidebar 复制版）经 @/ alias 引入宿主组件/hooks——
    // 这些模块的 react 全部 alias 到 host-shim，需在此补齐委托的真 hooks
    // host-shim 的惰性 context（createContext 在 _ctx 注入前无法创建真 context）——
    // 标记 __smI18nCtx 的 wrapper 统一解析到宿主真 I18nContext（SidebarClone 的 useI18n 链）
    // host-shim 惰性 context（__smI18nCtx）→ 直接返回宿主 useI18n() 当前值（t/locale 随宿主语言）
    useContext: ((c: any) => (c && (c as any).__smI18nCtx
      ? { t: (key: string, params?: Record<string, string | number>) => interpolate(tableFor()[key] ?? key, params), locale: currentUiLocale() }
      : useContext(c))) as any,
    useSyncExternalStore: ((sub: any, get: any, getServer?: any) => useSyncExternalStore(sub as any, get, getServer)) as any,
    useReducer: ((fn: any, init: any, initArg?: any) => useReducer(fn, init, initArg as never)) as any,
    useImperativeHandle: ((ref: any, fn: any, deps?: any) => useImperativeHandle(ref, fn, deps)) as any,
    useId: (() => useId()) as any,
    createContext: ((d: any) => ({ __smI18nCtx: true, defaultValue: d })) as any,
    forwardRef: ((fn: any) => forwardRef(fn as any)) as any,
    memo: ((fn: any) => memo(fn as any)) as any,
    createPortal: (children, container) => createPortal(children, container),
    t: (key, params) => interpolate(tableFor()[key] ?? key, params),
    apiUrl,
    renderSlot: (name, props) => createElement(ExtSlot, {
      name,
      currentSession: props?.currentSession ?? null,
      // extra 原样透传（ExtSlot 内部解构 extra 再展开给 item render）——此前误写成
      // ...props.extra 平铺到顶层 props，ExtSlot 解构不到 extra 恒 undefined，
      // 插槽 item 全收不到 extra（session-manager workspacePickerActions 管理弹窗
      // allProjects.length 崩溃即此因）。
      extra: props?.extra as Record<string, unknown> | undefined,
      only: props?.only,
    }),
    // 插槽 items 响应式读取（DockStack 等自编排容器用：按 meta 分格/排序后逐 item 渲染）。
    // hook：必须在组件渲染体内调用（内部是 useExtSlotItems 真 hook，含懒加载拉起副作用）。
    useSlotItems: (slot: ExtSlotName) => useExtSlotItems(slot),
    getExtProvides: () => {
      const provides = new Set<string>();
      for (const meta of Object.values(getExtMetas())) {
        for (const p of meta.provides ?? []) provides.add(p);
      }
      return provides;
    },
    getLocale: () => currentUiLocale(),
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
    registerExtService: (key, impl) => registerExtClientService(ext.id, key, impl),
    getExtService: (key) => getExtClientService(key),
    onExtServiceChange: (cb) => onExtClientServiceChange(cb),
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
    // [懒加载 v2] 显式物化 API（extman 虚空打开 / 跨扩展交互时刻拉起）
    ensureMaterialized: (id: string) => ensureExtMaterialized(id),
    ensureSlotMaterialized: (slot: ExtSlotName) => ensureExtSlotMaterialized(slot),
  };
  return ctx;
}

/** AppShell 注入的宿主能力（经 ExtSlotsProvider props；makeClientContext 包装下发）。 */
export function ExtSlotsProvider({ children }: { children: ReactNode }) {
  const [, force] = useState(0);
  // SidebarClone（@/ 宿主模块链）的 useI18n 经 host-shim 委托到这里——快照每渲染刷新
  extI18nSnapshot = useI18n();
  useEffect(() => {
    void loadExtensions();
    const unsub = subscribeExtUi(() => force((v) => v + 1));
    return unsub;
  }, []);
  return <>{children}<ExtErrorIndicator /></>;
}

/** manifest 本地持久缓存：带 If-None-Match → 304 时零传输、零解析。
 *  写失败（配额/隐私模式）静默降级为每次全量。 */
const MANIFEST_CACHE_KEY = "pi-web:ext-manifest-cache";
function loadManifestCache(): { etag: string; data: ManifestData } | null {
  try {
    const raw = localStorage.getItem(MANIFEST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { etag: string; data: ManifestData };
    return parsed?.etag && parsed?.data ? parsed : null;
  } catch { return null; }
}
function saveManifestCache(etag: string, data: ManifestData): void {
  try { localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ etag, data })); } catch { /* quota */ }
}

/** 拉取 manifest 并刷新 client 侧缓存（manifestCache / declaredSlots / metas）。
 *  返回 { extensions, graph }；失败返回 null（不抛）。reload 后必须重拉——
 *  否则新安装扩展的元数据/i18n/声明的插槽停留在旧值，client bundle 加载不到。 */
async function fetchManifestData(): Promise<ManifestData | null> {
  try {
    const cached = loadManifestCache();
    const res = await fetch(apiUrl("/api/extensions/manifest"), {
      cache: "no-store",
      headers: cached ? { "if-none-match": cached.etag } : undefined,
    });
    let data: ManifestData | null = null;
    if (res.status === 304 && cached) {
      data = cached.data; // 未变：零传输，直接用本地副本
    } else if (res.ok) {
      data = (await res.json()) as ManifestData;
      const etag = res.headers.get("etag");
      if (etag) saveManifestCache(etag, data);
    }
    if (!data) return null;
    // manifest 元数据（name/icon/provides）→ 宿主 UI 标注扩展身份（顶栏自定义面板等）、
    // 并驱动内置 UI 的能力接管开关（useExtProvides）
    const metas: Record<string, ExtMeta> = {};
    for (const ext of data.extensions) {
      manifestCache.set(ext.id, ext);
      metas[ext.id] = { name: ext.name, icon: ext.icon ?? null, provides: ext.ui?.provides };
      // 功能状态统一写入共享 store（extman 管理；扩展经 ctx.getFeatures 读，零独立请求）
      setExtFeatures(ext.id, ext.features ? Object.fromEntries(ext.features.map((f) => [f.id, f.type === "string" ? (f.value ?? "") : (f.enabled !== false)])) : null);
      // 按需加载登记：声明了哪些 UI 插槽（ui 定义里非空数组的 slot 键）。
      const declaredSlotKeys = ext.ui ? Object.keys(ext.ui).filter((k) => k !== "i18n" && k !== "provides" && k !== "clientDependsOn" && k !== "clientImmediately") : [];
      registerDeclaredSlots(ext.id, declaredSlotKeys);
      // [懒加载 v2] 静态条目登记：manifest ui[slot][] 的可序列化声明 → 零 bundle 入口
      //（物化前宿主直接渲染；点击经 staticClickForwarder 物化后转发注册条目 onClick）。
      // 仅对懒扩展（clientImmediately:false）注册：即时扩展启动批就物化，静态条目只会
      // 造成一闪而过的双渲染；且即时扩展的 ui 声明与 client 注册 id 从未对齐过（历史
      // 上宿主不渲染静态声明，错位不可见）——按 §5.5 SOP 逐扩展转懒时才对齐并启用。
      if (ext.ui?.clientImmediately === false) {
        for (const slot of declaredSlotKeys) {
          const items = (ext.ui as Record<string, unknown>)[slot];
          if (Array.isArray(items) && items.length > 0) {
            registerStaticItems(slot as ExtSlotName, items as Parameters<typeof registerStaticItems>[1], ext.id);
          }
        }
      } else {
        // 懒翻回即时（或即时扩展原本就该清）的扩展：静态入口退役——不清理会残留幽灵按钮
        removeStaticItems(ext.id);
      }
    }
    registerExtMetas(metas);
    // 扩展稳定顺序（manifest 清单序）：注册完成序随加载流水线交错而随机，
    // 插槽展示序以清单序为准（ext-ui-store.getExtUiItems 排序），顶栏等不再跳动
    setExtOrder(data.extensions.map((e) => e.id));
    // 已卸载/禁用的扩展不再出现在 manifest——清除其残留的 slot 声明，
    // 防止 pendingForSlot 把不存在的扩展列为按需加载候选。
    pruneDeclaredSlots(data.extensions.map((e) => e.id));
    // [懒加载 v2] 同点清理静态条目残留（扩展卸载/禁用后按钮不能还挂在顶栏）
    pruneStaticItems(data.extensions.map((e) => e.id));
    // server 侧加载失败 → 错误指示器（同 id 覆盖去重；修复后自动移除）
    syncLoadErrors(data.failed);
    return data;
  } catch (e) {
    console.error("[ext] failed to fetch extension manifest:", e);
    return null;
  }
}

/** 启动就绪信号：loadExtensions 首次尝试 settle（成功/失败都算）即置位。
 *  「缺席即原生兜底」的裁决点（TerminalPanelBridge → 原生 TerminalPanel）用它 +
 *  useExtSlotSettled 区分「manifest 还没回来（不能预判，防接管迟到双开）」与
 *  「该插槽确定无人接管」。 */
let extBootSettled = false;
const extBootSettledListeners = new Set<() => void>();

function notifyExtBootSettled(): void {
  extBootSettled = true;
  for (const listener of [...extBootSettledListeners]) {
    try { listener(); } catch { /* 快照通知失败不阻断 */ }
  }
}

/** 首次加载：拉 manifest → 写元数据 + 启动图 → 按图 prefetch + materialize。 */
async function loadExtensions(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
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
  } finally {
    notifyExtBootSettled();
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

// ── [懒加载 v2] 静态条目点击转发器：零 bundle 入口 → 物化 → 注册条目行为 ──
// pending 置位（按钮加载态+防连点）→ ensureMaterialized → 同 (extId,id) 注册条目
// meta.onClick / meta.open → 复位。失败经 registerExtSlotError(kind:"load") 进左下角
// 指示器（§7-R2）。manifest 里已无该扩展（卸载/禁用后残留点击）同样走错误指示器。
// in-flight 集合防重入：工具条按钮 + ⋯ 菜单行两个入口并发点击只跑一次转发。
const staticForwardInFlight = new Set<string>();
async function staticClickForwarder(extId: string, itemId: string, slot: ExtSlotName, ev?: unknown): Promise<void> {
  const fkey = `${extId}\u0000${itemId}`;
  if (staticForwardInFlight.has(fkey)) return;
  staticForwardInFlight.add(fkey);
  setStaticItemPending(extId, itemId, true);
  const errId = `ext-static-${extId}:${slot}:${itemId}`;
  try {
    const ext = manifestCache.get(extId);
    if (!ext) {
      registerExtSlotError({
        id: errId, extId, slot, itemId, kind: "load",
        message: "静态入口点击：manifest 中已无此扩展（被卸载/禁用？）", reset: () => {},
      });
      return;
    }
    await ensureMaterialized(extId, () => makeClientContext(ext));
    const reg = getExtUiItems(slot).find((it) => it.extId === extId && it.id === itemId);
    if (!reg) {
      registerExtSlotError({
        id: errId, extId, slot, itemId, kind: "load",
        message: `静态入口点击后未发现 ${slot} 注册条目（client 未注册或 id 未对齐）`, reset: () => {},
      });
      return;
    }
    const onClick = reg.meta?.onClick;
    const open = (reg.meta as { open?: unknown } | undefined)?.open;
    if (typeof onClick === "function") onClick(ev);
    else if (typeof open === "function") (open as (e?: unknown) => void)(ev);
    else console.warn(`[ext] ${extId} 注册条目 ${slot}/${itemId} 缺少 onClick/open，静态点击转发落空`);
  } catch (e) {
    registerExtSlotError({
      id: errId, extId, slot, itemId, kind: "load",
      message: e instanceof Error ? e.message : String(e), reset: () => {},
    });
  } finally {
    staticForwardInFlight.delete(fkey);
    setStaticItemPending(extId, itemId, false);
  }
}
// 注入一次（模块级；Fast Refresh 重建本模块时随重注入）。转发器运行期才解引用
// manifestCache/makeClientContext，声明顺序无 TDZ 问题。
setStaticClickHandler(staticClickForwarder);

/** [懒加载 v2] 确保某扩展 client 已物化（幂等；manifest 缺失返回 false）。
 *  宿主组件（FileViewer/viewer page 接管跳板）与跨扩展消费方共用。 */
export function ensureExtMaterialized(id: string): Promise<boolean> {
  const ext = manifestCache.get(id);
  if (!ext) return Promise.resolve(false);
  return ensureMaterialized(id, () => makeClientContext(ext));
}

/** [懒加载 v2] 确保声明了 slot 的全部懒扩展已物化（接管直读点跳板：文件 tab 打开=
 *  交互时刻，editor/folder 首次接管前一次性加载）。 */
export async function ensureExtSlotMaterialized(slot: ExtSlotName): Promise<void> {
  await ensureSlotMaterialized(slot, (id) => {
    const ext = manifestCache.get(id);
    if (!ext) throw new Error(`[ext] ${id}: manifest 缺失，无法物化`);
    return makeClientContext(ext);
  });
}

/** 插槽接管缺席裁决：boot manifest 已 settle 且无人声明该插槽。「缺席即原生兜底」
 *  直读点（TerminalPanelBridge）用——定案前不能渲染原生面板：声明了接管但尚未物化
 *  （或物化失败）时抢先建原生 PTY，接管随后到位就是双开。声明/未声明以 manifest
 *  快照为准，一次定案无物化竞态。随 ui-store 版本推进重渲染。 */
export function useExtSlotSettled(slot: ExtSlotName): boolean {
  useSyncExternalStore(subscribeExtUi, extUiVersion, () => 0);
  return extBootSettled && !slotDeclared(slot);
}

/** Read registered items for a slot, re-rendering when the store changes. */
export function useExtSlotItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  const [items, setItems] = useState<ExtUiItemRegistered[]>(() => getExtUiItems(slot));
  // [懒加载适配 2026-09-09] ui-store 版本号:manifest 就绪（registerDeclaredSlots/
  // registerStaticItems/registerExtMetas 都 bump）、reload 反卷、feature 变更都会推进。
  // 物化 effect 以它为依赖——terminalDock 等「常挂载」插槽（AppShell hidden 容器里的
  // TerminalPanelBridge）挂载时刻早于 manifest 异步拉取完成，此前 effect 依赖仅 [slot]
  // 只跑一次：首跑时 declaredSlots 未登记 → pendingForSlot 恒空 → 声明扩展永不物化 →
  // 恢复的终端页签永驻「未检测到 aiti-cmd 扩展」fallback。version bump 后 effect 重跑，
  // pendingForSlot 幂等（已物化不重触发），顺带修复 reload 反卷后懒扩展不再被插槽拉起。
  const version = useSyncExternalStore(subscribeExtUi, extUiVersion, () => 0);
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
  // [懒加载 v2] 触发面按插槽分流：交互时挂载插槽（INTERACTIVE_SLOTS——打开设置/
  // 文件/终端等本身就是交互时刻）拉起全部声明扩展（含懒扩展，pendingForSlot 原语义）；
  // 常挂插槽（toolbar/sidebar/…20+，首屏即渲染）只拉即时扩展（pendingForSlotAuto），
  // 懒扩展在常挂插槽上的入口由 manifest 静态条目承担，点击才物化——首屏零请求成立。
  useEffect(() => {
    const pending = INTERACTIVE_SLOTS.has(slot) ? pendingForSlot(slot) : pendingForSlotAuto(slot);
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
  }, [slot, version]);

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
function findRenderSlotError(extId?: string, slot?: string, itemId?: string): ExtSlotError | undefined {
  for (const e of extSlotErrors.values())
    if (e.kind === "render" && e.extId === extId && e.slot === slot && e.itemId === itemId) return e;
  return undefined;
}

export class ExtItemBoundary extends Component<
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
    // 指纹去重（extId+slot+itemId+render）：瞬态 slot（如下拉）反复开关会反复卸载/重挂
    // boundary，重挂再崩时复用原条目覆盖（Map.set 同 id），不堆积重复卡片。
    const existing = findRenderSlotError(extId, slot, itemId);
    registerExtSlotError({
      id: existing ? existing.id : this.bid,
      extId, slot, itemId,
      message: err.message,
      stack: err.stack,
      reset: () => { if (this.mounted) this.setState({ err: null }); },
      kind: "render",
    });
  }
  componentWillUnmount() {
    this.mounted = false;
    // 不在此注销错误：slot 卸载 ≠ 错误消失。瞬态 slot（picker 下拉等）点外关闭时
    // boundary 随之卸载，若当场注销，用户点 ⚠/🚑（都算下拉外点击）会连锁关下拉→
    // 注销→⚠ 和错误面板一起闪没（「点了无效」的元凶）。错误保留至「忽略」按钮
    // 显式清除，或同指纹重注册时覆盖。
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
  only,
}: {
  name: S;
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  /** 插槽额外 props——类型从 ExtSlotContractMap 契约取（未声明 → 宽松对象）。 */
  extra?: ExtSlotProps<S>;
  /** 只渲染注册 id 等于该值的 item（aiti-float dock 方案 §4.3：rightFileDock 内容区按激活
   *  tab 分派用；id = 注册复合 id "extId:itemId"。缺省不过滤——其余插槽零影响）。 */
  only?: string;
}) {
  const items = useExtSlotItems(name)
    // render 可选（toolbar 声明式条目归宿主渲染）；其余插槽只消费带 render 的条目
    .filter(hasExtRender)
    .filter((it) => !only || it.id === only);
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

// ── TakeoverSlot —— 通用「有接管者即整块让位」插槽（sidebar 统一 dock 方案 §3.2）──
// 从 SessionSidebar 私有接管逻辑（projectsTakeover + 3s 兑底 + 首帧记忆）泛化：
//  · 接管记忆 key = `pi-web:takeover:<name>`（"1"=上次会话曾接管）。扩展 items 异步注册
//    （首帧必空），记忆让「接管态刷新」首帧就按接管语义渲染 fallback（不闪旧 UI、
//    不白拉宿主数据）；消费方读 `useTakeoverHint(name)` 同步判定。
//  · 旧 key 迁移（legacyKey）：首帧读一次，命中即迁入新 key（单向，旧 key 保留——
//    回滚旧宿主仍可读）。
//  · 兑底窗口 800ms（方案 §3.8 拍板，原 3s 压缩）：记忆命中但 items 迟迟不注册
//    （扩展被禁用/卸载后缓存残留）→ 到点清记忆并保持 fallback。
const TAKEOVER_MEM_PREFIX = "pi-web:takeover:";
export function takeoverMemKey(name: string): string { return TAKEOVER_MEM_PREFIX + name; }
function readTakeoverMem(name: string, legacyKey?: string): boolean {
  try {
    const cur = window.localStorage.getItem(takeoverMemKey(name));
    if (cur !== null) return cur === "1";
    if (legacyKey) {
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy === "1") { window.localStorage.setItem(takeoverMemKey(name), "1"); return true; }
    }
  } catch { /* storage unavailable */ }
  return false;
}
function writeTakeoverMem(name: string, on: boolean): void {
  try { window.localStorage.setItem(takeoverMemKey(name), on ? "1" : "0"); } catch { /* optional */ }
}
const TAKEOVER_MEM_EVENT = "pi-web:takeover-mem-changed";
/** 响应式读接管记忆（首帧同步命中——SessionSidebar 等 fallback 组件用它门控
 *  「接管态不渲染/不拉数据」的区块，无闪现）。 */
export function useTakeoverHint(name: string, legacyKey?: string): boolean {
  const [hint, setHint] = useState(() => readTakeoverMem(name, legacyKey));
  useEffect(() => {
    const sync = () => setHint(readTakeoverMem(name, legacyKey));
    sync();
    window.addEventListener(TAKEOVER_MEM_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(TAKEOVER_MEM_EVENT, sync); window.removeEventListener("storage", sync); };
  }, [name, legacyKey]);
  return hint;
}

export function TakeoverSlot({ name, fallback, extra, legacyKey, currentSession }: {
  name: ExtSlotName;
  fallback: ReactNode;
  extra?: Record<string, unknown>;
  /** 旧接管记忆 key（历史私有 key 迁移入口；缺省无迁移）。 */
  legacyKey?: string;
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
}) {
  const items = useExtSlotItems(name).filter(hasExtRender);
  const takeover = items.length > 0;
  const takeoverRef = useRef(takeover);
  takeoverRef.current = takeover;
  // 记忆（首帧从 localStorage 读，含旧 key 迁移）：live 接管态写入 "1"；
  // 从有到无（禁用/卸载/反卷）写 "0" 并广播（fallback 组件即时恢复旧区块）。
  const memRef = useRef<boolean | null>(null);
  if (memRef.current === null) memRef.current = readTakeoverMem(name, legacyKey);
  const everSeenRef = useRef<boolean | null>(null); // null=本会话尚未观察到注册态
  // 等待窗（§7-2 配套）：记忆命中但 items 未到 → 渲染空白占位而非整个 fallback——
  // 防旧侧栏整块闪现（fallback 可能是懒 chunk，加载窗口内本来也是空白，观感一致）。
  const [hintPending, setHintPending] = useState(() => memRef.current === true);
  useEffect(() => {
    if (takeover) {
      everSeenRef.current = true;
      if (hintPending) setHintPending(false);
      if (!memRef.current) { memRef.current = true; writeTakeoverMem(name, true); window.dispatchEvent(new Event(TAKEOVER_MEM_EVENT)); }
      return;
    }
    if (everSeenRef.current === true) {
      everSeenRef.current = false;
      if (memRef.current) { memRef.current = false; writeTakeoverMem(name, false); window.dispatchEvent(new Event(TAKEOVER_MEM_EVENT)); }
      setHintPending(false);
    }
    // 首帧未注册（everSeen===null）时不动记忆：等注册事件裁决，避免抹掉真接管记忆
  }, [takeover, name]);
  // 兑底：记忆命中但扩展始终未注册（缓存残留）→ 800ms 一次性校验后清记忆并放行 fallback（方案 §3.8）
  useEffect(() => {
    if (!hintPending) return;
    const timer = setTimeout(() => {
      if (takeoverRef.current) { setHintPending(false); return; }
      memRef.current = false;
      writeTakeoverMem(name, false);
      setHintPending(false);
      window.dispatchEvent(new Event(TAKEOVER_MEM_EVENT));
    }, 800);
    return () => clearTimeout(timer);
  }, [hintPending, name]);
  if (takeover) return <ExtSlot name={name} currentSession={currentSession} extra={extra as never} />;
  if (hintPending) return null;
  return <>{fallback}</>;
}
