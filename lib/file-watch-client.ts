// 文件 watch 的总线接入 helper（页面事件唯一 SSE 收敛，lib/event-bus-client.ts 的
// FileViewer 专用封装）：总线能力在 → POST wantWatch 票据注册（lib/file-watch-registry
// 服务端内联启动 fs.watch）+ 订阅总线 "file-watch" type 按 watchId 过滤，票据成功即
// 派发 named "connected"（原 SSE 建连语义：watcher 已在，调用方此刻拉快照无缝）；
// 不在 → 返回 null，调用方 fallback 原样 watch SSE（buildTicketUrl → EventSource）。
//
// 帧→named 重组由适配器完成（change/gone/error 与原 SSE 逐字段一致），调用方的
// connected/change/error 监听零改动。
// 生命周期：close() 退订 + POST /api/files/watch-stop（服务端另有 30min 空闲自动停兜底）。
import { getEventBus, type BusEventSource } from "./event-bus-client";
import { apiUrl } from "./base-path";

export function openFileWatchBus(filePath: string): BusEventSource | null {
  const bus = getEventBus(`/api/files/watch?path=${encodeURIComponent(filePath)}`, {
    topic: "file-watch",
  });
  if (!bus) return null;

  let watchId: string | null = null;
  let closed = false;
  const stopRemote = (id: string) => {
    void fetch(apiUrl("/api/files/watch-stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchId: id }),
    }).catch(() => { /* noop：30min 空闲自动停兜底 */ });
  };

  // 覆写 close：退订总线 + 显式 watch-stop（组件 cleanup 的 es.close() 即走到这里）
  const originalClose = bus.close.bind(bus);
  bus.close = () => {
    if (closed) return;
    closed = true;
    originalClose();
    if (watchId) stopRemote(watchId);
  };

  // 票据注册（wantWatch）：成功 → named "connected"；失败 → onerror（调用方 markDisconnected）
  void fetch(apiUrl("/api/files/ticket"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, type: "watch", wantWatch: true }),
  })
    .then((r): Promise<{ watchId?: string } | null> => (r.ok ? r.json() : Promise.resolve(null)))
    .then((t) => {
      if (closed) {
        // 期间已关闭：服务端可能已注册 → 立即补 stop（防泄漏，30min 兜底前的显式清理）
        if (t?.watchId) stopRemote(t.watchId);
        return;
      }
      if (!t?.watchId) {
        bus.onerror?.(new Event("error"));
        return;
      }
      watchId = t.watchId;
      bus.dispatchNamed("connected", { type: "connected", filePath });
    })
    .catch(() => {
      if (!closed) bus.onerror?.(new Event("error"));
    });

  return bus;
}
