// 全页连接池防抱死守护（anti-lock guard）
//
// 背景：浏览器 HTTP/1.1 对同 host 仅 ~6 条并发连接。页面上的长连接（running/events、
// agent/[id]/events、terminal events、文件 watch、扩展桥 SSE…）由各组件/扩展分别建连，
// 多 tab / 多面板叠加后总数 ≥6，之后一切新 fetch 永久 pending——页面整体饿死（实测：
// 视频 / 随机 fetch 超时转圈"卡死"，curl 却全部正常）。刷新会暂时释放连接，故表现为
// "多刷几次 / 开几个面板后可能卡死"。
//
// 机制（纯事件驱动，零轮询）：
//   - 包装 window.fetch，对同源请求做 header 级 pending 观测（promise resolve = 响应头
//     已到；body 流速度不参与判定）。
//   - 每个登记的请求挂一次性超时（非周期扫描）；任一请求超过 STARVE_THRESHOLD_MS 仍无
//     响应头 → 判定连接池饥饿 → 广播 starve。
//   - pending 队列出现 settle（fetch 完成/失败）且无其他超龄请求 → 广播 unstarve。
//   - SSE 持有方订阅饥饿信号，主动 close 让路（释放 socket），恢复后各自既有重连机制
//     重建（全部可安全丢弃重连，让路无损）。
//   - 最小间隔 MIN_STARVE_GAP_MS：两次 starve 广播之间的最小间隔，防止 close/connect
//     风暴（抱死解除需要时间，反复广播无益）。
//
// 扩展 bundle 经 window CustomEvent 双通道消费（同 onBackendConnChange 先例）：
//   window.addEventListener("piwe-conn-starve", (e) => { e.detail.starved ... })

export const STARVE_THRESHOLD_MS = 8_000;
export const MIN_STARVE_GAP_MS = 3_000;
/** 恢复延迟：超龄请求清空后再等这段时间才广播 unstarve。立即恢复会让 SSE 重建
 *  立刻回占 socket，下一个 fetch 又卡满阈值——周期性 8s 抖动。延迟恢复给短请求
 *  一个畅通窗口（SSE 少在线几秒无感知，它们各自重连机制会接上）。 */
export const UNSTARVE_REBUILD_DELAY_MS = 5_000;
/** 恢复抖动：多个 tab 往往几乎同时进入/解除饥饿（同一波刷新/同一波让路），
 *  固定延迟会让所有 tab 的 SSE 在同一毫秒回占连接池——重连风暴。各 tab 独立
 *  随机 0~JITTER 后广播 unstarve，重连时刻天然错开。 */
export const UNSTARVE_JITTER_MS = 4_000;

interface PendingEntry {
  url: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

type StarveListener = (starved: boolean) => void;

const starveListeners = new Set<StarveListener>();
let pending = new Map<number, PendingEntry>();
let nextId = 1;
let starved = false;
let lastStarveAt = 0;
let installed = false;
let unstarveTimer: ReturnType<typeof setTimeout> | null = null;

declare global {
  interface Window {
    __connGuardInstalled?: boolean;
  }
}

function broadcast(next: boolean): void {
  if (starved === next) return;
  starved = next;
  if (next) lastStarveAt = Date.now();
  starveListeners.forEach((f) => { try { f(starved); } catch { /* 订阅方异常不扩散 */ } });
  try {
    window.dispatchEvent(new CustomEvent("piwe-conn-starve", { detail: { starved } }));
  } catch { /* non-browser */ }
}

/** 该请求是否已超龄（无响应头且超过阈值）。调用时机：登记 timer 到点 / 任一请求 settle。 */
function hasOverageLocked(now: number): boolean {
  for (const entry of pending.values()) {
    if (now - entry.startedAt >= STARVE_THRESHOLD_MS) return true;
  }
  return false;
}

function settle(id: number): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(id);
  if (starved && !hasOverageLocked(Date.now()) && !unstarveTimer) {
    // 恢复延迟（见 UNSTARVE_REBUILD_DELAY_MS）：给短请求一个畅通窗口，
    // 避免「SSE 回占 → 下一个 fetch 又卡满阈值」的周期性抖动；
    // 再叠加随机抖动（UNSTARVE_JITTER_MS）错开多 tab 的恢复/重连时刻。
    const delay = UNSTARVE_REBUILD_DELAY_MS + Math.random() * UNSTARVE_JITTER_MS;
    unstarveTimer = setTimeout(() => {
      unstarveTimer = null;
      if (pending.size === 0 || !hasOverageLocked(Date.now())) broadcast(false);
    }, delay);
  }
}

/** 幂等安装 fetch 观测（页面 client 侧调用一次即可）。 */
export function installConnGuard(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__connGuardInstalled) return;
  installed = true;
  window.__connGuardInstalled = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const sameOrigin = typeof url === "string" && (url.startsWith("/") || url.startsWith(`${location.origin}/`));
    if (!sameOrigin) return origFetch(input as RequestInfo, init);

    const id = nextId++;
    const entry: PendingEntry = {
      url,
      startedAt: Date.now(),
      // 一次性超时（登记时安排、settle 时清除）——事件驱动判定饥饿，非周期轮询
      timeout: setTimeout(() => {
        if (Date.now() - entry.startedAt < STARVE_THRESHOLD_MS) return;
        if (starved) {
          // 仍超龄（饥饿未解）：取消在途恢复——不能带着饿死的请求放 SSE 回来
          if (unstarveTimer) { clearTimeout(unstarveTimer); unstarveTimer = null; }
          return;
        }
        // 饥饿广播节流：抱死解除需要时间，MIN_STARVE_GAP_MS 内不重复广播
        if (Date.now() - lastStarveAt < MIN_STARVE_GAP_MS) return;
        broadcast(true);
      }, STARVE_THRESHOLD_MS),
    };
    pending.set(id, entry);

    const p = origFetch(input as RequestInfo, init);
    p.then(
      () => settle(id),
      () => settle(id),
    );
    return p;
  }) as typeof window.fetch;
}

/** 订阅饥饿状态迁移（返回退订函数）。订阅方（SSE 持有方）收到 true 应主动 close 让路。 */
export function onConnStarvation(listener: StarveListener): () => void {
  starveListeners.add(listener);
  return () => { starveListeners.delete(listener); };
}

/** 当前是否处于饥饿态（订阅前先查一次，避免错过迁移）。 */
export function isConnStarved(): boolean {
  return starved;
}
