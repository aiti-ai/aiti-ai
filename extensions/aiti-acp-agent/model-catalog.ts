/**
 * aiti-acp-agent — 模型目录（D15）：免会话获取 + 磁盘缓存 + 启动后台刷新。
 *
 * ACP 协议无 list-models（模型只在 session/new|load 响应里）；本模块分层：
 *   1. CLI 目录（零会话副作用）：cbc `--help`（共享解析器）/ opencode `models`；
 *   2. ACP 预启动探测（兜底）：spawn → initialize → session/new（临时 cwd）→ 取目录
 *      （实现在 index.ts，注入 AcpHandle 避免模块环）；
 *   3. 运行期回填：任何 session/new|load 的 availableModels 写缓存（source:"session"
 *      优先级最高）。
 * 缓存：ctx.cacheDir/model-catalog.json，TTL 24h；session 源覆盖 cli/acp；cli 条目
 * 随版本变化失效。探测单飞（per-agent in-flight 锁）+ 全局并发上限 2。
 *
 * 方案：docs/aiti-acp-model-catalog-startup-plan.md。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CatalogSource = "cli" | "acp" | "session";

export interface CatalogEntry {
  models: Array<{ id: string; label?: string }>;
  currentModelId?: string;
  source: CatalogSource;
  cliVersion?: string;
  fetchedAt: number;
}

interface CatalogFile {
  v: 1;
  agents: Record<string, CatalogEntry>;
}

export const CATALOG_TTL_MS = 24 * 3600 * 1000;

// ============================================================================
// 磁盘缓存（fail-soft：坏 JSON / 不可写一律当缺失）
// ============================================================================

export class ModelCatalogStore {
  private readonly file: string;
  private data: CatalogFile = { v: 1, agents: {} };
  private loaded = false;

  constructor(cacheDir: string) {
    this.file = join(cacheDir, "model-catalog.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as CatalogFile;
      if (j && j.v === 1 && j.agents && typeof j.agents === "object") this.data = j;
    } catch { /* 缺失/坏 JSON → 空 */ }
  }

  get(agent: string): CatalogEntry | null {
    this.load();
    return this.data.agents[agent] ?? null;
  }

  /** TTL 新鲜判定；cli 条目附带版本比较（版本漂移 = 失效，触发重探测）。 */
  isFresh(agent: string, opts: { now?: number; cliVersion?: string | null } = {}): boolean {
    const entry = this.get(agent);
    if (!entry || !Array.isArray(entry.models) || !entry.models.length) return false;
    if ((opts.now ?? Date.now()) - entry.fetchedAt > CATALOG_TTL_MS) return false;
    if (entry.source === "cli" && opts.cliVersion && entry.cliVersion !== opts.cliVersion) return false;
    return true;
  }

  /** 写入（合并规则：session 恒覆盖；cli/acp 不覆盖 session 既有条目）。 */
  put(agent: string, entry: CatalogEntry): void {
    this.load();
    const prev = this.data.agents[agent];
    if (entry.source !== "session" && prev?.source === "session" && this.isFresh(agent)) {
      return; // 会话实测最准，探测结果不回退它
    }
    this.data.agents[agent] = entry;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch { /* 不可写 → 内存态照常服务本次进程 */ }
  }

  /** 仅供单测。 */
  snapshot(): Record<string, CatalogEntry> {
    this.load();
    return { ...this.data.agents };
  }
}

// ============================================================================
// opencode `models` 输出解析（`provider/model` 逐行；非条目行忽略）
// ============================================================================

export function parseOpenCodeModels(text: string): Array<{ id: string; label?: string }> {
  const out: Array<{ id: string; label?: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/.exec(line);
    if (m) out.push({ id: line, label: `${m[1]} / ${m[2]}` });
  }
  return out;
}

// ============================================================================
// 刷新编排（单飞 + 并发上限；探测实现由 index.ts 注入）
// ============================================================================

export interface AgentProbeDesc {
  /** agent 名（与 provider type 一致） */
  name: string;
  /** CLI 目录探测（cbc --help / opencode models）；null = 无 CLI 源，走 ACP 预启动 */
  probeCli?: () => Promise<CatalogEntry | null>;
  /** ACP 预启动探测（spawn + initialize + session/new） */
  probeAcp?: () => Promise<CatalogEntry | null>;
  /** 当前 CLI 版本（cli 条目失效判据；可省） */
  cliVersion?: () => Promise<string | null>;
}

export interface CatalogRefresher {
  /** 启动全量刷新（后台）：跳过新鲜条目；失败静默。返回是否全部完成。 */
  refreshAll(): Promise<void>;
  /** 单 agent 刷新（TTL 内跳过）。 */
  refresh(agent: string): Promise<CatalogEntry | null>;
  /** 强制刷新（跳过 TTL；手动「刷新模型列表」入口；与启动/惰性探测共用单飞）。 */
  refreshForce(agent: string): Promise<CatalogEntry | null>;
  /** 该 agent 是否有 in-flight 探测。 */
  inFlight(agent: string): boolean;
}

const MAX_CONCURRENCY = 2;

export function createCatalogRefresher(store: ModelCatalogStore, agents: () => AgentProbeDesc[]): CatalogRefresher {
  const flight = new Map<string, Promise<CatalogEntry | null>>();

  async function runOne(desc: AgentProbeDesc): Promise<CatalogEntry | null> {
    try {
      if (desc.probeCli) {
        const entry = await desc.probeCli();
        if (entry && entry.models.length) return entry;
      }
      if (desc.probeAcp) {
        const entry = await desc.probeAcp();
        if (entry && entry.models.length) return entry;
      }
    } catch (e) {
      console.warn(`[acp-catalog] probe(${desc.name}) failed:`, e instanceof Error ? e.message : e);
    }
    return null;
  }

  function refresh(name: string, opts: { force?: boolean } = {}): Promise<CatalogEntry | null> {
    const existing = flight.get(name);
    if (existing) return existing;
    const desc = agents().find((a) => a.name === name);
    if (!desc) return Promise.resolve(null);
    if (!opts.force && store.isFresh(name, { cliVersion: undefined })) return Promise.resolve(store.get(name));
    const p = (async () => {
      try {
        // 版本判据仅在能取到时参与（isFresh 内部已处理 cli 源比较）
        const entry = await runOne(desc);
        if (entry) {
          store.put(name, entry);
          return store.get(name);
        }
        return store.get(name);
      } finally {
        flight.delete(name);
      }
    })();
    flight.set(name, p);
    return p;
  }

  async function refreshAll(): Promise<void> {
    const list = agents();
    // 顺序：先 CLI 源（快），后 ACP 预启动（慢）——方案 §3.3
    const ordered = [...list.filter((a) => a.probeCli), ...list.filter((a) => !a.probeCli)];
    let idx = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, ordered.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= ordered.length) return;
        const desc = ordered[i];
        // 新鲜（含 cli 版本判据）跳过
        let cliVersion: string | null = null;
        try { cliVersion = desc.cliVersion ? await desc.cliVersion() : null; } catch { /* 忽略 */ }
        if (store.isFresh(desc.name, { cliVersion })) continue;
        await refresh(desc.name);
      }
    });
    await Promise.all(workers);
  }

  return {
    refreshAll,
    refresh: (name) => refresh(name),
    refreshForce: (name) => refresh(name, { force: true }),
    inFlight: (name) => flight.has(name),
  };
}
