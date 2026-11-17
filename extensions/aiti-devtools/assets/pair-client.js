/**
 * pair-client.js — pair device interconnect browser library (docs/aiti-bridge-pair-plan.md + docs/pair-reaudit-and-fix-plan.md)
 *
 * Browser-side module at the same layer as aiwin.js: protocol glue (page-identity REST + aiConns pair_msg downlink +
 * chunked file upload/download) + full widget UI (device list / chat stream / file transfer). One implementation, reused by:
 *   - cockpit.html  toolbar chat button -> popup mount
 *   - aiwin adapter opts.pair hook (headless instance via aiwin.getPair())
 *   - pi-web ext    aiti-pair panel mounts the widget (phone entry = workbench deep link ?pair=1, QR via Open on Phone)
 *
 * No vendored QR lib (phone entry uses the opts.openOnPhone hook, backed by service-tunnels Open-on-Phone;
 * degrades to link+copy when absent)
 *
 * Usage:
 *   // widget (one-liner)
 *   const pair = window.AitiPair.mount(el, { base: 'https://host/aiti', name: 'phone' });
 *   // headless (protocol only, no UI)
 *   const p2 = window.AitiPair.create({ base });
 *   p2.on('message', m => …); p2.on('file', m => …); p2.on('devices', list => …);
 *   await p2.sendText('<deviceId>|all', 'hi'); await p2.sendFile('<deviceId>', file);
 */
(function (global) {
  'use strict';

  var CHUNK = 1024 * 1024; // 上传分块 1MB（服务端上限 2MB；≤1MB 不触 nginx client_max_body_size 常见默认）
  // i18n for kind/"self" labels: browser language binary split (zh prefix → Chinese) — consumed by
  // both createPair and mountWidget (renderDevices / detail overlay). Must live at the IIFE top
  // level: it was once misplaced inside createPair and the mountWidget side hit a ReferenceError
  // directly (device list rendering blew up on load).
  var langZh = !/^en/i.test(String((global.navigator && global.navigator.language) || 'zh'));
  var KIND_LABELS = langZh
    ? { page: '网页', agent: '代理', pair: '设备' }
    : { page: 'page', agent: 'agent', pair: 'device' };
  var SELF_LABEL = langZh ? '自己' : 'self';
    var T = langZh ? {
      allPages: '全部页面', allAgents: '全部代理', allPairDevices: '全部设备',
      save: '保存', send: '发送', copy: '复制', copied: '✓ 已复制', close: '关闭',
      copyLink: '复制链接', copyFail: '复制失败——请手动输入', copiedId: '✓ ID 已复制',
      msgTo: '发消息给 ', taPlaceholder: '发消息…（Enter 发送，Shift+Enter 换行）',
      offlineSuffix: '（离线）', noDevices: '暂无在线设备',
      sendFileTip: '发送文件', bellTip: '弹窗发送：对方设备弹通知（消息同时进聊天流）',
      exportTip: '导出聊天记录（Markdown）', phoneTip: '手机扫码接入（Open on Phone）',
      refreshTip: '刷新设备列表', deviceListTip: '设备列表', sideTip: '设备列表',
      selfNameTip: '本端设备名（回车保存，全桥可见）', online: '在线', offlineRow: '（离线）',
      showOffline: '显示离线', hideOffline: '隐藏离线', showOfflineTip: '显示离线设备', hideOfflineTip: '隐藏离线设备',
      bellPrompt: '先输入要弹窗的消息', bellSent: '🔔 已弹窗发送 → ',
      sendFail: '⚠ 发送失败：', sendFailNet: '⚠ 发送失败（网络）', offlineHint: '（离线设备不排队，消息已丢弃）',
      multiMatch: '⚠ 目标匹配多个：', nameSaved: '✓ 设备名已更新（全桥可见）', nameFail: '改名失败（网络）',
      qrTitle: '📱 手机扫码接入', qrFallbackTitle: '📱 手机扫码接入（无 QR 服务）',
      qrFallbackHint: '手机打开此链接即弹出设备互连面板（?pair=1 深链）',
      detailTitle: '设备详情', identify: '🔔 识别此设备', dm: '💬 发消息',
      exportNone: '没有可导出的消息', exportTitle: '# 设备互连聊天导出', exportTime: '- 导出时间：', exportSelf: '- 本端：',
      exportDone: '✓ 已导出 ', idCopied: '✓ ID 已复制', copyRow: '复制',
      status: '当前状态', onlineS: '在线', offlineS: '离线', sinceAgoP: '（', sinceAgoS: ' 起）',
      conn: '连接', lastActive: '最后活跃', sysBrowser: '系统与浏览器', browser: '浏览器',
      os: '操作系统', deviceType: '设备形态', hw: '硬件', screen: '屏幕', viewport: '视口',
      cpu: 'CPU / 内存', touch: '触摸点', langTz: '语言 / 时区', pageSec: '页面',
      agentSec: 'Agent', cwd: '工作目录', src: '接入方式', transport: '传输通道',
      ident: '标识', deviceId: '设备 ID', copyBtn: '复制', webdriver: 'webdriver=true（自动化控制中）',
      lan: '内网', wan: '公网', today: '今天 ', queued: ' 条（掉线暂存，上线即投）',
      emptyState: '消息零服务端留存：设备在线直投<br>目标离线不排队，消息将丢弃',
      identifyTargetOff: '该设备不在通知通道内', identifySent: '🔔 识别请求已发给 ',
    } : {
      allPages: 'All pages', allAgents: 'All agents', allPairDevices: 'All devices',
      save: 'Save', send: 'Send', copy: 'Copy', copied: '✓ Copied', close: 'Close',
      copyLink: 'Copy link', copyFail: 'Copy failed — enter manually', copiedId: '✓ ID copied',
      msgTo: 'Message ', taPlaceholder: 'Message… (Enter to send, Shift+Enter for newline)',
      offlineSuffix: ' (offline)', noDevices: 'No devices online',
      sendFileTip: 'Send file', bellTip: 'Bell send: pops a notification on the target (also recorded in chat)',
      exportTip: 'Export chat (Markdown)', phoneTip: 'Open on phone (Open on Phone)',
      refreshTip: 'Refresh devices', deviceListTip: 'Device list', sideTip: 'Device list',
      selfNameTip: 'Local device name (Enter to save, bridge-wide)', online: 'Online', offlineRow: ' (offline)',
      showOffline: 'Online', hideOffline: 'All', showOfflineTip: 'Show offline devices', hideOfflineTip: 'Hide offline devices',
      bellPrompt: 'Type the message to pop first', bellSent: '🔔 Popped to ',
      sendFail: '⚠ Send failed: ', sendFailNet: '⚠ Send failed (network)', offlineHint: ' (offline targets do not queue — dropped)',
      multiMatch: '⚠ Multiple targets matched: ', nameSaved: '✓ Device name updated (bridge-wide)', nameFail: 'Rename failed (network)',
      qrTitle: '📱 Open on phone', qrFallbackTitle: '📱 Open on phone (no QR service)',
      qrFallbackHint: 'Open this link on the phone to pop the pairing panel (?pair=1 deep link)',
      detailTitle: 'Device details', identify: '🔔 Identify this device', dm: '💬 Message',
      exportNone: 'Nothing to export', exportTitle: '# pair chat export', exportTime: '- Exported: ', exportSelf: '- Local: ',
      exportDone: '✓ Exported ', idCopied: '✓ ID copied', copyRow: 'Copy',
      status: 'Status', onlineS: 'Online', offlineS: 'Offline', sinceAgoP: ' (since ', sinceAgoS: ')',
      conn: 'Connection', lastActive: 'Last active', sysBrowser: 'System & browser', browser: 'Browser',
      os: 'OS', deviceType: 'Form factor', hw: 'Hardware', screen: 'Screen', viewport: 'Viewport',
      cpu: 'CPU / RAM', touch: 'Touch points', langTz: 'Language / TZ', pageSec: 'Page',
      agentSec: 'Agent', cwd: 'Workdir', src: 'Source', transport: 'Transport',
      ident: 'Identity', deviceId: 'Device ID', copyBtn: 'Copy', webdriver: 'webdriver=true (automated)',
      lan: 'LAN', wan: 'WAN', today: 'Today ', queued: ' queued (delivered on reconnect)',
      emptyState: 'Messages relay live with zero server retention.<br>Offline targets do not queue — messages are dropped',
      identifyTargetOff: 'Device is not on the notify channel', identifySent: '🔔 Identify request sent to ',
    };

  function kindLabel(k) { return KIND_LABELS[k] || k; }
  function createPair(opts) {
    opts = opts || {};
    var base = String(opts.base || inferBase()).replace(/\/+$/, '');
    var DEVICES_CACHE_KEY = '__aiti_pair_devices:' + base; // fallback data source when in-memory state is wiped (remount / freeze)
    var listeners = {}; // event -> [cb]
    var myName = opts.name || null;
    var started = false;
    var disposed = false;
    var devices = [];      // 统一设备视图（page/agent/pair）
    var history = [];      // chat stream (live + local echo)
    // Page identity (exposed by bridge-client): pair downlink rides aiConns (pageId channel); uplink REST is endorsed by the page identity
    function identity() {
      var idt = global.__aitiBridgeIdentity;
      return idt && idt.instanceId ? idt : null; // secret may be empty: role=ai connections self-identify, the bridge verifies by instanceId
    }
    function getInstanceId() { var idt = identity(); return idt ? idt.instanceId : null; }
    function getPageId() {
      try { var d = global.__dbg; if (d && d.pageId) return String(d.pageId); } catch (e) {}
      var iid = getInstanceId();
      return iid ? iid + '/host' : null;
    }
    function getSelfPageId() {
      var pid = getPageId();
      if (pid) return pid;
      var iid = getInstanceId();
      return iid ? iid + '/host' : null;
    }
    var NAME_KEY = '__aiti_pair_name:' + base;

    function inferBase() {
      var path = String(global.location && global.location.pathname || '');
      // pi-web embedded bridge: workbench served by the extension -> bridge endpoint prefix <basePath>/api/extensions/aiti-devtools/mcp
      // （extId 即 aiti-devtools；slice 保住 /dev 等 basePath 前缀）
      var i = path.indexOf('/api/extensions/aiti-devtools/');
      if (i >= 0) return global.location.origin + path.slice(0, i) + '/api/extensions/aiti-devtools/mcp';
      return global.location.origin + (path.indexOf('/aiti/') === 0 ? '/aiti' : '');
    }
    // Listener errors stay isolated (one bad consumer must not break the others), but they are no longer
    // silent: a swallowed ReferenceError inside renderMsgs made received messages invisible with zero trace.
    function emit(ev, data) { (listeners[ev] || []).forEach(function (cb) { try { cb(data); } catch (e) { try { console.warn('[aiti-pair] listener ' + ev + ' failed:', e); } catch (e2) {} } }); }
    function on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return function () { listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== cb; }); }; }

    function loadName() {
      try { if (!myName) myName = global.localStorage.getItem(NAME_KEY) || null; } catch (e) {}
    }
    function saveName() {
      try { global.localStorage.setItem(NAME_KEY, myName || ''); } catch (e) {}
    }
    loadName();

    /** 手机/新设备入口链接（QR 内容 + 复制链接同源）。
     *  pi-web 内嵌桥（base 相对，可带 basePath）→ 完整工作台 URL + ?pair=1 深链：打开 AI 窗口
     *  即自动弹出设备互连面板，与桌面「先开 pi-web → 点设备互连」同体验（aiti-pair 客户端消费该参数）；
     *  Non-embedded base (standalone bridge/cockpit) has no workbench to point at -> callers hide the phone entry via piWebBase. */
    var piWebBase = /\/api\/extensions\/aiti-devtools\//.test(base); // only pi-web embedded bridges (workbench deep link) show the phone entry (pair.html retired)
    function pairPageUrl() {
      var p = base.replace(/\/mcp$/, '');
      if (p.charAt(0) === '/') {
        var root = p.split('/api/extensions')[0];
        var origin = global.location && global.location.origin ? global.location.origin : '';
        return origin + root + '/?pair=1';
      }
      return p + '/?pair=1'; // non-pi-web base (cockpit -> standalone bridge) has no workbench; callers hide the entry via piWebBase
    }

    function http(path, body, rawBody) {
      var init = body || rawBody ? { method: 'POST', headers: rawBody ? {} : { 'Content-Type': 'application/json' }, body: rawBody || JSON.stringify(body) } : {};
      return fetch(base + path, init).then(function (r) { return r.json().catch(function () { return null; }); })
        .catch(function () { return null; });
    }

    // ---- downlink consumption (aiConns pair_msg -> aiti-pair-msg page event; the aiti-pair ext adds a module-level listener for closed-state unread) ----
        // ---- Registration is deprecated: the pair widget goes up/down with its page identity
        // ---- (instanceId exposed by bridge-client) ----
        // ---- Downlink: aiConns pair_msg (bridge-forwarded, dispatched to page events via
        // ---- bridge-client) — no dedicated SSE ----
    var onPairMsg = function (e) { // B5: kept by reference; removed in stop() (prevents remount listener leak / phantom unread)
      var m = e.detail || {};
      // Live bridge frames carry type "pair_msg" (files ride in .file); only a local echo has type "file".
      // Deciding on m.type alone turned every RECEIVED file into an empty text bubble (no download card).
      var isFile = !!(m.file) || m.type === 'file';
      var env = { id: m.id, type: isFile ? 'file' : 'text', from: m.from, to: m.to, ts: m.ts, text: m.text, file: m.file };
      if (!env.from || (env.type === 'text' && !env.text && !env.file)) return;
      pushHistory(env, false);
      emit(env.type, env); emit('message', env);
    };
    global.addEventListener('aiti-pair-msg', onPairMsg);

    // ---- Page inbox catch-up (frame-drop fallback): while the panel is visible, device polling
    // ---- piggybacks incremental pulls (frame-id dedupe), zero new timers ----
    var inboxSeq = 0;
    function pullInbox() {
      var idt = identity();
      if (!idt) return;
      fetch(base + '/bridge/pair/inbox?instanceId=' + encodeURIComponent(idt.instanceId) + '&since=' + inboxSeq)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok || !d.items || !d.items.length) { if (d && d.seq) inboxSeq = d.seq; return; }
          if (d.seq) inboxSeq = d.seq;
          d.items.forEach(function (m) {
            var env = m.env || m;
            var dup = history.some(function (h) { return h.id === env.id; });
            if (dup) return;
            pushHistory(env, false);
            emit(env.type === 'file' ? 'file' : 'text', env);
            emit('message', env);
          });
        }).catch(function () {});
    }

    // ---- Device list / inbox (event-driven: pull on ready / peer changes / unfreeze; polling as fallback) ----
    function refreshDevices() {
      return fetch(base + '/bridge/pair/devices').then(function (r) { return r.json(); }).then(function (b) {
        if (b && b.devices) {
          devices = b.devices;
          try { global.localStorage.setItem(DEVICES_CACHE_KEY, JSON.stringify({ ts: Date.now(), devices: devices })); } catch (e) {}
          emit('devices', devices);
        }
        emit('status', { state: 'connected' }); // B4: status dot reflects real bridge reachability (was always green)
        return devices;
      }).catch(function () { emit('status', { state: 'off' }); return devices; });
    }
    // ---- 发送 ----
    function sendText(to, text, opts) {
      var idt = identity();
      if (!idt) return Promise.reject(new Error('页面身份未就绪（bridge-client 未连接）'));
      // notify=true → the bridge also pops an interaction card on the target page (🔔 send); it must
      // ride the request body — dropping it made the bell button behave like a plain send.
      return http('/bridge/pair/message', { instanceId: idt.instanceId, secret: idt.secret || '', pageId: getPageId(), to: to || 'all', text: String(text || ''), notify: !!(opts && opts.notify) }).then(function (r) {
        if (!r) throw new Error('发送失败（网络）');
        if (r.ok) {
          var pid = getPageId() || idt.instanceId;
          pushHistory({ id: 'local_' + Date.now(), type: 'text', from: { id: pid, kind: 'page', name: myName || pid }, to: to || 'all', text: String(text), ts: Date.now() }, true);
        }
        return r;
      });
    }

    /** 🔔 identify request: make the target device pop a 50s self-info card (pair → pair card;
     *  degraded to agent/page receiving a text attribution) */
    // Popup message = plain text with a 🔔 prefix (existing message endpoint, lands in the chat
    // stream); identify = a user_notify command request (callUserNotify, see below).
    /** 🔔/🔎 notify & identify (via the bridge's existing MCP HTTP endpoint tools/call user_notify,
     *  stateless direct call — zero changes underneath) —
     *  only page devices (injected pages / AI windows, the aiti-user-notify coverage) can receive:
     *  interaction notify-only → the page's ready-made notify card.
     *  pair phones are not covered by this channel → the sender just sends a message (🔔/🔎 prefix
     *  text), handled locally by the receiver. */
    function callUserNotify(targetPageId, title, body, timeoutMs) {
      return fetch(base + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'pair_notify_' + Date.now(), method: 'tools/call', params: { name: 'user_notify', arguments: { title: String(title || ''), body: String(body || ''), timeout: timeoutMs || 50000, pageId: targetPageId } } })
      }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
        var payload = j && j.result && j.result.content && j.result.content[0] ? j.result.content[0].text : null;
        var parsed = null; try { parsed = payload ? JSON.parse(payload) : null; } catch (e) {}
        if (!parsed || !parsed.notified) throw new Error(parsed && parsed.error ? parsed.error : 'user_notify 失败');
        return parsed;
      });
    }

    function sendFile(to, file, onProgress) {
      var idt = identity();
      if (!idt) return Promise.reject(new Error('页面身份未就绪'));
      var mime = file.type || 'application/octet-stream';
      return http('/bridge/pair/file/init', { instanceId: idt.instanceId, secret: idt.secret || '', pageId: getPageId(), to: to || 'all', name: file.name, size: file.size, mime: mime }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'init 失败');
        var fileId = r.fileId;
        var off = 0;
        function next() {
          if (off >= file.size) return complete();
          var slice = file.slice(off, Math.min(off + CHUNK, file.size));
          return fetch(base + '/bridge/pair/file/chunk/' + fileId + '?n=' + Math.floor(off / CHUNK), { method: 'POST', body: slice })
            .then(function (resp) { return resp.json().catch(function () { return null; }); })
            .then(function (cr) {
              if (!cr || cr.error) throw new Error((cr && cr.error) || 'chunk 失败');
              off = cr.bytes;
              if (onProgress) { try { onProgress(off, file.size); } catch (e) {} }
              return next();
            });
        }
        function complete() {
          return http('/bridge/pair/file/complete/' + fileId, {}).then(function (cr) {
            if (!cr || !cr.ok) throw new Error((cr && cr.error) || 'complete 失败');
            pushHistory({ id: 'local_' + Date.now(), type: 'file', from: { id: idt.instanceId, kind: 'page', name: myName }, to: to || 'all', file: { fileId: fileId, name: file.name, size: file.size, mime: mime }, ts: Date.now() }, true);
            return { fileId: fileId };
          });
        }
        return next();
      });
    }

    function fileUrl(fileId) {
      var idt = identity();
      return base + '/bridge/pair/file/' + encodeURIComponent(fileId) + (idt ? '?instanceId=' + encodeURIComponent(idt.instanceId) + '&secret=' + encodeURIComponent(idt.secret || '') : '');
    }

    function pushHistory(env, mine) {
      // pair_msg envelope normalization (live frames and inbox catch-up share the same shape): type normalized to file/text for the render/export branches
      if (env.type === 'pair_msg') env.type = env.file ? 'file' : 'text';
      env.mine = !!mine || !!(env.from && env.from.id && String(env.from.id).split('/')[0] === getInstanceId());
      history.push(env);
      if (history.length > 500) history.splice(0, history.length - 500);
      emit('history', history);
    }

    // ---- 解冻锚点（手机后台冻结 SSE 被杀 → 回前台重建；照 bridge-client 同款三锚点） ----
    function armThawHooks() {
      if (typeof document === 'undefined' || !document.addEventListener) return;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && started) { thaw(); }
      });
      global.addEventListener('pageshow', function (e) { if (e.persisted && started) thaw(); });
      global.addEventListener('online', function () { if (started) thaw(); });
    }
    function thaw() {
      if (disposed || !started) return;
      refreshDevices(); // visibility / network recovery → refresh the device list (no dedicated SSE; REST suffices)
    }
    armThawHooks();

    function setName(name) { // B3: actually reported to the bridge (listDevices prefers custom name); localStorage keeps local display
      var clean = String(name || '').trim().slice(0, 40);
      if (!clean) return Promise.resolve({ ok: false, error: 'bad name' });
      var idt = identity();
      if (!idt) return Promise.reject(new Error('页面身份未就绪（bridge-client 未连接）'));
      return http('/bridge/pair/name', { instanceId: idt.instanceId, secret: idt.secret || '', pageId: getPageId(), name: clean }).then(function (r) {
        if (r && r.ok) { myName = r.name || clean; saveName(); }
        return r || { ok: false, error: '改名失败（网络）' };
      });
    }
    function getName() { return myName; }
    function getDevices() {
      if (devices && devices.length) return devices;
      // In-memory state lost (remount / freeze recovery) → fall back to the latest cache (10 min freshness) so the first frame already has a list
      try {
        var o = JSON.parse(global.localStorage.getItem(DEVICES_CACHE_KEY) || 'null');
        if (o && o.devices && o.devices.length && Date.now() - o.ts < 600000) return o.devices;
      } catch (e) {}
      return devices || [];
    }
    function getHistory() { return history; }

    function start() {
      if (started) return Promise.resolve();
      started = true;
      pullInbox(); // first pull (fills messages missed while offline after refresh)
      setPolling(true); // on by default (headless semantics; pi-web widget toggles via ext client on panel visibility)
      return refreshDevices();
    }
    function stop() {
      disposed = true;
      started = false;
      setPolling(false);
      global.removeEventListener('aiti-pair-msg', onPairMsg); // B5: prevents remount listener leak (phantom unread / memory growth)
    }

    // ---- Device list polling fallback (explicit user request; red-line exception approved):
    // SSE event-driven first; pulls /devices every POLL_MS during reconnect windows / missed events
    // to stay fresh. Runs only while the panel is visible (wired through setPolling) ----
    var POLL_MS = 5000;
    var pollingTimer = null;
    function setPolling(on) {
      if (on && !pollingTimer && !disposed) pollingTimer = setInterval(function () { if (!disposed) { refreshDevices(); pullInbox(); } }, POLL_MS);
      else if (!on && pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    }

    return { start: start, stop: stop, on: on, pullInbox: pullInbox, sendText: sendText, callUserNotify: callUserNotify, sendFile: sendFile, fileUrl: fileUrl, pairPageUrl: pairPageUrl, piWebBase: function () { return piWebBase; }, setName: setName, getName: getName, getDevices: getDevices, getHistory: getHistory, getInstanceId: getInstanceId, getSelfPageId: getSelfPageId, isConnected: function () { return !!identity(); }, refreshDevices: refreshDevices, setPolling: setPolling };
  }

  // ================= widget UI (mount; shared by cockpit / pi-web ext) =================
  // 主题自适配：mount 时从宿主 documentElement 读 CSS 变量（pi-web --text/--bg-panel/--accent、
  // cockpit --text/--panel name match; built-in light fallback when no host vars).
  var WIDGET_CSS = [
    '.apair{position:relative;width:100%;display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ap-fg);background:var(--ap-panel)}',
    '.apair *,.apair *::before,.apair *::after{box-sizing:border-box}',
    '.apair ::-webkit-scrollbar{width:8px;height:8px}',
    '.apair ::-webkit-scrollbar-thumb{background:var(--ap-line);border-radius:4px}',
    '.apair ::-webkit-scrollbar-thumb:hover{background:var(--ap-dim)}',
    // ---- 头部：状态点 + 本端名（ghost 输入）+ 设备数 ----
    '.apair-head{display:flex;align-items:center;gap:9px;padding:9px 12px;border-bottom:1px solid var(--ap-line);flex-shrink:0}',
    '.apair-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex-shrink:0;box-shadow:0 0 0 3px rgba(16,185,129,.16)}',
    '.apair-dot.mid{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16);animation:ap-pulse 1.2s ease-in-out infinite}',
    '.apair-dot.off{background:#9ca3af;box-shadow:none;animation:none}',
    '@keyframes ap-pulse{50%{opacity:.35}}',
    '.apair-name{flex:0 1 auto;width:158px;min-width:0;background:transparent;border:1px solid transparent;border-radius:7px;color:var(--ap-fg);padding:3px 8px;font:inherit;font-weight:600;transition:border-color .12s,background .12s}',
    '.apair-name:hover{border-color:var(--ap-line)}',
    '.apair-name:focus{outline:none;border-color:var(--ap-accent);background:var(--ap-panel)}',
    '.apair-head .sp{flex:1;min-width:0}',
    '.apair-count{font-size:10px;color:var(--ap-dim);background:var(--ap-surface);border-radius:9px;padding:2px 9px;white-space:nowrap}',
    '.apair-target{display:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;color:var(--ap-accent);cursor:pointer;border:1px solid var(--ap-line);border-radius:7px;padding:2px 8px}',
    '.apair-target::after{content:" ▼";font-size:8px;color:var(--ap-dim)}',
    '.apair-hbtn{background:transparent;border:1px solid transparent;border-radius:7px;color:var(--ap-dim);cursor:pointer;font:inherit;font-size:13px;padding:3px 6px;line-height:1;flex-shrink:0;transition:color .12s,border-color .12s}',
    '.apair-hbtn:hover{color:var(--ap-fg);border-color:var(--ap-line)}',
    '.apair-hbtn.on{color:var(--ap-accent);border-color:var(--ap-accent)}',
    '.apair-hbtn.hact{font-size:11px}',
    // ---- 侧栏设备列表 ----
    '.apair-body{display:flex;flex:1;min-height:0}',
    '.apair-side{width:176px;flex-shrink:0;border-right:1px solid var(--ap-line);overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px;background:var(--ap-page)}',
    '.apair-sidehd{display:none;align-items:center;gap:4px;font-size:10px;color:var(--ap-dim);padding:2px 4px 6px 8px;text-transform:uppercase;letter-spacing:.06em}',
    '.apair-sidehd .t{flex:1;min-width:0}',
    '.apair-flt{background:transparent;border:1px solid transparent;border-radius:5px;color:var(--ap-dim);cursor:pointer;font:inherit;font-size:9px;padding:2px 6px;line-height:1;flex-shrink:0;letter-spacing:0;transition:color .12s,border-color .12s}',
    '.apair-flt:hover{color:var(--ap-fg);border-color:var(--ap-line)}',
    '.apair-flt.on{color:var(--ap-accent);border-color:var(--ap-accent)}',
    '.apair-dev{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;min-width:0;border:1px solid transparent;transition:background .12s}',
    '.apair-dev:hover{background:var(--ap-surface)}',
    '.apair-dev.sel{background:var(--ap-accent-soft)}',
    '.apair-dev.sel .nm{color:var(--ap-accent);font-weight:600}',
    '.apair-dev .ic{width:26px;height:26px;border-radius:8px;background:var(--ap-panel);border:1px solid var(--ap-line);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}',
    '.apair-dev .nmc{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
    '.apair-dev .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;flex-shrink:0}',
    '.apair-dev .nm-info{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px;color:var(--ap-dim)}',
    '.apair-dev.off .nm{opacity:.55}',
    '.apair-dev .dot{width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0}',
    '.apair-dev .dot.off{background:#cbd5e1}',
    '.apair-dev .kd{font-size:9px;color:var(--ap-dim);flex-shrink:0;letter-spacing:.04em}',
    // The self row reuses the kind slot (its "page" kind is meaningless to the operator)
    '.apair-dev .kd.self{color:var(--ap-accent);background:var(--ap-accent-soft);border-radius:6px;padding:1px 5px;font-weight:600}',
    // ---- Device detail: inline ℹ button + grouped key-value overlay ----
    '.apair-devinfo{background:transparent;border:1px solid transparent;border-radius:6px;color:var(--ap-dim);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:5px 6px;min-width:26px;flex-shrink:0;text-align:center;transition:color .12s,background .12s;display:flex;align-items:center;justify-content:center}',
    '.apair-devinfo:hover{color:var(--ap-accent);background:var(--ap-accent-soft)}',
    '.apair-devinfo svg{display:block}',
    '.apair-dl{display:flex;flex-direction:column;min-width:0;flex:1;min-height:0;overflow-y:auto}',
    '.apair-dgrp{font-size:10px;color:var(--ap-dim);letter-spacing:.06em;padding:9px 0 3px;flex-shrink:0}',
    '.apair-dgrp:first-child{padding-top:2px}',
    '.apair-drow{display:flex;gap:10px;padding:4px 0;font-size:12px;line-height:1.5;min-width:0}',
    '.apair-drow .k{flex-shrink:0;width:82px;color:var(--ap-dim)}',
    '.apair-drow .v{flex:1;min-width:0;word-break:break-all;color:var(--ap-fg)}',
    '.apair-dbadge{display:inline-block;background:var(--ap-accent-soft);color:var(--ap-accent);border-radius:6px;padding:0 6px;font-size:10px;font-weight:600;margin-left:6px;vertical-align:1px}',
    // ---- 消息区：气泡 + 时间戳 ----
    '.apair-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--ap-page)}',
    '.apair-msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px;min-height:0}',
    '.apair-msg{max-width:78%;display:flex;flex-direction:column;gap:3px;animation:ap-in .18s ease-out}',
    '@keyframes ap-in{from{opacity:0;transform:translateY(4px)}}',
    '.apair-msg.mine{align-self:flex-end;align-items:flex-end}',
    '.apair-bub{padding:7px 11px;border-radius:12px;background:var(--ap-panel);border:1px solid var(--ap-line);word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
    '.apair-msg.mine .apair-bub{background:var(--ap-accent);border-color:transparent;color:var(--ap-accent-c);border-bottom-right-radius:4px}',
    '.apair-msg:not(.mine) .apair-bub{border-bottom-left-radius:4px}',
    '.apair-who{font-size:10px;color:var(--ap-dim);padding:0 4px}',
    '.apair-meta{font-size:9px;color:var(--ap-dim);padding:0 4px}',
    // ---- 文件卡 ----
    '.apair-file{display:flex;align-items:center;gap:9px;min-width:190px}',
    '.apair-file .fic{width:32px;height:32px;border-radius:8px;background:var(--ap-surface);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}',
    '.apair-msg.mine .apair-file .fic{background:rgba(255,255,255,.2)}',
    '.apair-file .fm{flex:1;min-width:0}',
    '.apair-file .fn{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.apair-file .fs{font-size:10px;color:var(--ap-dim)}',
    '.apair-msg.mine .apair-file .fs{color:inherit;opacity:.7}',
    '.apair-file .fb{flex-shrink:0;border:1px solid var(--ap-line);border-radius:7px;padding:4px 10px;font-size:11px;color:var(--ap-accent);cursor:pointer;text-decoration:none;background:var(--ap-panel)}',
    '.apair-file .fb:hover{border-color:var(--ap-accent)}',
    // ---- 空态 ----
    '.apair-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--ap-dim);font-size:12px;padding:26px 16px;text-align:center}',
    '.apair-empty .big{font-size:30px;opacity:.55}',
    // ---- 进度条 ----
    '.apair-prog{display:none;align-items:center;gap:9px;padding:7px 12px;font-size:11px;color:var(--ap-muted);border-top:1px solid var(--ap-line);flex-shrink:0;background:var(--ap-panel)}',
    '.apair-prog.show{display:flex}',
    '.apair-prog .t{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.apair-prog .bar{flex:1;height:4px;border-radius:2px;background:var(--ap-surface);overflow:hidden}',
    '.apair-prog .bar i{display:block;height:100%;background:var(--ap-accent);border-radius:2px;transition:width .15s}',
    // ---- 输入区 ----
    '.apair-comp{display:flex;flex-direction:column;gap:6px;padding:10px;border-top:1px solid var(--ap-line);flex-shrink:0;background:var(--ap-panel)}',
    '.apair-comp textarea{width:100%;resize:none;background:var(--ap-page);border:1px solid var(--ap-line);border-radius:10px;color:var(--ap-fg);padding:8px 10px;font:inherit;min-height:52px;max-height:110px;transition:border-color .12s,box-shadow .12s;box-sizing:border-box;display:block}',
    '.apair-comp-btns{display:flex;gap:8px;justify-content:flex-end;align-items:center}',
    '.apair-comp textarea:focus{outline:none;border-color:var(--ap-accent);box-shadow:0 0 0 3px var(--ap-accent-soft)}',
    '.apair-btn{background:var(--ap-panel);border:1px solid var(--ap-line);border-radius:9px;color:var(--ap-fg);padding:7px 12px;cursor:pointer;font:inherit;white-space:nowrap;transition:border-color .12s,filter .12s}',
    '.apair-btn:hover{border-color:var(--ap-dim)}',
    '.apair-btn.primary{background:var(--ap-accent);color:var(--ap-accent-c);border-color:transparent}',
    '.apair-btn.primary:hover{border-color:transparent;filter:brightness(1.08)}',
    '.apair-btn:disabled{opacity:.5;cursor:default}',
    // ---- 小屏（≤640）：抽屉式设备列表 + 头部紧凑 + 防横向溢出 ----
    '.apair-hbtn.side-tgl{display:none}',
    // ---- 大屏：侧栏加宽 + 气泡收窄 + 留白升级（配 aiti-pair 面板 720/900 响应式默认尺寸） ----
    '@media (min-width:1024px){.apair-side{width:212px}.apair-msg{max-width:74%}.apair-msgs{padding:16px 14px}.apair-head{padding:10px 14px}}',
    '@media (min-width:1536px){.apair-side{width:244px}.apair-msgs{padding:18px 16px}.apair-empty .big{font-size:36px}}',
    '@media (max-width:640px){',
    '  .apair-head{gap:6px;padding:8px 10px}',
  '  .apair-head .hact{display:none}',
  '  .apair-sidehd{display:flex}',
    '  .apair-name{width:auto;flex:1;min-width:0}',
    '  .apair-count{display:none}',
    '  .apair-target{display:inline-block}',
    '  .apair-hbtn.side-tgl{display:inline-flex}',
    '  .apair-side{position:absolute;top:0;bottom:0;left:0;width:min(240px,80vw);transform:translateX(-103%);transition:transform .16s ease;z-index:6;box-shadow:10px 0 28px rgba(0,0,0,.14)}',
    '  .apair.side-open .apair-side{transform:none}',
    '  .apair-side-mask{display:none;position:absolute;inset:0;background:rgba(0,0,0,.32);z-index:5}',
    '  .apair.side-open .apair-side-mask{display:block}',
    '  .apair-comp{gap:6px;padding:8px}',
    '  .apair-comp textarea{min-width:0}',
    '  .apair-msg{max-width:88%}',
    '  .apair-side svg{max-width:100%;height:auto !important}', // 空态内嵌 QR(inline 160px)收缩进抽屉
    '}',
  ].join('\n');

  /** 从宿主 documentElement 收集主题变量（缺省浅色兜底）；挂到 widget 根上局部生效 */
  function themeVars() {
    var cs = getComputedStyle(document.documentElement);
    function pick(names, fb) {
      for (var i = 0; i < names.length; i++) { var v = (cs.getPropertyValue(names[i]) || '').trim(); if (v) return v; }
      return fb;
    }
    var tv = {
      '--ap-fg': pick(['--text'], '#0f172a'),
      '--ap-muted': pick(['--text-muted', '--muted'], '#64748b'),
      '--ap-dim': pick(['--text-dim', '--dim'], '#94a3b8'),
      '--ap-line': pick(['--border'], '#e2e8f0'),
      '--ap-panel': pick(['--bg-panel', '--panel'], '#ffffff'),
      '--ap-surface': pick(['--bg-hover', '--panel2'], '#f1f5f9'),
      '--ap-page': pick(['--bg', '--panel2'], '#f8fafc'),
      '--ap-accent': pick(['--accent'], '#2563eb'),
      '--ap-accent-c': pick(['--accent-contrast'], '#ffffff'),
      '--ap-accent-soft': pick(['--accent-soft'], 'rgba(37,99,235,.10)'),
    };
    return tv;
  }

  // phone entry visibility (B8): only pi-web embedded bridge bases have a workbench deep link (pair.html retired)
  function createPairPiWeb(opts) {
    return /\/api\/extensions\/aiti-devtools\//.test(String((opts && opts.base) || ''));
  }

  function mountWidget(el, opts) {
    opts = opts || {};
    var p = createPair(opts);
    var cssId = 'apair-css';
    if (!document.getElementById(cssId)) {
      var st = document.createElement('style'); st.id = cssId; st.textContent = WIDGET_CSS;
      document.head.appendChild(st);
    }
    el.innerHTML = [
      '<div class="apair">',
      '  <div class="apair-head">',
      '    <button class="apair-hbtn side-tgl" data-act="side" title="' + T.sideTip + '">👥</button>',
      '    <span class="apair-dot"></span>',
      '    <input class="apair-name" title="' + T.selfNameTip + '" />',
      '    <span class="apair-target" data-act="side"></span>',
      '    <span class="sp"></span>',
      '    <button class="apair-hbtn hact" data-act="refresh" title="' + T.refreshTip + '">🔄</button>',
      '    <button class="apair-hbtn hact" data-act="flt" title="' + (langZh ? '显示离线设备' : 'Show offline devices') + '">在线</button>',
      '    <button class="apair-hbtn" data-act="phone" title="' + T.phoneTip + '"' + (createPairPiWeb(opts) ? '' : ' style="display:none"') + '>📱</button>',
      '    <button class="apair-hbtn" data-act="export" title="' + T.exportTip + '">⬇</button>',
      '    <span class="apair-count"></span>',
      '  </div>',
      '  <div class="apair-side-mask"></div>',
      '  <div class="apair-body">',
      '    <div class="apair-side"></div>',
      '    <div class="apair-main">',
      '      <div class="apair-msgs"></div>',
      '      <div class="apair-prog"><span class="t"></span><div class="bar"><i style="width:0%"></i></div></div>',
      '      <div class="apair-comp">',
      '        <textarea placeholder="' + T.taPlaceholder + '"></textarea>',
      '        <div class="apair-comp-btns">',
      '          <button class="apair-btn" data-act="file" title="' + T.sendFileTip + '">📎</button>',
      '          <button class="apair-btn" data-act="notify-send" title="' + T.bellTip + '">🔔</button>',
      '          <button class="apair-btn primary" data-act="send">' + T.send + '</button>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <input type="file" multiple style="display:none" />',
      '</div>',
    ].join('');
    var root = el.querySelector('.apair');
    var tv = themeVars();
    for (var k in tv) root.style.setProperty(k, tv[k]);
    var dotEl = el.querySelector('.apair-dot');
    var nameInput = el.querySelector('.apair-name');
    var countEl = el.querySelector('.apair-count');
    var sideEl = el.querySelector('.apair-side');
    var targetEl = el.querySelector('.apair-target');
    if (targetEl) targetEl.addEventListener('click', function () { root.classList.add('side-open'); p.refreshDevices(); });
    var msgsEl = el.querySelector('.apair-msgs');
    var progEl = el.querySelector('.apair-prog');
    var progT = progEl.querySelector('.t');
    var progBar = progEl.querySelector('.bar i');
    var ta = el.querySelector('textarea');
    var fileInput = el.querySelector('input[type=file]');
    var target = 'all'; // 发送目标：设备 id 或 'all'
    // Selected-target persistence (keyed by page instanceId so phone/desktop never leak into each
    // other): restored after refresh/remount, never falls back to all
    var TARGET_KEY = '__aiti_pair_target:' + (opts.base || '');
    function saveTargetSelection() {
      try { global.localStorage.setItem(TARGET_KEY, JSON.stringify({ pid: p.getSelfPageId(), target: target })); } catch (e) {}
    }
    function restoreTargetSelection() {
      try {
        var o = JSON.parse(global.localStorage.getItem(TARGET_KEY) || 'null');
        if (o && o.pid === p.getSelfPageId() && o.target) target = String(o.target);
      } catch (e) {}
    }
    var icon = { page: '🖥', agent: '💻', pair: '📲' };
    var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

    function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }
    function fmtTime(ts) {
      var d = new Date(typeof ts === 'number' ? ts : (Date.parse(ts) || Date.now()));
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    /** Same-name disambiguation tail: page rows end with "/host" (id.slice(-4) was literally "host" for
     *  every page, so two browser windows named "Linux · Edge" both rendered "Linux · Edge ·host") — prefer
     *  the canonical instanceId tail, then the id base. */
    function idTail(d) {
      var base = (d && d.instanceId) ? String(d.instanceId) : String((d && d.id) || '').split('/')[0];
      return base.slice(-4);
    }
    function targetName(id, rows) {
      if (id === 'all') return langZh ? '全部页面' : 'All pages';
      if (id === 'agents') return langZh ? '全部代理' : 'All agents';
      if (id === 'pairs') return langZh ? '全部设备' : 'All devices';
      var all = rows || p.getDevices();
      var d = all.filter(function (x) { return x.id === id; })[0];
      // Row ids for pi-web pages are pageIds whose base may differ from the bridge instanceId; after an id
      // flip the old id no longer matches a row — fall back to the canonical instanceId so labels stay readable.
      if (!d) {
        var base = String(id || '').split('/')[0];
        d = base ? all.filter(function (x) { return x.kind === 'page' && x.instanceId && x.instanceId === base; })[0] : null;
      }
      if (!d) return String(id || '').slice(0, 12);
      // 同名歧义时占位符也带 id 尾标（与列表消歧一致）
      var same = all.filter(function (x) { return x.name === d.name; }).length;
      return d.name + (same > 1 ? ' ·' + idTail(d) : '');
    }

    // 离线显示偏好（默认只显在线；持久化 localStorage）
    var showOffline = false;
    try { showOffline = global.localStorage.getItem('__aiti_pair_showOffline') === '1'; } catch (e) {}
    function setShowOffline(v) {
      showOffline = !!v;
      try { global.localStorage.setItem('__aiti_pair_showOffline', showOffline ? '1' : '0'); } catch (e) {}
      renderDevices();
    }

    /** 当前工作台会话 id（URL ?session= 随会话切换由 AppShell 维护）——用于给「自己」的 agent 打标 */
    function currentSessionId() {
      try { return new URLSearchParams(global.location.search).get('session') || ''; } catch (e) { return ''; }
    }

    // Online-status debounce (15s grace): a momentary SSE drop makes the server briefly report
    // offline, and the 5s polling amplifies that flicker into a "QR empty state ↔ device list"
    // flip-flop. Track each device's last-seen-online time locally and keep rendering it as online
    // within the grace window (offline→online applies immediately, online→offline only after 15s).
    var ONLINE_GRACE_MS = 15000;
    var onlineSeenAt = {}; // id -> ts
    function withOnlineHysteresis(list) {
      var now = Date.now();
      list.forEach(function (d) { if (d.online !== false) onlineSeenAt[d.id] = now; });
      return list.map(function (d) {
        if (d.online === false && onlineSeenAt[d.id] && now - onlineSeenAt[d.id] < ONLINE_GRACE_MS) {
          var copy = {}; for (var k in d) copy[k] = d[k]; copy.online = true; return copy;
        }
        return d;
      });
    }

    /** Device row / detail card icon: kind first (agent 🤖 / pair 📱); page by form factor (mobile/tablet → 📱, desktop → 🖥) */
    function pageIcon(d) {
      if (d.kind === 'agent') return '💻';
      if (d.kind === 'pair') return '📲';
      var dt = d.device && d.device.deviceType;
      return (dt === 'mobile' || dt === 'tablet') ? '📱' : '🖥';
    }

    function renderDevices() {
      // Dead-target self-heal: the device target points at is no longer in the unified view (id
      // drift / offline cleanup) → fall back to broadcast; otherwise sends silently fail against a
      // dead id (the placeholder would show a dead target too).
      // Self-heal triggers only when the device list is "loaded and definitely does not contain
      // target" — an empty list (not loaded / fetch failed) never touches target, otherwise every
      // refresh would first jump to "all devices" and then restore (selection flicker).
      var __devs = p.getDevices();
      // Group pseudo-targets (all/agents/pairs) are not device rows — the dead-target self-heal below must
      // never reset them, otherwise picking "All agents"/"All devices" silently bounces back to "all".
      var GROUP_TARGETS = { all: 1, agents: 1, pairs: 1 };
      if (target !== 'all' && !GROUP_TARGETS[target] && __devs.length && !__devs.some(function (d) { return d.id === target; })) {
        target = 'all';
        saveTargetSelection();
      }
      // list everything (self included, marked); no self-exclusion
      var all = withOnlineHysteresis(p.getDevices());
      var online = all.filter(function (d) { return d.online !== false; });
      var countText = online.length + ' / ' + all.length + ' 台在线';
      if (countEl.textContent !== countText) countEl.textContent = countText; // skip DOM writes when unchanged (silent refresh)
      // Header filter-button state sync (the desktop header merges device-row controls: online/all
      // toggle text and highlight; no write when unchanged)
      var headFltBtn = el.querySelector('.apair-head [data-act=flt]');
      if (headFltBtn) {
        var fltTxt = showOffline ? '全部' : '在线';
        if (headFltBtn.textContent !== fltTxt) headFltBtn.textContent = fltTxt;
        headFltBtn.classList[showOffline ? 'add' : 'remove']('on');
        headFltBtn.title = showOffline ? T.hideOfflineTip : T.showOfflineTip;
      }
      var mySession = currentSessionId();
      var myIid = p.getInstanceId();
      var selfPageId = p.getSelfPageId();
      /** This page: same pageId, or the canonical bridge instanceId (the row id may be a host pageId whose
       *  base differs from the instanceId). */
      function isSelfPage(d) {
        return d.kind === 'page' && (d.id === selfPageId || (d.instanceId && d.instanceId === myIid));
      }
      /** This workbench session's agent (id/name carries the URL session) — only used as a FALLBACK:
       *  when the page row itself is listed, marking the agent too produced two rows labelled 自己. */
      function isSelfAgent(d) {
        return !!(mySession && d.kind === 'agent' && (String(d.id).indexOf(mySession) !== -1 || String(d.name).indexOf(mySession) !== -1));
      }
      var hasSelfPageRow = all.some(isSelfPage);
      function isSelfRow(d) { return isSelfPage(d) || (!hasSelfPageRow && isSelfAgent(d)); }
      // 默认只显在线；"显示离线"开启才列出。选中的目标即使离线/被过滤也保持可见（发送目标上下文不丢）
      var list = showOffline ? all : all.filter(function (d) { return d.online !== false || d.id === target; });
      // This device is pinned to the top of the device block: with the old pure name sort it landed at the
      // bottom ("Windows · Edge" after "Linux · Chrome") and scrolled out of the narrow dock. Everything
      // else keeps the stable name/ID order (online state only colors the dot, never reorders rows).
      list.sort(function (a, b) {
        var sa = isSelfRow(a) ? 1 : 0, sb = isSelfRow(b) ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
      });
      var rows = ['<div class="apair-sidehd"><span class="t">设备</span>'
        + '<button class="apair-flt" data-act="refresh" title="刷新设备列表">🔄</button>'
        + '<button class="apair-flt' + (showOffline ? ' on' : '') + '" data-act="flt" title="' + (showOffline ? '隐藏离线设备' : '显示离线设备') + '">' + (showOffline ? '全部' : '在线') + '</button></div>'];
            var groups = [
        { id: 'all', ic: '📄', nm: langZh ? '全部页面' : 'All pages', tip: langZh ? '群发：全部浏览器页面' : 'Broadcast: all browser pages' },
        { id: 'agents', ic: '🤖', nm: langZh ? '全部代理' : 'All agents', tip: langZh ? '群发：全部 agent 会话' : 'Broadcast: all agents' },
        { id: 'pairs', ic: '📱', nm: langZh ? '全部设备' : 'All devices', tip: langZh ? '群发：全部 pair 设备' : 'Broadcast: all pair devices' },
      ];
      groups.forEach(function (g) {
        rows.push('<div class="apair-dev' + (target === g.id ? ' sel' : '') + '" data-id="' + g.id + '" title="' + g.tip + '">'
          + '<span class="ic">' + g.ic + '</span><span class="nm">' + g.nm + '</span></div>');
      });
      if (!list.length) {
        rows.push('<div style="font-size:11px;color:var(--ap-dim);padding:8px 4px;text-align:center;line-height:1.6">暂无在线设备</div>');
      } else {
        // 同名消歧：同默认名的设备（多标签/多来源/同 CLI 多会话）追加 id 尾标区分，
        // 否则列表看起来全是重复项（name 相同时 cwd 副标题窄屏又看不见）。
        // The self row is excluded from the count: it already carries the 自己 badge, and an id tail on your
        // own row ("Windows · Edge ·8f3a") only looked like a duplicate device.
        var nameCount = {};
        list.forEach(function (d) { if (!isSelfRow(d)) nameCount[d.name] = (nameCount[d.name] || 0) + 1; });
        list.forEach(function (d) {
          var on = d.online !== false;
          var isSelf = isSelfRow(d);
          // Self row: device label + kind are noise for the operator ("Edge · Windows · 1536x864 · page" says
          // nothing about yourself) — keep the editable device name and the 自己 badge only.
          var info = isSelf ? '' : (d.deviceLabel || d.cwd || '');
          var dup = !isSelf && nameCount[d.name] > 1;
          var nm = d.name + (dup ? ' <span style="color:var(--ap-dim);font-weight:400">·' + esc(idTail(d)) + '</span>' : '');
          rows.push('<div class="apair-dev' + (d.id === target ? ' sel' : '') + (!on ? ' off' : '') + '" data-id="' + esc(d.id) + '" title="' + esc(d.name) + (info ? ' · ' + info : '') + (on ? '' : '（离线）') + '">'
            + '<span class="ic">' + pageIcon(d) + '</span>'
            + '<span class="nmc"><span class="nm">' + nm + '</span>'
            + (info ? '<span class="nm-info">' + esc(info.slice(0, 40)) + '</span>' : '')
            + '</span>'
            + '<button class="apair-devinfo" data-info="' + esc(d.id) + '" title="设备详情"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></button>'
            + '<span class="dot' + (!on ? ' off' : '') + '"></span>'
            // 自己 occupies the kind slot: "page" tells the operator nothing about their own device
            + '<span class="kd' + (isSelf ? ' self' : '') + '">' + esc(isSelf ? SELF_LABEL : kindLabel(d.kind)) + '</span></div>');
        });
      }
      var html = rows.join('');
      // Empty-state grace: if a device list was rendered within the last 30s, a momentary all-empty
      // (bridge restart / fed relay flap etc.) keeps the last list instead of switching to the empty state
      if (!list.length) {
        if (sideEl.__lastHtml && sideEl.__lastHtml.indexOf('apair-dev" data-id') !== -1 && Date.now() - (sideEl.__lastNonEmptyAt || 0) < 30000) return;
      } else {
        sideEl.__lastNonEmptyAt = Date.now();
      }
      if (sideEl.__lastHtml !== html) { // silent refresh: zero DOM ops when content unchanged; scroll position preserved on change (selection is driven by target, unaffected by refresh)
        var st = sideEl.scrollTop;
        sideEl.innerHTML = html;
        sideEl.scrollTop = st;
        sideEl.__lastHtml = html;
      }
      var ph = T.msgTo + targetName(target, all) + '…';
      if (ta.placeholder !== ph) ta.placeholder = ph;
      // Small screens show the current send target at the top (tap opens the device-list drawer; hidden on desktop)
      var off = '';
      if (target !== 'all') {
        var td = all.filter(function (x) { return x.id === target; })[0]; // row after hysteresis (no flapping on weak networks)
        if (td && td.online === false) off = T.offlineSuffix;
      }
      var tt = targetName(target, all) + off;
      if (targetEl && targetEl.textContent !== tt) targetEl.textContent = tt;
    }
    sideEl.addEventListener('click', function (e) {
      var rfr = e.target.closest && e.target.closest('[data-act=refresh]');
      if (rfr) { p.refreshDevices(); return; }
      var flt = e.target.closest && e.target.closest('[data-act=flt]');
      if (flt) { setShowOffline(!showOffline); return; }
      var infoBtn = e.target.closest && e.target.closest('.apair-devinfo[data-info]');
      if (infoBtn) { toggleDeviceDetail(infoBtn.getAttribute('data-info')); return; } // detail button: never changes the send target
      var row = e.target.closest && e.target.closest('.apair-dev');
      if (!row) return;
      // QR 占位行不是发送目标——误点会把 target 静默改成 __qr__（消息从此发丢）
      if (row.getAttribute('data-id') === '__qr__') return;
      target = row.getAttribute('data-id');
      saveTargetSelection();
      renderDevices();
      // 小屏抽屉：选中设备即收起（mobileMq 与 CSS 媒体块同阈值；非小屏 no-op）
      if (mobileMq && mobileMq.matches) root.classList.remove('side-open');
    });

    function renderMsgs() {
      var hist = p.getHistory();
      if (!hist.length) {
        msgsEl.innerHTML = '<div class="apair-empty"><div class="big">💬</div><div>' + (langZh ? '消息零服务端留存：设备在线直投<br>目标离线不排队，消息将丢弃' : 'Messages relay live with zero server retention.<br>Offline targets do not queue — messages are dropped') + '</div></div>';
        return;
      }
      msgsEl.innerHTML = hist.map(function (m) {
        var mine = !!m.mine;
        var time = fmtTime(m.ts);
        var inner;
        if (m.type === 'file' && m.file) {
          inner = '<div class="apair-file"><span class="fic">📄</span><div class="fm"><div class="fn">' + esc(m.file.name) + '</div><div class="fs">' + fmtSize(m.file.size) + ' · ' + esc(targetName(m.to)) + '</div></div>'
            + '<span class="fb" data-fid="' + esc(m.file.fileId) + '" data-fn="' + esc(m.file.name) + '">' + T.save + '</span>' + '</div>';
        } else {
          inner = '<div class="apair-bub">' + esc(m.text || '') + '</div>';
        }
        // targetName(m.to) is deliberate: `all` only exists inside renderDevices/targetName, and a bare
        // reference here threw ReferenceError for every RECEIVED message (the sender's own echo took the
        // `mine` short-circuit, so the bug only showed on the receiving side). emit() swallows listener
        // errors, so the failure was silent: uplink worked, the peer's chat pane stayed empty.
        var who = mine ? '' : '<div class="apair-who">' + esc((m.from && m.from.name) || '?') + ' → ' + esc(targetName(m.to)) + '</div>';
        return '<div class="apair-msg' + (mine ? ' mine' : '') + '">' + who + inner + '<div class="apair-meta">' + time + '</div></div>';
      }).join('');
      // B7: autoscroll only when user is near the bottom (<=40px) — reading history is not yanked down
      var nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40;
      msgsEl.scrollTop = nearBottom ? msgsEl.scrollHeight : msgsEl.scrollTop;
    }
    msgsEl.addEventListener('click', function (e) {
      var fb = e.target.closest && e.target.closest('.fb');
      if (!fb) return;
      var a = document.createElement('a');
      a.href = p.fileUrl(fb.getAttribute('data-fid'));
      a.download = fb.getAttribute('data-fn') || '';
      document.body.appendChild(a); a.click(); a.remove();
    });

    function toast_(text) {
      progEl.classList.add('show');
      progT.textContent = text;
      progBar.style.width = '0%';
      clearTimeout(toast_._t);
      toast_._t = setTimeout(function () { progEl.classList.remove('show'); }, 4000);
    }

    /** ℹ Device detail overlay: all fields of the unified device view in grouped sections
     *  (connection / system & browser / hardware / page / agent / identity; copyable IDs,
     *  one-tap open-session) */
    function toggleDeviceDetail(id) {
      var existing = document.getElementById('apair-dev-detail');
      if (existing) { existing.remove(); return; }
      var d = p.getDevices().filter(function (x) { return String(x.id) === String(id); })[0];
      if (!d) { toast_('设备已不在列表'); return; }
      var rows = [];
      var grp = function (t) { rows.push('<div class="apair-dgrp">' + esc(t) + '</div>'); };
      var kv = function (k, v, badge) {
        if (v === null || v === undefined || v === '') return;
        rows.push('<div class="apair-drow"><span class="k">' + esc(k) + '</span><span class="v">' + esc(String(v)) + (badge ? '<span class="apair-dbadge">' + esc(badge) + '</span>' : '') + '</span></div>');
      };
      var kindCn = langZh ? { page: '注入页面', agent: 'Agent 会话', pair: '配对设备' } : { page: 'Injected page', agent: 'Agent session', pair: 'Paired device' };
      var on = d.online !== false;
      var ipPrivate = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/;
      grp('连接');
      rows.push('<div class="apair-drow"><span class="k">当前状态</span><span class="v"><span style="color:' + (on ? '#10b981' : '#94a3b8') + '">●</span> ' + (on ? '在线' : ('离线' + (d.offlineAt ? '（' + fmtFull(d.offlineAt) + ' 起）' : ''))) + '</span></div>');
      if (d.lastSeen) kv('最后活跃', fmtFull(d.lastSeen));
      if (d.ip) kv('来源 IP', d.ip, ipPrivate.test(d.ip) ? '内网' : '公网');
      if (d.regAt) kv('首次接入', fmtFull(d.regAt));
      if (d.pending != null) kv('排队消息', d.pending + ' 条（掉线暂存，上线即投）');
      var dev = d.device && typeof d.device === 'object' ? d.device : null;
      if (dev && ((dev.browser && dev.browser !== '?') || (dev.os && dev.os !== '?'))) {
        grp('系统与浏览器');
        kv('浏览器', dev.browser && dev.browser !== '?' ? dev.browser + (dev.version ? ' ' + dev.version : '') : null);
        kv('操作系统', dev.os && dev.os !== '?' ? dev.os + (dev.osVer ? ' ' + dev.osVer : '') : null);
        kv('设备形态', dev.deviceType || null);
        if (dev.webdriver) kv('自动化', 'webdriver=true（自动化控制中）');
      }
      if (dev && (dev.screen || dev.cores || dev.mem != null)) {
        grp('硬件');
        if (dev.screen) kv('屏幕', String(dev.screen) + (dev.dpr ? ' @' + dev.dpr + 'x' : ''));
        if (dev.viewport) kv('视口', String(dev.viewport));
        if (dev.cores || dev.mem) kv('CPU / 内存', (dev.cores ? dev.cores + ' 核' : '') + (dev.cores && dev.mem ? ' / ' : '') + (dev.mem ? dev.mem + 'GB' : ''));
        if (dev.touch) kv('触摸点', String(dev.touch));
        kv('语言 / 时区', dev.lang && dev.tz ? dev.lang + ' · ' + dev.tz : (dev.lang || dev.tz || null));
      }
      kv('UA', d.ua || null);
      if (d.url || d.title) {
        grp('页面');
        kv('URL', d.url || null);
        kv('标题', d.title || null);
      }
      if (d.cwd || d.source || d.transportKind || d.sessionId) {
        grp('Agent');
        kv('会话', d.sessionId ? String(d.sessionId).slice(0, 18) + (String(d.sessionId).length > 18 ? '…' : '') : null);
        kv('工作目录', d.cwd || null);
        kv('接入方式', d.source || null);
        kv('传输通道', d.transportKind || null);
      }
      grp('标识');
      rows.push('<div class="apair-drow"><span class="k">设备 ID</span><span class="v"><span style="word-break:break-all">' + esc(String(d.id)) + '</span> <button class="apair-flt" data-act="id-copy" style="border-color:var(--ap-line)">' + T.copyRow + '</button></span></div>');
      // No skin/backdrop: the card is the overlay itself (fixed top-right default, drag freely by
      // the header) — never blocks interaction with the page underneath
      var cardW = Math.min(460, Math.round(global.innerWidth * 0.92));
      var panel = document.createElement('div');
      panel.id = 'apair-dev-detail';
      panel.setAttribute('data-ext-float', '1');
      panel.setAttribute('data-ext-float-key', 'aiti-pair:detail');
      panel.setAttribute('data-ext-float-w', String(cardW));
      panel.setAttribute('data-ext-float-h', String(Math.min(Math.round(global.innerHeight * 0.7), 560)));
      var cardH = Math.min(Math.round(global.innerHeight * 0.86), Math.round(global.innerHeight - 96));
    panel.style.cssText = 'position:fixed;left:' + Math.max(12, global.innerWidth - cardW - 28) + 'px;top:84px;background:var(--ap-panel,#fff);color:var(--ap-fg,#111);border:1px solid var(--ap-line);border-radius:12px;padding:14px 16px;width:' + cardW + 'px;height:' + cardH + 'px;display:flex;flex-direction:column;gap:6px;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden'
      panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;cursor:grab;user-select:none"><span style="font-size:16px">' + pageIcon(d) + '</span>'
        + '<span style="font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(d.name) + '</span>'
        + '<span style="font-size:10px;color:var(--ap-dim);flex-shrink:0">' + esc(kindCn[d.kind] || d.kind) + (d.fed ? ' · 联邦桥' : '') + '</span>'
        + '<span style="width:8px;height:8px;border-radius:50%;background:' + (on ? '#10b981' : '#cbd5e1') + ';flex-shrink:0"></span>'
        + '<button class="apair-btn" data-act="detail-close" style="padding:2px 9px;font-size:12px">✕</button></div>'
        + '<div class="apair-dl">' + rows.join('') + '</div>'
        + '<div style="display:flex;gap:8px;margin-top:4px"><button class="apair-btn primary" data-act="detail-send" style="flex:1">💬 ' + T.dm + '</button>'
        + '<button class="apair-btn" data-act="detail-identify" style="flex:1">🔔 ' + T.identify + '</button></div>';
      document.body.appendChild(panel);
      panel.addEventListener('click', function (e) {
        var act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'detail-close') panel.remove();
        if (act === 'detail-send') {
          target = String(d.id);
          saveTargetSelection();
          renderDevices();
          panel.remove();
          if (mobileMq && mobileMq.matches) root.classList.remove('side-open');
          toast_('已选中 ' + d.name + (on ? '' : '（离线，消息将暂存）'));
        }
        if (act === 'detail-identify') {
          var dev = d.device || {};
          // each field appears exactly once: browser (+version) · OS (+version) · screen · form factor · full page ID
          var parts = [];
          if (dev.browser) parts.push(dev.browser + (dev.version ? ' ' + dev.version : ''));
          if (dev.os) parts.push(dev.os + (dev.osVer ? ' ' + dev.osVer : ''));
          if (dev.screen) parts.push(String(dev.screen));
          if (dev.deviceType && dev.deviceType !== 'desktop') parts.push(String(dev.deviceType));
          parts.push('ID: ' + String(d.id || ''));
          var summary = parts.join('  ·  ');
          // identify = a user_notify command request (aiti-user-notify channel, card auto-closes after
          // 50s), content = the device's own info; only page devices (injected pages / AI windows) are
          // covered by this channel — if the target is not covered (e.g. a pair phone), show a hint instead
          if (d.kind !== 'page') { toast_('该设备不在 aiti-user-notify 通知通道内'); }
          else {
            p.callUserNotify(d.id, '🔎 找到我了——就是这台设备', (d.name || '') + '  ' + summary, 50000)
              .then(function () { panel.remove(); toast_('🔔 识别请求已发给 ' + d.name); })
              .catch(function (e) { toast_('识别发送失败：' + ((e && e.message) || e)); });
          }
        }
        if (act === 'id-copy') {
          var txt = String(d.id);
          try { navigator.clipboard.writeText(txt).then(function () { toast_('✓ ID 已复制'); }, function () { toast_(txt); }); } catch (err) { toast_(txt); }
        }
      });
    }

    function fmtFull(ts) {
      var n = typeof ts === 'number' ? ts : (Date.parse(ts) || Date.now());
      var d = new Date(n);
      var sameDay = new Date().toDateString() === d.toDateString();
      var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      return sameDay ? '今天 ' + hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    }

    /** 📱 扫码面板：二维码 + URL + 复制（QR 内容 = 工作台深链 / pair 入口；大屏 QR 放大） */
    /** phone entry (B8): prefers the opts.openOnPhone hook (service-tunnels Open-on-Phone QR with params);
     *  fallback = link + copy panel (no QR image — no vendored QR generation anymore). */
    function toggleQrPanel() {
      var url = p.pairPageUrl();
      if (typeof opts.openOnPhone === 'function') {
        try {
          var r = opts.openOnPhone(url);
          if (r && typeof r.catch === 'function') r.catch(function () { fallbackPhonePanel(url); });
          return;
        } catch (e) { /* hook error -> fallback */ }
      }
      fallbackPhonePanel(url);
    }
    function fallbackPhonePanel(url) {
      var existing = document.getElementById('apair-qr-panel');
      if (existing) { existing.remove(); return; }
      var big = global.matchMedia && global.matchMedia('(min-width:1024px)').matches;
      var panel = document.createElement('div');
      panel.id = 'apair-qr-panel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:16px';
      panel.innerHTML = '<div style="background:var(--ap-panel,#fff);border-radius:12px;padding:18px;display:flex;flex-direction:column;align-items:center;gap:10px;max-width:92vw">'
        + '<div style="font-size:13px;font-weight:600;color:var(--ap-fg,#111)">📱 手机接入（降级：无出码服务）</div>'
        + '<div style="font-size:11px;color:var(--ap-muted,#666);word-break:break-all;text-align:center;max-width:' + (big ? '420px' : '260px') + '">' + esc(url) + '</div>'
        + '<div style="font-size:10px;color:var(--ap-dim)">手机打开此链接即弹出设备互连面板（?pair=1 深链）</div>'
        + '<button class="apair-btn primary" data-act="qr-copy">复制链接</button>'
        + '<button class="apair-btn" data-act="qr-close">关闭</button>'
        + '</div>';
      document.body.appendChild(panel);
      panel.addEventListener('click', function (e) {
        if (e.target === panel) { panel.remove(); return; }
        var act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'qr-close') panel.remove();
        if (act === 'qr-copy') {
          try { navigator.clipboard.writeText(url).then(function () { toast_('✓ 已复制'); }, function () { toast_('复制失败——请手动输入'); }); } catch (err) { toast_(url); }
        }
      });
    }

    function exportMd() {
      var hist = p.getHistory();
      if (!hist.length) { toast_(T.exportNone); return; }
      var lines = ['# pair 聊天导出', '', '- 导出时间：' + new Date().toLocaleString(), '- 本端：' + (p.getName() || '?'), ''];
      hist.forEach(function (m) {
        var time = new Date(m.ts || Date.now()).toLocaleString();
        var who = m.mine ? '我' : ((m.from && m.from.name) || '?');
        var to = targetName(m.to);
        if (m.type === 'file' && m.file) lines.push('- **[' + time + '] ' + who + ' → ' + to + '** · 📄 ' + m.file.name + '（' + fmtSize(m.file.size) + '）');
        else lines.push('- **[' + time + '] ' + who + ' → ' + to + '**：' + String(m.text || '').replace(/\n/g, '\n  '));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pair-chat-' + new Date().toISOString().slice(0, 10) + '.md';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 3000);
      toast_(T.exportDone + hist.length + ' 条（Markdown）');
    }

    function doSend() {
      var text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      // 防御：QR 占位 id 混进 target 时回退群发（正常流已在点击侧排除）
      var to = target === '__qr__' ? 'all' : target;
      p.sendText(to, text).then(function (r) {
        if (!r) { progEl.classList.add('show'); progT.textContent = '⚠ 发送失败（网络）'; progBar.style.width = '0%'; return; }
        if (r.candidates && r.candidates.length) { // B1: ambiguous target -> ask to pick (message rejected)
          progEl.classList.add('show');
          progT.textContent = '⚠ 目标匹配多个：' + r.candidates.map(function (c) { return c.name || c.id; }).join('、');
          progBar.style.width = '0%';
        } else if (!r.ok) { // B1: failures must be visible (previously silent — input cleared with zero feedback)
          progEl.classList.add('show');
          progT.textContent = '⚠ 发送失败：' + (r.error || '目标不可达') + '（离线设备不排队，消息已丢弃）';
          progBar.style.width = '0%';
        }
      }).catch(function (e) { progEl.classList.add('show'); progT.textContent = '⚠ ' + (e.message || e); });
    }
    /** 🔔 popup send: text goes through the regular message flow (interaction channel, visible
     *  bubble) + page devices additionally get a user_notify popup card */
    function doNotifySend() {
      var text = ta.value.trim();
      if (!text) { toast_('先输入要弹窗的消息'); return; }
      var to = target === '__qr__' ? 'all' : target;
      // 🔔: sendText({notify:true}) → bridge-side interaction notify card (popup on the receiving
      // page) + pair_* dispatch into both sides' chat streams
      p.sendText(to, text, { notify: true }).then(function () {
        ta.value = '';
        renderMsgs();
        toast_('🔔 已弹窗发送 → ' + targetName(to));
      }).catch(function (e) { toast_('⚠ ' + ((e && e.message) || e)); });
    }
    el.querySelector('[data-act=send]').addEventListener('click', doSend);
    el.querySelector('[data-act=notify-send]').addEventListener('click', doNotifySend);
    el.querySelector('[data-act=phone]').addEventListener('click', toggleQrPanel);
    el.querySelector('[data-act=export]').addEventListener('click', exportMd);
    // Header device-row merged controls (desktop): refresh / online-all toggle (hidden on small
    // screens; the same-named controls in the drawer take over)
    var headRefresh = el.querySelector('.apair-head [data-act=refresh]');
    if (headRefresh) headRefresh.addEventListener('click', function () { p.refreshDevices(); });
    var headFlt = el.querySelector('.apair-head [data-act=flt]');
    if (headFlt) headFlt.addEventListener('click', function () { setShowOffline(!showOffline); });
    el.querySelector('[data-act=side]').addEventListener('click', function () { root.classList.toggle('side-open'); p.refreshDevices(); });
    // Small-screen drawer: tapping the backdrop (blank area) collapses it — no need to pick a device just to go back
    var sideMask = el.querySelector('.apair-side-mask');
    if (sideMask) sideMask.addEventListener('click', function () { root.classList.remove('side-open'); });
    // 小屏抽屉：选中设备即收起（matchMedia 与 CSS 媒体块同阈值）
    var mobileMq = global.matchMedia ? global.matchMedia('(max-width:640px)') : null;
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    el.querySelector('[data-act=file]').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = [].slice.call(fileInput.files || []);
      fileInput.value = '';
      (function sendNext() {
        var f = files.shift();
        if (!f) { setTimeout(function () { progEl.classList.remove('show'); }, 600); return; }
        progEl.classList.add('show');
        progT.textContent = '⬆ ' + f.name;
        progBar.style.width = '0%';
        p.sendFile(target === '__qr__' ? 'all' : target, f, function (done, total) {
          progBar.style.width = Math.round((done / total) * 100) + '%';
        }).then(function () { progBar.style.width = '100%'; renderMsgs(); sendNext(); })
          .catch(function (e) { progT.textContent = '⚠ ' + f.name + '：' + (e.message || e); });
      })();
    });
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        p.setName(nameInput.value.trim()).then(function (r) {
          progEl.classList.add('show');
          progT.textContent = r && r.ok ? '✓ 设备名已更新（全桥可见）' : '⚠ ' + ((r && r.error) || '改名失败');
          progBar.style.width = '0%';
          setTimeout(function () { progEl.classList.remove('show'); }, 1200);
          if (r && r.ok) { nameInput.value = r.name || nameInput.value.trim(); renderDevices(); }
        }).catch(function (e) { progEl.classList.add('show'); progT.textContent = '⚠ ' + (e.message || e); progBar.style.width = '0%'; });
      }
    });

    // 浏览器通知：标签页不在前台 + 有新消息 → Notification API（首次触发权限请求）
    var notifRequested = false;
    p.on('message', function (m) {
      if (m.mine) return;
      if (document.hasFocus && document.hasFocus()) return; // 前台不通知
      try {
        if (!notifRequested && typeof global.Notification !== 'undefined' && global.Notification.permission === 'default') {
          notifRequested = true;
          global.Notification.requestPermission();
        }
        if (global.Notification && global.Notification.permission === 'granted') {
          var n = new global.Notification((m.from && m.from.name) || '设备互连', {
            body: m.type === 'file' ? '📎 ' + (m.file && m.file.name || '') : String(m.text || '').slice(0, 100),
            tag: 'apair-' + m.id,
          });
          n.onclick = function () { global.focus(); n.close(); };
          setTimeout(function () { n.close(); }, 8000);
        }
      } catch (e) {}
    });
    p.on('devices', renderDevices);
    p.on('history', renderMsgs);
    p.on('status', function (s) {
      dotEl.className = 'apair-dot' + (s.state === 'connected' ? '' : (s.state === 'reconnecting' ? ' mid' : ' off'));
      dotEl.title = s.state === 'connected' ? '已连接' : (s.state === 'off' ? '桥不可达' : '重连中');
    });

    if (opts.name) nameInput.value = opts.name;
    p.on('devices', function () { if (!nameInput.value) nameInput.value = p.getName() || ''; });
    renderDevices();
    renderMsgs(); // 初始空态（history 事件仅在首条消息时触发）
    p.start().then(function () {
      restoreTargetSelection(); // restore the last selection once the page identity is ready; the subsequent devices event re-renders with it
      renderDevices();
    });
    return p;
  }

  global.AitiPair = { create: createPair, mount: mountWidget };
})(window);
