/**
 * aiti-helper · 结果状态机（纯逻辑，可单测；方案 docs/aiti-helper-result-event-bus-plan.md）
 *
 * 职责边界：
 *   - 本模块只管「一轮 helper invoke 的状态与快照语义」，不做 IO、不发帧、不读写历史；
 *   - index.ts 接线：hook → store；store 回调 onGraceExpire → 发 `result{ok:false}` 帧；
 *     客户端经总线 `helper-<sid>` 主题收 `result{ok:true}` 帧（带全文），HTTP /result 仅做快照。
 *
 * 为什么需要它：
 *   历史实现用「deferred + /result 长等待（long-poll）」交付结果，被 nginx 默认 60s
 *   proxy_read_timeout 掐成 504 + HTML → 弹窗「取结果失败」而会话仍在跑（2026-09-18 事故）。
 *   现改为 event-bus 推送 + 快照对齐，本模块是该改造的可测内核。
 */

export interface InvokeOrigin {
  message: string;
  helperId?: string | null;
  placeholder?: string | null;
  contextLabel?: string | null;
  system?: string | null;
  turn: number;
  model?: string | null;
  sourceSession?: string | null;
  startedAt: number;
}

export interface InvokeEntry {
  origin: InvokeOrigin;
  settled: boolean;
  /** 本轮是否 helper 发起（宿主 onAgentSettled 仅在此为 true 时写历史，防用户直接聊该会话污染） */
  pendingTurn: boolean;
  lastResult?: { text: string; historyId: string };
  /** 终态失败（零产出/模型报错/中止）——/result 快照据此返回 no_result 而不是 running */
  failedError?: string | null;
}

export type Snapshot =
  | { ok: true; text: string; historyId: string | null; turn: number; settled: true }
  | { ok: false; code: "running"; turn: number }
  | { ok: false; code: "no_result"; error: string; turn: number }
  | { ok: false; code: "not_found"; error: string };

/** 宽限：raw agent_settled 到「宿主 dispatchAgentSettled」之间只隔同一次事件分发（毫秒级），
 *  3s 只为跨事件循环边界的极端时序留余量。 */
export const DEFAULT_SETTLE_GRACE_MS = 3000;

export interface ResultStoreOptions {
  graceMs?: number;
  /** 宽限到点且仍未结算 → 已把 entry 标为 failed 后回调（接线方在此发 result 失败帧） */
  onGraceExpire?: (sessionId: string, entry: InvokeEntry) => void;
  /** 计时器注入（测试可替换为假计时器） */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface ResultStore {
  begin(sessionId: string, origin: InvokeOrigin): InvokeEntry;
  get(sessionId: string): InvokeEntry | undefined;
  /** 宿主 onAgentSettled（已产出最终文本）→ 标记结算（调用方先写历史） */
  markSettled(sessionId: string, text: string, historyId: string): InvokeEntry | undefined;
  /** 终态失败（零产出/报错/中止） */
  markFailed(sessionId: string, error: string): InvokeEntry | undefined;
  isPendingHelperTurn(sessionId: string): boolean;
  snapshot(sessionId: string): Snapshot;
  /** 未结算的活动条目（/active 用） */
  listActive(): Array<{ sessionId: string; entry: InvokeEntry }>;
  /** 原始事件 agent_start */
  onAgentStart(sessionId: string): void;
  /** 原始事件 agent_settled：run 结束；仍未结算 → 起宽限计时（防宿主不分发 onAgentSettled 时永挂） */
  onAgentSettled(sessionId: string): void;
  /** 会话销毁/回收：已结算条目保留（快照/恢复仍可用），未结算条目删除；返回保留的条目 */
  endSession(sessionId: string): InvokeEntry | undefined;
  isRunActive(sessionId: string): boolean;
  /** 扩展卸载：清全部计时器与状态 */
  dispose(): void;
  size(): number;
}

export function createResultStore(opts: ResultStoreOptions = {}): ResultStore {
  const graceMs = opts.graceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const onGraceExpire = opts.onGraceExpire;

  const active = new Map<string, InvokeEntry>();
  /** run 真实边界账本：agent_start ↔ agent_settled（防 followup 边界把新一轮误判为零产出） */
  const runActive = new Set<string>();
  const graceTimers = new Map<string, unknown>();

  function clearGrace(sessionId: string): void {
    const t = graceTimers.get(sessionId);
    if (t !== undefined) { clearTimer(t); graceTimers.delete(sessionId); }
  }

  function armGrace(sessionId: string): void {
    clearGrace(sessionId);
    const timer = setTimer(() => {
      graceTimers.delete(sessionId);
      const a = active.get(sessionId);
      if (!a || a.settled) return;        // 正常结算先到（宿主 dispatchAgentSettled 在前）→ 无操作
      if (runActive.has(sessionId)) return; // 新一轮已起跑（followup 边界）→ 不是零产出终态
      markFailed(sessionId, "本轮未产生结果（模型报错或中止）——请重试");
      onGraceExpire?.(sessionId, active.get(sessionId)!);
    }, graceMs);
    (timer as { unref?: () => void } | null)?.unref?.();
    graceTimers.set(sessionId, timer);
  }

  function begin(sessionId: string, origin: InvokeOrigin): InvokeEntry {
    const entry: InvokeEntry = { origin, settled: false, pendingTurn: true };
    active.set(sessionId, entry);
    return entry;
  }

  function markSettled(sessionId: string, text: string, historyId: string): InvokeEntry | undefined {
    clearGrace(sessionId);
    const a = active.get(sessionId);
    if (!a) return undefined;
    a.lastResult = { text, historyId };
    a.settled = true;
    a.pendingTurn = false;
    a.failedError = null;
    return a;
  }

  function markFailed(sessionId: string, error: string): InvokeEntry | undefined {
    clearGrace(sessionId);
    const a = active.get(sessionId);
    if (!a) return undefined;
    a.failedError = error;
    a.settled = true;      // 计入已结算 → /active 不再列为后台任务
    a.pendingTurn = false;
    return a;
  }

  function snapshot(sessionId: string): Snapshot {
    const a = active.get(sessionId);
    if (!a) return { ok: false, code: "not_found", error: "该会话不是 aiti-helper 发起，或已被回收" };
    if (a.settled) {
      if (a.failedError) return { ok: false, code: "no_result", error: a.failedError, turn: a.origin.turn };
      return { ok: true, text: a.lastResult?.text || "", historyId: a.lastResult?.historyId || null, turn: a.origin.turn, settled: true };
    }
    return { ok: false, code: "running", turn: a.origin.turn };
  }

  return {
    begin,
    get: (sessionId) => active.get(sessionId),
    markSettled,
    markFailed,
    isPendingHelperTurn: (sessionId) => !!active.get(sessionId)?.pendingTurn,
    snapshot,
    listActive: () => [...active.entries()].filter(([, a]) => !a.settled).map(([sessionId, entry]) => ({ sessionId, entry })),
    onAgentStart: (sessionId) => {
      runActive.add(sessionId);
      clearGrace(sessionId);
    },
    onAgentSettled: (sessionId) => {
      runActive.delete(sessionId);
      const a = active.get(sessionId);
      if (a && !a.settled) armGrace(sessionId);
    },
    endSession: (sessionId) => {
      clearGrace(sessionId);
      runActive.delete(sessionId);
      const a = active.get(sessionId);
      if (!a) return undefined;
      if (a.settled) return a;             // 已结算：保留（快照/恢复仍可用；/origin history 回落兜底）
      active.delete(sessionId);
      return undefined;
    },
    isRunActive: (sessionId) => runActive.has(sessionId),
    dispose: () => {
      for (const t of graceTimers.values()) clearTimer(t);
      graceTimers.clear();
      runActive.clear();
      active.clear();
    },
    size: () => active.size,
  };
}
