/**
 * ext-boot-signal — 扩展启动批量 settle 信号（lib 侧轻量共享，无 React/组件依赖）。
 *
 * 统一 SSE 端口方案 §3-C1：getEventBus（lib/event-bus-client.ts）的「总线缺席定案」
 * 锚定到扩展启动批量 settle，而非固定 3s 超时——配合 materialize 优先级（aiti-event-bus
 * 先挂槽），部署了总线的页面在 boot settle 时 window.__piEventBus 必已在；届时仍未挂槽
 * 才判缺席。这消除了「正常但慢的加载」被误判缺席 → 回退原生 EventSource → SSE 泄露的窗口。
 *
 * 置位方：ExtSlots.loadExtensions() 的 finally（成功/失败都算 settle，语义与宿主
 * extBootSettled 一致）；消费方：event-bus-client 等非组件 lib 模块（不能反向 import
 * components/ExtSlots，故信号经本模块中转）。
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
