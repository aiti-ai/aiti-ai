/**
 * aiti-event-bus · client —— 页面级单例 SSE broker（/api/extensions/aiti-event-bus/events）
 *
 * 职责（方案 §4-E + v0.2 主题订阅）：页面一条连接收页面事件帧，订阅方只挂回调——
 * 连接池保护同 core window.__piPageEventsClient（浏览器 HTTP/1.1 每主机 6 连接）。
 *
 * 两种订阅（同一连接上并存，本地分发各自过滤）：
 *   1. 全帧 subscribePageFrames(handler) —— v0.1 兼容，收一切帧
 *   2. 主题 subscribeTopics(handler, types, onStatus?) → { ready, off }
 *      - types: string[]，订阅方只收 frame.type ∈ types 的帧
 *      - 本地分发过滤之外，broker 还把汇总集 POST /subscribe 声明给服务端，
 *        SSE 转发层按连接白名单过滤——无关帧（如其他终端的大流量 data）不出 SSE
 *      - ready: Promise，POST 生效后 resolve（订阅方此后再拉初始快照即可无缝衔接）；
 *        总线不可达时 reject（订阅方据此降级旧通道）
 *      - onStatus("up"|"down"|"reconnecting")：连接状态回调（可选）
 *      - onHeartbeat()：服务端 named heartbeat（30s）回调（可选；判活用，不进帧分发）
 *      - 高频流消费方（aiti-cmd 终端）接 type 约定：每终端一个专属 type（cmd-<id>）
 *
 * 模式协调：页面存在任一全帧订阅者时连接保持全帧（服务端不过滤，正确性优先）；
 * 全帧订阅者退光后才 POST 白名单。分发层始终本地过滤，两模式行为一致。
 *
 * 重连：EventSource 断线自动重连 → 新连接（服务端订阅集已重置）→ hello 到达后
 * broker 重发当前订阅全集。旧客户端（v0.1 部署）无 POST，服务端默认全帧，兼容。
 *
 * 帧契约 { type, ... } 与 core 一致（running / pf:remind / mc:avail / ed-watch /
 * cmd-<id> …）；named heartbeat/hello 帧不进帧分发。
 */

const EVENTS_PATH = "/api/extensions/aiti-event-bus/events";
const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_MS = 90000; // 连接保活心跳（开页方案 §8：45→90s 减半空闲请求；服务端 6min 无心跳清理，4 次容忍）
// STALE_CONN（subscribe 报 conn 失效，服务端 reload 重建 conns 等）连续重建上限：
// 超过视为服务端持续异常，按不可达走失败路径（ready reject / warn），防无限重建循环。
const STALE_REBUILD_MAX = 3;
// STALE 重建窗口：窗口内的订阅成功不复位重建计数——服务端持续抖动（reload 风暴）
// 时「404→重建→200」交替若每次都复位，STALE_REBUILD_MAX 形同虚设，重建风暴不收敛
// （实测 dev 热重载下 ~3s 一轮 attach+subscribe+events 重建）；正常场景 STALE 稀疏
// （>窗口），成功订阅照常复位，计数从零开始。
const STALE_WINDOW_MS = 10_000;

// ── 页面级单例 broker（末位退订才真正关闭；引用计数，不挂在 register 生命周期上）──

let broker = null;

// register(ctx) 时保存的宿主 ctx（含 apiUrl 等）。subscribe* 订阅时不带参数，
// ensureBroker 用这里的 ctx 构造保真 URL——优先走宿主 apiUrl（正确 withBasePath），
// 避免兜底逻辑（见下）在子路径部署下把 basePath 拼成 host。
let activeCtx = null;

/**
 * 兜底 basePath（纯函数，可测）：__PIBASE__ 存在时优先；否则从 pathname 推。
 * 用捕获组 m[1]（不含前导斜杠）再拼 "/"：若误用 m[0]（已是 "/dev"）再前置 "/" 会
 * 得到 "//dev"，浏览器把协议相对 URL "//dev/..." 解析为 host="dev"（把 basePath 当主机）。
 * @param {string} [pathname] 如 "/dev/"；undefined（非浏览器）→ 空
 * @param {unknown} [pibase] window.__PIBASE__（basePath 便道）
 */
export function fallbackBasePath(pathname, pibase) {
  if (pibase) return String(pibase);
  const m = typeof pathname === "string" ? pathname.match(/^\/([^/]+)\//) : null;
  return m ? "/" + (m[1] ?? m[0].replace(/\/$/, "")) : "";
}

function apiUrl(ctx, path) {
  try {
    if (typeof ctx?.apiUrl === "function") return ctx.apiUrl(path);
  } catch { /* fallthrough */ }
  const pathname = typeof location !== "undefined" ? location.pathname : "";
  const pibase = typeof window !== "undefined" ? window.__PIBASE__ : undefined;
  return fallbackBasePath(pathname, pibase) + path;
}

// 当前应声明的白名单（全帧订阅者存在 → null = 不声明，服务端全帧）
function desiredTypes(b) {
  if (b.frameListeners.size > 0) return null;
  const set = new Set();
  for (const { types } of b.topicHandlers.values()) for (const t of types) set.add(t);
  return [...set];
}

function pushSubscription(b, forReady) {
  // 需要连接已建（hello 到达拿到 connId）。未连上时挂起，hello handler 里重调。
  if (!b.conn) { b.pendingPush = true; return; }
  const types = desiredTypes(b);
  if (types === null) {
    // 全帧模式：若本连接此前声明过白名单，必须显式恢复全帧（types:null），
    // 否则后加入的全帧订阅者会被残留白名单致盲；从未声明过则无事可做。
    if (!b.everPushed) { b.pendingPush = false; return; }
  }
  const conn = b.conn;
  fetch(apiUrl(activeCtx ?? b.hostCtx, "/api/extensions/aiti-event-bus/subscribe"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conn, types }),
  }).then(async (r) => {
    if (!r.ok) {
      // 服务端 4xx/5xx 带 JSON body 时取 code（STALE_CONN = conn 失效，可重建）；
      // 宿主路由 404（扩展禁用/卸载）等无 code → 走不可达失败路径。
      let code = null;
      try { const body = await r.json(); code = body && body.code ? String(body.code) : null; } catch { /* 非 JSON body */ }
      const err = new Error("subscribe HTTP " + r.status + (code ? " [" + code + "]" : ""));
      err.status = r.status;
      err.code = code;
      throw err;
    }
    return r.json();
  }).then((d) => {
    if (!d || d.ok !== true) throw new Error((d && d.error) || "subscribe 失败");
    b.everPushed = true;
    b.pendingPush = false;
    b.subRetryCount = 0; // 订阅生效：退避重试计数复位（失败后不递增到放弃）
    // 订阅生效：逃出 stale 循环。仅当距上次 STALE 超过窗口才复位计数——
    // 持续抖动（reload 风暴）时「404→重建→200」若每次都复位，上限形同虚设
    // （重建循环不收敛）；正常场景 STALE 稀疏，成功订阅即复位。
    if (!b.lastStaleAt || Date.now() - b.lastStaleAt >= STALE_WINDOW_MS) {
      b.staleRebuilds = 0;
      b.lastStaleAt = 0;
    }
    // 生效瞬间可能又有新的订阅变化（types 已变）→ 再推一次对齐；
    // 以「POST 发出的订阅 vs 当前期望」判定，避免全帧恢复后多打一次冗余 POST
    const latest = desiredTypes(b);
    const prev = types || [];
    const changed = latest === null
      ? types !== null
      : (types === null || latest.length !== prev.length || latest.some((t) => !prev.includes(t)));
    b.lastPushedAll = latest === null;
    if (changed) pushSubscription(b, false);
    if (forReady) {
      for (const r of b.readyResolvers) r.resolve();
      b.readyResolvers.length = 0;
    }
  }).catch((e) => {
    // STALE_CONN（conn 失效：服务端 reload 重建 conns / 半开清理误伤）：静默重建——
    // 关旧 ES、清 conn（setConn(null) 置 pendingPush）、新建连；hello 到达后重发订阅，
    // forReady 的等待者由新连接的 POST 结果喂。不 reject、不 warn、不产生 unhandled。
    if (e && e.code === "STALE_CONN" && (b.staleRebuilds || 0) < STALE_REBUILD_MAX) {
      b.staleRebuilds = (b.staleRebuilds || 0) + 1;
      rebuildAfterStale(b);
      return;
    }
    if (forReady) {
      for (const r of b.readyResolvers) r.reject(e);
      b.readyResolvers.length = 0;
    } else {
      // 非首次失败（白名单收缩/重声明的 POST 遇瞬时 502/网络抖动）：不能只等下一轮
      // hello —— 连接活着 hello 永不来，白名单将停留在错误状态（running 帧被服务端
      // 过滤、心跳照发、健康判定恒过、兜底被抑制 = 「失聪直到手动刷新」；2026-11-04
      // 实锤：nginx 日志显示用户页面单条 SSE 连接 85 分钟仅 52KB，活跃期应有 MB 级）。
      // 有限指数退避重试；持续异常超上限则放弃（与 STALE 上限同哲学）。
      scheduleSubscribeRetry(b);
    }
  });
}

const SUBSCRIBE_RETRY_BASE_MS = 2000;
const SUBSCRIBE_RETRY_MAX = 5;
function scheduleSubscribeRetry(b) {
  if (b.subRetryTimer) return; // 已有挂起重试
  if (b.subRetryCount >= SUBSCRIBE_RETRY_MAX) return; // 连续上限次都失败：服务端持续异常，放弃（新 hello 时复位重来）
  b.subRetryCount += 1;
  b.subRetryTimer = setTimeout(() => {
    b.subRetryTimer = null;
    if (b.dead || !b.conn) return; // 连接已重建/关闭：白名单由 hello 流程接管
    pushSubscription(b, false);
  }, SUBSCRIBE_RETRY_BASE_MS * b.subRetryCount);
  (b.subRetryTimer).unref?.();
}

/** STALE_CONN 重建：主动换新连接（不能只等浏览器自动重连——旧流可能还活着，
 *  hello 不会再来的话 pendingPush/ready 会永久悬挂）。旧 ES 打 replacedByRebuild
 *  标记：close() 按规范不触发 onerror，但个别实现可能 fire——守卫防止旧连接的
 *  onerror 再 scheduleReconnect 造出第二条并行连接。 */
function rebuildAfterStale(b) {
  b.lastStaleAt = Date.now(); // STALE 窗口起点：此后窗口内订阅成功不复位计数
  rebuildConnection(b);
}

/** 换新连接的公共动作：关旧 ES（replacedByRebuild 守卫）、清 conn（setConn(null)
 *  置 pendingPush）、connect()；新连接 hello 后重发订阅全集。 */
function rebuildConnection(b) {
  const old = b.es;
  if (old) old.replacedByRebuild = true;
  try { old?.close(); } catch { /* noop */ }
  b.es = null;
  b.setConn(null);
  b.connect();
}

/** 服务端总线实例 id 比对（hello/heartbeat 帧携带 busId）：reload = 新实例 = 新 id。
 *  触发场景：服务端新实例 startup 关闭旧残留流 → EventSource 自动重连 → 新 hello 带
 *  新 id → 此处发现变化主动再重建一次（幂等，多一次切换换确定性）；或未来其他失效
 *  形态。旧服务端（不带 busId）→ 忽略，行为同旧版。
 *  es 参数：事件来源连接——迟到事件（来自已被换下的旧连接）只对齐记录不重复重建。 */
function noteBusId(b, id, es) {
  if (!id || typeof id !== "string") return;
  if (b.busId == null) { b.busId = id; return; } // 首帧：只记录
  if (id === b.busId) return;
  b.busId = id;
  if (!es || b.es === es) rebuildConnection(b);
}

function ensureBroker(ctx) {
  if (broker) return broker;
  // ctx 可能为空（订阅调用不带参）：回退到 register 时保存的 host ctx。
  const ctxForUrl = ctx ?? activeCtx ?? {};
  const b = (broker = {
    es: null, conn: null, hostCtx: ctxForUrl,
    busId: null,                              // 服务端总线实例 id（hello/heartbeat 帧携带）：变化 = 服务端 reload → 主动重建连接
    subRetryTimer: null,                      // subscribe 失败的退避重试（见 scheduleSubscribeRetry）
    subRetryCount: 0,
    frameListeners: new Set(),                 // 全帧订阅者（v0.1 兼容）
    topicHandlers: new Map(),                  // handler -> { types: string[], onStatus?, onHeartbeat? }
    dead: false, reconnectTimer: null, hb: null,
    pendingPush: false, readyResolvers: [],    // 首次 POST 生效前挂起的 ready
    everPushed: false, lastPushedAll: false,   // 是否声明过白名单 / 上次声明是否全帧
    staleRebuilds: 0,                          // STALE_CONN 连续重建计数（窗口外订阅成功复位）
    lastStaleAt: 0,                            // 最近一次 STALE 重建时间戳（窗口复位判据）
    url: apiUrl(ctxForUrl, EVENTS_PATH),
  });
  b.connect = () => {
    if (b.dead) return;
    // 新连接：白名单由 hello 流程重发，旧的重试作废（防与新连接的 pushSubscription 竞态）
    if (b.subRetryTimer) { clearTimeout(b.subRetryTimer); b.subRetryTimer = null; }
    try { b.es?.close(); } catch { /* noop */ }
    const es = new EventSource(b.url);
    b.es = es;
    b.setConn(null); // 新连接对象：等 hello
    startHeartbeat(b);
    // 传输层 named heartbeat（服务端 30s 一帧）：**透传给订阅方**（onHeartbeat 回调）。
    // 旧行为是直接丢弃（`() => {}`）——后果：总线模式下 running broker 的 markFrame /
    // session-manager 健康时钟永远收不到帧 → 75s 帧 watchdog 判定半连接 → close+connect，
    // 拆除全页共享 SSE、每周期 2 个 POST /subscribe + 偶发 404 STALE_CONN；且
    // session-manager 恒判 SSE 死 → 15s/30s 兜底轮询 /api/agent/running 与 sessions?fmt=2
    // 复发（开页方案 §7）。
    es.addEventListener("heartbeat", (e) => {
      // busId 同步比对（服务端 reload = 新实例 = 新 id）：帧流在旧实例 reload 后已不可信，
      // 心跳却是旧实例闭包照发的——只看心跳会「永远健康、帧全停」。见 noteBusId。
      let hb = null; try { hb = JSON.parse(e.data); } catch { /* malformed */ }
      noteBusId(b, hb && hb.busId, es);
      b.notifyHeartbeat();
    });
    es.addEventListener("hello", (e) => {
      let d = null; try { d = JSON.parse(e.data); } catch { /* malformed */ }
      b.setConn(d && d.conn ? d.conn : null);
      noteBusId(b, d && d.busId, es);
      // staleRebuilds 不在此复位：连续 stale 重建靠计数封顶，仅订阅生效（POST 成功）才算逃出
      if (b.conn && (b.pendingPush || desiredTypes(b) !== null)) {
        const hadPending = b.pendingPush;
        pushSubscription(b, hadPending); // 首次订阅等待者：此次 POST 结果喂给 ready
      }
    });
    es.onopen = () => b.notifyStatus("up");
    es.onmessage = (e) => {
      let frame = null;
      try { frame = JSON.parse(e.data); } catch { /* malformed frame */ }
      if (!frame) return;
      dispatch(b, frame);
    };
    es.onerror = () => {
      if (es.replacedByRebuild) return; // STALE_CONN 重建换下的旧连接：事件不再驱动状态
      b.notifyStatus(es.readyState === 2 ? "reconnecting" : "down");
      // EventSource 自动重试；进入 CLOSED（如扩展被禁用后端点 404）延迟重建
      if (es.readyState === 2) scheduleReconnect(b);
    };
  };
  b.setConn = (conn) => {
    b.conn = conn;
    if (!conn) b.pendingPush = desiredTypes(b) !== null;
  };
  b.notifyStatus = (s) => {
    for (const { onStatus } of b.topicHandlers.values()) {
      try { onStatus && onStatus(s); } catch { /* 订阅方错误不阻断 */ }
    }
  };
  /** [开页方案 §7] 把服务端 named heartbeat 透传给订阅方（判活用；不进帧分发）。 */
  b.notifyHeartbeat = () => {
    for (const { onHeartbeat } of b.topicHandlers.values()) {
      try { onHeartbeat && onHeartbeat(); } catch { /* 订阅方错误不阻断 */ }
    }
  };
  b.connect();
  return b;
}

/** 主题匹配：精确相等，或订阅项尾 `*` 前缀通配（与服务端 bus-core 同规则）。
 *  导出供测试钉死——2026-09-16 曾因本地过滤用精确 includes，把服务端已按通配
 *  转发的帧（aiti-git-ops:changed:* / sched:*）全部丢弃。 */
export function topicMatches(frameType, types) {
  for (const t of types) {
    if (t.endsWith("*") ? String(frameType).startsWith(t.slice(0, -1)) : t === frameType) return true;
  }
  return false;
}

function dispatch(b, frame) {
  for (const f of [...b.frameListeners]) {
    try { f(frame); } catch { /* 订阅方错误不阻断 */ }
  }
  for (const [handler, { types }] of [...b.topicHandlers]) {
    if (!topicMatches(frame.type, types)) continue; // 本地过滤：与 SSE 白名单双层保险
    try { handler(frame); } catch { /* 订阅方错误不阻断 */ }
  }
}

function startHeartbeat(b) {
  if (b.hb) clearInterval(b.hb);
  b.hb = setInterval(() => {
    if (!b.conn || b.dead) return;
    fetch(apiUrl(activeCtx ?? b.hostCtx, "/api/extensions/aiti-event-bus/heartbeat"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conn: b.conn }),
    }).catch(() => { /* 失败静默：连接级问题由 EventSource 断线重连兼管 */ });
  }, HEARTBEAT_MS);
  (b.hb).unref?.();
}

function scheduleReconnect(b) {
  if (b.dead || b.reconnectTimer) return;
  b.reconnectTimer = setTimeout(() => {
    b.reconnectTimer = null;
    if (!b.dead && (b.frameListeners.size > 0 || b.topicHandlers.size > 0)) b.connect();
  }, RECONNECT_DELAY_MS);
}

// ── 连接池饥饿让路（防抱死，core lib/conn-guard 广播协议）──────────────
// 唯一 SSE 收敛后本 broker 是页面事件唯一的传输连接；饿死场景下与其它长连接
// 一起让路：starve 主动断开释放 socket（订阅集保留，重连后 hello 重发），
// unstarve 立即重连。与 bridge-client 同款窗口事件通道。
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("piwe-conn-starve", function (ev) {
    var starved = !!(ev && ev.detail && ev.detail.starved);
    var b = broker;
    if (!b || b.dead) return;
    if (starved) {
      if (b.reconnectTimer) { clearTimeout(b.reconnectTimer); b.reconnectTimer = null; }
      try { if (b.es) b.es.close(); } catch (e) { /* noop */ }
      b.es = null;
    } else if (!b.es && (b.frameListeners.size > 0 || b.topicHandlers.size > 0)) {
      b.connect();
    }
  });
}

/** [开页方案 §7] 末位退订不立即拆连接：给短宽限窗（订阅方重建/换订阅的常见竞态）。
 *  宽限内重新订阅 → 取消拆连接；否则真正关闭（断线重连语义不变）。 */
const IDLE_CLOSE_GRACE_MS = 8000;
function closeBrokerIfIdle() {
  const b = broker;
  if (!b || b.frameListeners.size > 0 || b.topicHandlers.size > 0) return;
  if (b.idleCloseTimer) return; // 已在宽限窗
  b.idleCloseTimer = setTimeout(() => {
    if (broker !== b) return;
    if (b.frameListeners.size > 0 || b.topicHandlers.size > 0) { b.idleCloseTimer = null; return; }
    b.dead = true;
    if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
    if (b.hb) { clearInterval(b.hb); b.hb = null; }
    try { b.es?.close(); } catch { /* noop */ }
    broker = null;
  }, IDLE_CLOSE_GRACE_MS);
}
/** 取消挂起的宽限拆连接（新订阅者到来）。 */
function cancelIdleClose(b) {
  if (b && b.idleCloseTimer) { clearTimeout(b.idleCloseTimer); b.idleCloseTimer = null; }
}

/** 帧订阅（全帧，v0.1 兼容）：帧契约与 core window.__piPageEventsClient.subscribePageFrames 一致。返回退订函数。 */
export function subscribePageFrames(handler) {
  const b = ensureBroker();
  cancelIdleClose(b);
  b.frameListeners.add(handler);
  return () => {
    b.frameListeners.delete(handler);
    closeBrokerIfIdle();
  };
}

/**
 * 主题订阅（v0.2）：只收 frame.type ∈ types 的帧。
 * @param {(frame:{type:string,...}) => void} handler
 * @param {string[]} types 订阅的 type 集合（如 ["cmd-s_ab12", "cmd-sessions"]）
 * @param {(status:"up"|"down"|"reconnecting") => void} [onStatus]
 * @param {() => void} [onHeartbeat] 服务端 named heartbeat（30s）回调——供订阅方判活
 *  用（running broker 的 75s 帧 watchdog、session-manager 健康时钟）；不进帧分发。
 * @returns {{ ready: Promise<void>, off: () => void }}
 *   ready 在服务端白名单生效（首个 POST 成功）后 resolve——订阅方此后拉初始快照
 *   可保证「先订阅后快照」顺序（快照 ⊇ 生效时刻，配合 seq 去重无缝衔接）；
 *   总线不可达（建连失败/POST 4xx5xx）时 reject，订阅方应降级旧通道。
 */
export function subscribeTopics(handler, types, onStatus, onHeartbeat) {
  if (!Array.isArray(types)) throw new Error("subscribeTopics: types 必须是数组");
  const b = ensureBroker();
  const norm = [...new Set(types.map(String))];
  b.topicHandlers.set(handler, { types: norm, onStatus, onHeartbeat });
  cancelIdleClose(b);
  const ready = new Promise((resolve, reject) => {
    if (desiredTypes(b) === null) { resolve(); return; } // 全帧模式：无白名单可等，直接就绪
    b.readyResolvers.push({ resolve, reject });
    // 若连接已就绪（hello 已到）立刻推；否则 hello handler 里推
    if (b.conn) pushSubscription(b, true);
  });
  return {
    ready,
    off: () => {
      b.topicHandlers.delete(handler);
      if (broker === b && desiredTypes(b) !== null) pushSubscription(b, false); // 全集收缩
      closeBrokerIfIdle();
    },
  };
}

export default function register(ctx) {
  // 同扩展重挂（hydration 失配后客户端重执行）：解散旧实例的服务注册，旧连接留给
  // 旧订阅者自然耗尽（引用计数退订时关闭），新订阅者走新实例——帧不断流。
  if (typeof window !== "undefined" && window.__aitiEventBusDisposer) {
    try { window.__aitiEventBusDisposer(); } catch { /* noop */ }
    window.__aitiEventBusDisposer = null;
  }
  // core P0 客户端服务面落地后生效；缺席静默 no-op（消费方按规范回退 core 兜底通道）
  // 保存 host ctx 供 subscribe* 构造保真 URL（见 apiUrl/ensureBroker）。
  activeCtx = ctx ?? null;
  const disposeService = ctx?.registerExtService?.("aiti-event-bus.subscribe", subscribePageFrames);
  const disposeTopics = ctx?.registerExtService?.("aiti-event-bus.subscribe-topics", subscribeTopics);
  // core 宿主标准槽（lib/event-bus-client.ts getEventBus 探测）：宿主组件不在扩展
  // ctx 体系内，经 window 双方解耦——挂 subscribeTopics 同一 broker 单例。
  // 同时广播就绪事件：core 侧适配器可能在槽挂上之前创建（loader 懒加载时序竞态），
  // 依赖此事件立即唤醒等待中的适配器（否则等它超时转 fallback）。
  if (typeof window !== "undefined") {
    window.__piEventBus = { subscribeTopics };
    try { window.dispatchEvent(new Event("piwe-event-bus-ready")); } catch { /* noop */ }
  }
  const disposer = () => {
    try { disposeService?.(); } catch { /* noop */ }
    try { disposeTopics?.(); } catch { /* noop */ }
    if (activeCtx === ctx) activeCtx = null; // 本实例的 host ctx 下线
    if (typeof window !== "undefined") {
      if (window.__piEventBus && (window.__piEventBus).subscribeTopics === subscribeTopics) {
        window.__piEventBus = undefined; // 仅当还是自己挂的才摘（防误删新实例的）
      }
      if (window.__aitiEventBusDisposer === disposer) {
        window.__aitiEventBusDisposer = null;
      }
    }
  };
  if (typeof window !== "undefined") window.__aitiEventBusDisposer = disposer;
  return disposer;
}
