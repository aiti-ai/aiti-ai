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
  registerFn: ((ctx: unknown) => void) | null;
  /** 已 materialize（register 已调用）——同一 rev 只注册一次。 */
  materialized: boolean;
}

const modules = new Map<string, ClientModule>();
/** 进行中的 materialize（防并发重复注册：启动循环与按需触发可能同时到达）。 */
const materializing = new Map<string, Promise<boolean>>();
let bootGraph: PiWebBootGraph = { rev: "", entries: [] };

/**
 * 每个扩展声明的 UI 插槽（来自 manifest ui 定义）——按需加载的依据：
 * ExtSlot 渲染某 slot 时，若有「声明了该 slot 但未 materialize」的扩展，
 * 触发其 materialize（首次用到才拉 bundle + 执行注册副作用）。
 */
const declaredSlots = new Map<string, string[]>();

/** manifest 拉取后登记扩展声明的插槽（ui 定义的 slot 键）。 */
export function registerDeclaredSlots(extId: string, slots: string[]): void {
  if (slots.length > 0) declaredSlots.set(extId, slots);
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
    const mod = (await import(/* webpackIgnore: true */ apiUrl(entry.url))) as unknown;
    const ns = mod as { default?: unknown; register?: (ctx: unknown) => void };
    const registerFn =
      typeof ns.default === "function"
        ? (ns.default as (ctx: unknown) => void)
        : typeof ns.register === "function"
          ? ns.register
          : null;
    modules.set(id, { id, url: entry.url, rev: entry.rev, registerFn, materialized: false });
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
  let mod = modules.get(id);
  if (!mod) {
    await prefetch(id);
    mod = modules.get(id);
  }
  if (!mod) return false;
  if (mod.materialized) return false;
  // 互斥：并发调用共享一个 in-flight（启动批量 materialize 与 slot 按需触发
  // 可能同时到达——避免同一 register 执行两次导致重复注册）。
  const inFlight = materializing.get(id);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      mod.registerFn?.(makeCtx(id));
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

/**
 * HMR 钩子：丢弃某扩展的已注册项与 materialized 标记（rev 已变）。
 * @param removeItems 宿主提供的「按扩展清除 UI 项」回调（ext-ui-store.removeExtUiItems）。
 * @returns 该扩展下次 materialize 会重新 import + 重新注册。
 */
export function invalidate(id: string, removeItems?: (extId: string) => void): void {
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
