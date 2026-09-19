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
import { registerComposerEnhancement, getComposerTrashWriter } from "@/lib/composer/bus";
import { useI18n } from "@/hooks/useI18n";
/** SidebarClone (via the @/ host-module chain) aliases react entirely to the
 *  host shim — its useI18n context resolution goes through ctx.useContext →
 *  the host useI18n() snapshot cached here (refreshed every render).
 *  Hook timing: the snapshot updates in the ExtSlotsProvider render body (a
 *  legal hook call); materialize (effect) only reads the snapshot — no hook
 *  calls inside callbacks. */
let extI18nSnapshot: ReturnType<typeof useI18n> | null = null;
import type { ComposerEnhancement, ComposerSnapshot, RecoveryItemsProvider } from "@/lib/composer/types";
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
  immediateEntriesByPriority,
  isImmediateEntry,
  isServerDeclarationsKnown,
  materialize,
  materializedIds,
  pendingForSlot,
  pendingForSlotAuto,
  seedServerDeclarations,
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
import { notifyExtBootSettled as notifyBootSignal, settleEventBusDeployed } from "@/lib/ext-boot-signal";

/** The register(ctx) surface handed to a client bundle. */
export interface ExtClientContext {
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useLayoutEffect: typeof useLayoutEffect;
  useRef: typeof useRef;
  useCallback: typeof useCallback;
  useMemo: typeof useMemo;
  /** SidebarClone (a copy of the host SessionSidebar) pulls in host
   *  components/hooks via the @/ alias; react in those modules is fully
   *  aliased to the host shim — the real delegated hooks are supplied here. */
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
   * Render any host extension slot (returns the host ExtSlot element so
   * extension components can embed it in their own tree — e.g. the
   * sessionRowLeading/sessionRowMeta/sessionRowActions inside SidebarDock
   * session rows). Rendered by the host component itself, so there is no
   * cross-bundle component duplication.
   */
  renderSlot?: (name: ExtSlotName, props?: { currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null; extra?: Record<string, unknown>; /** Render only the item whose registered id equals this value (composite id "extId:itemId"; used by the DockStack to render items in separate cells) */ only?: string }) => ReactNode;
  /** Reactive read of slot items (hook — must be called in a component render
   *  body; internally the host useExtSlotItems, including the lazy-load boot
   *  side effect and store/locale subscriptions. Returns composite item ids
   *  "extId:itemId"; meta may carry title/priority etc. Data source for the
   *  floating-dialog extension's self-arranging DockStack container. */
  useSlotItems?: (slot: ExtSlotName) => ExtUiItemRegistered[];
  /** Reads the set of all extensions' ui.provides declarations (static manifest, unchanged at runtime; not a hook). */
  getExtProvides?: () => Set<string>;
  /** Current UI locale (for Intl formatting such as formatRelativeTime; follows the host locale setting). */
  getLocale?: () => string;
  /**
   * Translate using the extension's own i18n table (from the manifest).
   * Type contract: once an extension declares its key table in
   * LocaleNamespaceMap it gets key checking; without a declaration it
   * degrades to string (backwards compatible).
   */
  t(key: string, params?: Record<string, string | number>): string;
  apiUrl(path: string): string;
  registerItems(slot: ExtSlotName, items: Array<{ id: string; render?: (props: ExtRenderProps) => ReactNode; meta?: Record<string, unknown>; feature?: string }>): void;
  /** Returns a disposer: calling it removes exactly this registration (DSH effect semantics; used for HMR invalidation). */
  disposeItems(slot: ExtSlotName, ids: string[]): void;
  /** Registers a chat-input hook (the devtools extension: replaces [element N]/[answer N]/[error N] before send + collects candidate elements) */
  registerChatHook(hook: { preSend?: (text: string) => { text?: string; elements?: unknown[] } | null }): void;
  /** Programmatically sends a message (same path as user input: preSend hooks
   *  apply; sends directly when idle, steers/queues by mode while streaming;
   *  does not clear the input box)
   *  images optional: queue a follow-up carrying images (e.g. multiple
   *  leftover drafts restored at once) */
  sendChatMessage(text: string, mode: "steer" | "followUp", images?: { data: string; mimeType: string }[]): void;
  /** Enqueue only, never triggers (the draft-recovery "Re-queue" semantics):
   *  even when idle it only enters the follow-up queue, no direct send.
   *  preSend hooks ([element N]/[answer N]/[error N]) apply as well; images
   *  travel with the queue entry. */
  queueFollowUp(text: string, images?: { data: string; mimeType: string }[]): void;
  /** Registers a message-paragraph click takeover handler (thin host for paragraph click recognition: the core broadcasts the click event, all popover UI lives in the extension) */
  registerParagraphClick(handler: ParagraphClickHandler): void;
  /** Registers a pre-fork gate for sessions (e.g. the git-history extension's
   *  undo gate): gates are awaited in order before a fork starts; returning
   *  false or throwing cancels it. Returns a disposer (use directly as an
   *  effect return value so HMR reload removes it precisely). */
  registerSessionForkGate(gate: SessionForkGate): () => void;
  /** Synchronously reads all feature states of this extension (managed by the extension manager; the host fetches them in one go, so extensions make zero extra requests). Boolean features are booleans, string features are string values. */
  getFeatures?(): Record<string, boolean | string>;
  /** Subscribes to this extension's feature-state changes (fires after the extension manager changes a feature; returns an unsubscribe function) */
  onFeatureChange?(cb: () => void): () => void;
  /** Topic item registration (indirect coupling between extensions): publishes
   *  an item to an abstract topic (e.g. "msg-popover-action"); returns a
   *  disposer. Topic id + payload structure are defined by the consumer (the
   *  core does not interpret the content). */
  registerTopicItem<T>(topic: string, item: T): () => void;
  /** Synchronously reads all items of a topic (called by consumers at interaction time). */
  getTopicItems<T>(topic: string): T[];
  /** Cross-extension client service registration (dependency-injection plan
   *  §4-C; keys are forced to the "<extId>." prefix; direct in-process calls
   *  within the same page, no HTTP). Returns a disposer. */
  registerExtService?<T>(key: string, impl: T): () => void;
  /** Synchronously reads a cross-extension client service (undefined when absent — consumers must degrade while the provider's lazy load is not ready). */
  getExtService?<T>(key: string): T | undefined;
  /** Subscribes to client service up/down (provider materialize/unload). Returns an unsubscribe function. */
  onExtServiceChange?(cb: (key: string, phase: "up" | "down") => void): () => void;
  /** Opens a file tab (host public API, synchronous call; returns void/Promise) */
  openFile?(path: string, fileName?: string, options?: OpenFileOptions): void | Promise<void>;
  /** Opens a folder tab (right-panel FolderViewer; display-only, does not change cwd) */
  openFolder?(path: string, folderName?: string, options?: OpenFolderOptions): void | Promise<void>;
  /** Reveals a directory in the sidebar file tree */
  revealDir?(absPath: string): void | Promise<void>;
  /** Reads the currently open tabs (array order = open order; kind/pinned passed through) — the primitive for bulk close / capacity control. */
  getFileTabs?(): { id: string; filePath: string; kind?: "file" | "folder" | "dock"; pinned?: boolean }[];
  /** Closes the given tabs (state removal + active-tab reindex only; dirty confirmation / pinned protection are the extension's responsibility) */
  closeFileTabs?(ids: string[]): void;
  /** Appends text to the composer without sending (used to prefill quote replies) */
  appendText?(text: string): void | Promise<void>;
  /** Registers a composer enhancer (value observation / session key
   *  switching / pre-send chained hooks).
   *  Returns a disposer. */
  registerComposerEnhancement(enh: ComposerEnhancement): () => void;
  /** Reads the trash-write executor (for implementers of the input-clear enhancer's onClearToTrash). */
  getComposerTrashWriter?(): ((snapshot: ComposerSnapshot) => void) | null;
  /** Programmatically writes a value (the composer contract's controlled
   *  path: state → DOM-sync effect, tracker kept in sync).
   *  Returns whether the write actually happened (false when the composer is
   *  not mounted). */
  writeComposerValue?(text: string): boolean | Promise<boolean>;
  /** Fully restores a draft into the composer (text + images; raw, no hooks —
   *  same as how the core restores the first entry).
   *  Returns whether the restore actually happened (false when the composer
   *  is not mounted — the caller must not consume the draft in that case). */
  restoreComposerDraft?(draft: { value: string; images: { data: string; mimeType: string }[] }): boolean | Promise<boolean>;
  /** Registers a recovery-items provider (leftover input is merged into the recovery dialog; resolutions flow back through onResolve). Returns a disposer. */
  registerRecoveryItemsProvider?(provider: RecoveryItemsProvider): () => void;
  /** Registers the draft storage API (the core accesses it via getDraftApi(); all draft functionality belongs to the keeper). */
  registerDraftApi?(api: DraftApi): void;
  /** Registers the queue panel controller (ext → core reverse channel: the
   *  core calls expand after resolving a recovery/import).
   *  Returns a disposer. Without a takeover the core falls back to a banner
   *  (no collapsed state) and expand is a no-op. */
  registerQueuePanelController?(ctrl: QueuePanelController | null): () => void;
  /** Synchronously reads the current queue panel controller (null when no takeover). */
  getQueuePanelController?(): QueuePanelController | null;
  /** Triggers a host-side extension reload (fresh manifest fetch + graph
   *  reconciliation + invalidating materialize) — the extension-manager flow
   *  (refresh installed/enabled changes after a server-side hot reload;
   *  optional for compatibility with older hosts). opts.resyncOnly skips the
   *  POST /reload full reload (the caller already reloaded server-side, e.g.
   *  extension-manager ops) and only refetches the manifest + invalidates the
   *  client cache; older hosts ignore the flag and degrade to a full reload. */
  reloadExtensions?(opts?: { resyncOnly?: boolean }): Promise<{ invalidated: string[] }>;
  /** Current client loader state (materialized / prefetched extension ids) — for display in the extension management UI. */
  extLoaderState?(): { materialized: string[]; prefetched: string[] };
  /** [Lazy loading v2] Ensures an extension's client is materialized
   *  (idempotent; works for both lazy and immediate extensions). Returns
   *  whether this call actually completed the registration. Used by static
   *  entry click forwarding / extension-manager void opens / cross-extension
   *  interaction-time bootstrapping. */
  ensureMaterialized?(id: string): Promise<boolean>;
  /** [Lazy loading v2] Ensures all lazy extensions declaring a slot are materialized (a springboard for takeover direct-read points / interactive-time slots). */
  ensureSlotMaterialized?(slot: ExtSlotName): Promise<void>;
}

/** Chat-input hook store (registered by extensions; invoked when ChatInput sends) */
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

// ── Topic item registry (indirect coupling between extensions: providers
//    publish items via registerTopicItem, consumers read them synchronously
//    via getTopicItems. The core only relays (Map<topic, Set<item>>) and does
//    not interpret content — topic id + payload structure are inter-extension
//    contracts, defined and documented by the consumer (e.g. the
//    message-interaction extension's "msg-popover-action"). Load order is a
//    non-issue: items persist and consumers read them at interaction time
//    (by then every extension has registered).) ──
const topicItems = new Map<string, Set<unknown>>();
/** Registers a topic item; returns a disposer (removes exactly this registration). */
export function registerTopicItem<T>(topic: string, item: T): () => void {
  let set = topicItems.get(topic);
  if (!set) { set = new Set(); topicItems.set(topic, set); }
  set.add(item);
  return () => { set.delete(item); if (set.size === 0) topicItems.delete(topic); };
}
/** Synchronously reads all items of a topic (called by consumers at interaction time; not reactive, no subscription needed). */
export function getTopicItems<T>(topic: string): T[] {
  return Array.from(topicItems.get(topic) ?? []) as T[];
}

// ── Extension service registry (dependency-injection plan §4-C: an upgraded
//    sibling of topicItems — synchronous local direct calls, no HTTP) ── The
//    key contract matches the server: "<extId>.<name>" (the ctx closure
//    validates the prefix to prevent impersonation).
//    Shared in-process within the same page: a page-level Map; providers
//    register on client materialize, consumers check for absence and degrade.
type ExtServicePhase = "up" | "down";
const extServices = new Map<string, { impl: unknown }>();
const extServiceListeners = new Set<(key: string, phase: ExtServicePhase) => void>();
function emitExtService(key: string, phase: ExtServicePhase) {
  for (const cb of [...extServiceListeners]) {
    try { cb(key, phase); } catch { /* listener errors must not break the loop */ }
  }
}
/** Registers a cross-extension client service (keys are forced to the "<extId>." prefix). Returns a disposer (for invalidation). */
export function registerExtClientService<T>(extId: string, key: string, impl: T): () => void {
  // Same contract as the server's assertServiceKey: must be "<extId>.<name>", empty name segments rejected (anti-impersonation)
  if (typeof key !== "string" || key.length === 0 || !key.startsWith(extId + ".") || key === extId + ".") {
    throw new Error(`[ext] client service key must be "<extId>.<name>" (anti-impersonation): ${extId} attempted to provide "${key}"`);
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
/** Synchronously reads a cross-extension client service (undefined when absent — consumers check and degrade). */
export function getExtClientService<T>(key: string): T | undefined {
  return extServices.get(key)?.impl as T | undefined;
}
/** Subscribes to client service up/down (fires when a provider lazily materializes / unloads). Returns an unsubscribe function. */
export function onExtClientServiceChange(cb: (key: string, phase: ExtServicePhase) => void): () => void {
  extServiceListeners.add(cb);
  return () => { extServiceListeners.delete(cb); };
}

/** Chat send handler store (the single outlet for extension ctx.sendChatMessage; registered when ChatInput mounts) */
type ChatSendHandler = (text: string, mode: "steer" | "followUp" | "queue", images?: { data: string; mimeType: string }[]) => void;
let chatSendHandler: ChatSendHandler | null = null;
export function registerChatSend(fn: ChatSendHandler | null): void {
  chatSendHandler = fn;
}
export function dispatchChatSend(text: string, mode: "steer" | "followUp" | "queue", images?: { data: string; mimeType: string }[]): void {
  chatSendHandler?.(text, mode, images);
}

// Paragraph click takeover handler store (registered by extensions;
// broadcast when MarkdownBody is clicked on a paragraph).
// Note: the array reference must be replaced (never push in place) —
// useSyncExternalStore detects changes by getSnapshot reference identity.
// When an extension client loads dynamically after the first message render
// (e.g. entering a session right after a refresh), an in-place push would
// leave already-rendered paragraphs never re-wrapping (a click dead zone).
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
  // ui is fully serialized with the manifest (registry.ts `ui: e.ext.ui ?? null`):
  // besides i18n/provides it also carries each slot's static item arrays
  // (ExtUiStaticSlots) — the zero-bundle entry data source of lazy loading v2.
  ui: (ExtUiStaticSlots & { i18n?: Record<string, Record<string, string>>; provides?: string[]; clientImmediately?: boolean }) | null;
  icon?: string | null;
  features?: { id: string; type?: "boolean" | "string" | "textlist"; label?: string; placeholder?: string; enabled: boolean; value?: string }[] | null;
}

interface ManifestData {
  extensions: ManifestExt[];
  graph: PiWebBootGraph;
  /** Server-side load/startup failure list (registry errors: jiti parse
   *  errors / entry validation / startup throws). Visible as soon as the page
   *  opens (bottom-left error indicator); no need to open the extension
   *  manager's /status. */
  failed?: { id: string; error: string }[];
}

// ---- Server-side extension load failures → visible in the frontend ----
// registry errors used to be visible only in the extension manager's
// /status; now they travel with the manifest to the page and register in
// ExtErrorIndicator (bottom-left ⚠). After a fix, reload → the failed list
// updates → the error disappears automatically.
const registeredLoadErrors = new Set<string>();
function syncLoadErrors(failed: { id: string; error: string }[] | undefined): void {
  const next = new Set<string>();
  for (const f of failed ?? []) {
    const key = `ext-load-${f.id}`;
    next.add(key);
    // startup/shutdown prefixes (startAll/shutdown catch) → more accurate labels; anything else is an entry load failure
    const label = f.error.startsWith("startup: ") ? "Startup failed" : f.error.startsWith("shutdown: ") ? "Shutdown failed" : "Load failed";
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

// Unified notification pipeline: after the extension manager's set-feature
// succeeds it broadcasts → the host patches the shared feature store in
// place → subscribeExtFeatures subscribers (extensions) get notified (no
// refetch, no polling).
const FEATURES_CHANGED_EVENT = "pi-web:ext-features-changed";
if (typeof window !== "undefined") {
  window.addEventListener(FEATURES_CHANGED_EVENT, (e) => {
    const d = (e as CustomEvent)?.detail;
    if (d && d.extId && d.featureId) {
      // string features carry value (string); boolean features carry enabled (boolean)
      const v = (d.value !== undefined) ? d.value : (d.enabled !== false);
      patchExtFeature(String(d.extId), String(d.featureId), v as boolean | string);
    }
  });
}

/** Builds the register ctx for an extension (i18n table + host hooks + registration API). */

const EMPTY_I18N_TABLE: Record<string, string> = {};

/** Locale change event (dispatched by useI18n.setLocale; extension clients listen to it to re-render). */
export const LOCALE_CHANGED_EVENT = "pi-web:locale-changed";

/** Current UI locale (localStorage pi-locale, same source as useI18n; defaults to en). */
export function currentUiLocale(): string {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v === "zh-CN" || v === "en") return v;
  } catch { /* fall back to the default when storage is unavailable */ }
  return "en";
}

function makeClientContext(ext: ManifestExt): ExtClientContext {
  // The i18n table is resolved dynamically by current locale (t() takes effect
  // immediately after a locale switch):
  // current locale → same-language short code (zh) → en → any available table
  // (avoids en users seeing bare keys when only a zh table exists).
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
    // SidebarClone (a copy of the host SessionSidebar) pulls in host
    // components/hooks via the @/ alias — react in those modules is fully
    // aliased to the host shim, so the real delegated hooks are supplied here.
    // The host shim's lazy context (createContext cannot create a real
    // context before _ctx is injected) — wrappers marked __smI18nCtx resolve
    // uniformly to the host's real I18nContext (the SidebarClone useI18n chain).
    // host-shim lazy context (__smI18nCtx) → directly returns the host
    // useI18n() current value (t/locale follow the host locale)
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
      // extra is passed through as-is (ExtSlot destructures extra and spreads
      // it into the item render) — it was previously miswritten as
      // ...props.extra flattened onto top-level props, so ExtSlot never saw
      // extra and slot items all got undefined (the allProjects.length crash
      // in session-manager's workspacePickerActions management dialog was
      // caused by exactly this).
      extra: props?.extra as Record<string, unknown> | undefined,
      only: props?.only,
    }),
    // Reactive read of slot items (for self-arranging containers such as the
    // DockStack: split/sort by meta, then render item by item).
    // Hook: must be called in a component render body (internally the real
    // useExtSlotItems hook, including the lazy-load boot side effect).
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
          // render is optional: declarative toolbar items (meta.icon + meta.onClick) are rendered as standard buttons by the host
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
    // Host public API (AppShell registers the raw capabilities via registerHostApi; the fileName fallback adaptation lives in the framework layer)
    openFile: (path: string, fileName?: string, options?: OpenFileOptions) =>
      getHostApi().openFile?.(path, fileName ?? path.split("/").pop() ?? path, options),
    openFolder: (path: string, folderName?: string, options?: OpenFolderOptions) =>
      getHostApi().openFolder?.(path, folderName ?? path.split("/").pop() ?? path, options),
    revealDir: (absPath) => getHostApi().revealDir?.(absPath),
    getFileTabs: () => getHostApi().getFileTabs?.() ?? [],
    closeFileTabs: (ids: string[]) => getHostApi().closeFileTabs?.(ids),
    appendText: (text) => getHostApi().appendText?.(text),
    registerComposerEnhancement: (enh: ComposerEnhancement) => registerComposerEnhancement(enh),
    getComposerTrashWriter: () => getComposerTrashWriter(),
    writeComposerValue: (text: string) => getHostApi().writeComposerValue?.(text) ?? false,
    restoreComposerDraft: (draft) => getHostApi().restoreComposerDraft?.(draft) ?? false,
    registerRecoveryItemsProvider: (provider) => registerRecoveryItemsProvider(provider),
    registerDraftApi: (api) => registerDraftApi(api),
    registerQueuePanelController: (ctrl) => registerQueuePanelController(ctrl),
    getQueuePanelController: () => getQueuePanelController(),
    reloadExtensions: (opts?: { resyncOnly?: boolean }) => reloadExtensions(opts),
    extLoaderState: () => ({ materialized: materializedIds(), prefetched: prefetchedIds() }),
    // [Lazy loading v2] Explicit materialization API (extension-manager void opens / cross-extension interaction-time bootstrapping)
    ensureMaterialized: (id: string) => ensureExtMaterialized(id),
    ensureSlotMaterialized: (slot: ExtSlotName) => ensureExtSlotMaterialized(slot),
  };
  return ctx;
}

/** Host capabilities injected by AppShell (via ExtSlotsProvider props,
 *  handed down wrapped by makeClientContext).
 *  serverSlotDeclarations: the slot declaration table delivered by SSR (the
 *  server registry's ground truth, see plan §5) — seeded into the loader
 *  before children render so takeover/absence decisions have authoritative
 *  input on the **first frame**. */
export function ExtSlotsProvider({ children, serverSlotDeclarations }: { children: ReactNode; serverSlotDeclarations?: Record<string, string[]> | null }) {
  const [, force] = useState(0);
  // Seeded in the render body (idempotent, no side-effect rollback needed): must run before children (TakeoverSlot)
  seedServerDeclarations(serverSlotDeclarations);
  // SidebarClone's (via the @/ host-module chain) useI18n is delegated here through the host shim — the snapshot refreshes every render
  extI18nSnapshot = useI18n();
  useEffect(() => {
    void loadExtensions();
    const unsub = subscribeExtUi(() => force((v) => v + 1));
    return unsub;
  }, []);
  return <>{children}<ExtErrorIndicator /></>;
}

/** Local persistent manifest cache: with If-None-Match → a 304 means zero
 *  transfer and zero parsing. On write failure (quota/private mode) it
 *  silently degrades to a full fetch every time. */
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

/** Fetches the manifest and refreshes the client-side caches (manifestCache
 *  / declaredSlots / metas). Returns { extensions, graph }; returns null on
 *  failure (does not throw). Must refetch after a reload — otherwise a newly
 *  installed extension's metadata/i18n/declared slots stay stale and its
 *  client bundle never loads. */
async function fetchManifestData(): Promise<ManifestData | null> {
  try {
    const cached = loadManifestCache();
    const res = await fetch(apiUrl("/api/extensions/manifest"), {
      cache: "no-store",
      headers: cached ? { "if-none-match": cached.etag } : undefined,
    });
    let data: ManifestData | null = null;
    if (res.status === 304 && cached) {
      data = cached.data; // unchanged: zero transfer, use the local copy directly
    } else if (res.ok) {
      data = (await res.json()) as ManifestData;
      const etag = res.headers.get("etag");
      if (etag) saveManifestCache(etag, data);
    }
    if (!data) return null;
    // Event-bus deployment verdict (manifest ground truth, earliest moment):
    // the event-bus extension being in the manifest = installed and enabled
    // (disabled extensions are skipped by loadAll and never reach the
    // manifest); client registration is only a matter of time.
    // getEventBus uses this to park not-yet-ready subscription requests in a
    // queue (never falling back to a native EventSource); reload refetches
    // the manifest and flips it automatically (install/uninstall/enable/
    // disable). On failure (null return) the flag is not set: optimistic
    // queueing is kept.
    settleEventBusDeployed(
      data.extensions.some((e) => e.id === "aiti-event-bus") ||
      (data.graph?.entries ?? []).some((e) => e.id === "aiti-event-bus"),
    );
    // [Page-open plan §1 F1] The boot graph must land before the
    // per-extension registrations below: registering bumps the ui-store →
    // the useExtSlotItems materialize effect re-runs; if the graph is still
    // empty at that point, pendingForSlotAuto's fail-closed behavior would
    // skip even immediate extensions (the old code called setBootGraph only
    // after fetchManifestData returned, by which time the effect had already
    // run and let all lazy extensions through).
    setBootGraph(data.graph ?? { rev: "", entries: [] });
    // manifest metadata (name/icon/provides) → the host UI annotates
    // extension identity (top-bar custom panels etc.) and drives the built-in
    // UI's capability takeover switches (useExtProvides)
    const metas: Record<string, ExtMeta> = {};
    for (const ext of data.extensions) {
      manifestCache.set(ext.id, ext);
      metas[ext.id] = { name: ext.name, icon: ext.icon ?? null, provides: ext.ui?.provides };
      // Feature states are written uniformly into the shared store (managed by the extension manager; extensions read via ctx.getFeatures, zero extra requests)
      setExtFeatures(ext.id, ext.features ? Object.fromEntries(ext.features.map((f) => [f.id, f.type === "string" ? (f.value ?? "") : (f.enabled !== false)])) : null);
      // On-demand load registration: which UI slots are declared (slot keys with non-empty arrays in the ui definition).
      const declaredSlotKeys = ext.ui ? Object.keys(ext.ui).filter((k) => k !== "i18n" && k !== "provides" && k !== "clientDependsOn" && k !== "clientImmediately") : [];
      registerDeclaredSlots(ext.id, declaredSlotKeys);
      // [Lazy loading v2] Static item registration: the serializable
      // declarations in manifest ui[slot][] → a zero-bundle entry (the host
      // renders them directly before materialization; clicks go through
      // staticClickForwarder, which forwards to the registered item's onClick
      // after materialization). Only registered for lazy extensions
      // (clientImmediately:false): immediate extensions materialize in the
      // boot batch, so static items would only cause a fleeting double
      // render; also, immediate extensions' ui declarations were never
      // id-aligned with their client registrations (historically the host did
      // not render static declarations, so the mismatch was invisible) —
      // align and enable only when migrating each extension per the §5.5 SOP.
      if (ext.ui?.clientImmediately === false) {
        for (const slot of declaredSlotKeys) {
          const items = (ext.ui as Record<string, unknown>)[slot];
          if (Array.isArray(items) && items.length > 0) {
            registerStaticItems(slot as ExtSlotName, items as Parameters<typeof registerStaticItems>[1], ext.id);
          }
        }
      } else {
        // Extensions flipped from lazy back to immediate (or immediate ones that should have been cleaned anyway): retire static entries — without cleanup, ghost buttons linger
        removeStaticItems(ext.id);
      }
    }
    registerExtMetas(metas);
    // Stable extension order (manifest listing order): registration completion
    // order is random due to the interleaved loading pipeline; slot display
    // order follows the manifest order (ext-ui-store.getExtUiItems sorting),
    // so the top bar etc. stops jumping around
    setExtOrder(data.extensions.map((e) => e.id));
    // Uninstalled/disabled extensions no longer appear in the manifest —
    // clear their leftover slot declarations so pendingForSlot does not list
    // nonexistent extensions as on-demand load candidates.
    pruneDeclaredSlots(data.extensions.map((e) => e.id));
    // [Lazy loading v2] Clean up static item leftovers at the same point (buttons must not stay in the top bar after an extension is uninstalled/disabled)
    pruneStaticItems(data.extensions.map((e) => e.id));
    // server-side load failures → error indicator (same id overwrites for dedup; removed automatically once fixed)
    syncLoadErrors(data.failed);
    return data;
  } catch (e) {
    console.error("[ext] failed to fetch extension manifest:", e);
    return null;
  }
}

/** Boot settled signal: set as soon as loadExtensions' first attempt settles
 *  (success or failure both count). The "absence means native fallback"
 *  decision point (TerminalPanelBridge → native TerminalPanel) uses it +
 *  useExtSlotSettled to distinguish "manifest not back yet (cannot predict;
 *  prevents a late takeover double-opening)" from "this slot definitively
 *  has no takeover". */
let extBootSettled = false;
const extBootSettledListeners = new Set<() => void>();

function notifyExtBootSettled(): void {
  extBootSettled = true;
  // Unified SSE port plan §3-C1: synchronously sets the lib-side signal —
  // event-bus-client's getEventBus anchors the "bus absence verdict" to this
  // signal (instead of a fixed 3s timeout), eliminating the slow-load
  // misjudged-fallback window.
  notifyBootSignal();
  for (const listener of [...extBootSettledListeners]) {
    try { listener(); } catch { /* snapshot notification failures must not break the loop */ }
  }
}

/** First load: fetch manifest → write metadata + boot graph → prefetch + materialize per the graph. */
async function loadExtensions(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const data = await fetchManifestData();
    if (!data) return;
    setBootGraph(data.graph ?? { rev: "", entries: [] });
    // Two-phase loading: prefetch immediate entries (registration entry ready,
    // side effects not yet run) → materialize immediate entries (register(ctx)
    // invoked, side effects run). Lazy extensions (immediately:false) are
    // neither prefetched nor materialized — useExtSlotItems triggers them on
    // demand (download + register) the first time a slot they declare renders.
    // Failure isolation: one extension's failure does not affect the others.
    const immediate = immediateEntriesByPriority(data.graph ?? { rev: "", entries: [] });
    await Promise.allSettled(immediate.map((e) => prefetch(e.id)));
    // materialize scheduling (unified SSE port plan §3-B): materialize the
    // highest-priority entry alone first (the event-bus extension →
    // window.__piEventBus mounts its slot first, so consumers probing via
    // getEventBus see no race window), then the remaining immediate entries in
    // parallel (register side effects are independent of each other; the
    // materializing Map is mutually exclusive against re-entry, safe even
    // under StrictMode double effects) — this also removes the startup
    // bottleneck of ~51 extensions registering serially.
    const matBoot = (entry: (typeof immediate)[number]) => {
      const ext = manifestCache.get(entry.id) ?? data.extensions.find((e) => e.id === entry.id);
      if (!ext) return Promise.resolve(); // entry in the graph but no matching extension in the manifest — skip, do not build a ctx
      return materialize(entry.id, () => makeClientContext(ext));
    };
    const [first, ...rest] = immediate;
    if (first) await matBoot(first);
    await Promise.allSettled(rest.map(matBoot));
  } finally {
    notifyExtBootSettled();
  }
}

/** HMR precise invalidation: POST reload (server-side shutdown→loadAll→startAll)
 *  → refetch the manifest to refresh client caches (newly installed
 *  extensions' metadata/i18n/declared slots) → compare against the latest
 *  graph's rev and invalidate only changed extensions.
 *  opts.resyncOnly skips the POST /reload (the caller — extension-manager
 *  ops — already performed the server-side full reload within the same
 *  request and returned the latest state in the response; POSTing again
 *  would repeat the full shutdown→loadAll→startAll, measured at ~4s extra).
 *  Only the manifest refetch + client cache invalidation happen here. */
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
      // Refetch the manifest after a successful server-side hot reload —
      // manifestCache/declaredSlots/metas are snapshots from first load;
      // without a refresh, newly installed extensions cannot find their
      // metadata and their client bundles never load (B).
      const data = await fetchManifestData();
      if (!data) return { invalidated: [] };
      const graph = data.graph ?? { rev: "", entries: [] };
      const oldGraph = getBootGraph();
      const invalidated = reconcileGraph(graph, (extId) => removeExtUiItems(extId));
      // Newly added entries (back in the graph after enable/install) must load too — reconcileGraph only invalidates changed/removed items.
      const added = graph.entries
        .filter((e) => !oldGraph.entries.some((o) => o.id === e.id))
        .map((e) => e.id);
      // Re-prefetch + re-materialize invalidated and added extensions. Lazy
      // (immediately:false) entries stay lazy — invalidation only clears the
      // old registration; the new bundle is left for slots to trigger on
      // demand (consistent with the boot batch). materialize scheduling
      // matches the boot batch (§3-B): the highest-priority entry (the bus)
      // re-mounts alone first, the rest in parallel.
      const reloadIds = [...invalidated, ...added]
        .filter((id) => {
          const entry = entryOf(id);
          return manifestCache.has(id) && entry != null && isImmediateEntry(entry);
        })
        .map((id, i) => ({ id, p: entryOf(id)?.priority ?? 0, i }))
        .sort((a, b) => b.p - a.p || a.i - b.i)
        .map((x) => x.id);
      const matId = async (id: string) => {
        await prefetch(id);
        await materialize(id, () => makeClientContext(manifestCache.get(id)!));
      };
      const [firstId, ...restIds] = reloadIds;
      if (firstId) await matId(firstId);
      await Promise.allSettled(restIds.map(matId));
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

/** manifest cache (re-materialize after reload invalidation needs the original ext metadata/i18n table). */
const manifestCache = new Map<string, ManifestExt>();

// ── [Lazy loading v2] Static item click forwarder: zero-bundle entry →
// materialize → registered item behavior ──
// pending is set (button loading state + double-click guard) →
// ensureMaterialized → the registered item's meta.onClick / meta.open for the
// same (extId,id) → reset. Failures go through
// registerExtSlotError(kind:"load") into the bottom-left indicator (§7-R2).
// Stale clicks after uninstall/disable (extension gone from the manifest)
// take the same error-indicator path.
// The in-flight set guards re-entry: concurrent clicks from the toolbar
// button and the ⋯ menu row forward only once.
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
        message: "Static entry click: extension no longer in the manifest (uninstalled/disabled?)", reset: () => {},
      });
      return;
    }
    await ensureMaterialized(extId, () => makeClientContext(ext));
    const reg = getExtUiItems(slot).find((it) => it.extId === extId && it.id === itemId);
    if (!reg) {
      registerExtSlotError({
        id: errId, extId, slot, itemId, kind: "load",
        message: `Static entry click: no registered item found for ${slot} (client not registered or id mismatch)`, reset: () => {},
      });
      return;
    }
    const onClick = reg.meta?.onClick;
    const open = (reg.meta as { open?: unknown } | undefined)?.open;
    if (typeof onClick === "function") onClick(ev);
    else if (typeof open === "function") (open as (e?: unknown) => void)(ev);
    else console.warn(`[ext] ${extId} registered item ${slot}/${itemId} lacks onClick/open; static click forward dropped`);
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
// Injected once (module level; re-injected when Fast Refresh rebuilds this
// module). The forwarder only dereferences manifestCache/makeClientContext
// at runtime, so declaration order has no TDZ issue.
setStaticClickHandler(staticClickForwarder);

/** [Lazy loading v2] Ensures an extension's client is materialized
 *  (idempotent; returns false when missing from the manifest).
 *  Shared by host components (FileViewer/viewer-page takeover springboard)
 *  and cross-extension consumers. */
export function ensureExtMaterialized(id: string): Promise<boolean> {
  const ext = manifestCache.get(id);
  if (!ext) return Promise.resolve(false);
  return ensureMaterialized(id, () => makeClientContext(ext));
}

/** [Lazy loading v2] Ensures all lazy extensions declaring the slot are
 *  materialized (springboard for takeover direct-read points: opening a file
 *  tab = an interaction moment; editor/folder load once before their first
 *  takeover). */
export async function ensureExtSlotMaterialized(slot: ExtSlotName): Promise<void> {
  await ensureSlotMaterialized(slot, (id) => {
    const ext = manifestCache.get(id);
    if (!ext) throw new Error(`[ext] ${id}: manifest missing, cannot materialize`);
    return makeClientContext(ext);
  });
}

/** Slot takeover absence verdict: the boot manifest has settled and nobody
 *  declares the slot. Used by "absence means native fallback" direct-read
 *  points (TerminalPanelBridge) — the native panel must not render before
 *  the verdict: if a takeover is declared but not yet materialized (or
 *  materialization failed), spinning up the native PTY first would
 *  double-open once the takeover arrives. Declared/not-declared is decided
 *  from the manifest snapshot in one shot, with no materialization race.
 *  Re-renders as the ui-store version advances. */
export function useExtSlotSettled(slot: ExtSlotName): boolean {
  useSyncExternalStore(subscribeExtUi, extUiVersion, () => 0);
  return extBootSettled && !slotDeclared(slot);
}

/** Read registered items for a slot, re-rendering when the store changes. */
export function useExtSlotItems(slot: ExtSlotName): ExtUiItemRegistered[] {
  const [items, setItems] = useState<ExtUiItemRegistered[]>(() => getExtUiItems(slot));
  // [Lazy-load adaptation 2026-09-09] ui-store version: manifest readiness
  // (registerDeclaredSlots/registerStaticItems/registerExtMetas all bump it),
  // reload invalidation, and feature changes all advance it.
  // The materialize effect depends on it — "always-mounted" slots such as
  // terminalDock (the TerminalPanelBridge in AppShell's hidden container)
  // mount before the manifest's async fetch completes; previously the effect
  // depended only on [slot] and ran once: on that first run declaredSlots
  // was empty → pendingForSlot stayed empty → the declaring extension never
  // materialized → the restored terminal tab was stuck forever on the
  // "terminal-command extension not detected" fallback. After a version bump
  // the effect re-runs; pendingForSlot is idempotent (already-materialized
  // extensions are not re-triggered), which also fixes lazy extensions no
  // longer being pulled up by slots after a reload invalidation.
  const version = useSyncExternalStore(subscribeExtUi, extUiVersion, () => 0);
  useEffect(() => {
    const update = () => setItems(getExtUiItems(slot));
    update(); // pick up items registered before this hook mounted
    const unsubUi = subscribeExtUi(update);
    // Locale switch → refetch items (new array identity) → registered extension UI re-renders (t() reads the new locale table)
    window.addEventListener(LOCALE_CHANGED_EVENT, update);
    return () => { unsubUi(); window.removeEventListener(LOCALE_CHANGED_EVENT, update); };
  }, [slot]);

  // On-demand loading: extensions that declare this slot but are not yet
  // materialized → trigger materialize on first render (side effect =
  // register(ctx)); on completion the store bumps → re-render.
  // [Lazy loading v2] The trigger surface is split per slot: interactively
  // mounted slots (INTERACTIVE_SLOTS — opening settings/files/terminal is
  // itself an interaction moment) pull up all declaring extensions (lazy
  // included, pendingForSlot's original semantics); always-mounted slots
  // (toolbar/sidebar/…20+, rendered on first paint) only pull immediate
  // extensions (pendingForSlotAuto) — lazy extensions' entries on
  // always-mounted slots are carried by manifest static items and materialize
  // only on click, keeping the first paint zero-request.
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
      if (alive) setItems(getExtUiItems(slot)); // materialize → store bump → fetch latest
    })();
    return () => { alive = false; };
  }, [slot, version]);

  return items;
}

/** extId → manifest metadata (name/icon), re-rendering as the store version changes. */
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

/** The set of capability names declared as taken over by all loaded
 *  extensions (union of manifest ui.provides). The built-in UI uses it to
 *  decide whether to step aside: e.g. the sidebar delete button hides when
 *  someone declares session-delete. */
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

// ---- Extension slot render errors: global registry + persistent indicator
//      (layer 3 of the ext-client hardening plan) ----
// An item render throw no longer leaves a placeholder inside the slot (the
// slot may be hidden, where a placeholder is neither visible nor usable);
// instead the boundary silently collapses + reports to this registry, and a
// persistent small button at the page's bottom-left (shown only when there
// are errors) handles them uniformly.
export type ExtSlotError = {
  id: string;
  extId?: string;
  slot: string;
  itemId: string;
  message: string;
  stack?: string;
  reset: () => void;   // Dismiss: retry the render (meaningful only for render-time errors; no-op for uncaught/load)
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

/** Persistent bottom-left error indicator: shows a small button when slot render errors exist; clicking it lists the errors (copy/dismiss/close); hidden when there are none. */
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
  // 🚑 Emergency AI state (independent session, bypasses the chat UI; output shown as-is)
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSid, setAiSid] = useState<string | null>(null);
  const [aiLog, setAiLog] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  // Multi-error paging: a new error arrives → jump to the latest; errors shrink → clamp idx
  useEffect(() => {
    if (errors.length > prevLen.current) setIdx(errors.length - 1);
    else if (idx > errors.length - 1) setIdx(Math.max(0, errors.length - 1));
    prevLen.current = errors.length;
  }, [errors.length, idx]);
  // Globally captures non-render JS errors from extension clients (event
  // handlers / async / promise rejections) — the boundary only catches render
  // throws; these escape to window.onerror/unhandledrejection
  useEffect(() => {
    const onErr = (event: ErrorEvent | PromiseRejectionEvent) => {
      const err = event instanceof ErrorEvent ? event.error : event.reason;
      const msg = (err instanceof Error ? err.message : String(err ?? "")) || "unknown error";
      const stack = err instanceof Error ? err.stack : "";
      const src = event instanceof ErrorEvent ? event.filename ?? "" : "";
      // Attribute to an extension: stack/source URL contains /api/extensions/<id>/; non-extension origins are not captured
      const m = `${stack || ""}\n${src}`.match(/\/api\/extensions\/([^/]+)\//);
      if (!m) return;
      const extId = m[1];
      if (findExtSlotError(extId, msg)) return;  // dedup: same extension + same message is not stacked again
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
  // Position persistence (localStorage) — modeled on the movable launcher fab + restored across refreshes
  useEffect(() => {
    try {
      const s = localStorage.getItem("ext-err-btn-pos");
      if (s) { const p = JSON.parse(s); if (typeof p?.left === "number" && typeof p?.top === "number") setPos(p); }
    } catch {}
  }, []);
  // Drag to move (same semantics as makePointerDrag: a 6px threshold separates
  // click from drag, late capture, persistence).
  // Panel toggling rides on onClick: after a drag the button has moved →
  // mouseup lands elsewhere → no click fires → no toggle; a pure click →
  // click fires → toggles. The dragMoved ref guards against the "tiny drag
  // still produces a click" false toggle.
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
      d.left = left; d.top = top;  // store final values for up to persist (React re-render is async; btnRef still holds the old value here)
      setPos({ left, top });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = dragRef.current; dragRef.current = null;
      if (!d?.moved) return;  // pure click → do not persist (onClick handles toggling)
      try { localStorage.setItem("ext-err-btn-pos", JSON.stringify({ left: d.left, top: d.top })); } catch {}  // persist the final position
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onToggle = () => {
    if (dragMoved.current) { dragMoved.current = false; return; }  // drag just ended → do not toggle
    setOpen((v) => !v);
  };
  const copy = (e: ExtSlotError) => {
    const kindLabel = e.kind === "load" ? "Load failed" : e.kind === "uncaught" ? "Uncaught error" : "Render failed";
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
  // 🚑 Emergency AI: POST /api/emergency (independent session, includes the config-management extension's tools); the first round automatically carries error context
  const sendAi = async () => {
    const text = aiInput.trim();
    if (!text || aiBusy) return;
    const cwd = (window as unknown as { __piWebCwd?: string | null }).__piWebCwd;
    const kindWord = cur?.kind === "load" ? "load failure" : "crash";
    const msg = aiSid ? text : `[Emergency context] Extension ${cur?.extId ?? "?"} ${cur?.slot}/${cur?.itemId} ${kindWord}: ${cur?.message}\nStack: ${cur?.stack || "(none)"}\n\nUser instruction: ${text}`;
    // Placeholder empty AI message — streamed content keeps appending (fully shown)
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
      if (!acc) setLastAi(() => "(no output)");
    } catch (e) {
      setLastAi((t) => `${t}${t ? "\n" : ""}[Network error] ${e instanceof Error ? e.message : String(e)}`);
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
        title={`Extension errors (${errors.length}) — click to view / draggable`}
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
          {/* Top bar: title + paging + action buttons all live here (removing
              the duplicate bottom bar); the first child element = the
              floating-dialog extension's drag handle.
              data-ext-float-autoh="1": height is not fixed and not persisted
              (adapts to content), keeping the floating-dialog extension's
              drag/width-resize/persistence/maximize; no overflow:hidden —
              the panel's own maxHeight 85vh + overflowY auto take effect
              (the dialog auto-expands when the AI panel opens, scrolling
              internally past 85vh). */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted, #aaa)", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>Extension errors</span>
            {errors.length > 1 ? (
              <>
                <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={ci === 0} title="Previous" style={{ ...btn, opacity: ci === 0 ? 0.4 : 1 }}>‹</button>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{ci + 1}/{errors.length}</span>
                <button onClick={() => setIdx((i) => Math.min(errors.length - 1, i + 1))} disabled={ci === errors.length - 1} title="Next" style={{ ...btn, opacity: ci === errors.length - 1 ? 0.4 : 1 }}>›</button>
              </>
            ) : null}
            <span style={{ marginLeft: "auto" }} />
            <button onClick={() => copy(cur)} title="Copy full error (with stack)" style={btn}>{copiedId === cur.id ? "Copied ✓" : "Copy"}</button>
            {cur.kind === "render" && (
              <button onClick={() => { unregisterExtSlotError(cur.id); cur.reset(); }} title="Dismiss: retry the render (recaptured if the error persists)" style={btn}>Dismiss</button>
            )}
            <button onClick={() => setAiOpen(v => !v)} title="Emergency AI: fix this error in an independent session (with backup helper tools)" style={btn}>🚑</button>
            <button onClick={() => setOpen(false)} title="Close: collapse the panel (errors are kept)" style={btn}>✕</button>
          </div>
          {/* Content area: flex:1 + minHeight:0 + overflowY auto (the
              floating-dialog extension's convention: title bar at natural
              height + content area flex:1 scrolling itself) — on
              maximize/resize the content follows the height without
              overflowing or leaving blanks */}
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
                <strong style={{ fontWeight: 700, color: "#f59e0b" }}>{cur.extId ?? "?"}</strong>{cur.kind === "uncaught" ? " · uncaught" : cur.kind === "load" ? ` · ${cur.itemId}` : `/${cur.itemId}`}: {cur.message}
              </div>
              {cur.stack && (
                <pre style={{ margin: 0, maxHeight: 140, overflow: "auto", fontSize: 11, lineHeight: 1.45, color: "var(--text, #e8e8e8)", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", background: "rgba(0,0,0,0.06)", border: "1px solid var(--border, #444)", padding: "5px 7px", borderRadius: 5 }}>
                  {cur.stack}
                </pre>
              )}
              {/* Action buttons moved to the top bar; no duplicate bottom bar here */}
              {aiOpen && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
                  {/* AI output area: flex:1 grows with height (minHeight 160, ≥10 lines); shows a placeholder hint before sending */}
                  <div style={{ flex: 1, minHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "2px 0" }}>
                    {aiLog.length === 0 && !aiBusy ? <span style={{ fontSize: 10, color: "var(--text-dim, #6b7280)", lineHeight: 1.5 }}>AI output appears here as-is after sending (multi-turn supported). The first round automatically includes the error context.</span> : null}
                    {aiLog.map((m, i) => (
                      <div key={i} style={{ fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", lineHeight: 1.4, color: m.role === "user" ? "var(--text-muted, #888)" : "var(--text, #eee)", borderLeft: `2px solid ${m.role === "user" ? "var(--border, #444)" : "#f59e0b"}`, paddingLeft: 5 }}>{m.text}</div>
                    ))}
                    {aiBusy && <div style={{ fontSize: 10, color: "var(--text-muted, #888)" }}>Thinking…</div>}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <input value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } }} placeholder="Emergency instruction (Enter to send)…" disabled={aiBusy} style={{ flex: 1, fontSize: 11, padding: "3px 6px", background: "var(--bg, #1a1a1a)", color: "var(--text, #eee)", border: "1px solid var(--border, #444)", borderRadius: 4, outline: "none" }} />
                    <button onClick={sendAi} disabled={aiBusy || !aiInput.trim()} style={btn}>{aiBusy ? "…" : "Send"}</button>
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
/** Extension item render error boundary (layer 3 of the ext-client hardening
 *  plan). An item component render throw (e.g. a leftover-TS ReferenceError
 *  in .mjs) silently collapses (renders null) instead of bubbling up and
 *  crashing the whole page (crash-rescue §4.2: slots like sidebar/
 *  composerTools have no ancestor boundary — a crash would pierce through
 *  to the root). Errors are reported to the global registry and handled
 *  uniformly by the ExtErrorIndicator persistent button. */
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
    console.error(`[ext] ${extId ?? "?"} item ${slot}/${itemId} render failed (collapsed silently; see the bottom-left indicator):`, err);
    // Fingerprint dedup (extId+slot+itemId+render): transient slots (e.g.
    // dropdowns) toggling repeatedly unload/remount the boundary; when a
    // remount crashes again the original entry is reused/overwritten (Map.set
    // with the same id) instead of stacking duplicate cards.
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
    // Do not unregister the error here: slot unmount ≠ error gone. When a
    // transient slot (a picker dropdown etc.) closes on outside click, the
    // boundary unmounts with it; unregistering on the spot would let the
    // user's ⚠/🚑 click (both count as outside-dropdown clicks) chain-close
    // the dropdown → unregister → ⚠ and the error panel vanish together (the
    // culprit behind "clicking did nothing"). Errors stay until explicitly
    // cleared by the dismiss button, or until overwritten by a
    // same-fingerprint re-registration.
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
  /** Extra slot props — typed from the ExtSlotContractMap contract (falls back to a loose object when undeclared). */
  extra?: ExtSlotProps<S>;
  /** Render only the item whose registered id equals this value (dock plan
   *  §4.3: used to dispatch the rightFileDock content area by active tab;
   *  id = the registered composite id "extId:itemId". No filtering by
   *  default — zero impact on other slots). */
  only?: string;
}) {
  const items = useExtSlotItems(name)
    // render is optional (declarative toolbar items are rendered by the host); other slots only consume items with render
    .filter(hasExtRender)
    .filter((it) => !only || it.id === only);
  // Framework-level extension identity stamping: only for "dialog-class"
  // slots (dialogs/pages, both position:fixed overlays), each item is wrapped
  // in a display:contents div stamped with
  // data-ext-id/data-ext-slot/data-ext-item — it creates no box and does not
  // affect layout (fixed-position children still escape as usual), but the
  // DOM lets external scripts (the AI-helper extension's global dialog AI
  // button) find the owning extension via closest('[data-ext-id]').
  // dialogs/pages only: inline-layout slots such as
  // sidebar/sidebarFooter/chatInputTop/userMessageActions are not wrapped
  // (display:contents would still break their `>` direct-child CSS and flex
  // child semantics).
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

// ── TakeoverSlot —— the generic "yield the whole block when taken over"
//    slot (unified sidebar dock plan §3.2) ──
// Generalized from SessionSidebar's private takeover logic (projectsTakeover
// + 3s fallback + first-frame memory):
//  · Takeover memory key = `pi-web:takeover:<name>` ("1" = the previous
//    session had a takeover). Extension items register asynchronously
//    (necessarily empty on the first frame); the memory lets a "refresh
//    while taken over" render the fallback per takeover semantics on the
//    first frame (no old-UI flash, no wasted host data fetch); consumers
//    read `useTakeoverHint(name)` to decide synchronously.
//  · Legacy key migration (legacyKey): read once on the first frame; on a
//    hit, migrate into the new key (one-way; the old key is kept so a
//    rolled-back old host can still read it).
//  · Fallback window 800ms (plan §3.8 decision, compressed from the original
//    3s): memory hit but items never register (stale cache after the
//    extension was disabled/uninstalled) → clear the memory when the window
//    elapses and keep the fallback.
const TAKEOVER_MEM_PREFIX = "pi-web:takeover:";
const emptySubscribe = () => () => {};
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
/** Reactively reads the takeover memory (synchronous hit on the first frame
 *  — fallback components like SessionSidebar use it to gate "don't render /
 *  don't fetch while taken over" blocks, with no flash). */
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
  /** Legacy takeover memory key (migration entry for historical private keys; no migration by default). */
  legacyKey?: string;
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
}) {
  const items = useExtSlotItems(name).filter(hasExtRender);
  const takeover = items.length > 0;
  const takeoverRef = useRef(takeover);
  takeoverRef.current = takeover;
  // Memory (read from localStorage on the first frame, incl. legacy key
  // migration): a live takeover writes "1"; going from present to absent
  // (disabled/uninstalled/invalidated) writes "0" and broadcasts (fallback
  // components restore the old block immediately).
  const memRef = useRef<boolean | null>(null);
  if (memRef.current === null) memRef.current = readTakeoverMem(name, legacyKey);
  const everSeenRef = useRef<boolean | null>(null); // null = registration state not yet observed this session
  // Waiting window (companion to §7-2): memory hit but items not yet arrived →
  // render a blank placeholder instead of the whole fallback — prevents the
  // old sidebar flashing in as one block. hintPending must be hydration-safe:
  // always false during SSR/first frame (matching the server, preventing a
  // #418 mismatch); after mount it flips true before paint via uSES's
  // hydrated marker.
  const [hintCleared, setHintCleared] = useState(false);
  const hydrated = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const hintPending = hydrated && !hintCleared && memRef.current === true;
  useEffect(() => {
    if (takeover) {
      everSeenRef.current = true;
      if (!memRef.current) { memRef.current = true; writeTakeoverMem(name, true); window.dispatchEvent(new Event(TAKEOVER_MEM_EVENT)); }
      return;
    }
    if (everSeenRef.current === true) {
      everSeenRef.current = false;
      if (memRef.current) { memRef.current = false; writeTakeoverMem(name, false); window.dispatchEvent(new Event(TAKEOVER_MEM_EVENT)); }
      setHintCleared(true);
    }
    // While the first frame has no registration (everSeen===null), leave the memory untouched: wait for the registration event to decide, avoiding wiping a genuine takeover memory
  }, [takeover, name]);
  // Fallback: memory hit but the extension never registers (stale cache) → after a one-shot 800ms check, clear the memory and release the fallback (plan §3.8)
  useEffect(() => {
    if (!hydrated || hintCleared || memRef.current !== true) return;
    const timer = setTimeout(() => {
      if (takeoverRef.current) return;
      memRef.current = false;
      writeTakeoverMem(name, false);
      setHintCleared(true);
      window.dispatchEvent(new Event(TAKEOVER_MEM_EVENT));
    }, 800);
    return () => clearTimeout(timer);
  }, [hydrated, hintCleared, name]);
  // [§5 Server-authoritative] The first frame already knows whether the slot
  // has a taker: the SSR-delivered declaration seed (server registry ground
  // truth) or declarations after the client manifest settles. With a taker,
  // the first frame holds the placeholder and never mounts the fallback —
  // avoiding the fallback sidebar fetching the full session list on mount
  // (measured 1.59MB decoded) only to be replaced by the takeover.
  // Note: SSR and first-frame client render inputs are identical (props, not
  // localStorage), so there is no hydration mismatch.
  const declared = slotDeclared(name);
  const declaredDecided = isServerDeclarationsKnown() || extBootSettled;
  const [declaredReleased, setDeclaredReleased] = useState(false);
  useEffect(() => {
    if (!declaredDecided || !declared || takeover || declaredReleased) return;
    // Takeover declared but never materializes (bundle failure / disable race) → after the fallback window, release the fallback
    const timer = setTimeout(() => setDeclaredReleased(true), 1500);
    return () => clearTimeout(timer);
  }, [declaredDecided, declared, takeover, declaredReleased]);
  if (takeover) return <ExtSlot name={name} currentSession={currentSession} extra={extra as never} />;
  if ((declaredDecided && declared && !declaredReleased) || hintPending) return null;
  return <>{fallback}</>;
}
