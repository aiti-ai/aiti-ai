/**
 * session-manager — server runtime singleton (index + settings + archive).
 * One per data dir, cached; holds the SQLite connection for the process.
 */
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXT_ARCHIVE_REF, type SessionIndex } from "../lib/session-index.ts";
import { createIndexFacade } from "../lib/session-index-async.ts";
import {
  collectCandidates, writeArchive, writeArchiveFromBytes, deleteOriginals, packageNameFor,
  extractToCache, clearCache, cacheBytes, readArchiveManifest, removeFromArchive,
  restoreFromArchive, archivePackagesDir, findEntry, extractFromArchive, type ArchiveCandidate,
} from "../lib/session-archive.ts";
import { createHash } from "node:crypto";
import { extId, type AgentAdapter } from "../lib/agents/types.ts";

export interface Settings {
  archiveAgeDays: number;
  maxLiveSizeMb: number;
  autoArchive: boolean;
  autoArchiveIntervalH: number;
  /** M1: external source lifecycle state (agent → active/watermark/lastSyncAt). */
  extSources?: Record<string, { active: boolean; watermarkMs?: number; lastSyncAt?: string }>;
  /** M2 audit: completed imports (composite ext id → pi session) for idempotency. */
  extImports?: Record<string, { sessionId: string; path: string }>;
}

const DEFAULTS: Settings = {
  archiveAgeDays: 90,
  maxLiveSizeMb: 20,
  autoArchive: true,
  autoArchiveIntervalH: 6,
};

export interface ExtCoreLike {
  listSessions(options?: { refresh?: boolean }): Promise<Array<{ id: string; path: string; cwd: string; modified: string; name?: string; messageCount?: number; firstMessage?: string }>>;
  getRunningSessionIds(): Promise<string[]>;
  /** Attached (alive, possibly idle) rpc sessions — optional for old cores; guards fall back to running-only. */
  getAliveSessionIds?(): Promise<string[]>;
  /** 主动释放一个 alive-but-idle 的 rpc 会话（可选——旧核心无此能力时保持原守卫）。
   *  running 会话不碰（返回 "running"）；非本进程持有返回 "missing"。 */
  stopAliveSession?(id: string): Promise<"stopped" | "running" | "not-alive" | "missing" | "still-alive">;
}

/** Running ∪ alive: idle-but-open sessions still own their JSONL (next turn recreates it after a move). */
export async function guardedSessionIds(core: ExtCoreLike): Promise<Set<string>> {
  const guarded = new Set(await core.getRunningSessionIds());
  try {
    for (const id of (await core.getAliveSessionIds?.()) ?? []) guarded.add(id);
  } catch { /* old core without the API → running-only guard */ }
  return guarded;
}

/**
 * 显式目标（归档/移动）操作前：释放 alive-but-idle 的 rpc handle（对话已结束、
 * 仅 handle 挂载），随后磁盘操作才安全。running 会话不碰（stopAliveSession 返回
 * "running" 自然跳过）；旧核心无 stopAliveSession 时原守卫不变。
 * 返回释放后的守卫集（running ∪ alive）。
 */
export async function releaseIdleFor(ids: string[], core: ExtCoreLike): Promise<Set<string>> {
  const running = new Set(await core.getRunningSessionIds());
  const alive = await guardedSessionIds(core);
  if (!core.stopAliveSession) return alive;
  for (const id of ids) {
    if (!running.has(id) && alive.has(id)) {
      try { await core.stopAliveSession(id); } catch { /* 释放失败：保持守卫 */ }
    }
  }
  // shutdown 异步完成后 wrapper 已退出 registry → 重取守卫集（释放成功的自然消失）
  return guardedSessionIds(core);
}

interface Runtime {
  index: SessionIndex;
  settings: Settings;
}

const runtimes = new Map<string, Runtime>();

export function runtime(configDir: string, opts?: { extDir?: string }): Runtime {
  let r = runtimes.get(configDir);
  if (!r) {
    mkdirSync(join(dirname(configDir), "cache"), { recursive: true }); // 索引等可再生数据的父目录（SQLite 需目录已存在；configDir=<extRoot>/config）
    mkdirSync(archivePackagesDir(configDir), { recursive: true }); // 归档包目录（state 层）
    r = {
      // 异步门面（2026-09-12）：sync/syncExt 重活派发索引 worker（dist/index-worker.mjs，
      // vite 双入口产出），读/小写留主线程；bundle 缺失（未构建/测试环境）自动回落本地实现。
      index: createIndexFacade(join(dirname(configDir), "cache", "index.sqlite"), {
        workerPath: opts?.extDir ? join(opts.extDir, "dist", "index-worker.mjs") : undefined,
      }),
      settings: loadSettings(configDir),
    };
    runtimes.set(configDir, r);
  }
  return r;
}

export function settingsPath(configDir: string): string {
  return join(configDir, "settings.json");
}

export function loadSettings(configDir: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(configDir), "utf8")) as Partial<Settings>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(configDir: string, s: Settings): void {
  const p = settingsPath(configDir);
  writeFileSync(`${p}.tmp`, JSON.stringify(s, null, 2));
  writeFileSync(p, JSON.stringify(s, null, 2));
}

/** Incremental index sync against core's live session list.
 *  opts.refresh = 强制重扫磁盘（绕过 core 的 5s 缓存）——归档前调用，确保刚落盘/
 *  新出现的会话一定入索引（否则 markArchived 0 行 → 归档后无记录不可恢复）。 */
export async function syncIndex(configDir: string, core: ExtCoreLike, opts: { refresh?: boolean } = {}): Promise<{ indexed: number }> {
  const sessions = await core.listSessions(opts.refresh ? { refresh: true } : {});
  const r = runtime(configDir);
  const result = await r.index.sync(sessions.map((s) => ({ path: s.path, id: s.id, cwd: s.cwd })));
  return { indexed: result.indexed };
}

/** Run one archive pass; returns what happened. skippedIds = requested ids held back by the open-session guard (running ∪ alive). */
export async function runArchive(
  configDir: string,
  core: ExtCoreLike,
  overrides?: Partial<Pick<Settings, "archiveAgeDays" | "maxLiveSizeMb">>,
  ids?: string[],
): Promise<{ archived: number; deleted: number; packageName: string | null; sizeBytes: number; candidates: number; skippedIds?: string[] }> {
  // Sync the index first: sessions created since the last sync must be indexed
  // before archiving, or they'd vanish from the merged list (not live, not archived).
  // refresh = 强制重扫磁盘（绕过 5s 缓存）：落盘但未被缓存的会话必须入索引，
  // 否则 markArchived 0 行 → 文件进包但无记录、restore 无门。
  await syncIndex(configDir, core, { refresh: true });
  const r = runtime(configDir);
  const settings = overrides ? { ...r.settings, ...overrides } : r.settings;
  const sessions = await core.listSessions();
  const running = new Set(await core.getRunningSessionIds());
  let alive = new Set(running);
  try {
    for (const id of (await core.getAliveSessionIds?.()) ?? []) alive.add(id);
  } catch { /* old core without the API → running-only guard */ }
  // 用户显式归档（ids 分支）：对话已结束、仅 handle 挂载（alive 且非 running）的会话
  // 先释放 handle 再归档——不让用户先手动关页面。真运行中的不碰（留在守卫 → skipped）；
  // 自动归档（无 ids）保持原守卫不动。
  if (ids && ids.length && core.stopAliveSession) {
    for (const id of ids) {
      if (!running.has(id) && alive.has(id)) {
        try { await core.stopAliveSession(id); } catch { /* 释放失败：保持守卫 */ }
      }
    }
    // shutdown 异步完成后 wrapper 已退出 registry → 重取守卫集（释放成功的自然消失）
    alive = new Set(await core.getRunningSessionIds());
    try {
      for (const id of (await core.getAliveSessionIds?.()) ?? []) alive.add(id);
    } catch { /* old core */ }
  }
  let candidates: ArchiveCandidate[] = collectCandidates(
    sessions.map((s) => ({ id: s.id, cwd: s.cwd, modified: s.modified, path: s.path })),
    alive,
    { ageDays: settings.archiveAgeDays, maxLiveSizeMb: settings.maxLiveSizeMb },
  );
  // §14.4 batch archive: explicit session ids win over age/size heuristics.
  // Running sessions are NEVER archived (they'd be deleted mid-run) — filtered both here and client-side.
  let skippedIds: string[] | undefined;
  if (ids && ids.length) {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    skippedIds = ids.filter((id) => {
      const s = byId.get(id);
      return !s || alive.has(id);
    });
    candidates = ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x)
      .filter((s) => !alive.has(s.id))
      .map((s) => ({ sessionId: s.id, cwd: s.cwd, modified: s.modified, path: s.path, sizeBytes: 0, ageDays: 0 }));
    // 归档完整性：index 无行（未索引/解析失败的会话）无法安全归档——markArchived 0 行会
    // 静默留下「文件入 .pwarc 但无记录、restore 无门」的孤儿。显式剔除并计入 skippedIds。
    const unindexed = candidates.filter((c) => !r.index.getSession(c.sessionId));
    if (unindexed.length) {
      skippedIds = [...skippedIds, ...unindexed.map((c) => c.sessionId)];
      candidates = candidates.filter((c) => !unindexed.includes(c));
    }
    if (candidates.length === 0) return { archived: 0, deleted: 0, packageName: null, sizeBytes: 0, candidates: 0, skippedIds };
  }
  if (candidates.length === 0) return { archived: 0, deleted: 0, packageName: null, sizeBytes: 0, candidates: 0 };

  // §5.5.2 rolling buckets: ≤ MAX_PKG_SESSIONS sessions or ≤ MAX_PKG_BYTES (uncompressed) per package.
  const MAX_PKG_SESSIONS = 200;
  const MAX_PKG_BYTES = 50 * 1024 * 1024;
  const batches: ArchiveCandidate[][] = [];
  let cur: ArchiveCandidate[] = [];
  let curBytes = 0;
  for (const c of candidates) {
    if (cur.length >= MAX_PKG_SESSIONS || (curBytes + c.sizeBytes) > MAX_PKG_BYTES) {
      if (cur.length) batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(c);
    curBytes += c.sizeBytes;
  }
  if (cur.length) batches.push(cur);

  let archived = 0;
  let deleted = 0;
  let lastPkg: string | null = null;
  let lastPkgBytes = 0;
  for (const batch of batches) {
    const pkg = packageNameFor(batch);
    // 包必须落在 archivePackagesDir（= state/archive；读取侧 findEntry/extractToCache/removeFromArchive
    // 的同一来源函数——「写 == 读同源」）。曾漏迁为根级 archive/：写入侧自建目录照常成功，读取侧
    // 永远 MISS → 恢复/查看/删除全部静默失败（客户端 res.ok=false 无提示）。writeArchive 内的
    // mkdirSync 会掩盖目录不存在，任何改路径的验证都必须以「写入位置 == 读取位置」为准
    // （api.test.mjs 已钉住）。归档不可再生 → 落 state 层（不可整体删除），与 cache/ 的可再生数据物理分离。
    const pkgPath = join(archivePackagesDir(configDir), pkg);
    const { entries } = writeArchive(pkgPath, batch);
    // §10 guarantee: never delete originals unless the package is verifiably readable.
    if (!readArchiveManifest(pkgPath)) {
      try { unlinkSync(pkgPath); } catch { /* best-effort */ }
      throw new Error(`archive package unreadable: ${pkg}`);
    }
    const { changed } = r.index.markArchived(pkg, entries.map((e) => e.sessionId));
    if (changed !== entries.length) {
      // 防御：正常路径已剔除未索引会话；若仍有 0 行（竞态/索引被清），包已写但原文件未删——
      // 删除包（无记录不可恢复，宁可不归档），抛错中断本轮，原文件保留。
      try { unlinkSync(pkgPath); } catch { /* best-effort */ }
      throw new Error(`archive integrity: ${entries.length - changed} session(s) not tracked in index`);
    }
    deleted += deleteOriginals(batch.map((c) => c.path));
    archived += entries.length;
    lastPkg = pkg;
    lastPkgBytes = existsSync(pkgPath) ? statSync(pkgPath).size : 0;
  }
  return { archived, deleted, packageName: lastPkg, sizeBytes: lastPkgBytes, candidates: candidates.length, ...(skippedIds ? { skippedIds } : {}) };
}

export async function archiveStatus(
  configDir: string,
  core: ExtCoreLike,
): Promise<{
  candidates: ArchiveCandidate[];
  cacheBytes: number;
  settings: Settings;
}> {
  const r = runtime(configDir);
  const sessions = await core.listSessions();
  const running = new Set(await core.getRunningSessionIds());
  const candidates = collectCandidates(
    sessions.map((s) => ({ id: s.id, cwd: s.cwd, modified: s.modified, path: s.path })),
    running,
    { ageDays: r.settings.archiveAgeDays, maxLiveSizeMb: r.settings.maxLiveSizeMb },
  );
  return { candidates, cacheBytes: cacheBytes(configDir), settings: r.settings };
}

/** Extract an archived session to the on-demand cache; returns cache path. */
export function extractArchived(configDir: string, sessionId: string): string | null {
  return extractToCache(configDir, sessionId);
}

/**
 * Restore an archived session to its original live path.
 * The restored file is byte-identical to the archived one (sha256-verified),
 * so the index row is flipped back to live WITHOUT dropping messages/FTS —
 * search / lastMeta / stats stay correct immediately (no waiting for a sync).
 */
export function restoreArchived(configDir: string, sessionId: string): boolean {
  const r = runtime(configDir);
  const row = r.index.getSession(sessionId);
  if (!row?.archived) return false;
  // ext 视图层归档行（无 .pwarc 包）：直接翻回 live
  if (row.archiveRef === EXT_ARCHIVE_REF) return unhideExtSession(configDir, sessionId);
  const restored = restoreFromArchive(configDir, sessionId);
  if (!restored) return false;
  r.index.restoreToLive(sessionId, restored);
  return true;
}

/**
 * Permanently delete an archived session (archive records only — live files
 * must be archived first). Removes the entry from its .pwarc package and all
 * index rows (sessions/messages/fts). Returns false if the id is not archived.
 * ext 视图层归档行（archiveRef=__ext__，无 .pwarc 包）不可删：返回 false（404）
 * —— 移除是纯视图层操作，行永远可恢复接管。
 */
export function deleteArchived(configDir: string, sessionId: string): boolean {
  const r = runtime(configDir);
  const row = r.index.getSession(sessionId);
  if (!row?.archived) return false;
  if (row.archiveRef === EXT_ARCHIVE_REF) return false;
  if (!removeFromArchive(configDir, sessionId)) return false;
  r.index.removeSession(sessionId);
  return true;
}

/** ext 源行「从列表移除」：视图层收进归档分组（archived=1，archiveRef=__ext__）。
 *  只接受外部源行（agent 非 pi）；path 保留（同步 GC 判活靠它）。 */
export function hideExtSession(configDir: string, sessionId: string): boolean {
  const r = runtime(configDir);
  const row = r.index.getSession(sessionId);
  if (!row || !row.agent || row.agent === "pi") return false;
  if (row.archived) return true; // 已在归档分组 → 幂等成功
  return r.index.setExtArchived(sessionId, true) > 0;
}

/** 移除过的 ext 行放回列表（archived=0）。 */
export function unhideExtSession(configDir: string, sessionId: string): boolean {
  const r = runtime(configDir);
  const row = r.index.getSession(sessionId);
  if (!row || row.archiveRef !== EXT_ARCHIVE_REF) return false;
  r.index.setExtArchived(sessionId, false);
  return true;
}

// ───────────────────────── A03 真归档管线（ext-archive / ext-restore） ─────────────────────────
// docs/todo-session-manager-ext-archive-delete.md §3：快照入 .pwarc → 删源 → 按需原样放回。
// §10 完整性纪律的 ext 版：包可读 + 逐条 sha256 回读验证通过，才允许 removeSession；
// removeSession 抛错 → 撤包、源数据保留（不漏记红线）。行状态复用视图层 archiveRef=__ext__，
// 消息/FTS 副本保留——归档行可看可搜。

export interface ExtArchiveOutcome {
  ok: boolean;
  id: string;
  agent: string;
  sid: string;
  packageName?: string;
  error?: string;
}

/** sha256 回读验证（解压后重算比对 manifest）。 */
function verifyArchiveEntry(packagePath: string, entry: { sha256: string; brotliSize: number; offset: number }): boolean {
  try {
    const raw = extractFromArchive(packagePath, entry as Parameters<typeof extractFromArchive>[1]);
    return createHash("sha256").update(raw).digest("hex") === entry.sha256;
  } catch {
    return false;
  }
}

/** 真归档：外部源会话 → .pwarc 快照 → 删源。adapter 需具备 remove 能力。 */
export async function runExtArchive(
  configDir: string,
  core: ExtCoreLike,
  adapter: AgentAdapter,
  sid: string,
): Promise<ExtArchiveOutcome> {
  const id = extId(adapter.id, sid);
  const fail = (error: string): ExtArchiveOutcome => ({ ok: false, id, agent: adapter.id, sid, error });
  if (!adapter.removeSession || !adapter.snapshot || !adapter.capabilities?.remove) {
    return fail("该 agent 不支持真归档（无 remove 能力）");
  }
  // 守卫：接管中/运行中跳过（open-live 接管链复用）
  const guarded = await releaseIdleFor([id], core);
  if (guarded.has(id)) return fail("会话运行中/接管中——先关闭再归档");
  // 源列表必须仍有该会话
  const refs = await adapter.list();
  const ref = refs.find((r) => r.sid === sid);
  if (!ref) return fail("源中未找到该会话（可能已被删除）");
  // 不可解析的不动（解析失败的会话无法安全归档）
  const parsed = await adapter.parse(ref);
  if (!parsed) return fail("源会话不可解析——拒绝归档");
  // 索引行预检（setExtArchived/hideExtSession 需行存在；未索引会话先同步）
  const r = runtime(configDir);
  if (!r.index.getSession(id)) return fail("索引无该会话行——请先同步源");
  if (r.index.getSession(id)?.archived) return fail("该会话已在归档分组");
  // 快照（原始字节）
  const snap = await adapter.snapshot(ref);
  if (!snap || !snap.bytes?.length) return fail("快照失败（源文件不可读）");
  // 写包（写 == 读同源：archivePackagesDir）
  const pkgName = `ext-${adapter.id.replace(/[^a-z0-9_-]/gi, "")}-${sid.slice(0, 8)}-${Date.now().toString(36)}.pwarc`;
  const pkgPath = join(archivePackagesDir(configDir), pkgName);
  try {
    writeArchiveFromBytes(pkgPath, [{ sessionId: id, path: snap.layout, bytes: snap.bytes, mtimeMs: ref.rev }]);
  } catch (e: any) {
    return fail("写归档包失败：" + String(e?.message ?? e));
  }
  // §10 完整性门：manifest 可读 + sha256 回读一致——不过则撤包，源数据未动
  const manifest = readArchiveManifest(pkgPath);
  if (!manifest || manifest.files.length !== 1 || !verifyArchiveEntry(pkgPath, manifest.files[0])) {
    try { unlinkSync(pkgPath); } catch { /* best-effort */ }
    return fail("归档包完整性校验未通过——已撤包，源数据保留");
  }
  // 删源（失败 → 撤包，源数据保留）
  try {
    await adapter.removeSession(ref);
  } catch (e: any) {
    try { unlinkSync(pkgPath); } catch { /* best-effort */ }
    return fail("removeSession 失败（源数据保留）：" + String(e?.message ?? e));
  }
  // 归档位（消息/FTS 副本保留：归档行可看可搜）。预检已保证行存在；0 行属竞态——
  // 数据仍在包内（不丢），行以 live 复现时下次同步会对齐，此处 console.error 留痕。
  if (r.index.setExtArchived(id, true) <= 0) {
    console.error(`[ext-archive] setExtArchived 0 行：${id}（包 ${pkgName} 保留，数据不丢）`);
  }
  console.log(`[ext-archive] ${id} → ${pkgName}（${snap.bytes.length} bytes）`);
  return { ok: true, id, agent: adapter.id, sid, packageName: pkgName };
}

/** 真恢复：.pwarc 解出 → putBack 原样写回 → 源列表确认 → 撤包条目 + 行翻回 live。 */
export async function restoreExtArchive(
  configDir: string,
  core: ExtCoreLike,
  adapter: AgentAdapter,
  sid: string,
): Promise<ExtArchiveOutcome> {
  const id = extId(adapter.id, sid);
  const fail = (error: string): ExtArchiveOutcome => ({ ok: false, id, agent: adapter.id, sid, error });
  if (!adapter.putBack) return fail("该 agent 不支持写回（无 putBack 能力）——快照仍可查看");
  const hit = findEntry(archivePackagesDir(configDir), id);
  if (!hit) return fail("归档包中未找到该会话（纯视图移除的行走「放回列表」）");
  const raw = extractFromArchive(hit.packagePath, hit.entry);
  if (createHash("sha256").update(raw).digest("hex") !== hit.entry.sha256) {
    return fail("归档包 sha256 校验失败（包损坏）——包保留，未写回");
  }
  // putBack 前查重：源里已重建同 id → 中止（防覆盖）
  const refs = await adapter.list();
  if (refs.some((r) => r.sid === sid)) return fail("源已存在同 id 会话——为防覆盖中止恢复");
  try {
    await adapter.putBack(sid, { bytes: raw, layout: hit.entry.path });
  } catch (e: any) {
    return fail("putBack 写回失败（包保留，数据不丢）：" + String(e?.message ?? e));
  }
  // 验收硬条件：写回后 agent 自身重新列出该会话
  const refs2 = await adapter.list();
  if (!refs2.some((r) => r.sid === sid)) {
    return fail("写回后源未列出该会话（agent 自身索引未同步？）——包保留");
  }
  // 撤包条目（数据已活）+ 行翻回 live（sync 重摄新数据）
  removeFromArchive(configDir, id);
  const r = runtime(configDir);
  r.index.setExtArchived(id, false);
  console.log(`[ext-restore] ${id} ← ${hit.packagePath}`);
  return { ok: true, id, agent: adapter.id, sid };
}

export function clearArchiveCache(configDir: string): number {
  return clearCache(configDir);
}

export function cacheUsage(configDir: string): number {
  return cacheBytes(configDir);
}
