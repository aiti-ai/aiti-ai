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

export function addPageEventSink(send: (frame: PageFrame) => void): () => void {
  sinks.add(send);
  return () => sinks.delete(send);
}

// 扩展发布入口（服务端进程内直调）
(globalThis as any).__piPageEvents = { publish: publishPageEvent };
