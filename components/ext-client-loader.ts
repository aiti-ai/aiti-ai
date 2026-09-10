/**
 * ExtClientLoader — client-modules 机制的浏览器半（DSH 反哺，见
 * docs/dsh-adapter-assessment.md §5.1）。
 *
 * 服务端把扩展 client bundle 组装成启动图（PiWebBootGraph，rev 锚定）；本 loader
 * 按图两阶段加载：
 *  - prefetch(id)：拉取 bundle（ESM import），只保存 register 入口——副作用
 *    （registerItems/registerChatHook 等）都在 register(ctx) 里，调用前不发生。
 *  - materialize(id, ctx)：调用 register(ctx)，memoize（同一 rev 只注册一次）。
 *  - invalidate(id)：丢弃已注册项与 materialized 标记（HMR 钩子）→ 下次
 *    materialize 重新 import + 重新 register。
 *  - reconcileGraph(newGraph)：比 rev 差集 → 只 invalidate 变更扩展（HMR 精确反卷，
 *    替代全量 reset + 重新 import）。
 *
 * 向后兼容：现有扩展 bundle 仍是「export default register(ctx)」（import 即执行
 * 顶层，副作用在 register 内）——本 loader 的 prefetch/materialize 语义与之对齐
 * （顶层执行 = 注册入口就绪，register 调用 = materialize）。
 */
"use client";

import { apiUrl } from "../lib/base-path.ts";
import type { PiWebBootGraph, PiWebBootEntry } from "@/lib/ext/client-modules";

/** 一个扩展 client 模块的加载态。 */
interface ClientModule {
  id: string;
  url: string;
  rev: string;
  /** bundle 导出的 register 入口（import 后取得，materialize 时调用）。
   *  ctx 类型由宿主提供（ExtSlots.makeClientContext）——loader 保持框架无关，
   *  不依赖具体 ctx 形状（避免 tsx 文件被 node 测试解析）。 */
  registerFn: ((ctx: unknown) => unknown) | null;
  /** register(ctx) 的返回 disposer（DI 方案 P2：跨扩展客户端服务反卷用；非函数返回忽略）。
   *  invalidate（rev 变更/扩展移除）时调用——服务下线广播 down，消费方 onExtServiceChange 可感。 */
  disposeFn: (() => void) | null;
  /** 已 materialize（register 已调用）——同一 rev 只注册一次。 */
  materialized: boolean;
}

const modules = new Map<string, ClientModule>();
/** 进行中的 materialize（防并发重复注册：启动循环与按需触发可能同时到达）。 */
const materializing = new Map<string, Promise<boolean>>();
/** 已 warn 过「无 register 导出」的扩展（防重复刷屏）。 */
const warnedNullRegister = new Set<string>();
let bootGraph: PiWebBootGraph = { rev: "", entries: [] };

/**
 * 每个扩展声明的 UI 插槽（来自 manifest ui 定义）——按需加载的依据：
 * ExtSlot 渲染某 slot 时，若有「声明了该 slot 但未 materialize」的扩展，
 * 触发其 materialize（首次用到才拉 bundle + 执行注册副作用）。
 */
const declaredSlots = new Map<string, string[]>();

/** manifest 拉取后登记扩展声明的插槽（ui 定义的 slot 键）。空声明清除旧值（reload 后
 *  扩展不再声明某 slot 时，不能残留上次的声明——否则按需加载会错误触发）。 */
export function registerDeclaredSlots(extId: string, slots: string[]): void {
  if (slots.length > 0) declaredSlots.set(extId, slots);
  else declaredSlots.delete(extId);
}

/** 图行是否为「立即加载」项（immediately:false = 懒加载，留给按需触发）。 */
export function isImmediateEntry(entry: PiWebBootEntry): boolean {
  return entry.immediately !== false;
}

/** 启动批量的目标行：只取立即项——懒加载扩展既不预取也不 materialize。 */
export function immediateEntries(graph: PiWebBootGraph): PiWebBootEntry[] {
  return graph.entries.filter(isImmediateEntry);
}

/** 清除不在 activeIds 里的 slot 声明（manifest 重拉后调用——已卸载/禁用的扩展
 *  不再出现在 manifest，其旧声明残留会让 pendingForSlot 每次渲染都徒劳触发）。 */
export function pruneDeclaredSlots(activeIds: Iterable<string>): void {
  const active = new Set(activeIds);
  for (const id of [...declaredSlots.keys()]) {
    if (!active.has(id)) declaredSlots.delete(id);
  }
}

export function getBootGraph(): PiWebBootGraph {
  return bootGraph;
}

/** manifest 拉取后写入最新图（首次加载 / reload 后刷新）。 */
export function setBootGraph(graph: PiWebBootGraph): void {
  bootGraph = graph;
}

/** 图里某扩展的 entry；未知 id 返回 undefined。 */
export function entryOf(id: string): PiWebBootEntry | undefined {
  return bootGraph.entries.find((e) => e.id === id);
}

/** 阶段一：拉取 bundle 并取得 register 入口（不调用，无副作用）。 */
export async function prefetch(id: string): Promise<void> {
  const entry = entryOf(id);
  if (!entry) return;
  const existing = modules.get(id);
  if (existing && existing.url === entry.url) return; // 同 rev 已在表
  try {
    // webpackIgnore: keep the native dynamic import (Next would otherwise
    // rewrite it into a bundled context stub). apiUrl 补 basePath（graph 的
    // assetUrl 是裸 /api/...，部署在子路径下必须带 /dev 前缀）。
    const importBundle = (bust?: number) =>
      import(/* webpackIgnore: true */ bust
        ? `${apiUrl(entry.url)}${entry.url.includes("?") ? "&" : "?"}bust=${bust}`
        : apiUrl(entry.url));
    let mod: unknown;
    try {
      mod = await importBundle();
    } catch (firstErr) {
      // 模块负缓存兜底：HTML module map 按 URL 记账，同文档内 import 失败后
      // 重试同一 URL 必失败、且不再发请求——网络瞬断（dev 重编译/deploy reload
      // 窗口）撞上时会表现为「按钮点了没反应」。bundle 是内容寻址（rev 锚定），
      // 加一次性参数语义不变，重试一次即可穿透负缓存。
      mod = await importBundle(Date.now());
      console.warn(
        `[ext] ${id}: bundle import 重试成功（首次失败：${String((firstErr as Error)?.message ?? firstErr).slice(0, 120)}）`,
      );
    }
    const ns = mod as { default?: unknown; register?: (ctx: unknown) => void };
    const registerFn =
      typeof ns.default === "function"
        ? (ns.default as (ctx: unknown) => void)
        : typeof ns.register === "function"
          ? ns.register
          : null;
    modules.set(id, { id, url: entry.url, rev: entry.rev, registerFn, disposeFn: null, materialized: false });
  } catch (e) {
    console.error(`[ext] failed to fetch client bundle for ${id}:`, e);
    modules.delete(id);
  }
}

/**
 * 阶段二：调用 register(ctx)（副作用发生）。memoize：同 rev 已 materialize 则 no-op。
 * @returns true 当本次真正执行了注册（用于调用方决定是否需要反卷）。
 */
export async function materialize(id: string, makeCtx: (id: string) => unknown): Promise<boolean> {
  // 互斥必须在函数入口同步建立（prefetch 的 await 之前）——并发调用
  // （StrictMode 双 effect / 启动批量 + slot 按需触发）若都经过 await prefetch
  // 再检查 in-flight，会交错到各自执行 register → 重复注册。
  const inFlight = materializing.get(id);
  if (inFlight) return inFlight;
  const run = (async () => {
    let mod = modules.get(id);
    if (!mod) {
      await prefetch(id);
      mod = modules.get(id);
    }
    if (!mod) return false;
    if (mod.materialized) return false;
    if (!mod.registerFn) {
      // bundle 契约违反（无 default/register 导出）——warn 一次，不标
      // materialized（按需触发会重试，但不再刷屏）。
      if (!warnedNullRegister.has(id)) {
        warnedNullRegister.add(id);
        console.warn(`[ext] ${id}: client bundle exports no register function (expected export default register(ctx))`);
      }
      return false;
    }
    try {
      const ret: unknown = mod.registerFn(makeCtx(id));
      // DI 方案 P2：捕获 register 返回的 disposer（invalidate 时反卷客户端服务注册）
      mod.disposeFn = typeof ret === "function" ? (ret as () => void) : null;
      mod.materialized = true;
      return true;
    } catch (e) {
      console.error(`[ext] failed to materialize ${id}:`, e);
      return false;
    }
  })();
  materializing.set(id, run);
  try {
    return await run;
  } finally {
    materializing.delete(id);
  }
}

/** 已 materialize 的扩展 id 集合（扩展管理界面展示加载状态用）。 */
export function materializedIds(): string[] {
  return [...modules.values()].filter((m) => m.materialized).map((m) => m.id);
}

/** 已 prefetch（bundle 已拉取，未 materialize）的扩展 id 集合。 */
export function prefetchedIds(): string[] {
  return [...modules.values()].filter((m) => !m.materialized).map((m) => m.id);
}

/**
 * 某 slot 尚未 materialize 的声明扩展（按需加载队列）。
 * immediately 标记（图行）只影响「启动阶段一是否预取」；无论是否预取，
 * 声明了该 slot 的扩展在此返回，由 ExtSlot 渲染时触发 materialize。
 */
export function pendingForSlot(slot: string): string[] {
  return [...declaredSlots.entries()]
    .filter(([, slots]) => slots.includes(slot))
    .map(([id]) => id)
    .filter((id) => {
      const m = modules.get(id);
      return !m || !m.materialized; // 未拉取或已拉取未注册
    });
}

/** 某插槽是否有扩展声明（manifest ui 快照；registerDeclaredSlots 登记后生效）。
 *  「缺席即原生兜底」裁决用：无人声明 = 一次快照定案，与物化时序/成败无关。 */
export function slotDeclared(slot: string): boolean {
  for (const slots of declaredSlots.values()) if (slots.includes(slot)) return true;
  return false;
}

/**
 * [懒加载 v2] 常挂插槽自动触发用：从 pendingForSlot 排除全部懒扩展（immediately:false）。
 * 常挂插槽（toolbar/sidebar/…20+）首屏即渲染——若不排除懒扩展，「标懒」照样启动即物化。
 * 懒扩展在常挂插槽上的入口由 manifest 静态条目承担（点击经 ensureMaterialized 拉起）。
 */
export function pendingForSlotAuto(slot: string): string[] {
  return pendingForSlot(slot).filter((id) => entryOf(id)?.immediately !== false);
}

/**
 * [懒加载 v2] 交互时挂载插槽清单：这些插槽的 useExtSlotItems 物化 effect 保持
 * 「首渲染即拉起全部声明扩展（含懒扩展）」语义——插槽挂载本身就是用户可感知的
 * 交互时刻（打开设置/打开文件/打开终端…）。清单外（常挂）插槽一律走 pendingForSlotAuto。
 * 宿主维护；新增交互时挂载插槽时同步登记（见 docs/aiti-ext-lazy-loading-plan.md §1.2 全景表）。
 */
export const INTERACTIVE_SLOTS: ReadonlySet<string> = new Set([
  "sessionStats",
  "fileViewer",
  "pathPicker",
  "terminalDock",
  "settingsModels",
  "settingsAgents",
  "settingsAgentsFeature",
  "rightFileDock",
]);

/**
 * [懒加载 v2] 幂等物化：确保某扩展 client 已 register(ctx)（并发安全——复用
 * materialize 的 materializing Map 互斥）。
 * @returns true 当本次调用真正执行了注册；已 materialize / 无 bundle 返回 false。
 */
export async function ensureMaterialized(id: string, makeCtx: (id: string) => unknown): Promise<boolean> {
  const mod = modules.get(id);
  if (mod?.materialized) return false;
  return materialize(id, makeCtx);
}

/**
 * [懒加载 v2] 物化声明了 slot 的全部懒扩展（交互时挂载插槽 / 接管直读点跳板用）。
 * 幂等：全部已 materialize 时空转返回。
 */
export async function ensureSlotMaterialized(slot: string, makeCtx: (id: string) => unknown): Promise<void> {
  const pending = pendingForSlot(slot);
  for (const id of pending) {
    await ensureMaterialized(id, makeCtx);
  }
}

/**
 * HMR 钩子：丢弃某扩展的已注册项与 materialized 标记（rev 已变）。
 * @param removeItems 宿主提供的「按扩展清除 UI 项」回调（ext-ui-store.removeExtUiItems）。
 * @returns 该扩展下次 materialize 会重新 import + 重新注册。
 */
export function invalidate(id: string, removeItems?: (extId: string) => void): void {
  // DI 方案 P2：反卷 register 返回的 disposer（跨扩展客户端服务注销 → down 广播）
  const mod = modules.get(id);
  try { mod?.disposeFn?.(); } catch (e) { console.warn(`[ext] ${id}: client dispose failed:`, e); }
  removeItems?.(id);
  modules.delete(id);
}

/**
 * 按新图反卷：rev 差集 → 只 invalidate 变更/消失的扩展；新增的扩展自动进入
 * 下一轮 prefetch/materialize。返回被反卷的扩展 id 列表。
 */
export function reconcileGraph(
  newGraph: PiWebBootGraph,
  removeItems?: (extId: string) => void,
): string[] {
  const oldById = new Map(bootGraph.entries.map((e) => [e.id, e]));
  const newById = new Map(newGraph.entries.map((e) => [e.id, e]));
  const invalidated: string[] = [];
  for (const [id, oldEntry] of oldById) {
    const newEntry = newById.get(id);
    if (!newEntry) {
      // 扩展被移除 → 反卷
      invalidate(id, removeItems);
      invalidated.push(id);
    } else if (newEntry.rev !== oldEntry.rev) {
      // bundle 内容变化 → 反卷后重载
      invalidate(id, removeItems);
      invalidated.push(id);
    }
  }
  bootGraph = newGraph;
  return invalidated;
}
