/**
 * session-manager · 共享数据层（自手写版迁移，逻辑一比一）。
 *
 * store（sessions/running/tagData）+ 订阅、共享 tag 过滤器、弹窗开关 flag、
 * 数据刷新（ETag/304）、tag 动作（乐观锁 409 重试）、归档动作、pending tags 持久化。
 */

import { useState, useEffect, apiUrl, getExtService } from "./host-shim";
import { present as presentDock, presentState, openFloat, closePanel } from "../../../_shared/ext-float-dock-lite";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
import { decodeSessionsPayload, decodeArchivedPayload, decodeRowV2 } from "../../server/payload.ts";
import type { SessionInfo } from "./sidebar/pure";
import {
  PIN_TAG_NAME, findPinTagId, isSessionPinned,
  isProjectPinned, projectPinId, reorderPinnedFavorites,
} from "./sidebar/pure";

// 空标签数据兜底（稳定引用——useEffect 依赖比较用;若用对象字面量,
// 每次渲染都生成新对象导致依赖每次都变 → setState 循环 → Maximum update depth exceeded）
export const EMPTY_TAGS = Object.freeze({ version: 0, favoriteIds: [], tags: [], sessionTags: {} });

/* ── store ── */

/** workspace（项目）条目（通道拆分方案 §3 F1；服务端 /workspaces 项目级聚合）。 */
export interface WorkspaceEntry {
  key: string;
  root: string;
  name?: string;
  lastModified?: string;
  sessionCount?: number;
  runningCount?: number;
  unreadCount?: number;
}

export const store = {
  /** 纯 live 列表（live+外部行；服务端 /sessions 拆分返回，2026-09-07）。
   *  dock/看板/回灌宿主直接消费即纯在册列表，归档不残留。
   *  [通道拆分] 全量通道：宿主 catalog（家族树）/All Sessions/看板/搜索用；侧栏列表改用
   *  projectSessions（scoped 通道）。 */
  sessions: [] as any[],
  /** 归档行独立桶（同 id 不跨桶共存；归档=移桶）。面板归档视图按需合并。 */
  archived: [] as any[],
  /** [通道拆分] 项目列表通道：服务端 /workspaces 项目级聚合（轻量、不依赖 1MB 全量）。 */
  workspaces: [] as WorkspaceEntry[],
  /** [通道拆分] 当前 workspace 的会话列表（scoped /sessions?project=<key>）。 */
  projectSessions: [] as any[],
  /** 当前 projectSessions 所属 project key（`isProjectSessionsLoaded` 的单一事实源；
   *  切换项目时据此判 loading / 是否需重拉；仅在响应真正落地（含 target 守卫通过）时写入）。 */
  projectSessionsKey: "" as string,
  /** 未落盘会话行（内存态/刚落盘但服务端尚不可见）——不绑定选中态：新建会话后
   *  用户切到其他会话，草稿行仍保留在列表（原实现只在选中时显示，切走即消失、
   *  必须刷新才能找回——2026-09「新会话丢失」修复）。落盘后被 /sessions 列出
   *  → reconcile 自动移出转正；超 TTL 清理防泄漏。 */
  pendingDrafts: [] as Array<{ session: SessionInfo; notedAt: number }>,
  running: new Set<string>(),
  tagData: null as any, // { version, favoriteIds, tags, sessionTags }
  sources: [] as any[],  // M1: external source cards {agent,label,status,count,...}
  /** 具备真归档原语的 agent 名单（全量 /sessions 带下；空=服务端未提供，菜单不做限制）。 */
  extArchiveAgents: [] as string[],
  version: 0,
  listeners: new Set<() => void>(),
};

export function emit() { store.version++; for (const l of store.listeners) l(); }
export function subscribe(l: () => void) { store.listeners.add(l); return () => { store.listeners.delete(l); }; }

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((v) => v + 1)), []);
  return store;
}

/** 就地改名单行（乐观更新，2026-09-12）：重命名成功后立即在本地 store 生效——
 *  不等列表刷新往返。调用方不需要强刷：服务端 rev 指纹已含 name，下一次常规
 *  刷新（patch/全量）自然对齐（此前只依赖 refreshSessions：叠加 3s 节流 +
 *  服务端指纹漏 name → 行名长期停在旧值，即「重命名很久才刷新」）。
 *  覆盖 live/archived/projectSessions 三桶——左栏 dock 渲染 scoped 桶，只 patch 前两桶
 *  则 dock 里改名没反应（通道拆分后同一族遗漏，2026-09-22 补）。
 *  override 表：重命名前已发出的在途响应（尤其 refresh=1 全量分支整桶替换）可能在
 *  乐观更新后落地、用旧名覆盖整行——列表落地时按 override 套回；服务端数据
 *  一致即确认清除；TTL 内未确认（极端：外部行名被源覆盖）则放弃，回到服务端值。 */
const localNameOverrides = new Map<string, { name: string; until: number }>();
const LOCAL_NAME_OVERRIDE_TTL_MS = 10_000;

export function applySessionNameLocal(id: string, name: string): void {
  const key = String(id);
  localNameOverrides.set(key, { name, until: Date.now() + LOCAL_NAME_OVERRIDE_TTL_MS });
  let found = false;
  const patchRows = (rows: any[] | undefined) => (rows ?? []).map((r) => {
    if (String(r.id) !== key) return r;
    found = true;
    return r.name === name ? r : { ...r, name };
  });
  const nextLive = patchRows(store.sessions);
  const nextArch = patchRows(store.archived);
  const nextProj = patchRows(store.projectSessions);
  if (!found) return; // 不在册（极端：列表尚未加载）——等下次刷新自然带出
  store.sessions = nextLive;
  store.archived = nextArch;
  store.projectSessions = nextProj;
  emit();
}

/**
 * 列表响应落地后调用（emit 前）：把仍有效的本地改名套回（override 语义见上）。
 * scope 指明「本次落地的是哪个桶」——只有刚落地的行才是服务端数据，可据名字一致
 * 确认清除 override：
 *   · full：sessions/archived 为准（并据三桶判行是否还在）；驻留的 projectSessions 只套回。
 *   · scoped：只处理 projectSessions，且不 purge——本项目桶本就不含其它项目的行，
 *     缺席不构成「行已消失」，据此清会把别处的乐观值丢掉（2026-09-22 补）。
 */
function reconcileLocalNames(scope: "full" | "scoped" = "full"): void {
  if (!localNameOverrides.size) return;
  const now = Date.now();
  const seen = new Set<string>();
  /** @param fresh 本桶行是否刚由服务端响应落地（只有 fresh 桶的「已一致」才算服务端确认） */
  const apply = (rows: any[] | undefined, fresh: boolean) => (rows ?? []).map((r) => {
    const id = String(r.id);
    const ov = localNameOverrides.get(id);
    if (!ov) return r;
    seen.add(id);
    if (now >= ov.until || (fresh && r.name === ov.name)) { // 保护过期 / 服务端已一致 → 确认清除
      localNameOverrides.delete(id);
      return r;
    }
    return { ...r, name: ov.name }; // 旧响应（在途）→ 套回乐观值
  });
  if (scope === "scoped") {
    store.projectSessions = apply(store.projectSessions, true);
    return;
  }
  store.sessions = apply(store.sessions, true);
  store.archived = apply(store.archived, true);
  store.projectSessions = apply(store.projectSessions, false);
  // 行已不在任何桶（删除/移出）→ override 失效
  for (const id of [...localNameOverrides.keys()]) if (!seen.has(id)) localNameOverrides.delete(id);
}

/* ── 行移除操作进行中跟踪（置灰标注，2026-09）──────────────
 * 移除类操作（归档/彻底删除/从列表移除，含恢复——恢复也是把行移出归档视图）
 * 后端动作 + 列表刷新（refreshSessions）较慢：操作执行即标记该行 pending（带桶：
 * live=从当前 live 视图移除 / archived=从归档视图移除），渲染层把对应条目置灰 +
 * 禁点，让用户知道正在处理、防重复点击；刷新落地（条目已移出所在桶）自动清除，
 * 失败由调用方 clear 恢复样式。模块级跨组件共享（面板行/归档弹层/批量对话框/归档
 * 查看器），订阅模式同 sharedFilter（Set 变更不触发 store.emit，须单独通知）。 */
const pendingRemovals = new Map<string, "live" | "archived">();
const pendingRemovalSubs = new Set<() => void>();
function notifyPendingRemovals() { for (const l of pendingRemovalSubs) l(); }
export function markPendingRemoval(id: string, bucket: "live" | "archived") {
  pendingRemovals.set(id, bucket);
  notifyPendingRemovals();
}
export function clearPendingRemoval(id: string) {
  if (pendingRemovals.delete(id)) notifyPendingRemovals();
}
export function pendingRemovalOf(id: string): "live" | "archived" | undefined {
  return pendingRemovals.get(id);
}
export function isPendingRemoval(id: string, bucket?: "live" | "archived"): boolean {
  if (!bucket) return pendingRemovals.has(id);
  return pendingRemovals.get(id) === bucket;
}
export function subscribePendingRemovals(l: () => void) {
  pendingRemovalSubs.add(l);
  return () => { pendingRemovalSubs.delete(l); };
}
/** 列表刷新落地后调用：条目已移出标记所在桶 → 该 pending 已完成（清除，防残留）。
 *  bucket==live 只看 live 桶：归档/从列表移除把行移进 archived 桶，但 live 视图已无
 *  此行 → 完成（归档行新出现不受 live 标记影响）；bucket==archived 看 archived 桶。 */
function prunePendingRemovals() {
  if (!pendingRemovals.size) return;
  const liveIds = new Set((store.sessions ?? []).map((r) => String(r.id)));
  const archIds = new Set((store.archived ?? []).map((r) => String(r.id)));
  let changed = false;
  for (const [id, bucket] of [...pendingRemovals]) {
    const gone = bucket === "live" ? !liveIds.has(id) : !archIds.has(id);
    if (gone) { pendingRemovals.delete(id); changed = true; }
  }
  if (changed) notifyPendingRemovals();
}

/* Shared tag filter across the panel + topbar chips (§4.2/§3.4). */
export const sharedFilter = { tagIds: [] as string[], listeners: new Set<() => void>() };
function notifyFilter() { for (const l of sharedFilter.listeners) l(); }
function toggleSharedFilter(tagId: string) {
  const has = sharedFilter.tagIds.includes(tagId);
  sharedFilter.tagIds = has ? sharedFilter.tagIds.filter((x) => x !== tagId) : [...sharedFilter.tagIds, tagId];
  notifyFilter();
}
export function clearSharedFilter() { sharedFilter.tagIds = []; notifyFilter(); }
export function useSharedFilter(): string[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((v) => v + 1);
    sharedFilter.listeners.add(l);
    return () => { sharedFilter.listeners.delete(l); };
  }, []);
  return sharedFilter.tagIds;
}
export { notifyFilter, toggleSharedFilter };

/* ── running 状态源治理（2026-09-07「运行中状态丢失」修复）──
 * store.running 被三类源写入：
 *   1. SSE 帧（/api/agent/running/events，entries.tsx）——服务端每次运行集变化才广播，权威且最新；
 *   2. refreshSessionsInner 的 runRes 快照（/api/agent/running，与列表并行拉）；
 *   3. entries.tsx 的 15s 兜底轮询（refreshRunning）。
 * 后两者是「请求时点」快照——若请求发出早、响应落地晚（在某个运行帧之后才回来），
 * 就会用旧时点快照覆盖 SSE 已更新的运行集 → 亮着的运行中转圈熄灭（session 明明在跑
 * 却不标 running，用户实测「运行中状态丢失」）。
 * 治理：SSE 帧永远权威（总是落地）；快照只在「SSE 尚未递送过运行帧」（初始快照，保证
 * 刷新后转圈即恢复）或「SSE 静默超时」（断线兜底）时才准落地。 */
let runningSseDelivered = false; // 是否收到过运行帧（此后快照不再覆盖，SSE 为主导）
let runningSseFreshAt = 0;       // 最近一次运行帧/心跳时刻（快照兜底的静默判断）
export const RUNNING_SSE_FRESH_MS = 45_000;
// 宿主共享 broker 投递给 frameListeners 的「心跳帧」type（与 pi-web lib/agent-running-events.ts
// 的 HEARTBEAT_FRAME_TYPE 对齐）。只推进健康时钟，不透传给业务 handler。
export const HEARTBEAT_FRAME_TYPE = "piwe:heartbeat";

/** SSE 权威运行帧：总是落地；返回「集合是否变化」（entries.tsx 据以决定是否触发列表刷新）。 */
export function applyRunningFrame(ids: string[]): boolean {
  runningSseDelivered = true;
  runningSseFreshAt = Date.now();
  const next = new Set(ids);
  const changed = next.size !== store.running.size
    || [...next].some((id) => !store.running.has(id));
  store.running = next;
  return changed;
}

/** /api/agent/running 快照：仅当 SSE 未权威、已静默超时、或后端广播 offline 时才落地；
 *  返回「是否实际写入且内容变化」（供调用方据此 emit）。
 *  SSE 权威且未静默且后端在线 → 快照是旧时点，跳过（防覆盖运行中标志）；
 *  后端断连窗口（runningBackendOffline）→ 允许快照兜底，直接落地。 */
export function applyRunningSnapshot(ids: string[]): boolean {
  if (runningSseDelivered && !runningBackendOffline && Date.now() - runningSseFreshAt < RUNNING_SSE_FRESH_MS) {
    return false;
  }
  const next = new Set(ids);
  const changed = next.size !== store.running.size
    || [...next].some((id) => !store.running.has(id));
  if (!changed) return false; // 内容未变：不写入不 emit（避免断连窗口每 15s 无谓重渲染）
  store.running = next;
  return true;
}

/** SSE 心跳判活：更新静默时钟（快照兜底据此判断「SSE 是否死了」）。 */
export function markRunningHeartbeat(): void {
  runningSseFreshAt = Date.now();
}

/** 首帧快照即通道基线（2026-09-15）：服务端 running 帧生产已与 events route 连接
 *  解绑（pi-web lib/running-broadcast.ts）——订阅建立后拉到的快照是权威起点，
 *  标记后兜底轮询归零（后续由 SSE 运行帧/心跳接管健康时钟）。通道实际不可用时
 *  45s 内无心跳/帧 → 静默超时 → 自动恢复兜底轮询（零冻结：快照重新可落地）。 */
export function markRunningSnapshotAligned(): void {
  runningSseDelivered = true;
  runningSseFreshAt = Date.now();
}

/** 订阅建立即对齐快照基线（一次；失败允许重试）。运行集广播恢复后（pi-web
 *  lib/running-broadcast.ts），订阅者的权威起点 = 首次快照 + 后续 SSE 帧；
 *  对齐后 isRunningSseHealthy 成立 → 30s 兜底轮询不再发请求（心跳/帧持续
 *  刷新时钟；通道真断时 45s 后静默超时 → 轮询自动恢复）。 */
let runningSnapshotAligned = false;
export function alignRunningSnapshotOnce(): void {
  if (runningSnapshotAligned) return;
  runningSnapshotAligned = true;
  void refreshRunning().then((ok) => { if (ok) markRunningSnapshotAligned(); else runningSnapshotAligned = false; });
}

/* ── 共享 broker 订阅（2026-09-07：消除扩展直连 /api/agent/running/events 的重复长连接）──
 * 宿主把 /api/agent/running/events 做成页面级共享连接（pi-web lib/agent-running-events.ts），
 * 并在 window.__piPageEventsClient.subscribePageFrames(handler) 暴露跨 bundle 消费口：
 * 每个 message 帧（data: JSON）原样交给 handler（frame.type 区分来源）；宿主现会把 named
 * heartbeat 也作为 { type: HEARTBEAT_FRAME_TYPE } 帧投递（见下方 wrapped：推进健康时钟）；
 * 建连/心跳/断线重连全由宿主 broker 管理。这里封装：broker 优先，旧宿主回退
 * 原生 EventSource（自带 heartbeat→markRunningHeartbeat + CLOSED 重建）。 */
export function subscribeRunningFrames(
  handler: (frame: Record<string, unknown>) => void,
): () => void {
  // 订阅即对齐基线（一次）：快照权威起点 + 后续帧/心跳接管健康时钟（见 alignRunningSnapshotOnce）
  alignRunningSnapshotOnce();
  // 统一包装：识别宿主投递的「心跳帧」→ 只推进健康时钟（不透传，避免业务 handler 收到
  // 非业务帧）；其余帧（running/扩展帧）原样透传。回退分支的 onmessage 同走此包装。
  // （根因：宿主 broker 原契约不把 named heartbeat 投递给 frameListeners，导致运行集稳定时
  //   session-manager 恒判 SSE 死 → 持续兜底轮询 /api/agent/running，放大后端负载。）
  const wrapped = (frame: Record<string, unknown>) => {
    if (frame?.type === HEARTBEAT_FRAME_TYPE) { markRunningHeartbeat(); return; }
    handler(frame);
  };
  // 优先：宿主共享 broker（页面级单例连接）
  try {
    const client = (window as unknown as {
      __piPageEventsClient?: { subscribePageFrames?: (h: (f: Record<string, unknown>) => void) => () => void };
    }).__piPageEventsClient;
    if (client && typeof client.subscribePageFrames === "function") {
      return client.subscribePageFrames(wrapped);
    }
  } catch { /* 非浏览器环境 */ }
  // 回退：旧宿主无 broker → 原生 EventSource（保留心跳/重建）
  let stopped = false;
  let es: EventSource | null = null;
  const connect = () => {
    if (stopped || es) return;
    const source = new EventSource(apiUrl("/api/agent/running/events"));
    es = source;
    source.addEventListener("heartbeat", () => {
      if (stopped || source !== es) return;
      markRunningHeartbeat();
    });
    source.onmessage = (e) => {
      if (stopped || source !== es) return;
      try { wrapped(JSON.parse(e.data) as Record<string, unknown>); } catch { /* 畸形帧 */ }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && es === source) {
        setTimeout(() => {
          if (stopped || es !== source) return;
          es = null;
          connect();
        }, 3000);
      }
    };
  };
  connect();
  return () => { stopped = true; try { es?.close(); } catch { /* noop */ } es = null; };
}

/** 宿主广播的后端断连状态（piwe-backend-conn CustomEvent）——断连时允许快照兜底落地。 */
let runningBackendOffline = false;
export function setRunningBackendOffline(offline: boolean) { runningBackendOffline = offline; }

/** SSE/共享 broker 是否健康（决定兜底轮询是否发请求、快照是否可落地）。 */
export function isRunningSseHealthy(): boolean {
  return runningSseDelivered && !runningBackendOffline
    && (Date.now() - runningSseFreshAt < RUNNING_SSE_FRESH_MS);
}

// 模块级：监听宿主广播的后端断连/恢复（跨 bundle CustomEvent；非浏览器环境静默）
try {
  if (typeof window !== "undefined") {
    window.addEventListener("piwe-backend-conn", ((e: CustomEvent) => {
      const state = (e as CustomEvent<{ state?: string }>).detail?.state;
      if (state === "offline") setRunningBackendOffline(true);
      else if (state === "online") setRunningBackendOffline(false);
    }) as EventListener);
  }
} catch { /* 非浏览器环境 */ }

/* ── 未落盘会话（pending drafts）——2026-09「新会话丢失」修复 ──
 * 问题：新建会话第一次交互后，内存已有真实 id，但 .jsonl 落盘（pi 在第一条
 * assistant 回复完成时写）+ core 5s 扫描缓存前，服务端 /sessions 列不出它。
 * 旧实现草稿行绑定「选中会话」：切到其他会话行即消失，且落盘后若刷新命中
 * 5s 缓存则草稿态永不消除（无补偿刷新）→ 必须刷页面（很吓人）。
 * 治理：noteDraftSession 把这类会话记入 store.pendingDrafts（不绑定选中态），
 * dock 按当前项目钉在列表顶部显示草稿行；refreshSessions 落地后 reconcile——
 * 列表出现即移出转正。等待窗口（~155s，覆盖长思考后写盘）内指数退避补拉
 * （5s/10s/20s/40s/80s，每次带 refresh=1 绕过 core 5s 缓存强制重扫），窗口
 * 截止即停（有界，非轮询）；宿主 handleAgentEnd 每回合 bump refreshKey 且
 * pending 非空时 dock 把该刷新升级为 refresh=1 → 回复完成即转正。
 * 快照一律标 transient：行内重命名/删除入口与宿主语义一致保持隐藏。 */
const PENDING_DRAFT_TTL_MS = 10 * 60 * 1000;   // 未落盘行保留上限（防泄漏）
const PENDING_DRAFT_RETRY_WINDOW_MS = 155_000; // 落盘等待窗口（窗口内补拉，窗口外停）
const PENDING_RETRY_BASE_MS = 5_000;           // 补拉退避基数（≈ core 5s 扫描 TTL）
const PENDING_RETRY_MAX_MS = 80_000;           // 退避上限
let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRetryCount = 0; // 当前补拉链已发次数（退避指数；链结束/转正后归零）

function schedulePendingRetry() {
  if (pendingRetryTimer) return;
  const delay = Math.min(PENDING_RETRY_BASE_MS * 2 ** pendingRetryCount, PENDING_RETRY_MAX_MS);
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null;
    pendingRetryCount += 1;
    // force（跳过 3s 节流）+ refresh=1（绕过服务端 5s 扫描缓存）——等落盘专用
    void refreshSessions({ force: true, refresh: true });
  }, delay);
}

/** 全部转正/清理 → 结束补拉链（清定时器 + 计数归零，供下次新链从头退避）。 */
function stopPendingRetryChain() {
  if (pendingRetryTimer) { clearTimeout(pendingRetryTimer); pendingRetryTimer = null; }
  pendingRetryCount = 0;
}

/** 观察到一个未落盘会话（内存态 id 不在 live/archived 列表）→ 记入 pending drafts。
 *  幂等：同 id 只更新快照，不重复计数/不重复 emit。 */
export function noteDraftSession(s: SessionInfo): void {
  // 首拉未落地前不评估：此时列表为空不代表会话不存在。跳过后 dock 的观察
  // effect 会在 store.sessions 引用变化（首拉落地 emit）时重跑再评估。
  if (!sessionsLoadedOnce) return;
  const id = String(s.id);
  if (!id) return;
  const snapshot = { ...s, transient: true } as SessionInfo;
  const existsIdx = store.pendingDrafts.findIndex((p) => String(p.session.id) === id);
  if (existsIdx >= 0) {
    store.pendingDrafts[existsIdx] = { session: snapshot, notedAt: store.pendingDrafts[existsIdx].notedAt };
    return;
  }
  store.pendingDrafts = [...store.pendingDrafts, { session: snapshot, notedAt: Date.now() }];
  emit();
  if (!(store.sessions ?? []).some((x) => String(x.id) === id)) {
    if (store.pendingDrafts.length === 1) pendingRetryCount = 0; // 新链从头退避
    schedulePendingRetry(); // 列表尚无此会话 → 等落盘（去重由 schedule 保证）
  }
}

/** 主动移除（如宿主删除会话回调；draft 行本身无删除入口，防御性收口）。 */
export function removePendingDraft(id: string): void {
  const before = store.pendingDrafts.length;
  store.pendingDrafts = store.pendingDrafts.filter((p) => String(p.session.id) !== id);
  if (store.pendingDrafts.length !== before) emit();
  if (store.pendingDrafts.length === 0) stopPendingRetryChain();
}

/** A03/B4：omp 换绑帧（topic `aiti-omp-agent:rebind`，载荷 {from,to}）——占位 id 的
 *  草稿行让位于真实会话行（后者由 sync 正常收录，无需迁移）。帧 type 自过滤。 */
export function onOmpRebindFrame(frame: Record<string, unknown>): void {
  if (frame.type !== "aiti-omp-agent:rebind") return;
  const from = String(frame.from ?? "");
  if (from) removePendingDraft(from);
}

/** 每次列表落地后调用：已落盘（id 进 live 列表）→ 移出转正；超 TTL → 清理。
 *  落盘等待窗口内仍有未落盘 → 安排一次带 refresh=1 的补拉（有界）。 */
// 首拉是否已落地：noteDraftSession 的前提判据——列表未加载过时「不在列表」
// 无法证明「未落盘」，误记会触发无谓的 refresh=1 补拉链（首载风暴推手之一）。
let sessionsLoadedOnce = false;

function reconcilePendingDrafts(now = Date.now()): void {
  const liveIds = new Set((store.sessions ?? []).map((s) => String(s.id)));
  // 归档桶同查：选中归档会话打开页面 → 永不进 live 桶 → 旧实现误判「未落盘」
  // → 155s 窗口内指数退避补拉全量 refresh=1（每次 ~221KB）首载连打 5-6 次。
  const archIds = new Set((store.archived ?? []).map((s) => String(s.id)));
  const next = store.pendingDrafts.filter(
    (p) => !liveIds.has(String(p.session.id)) && !archIds.has(String(p.session.id))
      && now - p.notedAt < PENDING_DRAFT_TTL_MS,
  );
  const changed = next.length !== store.pendingDrafts.length;
  store.pendingDrafts = next;
  if (next.length === 0) {
    stopPendingRetryChain(); // 全部转正/清理：结束补拉链
  } else if (next.some((p) => now - p.notedAt < PENDING_DRAFT_RETRY_WINDOW_MS)) {
    schedulePendingRetry();
  }
  if (changed) emit();
}

/** 跨 tab「新会话创建」帧处理（服务端 sm:session-created：rpc-manager 全新本地会话
 *  启动成功后 publish，SSE 直达所有 tab）：记 pendingDraft 草稿行，复用现有有界
 *  补拉链兜底落盘转正。解决别 tab/服务端直建（ai-helper invoke/急救 AI/定时任务/
 *  ACP 桥）的新会话在本 tab 列表长期不出现——此前列表刷新只能靠 running 帧间接
 *  带动，而 start 帧时 jsonl 未落盘、stop 帧又受 3s 节流 + 5s 扫描缓存影响，
 *  快速任务两帧都拉空。
 *  幂等：已在 live/archived 桶（本 tab 自己新建，宿主 refreshKey 已覆盖）或已在
 *  草稿桶（补拉链已在跑）都跳过；首拉未落地时 noteDraftSession 内部判据跳过
 *  ——随后首拉会列出已落盘行，未落盘窗口极小可接受。 */
export function onSessionCreatedFrame(frame: Record<string, unknown>) {
  if (!frame || frame.type !== "sm:session-created") return;
  const id = typeof frame.sessionId === "string" ? frame.sessionId : "";
  if (!id) return;
  const cwd = typeof frame.cwd === "string" ? frame.cwd : "";
  if ((store.sessions ?? []).some((x) => String(x.id) === id)) return;
  if ((store.archived ?? []).some((x) => String(x.id) === id)) return;
  if ((store.pendingDrafts ?? []).some((p) => String(p.session.id) === id)) return;
  noteDraftSession({
    path: "",
    id,
    cwd,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: 0,
    firstMessage: "",
  } as SessionInfo);
}

/** 跨 tab「会话活动」帧处理（服务端 sm:session-activity：agent message_end 落盘后广播，
 *  按会话 3s 节流）：会话持续运行期间的消息数/modified 增长此前不触发任何刷新（列表
 *  刷新只由 running 集变化带动）→ 行数据冻结在「开始运行那一刻」（2026-09-14 实测：行
 *  显示 34 条/19 小时前，实际该会话已 300+ 条、正在跑）。这里收到帧即走既有增量刷新
 *  通道（since=rev patch + 3s 节流 + 并发合流）。
 *  数据帧（2026-09-15）：服务端随帧下发行数据（row）→ 这里直接 patch store，零请求；
 *  帧无 row（旧服务端/服务端行缓存未命中）才回退增量刷新。
 *  背景：首版信号帧「广播了还要刷新」——每帧一次列表拉取 × 每个客户端；数据帧把
 *  行数据随帧下发，客户端不再回源。 */
export function onSessionActivityFrame(frame: Record<string, unknown>) {
  if (!frame || frame.type !== "sm:session-activity") return;
  const id = typeof frame.sessionId === "string" ? frame.sessionId : "";
  if (!id) return;
  // 会话不在列表（无行可刷；如 TUI 桥独占的嵌套 fork 子代理）→ 跳过。
  // 新会话的「出现」由 sm:session-created 草稿行通道负责，不在此代偿。
  const known = ((store.sessions ?? []) as Record<string, unknown>[]).some((x) => String(x.id) === id)
    || ((store.archived ?? []) as Record<string, unknown>[]).some((x) => String(x.id) === id);
  if (!known) return;
  // 数据帧（2026-09-15）：行数据随帧下发 → 直接 patch store，零请求。
  // 帧无 row（旧服务端/服务端行缓存未命中）→ 回退既有增量刷新。
  const row = frame.row as Record<string, unknown> | undefined;
  if (row && typeof row === "object" && String(row.id) === id) {
    applyActivityRow(row);
    return;
  }
  void refreshSessions();
}

/** 活动数据帧的单行落地：替换所在桶（archived 位自描述，跨桶则移桶），保持
 *  「行数据即最新」语义；乐观改名保护复用 reconcileLocalNames。
 *  注意：不推进 sessionsRev/sessionsEtag——数据帧不是服务端列表 rev 的凭据，
 *  后续增量拉取仍按既有 rev 对齐（可能重复带上本行，patch 替换幂等无害）。 */
function applyActivityRow(row: Record<string, unknown>): void {
  const id = String(row.id);
  const byId = new Map(((store.sessions ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
  const archById = new Map(((store.archived ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
  if (row.archived) { byId.delete(id); archById.set(id, row); }
  else { archById.delete(id); byId.set(id, row); }
  store.sessions = [...byId.values()] as any[];
  store.archived = [...archById.values()] as any[];
  reconcileLocalNames(); // 乐观改名套回（防在途旧名广播盖回；与 refreshSessions 同 stance）
  emit();
}

let sessionsEtag = "";
let sessionsRev = ""; // 增量同步凭据（服务端全局 rev = etag 裸值；payload 方案 §9）

/**
 * [通道拆分] workspace 列表刷新（轻量项目级聚合端点）。
 * unreadIds：客户端未读 session id 集合（项目红点精确计数；变化时由调用方重拉）。
 * 独立 in-flight 单飞 + 5s 节流（落地后）；ETag 304 幂等；失败 keep-last 并作废 ETag
 * （keep-last 只保「已有数据不被清空」，不保「一次失败后不再重试」——见下方 etag 注释）。
 */
const WORKSPACES_MIN_INTERVAL_MS = 5000;
let workspacesInFlight: Promise<void> | null = null;
let workspacesLastAt = 0;
let workspacesEtag = "";
/** 通道是否已成功落地过一次（空数组也算）。节流凭据（不能用 length>0——真·零项目会退化成
 *  每次渲染都发请求）+ 下拉据此区分「还在拉」与「真的没有项目」。 */
let workspacesLanded = false;
export function isWorkspacesLanded(): boolean {
  return workspacesLanded;
}
export async function refreshWorkspaces(unreadIds?: Set<string>, force = false): Promise<void> {
  if (workspacesInFlight) return workspacesInFlight;
  const since = Date.now() - workspacesLastAt;
  if (!force && workspacesLanded && since < WORKSPACES_MIN_INTERVAL_MS) return;
  workspacesInFlight = (async () => {
    try {
      const unreadParam = unreadIds && unreadIds.size > 0 ? [...unreadIds].join(",") : "";
      const url = apiUrl("/api/extensions/session-manager/workspaces" + (unreadParam ? `?unread=${encodeURIComponent(unreadParam)}` : ""));
      // etag 是「客户端已持有这份数据」的凭据；force（下拉打开补拉 / 刷新按钮）用途正是
      // 从「数据没落地」中恢复，照发必被 304 挡回、store 永远空着（手机端一次中断的请求
      // 即可触发，且点刷新也救不回来）——force 一律无条件重拉。
      const headers = !force && workspacesEtag ? { "if-none-match": workspacesEtag } : undefined;
      const res = await fetch(url, { headers });
      if (res.status === 304) { workspacesLanded = true; return; }
      if (!res.ok) { workspacesEtag = ""; return; }
      const d = await res.json() as { rev?: string; workspaces?: WorkspaceEntry[] };
      // 载荷不可用（代理返回 HTML / 响应体截断 / 字段漂移）：作废 etag 让下次无条件重拉，
      // 绝不在应用前 adopt——否则「拿不到数据却持有其 etag」= 之后每轮都 304，永久空列表。
      if (!Array.isArray(d.workspaces)) { workspacesEtag = ""; return; }
      store.workspaces = d.workspaces;
      workspacesEtag = res.headers.get("etag") ?? "";
      workspacesLanded = true;
      emit();
    } catch { workspacesEtag = ""; /* keep last */ } finally {
      workspacesLastAt = Date.now();
      workspacesInFlight = null;
    }
  })();
  return workspacesInFlight;
}

/**
 * [通道拆分] 当前 workspace 会话列表的**目标 key**：最近一次 refreshProjectSessions 的入参。
 * 两个用途（2026-09-18 跨 workspace 卡死修复，见
 * docs/pi-web-session-manager-scoped-workspace-channel-fix-plan.md）：
 *   1. 响应落地守卫——k !== target 的迟到/乱序响应一律丢弃，不覆盖新项目的行；
 *   2. 刷新按钮（sidebar-content doRefresh）以它为准——原先用 store.projectSessionsKey
 *      （上次成功落地值），切项目失败时会停留在旧 key，点刷新刷错 workspace。
 */
let projectSessionsTarget = "";
export function getProjectSessionsTarget(): string {
  return projectSessionsTarget;
}

/**
 * [通道拆分] 当前 workspace 会话列表是否已就绪：驻留行（store.projectSessions）属于该 key。
 * 单一事实源 = store.projectSessionsKey（原独立 module 单槽与行可能不同步——切项目
 * 失败时行是 A、标记却是 B 或反之，loading 门控失真）。
 */
export function isProjectSessionsLoaded(key: string): boolean {
  return key !== "" && store.projectSessionsKey === key;
}

/**
 * [通道拆分] 当前 workspace 的会话列表刷新（scoped /sessions?project=<key>）。
 * 只写 live 桶（不动 store.archived——归档视图仍由全量通道负责）；服务端 scoped 不做
 * patch（永远回全量 scoped），客户端也不发 since（仅 If-None-Match 304）。
 *
 * 按 key 治理（2026-09-18 修复跨 workspace 卡死）：
 *   · in-flight 按 key 分开（Map）：同 key 合流防重复请求；**异 key 并行发出**——原单槽
 *     in-flight 不校验 key，A 在飞时切 B 的刷新被直接 return 吞掉，B 永不发请求、
 *     Loading 常驻（用户实测「不强制刷新不显示 session list」）。
 *   · ETag 按 key 分开，且仅当驻留行就是本 key（store.projectSessionsKey === key）时
 *     才作为 If-None-Match 发出——跨 key 复用会拿 A 的 etag 问 B，304 时提前 return
 *     不写行不打已加载标记 → 死锁。
 *   · 响应落地守卫：k !== projectSessionsTarget（已有更新的目标）→ 丢弃。
 * 失败 keep-last 不 throw（与全量通道同 stance）。
 */
const projectSessionsInFlight = new Map<string, Promise<void>>();
const projectSessionsEtagByKey = new Map<string, string>();
export async function refreshProjectSessions(key: string, opts: { refresh?: boolean } = {}): Promise<void> {
  const k = String(key ?? "");
  if (!k) return;
  projectSessionsTarget = k; // 最新目标；旧 key 的在途响应据此作废
  const existing = projectSessionsInFlight.get(k);
  if (existing) return existing; // 仅同 key 合流（异 key 不吞，各自发出）
  const refresh = opts?.refresh === true;
  const url = apiUrl("/api/extensions/session-manager/sessions?fmt=2&project=" + encodeURIComponent(k)
    + (refresh ? "&refresh=1" : ""));
  // If-None-Match 仅当驻留行就是本 key（行与 etag 同源；跨 key 304 死锁根因）
  const etag = !refresh && store.projectSessionsKey === k ? projectSessionsEtagByKey.get(k) : undefined;
  const req = (async () => {
    try {
      const res = await fetch(url, { headers: etag ? { "if-none-match": etag } : undefined });
      if (res.status === 304) {
        // 只可能发生在驻留行同 key（etag 发送条件）——行保持，仅记 etag
        const next = res.headers.get("etag");
        if (next) projectSessionsEtagByKey.set(k, next);
        return;
      }
      if (!res.ok) return;
      const d = await res.json() as { fmt?: number; cwds?: unknown; sessions?: unknown; rev?: string };
      const v2cwds = d.fmt === 2 && Array.isArray(d.cwds) ? d.cwds as string[] : null;
      if (d.fmt === 2 && !v2cwds) return; // 坏响应防御（与全量通道同 stance）
      if (k !== projectSessionsTarget) return; // 已切目标：丢弃迟到响应，不覆盖新行
      const decoded = (decodeSessionsPayload(d) ?? []) as any[];
      store.projectSessions = decoded;
      store.projectSessionsKey = k;
      reconcileLocalNames("scoped"); // 乐观改名套回（dock 渲染本源；只套本桶，不 purge）
      const nextEtag = res.headers.get("etag");
      if (nextEtag) projectSessionsEtagByKey.set(k, nextEtag);
      emit();
    } catch { /* keep last */ } finally {
      if (projectSessionsInFlight.get(k) === req) projectSessionsInFlight.delete(k);
    }
  })();
  projectSessionsInFlight.set(k, req);
  return req;
}

/**
 * [通道拆分] 列表写操作（归档/移除/删除/恢复/移动）后的统一对齐：全量通道（面板/看板/
 * 宿主 catalog）+ 当前项目 scoped 通道。侧栏 dock 渲染的是 store.projectSessions，
 * 只有 refreshProjectSessions 会写它——只刷全量则被移除的行留在左栏，直到切项目或手动
 * 刷新才消失（2026-09-22 归档/「从列表移除」残留），而且行的 pending 置灰会随全量
 * 落地被 prune 清掉，看起来像「点了没反应」。scoped 未拉过（dock 未挂载 → target 空）
 * 则跳过；notifySessionsChanged 让宿主侧栏绕开 5s 列表缓存重取。
 * 只补刷当前目标一桶就够：移动/归档的目的地若不是当前显示项目，用户切过去时 dock 的
 * selectedProject.key effect 必重拉（且 etag 由含行 id 的 rowRevs 算出，移入即变指纹）。
 */
export function refreshListChannels(opts: { force?: boolean; refresh?: boolean } = { force: true }) {
  void refreshSessions(opts);
  const key = projectSessionsTarget;
  if (key) void refreshProjectSessions(key, { refresh: opts.refresh });
  notifySessionsChanged();
}

// 并发合流 + 最小间隔节流：refreshSessions 的调用方很多（面板打开/挂载/每个用户
// 操作/running SSE 每帧），且列表指纹含 modified/lastMessage——有会话流式时指纹
// 必变，304 打不中，每次都是全量 ~186KB。突发触发必须合并；trailing 补拉保最终一致。
const SESSIONS_MIN_INTERVAL_MS = 3000;
let sessionsInFlight: Promise<void> | null = null;
let sessionsForceChain: Promise<void> | null = null; // force 合流：并发 force 共享一次补拉
let sessionsForceRefreshQueued = false;              // 待发补拉是否需 refresh=1（任一 refresh 调用置位）
let sessionsLastFetchAt = 0;
let sessionsTrailingTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * force：显式用户动作（归档/恢复/删除/移动）后跳过 3s 节流立即拉——
 * 不跳则归档后最多延迟 3s+trailing 才消失，看起来像「没生效」（dock 归档残留事故 UX 加固）。
 * refresh：请求带 ?refresh=1，服务端绕过 core 5s 扫描缓存强制重扫（新会话刚落盘、等转正）。
 * 若有在途请求：等它落地再拉（在途数据不含刚完成的变更）；非 force 保持合流语义。
 */
export async function refreshSessions(opts?: { force?: boolean; refresh?: boolean }): Promise<void> {
  const refresh = opts?.refresh === true;
  // refresh 必达：等落盘关键路径，跳过 3s 节流与合流（否则 trailing 补拉会丢 refresh 标志）。
  const force = opts?.force === true || refresh;
  if (refresh) sessionsForceRefreshQueued = true;
  if (sessionsInFlight) {
    if (!force) return sessionsInFlight;
    // force 必达：等在飞请求落地后补拉一次；并发多个 force 共享同一次补拉。
    // 旧实现每个 force 各自 await 后再各自发——N 个并发 force = N 个串行全量
    // 请求（首载 fmt=2&refresh=1 ×6 风暴的直接根源：dock 挂载两 effect + 补拉链）。
    if (!sessionsForceChain) {
      const wantRefresh = sessionsForceRefreshQueued;
      sessionsForceRefreshQueued = false;
      sessionsForceChain = sessionsInFlight
        .catch(() => { /* keep last */ })
        .then(() => refreshSessionsInner({ refresh: wantRefresh }))
        .finally(() => {
          sessionsForceChain = null;
          sessionsInFlight = null;
          sessionsLastFetchAt = Date.now();
        });
      sessionsInFlight = sessionsForceChain; // 后续普通调用也搭这次补拉
    }
    return sessionsForceChain;
  }
  const since = Date.now() - sessionsLastFetchAt;
  if (!force && since < SESSIONS_MIN_INTERVAL_MS) {
    if (!sessionsTrailingTimer) {
      sessionsTrailingTimer = setTimeout(() => {
        sessionsTrailingTimer = null;
        void refreshSessions();
      }, SESSIONS_MIN_INTERVAL_MS - since);
    }
    return;
  }
  sessionsForceRefreshQueued = false;
  sessionsInFlight = refreshSessionsInner({ refresh }).finally(() => {
    sessionsInFlight = null;
    sessionsLastFetchAt = Date.now();
  });
  return sessionsInFlight;
}
async function refreshSessionsInner(opts?: { refresh?: boolean }): Promise<void> {
  try {
    // Merged live + archived list (extension endpoint); running from core.
    // 增量同步（payload 方案 §9）：带 since=<rev> → 304 / patch {up,rm} / 全量降级。
    // 全量行与 patch 行同构（同源拼装出口），消费方不感知形态。
    // fmt=2：紧凑传输编码（cwd/projectRoot 枚举表 + epoch 时间戳，server/payload.ts）
    // ——decode 在 store 单点还原标准行，dock/面板/看板/回灌零感知。
    // refresh=1：绕过 core 5s 扫描缓存强制重扫（pending draft 等落盘专用）——
    // 此时不带 if-none-match/since（全量最可靠，rev 顺带推进）。
    const refresh = opts?.refresh === true;
    const url = apiUrl("/api/extensions/session-manager/sessions?fmt=2"
      + (refresh ? "&refresh=1" : "")
      + (sessionsRev && !refresh ? `&since=${encodeURIComponent(sessionsRev)}` : ""));
    const [res, runRes] = await Promise.all([
      // dedupeFetch：与宿主 SessionSidebar 兜底快照同窗口合流，避免加载风暴期重复打 running（重复请求分析 §3.1）
      fetch(url, {
        headers: sessionsEtag && !refresh ? { "if-none-match": sessionsEtag } : undefined,
      }),
      dedupeFetch(apiUrl("/api/agent/running"), { cache: "no-store" }),
    ]);
    // 304：列表未变，沿用旧数据（跳过解析/emit/重渲染）
    if (res.status === 304) {
      sessionsLoadedOnce = true;
      sessionsEtag = res.headers.get("etag") ?? sessionsEtag;
      if (runRes.ok) {
        const r = await runRes.json();
        // 快照仅在 SSE 未权威/已静默时落地——避免旧时点快照覆盖 SSE 新运行集
        if (applyRunningSnapshot(r.runningSessionIds ?? [])) emit();
      }
      return;
    }
    if (!res.ok) return;
    sessionsLoadedOnce = true;
    sessionsEtag = res.headers.get("etag") ?? "";
    const d = await res.json();
    // 行数 sanity（**仅全量响应**）：全量行数骤降 >50% 视为服务端残缺集（扫描抖动/
    // 索引窗口）——丢弃（keep last，rev 不推进）→ 下一轮 since=旧 rev，服务端 diff
    // 自动补回缺失行自愈。console.warn 留诊断证据。分母/分子=两桶合并
    //（批量归档是正常操作：行只在桶间移动，合并总数不降）。
    // patch 响应不做此判定：patch 本就是完整 diff（up=rowRev 变化行、rm=消失 id），
    // up 行数天然远小于全量行数；服务端已有 rm>30% 抖动降级全量 + 冷启动 60s 禁
    // patch 保护（api.ts）。曾经把 patch 也算进来 → 每次增量同步都误判「残缺集」
    // 清 rev 触发 738KB 全量重拉（1771 行列表实测复现）。
    const newRows = (d as { sessions?: unknown[] }).sessions;
    const archRowsRaw = (d as { archived?: unknown[] }).archived;
    const isFullPayload = Array.isArray(newRows);
    const incoming = isFullPayload
      ? newRows.length + (Array.isArray(archRowsRaw) ? archRowsRaw.length : 0)
      : 0;
    const prevCount = (store.sessions ?? []).length + (store.archived ?? []).length;
    if (isFullPayload && prevCount > 50 && incoming > 0 && incoming < prevCount * 0.5) {
      console.warn("[sm] sessions 全量行数骤降疑似残缺集，丢弃——prev:", prevCount, "incoming:", incoming,
        "rev:", (d as { rev?: string }).rev);
      return; // 残缺全量：不应用不推进 rev，下轮 since 自动补
    }
    // fmt=2 解码（server/payload.ts）：v2 行 → 标准行；旧形态原样透传。
    const v2cwds = (d as { fmt?: number; cwds?: unknown }).fmt === 2 && Array.isArray((d as { cwds?: unknown }).cwds)
      ? (d as { cwds: string[] }).cwds : null;
    // 坏响应防御：声明 fmt=2 但 cwds 无效（服务端 bug）→ 丢弃本次响应保持旧数据
    //（与 catch keep-last 同 stance），绝不能把紧凑行（cwd=索引数字）透传进 store。
    if ((d as { fmt?: number }).fmt === 2 && !v2cwds) return;
    // 形态判定：patch 是对象 {up, rm}（非数组！曾误用 Array.isArray 致每个增量
    // 响应被当全量、store 被空数组顶掉——列表只剩 draft 自算行，实测翻车）。
    const patchPayload = (d as { patch?: { up?: Record<string, unknown>[]; rm?: string[] } }).patch;
    if (patchPayload && typeof patchPayload === "object" && !Array.isArray(d.sessions)) {
      // patch 形态：up 替换同 id/追加新行，rm 剔除消失行（渲染层自行排序）。
      // up 行自描述（带 archived 位）→ 按位分拣到对应桶，且从另一桶删同 id
      //（归档/恢复=同 id 移桶：dock 的 live 视图即随之增减，无需客户端过滤）。
      const p = d as { rev?: string; patch: { up?: Record<string, unknown>[]; rm?: string[] } };
      if (p.rev) { sessionsRev = p.rev; sessionsEtag = `"${p.rev}"`; }
      const byId = new Map(((store.sessions ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
      const archById = new Map(((store.archived ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
      for (const raw of p.patch.up ?? []) {
        const row = v2cwds ? decodeRowV2(raw, v2cwds) : raw;
        const id = String(row.id);
        if (row.archived) { byId.delete(id); archById.set(id, row); }
        else { archById.delete(id); byId.set(id, row); }
      }
      for (const id of p.patch.rm ?? []) { byId.delete(id); archById.delete(id); }
      store.sessions = [...byId.values()] as any[];
      store.archived = [...archById.values()] as any[];
    } else {
      // 全量形态（首次/降级）——decodeSessionsPayload 对旧形态原样返回 d.sessions；
      // archived 桶独立解码（旧服务端无该字段 → undefined → keep last）。
      sessionsRev = (d as { rev?: string }).rev ?? sessionsRev;
      const decodedLive = (decodeSessionsPayload(d) ?? []) as any[];
      const decodedArch = (decodeArchivedPayload(d) ?? []) as any[];
      // 防御：服务端双桶共存窗口（宿主 core.listSessions 5s 扫描缓存 vs sqlite 已标
      // archived）——归档权威优先，live 桶剔重；否则 dock 全量应用后归档行残留（实测复现）。
      const archIdSet = new Set(decodedArch.map((r) => String(r.id)));
      store.sessions = decodedLive.filter((r) => !archIdSet.has(String(r.id)));
      store.archived = decodedArch;
      // 真归档能力名单只随全量下发（静态属性，patch 不重复带）；旧服务端无此字段
      // → 保留上次值，绝不清空（清空等于对不支持的源重新显示「真归档」）。
      const aa = (d as { archiveAgents?: unknown }).archiveAgents;
      if (Array.isArray(aa)) store.extArchiveAgents = aa.map(String);
    }
    // 列表落地 → 未落盘草稿 reconcile：已落盘转正（移出 pending），窗口内仍缺席则补拉
    prunePendingRemovals();
    reconcilePendingDrafts();
    reconcileLocalNames(); // 乐观改名套回（防在途旧响应盖回；服务端一致即确认清除）
    if (runRes.ok) {
      const r = await runRes.json();
      // 快照门控（同上）：SSE 权威且未静默时跳过，防旧数据覆盖；emit 由下方列表变更统一触发
      applyRunningSnapshot(r.runningSessionIds ?? []);
    }
    emit();
  } catch { /* keep last */ }
}

// 轻量运行计数刷新：只拉 agent/running（~10ms、零字节级），不拉 sessions 全量。
// 供侧边栏/工具栏运行徽标用——它们只需要 running 集合，拉全量列表是浪费。
// 返回是否成功拿到快照（false = 请求/解析失败；调用方据此决定是否标记通道基线）。
export async function refreshRunning(): Promise<boolean> {
  try {
    // dedupeFetch：与 refreshSessionsInner 的并行快照/宿主兜底快照同窗口合流
    const res = await dedupeFetch(apiUrl("/api/agent/running"), { cache: "no-store" });
    if (!res.ok) return false;
    const r = await res.json();
    // 快照门控：SSE 权威且未静默时跳过（兜底轮询不做旧数据覆盖）；仅实际落地才 emit
    if (applyRunningSnapshot(r.runningSessionIds ?? [])) emit();
    return true;
  } catch { return false; /* keep last */ }
}

// 并发合流 + 最小间隔节流：调用点遍布各组件 mount effect（topbar/面板/看板/标签管理器），
// 组件同时挂载会簇发 6-8 连发；与 refreshSessions 同款治理。
// force=true（事件驱动：服务端广播 sm:tags-changed 帧）：跳过节流立即拉（数据真变了），
// 仍保留 in-flight 合流防并发。
const TAGS_MIN_INTERVAL_MS = 3000;
let tagsInFlight: Promise<void> | null = null;
let tagsLastFetchAt = 0;
let tagsTrailingTimer: ReturnType<typeof setTimeout> | null = null;
export async function refreshTags(force = false): Promise<void> {
  if (tagsInFlight) return tagsInFlight;
  const since = Date.now() - tagsLastFetchAt;
  if (!force && since < TAGS_MIN_INTERVAL_MS) {
    if (!tagsTrailingTimer) {
      tagsTrailingTimer = setTimeout(() => {
        tagsTrailingTimer = null;
        void refreshTags();
      }, TAGS_MIN_INTERVAL_MS - since);
    }
    return;
  }
  if (force && tagsTrailingTimer) {
    clearTimeout(tagsTrailingTimer);
    tagsTrailingTimer = null;
  }
  tagsInFlight = refreshTagsInner().finally(() => {
    tagsInFlight = null;
    tagsLastFetchAt = Date.now();
  });
  return tagsInFlight;
}
async function refreshTagsInner(): Promise<void> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/session-tags"));
    if (!res.ok) return;
    store.tagData = await res.json();
    emit();
  } catch { /* keep last */ }
}

/** 懒加载：仅首次真正需要 tag 数据（行胶囊/顶栏 chip/看板列/标签管理器展示）时拉一次。
 *  之后的数据新鲜度由事件驱动（entry.tsx 常驻订阅 sm:tags-changed 帧 → onTagsChangedFrame），
 *  不再因切会话/回前台/打开面板等无关操作重复拉取。tagData 已就绪则静默返回。 */
export function ensureTags(): Promise<void> | undefined {
  if (store.tagData) return undefined;
  return refreshTags(true);
}

/** event-bus 帧处理：仅认 sm:tags-changed；版本与本地一致（本 tab 保存已本地落地）跳过，
 *  否则强制刷新。任何组件卸载都不影响——订阅挂在 entry.tsx register（页面级常驻）。 */
export function onTagsChangedFrame(frame: Record<string, unknown>) {
  if (!frame || frame.type !== "sm:tags-changed") return;
  const ver = frame.version as number | undefined;
  if (typeof ver === "number" && store.tagData?.version === ver) return; // 本地已落地
  void refreshTags(true);
}

/* ── M1: external agent sources ── */

/** Agent 过滤器（面板与未来顶栏共享）：默认只选 pi，外部源选中才显示。 */
const agentFilterState = {
  agents: (() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem("sm.agentFilter") ?? "[\"pi\"]")); }
    catch { return new Set<string>(["pi"]); }
  })(),
  listeners: new Set<() => void>(),
};
function notifyAgentFilter() { try { localStorage.setItem("sm.agentFilter", JSON.stringify([...agentFilterState.agents])); } catch {} for (const l of agentFilterState.listeners) l(); }
export function toggleAgentFilter(agent: string) {
  const has = agentFilterState.agents.has(agent);
  if (has) agentFilterState.agents.delete(agent);
  else agentFilterState.agents.add(agent);
  notifyAgentFilter();
}
/** 激活源后自动选中，避免「加载了却看不到」。 */
export function selectAgent(agent: string) {
  agentFilterState.agents.add(agent);
  notifyAgentFilter();
}
export function useAgentFilter(): Set<string> {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((v) => v + 1);
    agentFilterState.listeners.add(l);
    return () => { agentFilterState.listeners.delete(l); };
  }, []);
  return agentFilterState.agents;
}

/** Refresh the external-source discovery list (cheap stat-level probes). */
export async function refreshSources() {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/sources"), { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json();
    store.sources = d.sources ?? [];
    emit();
  } catch { /* keep last */ }
}

/** Activate / resync an external source; refreshes sessions + sources. */
export async function sourceAction(op: "activate" | "sync", agent: string) {
  try {
    const res = await fetch(apiUrl(`/api/extensions/session-manager/sources/${op}`), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    void refreshSources();
    void refreshSessions({ force: true });
    if (op === "activate") selectAgent(agent); // 新加载的源自动选中
    return d;
  } catch {
    return null;
  }
}

/** Release an external session into a native pi session (returns new pi sessionId). */
export async function importSession(id: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/import"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    void refreshSessions({ force: true });
    return (d.sessionId as string) ?? null;
  } catch {
    return null;
  }
}

/** Result of an open-live attempt (attach-from-history through a backend extension). */
export type OpenLiveResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "no_provider" | "open_failed" | "unknown_agent" | "network"; error?: string };

/**
 * Open an external session as a LIVE driving session via the host's
 * session-provider slot (requires a backend extension for that agent,
 * e.g. aiti-claude-code-agent for "claude:<sid>").
 */
export async function openLiveSession(id: string, cwd?: string): Promise<OpenLiveResult> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/open-live"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...(cwd ? { cwd } : {}) }),
    });
    const d = await res.json().catch(() => ({}));
    if (d?.ok === true && typeof d.sessionId === "string") return { ok: true, sessionId: d.sessionId };
    return { ok: false, reason: d?.reason ?? "open_failed", error: d?.error };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/**
 * Notify pi-web's sidebar that the on-disk session list changed out from
 * under it (archive / archive-delete). SessionSidebar listens for this event
 * and refetches with ?refresh=1 (bypassing the 5s TTL list cache).
 */
export function notifySessionsChanged() {
  try { window.dispatchEvent(new Event("sm:sessions-changed")); } catch { /* non-DOM */ }
}

/**
 * 收集某会话的全部后代子会话 id（subagents / forks：parentSessionId 指向它的所有层级，
 * 含孙级）。返回顺序为叶子优先（深层级在前），供「先子后主」的删除/归档使用。
 * 不入队的 self-loop / 缺失父级容错；外部会话（复合 id）同样按 parentSessionId 归组。
 */
export function collectSubtreeIds(sessions: any[], rootId: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const s of sessions ?? []) {
    const pid = (s as any)?.parentSessionId;
    if (!pid || pid === s.id) continue;
    const arr = byParent.get(pid) ?? [];
    arr.push(s.id);
    byParent.set(pid, arr);
  }
  const result: string[] = [];
  const seen = new Set([rootId]);
  const levels: string[][] = [];
  let frontier = [rootId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of byParent.get(id) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        next.push(c);
      }
    }
    if (next.length) levels.push(next);
    frontier = next;
  }
  for (let i = levels.length - 1; i >= 0; i--) result.push(...levels[i]);
  return result;
}

/** Archive a batch of sessions now (explicit ids — bypasses age/size heuristics). Server skips open (running/alive) ids and reports them in skippedIds. */
export interface ArchiveSessionsResult { ok: boolean; skippedIds: string[]; }
export async function archiveSessions(ids: string[]): Promise<ArchiveSessionsResult> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/archive/run"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    let skipped: string[] = [];
    if (res.ok) {
      // 守卫跳过清单（打开中/运行中/未索引会话）；全被跳过 = 实际没归档任何东西 → 按失败处理
      const d = await res.json().catch(() => ({} as { skippedIds?: string[] }));
      skipped = Array.isArray(d.skippedIds) ? d.skippedIds : [];
      const archivedIds = ids.filter((id) => !skipped.includes(id));
      if (!archivedIds.length) return { ok: false, skippedIds: skipped };
      // 宿主侧边栏监听：归档含当前选中会话时收尾选中态（否则草稿行误判 + 聊天窗留在已归档会话）
      try { window.dispatchEvent(new CustomEvent("sm:sessions-archived", { detail: { ids: archivedIds } })); } catch { /* ignore */ }
    }
    refreshListChannels({ force: true });
    return { ok: res.ok, skippedIds: skipped };
  } catch { return { ok: false, skippedIds: [] }; }
}

/** Archive one session now (explicit id — bypasses age/size heuristics). Server refuses running ids. */
export async function archiveSession(id: string): Promise<ArchiveSessionsResult> {
  return archiveSessions([id]);
}



/** Put an archived session back to its original live path (恢复).
 *  A03 真归档：外部源复合 id（agent:sid）先试 /archive/ext-restore（.pwarc 解出 → putBack
 *  写回源 → 源列表确认）——无包（纯视图移除）时服务端 422，回退既有 pi 恢复/ext unhide 链。 */
export async function restoreSession(id: string) {
  try {
    if (id.includes(":")) {
      const r = await fetch(apiUrl("/api/extensions/session-manager/archive/ext-restore"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      const d = await r.json().catch(() => null);
      if (r.ok && d?.ok) {
        refreshListChannels({ force: true });
        return true;
      }
      // 无包（纯视图移除）→ 回退视图层放回；其余失败（包损坏/查重中止）→ 如实报失败
      if (d && typeof d.error === "string" && !d.error.includes("纯视图移除")) return false;
    }
    const res = await fetch(apiUrl("/api/extensions/session-manager/archive/restore"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    refreshListChannels({ force: true });
    return res.ok;
  } catch { return false; }
}

/** A03 真归档：外部源会话 → .pwarc 快照 → 删源（adapter 需 remove 能力；可 /archive/ext-restore 放回）。 */
export async function archiveExtSession(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/archive/ext-run"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    const d = await res.json().catch(() => null);
    if (res.ok && d?.ok) {
      refreshListChannels({ force: true });
      return { ok: true };
    }
    return { ok: false, error: d?.error || "HTTP " + res.status };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

/** Permanently delete an archived session (archive records only — 先归档才能删除). */
export async function deleteArchivedSession(id: string) {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/archive/delete"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    refreshListChannels({ force: true });
    return res.ok;
  } catch { return false; }
}

/** ext 源行（zcode/cursor 等只读镜像行）「从列表移除」/恢复：视图层归档，源数据不动。 */
export async function hideExtSession(id: string, hidden = true) {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/archive/ext"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, hidden }),
    });
    refreshListChannels({ force: true });
    return res.ok;
  } catch { return false; }
}

/** 相关文档（server 端进程内消费 aiti-doc-center services.docs；available:false = 文档中心缺席）。 */
export async function fetchRelatedDocs(sid: string): Promise<{ available: boolean; docs: any[] }> {
  try {
    const res = await fetch(apiUrl(`/api/extensions/session-manager/related-docs?sessionId=${encodeURIComponent(sid)}`));
    if (!res.ok) return { available: false, docs: [] };
    const d = await res.json().catch(() => ({}));
    return { available: (d as any)?.available !== false, docs: Array.isArray((d as any)?.docs) ? (d as any).docs : [] };
  } catch { return { available: false, docs: [] }; }
}

/** Move a live pi session to another cwd (header rewrite + file relocation server-side).
 *  Returns the error message from the server on failure, null on success. */
export async function moveSession(id: string, cwd: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/move"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, cwd }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return (d as { error?: string }).error ?? `HTTP ${res.status}`;
    refreshListChannels({ force: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Batch-move live pi sessions to another cwd (workspace 删除时「全部移动」选项)。
 * 逐会话复用 move 写路径（server /move-batch），返回 { movedCount, skippedCount }。
 * 运行中/外部 agent/归档记录被跳过并在 skipped 里说明。
 */
export async function moveBatchSession(ids: string[], cwd: string): Promise<{ ok: boolean; movedCount: number; skippedCount: number; error?: string }> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/move-batch"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: ids, cwd }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, movedCount: 0, skippedCount: 0, error: (d as { error?: string }).error ?? `HTTP ${res.status}` };
    refreshListChannels({ force: true });
    return { ok: true, movedCount: (d as { movedCount?: number }).movedCount ?? 0, skippedCount: (d as { skippedCount?: number }).skippedCount ?? 0 };
  } catch (e) {
    return { ok: false, movedCount: 0, skippedCount: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 识别一个会话的真实 CWD —— 依据它操作过的文件推断最可能的项目目录（server /session-cwd）。
 * 返回 { current, candidates: [{root,count,weighted}], suggest }。失败返回 null。
 */
export interface SessionCwdResult { current: string; candidates: Array<{ root: string; count: number; weighted: number }>; suggest: string; }
export async function detectSessionCwd(id: string): Promise<SessionCwdResult | null> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/session-cwd"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return (d as SessionCwdResult) ?? null;
  } catch { return null; }
}

/** 归档一批会话（workspace 删除时「全部归档」选项；server 拒绝运行中 id）。
 *  skipped = 被守卫跳过（打开/运行中/未索引）的会话数——提示区分「部分跳过」而非笼统失败。 */
export async function archiveBatchSession(ids: string[]): Promise<{ ok: boolean; archived: number; skipped: number }> {
  try {
    const res = await fetch(apiUrl("/api/extensions/session-manager/archive/run"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, archived: 0, skipped: 0 };
    refreshListChannels({ force: true });
    const skipped = Array.isArray((d as { skippedIds?: string[] }).skippedIds) ? (d as { skippedIds: string[] }).skippedIds.length : 0;
    return { ok: true, archived: (d as { archived?: number }).archived ?? 0, skipped };
  } catch {
    return { ok: false, archived: 0, skipped: 0 };
  }
}

/** Permanently delete a LIVE session file (core DELETE：级联重挂子会话 + 停 rpc + 删文件)。
 *  Returns the error message from the server on failure, null on success. */
export async function deleteLiveSession(id: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(id)}`), { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return (d as { error?: string }).error ?? `HTTP ${res.status}`;
    refreshListChannels({ force: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** POST an action; handles the optimistic-lock 409 by re-fetching + retrying once. */
export async function act(name: string, payload?: Record<string, unknown>) {
  // Retry a few times: concurrent tabs all race on the same optimistic version
  // — only the first wins, the rest get 409 and re-fetch + retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = store.tagData ?? { version: 0 };
    try {
      const res = await fetch(apiUrl(`/api/extensions/session-manager/${name}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: t0.version, ...payload }),
      });
      if (res.status === 409) { await refreshTags(); continue; }
      if (res.ok) {
        const d = await res.json();
        store.tagData = d.data;
        emit();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  await refreshTags();
  return false;
}

/** Whole-file PUT (used by the picker's create-new flow). */
export async function actPut(next: unknown) {
  const res = await fetch(apiUrl("/api/extensions/session-manager/session-tags"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(next),
  });
  if (res.ok) { const d = await res.json(); store.tagData = d.data; emit(); return true; }
  await refreshTags();
  return false;
}

/* ── 置顶（固定 tag「📌 置顶」承载；方案 docs/session-manager-sidebar-dock-pin-plan.md） ──
 *  多设备共享：置顶 = 给会话打固定 tag，服务端 tags 持久化；取 tagData 时置顶集合同车。
 *  已知限制：用户改名/删除该 tag → 置顶失联，改回原名或重新置顶（自动重建）即恢复。 */
const PIN_MARKER_SESSION = "__sm_pin";

/** 确保固定置顶 tag 存在，返回其 id；失败返回 null（tag 数据未就绪先加载）。
 *  tag 被删后再次置顶自动重建（assign 按路径创建节点 + 清理 marker 映射，同 tag-manager 两步法）。 */
export async function ensurePinTag(): Promise<string | null> {
  let data = store.tagData;
  if (!data) await ensureTags();
  data = store.tagData;
  const existing = findPinTagId(data);
  if (existing) return existing;
  const ok = await act("assign", { sessionId: PIN_MARKER_SESSION, path: PIN_TAG_NAME });
  if (!ok) return null;
  const d = store.tagData;
  if (d && d.sessionTags?.[PIN_MARKER_SESSION]) {
    const next = { ...d, sessionTags: { ...d.sessionTags } };
    delete next.sessionTags[PIN_MARKER_SESSION];
    await actPut(next);
  }
  return findPinTagId(store.tagData);
}

/** 置顶/取消置顶：pinned → unassign；否则 ensurePinTag 后 assignTag。
 *  act 成功内部 emit → dock useStore 订阅自动重排列表。 */
export async function togglePinSession(id: string): Promise<void> {
  const data = store.tagData;
  const pinId = findPinTagId(data);
  const pinned = pinId ? isSessionPinned(data, id) : false;
  if (pinned) {
    await act("unassign", { sessionId: id, tagId: pinId });
  } else {
    const tagId = pinId ?? (await ensurePinTag());
    if (tagId) await act("assignTag", { sessionId: id, tagId });
  }
}

/* ── 项目钉住（favoriteIds 的 "ws:" 命名空间；方案 docs/session-manager-project-pin-order-plan.md） ──
 *  与会话收藏同池共存：钉住项是 `"ws:<projectKey>"`，数组相对顺序 = 钉内展示顺序。
 *  多设备共享（同 tagData 通道，sm:tags-changed 帧驱动刷新），零新增服务端 API。 */

/**
 * favoriteIds 读改写：409（并发端抢先）→ 强刷 tagData → 用最新数据重算目标序 → 重试。
 * recompute 收旧数组返新数组（null = 无事可做，直接结束）；顺序调整是 read-modify-write，
 * 多端同时 ↑↓ 必撞 409，不重试表现为「按了没反应」（不损数据）。
 */
async function putFavoriteIds(
  recompute: (favoriteIds: string[]) => string[] | null,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!store.tagData) await ensureTags();
    const base = (store.tagData ?? EMPTY_TAGS).favoriteIds as string[];
    const next = recompute(base);
    if (!next) return false;
    if (await actPut({ ...(store.tagData ?? EMPTY_TAGS), favoriteIds: next })) return true;
    await refreshTags(true); // actPut 内部已刷新（可能被节流）；强制拉最新再重算
  }
  return false;
}

/** 钉住/取消钉住项目（已处于目标态则静默返回，不空转 version）。 */
export async function setProjectPinned(key: string, on: boolean): Promise<void> {
  if (!store.tagData) await ensureTags();
  if (isProjectPinned(store.tagData, key) === on) return;
  await act(on ? "favorite" : "unfavorite", { sessionId: projectPinId(key) });
}

export async function togglePinProject(key: string): Promise<void> {
  if (!store.tagData) await ensureTags();
  await setProjectPinned(key, !isProjectPinned(store.tagData, key));
}

/** 项目被删除/搬空后的清钉（未钉则无事可做）。 */
export async function unpinProject(key: string): Promise<void> {
  await setProjectPinned(key, false);
}

/** 钉段内上移（delta=-1）/下移（delta=+1）；未钉或已到边界返回 false。 */
export async function movePinnedProject(key: string, delta: number): Promise<boolean> {
  return putFavoriteIds((ids) => reorderPinnedFavorites(ids, key, delta));
}

/* ── 弹窗开关 flags + 跨组件待消费状态 ── */
export function makeFlag() {
  return {
    value: false,
    subs: new Set<() => void>(),
    onOpen() { this.value = true; for (const l of this.subs) l(); },
    onClose() { this.value = false; for (const l of this.subs) l(); },
  };
}
export const panelOpen = makeFlag();
// dock 状态机收口（aiti-web-ext-float-dock-plan §3.4 模式①）：入口写 onOpen/onClose
// 时转发 dock present（浮窗 ⇱ / 侧栏嵌入共享同一状态机）；渲染开关已由 useGate 接管
// （entry.tsx 双 face），flag.value 仅遗留读取不再驱动渲染。
panelOpen.onOpen = function () { presentDock("session-manager:panel", "open"); };
panelOpen.onClose = function () { presentDock("session-manager:panel", "close"); };
/** 点开会话后面板是否让位：仅小屏全屏浮窗（aiti-float data-ext-float-full 同款断点）
 *  会铺满视口盖住刚打开的会话/查看器，此时才收起；桌面浮窗与右栏停靠不遮挡 →
 *  面板保持打开，可连续点选会话。 */
export function collapsePanelIfCovering() {
  if (presentState("session-manager:panel") !== "floating") return;
  let fullscreen = false;
  try { fullscreen = window.matchMedia("(max-width: 640px)").matches; } catch { /* 非 DOM 环境 */ }
  if (fullscreen) panelOpen.onClose();
}
export const managerOpen = makeFlag();
export const kanbanOpen = makeFlag();
// 顶栏搜索框 → 全部会话面板的待消费查询词（提交时设置，面板打开时注入）
export let pendingSearch = "";
export function setPendingSearch(q: string) { pendingSearch = q; }
export function consumePendingSearch(): string {
  const q = pendingSearch;
  pendingSearch = "";
  return q;
}

/* home dir for ~ display — fetched once from core /api/home (not hardcoded).
   惰性触发：模块顶层 fetch 会早于宿主 register(ctx) 执行，apiUrl 拿不到 basePath
   （子路径部署如 /win 下会打到根路径 404）。首次 displayCwd 渲染时才拉，
   一次尝试，失败回退完整路径展示。 */
let homeDir: string | null = null;
let homeTried = false;
function ensureHomeDir(): void {
  if (homeTried) return;
  homeTried = true;
  // 优先宿主共享服务 pi-web.home（lib/home-dir 单例：宿主 + 全部扩展一次请求）；
  // 旧宿主/服务缺席 → 回退自拉（dedupeFetch 兜同窗口重复）。
  const svc = getExtService<{ ensure: () => Promise<string | null> }>("pi-web.home");
  const p = svc?.ensure
    ? svc.ensure()
    : dedupeFetch(apiUrl("/api/home")).then((r) => r.json()).then((d: any) => (d?.home as string) ?? null).catch(() => null);
  void p.then((dir) => { if (dir) homeDir = dir; }).catch(() => {});
}
export function displayCwd(cwd: string) {
  ensureHomeDir();
  if (homeDir && cwd.startsWith(homeDir)) return "~" + cwd.slice(homeDir.length);
  return cwd;
}

/* ---- §3.4 pending 持久化：新会话 tag 只存 state 会在刷新/重挂载时丢
   （标签既没附到 session 也没附到新 session）——落 localStorage（按 cwd 分组），
   会话创建（含刷新恢复）后合并到真实 sessionId，全部成功才清存储。 */
const PENDING_TAGS_KEY = "sm.pendingTags.v1"; // { [cwd]: string[] }
export function loadPendingMap(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(PENDING_TAGS_KEY) || "{}") || {}; } catch { return {}; }
}
export function savePendingMap(map: Record<string, string[]>) {
  try { localStorage.setItem(PENDING_TAGS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}


/* ── 查看器会话 id 状态（薄壳拆分 §5.1 自 sessions-panel.tsx 收编 eager 侧）──
 * 归档/外部会话查看器的「看哪个会话」状态是跨 chunk 公共数据：kanban（lazy）行点击、
 * entry 的 sm:open-archived 事件通道都要 openViewer，不依赖面板 chunk 是否已加载。
 * 查看器 UI 本体仍在 sessions-panel（懒 chunk），经本状态 + dock 状态机门控渲染。 */
export const SM_PANEL_KEY = "session-manager:panel";
export const ARCHIVED_VIEWER_KEY = "session-manager:archived-viewer";
const viewerState = { sessionId: null as string | null, subs: new Set<() => void>() };
export function openViewer(id: string) {
  viewerState.sessionId = id;
  for (const l of viewerState.subs) l();
  openFloat(ARCHIVED_VIEWER_KEY);
}
export function closeViewer() {
  viewerState.sessionId = null;
  for (const l of viewerState.subs) l();
  closePanel(ARCHIVED_VIEWER_KEY);
}
export function viewerSessionId(): string | null { return viewerState.sessionId; }
export function subscribeViewerSession(fn: () => void): () => void {
  viewerState.subs.add(fn);
  return () => { viewerState.subs.delete(fn); };
}

export const EXT_VIEWER_KEY = "session-manager:ext-viewer";
const extViewerState = { id: null as string | null, subs: new Set<() => void>() };
export function openExtViewer(id: string) {
  extViewerState.id = id;
  for (const l of extViewerState.subs) l();
  openFloat(EXT_VIEWER_KEY);
}
export function closeExtViewer() {
  extViewerState.id = null;
  for (const l of extViewerState.subs) l();
  closePanel(EXT_VIEWER_KEY);
}
export function extViewerId(): string | null { return extViewerState.id; }
export function subscribeExtViewer(fn: () => void): () => void {
  extViewerState.subs.add(fn);
  return () => { extViewerState.subs.delete(fn); };
}

/** flag（makeFlag 产物）的 React 订阅 hook：懒包装门控用（TagManager/KanbanPage 常挂
 *  pages/dialogs 插槽的 gate）。 */
export function useFlag(flag: { value: boolean; subs: Set<() => void> }): boolean {
  const [v, setV] = useState(flag.value);
  useEffect(() => {
    const l = () => setV(flag.value);
    flag.subs.add(l);
    return () => { flag.subs.delete(l); };
  }, [flag]);
  return v;
}
