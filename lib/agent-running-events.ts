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

// 服务端 30s 心跳；超过 HEARTBEAT_FRAME_TIMEOUT_MS 无任何帧（message/heartbeat）= 连接半死/
// 被浏览器后台冻结（EventSource 仍 OPEN 但不再收数据、也不触发 onerror 的"静默死连接"）
// → 由 broker 心跳 watchdog 主动关旧连接重建，治愈半连接（此问题此前让 session-manager
// 健康时钟恒超时，持续每 15s 兜底轮询 /api/agent/running，后端负载被无谓放大）。
export const HEARTBEAT_FRAME_TIMEOUT_MS = 75_000;
// 宿主 broker 投递给 frameListeners 的「心跳帧」type（扩展健康时钟专用；消费方按 type 分发，
// 对未知 type 忽略，互不误触）。原契约 named heartbeat 帧不投递给 frameListeners，导致扩展
// 在运行集稳定（无 running 变化帧）时收不到任何帧 → 恒判 SSE 死。此帧补上该缺口。
export const HEARTBEAT_FRAME_TYPE = "piwe:heartbeat";

export type RunningFrame = { type?: string; runningSessionIds?: string[] };
type Listener = (kind: "message" | "heartbeat" | "error", data: RunningFrame | null, raw?: MessageEvent) => void;

interface RunningBroker {
  listeners: Set<Listener>;
  frameListeners: Set<(frame: Record<string, unknown>) => void>;
  es: EventSource | null;
  dead: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** 连续失败次数（每次 EventSource onerror +1；onopen 清零）——≥2 判定后端断连 */
  connFails: number;
  /** 当前是否已广播「断连」（只广播状态迁移，不重复刷屏） */
  connOffline: boolean;
  /** 最近一次收到帧（message/heartbeat）时刻——心跳 watchdog 判活基准 */
  lastFrameAt: number;
  /** 心跳超时 watchdog（事件驱动：每帧重置；超时无帧即连接半死 → 主动重建）。
   *  零业务轮询——它就是 TCP keepalive 的等效，帧驱动重置，不引入定时拉取。 */
  frameWatchdog: ReturnType<typeof setTimeout> | null;
  connect: () => void;
}

// ── 后端断连/恢复广播（后端重启提示横幅的数据源）──────────────────
// 后端（pi-web）重启窗口内所有请求 502/拒连，页面上散落的「HTTP 502」toast 没有
// 任何「请刷新」指引。这里复用 broker 既有连接生命周期做全页统一的存活信号：
//   - EventSource onerror = 失败一次（重启期间既有的 3s 重建循环会持续喂错误）；
//     连续 ≥2 次才判定断连——过滤单次网络抖动（移动端隧道闪断常见）。
//   - onopen = 恢复（连接真正建起来）。
// 零新增轮询：检测节奏就是既有 reconnect 循环本身。
export type BackendConnState = "offline" | "online";
const connStateListeners = new Set<(state: BackendConnState) => void>();

/** 订阅后端断连/恢复（模块级监听 + window CustomEvent 双通道，扩展 bundle 也可经事件消费） */
export function onBackendConnChange(listener: (state: BackendConnState) => void): () => void {
  connStateListeners.add(listener);
  return () => connStateListeners.delete(listener);
}

/** 最近一次广播的状态（订阅者挂上之前可能已错过 offline——进横幅时先查一次） */
let lastConnState: BackendConnState | null = null;
export function getBackendConnState(): BackendConnState | null {
  return lastConnState;
}

function broadcastConnState(state: BackendConnState): void {
  if (lastConnState === state) return;
  lastConnState = state;
  connStateListeners.forEach((f) => { try { f(state); } catch { /* 订阅方异常不扩散 */ } });
  // window 事件通道：跨 bundle（扩展 client）消费用；非浏览器环境静默
  try {
    window.dispatchEvent(new CustomEvent("piwe-backend-conn", { detail: { state } }));
  } catch { /* non-browser */ }
}

/** window 上的 broker 挂点（core 与各扩展 client bundle 共享同一单例） */
interface BrokerWindow {
  __runningEventsBroker?: RunningBroker | null;
  __piPageEventsClient?: {
    subscribePageFrames: typeof subscribePageFrames;
    /** 强制立即重建共享连接（判活超时/半连接时由扩展调用；走 0ms 重建） */
    reconnectRunning: () => void;
  };
}

export function subscribeRunningEvents(listener: Listener): () => void {
  const w = window as BrokerWindow;
  let b = w.__runningEventsBroker;
  if (!b) {
    b = w.__runningEventsBroker = {
      listeners: new Set<Listener>(),
      frameListeners: new Set<(frame: Record<string, unknown>) => void>(),
      es: null,
      dead: false,
      reconnectTimer: null,
      connFails: 0,
      connOffline: false,
      lastFrameAt: 0,
      frameWatchdog: null,
      connect: () => {
        // 心跳 watchdog（事件驱动，零业务轮询）：每收到一帧（message/heartbeat）重置；
        // 超时窗口内无任何帧 = 连接半死/被浏览器后台冻结（EventSource 仍 OPEN 但收不到
        // 数据、也不触发 onerror——"静默死连接"正是 session-manager 持续兜底轮询的根源）。
        // 守护到点主动关旧连接重建，治愈半连接，让 heartbeat/快照帧恢复流动。
        const armFrameWatchdog = () => {
          if (b!.frameWatchdog) clearTimeout(b!.frameWatchdog);
          b!.frameWatchdog = setTimeout(() => {
            b!.frameWatchdog = null;
            if (b!.dead) return;
            if (Date.now() - b!.lastFrameAt >= HEARTBEAT_FRAME_TIMEOUT_MS) {
              try { b!.es?.close(); } catch { /* noop */ }
              b!.es = null;
              b!.connect();
            } else {
              armFrameWatchdog(); // 刚收到过帧，timer 只是迟触发——续判
            }
          }, HEARTBEAT_FRAME_TIMEOUT_MS);
        };
        const markFrame = () => {
          b!.lastFrameAt = Date.now();
          armFrameWatchdog();
        };
        if (b!.dead) return;
        try { b!.es?.close(); } catch { /* noop */ }
        const source = new EventSource(apiUrl("/api/agent/running/events"));
        b!.es = source;
        markFrame(); // 建连即给活性基准，避免 watchdog 首巡误判
        // named event 心跳（服务端 30s 一帧）：专供订阅方判活
        source.addEventListener("heartbeat", () => {
          markFrame();
          b!.listeners.forEach((f) => { try { f("heartbeat", null); } catch { /* noop */ } });
          // 顺带投递给 frameListeners（扩展健康时钟靠它）。原契约缺失导致运行集稳定时
          // session-manager 恒判 SSE 死 → 持续兜底轮询 /api/agent/running。
          // 专用 type=HEARTBEAT_FRAME_TYPE；消费方按 type 分发，未知 type 忽略。
          b!.frameListeners.forEach((f) => { try { f({ type: HEARTBEAT_FRAME_TYPE, at: b!.lastFrameAt }); } catch { /* noop */ } });
        });
        source.onopen = () => {
          // 连接建起 = 后端存活：清失败计数；若此前广播过断连 → 广播恢复。
          // lastConnState 兜底：broker 全退订销毁后重建时 connOffline 已随旧对象
          // 丢失，但模块级 lastConnState 可能仍是 offline——首个成功连接负责纠正。
          b!.connFails = 0;
          markFrame();
          if (b!.connOffline || lastConnState === "offline") {
            b!.connOffline = false;
            broadcastConnState("online");
          }
        };
        source.onmessage = (e) => {
          markFrame();
          let data: RunningFrame | null = null;
          try { data = JSON.parse((e as MessageEvent).data) as RunningFrame; } catch { /* malformed frame */ }
          b!.listeners.forEach((f) => { try { f("message", data, e as MessageEvent); } catch { /* noop */ } });
          if (data) b!.frameListeners.forEach((f) => { try { f(data as Record<string, unknown>); } catch { /* noop */ } });
        };
        source.onerror = () => {
          b!.listeners.forEach((f) => { try { f("error", null); } catch { /* noop */ } });
          // 断连判定：连续 ≥2 次失败（第一次可能是重启刚掐断在途连接，第二次来自
          // 重建循环的拒连/502——到这一步基本确定后端不在了）→ 广播 offline
          b!.connFails++;
          if (b!.connFails >= 2 && !b!.connOffline) {
            b!.connOffline = true;
            broadcastConnState("offline");
          }
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
  const b = (window as BrokerWindow).__runningEventsBroker;
  if (!b || b.dead || b.reconnectTimer) return;
  b.reconnectTimer = setTimeout(() => {
    b.reconnectTimer = null;
    if (!b.dead && b.listeners.size > 0) b.connect();
  }, delayMs);
}

// ── 通用帧订阅（跨扩展共享同一连接）──────────────────────────
// 扩展/其他消费方经 window.__piPageEventsClient.subscribePageFrames(handler) 挂上
// 同一条连接：每个 message 帧（JSON）原样分发给 handler（frame.type 区分来源：
// running / pf:remind / mc:avail / ed-watch …）；named heartbeat 帧现也作为
// { type: HEARTBEAT_FRAME_TYPE, at } 帧投递（修复扩展健康时钟缺失），扩展按 type 分发、
// 未知 type 忽略，互不误触。
export function subscribePageFrames(handler: (frame: Record<string, unknown>) => void): () => void {
  const w = window as BrokerWindow;
  let b = w.__runningEventsBroker;
  if (!b) { subscribeRunningEvents(() => {}); b = w.__runningEventsBroker; }
  const listeners = b!.frameListeners as Set<(frame: Record<string, unknown>) => void>;
  listeners.add(handler);
  return () => listeners.delete(handler);
}


// 跨扩展浏览器端入口（plan-first / model-check / aiti-editor 等经此共享连接）
if (typeof window !== "undefined") {
  (window as BrokerWindow).__piPageEventsClient = {
    subscribePageFrames,
    // 判活超时/半连接时扩展可主动重建共享连接（0ms），缩短自愈时间
    reconnectRunning: () => reconnectRunningEvents(0),
  };
}
