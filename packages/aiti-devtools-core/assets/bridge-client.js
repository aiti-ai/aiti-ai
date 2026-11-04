/**
 * bridge-client.js —— aiti-mcp-server 通用桥客户端（任意页面 ⇄ 桥）
 *
 * 专门处理 MCP bridge 的通用逻辑（方案 D：pageId = instanceId/frameId）：
 *   - claim()：连接登记/复用（POST /bridge/claim；页面端用，带 pageKey）
 *   - listSessions()：发现可操作页面（GET /bridge/sessions → [{ instanceId, frameId, pageId, url, frameworks, active }]）
 *   - connect({ base, instanceId|token, role:'page'|'ai', useForward, onStatus/onExec/onResult/onEvent })：连桥（SSE）
 *   - 回桥：postResult(requestId, ok, result, pageId)、postEvent(type, payload, pageId)
 *   - 转发结果：connect 时若 useForward=true，本模块转发的 exec 会监听 dbg_command_result 自动回桥
 *
 * 用法（任何页面/界面）：
 *   <script src="/src/mcp/bridge-client.js"></script>
 *   <script>
 *     window.BridgeClient.connect({
 *       base: 'http://localhost:8777', instanceId: '00001', role: 'page',
 *       onStatus: (text, color) => { ... 连接状态显示 ... },
 *       onExec:   (m) => { ...收到 MCP 请求：展示/转发执行（转发则返回 true）... },
 *       onResult: (m) => { [ 收到执行结果 ] },
 *       onEvent:  (m) => { [ 收到页面事件（open_file 等） ] },
 *     });
 *     const sessions = await window.BridgeClient.listSessions();
 *   </script>
 */
(function (global) {
  'use strict';
  // 幂等守卫：本脚本可能被重复加载（pi-web 工具栏可见行 + 离屏测量 strip 双挂载竞态等）。
  // 重复执行会生成第二个独立闭包（独立 es/cfg）→ 第二条 SSE 连接 → 桥每次推送被同一窗口收到两次
  // （交互双面板 / exec 双执行 / pick_element 互拒）。已存在 BridgeClient 则直接返回，
  // 首个闭包负责全部连接；后续 connect 复用同一全局对象（connect 内部会先关旧 EventSource）。
  if (global.BridgeClient) return;
  var es = null;
  var cfg = { base: null, instanceId: null, secret: null, token: null, role: 'ai', useForward: false };
  var reqIds = new Set(); // 本模块转发的 exec requestId（结果自动回桥用）
  var sseReady = false; // 服务端已注册本连接（收到 ready 消息才算真正连上；EventSource 对象创建 ≠ 连接建立）
  var reconnectTimer = null; // 主动重连定时器（桥重启/网络瞬断后 EventSource 不会自动恢复——需显式重连）
  var reconnectAttempt = 0; // 重连退避次数（成功/收到 ready 后清零）
  // ---- 统一 SSE 端口适配（下行改走 event-bus 专属 topic；无总线 fallback 自带 SSE）----
  var viaBus = false;      // 当前连接是否走总线（探测结果；重连时重新探测，可能切换模式）
  var busOff = null;       // 总线订阅退订函数
  var busHb = null;        // 总线型连接保活心跳定时器

  function stopBus() {
    viaBus = false;
    if (busOff) { try { busOff(); } catch (e) {} busOff = null; }
    if (busHb) { clearInterval(busHb); busHb = null; }
  }
  /** 总线型连接保活：桥 sweep 扫 BUS_CONN_TTL 超时摘除断连信号缺失的连接（404 → 重新 attach） */
  function startBusHeartbeat() {
    if (busHb) clearInterval(busHb);
    busHb = setInterval(function () {
      if (!cfg.base || !viaBus) return;
      fetch(cfg.base + '/bridge/bus-heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: cfg.instanceId, secret: cfg.secret, token: cfg.token, role: cfg.role }),
      }).then(function (r) { if (r && r.status === 404 && !cfg.disposed) { stopBus(); connect(cfg); } }).catch(function () {});
    }, 45000); // 心跳保持 45s（开页方案 §8：不拉长心跳；桥侧 BUS_CONN_TTL 已提到 150s，漏 2 拍不误摘）
    if (busHb && typeof busHb.unref === 'function') busHb.unref();
  }

  /** 断线主动重连（退避）；native EventSource 对 HTTP 错误/流异常不自动重连，页面/AI 窗因此失联——必须显式拉起 */
  function scheduleReconnect() {
    if (reconnectTimer || !cfg.base) return; // 已有重连在途/未配置 → 跳过
    var delay = Math.min(15000, 500 * Math.pow(2, reconnectAttempt++)); // 0.5s → 1s → 2s → … ≤15s
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (!cfg.base || cfg.disposed) return;
      if (cfg.onStatus) cfg.onStatus('🔗 断线重连中（第 ' + reconnectAttempt + ' 次）…', '#f59e0b');
      connect(cfg); // 复用当前配置重连（connect 内部会关闭旧 es 并新建）
    }, delay);
  }

  // 连接池饥饿让路（防抱死） ----------
  // 浏览器 HTTP/1.1 同 host ~6 条连接被页面各长连接占满时，一切新 fetch 永久 pending——
  // 页面整体饿死（实测：视频/随机 fetch 超时，curl 却正常）。宿主页面（pi-web
  // lib/conn-guard）检测到饥饿时经 window 广播 "piwe-conn-starve"（detail.starved）。
  // 桥 SSE 是最可让的连接之一（可安全丢弃重连）：starve 即断开释放 socket，恢复广播后
  // 立即重建（复用 connect，配置保留）。总线模式下桥不再自持连接（下行在共享总线里），
  // 让路由由总线 broker 自己响应——直接跳过。非 pi-web 页面无人广播，本逻辑零参与。事件驱动，零轮询。
  var starveWired = false;
  function ensureStarveRelay() {
    if (starveWired || typeof global.addEventListener !== 'function') return;
    starveWired = true;
    global.addEventListener('piwe-conn-starve', function (ev) {
      var starved = !!(ev && ev.detail && ev.detail.starved);
      if (viaBus) return; // 总线模式：无自持连接可让（总线 broker 已接 starve 让路协议）
      if (!cfg.base || cfg.disposed) return;
      if (starved) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        sseReady = false;
        try { if (es) es.close(); } catch (e) {}
        es = null;
        if (cfg.onStatus) cfg.onStatus('🔗 连接拥挤，暂时让路…', '#f59e0b');
      } else if (!es) {
        connect(cfg); // 恢复：立即重建（connect 幂等：内部先关旧 es；重建后 ready 重新登记）
      }
    });
  }

  // 回桥加固：超时 + 熔断。桥慢/卡时 POST 若无超时会一直挂起占用连接池（实测
  // 917 个 POST + 527 ERR_INSUFFICIENT_RESOURCES 风暴：慢桥 → 挂起 POST 占满连接
  // → 新请求全失败 → 页面重试 → 自我强化）。AbortController 5s 超时 + 连续失败
  // 熔断 15s（SSE 恢复 ready 后清零），让风暴在客户端侧先折断。
  // 熔断/并发满期间不丢数据：入 pendingResults 队列，通道恢复后逐批补发。
  // 时效：每条请求桥端结算超时不同（exec 15s / SLOW_EXEC_CMDS 180s / interaction 60s+），
  // 客户端不预判——补发后由桥端权威判断（pending 在 → 成功；已结算 → 无 pending 丢弃）。
  var httpOutstanding = 0; // 并发回桥计数
  var httpFailStreak = 0;  // 连续失败次数
  var httpBreakerUntil = 0; // 熔断截止时间戳
  var pendingResults = []; // { path, body }
  var PENDING_MAX = 200; // 队列上限：防极端场景无限堆积（超出丢最旧）
  var flushTimer = null; // 补发循环定时器（每 tick 填满并发余量）
  function stopFlushTimer() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  }
  function tryFlushPendingResults() {
    if (!cfg.base || pendingResults.length === 0) { stopFlushTimer(); return; }
    if (Date.now() < httpBreakerUntil) { stopFlushTimer(); return; } // 熔断中：等解除
    // 逐批补发：每 tick 只发「并发余量」个（8 - outstanding），避免一次 flush 200 条
    // 全部发出 → 瞬间 200 并发 → 连接池又被占满（风暴复现，实测）。
    var room = Math.max(0, 8 - httpOutstanding);
    if (room > 0) {
      var batch = pendingResults.splice(0, room);
      for (var i = 0; i < batch.length; i++) {
        httpInner(batch[i].path, batch[i].body);
      }
    }
    // 还有剩余：定时器继续（每 50ms 填满余量；请求完成回调也会触发，双驱动防饿死）
    if (pendingResults.length > 0 && flushTimer === null) {
      flushTimer = setTimeout(function () {
        flushTimer = null;
        tryFlushPendingResults();
      }, 50);
    }
  }
  function http(path, body) {
    if (!cfg.base) return;
    // 熔断打开 / 并发满：入队（数据不丢），通道恢复后补发
    if (Date.now() < httpBreakerUntil || httpOutstanding >= 8) {
      if (pendingResults.length < PENDING_MAX) pendingResults.push({ path: path, body: body });
      return;
    }
    httpInner(path, body);
  }
  // 事件直发（不排队）：bridge/event 是广播型（无 requestId 幂等），补发会重复广播
  // （page_log 重复、open_file 重复触发）；且事件有时效性，过期补发无意义。
  // 熔断/并发满期间丢弃——事件丢失可接受（日志/状态类），result 才需要保真。
  function httpEvent(path, body) {
    if (!cfg.base) return;
    if (Date.now() < httpBreakerUntil || httpOutstanding >= 8) return; // 丢弃
    httpInner(path, body);
  }
  function httpInner(path, body) {
    if (!cfg.base) return;
    httpOutstanding++;
    var ctrl = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 5000);
    }
    try {
      fetch(cfg.base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl ? ctrl.signal : undefined,
        body: JSON.stringify(Object.assign({ token: cfg.token, secret: cfg.secret }, body || {})),
      }).then(function (r) {
        httpOutstanding--;
        if (r && r.ok) httpFailStreak = 0;
        else httpFailStreak++;
        if (httpFailStreak >= 5 && Date.now() >= httpBreakerUntil) {
          httpBreakerUntil = Date.now() + 15000;
          httpFailStreak = 0;
          if (cfg.onStatus) cfg.onStatus('⚠ 回桥熔断（15s 后重试）…', '#f59e0b');
        }
        tryFlushPendingResults(); // 并发降了 → 补发队列
      }).catch(function () {
        httpOutstanding--;
        httpFailStreak++;
        if (httpFailStreak >= 5 && Date.now() >= httpBreakerUntil) {
          httpBreakerUntil = Date.now() + 15000;
          httpFailStreak = 0;
        }
        tryFlushPendingResults();
      });
    } catch (e) {
      httpOutstanding--;
      tryFlushPendingResults();
    }
  }

  /** 连接登记/复用：页面端带 pageKey + hostUrl（端口偏好：localhost:6513 / 6513-port.localhost → instanceId=6513）；返回 { instanceId, secret } 或 null */
  function claim(pageKey, hostUrl) {
    var cred = { instanceId: null, secret: null };
    try {
      var v = global.localStorage.getItem('__dbg_mcp_iid:' + (pageKey || 'page'));
      if (v) { try { var o = JSON.parse(v); cred = { instanceId: o.iid || null, secret: o.secret || null }; } catch (e) { cred = { instanceId: v, secret: null }; } }
    } catch (e) {}
    return fetch(cfg.base + '/bridge/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: cred.instanceId, secret: cred.secret, pageKey: pageKey || null, hostUrl: hostUrl || (global.location ? global.location.href.slice(0, 500) : null) }),
    }).then(function (r) {
      if (r.status === 404) return null; // 老桥
      return r.json().then(function (b) {
        if (b && b.instanceId) {
          try { global.localStorage.setItem('__dbg_mcp_iid:' + (pageKey || 'page'), JSON.stringify({ iid: b.instanceId, secret: b.secret || null })); } catch (e) {}
          return { instanceId: b.instanceId, secret: b.secret || null };
        }
        return null;
      }).catch(function () { return null; });
    }).catch(function () { return null; });
  }

  /** 发现：列出已连接页面 [{ instanceId, frameId, pageId, url, frameworks, active, lastSeen }] */
  function listSessions() {
    if (!cfg.base) return Promise.resolve([]);
    return fetch(cfg.base + '/bridge/sessions').then(function (r) { return r.json(); }).catch(function () { return []; });
  }

  /** 连接桥；opts: {base, instanceId|secret|token, role('page'|'ai'), useForward, onStatus, onExec, onResult, onEvent} */
  function connect(opts) {
    opts = opts || {};
    cfg.base = opts.base;
    cfg.disposed = false; // 新连接（含重连）→ 清除显式断开标记
    cfg.instanceId = opts.instanceId || null;
    cfg.secret = opts.secret || null;
    cfg.token = opts.token || '';
    cfg.role = opts.role || 'ai';
    cfg.useForward = !!opts.useForward;
    cfg.onStatus = opts.onStatus || null;
    cfg.onExec = opts.onExec || null;
    cfg.onResult = opts.onResult || null;
    cfg.onEvent = opts.onEvent || null;
    cfg.onInteraction = opts.onInteraction || null;
    cfg.onReady = opts.onReady || null;
    if (!cfg.base) return false;
    ensureStarveRelay(); // 防抱死让路监听（幂等，首次 connect 时挂上）
    sseReady = false; // 重连/换连接 → 清就绪态（isConnected 回 false，直到服务端 ready 确认）
    cfg.frameId = opts.frameId || null;
    cfg.device = opts.device || null;
    cfg.deviceLabel = opts.deviceLabel || null;
    // 统一 SSE 端口适配：宿主 event-bus 已注册（window.__piEventBus 槽）且有 instanceId
    //（总线专属 topic 的隔离键）→ 下行走总线；否则（独立桥/非 pi-web 页面/token 模式/
    // 总线未部署）fallback 自带 SSE。重连时重新探测，两模式可互切。
    var bus = global.__piEventBus;
    if (bus && typeof bus.subscribeTopics === 'function' && cfg.instanceId) return connectViaBus(bus);
    return connectRaw();
  }

  /** 桥下行消息分发（EventSource 与总线两模式共用）：ready/exec/result/interaction/event */
  function handleMessage(m) {
    if (m && m.type === 'ready') {
      // 服务端已把本连接登记进注册表（ready 在注册之后发送）→ 此时 isConnected() 才为真、onReady 触发
      sseReady = true;
      reconnectAttempt = 0; // 服务端确认 → 重连周期结束
      httpFailStreak = 0; httpBreakerUntil = 0; // SSE 恢复 → 熔断清零（回桥通道已通）
      tryFlushPendingResults(); // 补发暂存结果（ready：通道已恢复）
      if (cfg.onReady) { try { cfg.onReady(m); } catch (e) {} }
      return;
    }
    if (!m) return;
    if (m.type === 'exec') {
      var forwarded = false;
      // M1 self-exec：桥标记 via:'self'（AI 主窗口自管理，无宿主）→ 用 cdp-core 在本窗口直接执行并回桥
      if (m.via === 'self') {
        var core = global.__AitiCdpCore;
        if (core && core.exec) {
          forwarded = true;
          try {
            var r0 = core.exec(m.cmd, m.args || {});
            Promise.resolve(r0 && typeof r0.then === 'function' ? r0 : (r0 && r0.result && typeof r0.result.then === 'function' ? r0.result.then(function (v) { return { ok: true, result: v }; }) : r0)).then(function (r) {
              var ok = !!(r && r.ok !== false);
              var res = (r && 'result' in r) ? r.result : r;
              // 直接回桥（不经 dbg_command_result 转发——本窗口执行无宿主转发）
              http('/bridge/result', { requestId: m.requestId, ok: ok, result: res, cmd: m.cmd });
            }).catch(function (err) {
              http('/bridge/result', { requestId: m.requestId, ok: false, result: { error: String((err && err.message) || err) }, cmd: m.cmd });
            });
          } catch (e) {
            http('/bridge/result', { requestId: m.requestId, ok: false, result: { error: String((e && e.message) || e) }, cmd: m.cmd });
          }
        }
      }
      if (!forwarded && cfg.useForward) {
        // 转发宿主执行（dbg_command → handleAiCommand）；结果由下方 message 监听自动回桥
        // 目标：opener 优先（AI 窗 popup 模式），parent 次之（内嵌 iframe 模式）——与 host-protocol aiHost 一致
        reqIds.add(m.requestId);
        var host = null;
        try {
          // 协商门槛（与 host-protocol aiHost 同规则，约定字符串 '__dbg_aiwin=' 三处同步）：
          // 仅 URL hash 带宿主打开 AI 窗时附带的 #__dbg_aiwin=1（aiwin.js withAiWinMark）才认
          // opener/parent——普通被 window.open 的页面不向宿主转发桥命令（否则宿主孤儿清理/路由误接管）。
          // 缓存 __dbgAiHostWin：SPA 剥 hash 后仍互通（见 host-protocol aiHost 注释）
          if (global.__dbgAiHostWin && !global.__dbgAiHostWin.closed) host = global.__dbgAiHostWin;
          else if (String(global.location && global.location.hash || '').indexOf('__dbg_aiwin=') >= 0) {
            if (global.opener && !global.opener.closed) { global.__dbgAiHostWin = global.opener; host = global.opener; }
            else if (global.parent !== global) { global.__dbgAiHostWin = global.parent; host = global.parent; }
          }
        } catch (e) {}
        // pi-web 内嵌 AI 窗：宿主与 AI 窗同窗口（无 opener/parent）→ 转发给自身窗口
        //（postMessage 自发自收异步送达，launcher 路由只认 __dbg 标记，无回环风险）
        if (!host) host = global;
        if (host) { try { host.postMessage({ __dbg: 1, type: 'dbg_command', payload: { requestId: m.requestId, cmd: m.cmd, args: m.args || {}, frameId: m.frameId } }, '*'); } catch (e) {} }
        forwarded = true;
      }
      if (cfg.onExec) cfg.onExec(m, forwarded);
    } else if (m.type === 'result') {
      if (cfg.onResult) cfg.onResult(m);
    } else if (m.type === 'interaction') {
      // 用户交互消息（AI 提问 → AI 窗口/页面作答）；宿主转发场景转发给 parent 由宿主面板处理
      if (cfg.onInteraction) cfg.onInteraction(m);
    } else if (m.type === 'event') {
      if (cfg.onEvent) cfg.onEvent(m.event || m);
    }
  }

  /** 总线模式（统一 SSE 端口适配）：宿主 event-bus 已注册（window.__piEventBus 槽）时，
   *  下行走总线专属 topic（bridge-<instanceId>），不再自建 EventSource——页面少一条
   *  长连（HTTP/1.1 6 连接保护）。POST /bridge/attach-bus 把连接注册成总线型（服务端
   *  既有推送点零改动自动改投总线）；总线未部署/桥未接线（501）→ connectRaw() fallback
   *  自带 SSE。重连时重新探测，两种模式可互切。 */
  function connectViaBus(bus) {
    viaBus = true;
    sseReady = false;
    try { if (es) es.close(); } catch (e) {} es = null;
    if (busOff) { try { busOff(); } catch (e) {} busOff = null; }
    var body = {
      instanceId: cfg.instanceId, secret: cfg.secret, token: cfg.token, role: cfg.role,
      url: global.location ? global.location.href.slice(0, 500) : null,
      title: global.document ? global.document.title : null,
      frameId: cfg.frameId || 'host',
    };
    if (cfg.device) { try { body.device = typeof cfg.device === 'string' ? cfg.device : JSON.stringify(cfg.device); } catch (e) {} body.deviceLabel = cfg.deviceLabel || null; }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = ctrl && setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 5000);
    fetch(cfg.base + '/bridge/attach-bus', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: ctrl ? ctrl.signal : undefined, body: JSON.stringify(body),
    }).then(function (r) {
      if (to) clearTimeout(to);
      if (!r.ok) return null; // 501（桥未接线总线）/401 → fallback
      return r.json();
    }).then(function (d) {
      if (cfg.disposed) { viaBus = false; return; } // attach 在途时已显式断开：不再复活连接（防 dispose 竞态脑裂）
      if (!d || !d.ok || !d.topic) { viaBus = false; connectRaw(); return; } // fallback 自带 SSE
      var topic = d.topic;
      var sub = bus.subscribeTopics(function (frame) {
        // 帧契约：{ type: "bridge-<instanceId>", msg: <桥原消息> }（帧 type = 订阅 topic，
        // 与服务端白名单一致；桥消息放 msg——publish 的 data 展开会覆盖同名键）
        if (!frame || frame.type !== topic || !frame.msg) return;
        handleMessage(frame.msg);
      }, [topic], function (status) {
        if (status !== 'up' && !cfg.disposed) {
          sseReady = false;
          if (cfg.onStatus) cfg.onStatus('🔗 总线断开，重连中…', '#f87171');
          scheduleReconnect(); // 重连 = connect(cfg) 重新探测（可能切回 EventSource 模式）
        }
      });
      busOff = sub.off;
      sub.ready.then(function () {
        if (cfg.disposed) return;
        startBusHeartbeat(); // 总线型连接保活（服务端 sweep 扫超时）
        reconnectAttempt = 0;
        // 兑底置就绪（防假死脑裂）：attach 的 ready 帧若落在 broker 断线重连窗口内会被
        // 总线丢弃（sink 为空/旧 sink 已死）且服务端不会重发——但订阅生效即通道就绪，
        // 后续下行必达。幂等：ready 帧先到时 handleMessage 已置过。onReady 仍由 ready 帧
        // 触发（保留首次登记语义）。
        if (!sseReady) sseReady = true;
      }).catch(function () {
        if (!cfg.disposed) scheduleReconnect(); // 总线不可达（POST 4xx/5xx）→ 退避重连（重新探测模式）
      });
    }).catch(function () {
      if (to) clearTimeout(to);
      viaBus = false;
      if (!cfg.disposed) connectRaw(); // 网络失败 → fallback 自带 SSE（自带连接有自动重试）
    });
    return true;
  }

  /** 自带 SSE 模式（现状行为，fallback 路径） */
  function connectRaw() {
    viaBus = false;
    if (busOff) { try { busOff(); } catch (e) {} busOff = null; }
    if (busHb) { clearInterval(busHb); busHb = null; }
    try { if (es) es.close(); } catch (e) {}
    var qs = cfg.instanceId
      ? '?instanceId=' + encodeURIComponent(cfg.instanceId) + (cfg.secret ? '&secret=' + encodeURIComponent(cfg.secret) : '')
      : '?token=' + encodeURIComponent(cfg.token || 'dev');
    qs += '&role=' + encodeURIComponent(cfg.role);
    // 设备信息随附（浏览器·屏幕等，供 bridge_status 识别是哪台机器/标签）——页面直连（role=page）时带上
    if (cfg.device) {
      try { qs += '&device=' + encodeURIComponent(typeof cfg.device === 'string' ? cfg.device : JSON.stringify(cfg.device)); } catch (e) {}
      if (cfg.deviceLabel) qs += '&deviceLabel=' + encodeURIComponent(String(cfg.deviceLabel));
    }
    es = new EventSource(cfg.base + '/bridge/sse' + qs);
    es.onopen = function () {
      reconnectAttempt = 0; // 连接建立 → 退避归零
      if (cfg.onStatus) cfg.onStatus('🔗 已连接', '#4ade80');
    };
    es.onerror = function () {
      sseReady = false;
      if (cfg.onStatus) cfg.onStatus('🔗 断开，重连中…', '#f87171');
      // native EventSource：网络错误会自动重试，但 HTTP 非 2xx（如桥重启瞬间 404/502）会进入 CLOSED 且不再自动重试
      // → 统一显式调度重连（connect 幂等：重连会新建 EventSource，auto-reconnect 与主动重连不冲突）
      scheduleReconnect();
    };
    es.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(m);
    };
    return true;
  }

  function disconnect() {
    cfg.disposed = true; // 标记已显式断开（防 scheduleReconnect 在途定时器复活连接）
    stopBus(); // 总线模式退订 + 停心跳
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopFlushTimer(); // 断开：停止补发循环（队列保留，重连后 ready 再补发）
    try { if (es) es.close(); } catch (e) {}
    es = null;
    reqIds.clear();
    if (cfg.onStatus) cfg.onStatus('🔗 已断开', '#9ca3af');
  }

  // ---------- 解冻锚点：手机后台冻结兔底 ----------
  // 手机浏览器（Android/华为等）切后台/锁屏会冻结页面：SSE 被系统直接拦断（HTTP 层 CLOSED，
  // readyState=2，native EventSource 不自动重连），且 onerror/重连 setTimeout 链可能在冻结中丢失
  // （不执行或解冻后对象已假死不再触发 error）→ 页面活着但桥连接永久死亡（桥端 sweep 摘除）。
  // 冻结期任何定时器都不可靠，唯一可靠的时机是「解冻瞬间」——挂 visibilitychange/pageshow/online
  // 三个锚点，回前台时发现连接不在就立即重建（cfg 保留全部回调，onReady 会重新注册页面）。
  function thawReconnect() {
    if (!cfg.base || cfg.disposed) return; // 未配置/显式断开 → 不拉起
    if (viaBus) { if (!sseReady) connect(cfg); return; } // 总线模式：连接活性由总线 broker 兜底，仅就绪态丢失时重 attach
    if (es && es.readyState === 0) return; // CONNECTING（原生自动重试中）→ 不打断
    if (!es || es.readyState === 2 || !sseReady) { connect(cfg); return; } // rs=2 CLOSED / 无连接 / open 过但 ready 没来（半死）→ 重建
    // rs=1 + ready 确认：解冻后探活一次（2s 超时）——失败说明断网/半开，重建拉活
    try {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var to = ac && setTimeout(function () { try { ac.abort(); } catch (e) {} }, 2000);
      fetch(cfg.base + '/bridge/sessions', { cache: 'no-store', signal: ac && ac.signal })
        .then(function () { if (to) clearTimeout(to); })
        .catch(function () { if (to) clearTimeout(to); if (!cfg.disposed) connect(cfg); });
    } catch (e) {}
  }
  function armThawHooks() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') thawReconnect();
    });
    global.addEventListener('pageshow', function (e) { if (e.persisted) thawReconnect(); }); // BFCache 恢复
    global.addEventListener('online', thawReconnect); // 网络恢复
  }
  armThawHooks();

  // 监听宿主执行结果：本模块转发的请求（requestId ∈ reqIds）→ POST /bridge/result 回桥
  global.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.__dbg !== 1 || m.type !== 'dbg_command_result') return;
    var p = m.payload || {};
    if (reqIds.has(p.requestId)) {
      reqIds.delete(p.requestId);
      http('/bridge/result', { requestId: p.requestId, ok: p.ok, result: p.result, cmd: p.cmdHint });
    }
  });

  global.BridgeClient = {
    connect: connect,
    disconnect: disconnect,
    claim: claim,
    listSessions: listSessions,
    isConnected: function () { return !!(sseReady && (viaBus || es)); }, // 真正的连接态：服务端 ready 确认 +（总线模式或 EventSource 对象）
    /** 解冻自愈检查（visibilitychange/pageshow/online 锚点同款逻辑；调试/运维手动触发用） */
    thaw: thawReconnect,
    getInstanceId: function () { return cfg.instanceId; },
    /** 执行结果回桥（页面执行端用；转发模式自动处理，一般无需手动） */
    postResult: function (requestId, ok, result, pageId) { http('/bridge/result', { requestId: requestId, ok: ok, result: result, pageId: pageId || null }); },
    /** 交互倒计时控制：用户暂停/继续超时（POST /bridge/interaction） */
    postInteraction: function (requestId, action) {
      if (!cfg.base || !requestId) return Promise.resolve(null);
      return fetch(cfg.base + '/bridge/interaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cfg.token, secret: cfg.secret, requestId: requestId, action: action }),
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
    },
    /** 页面事件到桥（open_file 等）：直发不排队（广播型无幂等，补发重复；熔断丢弃） */
    postEvent: function (type, payload, pageId) { httpEvent('/bridge/event', { type: type, payload: payload || {}, pageId: pageId || null }); },
  };
})(window);
