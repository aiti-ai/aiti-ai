/**
 * aiti-plan-first · 新会话「先选方案，创建后自动绑定」pending 存储。
 *
 * 对齐 session-manager §3.4 pending tags 模式（参考其 `sm.pendingTags.v1`）：
 *   - 新会话（尚无 canonical sessionId）时选方案 → 按 cwd 分桶存 localStorage；
 *   - 会话真正创建（宿主下发 session）后把该 cwd 的 pending 绑定到新会话并清空；
 *   - 纯函数 + 可注入 storage —— node:test 直测（不依赖浏览器）。
 *
 * 为什么带 rel：绑定后下拉/行内展示用（planRel 最终由服务端按 cwd 重算，这里只作 UI 兜底）。
 */

export interface PendingPlan {
  /** 方案文档绝对路径 */
  path: string;
  /** 相对新建会话 cwd 的显示名（可选；取不到时 UI 退回绝对路径） */
  rel?: string;
  /** 选择时间（ms） */
  at: number;
}

export const PENDING_PLAN_KEY = "pf.pendingPlan.v1";

/** localStorage 最小接口（node 测试注入内存实现） */
export interface PendingPlanStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PendingPlanStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** 读全量分桶映射（坏 JSON / 非对象 → 空表，不抛）。 */
export function loadPendingMap(store: PendingPlanStorage | null = defaultStorage()): Record<string, PendingPlan> {
  if (!store) return {};
  try {
    const raw = store.getItem(PENDING_PLAN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, PendingPlan>) : {};
  } catch {
    return {};
  }
}

/** 写全量分桶映射（空表时写 "{}"；写失败静默）。 */
export function savePendingMap(map: Record<string, PendingPlan>, store: PendingPlanStorage | null = defaultStorage()): void {
  if (!store) return;
  try {
    store.setItem(PENDING_PLAN_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式/配额满 → 静默（功能降级为不恢复） */
  }
}

/** 读某 cwd 的 pending（cwd 空 → null）。 */
export function readPendingPlan(cwd: string, store: PendingPlanStorage | null = defaultStorage()): PendingPlan | null {
  if (!cwd) return null;
  const p = loadPendingMap(store)[cwd];
  return p && typeof p.path === "string" && p.path ? p : null;
}

/** 写/清某 cwd 的 pending（p=null 删除；cwd 空 → 不动）。 */
export function writePendingPlan(cwd: string, p: PendingPlan | null, store: PendingPlanStorage | null = defaultStorage()): void {
  if (!cwd) return;
  const map = loadPendingMap(store);
  if (p) map[cwd] = p;
  else delete map[cwd];
  savePendingMap(map, store);
}

/** 取走（读后即清）某 cwd 的 pending —— 绑定成功后消费（先清除再请求，防重复绑定）。 */
export function takePendingPlan(cwd: string, store: PendingPlanStorage | null = defaultStorage()): PendingPlan | null {
  const p = readPendingPlan(cwd, store);
  if (p) writePendingPlan(cwd, null, store);
  return p;
}
