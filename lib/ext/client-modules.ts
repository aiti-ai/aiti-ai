/**
 * client-modules — bundle 分发契约（DSH 机制反哺，见 docs/dsh-adapter-assessment.md §5.1）。
 *
 * 服务端把扩展 client bundle 组装成一张「启动图」（wire single source）：
 *  - 每行 = 一个扩展的 client bundle（内容哈希 rev + 带 rev 的 URL）
 *  - 图 rev = 全图一致性锚：任一行变化 → 图 rev 变化（前端比图 rev 做 HMR 精确反卷）
 *  - inject 边：扩展可声明依赖其他扩展（并行预取/加载顺序提示，informational）
 *
 * 前端按图两阶段加载（prefetch 注册 factory → materialize 惰性执行副作用），
 * reload 按 rev 差集只 invalidate 变更项——替代全量 reset + 重新 import。
 *
 * 与 manifest 的关系：manifest 承载「UI 元数据 + clientUrl」，graph 承载「加载
 * 图（rev + 依赖边 + prefetch 标记）」。两者同一扫描源，但 graph 才是前端
 * loader 的输入；manifest 的 clientUrl 保留兼容旧加载路径。
 */

/** 图的一行：一个扩展的 client bundle。 */
export interface PiWebBootEntry {
  /** 扩展 id（== entry 名）。 */
  id: string;
  /** Bundle endpoint，如 /api/extensions/<id>/assets/<client>?rev=<rev>。 */
  url: string;
  /** Bundle 内容哈希（缓存失效一致性锚；riding the URL 作 cache-busting）。 */
  rev: string;
  /** 依赖边：本 bundle 依赖的其他扩展 id（并行预取提示，informational）。 */
  inject?: string[];
  /** 阶段一 prefetch 标记：启动即拉取注册 factory；未标记的在首次 materialize 时拉取。 */
  immediately?: boolean;
  /** 前端 materialize 优先级（统一 SSE 端口方案 §3-B）：越大越先——启动批量先单独
   *  materialize 最高 priority 项（aiti-event-bus → window.__piEventBus 先挂槽），
   *  其余立即项并行。缺省 = 0，与后端 startupPriority 同源透传。 */
  priority?: number;
}

/** 单个图行的输入（buildBootGraph 参数行）。 */
export interface PiWebBootGraphInput {
  id: string;
  /** 相对 client bundle 的 asset 路径（不含 hash query），如 /api/extensions/demo/assets/client/demo.mjs */
  assetUrl: string;
  /** bundle 内容哈希（12 位 hex） */
  hash: string;
  inject?: string[];
  immediately?: boolean;
  /** 与 PiWebBootEntry.priority 同名透传（扩展 startupPriority）。 */
  priority?: number;
  /** 不参与 eager 批量包（入口使用 import.meta 等对加载路径敏感的场景）。 */
  bundleExcluded?: boolean;
}

/** 注入前端的完整启动图。 */
export interface PiWebBootGraph {
  /** 全图一致性锚：hash(组合后的 entries)。任一行变化 → 图 rev 变化。 */
  rev: string;
  /** 组合后的 entries；顺序不承载语义（激活序由前端按需 materialize）。 */
  entries: PiWebBootEntry[];
  /** eager 扩展批量包（无 eager 行时缺省）。 */
  bundle?: PiWebClientBundle;
}

/** 空图（无任何 client 扩展时前端 loader 的初始值）。 */
export const EMPTY_BOOT_GRAPH: PiWebBootGraph = { rev: "", entries: [] };

/**
 * 组合启动图（纯函数）。hashFn 返回 bundle 内容哈希（与 manifest clientUrl
 * 的 ?v= 同源，保证图 rev 与 clientUrl 缓存失效一致）。
 *
 * @param entries 扫描出的 (id, clientUrl, hash, inject, immediately) 行
 * @returns 组合后的图；无 bundle 时返回 EMPTY_BOOT_GRAPH
 */
export function buildBootGraph(entries: PiWebBootGraphInput[]): PiWebBootGraph {
  const valid = entries.filter((e) => e.hash); // 无 client 或不可读的扩展不进图
  const rows: PiWebBootEntry[] = valid.map((e) => ({
    id: e.id,
    url: `${e.assetUrl}?rev=${e.hash}`,
    rev: e.hash,
    ...(e.inject?.length ? { inject: e.inject } : {}),
    ...(e.immediately === false ? { immediately: false } : {}),
    ...(typeof e.priority === "number" && e.priority !== 0 ? { priority: e.priority } : {}),
  }));
  if (rows.length === 0) return EMPTY_BOOT_GRAPH;
  // eager 批量包：immediately !== false 且未排除的行（顺序 = priority 降序 + 图序，
  // 与前端 immediateEntriesByPriority 一致；包内模块顶层执行顺序因此稳定）。
  const bundleRows = valid
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.immediately !== false && !e.bundleExcluded)
    .sort((a, b) => (b.e.priority ?? 0) - (a.e.priority ?? 0) || a.i - b.i)
    .map(({ e }) => ({ id: e.id, rev: e.hash }));
  const bundle: PiWebClientBundle | undefined = bundleRows.length
    ? (() => {
        const rev = clientBundleRev(bundleRows);
        return { url: clientBundleUrl(rev), rev, ids: bundleRows.map((r) => r.id) };
      })()
    : undefined;
  // priority 纳入图 hash：优先级变化（如基础设施扩展调整）也要触发图 rev 变化 → 前端对账
  const graphRev = hashText(JSON.stringify({
    rows: rows.map((r) => ({ id: r.id, rev: r.rev, inject: r.inject, priority: r.priority ?? 0 })),
    bundle: bundle?.rev ?? "",
  }));
  return { rev: graphRev, entries: rows, ...(bundle ? { bundle } : {}) };
}

/** 内容哈希（与 registry.clientHash 一致的 sha256 前 12 位）。 */
import { createHash } from "node:crypto";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * eager 批量包（client-bundle）——请求数治理：
 * 首屏必然加载的扩展不必逐扩展发请求；registry.computeBundle() 把 eager 行
 * （immediately !== false 且未标注 bundleExcluded）合成一条 bundle 行，前端
 * loader 一次 import 后按图 materialize。包的构建/服务端逻辑在 client-bundle.ts
 * （本文件保持纯函数、零 fs/esbuild 依赖，可被客户端安全引用）。
 * ------------------------------------------------------------------ */

/** 批量包 URL 路径（客户端 apiUrl() 会补 basePath）。 */
export const CLIENT_BUNDLE_PATH = "/api/extensions/client-bundle";

/** 批量打包版本（算法/包装形状变化时 bump，强制所有客户端重新拉包）。
 *  v4：拆包扩展（usesLazyChunks）静态相对 import 外置——共享 chunk 文件单实例。 */
export const CLIENT_BUNDLE_VERSION = 4;

/** 批量包描述（挂在 boot graph 上；entries 的 rev/url 仍保留单扩展语义）。 */
export interface PiWebClientBundle {
  url: string;
  rev: string;
  /** 打进包的扩展 id（前端 prefetch 只对这些 id 走包加载；缺项自动回退单扩展 URL）。 */
  ids: string[];
}

export function clientBundleUrl(rev: string): string {
  return `${CLIENT_BUNDLE_PATH}?rev=${rev}`;
}

/** 批量包内容寻址 rev（参与扩展集合 + 版本号）。 */
export function clientBundleRev(entries: Array<{ id: string; rev: string }>): string {
  return hashText(JSON.stringify({
    v: CLIENT_BUNDLE_VERSION,
    rows: entries.map((e) => [e.id, e.rev]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  }));
}
