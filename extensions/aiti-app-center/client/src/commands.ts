/**
 * aiti-app-center · commands —— 应用命令提示查询服务（aiti-ai-input suggest 的 kind="app" 候选数据源）。
 * 方案：workspace-tools docs/aiti-ai-input-app-command-hints-plan.md。
 *
 * 服务 key：`aiti-app-center.commands`（客户端服务，entry register 时经 regSvc 注册——materialize
 * 即可用，不依赖 DockStack 渲染 AppCenter）。
 *
 * query(q, limit?) → CommandHint[]（轻量投影 + run() 闭包 + 成品文案）：
 *   - 插槽条目经宿主 ctx.getSlotItems 三槽现读（非 hook 只读口 = getExtUiItems：静态条目自带
 *     物化转发 onClick、feature 门控内置——懒扩展候选点击 = 物化转发 = 正常执行）
 *   - manifest 元数据（extName/features 基线）TTL 30s 缓存 + in-flight 合流 + 注册时后台预热；
 *     接受 ≤30s 禁用残留窗口（exts 仅用于展示名，执行端 catch 兜底）；插槽条目面每次 query
 *     现读（禁用即从 store 移除，无残留）
 *   - feature overlay：监听既有 pi-web:ext-features-changed；featureState 按当前 exts 循环生成
 *     （overlay 残留键天然不进——比组件版 dropExt 更干净）
 *   - pinned/hidden：query 时现读 localStorage（新鲜）；排序 = pinned 序 → buildApps 输出序
 *   - toggle 执行：setBooleanFeature（extman REST + 广播回灌，store bump 下次 query 态自愈）
 *   - i18n：分类展示名复用 cat.* 词条（t() 现查 locale）→ 投影返回成品文案（文案职责归数据提供方，
 *     消费方 ai-input 零复制）
 */
// 相对 import 显式 .ts 后缀：commands.test.mjs 走 node --experimental-strip-types 直载（vite/esbuild 同样解析）
import { getCtx, regSvc, apiUrl, t } from "./host-shim.ts";
import {
  buildApps, matchApp, categoryLabel, readPinned, readHidden, setBooleanFeature, currentUiLocale,
  type AppDescriptor,
} from "./app-registry.ts";
import { present, presentState, dockPref } from "../../../_shared/ext-float-dock-core.ts";

/** manifest 扩展条目子集（buildApps 输入面）。 */
interface ManifestExt {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  icon?: string | null;
  category?: string;
  features?: Array<{ id: string; type?: string; label?: string; description?: string; category?: string; enabled: boolean }> | null;
}

/** 命令候选轻量投影（ai-input 弹窗/建议条渲染 + 执行）。 */
export interface CommandHint {
  /** "action:<extId>:<itemId>" / "panel:…" / "manage:…" / "toggle:<extId>:<featureId>" */
  id: string;
  kind: "action" | "panel" | "manage" | "toggle";
  label: string;
  extId: string;
  extName?: string;
  /** 分类成品文案（内部分类已按 locale 翻译；自定义分类原文）。 */
  category: string;
  /** 声明式图标三形态：{svg} 内联 / "icons/*.svg" 相对路径（URL 由消费方拼）/ emoji 文本。 */
  icon?: string | { svg: string };
  /** toggle 当前态（仅 toggle）。 */
  on?: boolean;
  /** 执行（action=meta.onClick / panel=present 状态机 / toggle=切换开关）。消费方调用处 catch 兜底。 */
  run: () => void;
}

/* ── 面板打开原语（从 app-center.tsx 上提：present 状态机语义糖，AppCenter 组件同源消费） ── */

/** 已停靠 → 原位激活（ACTIVATE 置前）；有偏好 → 落偏好位；否则右栏 tab（dock 面板的宿命位）。 */
export function openPanel(key: string): void {
  try {
    const cur = presentState(key);
    if (cur.startsWith("docked:")) {
      const zone = cur.slice("docked:".length);
      if (zone) { present(key, `dock:${zone}`); return; }
    }
    const pref = dockPref(key);
    if (pref && pref !== "float") { present(key, `dock:${pref}`); return; }
    present(key, "dock:right-panel");
  } catch { /* ignore */ }
}

/* ── manifest 缓存（TTL 30s + in-flight 合流；entry 注册时 prime 后台预热） ── */

const MANIFEST_TTL_MS = 30_000;
let extsCache: { at: number; exts: ManifestExt[] } | null = null;
let extsInflight: Promise<ManifestExt[]> | null = null;

/** 后台预热（entry 注册时调；失败静默——query 时会再试）。 */
export function primeCommandsCache(): void { void loadExts(); }

async function loadExts(): Promise<ManifestExt[]> {
  if (extsCache && Date.now() - extsCache.at < MANIFEST_TTL_MS) return extsCache.exts;
  if (extsInflight) return extsInflight;
  extsInflight = (async () => {
    try {
      const res = await fetch(apiUrl("/api/extensions/manifest"));
      const d = await res.json();
      const exts = Array.isArray(d?.extensions) ? (d.extensions as ManifestExt[]) : [];
      extsCache = { at: Date.now(), exts };
      return exts;
    } catch {
      return extsCache?.exts ?? [];
    } finally {
      extsInflight = null;
    }
  })();
  return extsInflight;
}

/* ── feature overlay（extman 广播 → 本地覆盖层；模块级幂等 bind） ── */

const featureOverlay: Record<string, boolean> = {};
let overlayBound = false;
function bindFeatureOverlay(): void {
  if (overlayBound || typeof window === "undefined") return;
  overlayBound = true;
  window.addEventListener("pi-web:ext-features-changed", ((e: Event) => {
    const d = (e as CustomEvent<{ extId?: string; featureId?: string; enabled?: boolean; value?: string }>).detail;
    if (!d?.extId || !d?.featureId) return;
    featureOverlay[`${d.extId}:${d.featureId}`] = d.value !== undefined ? d.value !== "" : d.enabled !== false;
  }) as EventListener);
}

/** featureState 按当前 exts 循环生成（只 boolean；overlay 残留键因不循环到而天然失效）。 */
function currentFeatureState(exts: ManifestExt[]): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const e of exts) {
    for (const f of e.features ?? []) {
      if (f.type && f.type !== "boolean") continue;
      const key = `${e.id}:${f.id}`;
      m[key] = featureOverlay[key] ?? f.enabled !== false;
    }
  }
  return m;
}

/* ── 纯投影（依赖注入形态，可单测） ── */

export function buildCommandHints(input: {
  q: string;
  limit?: number;
  exts: ManifestExt[];
  slotItems: Array<{ slot: "toolbar" | "sidebarFooter" | "rightFileDock"; id: string; extId?: string; meta?: { label?: string; title?: string; icon?: unknown; onClick?: (e?: unknown) => void }; category?: string; feature?: string; static?: boolean }>;
  featureState: Record<string, boolean>;
  pinned: string[];
  hidden: string[];
  openPanelFn: (key: string) => void;
  apiUrlFn: (p: string) => string;
  categoryText: (id: string) => string;
}): CommandHint[] {
  const limit = input.limit ?? 5;
  const q = String(input.q ?? "").trim();
  // buildApps：插槽条目 → action/panel/manage 卡（含静态条目物化转发）+ manifest boolean features → toggle 卡
  // （含同扩展同名跨 kind 去重：panel 优先）。toggle 卡 run 为空占位，投影时接 setBooleanFeature。
  const apps = buildApps({
    exts: input.exts as Parameters<typeof buildApps>[0]["exts"],
    slotItems: input.slotItems as Parameters<typeof buildApps>[0]["slotItems"],
    featureState: input.featureState,
    openPanel: input.openPanelFn,
    locale: currentUiLocale(), // query 时现读：静态条目 "i18n:" 标签按当前 locale 出成品文案
  });
  const hiddenSet = new Set(input.hidden);
  const qEmpty = !q;
  let list = apps.filter((a) => a.kind === "toggle" || !hiddenSet.has(a.id));
  // 空 q = 常用（pinned）语义：仅返回 pinned（不补满，避免无输入时推荐噪音）；
  // 非 q 匹配（matchApp 分词子串：label/extId/extName/keywords）
  const pinnedSet = new Set(input.pinned);
  if (qEmpty) list = list.filter((a) => pinnedSet.has(a.id));
  else list = list.filter((a) => matchApp(a, q));
  // 排序：pinned 序优先（稳定——其余保持 buildApps 输出序 = manifest 序）
  const pinnedIdx = new Map(input.pinned.map((id, i) => [id, i]));
  const ranked = list
    .map((a, idx) => ({ a, idx, pin: pinnedIdx.get(a.id) }))
    .sort((x, y) => {
      if (x.pin != null && y.pin != null) return x.pin - y.pin;
      if (x.pin != null) return -1;
      if (y.pin != null) return 1;
      return x.idx - y.idx;
    })
    .map((x) => x.a);
  return ranked.slice(0, limit).map((a) => toHint(a, input));
}

function toHint(a: AppDescriptor, input: { apiUrlFn: (p: string) => string; categoryText: (id: string) => string }): CommandHint {
  const hint: CommandHint = {
    id: a.id,
    kind: a.kind,
    label: a.label,
    extId: a.extId,
    extName: a.extName,
    category: input.categoryText(a.category),
    icon: a.icon,
    run: a.kind === "toggle"
      ? () => {
          // toggle 卡 buildApps 的 run 是空占位（UI 层接线）——命令候选在此接 extman ops
          const featureId = a.id.slice(`toggle:${a.extId}:`.length);
          void setBooleanFeature(input.apiUrlFn, a.extId, featureId, a.on !== true);
        }
      : a.run,
  };
  if (a.kind === "toggle") hint.on = a.on === true;
  return hint;
}

/* ── 服务壳（粘合：缓存/localStorage/getSlotItems；entry 经 regSvc 注册） ── */

export async function queryCommands(q: string, limit = 5): Promise<CommandHint[]> {
  bindFeatureOverlay();
  const ctx = getCtx() as { getSlotItems?: (slot: string) => Array<Record<string, unknown>> } | null;
  const getSlotItems = ctx?.getSlotItems;
  // 宿主旧版无 getSlotItems 出口 → 静默降级（无 app 候选，消费方判空兜底）
  if (typeof getSlotItems !== "function") return [];
  const exts = await loadExts();
  const pick = (slot: string) =>
    (getSlotItems(slot) as Array<Record<string, unknown>>).map((it) => ({ ...(it as object), slot }));
  return buildCommandHints({
    q,
    limit,
    exts,
    slotItems: [
      ...pick("toolbar"),
      ...pick("commands"),   // 命令目录槽（dialogs 同型目录槽，无渲染点；kind=action）
      ...pick("sidebarFooter"),
      ...pick("rightFileDock"),
    ] as Parameters<typeof buildCommandHints>[0]["slotItems"],
    featureState: currentFeatureState(exts),
    pinned: readPinned(),
    hidden: readHidden(),
    openPanelFn: openPanel,
    apiUrlFn: apiUrl,
    categoryText: (id) => categoryLabel(id, t),
  });
}

/** entry register 时调用：注册客户端服务 + manifest 后台预热。返回 disposer（旧宿主返回 null）。 */
export function registerCommandsService(): (() => void) | null {
  primeCommandsCache();
  return regSvc("aiti-app-center.commands", { query: queryCommands });
}
