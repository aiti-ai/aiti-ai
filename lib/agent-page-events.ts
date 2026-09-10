// 页面事件流（服务端广播器）：/api/agent/running/events 的泛化承载。
//
// 全页唯一事件 SSE（HTTP/1.1 每主机 6 连接保护——此前各扩展/核心各自建连，
// 长连接 ≥6 后媒体/随机请求永久 pending，页面整体饿死，实测）。
// 帧格式：JSON message 帧，`type` 字段区分来源：
//   running   → 会话运行集（core）
//   pf:remind → 方案先行提醒（aiti-plan-first）
//   mc:avail  → 模型可用性（aiti-model-check）
//   ed-watch  → 媒体文件变化（aiti-editor，帧带 id = watchId）
// 扩展进程内发布：globalThis.__piPageEvents.publish(type, data)
//（instrumentation 启动时 import 本模块完成注册；与本模块同进程，零 socket 开销）。

type PageFrame = Record<string, unknown> & { type: string };
const sinks = new Set<(frame: PageFrame) => void>();

export function publishPageEvent(type: string, data: Record<string, unknown> = {}): void {
  const frame: PageFrame = { type, ...data };
  for (const send of [...sinks]) {
    try { send(frame); } catch { sinks.delete(send); }
  }
}

/**
 * 宽发布：core sinks（fallback SSE / core route 消费方）+ 总线（若 aiti-event-bus
 * 已接管 globalThis 槽）。唯一 SSE 收敛的服务端发布统一走本函数——直调
 * publishPageEvent 只进模块级 sinks，绕过总线接管槽（接管的正是槽的 wrapper）。
 * 防双发：槽是本模块自己的 plain 赋值（总线不在场）时跳过（已直调过）；
 * accessor wrapper 场景下 wrapper 的「前任」可能也是本模块实例——重复帧只会落
 * 到 core sinks（此时 fallback 客户端不在线，无实际重复），总线侧仅一份。
 */
export function publishPageEventToBus(type: string, data: Record<string, unknown> = {}): void {
  publishPageEvent(type, data);
  const slot = (globalThis as { __piPageEvents?: { publish: typeof publishPageEvent } }).__piPageEvents;
  if (slot?.publish && slot.publish !== publishPageEvent) {
    try { slot.publish(type, data); } catch { /* 总线不可达静默 */ }
  }
}

export function addPageEventSink(send: (frame: PageFrame) => void): () => void {
  sinks.add(send);
  return () => sinks.delete(send);
}

// 扩展发布入口（服务端进程内直调）
(globalThis as { __piPageEvents?: { publish: typeof publishPageEvent } }).__piPageEvents = { publish: publishPageEvent };
