// 页面级单例：/api/agent/running/events SSE 共享通道（连接池保护）
//
// 背景：浏览器 HTTP/1.1 对每主机仅 6 条并发连接。页面上的长连接（running/events、
// availability/events、plan-first/events、扩展桥 SSE、媒体 watch…）若由各组件实例
// 分别建连（SessionSidebar 在桌面/移动双渲染下就有 2 个实例），总数很快 ≥6，
// 之后一切新请求（媒体流、任意 fetch）永久 pending——页面整体饿死（实测：视频
// 无法播放、random fetch 4s 超时，curl 却全部正常）。
//
// 因此 running/events 全页共享一条连接：订阅者只挂回调；末位退订时才真正关闭。
// 服务端 30s 心跳（named event "heartbeat"）供判活；错误广播由订阅方自行决策
// （如 CLOSED 后延迟重建走 broker.reconnect()）。
import { apiUrl } from "./base-path";

export type RunningFrame = { type?: string; runningSessionIds?: string[] };
type Listener = (kind: "message" | "heartbeat" | "error", data: RunningFrame | null, raw?: MessageEvent) => void;

interface RunningBroker {
  listeners: Set<Listener>;
  frameListeners: Set<(frame: Record<string, unknown>) => void>;
  es: EventSource | null;
  dead: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connect: () => void;
}

export function subscribeRunningEvents(listener: Listener): () => void {
  const w = window as any;
  let b = w.__runningEventsBroker as RunningBroker | undefined;
  if (!b) {
    b = w.__runningEventsBroker = {
      listeners: new Set<Listener>(),
      frameListeners: new Set<(frame: Record<string, unknown>) => void>(),
      es: null,
      dead: false,
      reconnectTimer: null,
      connect: () => {
        if (b!.dead) return;
        try { b!.es?.close(); } catch { /* noop */ }
        const source = new EventSource(apiUrl("/api/agent/running/events"));
        b!.es = source;
        // named event 心跳（服务端 30s 一帧）：专供订阅方判活
        source.addEventListener("heartbeat", () => {
          b!.listeners.forEach((f) => { try { f("heartbeat", null); } catch { /* noop */ } });
        });
        source.onmessage = (e) => {
          let data: RunningFrame | null = null;
          try { data = JSON.parse((e as MessageEvent).data) as RunningFrame; } catch { /* malformed frame */ }
          b!.listeners.forEach((f) => { try { f("message", data, e as MessageEvent); } catch { /* noop */ } });
          if (data) b!.frameListeners.forEach((f) => { try { f(data as Record<string, unknown>); } catch { /* noop */ } });
        };
        source.onerror = () => {
          b!.listeners.forEach((f) => { try { f("error", null); } catch { /* noop */ } });
        };
      },
    };
    b.connect();
  }
  b.listeners.add(listener);
  return () => {
    b.listeners.delete(listener);
    if (b.listeners.size === 0 && b.frameListeners.size === 0) {
      b.dead = true;
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
      try { b.es?.close(); } catch { /* noop */ }
      w.__runningEventsBroker = null;
    }
  };
}

/** broker 连接进入 CLOSED（EventSource 不再自动重连）时由订阅方调用：延迟重建 */
export function reconnectRunningEvents(delayMs = 3000): void {
  const b = (window as any).__runningEventsBroker as RunningBroker | undefined;
  if (!b || b.dead || b.reconnectTimer) return;
  b.reconnectTimer = setTimeout(() => {
    b.reconnectTimer = null;
    if (!b.dead && b.listeners.size > 0) b.connect();
  }, delayMs);
}

// ── 通用帧订阅（跨扩展共享同一连接）──────────────────────────
// 扩展/其他消费方经 window.__piPageEventsClient.subscribePageFrames(handler) 挂上
// 同一条连接：每个 message 帧（JSON）原样分发给 handler（frame.type 区分来源：
// running / pf:remind / mc:avail / ed-watch …）；named heartbeat 帧不投递（判活用）。
export function subscribePageFrames(handler: (frame: Record<string, unknown>) => void): () => void {
  const w = window as any;
  let b = w.__runningEventsBroker as RunningBroker | undefined;
  if (!b) { subscribeRunningEvents(() => {}); b = w.__runningEventsBroker; }
  const listeners = b!.frameListeners as Set<(frame: Record<string, unknown>) => void>;
  listeners.add(handler);
  return () => listeners.delete(handler);
}


// 跨扩展浏览器端入口（plan-first / model-check / aiti-editor 等经此共享连接）
if (typeof window !== "undefined") {
  (window as any).__piPageEventsClient = { subscribePageFrames };
}
