/**
 * 运行集总线广播（2026-09-15）：把 running 帧生产与 /api/agent/running/events
 * 的连接生命周期解绑。
 *
 * 背景（2026-09-15 生产实测）：running 帧的原始生产者挂在 events route 的 GET 内——
 * 只有客户端直连该 route 时才注册三路订阅（rpc/handle/bridge）。页面事件收敛到
 * aiti-event-bus 后无人直连（当天生产 0 次连接，nginx 证据）→ 总线 running topic
 * 无帧 → session-manager「收到过运行帧」健康判据恒假 → 全端每 30s 兜底轮询
 * /api/agent/running（兜底轮询被放大为常态）。
 *
 * 本模块：订阅三路运行变化（订阅集合全部 globalThis 承载——rpc 的 __piRunningListeners、
 * handle 的 __piHandleRunningListeners、bridge 的 __aitiBridgeRunning.listeners，
 * 跨模块图 realm 生效），任一变化 → 合并全集 → 与上次内容去重 → 宽发布 running 帧
 * （core sinks + 总线槽访问器）。ensureRunningBroadcast() 由必然加载的入口调用
 * （instrumentation 启动段 / /api/agent/running 快照 route，双入口保底），
 * globalThis 幂等——跨 realm 只注册一次。
 *
 * 与 events route 的关系：route 保留自己的三路订阅（直连模式自给自足，直调
 * publishPageEvent 只进本模块图的 sinks）；跨端主通道（总线）由本模块统一供帧，
 * 互不双发（见 route 内注释）。
 */
import { getRunningRpcSessionIds, subscribeRunningSessions } from "./rpc-manager.ts";
import { getRunningHandleIds, subscribeRunningHandles } from "./session/handle-store.ts";
import { getBridgeRunningIds, subscribeBridgeRunning } from "./session/bridge-running.ts";
import { publishPageEventToBus } from "./agent-page-events.ts";
import { mergeRunningIds, runningFrameKey } from "./running-broadcast-core.ts";

/** 合并三路运行集（rpc 本地 + handle 后端 + TUI 桥未认领），与各 route 内联版本同口径。 */
export function mergedRunningIds(): string[] {
  return mergeRunningIds(getRunningRpcSessionIds(), getRunningHandleIds(), getBridgeRunningIds());
}

const KEY_SLOT = "__piRunningBroadcastKey";
const WIRED_SLOT = "__piRunningBroadcastWired";

/**
 * 合并并发布 running 帧（内容与上次相同则跳过——多路在同一次变化里各自触发、
 * 或跨 realm 重复触发，也只会发一帧）。
 * 去重键放 globalThis：跨模块图 realm 共享，避免同一变化被不同 realm 各发一遍。
 */
export function publishMergedRunning(): void {
  const ids = mergedRunningIds();
  const key = runningFrameKey(ids);
  const g = globalThis as Record<string, unknown>;
  if (g[KEY_SLOT] === key) return;
  g[KEY_SLOT] = key;
  publishPageEventToBus("running", { runningSessionIds: ids });
}

/**
 * 幂等注册三路订阅 + 首帧快照。globalThis 标志保证跨 realm 只注册一次
 * （先注册者的闭包由 globalThis 订阅集合持有，进程存活期不回收）。
 *
 * 调用点（双入口保底）：
 *   - instrumentation.register()：总线 startup 之后（早、全量）；
 *   - app/api/agent/running/route.ts GET：任何部署形态下被首次访问即激活。
 */
export function ensureRunningBroadcast(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[WIRED_SLOT]) return;
  g[WIRED_SLOT] = true;
  subscribeRunningSessions(() => publishMergedRunning());
  subscribeRunningHandles(() => publishMergedRunning());
  subscribeBridgeRunning(() => publishMergedRunning());
  // 初始快照（空集也发：新页面订阅后即可对齐权威空集，不必等首次变化）
  publishMergedRunning();
}
