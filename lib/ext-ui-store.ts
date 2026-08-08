/**
 * Client-side extension UI store — a tiny registry on window.__piWebExtUI.
 *
 * The extension client bundles call ctx.registerItems(slot, items) during
 * module registration; core components render them via <ExtSlot name=.../>.
 * A version counter lets React hooks re-render when items are registered.
 */
"use client";

import type { ReactNode } from "react";
import type { ExtSlotName } from "@/lib/ext/types";

export interface ExtRenderProps {
  /** Current selected session (null for a fresh new-session composer). */
  currentSession?: { id: string; cwd: string; name?: string } | null;
  [key: string]: unknown;
}

export interface ExtUiItemRegistered {
  id: string;
  /** Component receiving ExtRenderProps (currentSession etc.). */
  render: (props: ExtRenderProps) => ReactNode;
  meta?: { label?: string; title?: string; badge?: boolean };
}

export interface ExtUiStore {
  items: Partial<Record<ExtSlotName, ExtUiItemRegistered[]>>;
  version: number;
  listeners: Set<() => void>;
}

declare global {
  var __piWebExtUI: ExtUiStore | undefined;
}

function getStore(): ExtUiStore {
  if (!globalThis.__piWebExtUI) {
    globalThis.__piWebExtUI = { items: {}, version: 0, listeners: new Set() };
  }
  return globalThis.__piWebExtUI;
}

export function registerExtUiItems(slot: ExtSlotName, items: ExtUiItemRegistered[]): void {
  const store = getStore();
  const existing = store.items[slot] ?? [];
  store.items[slot] = [...existing, ...items];
  store.version += 1;
  for (const l of store.listeners) l();
}

/** Clear all items for every slot (used when re-importing bundles on reload). */
export function resetExtUiItems(): void {
  const store = getStore();
  store.items = {};
  store.version += 1;
  for (const l of store.listeners) l();
}

export function getExtUiItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  return getStore().items[slot] ?? [];
}

export function subscribeExtUi(cb: () => void): () => void {
  const store = getStore();
  store.listeners.add(cb);
  return () => store.listeners.delete(cb);
}

export function extUiVersion(): number {
  return getStore().version;
}
