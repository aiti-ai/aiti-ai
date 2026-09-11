/**
 * ext-boot-signal — 宿主启动信号中心（lib 侧轻量共享，无 React/组件依赖）。
 *
 * 1）boot-settle：扩展启动批量 settle 信号（§3-C1）。
 * 2）事件总线部署定案：manifest 拉取后置位 aiti-event-bus 是否在部署清单
 *    （disabled 扩展不进 manifest = 清单即「已安装且启用」事实）。getEventBus
 *    据此三态裁决：已部署未 ready → 订阅排队挂起（绝不回退原生）；未部署 →
 *    回退；未知（manifest 未回）→ 乐观排队。置位方：ExtSlots.fetchManifestData。
 */

let settled = false;
const listeners = new Set<() => void>();

/** 启动批量 settle（首次尝试完成，成功/失败都算）。幂等：重复调用只首次生效。 */
export function notifyExtBootSettled(): void {
  if (settled) return;
  settled = true;
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 快照通知失败不阻断 */ }
  }
  listeners.clear();
}

/** 启动批量是否已 settle。 */
export function isExtBootSettled(): boolean {
  return settled;
}

/** 订阅 settle 信号（已 settle 则同步触发一次）。返回退订函数。 */
export function onExtBootSettled(fn: () => void): () => void {
  if (settled) {
    try { fn(); } catch { /* 消费方异常不扩散 */ }
    return () => {};
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── 事件总线部署定案（统一 SSE 端口方案 v2：部署事实，非运行时猜测）──────
// manifest 拉取后由宿主（ExtSlots.fetchManifestData）置位：aiti-event-bus 在
// manifest 清单里（disabled 扩展 loadAll 跳过、不进 manifest）= 总线已安装且启用，
// client register 只是时间问题。getEventBus 据此三态裁决：
//   true  → 未 ready 的订阅请求进队列挂起（绝不回退原生 SSE——泄露根源杜绝）
//   false → 未部署，调用方按各自契约回退原生 SSE（唯一回退条件）
//   null  → manifest 未回（极早窗口）：乐观排队，待定案后分流
// reload 拉新 manifest 可翻转定案（安装/卸载/启停），等待者随之分流。

let busDeployed: boolean | null = null;
const busDeployedListeners = new Set<(deployed: boolean) => void>();

/** 部署定案（manifest 回来即调；值变化时通知等待者）。 */
export function settleEventBusDeployed(deployed: boolean): void {
  if (busDeployed === deployed) return;
  busDeployed = deployed;
  for (const fn of [...busDeployedListeners]) {
    try { fn(deployed); } catch { /* 消费方异常不扩散 */ }
  }
}

/** 当前定案：true 已部署 / false 未部署 / null 未知（manifest 未回）。 */
export function eventBusDeployedVerdict(): boolean | null {
  return busDeployed;
}

/** 订阅部署定案（已定案则同步触发一次）。返回退订函数。 */
export function onEventBusDeployed(fn: (deployed: boolean) => void): () => void {
  if (busDeployed !== null) {
    try { fn(busDeployed); } catch { /* 消费方异常不扩散 */ }
    return () => {};
  }
  busDeployedListeners.add(fn);
  return () => busDeployedListeners.delete(fn);
}
