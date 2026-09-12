/**
 * 页面级「当前会话状态」store（统一会话状态服务，2026-09-12 方案
 * docs/pi-web-session-state-and-perf-plan.md §4）。
 *
 * 宿主（AppShell）按 initialNavigation.sessionId / initialSessionRestored /
 * selectedSession 派生快照并 publish；扩展经 `ctx.services` 的
 * `pi-web.session` 服务 `get()/subscribe()` 消费——统一
 * 「resolving（?session= 解析中）/ active（已确立 canonical id）/ none（无会话）」
 * 语义，替代各扩展自行从 URL `?session=` 读取未验证 id 发请求。
 *
 * 同时派发 window 事件 `pi-web:session-state`（detail = 快照；兼容/调试通道，
 * 正式契约走 ctx 服务）。
 *
 * 注册：AppShell 模块顶层 `registerExtClientService("pi-web", "pi-web.session", …)`
 * ——早于任何扩展 client materialize（模块顶层副作用先于 effect 阶段）。
 */

export type PiWebSessionPhase = "resolving" | "active" | "none";

export type PiWebSessionSource =
  | "initial"        // 首帧（无 URL session）
  | "url"            // URL ?session= 解析中 / 解析成功
  | "url-failed"     // URL ?session= 校验失败（404/不存在）
  | "select"         // 用户选择
  | "created"        // 新会话创建完成
  | "fork"           // fork
  | "canonicalized"  // id 规范化（旧 ?session= URL / 占位 id）
  | "deleted"        // 当前会话被删除
  | "cwd-switch"     // 项目/工作区切换导致会话清空
  | "restore";       // 切项目恢复 lastOpenSession

export interface PiWebSessionSummary {
  id: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
}

export interface PiWebSessionSnapshot {
  phase: PiWebSessionPhase;
  /** URL 请求的原始 id（未验证；规范化后保留旧 id 供对照）。无 URL session 时 null */
  requestedId: string | null;
  /** 已验证的 canonical 会话 id（phase=active 时非空） */
  sessionId: string | null;
  /** 会话摘要（active 时） */
  session: PiWebSessionSummary | null;
  source: PiWebSessionSource;
  /** 单调递增修订号（订阅者去重） */
  rev: number;
}

export interface PiWebSessionService {
  get(): PiWebSessionSnapshot;
  /** 订阅状态变化；订阅时立即回调一次当前快照。返回退订函数。 */
  subscribe(cb: (snapshot: PiWebSessionSnapshot) => void): () => void;
}

const INITIAL_SNAPSHOT: PiWebSessionSnapshot = Object.freeze({
  phase: "none",
  requestedId: null,
  sessionId: null,
  session: null,
  source: "initial",
  rev: 0,
});

let snapshot: PiWebSessionSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<(snapshot: PiWebSessionSnapshot) => void>();

/** 当前快照（同步读；服务缺席场景外的直接入口）。 */
export function getSessionSnapshot(): PiWebSessionSnapshot {
  return snapshot;
}

function sameSummary(a: PiWebSessionSummary | null, b: PiWebSessionSummary | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.cwd === b.cwd
    && (a.name ?? "") === (b.name ?? "")
    && (a.firstMessage ?? "") === (b.firstMessage ?? "");
}

/**
 * 发布新快照（rev 自增）。内容与当前一致（phase/requestedId/sessionId/session 摘要）
 * 时跳过——React 每次渲染调用本函数也不会产生重复通知。
 */
export function publishSessionState(next: {
  phase: PiWebSessionPhase;
  requestedId: string | null;
  sessionId: string | null;
  session: PiWebSessionSummary | null;
  source: PiWebSessionSource;
}): void {
  if (
    next.phase === snapshot.phase
    && next.requestedId === snapshot.requestedId
    && next.sessionId === snapshot.sessionId
    && next.source === snapshot.source
    && sameSummary(next.session, snapshot.session)
  ) {
    return;
  }
  snapshot = {
    phase: next.phase,
    requestedId: next.requestedId,
    sessionId: next.sessionId,
    session: next.session,
    source: next.source,
    rev: snapshot.rev + 1,
  };
  for (const cb of [...listeners]) {
    try { cb(snapshot); } catch { /* 订阅方错误不阻断 */ }
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("pi-web:session-state", { detail: snapshot }));
    } catch { /* 非浏览器环境忽略 */ }
  }
}

/** 订阅快照变化；订阅时立即回调一次当前值（快照语义）。返回退订函数。 */
export function subscribeSessionState(cb: (snapshot: PiWebSessionSnapshot) => void): () => void {
  listeners.add(cb);
  try { cb(snapshot); } catch { /* ignore */ }
  return () => { listeners.delete(cb); };
}

/** ctx.services 服务实现（AppShell 注册 key `pi-web.session` 用）。 */
export const piWebSessionService: PiWebSessionService = {
  get: getSessionSnapshot,
  subscribe: subscribeSessionState,
};
