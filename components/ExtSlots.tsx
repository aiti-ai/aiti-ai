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
import type { ExtSlotName, ExtSlotProps, PopoverActionProvider } from "@/lib/ext/types";
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
  materialize,
  pendingForSlot,
  prefetch,
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
  /** 注册消息点击识别弹层动作 provider（QuoteReplyPopover 扩展点：异步识别段落 → 动作按钮） */
  registerPopoverAction(provider: PopoverActionProvider): void;
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

/** 聊天发送处理器 store（扩展 ctx.sendChatMessage 的统一出口；ChatInput mount 时注册） */
type ChatSendHandler = (text: string, mode: "steer" | "followUp") => void;
let chatSendHandler: ChatSendHandler | null = null;
export function registerChatSend(fn: ChatSendHandler | null): void {
  chatSendHandler = fn;
}
export function dispatchChatSend(text: string, mode: "steer" | "followUp"): void {
  chatSendHandler?.(text, mode);
}

// 消息点击识别弹层动作 provider store（扩展注册；QuoteReplyPopover 渲染）
const popoverActions: PopoverActionProvider[] = [];
const EMPTY_POPOVER_ACTIONS: PopoverActionProvider[] = [];
const popoverActionListeners = new Set<() => void>();
function registerPopoverActions(p: PopoverActionProvider) {
  popoverActions.push(p);
  for (const l of popoverActionListeners) l();
}
export function usePopoverActionProviders(): PopoverActionProvider[] {
  return useSyncExternalStore(
    (cb) => { popoverActionListeners.add(cb); return () => { popoverActionListeners.delete(cb); }; },
    () => popoverActions,
    () => EMPTY_POPOVER_ACTIONS,
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
  return {
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
    registerPopoverAction: (p) => registerPopoverActions(p),
  };
}

/** 首次加载：拉 manifest → 写元数据 + 启动图 → 按图 prefetch + materialize。 */
async function loadExtensions(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const res = await fetch(apiUrl("/api/extensions/manifest"), { cache: "no-store" });
    if (!res.ok) return;
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
    setBootGraph(data.graph ?? { rev: "", entries: [] });
    // 两阶段加载：prefetch 全部（注册入口就绪，副作用未发生）→ materialize 逐个
    // （register(ctx) 调用，副作用发生）。失败隔离：单扩展失败不影响其他。
    await Promise.allSettled(data.graph?.entries.map((e) => prefetch(e.id)) ?? []);
    for (const ext of data.extensions) {
      if (!entryOf(ext.id)) continue; // 无 client bundle 或未进图
      await materialize(ext.id, () => makeClientContext(ext));
    }
  } catch (e) {
    console.error("[ext] failed to fetch extension manifest:", e);
  }
}

/** HMR 精确反卷：POST reload → 服务端返回新图 → 比 rev 只反卷变更扩展。 */
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
      const data = (await res.json()) as { ok: boolean; graph?: PiWebBootGraph };
      if (!data.ok || !data.graph) return { invalidated: [] };
      const invalidated = reconcileGraph(data.graph, (extId) => removeExtUiItems(extId));
      // 反卷的扩展重新 prefetch + materialize（新 rev 的 bundle）。
      for (const id of invalidated) {
        const ext = manifestCache.get(id);
        if (ext && entryOf(id)) {
          await prefetch(id);
          await materialize(id, () => makeClientContext(ext));
        }
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

export function ExtSlotsProvider({ children }: { children: ReactNode }) {
  const [, force] = useState(0);
  useEffect(() => {
    void loadExtensions();
    const unsub = subscribeExtUi(() => force((v) => v + 1));
    return unsub;
  }, []);
  return <>{children}</>;
}

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
