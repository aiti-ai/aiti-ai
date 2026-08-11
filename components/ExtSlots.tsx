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

import { createElement, memo, useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import { apiUrl } from "@/lib/base-path";
import type { ExtSlotName } from "@/lib/ext/types";
import {
  getExtUiItems,
  registerExtUiItems,
  resetExtUiItems,
  subscribeExtUi,
  type ExtRenderProps,
  type ExtUiItemRegistered,
} from "@/lib/ext-ui-store";

/** The register(ctx) surface handed to a client bundle. */
export interface ExtClientContext {
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useRef: typeof useRef;
  useCallback: typeof useCallback;
  useMemo: typeof useMemo;
  /** Translate using the extension's own i18n table (from the manifest). */
  t(key: string, params?: Record<string, string | number>): string;
  apiUrl(path: string): string;
  registerItems(slot: ExtSlotName, items: Array<{ id: string; render: (props: ExtRenderProps) => ReactNode; meta?: Record<string, unknown> }>): void;
  /** 注册聊天输入钩子（aiti-devtools：发送前 @选择N 替换 + 收集候选元素） */
  registerChatHook(hook: { preSend?: (text: string) => { text?: string; elements?: unknown[] } | null }): void;
}

/** 聊天输入钩子 store（扩展注册；ChatInput 发送时调用） */
interface ChatHook { preSend?: (text: string) => { text?: string; elements?: unknown[] } | null }
const chatHooks: ChatHook[] = [];
const chatHookListeners = new Set<() => void>();
function registerChatHooks(hook: ChatHook) {
  chatHooks.push(hook);
  for (const l of chatHookListeners) l();
}
export function useChatHooks(): ChatHook[] {
  const [hooks, setHooks] = useState<ChatHook[]>(chatHooks);
  useEffect(() => {
    const l = () => setHooks([...chatHooks]);
    chatHookListeners.add(l);
    return () => { chatHookListeners.delete(l); };
  }, []);
  return hooks;
}

interface ManifestExt {
  id: string;
  name: string;
  version: string;
  clientUrl: string | null;
  ui: { i18n?: Record<string, Record<string, string>> } | null;
}

let loadStarted = false;

function interpolate(message: string, params: Record<string, string | number> = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

declare global {
  interface Window { __extDebug?: string[]; }
}

async function loadExtensions(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const res = await fetch(apiUrl("/api/extensions/manifest"), { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { extensions: ManifestExt[] };
    resetExtUiItems();
    for (const ext of data.extensions) {
      if (!ext.clientUrl) continue;
      try {
        // webpackIgnore: keep the native dynamic import (Next would otherwise
        // rewrite it into a bundled context stub).
        const mod = (await import(/* webpackIgnore: true */ apiUrl(ext.clientUrl))) as unknown;
        // Bundle exports either `export default function register(ctx)` or
        // `export function register(ctx)` — support both.
        const ns = mod as { default?: unknown; register?: (ctx: ExtClientContext) => void };
        const registerFn = typeof ns.default === "function" ? ns.default as (ctx: ExtClientContext) => void : ns.register;
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
            registerExtUiItems(slot, items.map((it) => ({ id: `${ext.id}:${it.id}`, render: it.render, meta: it.meta })));
          },
          registerChatHook: (hook) => registerChatHooks(hook),
          registerChatHook: (hook) => registerChatHooks(hook),
        };
        registerFn?.(ctx);
      } catch (e) {
        console.error(`[ext] failed to load client bundle for ${ext.id}:`, e);
      }
    }
  } catch (e) {
    console.error("[ext] failed to fetch extension manifest:", e);
  }
}

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
  return items;
}

export function ExtSlot({
  name,
  currentSession = null,
  extra,
}: {
  name: ExtSlotName;
  currentSession?: { id: string; cwd: string; name?: string } | null;
  extra?: Record<string, unknown>;
}) {
  const items = useExtSlotItems(name);
  return (
    <>
      {items.map((it) => (
        <it.render key={it.id} currentSession={currentSession} {...extra} />
      ))}
    </>
  );
}

/** Convenience: memoized slot for use inside tight render loops (rows). */
export const MemoExtSlot = memo(ExtSlot, (prev, next) =>
  prev.name === next.name && prev.currentSession?.id === next.currentSession?.id
);
