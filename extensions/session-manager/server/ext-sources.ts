/**
 * session-manager — external source lifecycle (plan §4.7).
 *
 * Three states per source:
 *   discovered — roots exist, probed stat-level only (ms); NOT indexed
 *   active     — user clicked "load"; rows live in the index
 *   stale      — active but the watermark moved; a sync prompt shows, and
 *                nothing re-indexes until the user clicks
 *
 * Default is zero external cost: opening the panel never parses/decrypts/
 * copies anything from an inactive source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveCapableAgents, builtinAdapters } from "../lib/agents/registry.ts";
import { splitExtId, type AgentAdapter, type AgentSourceDescriptor, type ExtSessionRef, type ExtSourceProbe } from "../lib/agents/types.ts";
import type { Settings } from "./runtime.ts";

export interface SourceState {
  active: boolean;
  /** Max artifact mtime at last full sync (ms). */
  watermarkMs?: number;
  lastSyncAt?: string;
}

export interface SourceInfo {
  agent: string;
  label: string;
  status: "discovered" | "active" | "stale" | "unavailable" | "error";
  count?: number;
  pendingCount?: number;
  lastSyncAt?: string;
  dependencyHint?: string;
  /** 该源是否具备 A03 真归档原语（snapshot+removeSession+putBack）。 */
  archive?: boolean;
  error?: string;
}

interface SourcesRuntime {
  adapters: Map<string, AgentAdapter>;
  probes: Map<string, ExtSourceProbe>;
  states: Map<string, SourceState>;
  loadedFor: string;
}

const rt = new WeakMap<object, SourcesRuntime>();

/**
 * §4.8 slot contract: third-party extensions declaring
 * `ui.provides: ["session-agent-source"]` contribute agent sources. The ext
 * host registry singleton lives on globalThis (survives Next.js hot reload);
 * we call the provider's own api hook in-process — no HTTP hop.
 */
const SLOT_NAME = "session-agent-source";

interface RegistryLike {
  status(): Record<string, { provides?: string[] }>;
  api(req: Request, pathSegments: string[]): Promise<Response | null>;
}

function hostRegistry(): RegistryLike | null {
  const reg = (globalThis as { __piWebExt?: RegistryLike }).__piWebExt;
  return reg && typeof reg.status === "function" && typeof reg.api === "function" ? reg : null;
}

/** Extension ids (≠ self) that contribute sources: slot declaration ∪ explicit registration. */
function providerExtensionIds(selfId: string, configDir?: string): string[] {
  const ids = new Set<string>();
  const reg = hostRegistry();
  if (reg) {
    try {
      for (const [id, e] of Object.entries(reg.status())) {
        if (id !== selfId && Array.isArray(e.provides) && e.provides.includes(SLOT_NAME)) ids.add(id);
      }
    } catch { /* registry unavailable */ }
  }
  if (configDir) {
    for (const id of settingsOf(configDir).extRegisteredProviders ?? []) ids.add(id);
  }
  return [...ids];
}

/** §4.8 fallback: explicitly register a provider extension (persisted). */
export function registerProvider(configDir: string, extensionId: string): void {
  const cur = settingsOf(configDir).extRegisteredProviders ?? [];
  if (!cur.includes(extensionId)) {
    writeSettingsRaw(configDir, { ...settingsOf(configDir), extRegisteredProviders: [...cur, extensionId] });
  }
}

export function unregisterProvider(configDir: string, extensionId: string): void {
  const cur = settingsOf(configDir).extRegisteredProviders ?? [];
  writeSettingsRaw(configDir, { ...settingsOf(configDir), extRegisteredProviders: cur.filter((x) => x !== extensionId) });
}

async function callProvider(extId: string, op: string, params: URLSearchParams): Promise<unknown | null> {
  const reg = hostRegistry();
  if (!reg) return null;
  try {
    const url = `http://local/${extId}/agent-source/${op}${params.toString() ? "?" + params : ""}`;
    const res = await reg.api(new Request(url), [extId, "agent-source", op]);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Build an in-process proxy adapter backed by a provider extension's endpoints. */
function proxyAdapter(extId: string, desc: AgentSourceDescriptor): AgentAdapter {
  const q = (extra?: Record<string, string>) => new URLSearchParams({ agent: desc.id, ...(extra ?? {}) });
  return {
    id: desc.id,
    label: desc.label,
    dependencyHint: desc.dependencyHint,
    roots: () => [],
    async probe() {
      const d = (await callProvider(extId, "manifest", new URLSearchParams())) as { agents?: Array<{ id: string; count?: number; watermarkMs?: number; ok?: boolean }> } | null;
      const mine = d?.agents?.find((a) => a.id === desc.id);
      return { ok: mine ? mine.ok !== false : true, count: mine?.count ?? 0, watermarkMs: mine?.watermarkMs ?? 0 };
    },
    async list() {
      const d = (await callProvider(extId, "list", q())) as { sessions?: Array<{ id: string; artifactPath?: string }> } | null;
      return (d?.sessions ?? []).map((s) => ({ sid: s.id, path: s.artifactPath ?? `provider:${extId}#${desc.id}:${s.id}` }));
    },
    async parse(ref) {
      const d = (await callProvider(extId, "session", q({ sid: ref.sid }))) as { meta?: unknown; messages?: unknown } | null;
      if (!d?.meta || !Array.isArray(d.messages)) return null;
      return { meta: d.meta as ParsedMeta, messages: d.messages as ParsedMsgs };
    },
  };
}
type ParsedMeta = Parameters<AgentAdapter["parse"]> extends (r: ExtSessionRef) => infer R ? R extends { meta: infer M } ? M : never : never;
type ParsedMsgs = Parameters<AgentAdapter["parse"]> extends (r: ExtSessionRef) => infer R ? R extends { messages: infer M } ? M : never : never;

function getRt(configDir: string): SourcesRuntime {
  let r = rt.get(globalThis as object) as SourcesRuntime | undefined;
  if (!r || r.loadedFor !== configDir) {
    const adapters = new Map<string, AgentAdapter>();
    for (const a of builtinAdapters()) adapters.set(a.id, a);
    r = { adapters, probes: new Map(), states: new Map(), loadedFor: configDir };
    rt.set(globalThis as object, r);
    return r;
  }
  // The runtime outlives extension reloads (globalThis key) — refresh builtin
  // implementations so newly shipped sources appear without a process restart.
  for (const a of builtinAdapters()) r.adapters.set(a.id, a);
  return r;
}

/** Register proxy adapters for provider extensions (idempotent; builtin wins on id clash). */
async function ensureProviderAdapters(r: SourcesRuntime, configDir: string): Promise<void> {
  for (const extId of providerExtensionIds("session-manager", configDir)) {
    try {
      const manifest = (await callProvider(extId, "manifest", new URLSearchParams())) as { agents?: AgentSourceDescriptor[] } | null;
      for (const desc of manifest?.agents ?? []) {
        if (!desc?.id || typeof desc.id !== "string") continue;
        if (r.adapters.has(desc.id)) continue; // builtin wins; conflict = skip
        r.adapters.set(desc.id, proxyAdapter(extId, desc));
      }
    } catch { /* bad provider — skipped, never fatal */ }
  }
}

function writeSettingsRaw(configDir: string, obj: Record<string, unknown>): void {
  try { writeFileSync(join(configDir, "settings.json"), JSON.stringify(obj, null, 2)); } catch { /* best effort */ }
}

function settingsOf(configDir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadSourceStates(configDir: string): Map<string, SourceState> {
  const raw = settingsOf(configDir).extSources as Record<string, SourceState> | undefined;
  const map = new Map<string, SourceState>();
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v && typeof v === "object") map.set(k, { active: !!v.active, watermarkMs: v.watermarkMs, lastSyncAt: v.lastSyncAt });
  }
  return map;
}

export function saveSourceStates(configDir: string, states: Map<string, SourceState>, base: Record<string, unknown>): void {
  const extSources: Record<string, SourceState> = {};
  for (const [k, v] of states) if (v.active || v.watermarkMs !== undefined) extSources[k] = v;
  writeFileSync(join(configDir, "settings.json.tmp"), JSON.stringify({ ...base, extSources }, null, 2));
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ ...base, extSources }, null, 2));
}

/** stale 判定（静置期门控）。持续写入中的热工件（Trae 打开时不停写 db、codex
 *  活跃会话持续追加 rollout）会让 mtime 水位永远前移——同步永远追不上、徽标永不
 *  消失。只有最新工件已静置 QUIET 才算真有更新；写完静置后必触发一次，同步收敛。 */
const STALE_QUIET_MS = 120_000;

function isStale(now: number, probe: ExtSourceProbe, st: SourceState): boolean {
  return probe.ok
    && probe.watermarkMs > (st.watermarkMs ?? 0) + 1000
    && now - probe.watermarkMs > STALE_QUIET_MS;
}

/** Discovery pass: probe every registered adapter (stat-level only). */
export async function discoverSources(configDir: string): Promise<SourceInfo[]> {
  const r = getRt(configDir);
  await ensureProviderAdapters(r, configDir);
  r.states = loadSourceStates(configDir);
  const out: SourceInfo[] = [];
  for (const [id, a] of r.adapters) {
    try {
      const probe = await a.probe();
      r.probes.set(id, probe);
      const st = r.states.get(id) ?? { active: false };
      let status: SourceInfo["status"];
      if (!probe.ok && !st.active) status = "unavailable";
      else if (!st.active) status = "discovered";
      else status = isStale(Date.now(), probe, st) ? "stale" : "active";
      out.push({
        agent: id,
        label: a.label,
        status,
        count: probe.ok ? probe.count : 0,
        lastSyncAt: st.lastSyncAt,
        dependencyHint: a.dependencyHint,
        archive: archiveCapableAgents().includes(id),
      });
    } catch (e) {
      out.push({ agent: id, label: a.label, status: "error", error: String(e) });
    }
  }
  return out;
}

/** Activate: first full scan+index of one source. */
export async function activateSource(
  configDir: string,
  indexApi: { syncExt(agent: string, refs: ExtSessionRef[], parse: (ref: ExtSessionRef) => ReturnType<AgentAdapter["parse"]> | Promise<ReturnType<AgentAdapter["parse"]>>): Promise<{ indexed: number }> },
  agent: string,
): { ok: boolean; indexed?: number; error?: string } {
  const r = getRt(configDir);
  r.states = loadSourceStates(configDir); // merge disk truth — never clobber sibling activations
  const a = r.adapters.get(agent);
  if (!a) return { ok: false, error: "unknown agent" };
  let refs: ExtSessionRef[];
  try { refs = await a.list(); } catch (e) { return { ok: false, error: String(e) }; }
  let indexed = 0;
  try {
    indexed = (await indexApi.syncExt(agent, refs, (ref) => a.parse(ref))).indexed;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const probe = await r.probes.get(agent) ?? await a.probe();
  r.probes.set(agent, probe);
  const st: SourceState = { active: true, watermarkMs: probe.watermarkMs, lastSyncAt: new Date().toISOString() };
  r.states.set(agent, st);
  persistStates(configDir, r);
  return { ok: true, indexed };
}

/** Re-sync one active (or stale) source. */
export async function syncSource(
  configDir: string,
  indexApi: { syncExt(agent: string, refs: ExtSessionRef[], parse: (ref: ExtSessionRef) => ReturnType<AgentAdapter["parse"]> | Promise<ReturnType<AgentAdapter["parse"]>>): Promise<{ indexed: number }> },
  agent: string,
): { ok: boolean; indexed?: number; error?: string } {
  const r = getRt(configDir);
  r.states = loadSourceStates(configDir); // merge disk truth — never clobber sibling activations
  const a = r.adapters.get(agent);
  const st = r.states.get(agent);
  if (!a || !st?.active) return { ok: false, error: "source not active" };
  // list 失败（源库暂时不可读）必须中止而非当空 refs 同步——否则 scoped GC 会把
  // 本源全部 ext 行误删（zcode adapter 现在失败抛错，这里对齐 fail-loud）。
  let refs: ExtSessionRef[];
  try { refs = await a.list(); } catch (e) { return { ok: false, error: String(e) }; }
  let indexed = 0;
  try {
    indexed = (await indexApi.syncExt(agent, refs, (ref) => a.parse(ref))).indexed;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const probe = await a.probe();
  r.probes.set(agent, probe);
  r.states.set(agent, { ...st, watermarkMs: probe.watermarkMs, lastSyncAt: new Date().toISOString() });
  persistStates(configDir, r);
  return { ok: true, indexed };
}

/** Deactivate: drop this agent's rows from the index, keep the state record. */
export function deactivateSource(
  configDir: string,
  indexApi: { removeAgentRows(agent: string): void },
  agent: string,
): { ok: boolean; error?: string } {
  const r = getRt(configDir);
  if (!r.adapters.has(agent)) return { ok: false, error: "unknown agent" };
  indexApi.removeAgentRows(agent);
  r.states.set(agent, { active: false });
  persistStates(configDir, r);
  return { ok: true };
}

function persistStates(configDir: string, r: SourcesRuntime): void {
  const base = settingsOf(configDir);
  saveSourceStates(configDir, r.states, base);
}

/** Ensure third-party proxy adapters are registered (call before any adapter lookup). */
export async function ensureProviders(configDir: string): Promise<void> {
  await ensureProviderAdapters(getRt(configDir));
}

export function getAdapter(configDir: string, agent: string): AgentAdapter | undefined {
  return getRt(configDir).adapters.get(agent);
}

/** Active agent ids (for the merged-list tail query). */
export function activeAgents(configDir: string): string[] {
  return [...loadSourceStates(configDir).entries()].filter(([, v]) => v.active).map(([k]) => k);
}

/** Resolve a composite id back to its owning adapter + native sid. */
export function resolveExtId(configDir: string, id: string): { adapter: AgentAdapter; sid: string } | null {
  const { agent, sid } = splitExtId(id);
  const adapter = getRt(configDir).adapters.get(agent);
  return adapter ? { adapter, sid } : null;
}

/* ── 请求驱动的 stale 自动补同步（2026-09-08）──
 *
 * 此前 ext 源只在 activate/手动 sync 时索引：新建的外部会话（zcode/cursor…）没有
 * ext 行 → 站位行富化无内容、双行、徽标时有时无（实测 2026-09-07 zcode 双条目）。
 * 列表端点每次 GET 触发本函数：probe（stat 级）watermark 没变零成本跳过；变了才
 * 后台 syncSource。非轮询——没有 GET 就没有动作；in-flight 锁 + 失败冷却防抖。 */
const autoSyncInflight = new Set<string>();
const autoSyncFailAt = new Map<string, number>();
const AUTO_SYNC_FAIL_COOLDOWN_MS = 30_000;

/* ── 站位行按需单会话富化（2026-09-10）──
 * 静置门控的补同步要求源 db 静置 2 分钟——只要该源任一会话在活动（zcode 常驻写
 * wal，比如 agent 正在跑），watermark 就一直刷新，新落盘会话的 ext 索引行就一直
 * 缺席：站位行「0 条消息 / (no messages)」数分钟不转正（实测）。列表端点发现
 * 站位行查不到 ext 索引行时走本函数：单会话 parse + upsertExtParsed 直写，不触
 * 发全量重 parse。有界：per-sid in-flight 锁 + 60s 失败冷却；本次响应仍走站位
 * 兜底，下次 GET 即见富化行（客户端 running 帧/refreshKey 自会再拉）。 */
const enrichInflight = new Set<string>();
const enrichFailAt = new Map<string, number>();
const ENRICH_RETRY_MS = 60_000;

export function enrichExtPlaceholders(
  configDir: string,
  indexApi: { upsertExtParsed: (agent: string, sid: string, refPath: string, parsed: NonNullable<ReturnType<AgentAdapter["parse"]>>) => void },
  extIds: string[],
): void {
  const now = Date.now();
  const want = [...new Set(extIds)].filter((id) => !enrichInflight.has(id) && now - (enrichFailAt.get(id) ?? 0) >= ENRICH_RETRY_MS);
  if (!want.length) return;
  const byAgent = new Map<string, string[]>();
  for (const extId of want) {
    const { agent, sid } = splitExtId(extId);
    if (!agent || !sid) continue;
    const list = byAgent.get(agent) ?? [];
    list.push(sid);
    byAgent.set(agent, list);
  }
  for (const [agent, sids] of byAgent) {
    const adapter = getRt(configDir).adapters.get(agent);
    if (!adapter) continue;
    // 一次 list() 供整批复用（refs 的 path 形态与全量 syncExt 一致，GC 判活同源）
    let bySid = new Map<string, ExtSessionRef>();
    try {
      bySid = new Map(adapter.list().map((r) => [r.sid, r]));
    } catch {
      for (const sid of sids) enrichFailAt.set(`${agent}:${sid}`, Date.now());
      continue;
    }
    for (const sid of sids) {
      const extId = `${agent}:${sid}`;
      enrichInflight.add(extId);
      void (async () => {
        try {
          const ref = bySid.get(sid) ?? { sid, path: "" };
          const parsed = await adapter.parse(ref);
          if (parsed && (parsed.meta.messageCount ?? 0) > 0) {
            indexApi.upsertExtParsed(agent, sid, ref.path, parsed);
          } else {
            enrichFailAt.set(extId, Date.now());
          }
        } catch {
          enrichFailAt.set(extId, Date.now());
        } finally {
          enrichInflight.delete(extId);
        }
      })();
    }
  }
}

/* autoSyncStaleSources 全局节流（2026-09-12）：20+ active 源每源 probe 都是主线程
 * 同步扫描（readdir+stat / sqlite count，实测 12-45ms/源），每请求放行一轮累计
 * ~0.5-1s 占满事件循环——TTFB 直接受害（sessions?fmt=2 实测归因）。30s 一轮与
 * REFRESH_TS_MS 对齐：新外部会话 ext 行最多晚 30s 补齐，由下一轮拉取自然收敛。
 *
 * 事件循环让步（2026-09-13）：probe 实现是同步的（fs/sqlite），无法在单次 probe 内
 * 让步——改为「源间让步」：每处理一个源前 setImmediate 交还事件循环，把一次性
 * ~1s 的连续阻塞切成 ≤45ms 的小块，HTTP 请求可以在块间插入，TTFB 不再被整轮背走。*/
let autoSyncLastAt = 0;
const AUTO_SYNC_MIN_INTERVAL_MS = 30_000;

async function yieldLoop(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

export async function autoSyncStaleSources(
  configDir: string,
  indexApi: { syncExt(agent: string, refs: ExtSessionRef[], parse: (ref: ExtSessionRef) => ReturnType<AgentAdapter["parse"]> | Promise<ReturnType<AgentAdapter["parse"]>>): Promise<{ indexed: number }> },
): Promise<void> {
  const now = Date.now();
  if (now - autoSyncLastAt < AUTO_SYNC_MIN_INTERVAL_MS) return;
  autoSyncLastAt = now;
  const r = getRt(configDir);
  for (const [agent, st] of loadSourceStates(configDir)) {
    if (!st.active || autoSyncInflight.has(agent)) continue;
    const lastFail = autoSyncFailAt.get(agent) ?? 0;
    if (now - lastFail < AUTO_SYNC_FAIL_COOLDOWN_MS) continue;
    const a = r.adapters.get(agent);
    if (!a) continue;
    await yieldLoop(); // 源间让步：单源同步扫描不跨源累积成秒级阻塞
    void (async () => {
      let probe: ExtSourceProbe;
      try { probe = await a.probe(); } catch { return; } // probe 失败静默（下轮再试）
      if (!probe.ok) return;
      // 与 discoverSources 的 stale 判定同款（静置期门控 + 1s 容差）
      if (!isStale(now, probe, st)) return;
      autoSyncInflight.add(agent);
      try {
        const res = await syncSource(configDir, indexApi, agent);
        if (res.ok) autoSyncFailAt.delete(agent);
        else autoSyncFailAt.set(agent, Date.now());
      } catch {
        autoSyncFailAt.set(agent, Date.now());
      } finally {
        autoSyncInflight.delete(agent);
      }
    })();
  }
}

/* ── 运行中 ext 会话的时间戳刷新（2026-09-10）──
 *
 * 全量补同步被静置门控饿死：运行中源（zcode 常驻写 wal）watermark 永远前移 →
 * 永不 stale → ext 行 modified 停在最后一次 sync 的旧值，dock 时间冻结（实测）。
 * 本通道只做时间戳-only 前进：adapter.listFresh()（零 message parse 的轻量快照，
 * 只读 session 表 title/time_updated）→ refreshExtTimestamps（只写 sessions.modified
 * + 顺带 name，不碰 messages/fts/message_count）。新消息内容仍由静置后的全量 sync 补。
 * 节流 REFRESH_TS_MS 防高频开源 db；无 listFresh 的适配器自然跳过（无动作）。 */
const refreshTsLastAt = new Map<string, number>();
const REFRESH_TS_MS = 30_000; // 2026-09-12 10s→30s：降低后台扫描频率（时间戳滞后换性能）

export async function refreshLiveExtTimestamps(
  configDir: string,
  indexApi: { refreshExtTimestamps(agent: string, fresh: Array<{ sid: string; timeUpdatedMs?: number; title?: string }>): number },
): Promise<void> {
  const r = getRt(configDir);
  const now = Date.now();
  for (const [agent, st] of loadSourceStates(configDir)) {
    if (!st.active) continue;
    const a = r.adapters.get(agent);
    if (!a?.listFresh) continue;
    if (now - (refreshTsLastAt.get(agent) ?? 0) < REFRESH_TS_MS) continue;
    refreshTsLastAt.set(agent, now);
    await yieldLoop(); // 适配器间让步：listFresh 同步扫描不跨源累积
    try {
      const fresh = await a.listFresh();
      if (fresh.length) indexApi.refreshExtTimestamps(agent, fresh);
    } catch { /* 静默降级：下一轮再试；全量 sync 仍收敛 */ }
  }
}
