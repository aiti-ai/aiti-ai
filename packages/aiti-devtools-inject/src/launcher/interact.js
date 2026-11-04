// interact 子系统（ctx 模式）：AI ↔ 人在页面上协作的交互工具
//   - 浏览器通知：交互消息到达时 Notification API + 标题闪烁 + 提示音（用户可能在其他标签页）
//   - pick_element：收起 AI 窗 → 进入点选（宿主+iframe 广播）→ 弹点选面板（✓ 确认 / ✕ 拒绝 / 超时）
//   - 其余 Q&A（confirm/choose/input/presence）：AI 窗口渲染作答卡（ai.html）；宿主通知；
//     AI 窗未连接时宿主兜底渲染问答面板
// 结果回桥：window.postMessage dbg_mcp_result → MINI client postBridgeResult → POST /bridge/result
import { el, escapeHtml } from './dom.js';
import { dbgMsg } from './protocol.js';
import { isTouchDevice, detectScreenMode, getPhysViewport, capVisW, placePhysPanel, _fixedVisual } from './viewport.js';
import { makePointerDrag } from './drag.js';

// 可读回答描述（异步交互 user_answer 事件文案）。
// AI 窗 cockpit.html 有同语义实现（吃整 result 含 status）；这里适配 launcher 侧入参（直接传 value 层），
// 并覆盖多选（indexes/labels）——finishAsk 异步分支调用，仅 answered 态进入，无需 status 分支。
function describeAnswer(kind, v) {
  v = v || {};
  if (kind === 'confirm') return v.approved === false ? '❌ 否' : '✅ 是';
  if (kind === 'choose') {
    if (Array.isArray(v.indexes)) return (v.labels && v.labels.length) ? v.labels.join('、') : (v.indexes.length + ' 项');
    return (v.custom || v.index === -1) ? '✍️ 都不适合' : String(v.label != null ? v.label : v.index);
  }
  if (kind === 'input') return String(v.text || '');
  if (kind === 'presence') return v.present === false ? '⏳ 稍后' : '🙋 我在';
  if (kind === 'pick_element') {
    if (v.tag || v.text) return '🎯 <' + (v.tag || '?') + '>' + (v.text ? ' ' + String(v.text).trim().slice(0, 40) : '');
    return '🎯 已选元素';
  }
  return '✅ 已作答';
}

export function initInteract(ctx) {
  // HUD 小屏位置偏移记忆（▲ 上移避开遮挡 / ▼ 下移回贴底 → localStorage 持久化）
  ctx.hudSmallOffset = 0;
  try { ctx.hudSmallOffset = parseInt(localStorage.getItem('__dbg_hud_off') || '0', 10) || 0; } catch (e) {}
  ctx.adjustHudOffset = function (dy) {
    try {
      var vp = getPhysViewport();
      var visVh = _fixedVisual ? ((window.visualViewport && window.visualViewport.height) || window.innerHeight)
                               : (window.innerHeight * vp.scaleY);
      // 偏移上限 = 可视高 - 底部余量（防止把 HUD 推出屏幕顶）
      var maxOff = Math.max(0, Math.round(visVh) - 120);
      ctx.hudSmallOffset = Math.min(Math.max((ctx.hudSmallOffset || 0) + dy, 0), maxOff);
      try { localStorage.setItem('__dbg_hud_off', String(ctx.hudSmallOffset)); } catch (e) {}
    } catch (e) {}
  };
  // 短暂提示（toast）：交互到达时提示用户，几秒自动消失——不阻塞、不弹确认窗（用户要求）
  ctx.showPickToast = function (html, ms) {
    try {
      var olds = ctx.root.querySelectorAll('.dbg-pick-toast');
      for (var i = 0; i < olds.length; i++) { if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]); }
      var t = el('div', { class: 'dbg-pick-toast' });
      t.innerHTML = html;
      ctx.root.appendChild(t);
      placePhysPanel(t, { visW: Math.min(360, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 30, maxWidth: '360px', overflowY: '' });
      setTimeout(function () {
        t.style.opacity = '0';
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 450);
      }, ms || 4500);
    } catch (e) {}
  };
  // 小屏进入点选：底部 toast 提示“点击元素选择”（inspect 入口统一调用）
  ctx.showPickHint = function () {
    try {
      if (!detectScreenMode().small) return;
      ctx.showPickToast('🖱 点击页面元素选择<br><span style="color:#a5b4fc;font-size:11px">点选后工具条 ✓ 确认发送</span>');
    } catch (e) {}
  };

  // ---- 浏览器通知（Notification API + 标题闪烁 + 提示音） ----
  ctx.NOTIFY = { timer: null, origTitle: document.title, audio: null };
  ctx.notifyUser = function (title, body) {
    var shown = false; // 系统通知是否真正弹出（授权 + 创建成功）
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        try {
          var n = new Notification(title, { body: body || '', tag: 'aiti-interact', renotify: true });
          n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
          shown = true;
        } catch (e) {}
      } else if (Notification.permission !== 'denied') {
        // 未决：静默请求一次权限（浏览器可能要求用户手势，失败不阻塞交互面板本身）
        try { Notification.requestPermission().then(function (p) { if (p === 'granted') ctx.notifyUser(title, body); }); } catch (e) {}
      }
    }
    // 兜底降级：系统通知未弹出（权限被拒/不可用）→ 页面内 toast 兜底，保证用户一定看到；
    // 页面不可见时额外标题闪烁 + 提示音（toast 在别的标签页看不到）
    if (!shown) {
      try { ctx.showPickToast('🔔 ' + title + (body ? '<br>' + body : ''), 6000); } catch (e) {}
      if (document.hidden) { ctx.flashTitle('🔔 ' + title); ctx.beepAttention(); }
    }
  };
  ctx.flashTitle = function (prefix) {
    var orig = ctx.NOTIFY.origTitle || document.title;
    var on = true;
    if (ctx.NOTIFY.timer) clearInterval(ctx.NOTIFY.timer);
    ctx.NOTIFY.timer = setInterval(function () {
      document.title = on ? prefix + ' · ' + orig : orig;
      on = !on;
    }, 900);
    setTimeout(ctx.stopTitleFlash, 30000);
  };
  ctx.stopTitleFlash = function () {
    if (ctx.NOTIFY.timer) { clearInterval(ctx.NOTIFY.timer); ctx.NOTIFY.timer = null; document.title = ctx.NOTIFY.origTitle || ''; }
  };
  window.addEventListener('focus', ctx.stopTitleFlash);
  ctx.beepAttention = function () {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx.NOTIFY.audio) ctx.NOTIFY.audio = new AC();
      var ac = ctx.NOTIFY.audio;
      if (ac.state === 'suspended') ac.resume();
      [[880, 0, .12], [660, .16, .18]].forEach(function (t) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = t[0]; g.gain.value = .06;
        o.connect(g); g.connect(ac.destination);
        o.start(ac.currentTime + t[1]); o.stop(ac.currentTime + t[1] + t[2]);
      });
    } catch (e) {}
  };

  // ---- 交互结果回桥（AI 主窗口直接回 / 宿主经 AI 窗转发 → POST /bridge/result） ----
  ctx.sendInteractionResult = function (requestId, result) {
    // 回桥优先级：
    //   1) 本窗口有 BridgeClient（AI 主窗口连桥，自己就是桥端点）→ 直接 postResult（pageId 空走兼容 token，绕过非 idRegistry 实例）
    //   2) 宿主页面（不连桥）→ postToAi 经 AI 窗转发 → AI 窗 BridgeClient → 桥
    // 修复：此前一律 postToAi——AI 主窗口无 popup/iframe target 时静默丢弃 → 用户作答后 AI 仍超时。
    var ok = result.status !== 'timeout';
    try {
      if (global.BridgeClient && typeof global.BridgeClient.postResult === 'function') { global.BridgeClient.postResult(requestId, ok, result); return; }
    } catch (e) {}
    try { ctx.postToAi(dbgMsg({ type: 'dbg_mcp_result', payload: { requestId: requestId, ok: ok, result: result } })); } catch (e) {}
  };
  // 宿主 → 桥事件（经 AI 窗 BridgeClient.postEvent → POST /bridge/event——桥的唯一浏览器端点是 AI 窗，
  // 页面与桥零直接连接；AI 窗未开/未就绪时事件丢弃，client 侧环形缓冲不重放（频控在桥侧））
  ctx.postBridgeEvent = function (type, payload) {
    try { ctx.postToAi(dbgMsg({ type: 'dbg_bridge_event', payload: { type: type, payload: payload || {} } })); } catch (e) {}
  };
  // 交互倒计时控制（暂停/继续）：经 MINI client postBridgeControl → POST /bridge/interaction（服务器同步暂停计时）
  ctx.sendInteractionControl = function (requestId, action) {
    // 同上协议：控制一律经 AI 窗回桥，不向自身投递
    try { ctx.postToAi(dbgMsg({ type: 'dbg_mcp_interaction_control', payload: { requestId: requestId, action: action } })); } catch (e) {}
  };

  // 交互超时模型（timeout 可选，非默认）：AI 不传 timeout → 永久等待——面板常驻直到用户操作，不读秒不超时；
  // AI 明确传 timeout → 面板显示 ⏱ 读秒倒计时（可暂停，服务器同步计时），到点超时结算。
  // 各面板按 it.timeoutMs>0 自行分支，无需共享控件。

  // ---- 点选面板状态（pick_element）：面板 + 双区点选 ----
  ctx.pickPanel = null;
  ctx.hideAiForPick = function () { ctx.aiOpen = false; ctx.showAi(false); ctx.aiBtn.classList.remove('dbg-on'); };
  ctx.exitPickInspect = function () {
    // 退出点选（宿主/iframe client 退出 + 工具条隐藏）+ 恢复 AI 窗口
    try { ctx.postToAi({ type: 'dbg_ai_inspect_off', payload: {} }); } catch (e) {}
    try { ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: false } }); } catch (e) {}
    try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {}
    try { if (window.__dbg && typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
    ctx.aiInspectActive = false;
    ctx.inspectorOn = false;
    if (ctx.inspBtn) ctx.inspBtn.classList.remove('dbg-on');
    try { ctx.deactivateNestedIframes(); } catch (e) {}
    if (ctx.root) { var tbEl = ctx.root.querySelector('.dbg-toolbar'); if (tbEl) tbEl.classList.remove('dbg-on'); }
    ctx.aiOpen = true;
    ctx.ensureAi();
    ctx.showAi(true);
    ctx.aiBtn.classList.add('dbg-on');
  };
  // 取当前选区载荷（iframe 客户端优先，宿主 self 兜底，hover 缓存再兜底）
  ctx.getPickPayload = function () {
    try {
      var frames = ctx.listFrames();
      for (var i = 0; i < frames.length; i++) {
        var fw = frames[i] && frames[i].win;
        if (fw && fw.__dbg && typeof fw.__dbg.getSelectionPayload === 'function') {
          var p = fw.__dbg.getSelectionPayload();
          if (p) return p;
        }
      }
    } catch (e) {}
    try {
      if (window.__dbg && typeof window.__dbg.getSelectionPayload === 'function') {
        var q = window.__dbg.getSelectionPayload();
        if (q) return q;
      }
    } catch (e) {}
    return (ctx.pickPanel && ctx.pickPanel.el) || ctx.lastSelfPayload || ctx.lastPayload || null;
  };
  ctx.finishPickPanel = function (result) {
    if (!ctx.pickPanel) return;
    var pp = ctx.pickPanel;
    ctx.pickPanel = null;
    clearInterval(pp.timer);
    if (pp.dialog && pp.dialog.parentNode) pp.dialog.parentNode.removeChild(pp.dialog);
    try { ctx.exitPickInspect(); } catch (e) {}
    // 清小屏 HUD 撑开的空间（exitPickInspect 不走 exitInspector，需自行清理）
    if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
    // 退出点选：HUD 隐藏（恢复 hover 显示由 updateHud 原版控制）
    if (ctx.hud) { try { ctx.hud.style.opacity = '0'; } catch (e) {} }
    result.tookMs = Date.now() - pp.startedAt;
    if (pp.silent) return; // 服务端已结算（超时/取消/agent 停止）——只关面板，不回桥
    if (pp.it && pp.it.async) {
      // 异步：候选已在确认选中时进 AI 待选——只关窗/清 HUD（桥已异步返回；发送/拒绝消息由对应分支 postBridgeEvent）
      ctx.addMsg('sys', result.status === 'answered' ? '🎯 已选中（候选已放入 AI 待选，点击 [元素N] 发送给 AI）' : (result.status === 'rejected' ? '✕ 用户取消/拒绝：' + (result.reason || '') : '⏱ 点选超时（用户无响应）'));
      return;
    }
    ctx.sendInteractionResult(pp.requestId, result);
    ctx.addMsg('sys', result.status === 'answered' ? '🎯 用户已选元素（回传 AI）' : (result.status === 'rejected' ? '✕ 用户拒绝选择：' + (result.reason || '') : '⏱ 点选超时（用户无响应）'));
  };
  // 服务端结算（agent 停止/取消）→ 静默关闭点选面板（不回桥——桥已 settle，回传会报“无 pending”）
  ctx.closePickPanel = function (requestId) {
    var pp = ctx.pickPanel;
    if (pp && pp.requestId === requestId) { pp.silent = true; ctx.finishPickPanel({ status: 'cancelled', error: 'AI 已停止' }); }
  };
  ctx.showPickElementPanel = function (requestId, it) {
    // 去重：同 requestId 重复投递（桥双 writer/双转发兜底）→ 跳过，否则第二条会立刻拒绝第一条（'新的交互打断'）
    if (ctx.pickPanel && ctx.pickPanel.requestId === requestId) return;
    if (ctx.pickPanel) ctx.finishPickPanel({ status: 'rejected', reason: '新的交互打断' });
    // 清理可能残留的弹窗（MCP 调用中断/超时可能留下未清理的确认窗——用户看到多个堆叠）
    try {
      var _olds = ctx.root.querySelectorAll('.dbg-pick-dialog');
      for (var _i = 0; _i < _olds.length; _i++) { if (_olds[_i].parentNode) _olds[_i].parentNode.removeChild(_olds[_i]); }
    } catch (e) {}
    // 不包装 updateHud——点选 UI 走原有工具条（target.js hover/锁定 + ✓ 确认），一套 inspect 系统（用户要求）
    ctx.selfAiRequested = false; // 桥 pick_element 交互（AI 发起）：结果/候选归 AI 窗（原逻辑，谁触发归谁）
    var timeoutMs = parseInt(it.timeoutMs, 10) > 0 ? parseInt(it.timeoutMs, 10) : 0; // timeout 可选：>0 才倒计时读秒/到点超时；0=永久等待（面板常驻直到用户操作）
    var startedAt = Date.now();
    var asyncMode = !!it.async;
    // 确认弹窗（告诉用户现在要选：现在开始/暂不选择）——toast 4.5s 太容易消失看不见（用户实测），恢复弹窗；
    //   确认后才进入点选（工具条 hover/锁定），后续点选/结果全走原有工具条（一套 inspect 系统）
    var dialog = el('div', { class: 'dbg-pick-dialog' });
    var head = el('div', { class: 'dbg-pick-head' });
    head.appendChild(el('span', { class: 'dbg-pick-title' }, ['🎯 AI 请你选择页面元素']));
    var noTimeout = !(timeoutMs > 0); // 永久等待：无倒计时/暂停（⏸ 藏掉——没东西可暂停），头部静态 ♾ 标记面板常驻直到用户操作
    var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px' }, [noTimeout ? '♾ 等待操作' : ('⏱ ' + Math.ceil(timeoutMs / 1000) + 's')]);
    var pauseBtn = el('button', { title: '暂停倒计时' }, ['⏸']);
    if (noTimeout) pauseBtn.style.display = 'none';
    var minBtn = el('button', { title: '暂时隐藏（再点恢复）' }, ['👁 隐藏']);
    head.appendChild(timerSpan);
    head.appendChild(pauseBtn);
    head.appendChild(minBtn);
    dialog.appendChild(head);
    var body = el('div', { class: 'dbg-pick-body' });
    if (it.prompt) body.appendChild(el('div', { style: 'white-space:pre-wrap' }, [it.prompt]));
    body.appendChild(el('div', { style: 'color:#94a3b8;line-height:1.5;margin-top:4px' }, ['AI 需要你帮忙在页面上点选一个元素。点「现在开始选择」进入点选——移到元素上高亮、点击锁定，然后在工具条上确认发送。']));
    var c = el('div', { style: 'margin-top:8px;display:flex;gap:6px;justify-content:center' });
    var startBtn = el('button', { class: 'dbg-pick-ok' }, ['🖱 现在开始选择']);
    var laterBtn = el('button', { class: 'dbg-pick-cancel' }, ['⏳ 暂不选择']);
    c.appendChild(laterBtn); c.appendChild(startBtn); // 手机惯例：主操作（现在开始选择）在右侧
    body.appendChild(c);
    dialog.appendChild(body);
    ctx.root.appendChild(dialog);
    dialog.style.zIndex = '2147483648'; // 盖住工具条（2147483647）——否则按钮区域被工具条盖住点不了
    // 公共浮层定位（placePhysPanel——与 AI 窗/HUD 同套视觉坐标算法）：底部居中、限宽 420、自适应内容高、≤可视区（offsetY 抬高，同上）
    placePhysPanel(dialog, { visW: Math.min(420, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: '420px', overflowY: 'auto' });
    try { ctx.dodgeToolbarAboveDialog(dialog); } catch (e) {} // 工具条已显示 → 立即避让（含无选区/拖动过的情形，重锚对它们 no-op）
    // 拖拽移动：按住头部（非按钮）拖动面板（makePointerDrag——AI 窗/fab/问答面板同款基础设施）
    try {
      makePointerDrag({
        handle: head, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !(e.target && e.target.tagName === 'BUTTON'); },
        onStart: function () {
          dialog.classList.add('dbg-dragging');
          return { left: dialog.offsetLeft || 0, top: dialog.offsetTop || 0 };
        },
        onMove: function (ev, st, dx, dy) {
          var nl = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60));
          var nt = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40));
          dialog.style.left = nl + 'px';
          dialog.style.top = nt + 'px';
          dialog.style.right = 'auto';
          dialog.style.bottom = 'auto';
        },
        onEnd: function () { dialog.classList.remove('dbg-dragging'); },
      });
    } catch (e) {}
    minBtn.addEventListener('click', function () {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      minBtn.textContent = hidden ? '👁 隐藏' : '👁 显示';
      if (dialog.parentNode) placePhysPanel(dialog, { visW: Math.min(420, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: '420px', overflowY: 'auto' });
      // offsetY 必须保留：丢了会贴到屏幕最底，正好压住底部贴合的 inspect 工具条
    });
    function startInspect() {
      ctx.hideAiForPick(); // 隐藏 AI 窗（用户直接去选择）
      ctx.aiInspectActive = true;
      ctx.selfEngaged = false;
      ctx.enterSelfClient(isTouchDevice() ? 'touch' : 'mouse');
      ctx.activateNestedIframes(isTouchDevice() ? 'touch' : 'mouse');
      ctx.broadcast({ type: 'dbg_enter_inspector', payload: { mode: 'mouse' } });
      ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: true } });
      ctx.addMsg('sys', '🎯 点选模式（' + String(it.prompt || '').slice(0, 40) + '）——移到元素高亮、点击锁定，工具条上确认。');
      try { if (ctx.showPickHint) ctx.showPickHint(); } catch (e) {} // 小屏底部 toast：点击元素选择
    }
    startBtn.addEventListener('click', function () {
      try { if (dialog.parentNode) dialog.parentNode.removeChild(dialog); } catch (e) {}
      startInspect();
      ctx.pickPanel.dialog = null; // 确认窗已移除——finishPickPanel 不再动它
    });
    laterBtn.addEventListener('click', function () { ctx.finishPickPanel({ status: 'rejected', reason: '用户暂不选择' }); });
    // 倒计时（支持暂停/继续：⏸ 后服务器计时同步暂停）
    var deadline = Date.now() + timeoutMs;
    var paused = false;
    var remainingMs = timeoutMs; // 暂停时冻结剩余时间；恢复时按它重建 deadline（原逻辑用旧 deadline 丢失暂停时长 → 恢复后数字跳）
    function tickCountdown() {
      if (paused) return;
      var left = Math.max(0, deadline - Date.now());
      if (timerSpan) timerSpan.textContent = '⏱ ' + Math.ceil(left / 1000) + 's';
      if (left <= 0) ctx.finishPickPanel({ status: 'timeout', error: '用户无响应（不在线）' });
    }
    if (!noTimeout) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        remainingMs = Math.max(0, deadline - Date.now());
        if (timerSpan) timerSpan.textContent = '⏸ 已暂停（剩 ' + Math.ceil(remainingMs / 1000) + 's）';
        pauseBtn.textContent = '▶';
      } else {
        deadline = Date.now() + remainingMs;
        if (timerSpan) timerSpan.textContent = '⏱ ' + Math.ceil(remainingMs / 1000) + 's';
        pauseBtn.textContent = '⏸';
      }
      ctx.sendInteractionControl(requestId, paused ? 'pause' : 'resume');
    });
    ctx.pickPanel = { requestId: requestId, it: it, dialog: dialog, timerSpan: timerSpan, startedAt: startedAt, el: null, asyncMode: asyncMode, phase: 'confirm' };
    ctx.pickPanel.timer = noTimeout ? null : setInterval(tickCountdown, 500); // 永久等待无计时器（finishPickPanel clearInterval(null) 安全）
  };

  // pick_element 交互：点选锁定后 UI 走原有工具条（target.js hover/锁定 + ✓ 确认）——一套 inspect 系统。
  //   这里只记录当前选区 + 结果描述（供工具条 ✓ 确认发送用），不再渲染第二套 pick HUD（用户要求去掉）。
  ctx.updatePickPanelLabel = function (p) {
    if (!ctx.pickPanel || !p) return;
    ctx.pickPanel.el = p;
    if (p && p.engaged) {
      ctx.pickPanel.resultDesc = '<' + (p.tag || '?') + '>'
        + (p.text ? ' ' + String(p.text).trim().slice(0, 50) : '')
        + (p.xpath ? ' · ' + String(p.xpath).slice(0, 60) : '');
    }
  };
  // ---- 兜底问答面板（AI 窗口未连接时宿主直接渲染：confirm/choose/input/presence） ----
  ctx.showHostAskPanel = function (requestId, it) {
    // 去重：同 requestId 重复投递（桥双 writer/双转发兜底）→ 跳过，不堆叠双面板（用户会看到两个、点一个留一个）
    if (ctx.hostAskPanels && ctx.hostAskPanels[requestId]) return;
    var kind = it.kind || 'confirm';
    var timeoutMs = parseInt(it.timeoutMs, 10) > 0 ? parseInt(it.timeoutMs, 10) : 0; // timeout 可选：>0 才倒计时读秒/到点超时；0=永久等待（面板常驻直到用户操作）
    var startedAt = Date.now();
    var seq = (ctx.askPanelSeq = (ctx.askPanelSeq || 0) + 1); // 面板序号：键盘快捷键只响应最新面板（多面板并存防双响应）
    // 面板宽度：桌面 520（问题/选项长文案一屏读完，不再 360 挤压换行）；小屏自动收缩到可视宽 -24（物理适配由 placePhysPanel 统一裁决）
    function reflowPanel() {
      var w = Math.min(520, Math.round(getPhysViewport().w) - 24);
      placePhysPanel(dialog, { visW: w, dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: w + 'px', overflowY: 'auto' });
    }
    var dialog = el('div', { class: 'dbg-pick-dialog' }); // 浮层面板（右下角，不覆盖全屏）
    var head = el('div', { class: 'dbg-pick-head' });
    var kindTitle = { confirm: '🤖 AI 需要你确认', choose: '🤖 AI 请你选择', input: '✍️ AI 请你输入', presence: '🙋 AI 问你是否在场' };
    head.appendChild(el('span', { class: 'dbg-pick-title' }, [kindTitle[kind] || '🤖 AI 需要你回答']));
    var noTimeout = !(timeoutMs > 0); // 永久等待：无倒计时/暂停（⏸ 藏掉），头部静态 ♾ 标记面板常驻直到用户操作
    var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px' }, [noTimeout ? '♾ 等待操作' : ('⏱ ' + Math.ceil(timeoutMs / 1000) + 's')]);
    var pauseBtn = el('button', { title: '暂停倒计时' }, ['⏸']);
    if (noTimeout) pauseBtn.style.display = 'none';
    var minBtn = el('button', { title: '暂时隐藏（再点恢复）' }, ['👁 隐藏']);
    head.appendChild(timerSpan);
    head.appendChild(pauseBtn);
    head.appendChild(minBtn);
    // 取消（拒绝本次请求）：全面板头部右上角 ✕（标准关闭位）；多选底部另有「✕ 取消 + ✅ 发送所选」（用户认可，保留）
    var cancelHead = el('button', { title: '取消（拒绝本次请求）', style: 'font-size:15px;font-weight:700;padding:2px 10px' }, ['✕']);
    cancelHead.addEventListener('click', function () { finishAsk({ status: 'rejected', reason: '用户取消' }); });
    head.appendChild(cancelHead);
    dialog.appendChild(head);
    var body = el('div', { class: 'dbg-pick-body' });
    // 问题区：大字号高对比 + 左侧强调条（.dbg-ask-prompt）——AI 的问题是面板最重要信息（布局分区）
    body.appendChild(el('div', { class: 'dbg-ask-prompt' }, [it.prompt || '']));
    minBtn.addEventListener('click', function () {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      minBtn.textContent = hidden ? '👁 隐藏' : '👁 显示';
      // 重算面板高度：隐藏时收起成头部细栏（原固定高 → body 藏了但高度不变 = 空盒子，很搞笑），显示时恢复内容高
      try { reflowPanel(); } catch (e) {}
    });
    var ctl = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px' });
    var multiple = !!it.multiple; // choose 支持多选
    var singleShot = !(kind === 'choose' && multiple); // 单选：点选项立即作答；多选/自定义：两步（选完点发送）
    // 选项区标签（非 input 时显示）——文案随交互模式引导（编号徽标 + 键盘 1-9 快捷键）
    if (kind !== 'input') {
      ctl.appendChild(el('div', { class: 'dbg-ask-label' }, [singleShot ? '点选项或按数字键 1-9 立即作答：' : '勾选（可多选）后点「发送」：']));
    }
    var optWrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px' }); // 垂直全宽列表：长文案不挤压、扫读快
    var sel = { v: null, idxs: {}, custom: false };
    // finishAskCustom 提升到函数级：原在 else 块内声明——块级函数声明在 ESM/strict 下作用域限于块内，
    // 底部多选「发送所选 ✓」（else 块外）引用它 → ReferenceError → 多选面板构建中断、永远弹不出
    function finishAskCustom() {
      var comment = commentInp ? commentInp.value.trim() : '';
      var cv = comment ? { comment: comment } : {};
      // 固定选项「都不适合」→ 自定义回答（补充说明字段始终可用，与是否选此项无关）
      if (sel.custom) {
        if (kind === 'choose') finishAsk({ status: 'answered', value: { index: -1, label: comment || '都不适合', custom: true } });
        else if (kind === 'confirm') finishAsk({ status: 'answered', value: { approved: null, custom: comment || '都不适合' } });
        else finishAsk({ status: 'answered', value: { present: null, custom: comment || '都不适合' } });
        return;
      }
      if (kind === 'choose') {
        var choices2 = (it.choices && it.choices.length) ? it.choices : [];
        if (multiple) {
          var idxs = Object.keys(sel.idxs).map(Number).sort(function (a, b) { return a - b; });
          if (!idxs.length && !comment) return;
          if (!idxs.length) finishAsk({ status: 'answered', value: { indexes: [], custom: comment } });
          else finishAsk({ status: 'answered', value: Object.assign({ indexes: idxs, labels: idxs.map(function (i) { return choices2[i] != null ? choices2[i] : String(i); }) }, cv) });
        } else {
          if (sel.v === null && !comment) return;
          if (sel.v === null) finishAsk({ status: 'answered', value: { index: -1, label: comment, custom: true } });
          else { var idx = parseInt(sel.v, 10); finishAsk({ status: 'answered', value: Object.assign({ index: idx, label: choices2[idx] != null ? choices2[idx] : sel.v }, cv) }); }
        }
      } else if (kind === 'confirm') {
        if (sel.v === null && !comment) return;
        if (sel.v === null) finishAsk({ status: 'answered', value: { approved: null, custom: comment } });
        else finishAsk({ status: 'answered', value: Object.assign({ approved: sel.v === 'yes' }, cv) });
      } else if (kind === 'presence') {
        if (sel.v === null && !comment) return;
        if (sel.v === null) finishAsk({ status: 'answered', value: { present: null, custom: comment } });
        else if (sel.v === 'later') finishAsk({ status: 'rejected', reason: '用户暂时不在', ...cv });
        else finishAsk({ status: 'answered', value: Object.assign({ present: true }, cv) });
      }
    }
    // 选项按钮顺序契约（2026-09 用户指定）：编号选项 1/2/3… → 确认（主操作）→ 取消/否定 → 「都不适合」（自上而下）
    function askNum(n) { return el('span', { class: 'dbg-ask-num' }, [String(n)]); }
    if (kind === 'confirm') {
      optWrap.appendChild(el('button', { class: 'dbg-primary dbg-ask-opt', 'data-v': 'yes' }, [askNum(1), '是 / 确认']));
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-no', 'data-v': 'no' }, [askNum(2), '否 / 取消']));
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-opt-custom', 'data-custom': '1' }, [askNum(3), '都不适合（输入回答）']));
    } else if (kind === 'choose') {
      var choices = (it.choices && it.choices.length) ? it.choices : ['选项 A', '选项 B'];
      choices.forEach(function (c, i) { optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt', 'data-i': String(i) }, [askNum(i + 1), String(c)])); });
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-opt-custom', 'data-custom': '1' }, [askNum(choices.length + 1), '这些都不适合（输入回答）']));
    } else if (kind === 'presence') {
      optWrap.appendChild(el('button', { class: 'dbg-primary dbg-ask-opt', 'data-v': 'yes' }, [askNum(1), '我在，继续']));
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-no', 'data-v': 'later' }, [askNum(2), '稍后 / 不在']));
    }
    if (kind !== 'input') ctl.appendChild(optWrap);
    // 独立补充说明（confirm/choose/presence）：选了任何选项后都能再补充；仅填补充 = 自定义回答
    var commentInp = null, sendBtn = null;
    if (kind === 'confirm' || kind === 'choose' || kind === 'presence') {
      ctl.appendChild(el('div', { class: 'dbg-ask-label' }, ['📝 补充说明（可选）']));
      var commentRow = el('div', { style: 'display:flex;gap:6px' });
      commentInp = el('input', { type: 'text', placeholder: singleShot ? '📝 补充说明（可选，填好后点选项一并发送）' : '📝 补充说明（可选）', style: 'background:rgba(255,255,255,.06);border:1px solid rgba(148,163,184,.35);color:#f1f5f9;border-radius:8px;padding:9px 11px;font:inherit;flex:1' });
      // 发送按钮：亮绿高亮（CSS .dbg-ask-send）——加宽加粗（用户实测「确认按钮明显、发送完全不明显」）；
      // 单选即答默认隐藏（点选项已直接发送），仅在「都不适合」（需打字）时出现；
      // 多选：发送按钮并入底部主操作行（footSend）——此处不创建，避免两个「发送所选 ✓」
      sendBtn = multiple ? null : el('button', { class: 'dbg-primary dbg-ask-send', style: (singleShot ? 'display:none;' : '') + 'flex:1;font-weight:700;font-size:13px;padding:9px 12px' }, ['✓ 发送']);
      commentRow.appendChild(commentInp);
      if (sendBtn) commentRow.appendChild(sendBtn);
      ctl.appendChild(commentRow);
    }
    if (kind === 'input') {
      var inp = el('input', { type: 'text', value: it.defaultValue || '', placeholder: '输入你的回答…', style: 'background:rgba(255,255,255,.06);border:1px solid rgba(148,163,184,.35);color:#f1f5f9;border-radius:8px;padding:9px 11px;font:inherit;flex:1' });
      var send = el('button', { class: 'dbg-primary dbg-ask-send' }, ['发送']);
      var r3 = el('div', { style: 'display:flex;gap:6px' });
      r3.appendChild(inp); r3.appendChild(send);
      ctl.appendChild(r3);
      send.addEventListener('click', function () { finishAsk({ status: 'answered', value: { text: inp.value } }); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') send.click(); });
    } else {
      // 选项（单选/多选）+ 补充说明组合发送
      var optBtns = optWrap.querySelectorAll('.dbg-ask-opt');
      function refreshAskSend() {
        var hasSel = sel.custom || (multiple ? Object.keys(sel.idxs).length > 0 : sel.v !== null);
        var hasCmt = !!(commentInp && commentInp.value.trim());
        if (sendBtn) sendBtn.disabled = !(hasSel || hasCmt);
        if (footSend) {
          footSend.disabled = !(hasSel || hasCmt);
          if (multiple) footSend.textContent = '✅ 发送所选（' + Object.keys(sel.idxs).length + '）';
        }
      }
      Array.prototype.forEach.call(optBtns, function (o) {
        o.addEventListener('click', function () {
          // 固定选项「都不适合」：普通选项之一（排他），点选后聚焦补充输入框（补充说明本身始终可用）
          if (o.hasAttribute('data-custom')) {
            sel.custom = true;
            sel.v = null; sel.idxs = {};
            Array.prototype.forEach.call(optBtns, function (x) { x.classList.toggle('dbg-on', x === o); });
            if (sendBtn) sendBtn.style.display = ''; // 「都不适合」需打字 → 显示发送按钮（单选模式下默认隐藏）
            if (commentInp) { try { commentInp.focus(); } catch (e) {} }
            refreshAskSend();
            return;
          }
          sel.custom = false;
          var customBtn = optWrap.querySelector('.dbg-ask-opt-custom');
          if (customBtn) customBtn.classList.remove('dbg-on');
          if (kind === 'choose' && multiple) {
            var i = o.getAttribute('data-i');
            if (sel.idxs[i]) { delete sel.idxs[i]; o.classList.remove('dbg-on'); }
            else { sel.idxs[i] = true; o.classList.add('dbg-on'); }
          } else {
            var ov = o.getAttribute('data-i') !== null ? o.getAttribute('data-i') : o.getAttribute('data-v');
            sel.v = ov;
            Array.prototype.forEach.call(optBtns, function (x) { x.classList.toggle('dbg-on', x === o); });
          }
          refreshAskSend();
          // 单选即答：confirm/presence/choose(单选) 点击选项立即作答（已输入的补充说明随答案带上）——
          // 曾是两步（先选后点发送）：用户点 ✅ 无反应以为坏了，实测「点了不生效」；
          // 多选（需组合勾选）与「都不适合」（需打字）仍为两步——它们的 ✓ 发送按钮不消失
          if (!(kind === 'choose' && multiple)) {
            setTimeout(finishAskCustom, 0);
          }
        });
      });
      if (sendBtn) sendBtn.addEventListener('click', finishAskCustom);
      if (commentInp) {
        commentInp.addEventListener('input', refreshAskSend);
        commentInp.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          if (sendBtn && !sendBtn.disabled) sendBtn.click();
          else if (footSend) footSend.click(); // 多选：Enter 触发底部「发送所选 ✓」（footSend var 提升，点击时已赋值）
        });
      }
      refreshAskSend();
    }
    body.appendChild(ctl);
    if (it.rejectable !== false && kind !== 'presence') {
      var det2 = el('details', {}, []);
      // 拒绝区：文字/点击区域放大（用户实测 11px 太小不好点）
      det2.appendChild(el('summary', { style: 'cursor:pointer;font-size:13px;color:#cbd5e1;margin-top:10px;padding:4px 0;user-select:none' }, ['✕ 现在无法处理（告诉 AI 原因）']));
      var rr2 = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px' });
      ['我暂时无法满足你的要求', '暂时找不到/选不了', '等会再处理'].forEach(function (r) {
        rr2.appendChild(el('button', { class: 'dbg-ask-reject', 'data-reason': r }, [r]));
      });
      det2.appendChild(rr2);
      body.appendChild(det2);
      // 展开/收起「无法处理」时重算面板高度：placePhysPanel 创建时按收起态定高（固定高），
      // 展开后内容变高 → 固定高溢出出滚动条（用户实测）；toggle 后重新定位（底部锚定 → 向上长）
      det2.addEventListener('toggle', function () {
        try { reflowPanel(); } catch (e) {}
      });
    }
    dialog.appendChild(body);
    // 底部主操作行：仅多选（用户认可：取消靠左 + 发送靠右）；单选/确认/输入的取消已移到头部 ✕
    if (kind === 'choose' && multiple) {
      var footRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px' });
      footRow.appendChild(el('button', { class: 'dbg-pick-cancel dbg-ask-cancel' }, ['✕ 取消']));
      // 底部主发送按钮：更大更醒目（✅ + 已选数量动态更新 + 未选禁用）——用户实测原来两个「发送所选 ✓」重复且看不清
      var footSend = el('button', { class: 'dbg-primary dbg-ask-send', style: 'flex:1;font-weight:800;font-size:16px;padding:12px 18px;border-radius:10px;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;gap:6px' }, ['✅ 发送所选（0）']);
      footSend.disabled = true; // 初始无勾选：禁用（refreshAskSend 在 else 块内先跑、此时 footSend 未赋值，创建后显式初始化）
      footSend.addEventListener('click', finishAskCustom);
      footRow.appendChild(footSend);
      body.appendChild(footRow);
    }
    ctx.root.appendChild(dialog);
    dialog.style.zIndex = '2147483648'; // 盖住工具条（2147483647）——同上，按钮可点
    // 公共浮层定位（placePhysPanel——与 AI 窗/HUD/确认窗同套算法）：底部居中、限宽 520/小屏自适应、内容自适高、≤可视区
    // offsetY: 抬高底部留空（展开「无法处理」拒绝区/多选时面板向上长，底部不被 AI 窗/FAB 压着）
    try { reflowPanel(); } catch (e) {}
    try { ctx.dodgeToolbarAboveDialog(dialog); } catch (e) {} // 工具条已显示 → 立即避让（同点选确认窗）
    // 拖拽移动：按住头部（非按钮）拖动面板——公共手势 makePointerDrag（AI 窗/fab 同款基础设施，drag.js）
    try {
      makePointerDrag({
        handle: head, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !(e.target && e.target.tagName === 'BUTTON'); }, // 头部按钮（⏸/👁/✕）不触发拖拽
        onStart: function () {
          dialog.classList.add('dbg-dragging');
          return { left: dialog.offsetLeft || 0, top: dialog.offsetTop || 0 };
        },
        onMove: function (ev, st, dx, dy) {
          // left/top 为 CSS px（positionPhysical 同坐标系）；clamp 视口内
          var nl = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60));
          var nt = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40));
          dialog.style.left = nl + 'px';
          dialog.style.top = nt + 'px';
          dialog.style.right = 'auto';
          dialog.style.bottom = 'auto';
        },
        onEnd: function () { dialog.classList.remove('dbg-dragging'); },
      });
    } catch (e) {}

    var done = false;
    function finishAsk(res) {
      if (done) return;
      done = true;
      delete ctx.hostAskPanels[requestId];
      clearInterval(timer);
      document.removeEventListener('keydown', keyHandler);
      res.tookMs = Date.now() - startedAt;
      dialog.classList.remove('dbg-open');
      setTimeout(function () { if (dialog.parentNode) dialog.parentNode.removeChild(dialog); }, 200);
      try { ctx.floatToolbarReAnchor(); } catch (e) {} // 浮窗关闭 → 工具条回选区旁（弹出时曾为避让浮窗挪位）
      if (silent) return; // 服务端已结算（超时/取消/agent 停止）——只关面板，不回桥
      if (it.async) {
        // 异步：成功/拒绝消息经桥 event 发 MCP（不阻塞——桥已异步返回）；answered 结果同时进 AI 待选（候选 [回答N]——与 HUD 一致）
        if (res.status === 'answered') {
          var txt = describeAnswer(kind, res.value);
          ctx.postBridgeEvent('user_answer', { kind: kind, answer: txt, status: 'answered' });
          ctx.addMsg('sys', '💬 用户已回答：' + txt + '（异步——已放入 AI 待选，点击 [回答N] 发送给 AI）');
        } else {
          ctx.postBridgeEvent('user_answer', { kind: kind, answer: res.status === 'rejected' ? '❌ 拒绝：' + (res.reason || '') : '⏱ 超时', status: res.status === 'rejected' ? 'rejected' : 'timeout', reason: res.reason || '' });
          ctx.addMsg('sys', res.status === 'rejected' ? '✕ 用户拒绝：' + (res.reason || '') + '（异步——已通知 MCP）' : '⏱ 等待超时（用户无响应）');
        }
        return;
      }
      ctx.sendInteractionResult(requestId, res);
      ctx.addMsg('sys', res.status === 'answered' ? '💬 用户已回答（回传 AI）' : (res.status === 'rejected' ? '✕ 用户拒绝：' + (res.reason || '') : '⏱ 等待超时（用户无响应）'));
    }
    ctx.hostAskPanels = ctx.hostAskPanels || {};
    var silent = false;
    ctx.hostAskPanels[requestId] = { finishAsk: finishAsk, startedAt: startedAt };
    var timer = noTimeout ? null : setInterval(tickCountdown, 500); // 永久等待无计时器（finishAsk clearInterval(null) 安全）
    // 倒计时（支持暂停/继续：⏸ 后服务器计时同步暂停，用户有充足时间处理）——仅 AI 传了 timeout 时存在
    var deadline = Date.now() + timeoutMs;
    var paused = false;
    var remainingMs = timeoutMs; // 暂停时冻结剩余时间；恢复时按它重建 deadline（原逻辑用旧 deadline 丢失暂停时长 → 恢复后数字跳）
    function tickCountdown() {
      if (paused) return;
      var left = Math.max(0, deadline - Date.now());
      timerSpan.textContent = '⏱ ' + Math.ceil(left / 1000) + 's';
      if (left <= 0) finishAsk({ status: 'timeout', error: '用户无响应（不在线）' });
    }
    if (!noTimeout) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        remainingMs = Math.max(0, deadline - Date.now());
        timerSpan.textContent = '⏸ 已暂停（剩 ' + Math.ceil(remainingMs / 1000) + 's）';
        pauseBtn.textContent = '▶ 继续';
      } else {
        deadline = Date.now() + remainingMs;
        timerSpan.textContent = '⏱ ' + Math.ceil(remainingMs / 1000) + 's';
        pauseBtn.textContent = '⏸ 暂停';
      }
      ctx.sendInteractionControl(requestId, paused ? 'pause' : 'resume');
    });
    // 键盘快捷键：数字键 1-9 直选对应选项（与徽标编号一致；输入框聚焦时忽略——打字优先）；仅最新面板响应（多面板并存防双响应）
    var keyHandler = function (e) {
      if (done) return;
      if (seq !== ctx.askPanelSeq) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var n = parseInt(e.key, 10);
      if (!(n >= 1) || n > 9) return;
      var btns = optWrap.querySelectorAll('.dbg-ask-opt');
      if (btns[n - 1]) { btns[n - 1].click(); e.preventDefault(); }
    };
    document.addEventListener('keydown', keyHandler);
    dialog.addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('dbg-ask-yes')) {
        finishAsk(kind === 'confirm' ? { status: 'answered', value: { approved: true } } : { status: 'answered', value: { present: true } });
      } else if (t.classList.contains('dbg-ask-no')) {
        finishAsk(kind === 'confirm' ? { status: 'answered', value: { approved: false } } : { status: 'rejected', reason: '用户暂时不在' });
      } else if (t.classList.contains('dbg-ask-choice')) {
        var i = parseInt(t.getAttribute('data-i'), 10);
        var ch = it.choices || [];
        finishAsk({ status: 'answered', value: { index: i, label: ch[i] != null ? ch[i] : String(i) } });
      } else if (t.classList.contains('dbg-ask-reject')) {
        finishAsk({ status: 'rejected', reason: t.getAttribute('data-reason') });
      } else if (t.classList.contains('dbg-ask-cancel')) {
        finishAsk({ status: 'rejected', reason: '用户取消' });
      }
    });
    // 服务端结算（agent 停止/取消）→ 静默关闭问答面板（不回桥——桥已 settle，回传会报“无 pending”）
    ctx.closeHostAskPanel = function (requestId) {
      var p = ctx.hostAskPanels[requestId];
      if (p) { silent = true; p.finishAsk({ status: 'cancelled', error: 'AI 已停止' }); }
    };
  };

  // ---- 纯通知卡（user_notify）：右下角浮动小卡——系统 Notification 之外页面内也可见可回看 ----
  // 无需作答/不回桥（notify 即发即忘）：timeout 可选——不传=常驻直到 ✕（♾ 不读秒不自动收卡）；传了才倒计时读秒，到点自动收卡（⏸ 可暂停）
  ctx.showNotifyPanel = function (requestId, it) {
    var timeoutMs = parseInt(it.timeoutMs, 10) > 0 ? parseInt(it.timeoutMs, 10) : 0; // timeout 可选：>0 才倒计时读秒/到点自动收卡；0=常驻直到用户 ✕
    var dialog = el('div', { class: 'dbg-pick-dialog' });
    var head = el('div', { class: 'dbg-pick-head' });
    head.appendChild(el('span', { class: 'dbg-pick-title' }, ['🔔 ' + (it.title || 'AI 通知')]));
    var noTimeout = !(timeoutMs > 0); // 无 timeout：通知卡常驻（♾ 不读秒、不自动收卡）
    var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px' }, [noTimeout ? '♾ 常驻' : ('⏱ ' + Math.ceil(timeoutMs / 1000) + 's')]);
    var pauseBtn = el('button', { title: '暂停倒计时' }, ['⏸']);
    if (noTimeout) pauseBtn.style.display = 'none';
    head.appendChild(timerSpan);
    head.appendChild(pauseBtn);
    var closeBtn = el('button', { title: '关闭', style: 'font-size:15px;font-weight:700;padding:2px 10px' }, ['✕']);
    head.appendChild(closeBtn);
    dialog.appendChild(head);
    var body = el('div', { class: 'dbg-pick-body' });
    body.appendChild(el('div', { style: 'white-space:pre-wrap;font-size:14px;line-height:1.7;color:#e5e7eb;word-break:break-word;overflow-wrap:anywhere' }, [it.body || '']));
    dialog.appendChild(body);
    try {
      makePointerDrag({
        handle: head, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !(e.target && e.target.tagName === 'BUTTON'); },
        onStart: function () { dialog.classList.add('dbg-dragging'); return { left: dialog.offsetLeft || 0, top: dialog.offsetTop || 0 }; },
        onMove: function (ev, st, dx, dy) {
          dialog.style.left = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60)) + 'px';
          dialog.style.top = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40)) + 'px';
          dialog.style.right = 'auto'; dialog.style.bottom = 'auto';
        },
        onEnd: function () { dialog.classList.remove('dbg-dragging'); },
      });
    } catch (e) {}
    var done = false;
    var closeCard = function () { if (done) return; done = true; clearInterval(timer); if (dialog.parentNode) dialog.parentNode.removeChild(dialog); };
    var deadline = Date.now() + timeoutMs, paused = false, remainingMs = timeoutMs; // 暂停冻结剩余时间，恢复重建 deadline（问答面板同款）
    var timer = noTimeout ? null : setInterval(function () { // 永久等待无计时器（closeCard clearInterval(null) 安全）
      if (paused) return;
      var left = Math.max(0, deadline - Date.now());
      timerSpan.textContent = '⏱ ' + Math.ceil(left / 1000) + 's';
      if (left <= 0) closeCard();
    }, 500);
    if (!noTimeout) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        remainingMs = Math.max(0, deadline - Date.now());
        timerSpan.textContent = '⏸ 已暂停（剩 ' + Math.ceil(remainingMs / 1000) + 's）';
        pauseBtn.textContent = '▶ 继续';
      } else {
        deadline = Date.now() + remainingMs;
        timerSpan.textContent = '⏱ ' + Math.ceil(remainingMs / 1000) + 's';
        pauseBtn.textContent = '⏸ 暂停';
      }
    });
    closeBtn.addEventListener('click', closeCard);
    ctx.root.appendChild(dialog); // 先挂载再定位：placePhysPanel 按内容量高，未挂载时 scrollHeight=0 会把卡量成最小高度
    try { placePhysPanel(dialog, { visW: Math.min(520, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: '520px', overflowY: 'auto' }); } catch (e) {}
  };

  // ---- MCP 桥交互入口：通知 + 路由（pick_element → 点选面板；Q&A → AI 窗/兜底面板） ----
  ctx.handleMcpInteraction = function (payload) {
    var it = payload && payload.interaction ? payload.interaction : {};
    var itKind = it.kind || 'confirm';
    // 纯通知（user_notify）：只弹浏览器通知，不渲染问答面板——notify 无 prompt/无选项，
    // 走问答面板会弹「点击选项立即作答」但一个选项都没有的荒诞空卡（历史 bug：通知当问答渲染）
    if (itKind === 'notify') {
      // 双通道去重：独立桥下桥直发页面 + AI 窗转发两条路都可能到 launcher → 只弹一次（问答面板在 showHostAskPanel 内按 requestId 去重，通知路径无面板故在此去重）
      if (ctx.lastNotifyId === payload.requestId) return;
      ctx.lastNotifyId = payload.requestId;
      ctx.notifyUser(it.title || '🤖 AI 有一条消息', it.body || '');
      ctx.showNotifyPanel(payload.requestId, it); // 页面内通知卡：可拖动、可回看（timeout 可选：不传=常驻直到 ✕；系统通知会自动消失）
      return;
    }
    // 浏览器通知（Notification + 标题闪烁 + 提示音）：通知用户有消息要处理
    ctx.notifyUser('🤖 AI 需要你', itKind === 'pick_element' ? (it.prompt || '请点击页面上的一个元素') : (it.prompt || '请在页面回答'));
    if (itKind === 'pick_element') {
      ctx.showPickElementPanel(payload.requestId, it); // 收起 AI 窗 + 进入点选 + 弹面板（✓/✕/超时回桥）
    } else {
      // 当前 AI 窗 = pi-web 直接嵌入（aiti 扩展无作答卡渲染器）——confirm/choose/input/presence 一律走宿主兜底问答面板
      ctx.showHostAskPanel(payload.requestId, it);
    }
  };
}
