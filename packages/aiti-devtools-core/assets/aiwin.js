/**
 * aiti-devtools AI 窗公共库（浏览器端模块，公共库 aiti-devtools-core）
 *
 * AI 窗（cockpit / 未来其他）的标准能力：桥连接、数据轮询、消息、交互卡。
 * 宿主协议（launcher postMessage）由 host-protocol.js 统一处理（本库内部复用）。
 * 适配端只提供 render 回调（把数据渲染到自己的 slot），逻辑几乎为零。
 *
 * 依赖（先加载）：bridge-client.js（桥协议）、host-protocol.js（宿主协议）
 *
 * 用法（AI 窗页面）：
 *   <script src="./bridge-client.js"></script>
 *   <script src="./host-protocol.js"></script>
 *   <script src="./aiwin.js"></script>
 *   <script>
 *     const aiwin = window.AitiAiWin.create({
 *       base: location.origin + '/aiti',          // 省略则自动推断（/aiti/ 前缀）
 *       render: {
 *         onStatus(text, color),
 *         onSessions(list),
 *         onAgents(list),
 *         onMessages(rows, mode, key),
 *         onTarget(key),
 *         onInteraction(msg),
 *         onHostMsg(kind, text, meta),            // 宿主协议消息（boot/元素/错误/inspect/消息）
 *         onElement(cand),                        // 元素候选（插入输入框）
 *         onError(cand),                          // 错误候选（插入输入框）
 *       },
 *       pollMs: 5000,
 *     });
 *     aiwin.start();
 *     aiwin.setTarget('pi/sess-A');
 *     aiwin.push('消息');
 *   </script>
 */
(function (global) {
  'use strict';

  function createAiWindow(opts) {
    opts = opts || {};
    var r = opts.render || {};
    var pollMs = opts.pollMs || 5000;
    var base = opts.base || (global.location.origin + (String(global.location.pathname).indexOf('/aiti/') === 0 ? '/aiti' : ''));

    // ---- 宿主协议（host-protocol.js 公共层） ----
    var hp = null;
    if (global.AitiHostProtocol) {
      hp = global.AitiHostProtocol.create({
        onBoot: function (t) {
          // boot = 目标页握手上下文（host-protocol 内部已维护 debugTarget），不刷消息流（每次开 AI 窗都来一条是噪音）
          reportAiPage(); // 宿主页身份变化 → 注册到桥（bridge_status 可见、page_exec 可定向）
          if (r.onFrames) r.onFrames((t && t.frames) || []); // 帧树（主页+iframe）→ 适配端下拉展示/选择
        },
        onHostMsg: function (kind, text, meta) { if (r.onHostMsg) r.onHostMsg(kind, text, meta); },
        // 宿主页面事件（page_log/page_network/open_file…）→ 适配端转发桥（BridgeClient.postEvent；事件链路唯口在 AI 窗）
        onBridgeEvent: function (type, payload, target) { if (r.onBridgeEvent) r.onBridgeEvent(type, payload, target); },
        onInspect: function (on) { if (r.onHostMsg) r.onHostMsg('🖱️ Inspector', on ? '点选模式已开启——在页面点击元素' : '点选模式已关闭', 'launcher'); },
        // 占位符插入：适配端把候选 tag（[元素N]/[回答N]/[错误N]）插入输入框（发送时替换为完整描述）
        insertPlaceholder: function (el) { if (r.onCandidate) r.onCandidate(el); },
        // 候选变化：适配端渲染候选区
        onPicked: function (list) { if (r.onPicked) r.onPicked(list); },
        // describe 覆盖（适配端可传 opts.describe）
        describe: opts.describe || null,
      });
    }

    // ---- 状态 ----
    var targetKey = '__all__';
    var targetPageId = null; // 选中的目标页面（独立 AI 窗无宿主时，用户从页面列表选）→ push 带结构化 pageId/url
    var sessions = [];
    var hostPullCount = 0; // 无活跃页面时周期向宿主 pull_boot 的节流计数（pollMs*3）
    var aiInstanceId = null; // AI 窗连桥自标识（role=ai，桥用它关联 AI 宿主页注册表）
    var agents = [];
    var timers = [];
    var started = false;
    // 增量游标（单 agent / 全部模式按 agent 分别记）：切目标或首次 = 全量拉取（isFull）
    var lastSince = null;
    var agentSinces = {};
    var seenIds = new Set();
    // ---- 打开身份兜底：URL 参数（launcher 打开 AI 窗带 &pageId=&targetUrl=&title=）----
    // 从页面打开的独立 AI 窗不依赖 postMessage boot 竞态：URL 即页面身份；host-protocol boot 到达后 debugTarget 优先覆盖
    // urlIdent 已下沉 host-protocol 公共库（唯一来源）；此处仅透出给适配端
    var urlIdent = hp ? (function () { var t = hp.hostIdentity() || {}; return { pageId: t.pageId || null, url: t.targetUrl || null, title: t.title || null }; })() : { pageId: null, url: null, title: null };
    if (r.onIdent) r.onIdent(urlIdent);

    function http(path, body) {
      return global.fetch(base + path, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : undefined).then(function (resp) { return resp.json().catch(function () { return null; }); }).catch(function () { return null; });
    }

    // ================= 桥数据 =================
    // 宿主页合成记录：AI 窗是宿主（parent/opener launcher）打开的——宿主一定存在，桥里没有 session
    // 只是页面 client 的 SSE 没连上。用 host-protocol 的 debugTarget（宿主 boot 上报的实时页面身份）
    // 补一条记录，适配端不再干巴巴显示「无页面」；urlIdent（打开 URL 参数）兜底无宿主场景
    // 宿主页合成记录已下沉 host-protocol 公共库（唯一来源）——此处委托
    function hostPageRecord() { return hp ? hp.hostPageRecord() : null; }
    // reportAiPage/aiInstanceId 已下沉 host-protocol 公共库——此处仅委托（hp 未就绪时静默跳过）
    var aiInstanceId = null;
    function reportAiPage() { if (hp) { hp.reportAiPage(base); aiInstanceId = hp.getAiInstanceId(); } }
    function refreshSessions() {
      reportAiPage(); // 宿主页注册自愈（幂等；桥 sessions 经 AI 宿主页可见）
      if (!global.BridgeClient) return;
      global.BridgeClient.listSessions().then(function (list) {
        sessions = list || [];
        var act = sessions.filter(function (s) { return s.active; });
        if (!act.length) {
          var hr = hostPageRecord();
          if (hr) sessions = sessions.concat([hr]);
        }
        if (r.onSessions) r.onSessions(sessions);
        // 无活跃页面 → 主动问宿主：周期 pull_boot（宿主回实时 pageId/bridge + 检查页面 client 桥状态并触发重连）
        // 节流：每 3 次轮询一次（pollMs=5s → 15s）
        if (!act.length && hp) {
          hostPullCount++;
          if (hostPullCount % 3 === 0) {
            try { hp.postToHost('dbg_ai_pull_boot', {}); } catch (e) {}
          }
        } else hostPullCount = 0;
      });
    }
    function refreshAgents() {
      http('/bridge/agents').then(function (b) {
        agents = (b && b.agents) || [];
        if (r.onAgents) r.onAgents(agents);
      });
    }
    function refreshMessages() {
      if (targetKey && targetKey !== '__all__') {
        var q = '/bridge/messages?agentId=' + encodeURIComponent(targetKey) + '&limit=60';
        if (lastSince) q += '&since=' + encodeURIComponent(lastSince);
        var isFull = !lastSince;
        http(q).then(function (b) {
          if (!b || !b.messages) return;
          // 传全部增量（含状态变化的消息——适配端自行判断插入 or 更新状态）
          if (b.messages.length) lastSince = b.messages[b.messages.length - 1].at;
          if (r.onMessages) r.onMessages(b.messages, 'agent', targetKey, isFull);
        });
      } else {
        // 全部模式：按 agent 增量合并（时间倒序）
        var all = [];
        var isFull = !Object.keys(agentSinces).length;
        Promise.all(agents.map(function (a) {
          var q = '/bridge/messages?agentId=' + encodeURIComponent(a.agentKey) + '&limit=20';
          if (agentSinces[a.agentKey]) q += '&since=' + encodeURIComponent(agentSinces[a.agentKey]);
          return http(q).then(function (b) {
            if (b && b.messages) {
              if (b.messages.length) agentSinces[a.agentKey] = b.messages[b.messages.length - 1].at;
              all.push.apply(all, b.messages.map(function (m) { return Object.assign({}, m, { agentKey: m.agentKey || a.agentKey }); }));
            }
          });
        })).then(function () {
          all.sort(function (x, y) { return String(y.at).localeCompare(String(x.at)); });
          if (r.onMessages) r.onMessages(all.slice(0, 60), 'all', null, isFull);
        });
      }
    }
    function push(text, cb) {
      // 占位符替换：[元素N]/[回答N]/[错误N] → 完整描述（host-protocol describe；未引用的候选不发送）
      var finalText = String(text || '');
      if (hp) {
        var srcPid = (hp.getDebugTarget() || {}).pageId || null; // 来源页 pageId（错误候选 frame 来源页拼接用）
        hp.getPicked().forEach(function (el) {
          var tag = el && el.tag;
          if (tag && finalText.indexOf(tag) >= 0) finalText = finalText.split(tag).join(hp.describe(el, srcPid));
        });
      }
      var body = { text: finalText, kind: 'user_message' };
      if (targetKey && targetKey !== '__all__') body.to = targetKey;
      body.ref = 'sent_' + Date.now() + '_' + Math.floor(Math.random() * 1e6); // 唯一发送标识：桥回显的消息行按 ref 对应回本 body（点击弹完整详情）
      // 来源上下文全结构化（不拼文本）：选中的目标帧（用户从下拉选 主页/iframe）→ 宿主调试页（嵌入时）→ URL 身份（launcher 打开带 pageId）→ 唯一活跃页兜底
      var srcPage = null;
      // 选中帧优先：选择 frame 后下次发消息 pageId 即该帧（url/title 用帧级，agent 可直接 page_exec 操作该帧）
      if (targetPageId) {
        var selRow = null;
        for (var i = 0; i < sessions.length; i++) {
          if (sessions[i].pageId === targetPageId) { selRow = sessions[i]; break; }
        }
        if (selRow) {
          srcPage = { pageId: selRow.pageId, url: selRow.frameUrl || selRow.url || null, title: selRow.frameTitle || selRow.title || null };
        } else {
          srcPage = { pageId: targetPageId }; // 选中的帧不在 sessions（已断）→ 至少带 pageId
        }
      } else {
        var tgt = hp && hp.getDebugTarget ? hp.getDebugTarget() : null;
        if (tgt && tgt.pageId) {
          srcPage = { pageId: tgt.pageId, url: tgt.targetUrl || null, title: tgt.title || null };
        } else if (urlIdent.pageId) {
          srcPage = { pageId: urlIdent.pageId, url: urlIdent.url || null, title: urlIdent.title || null };
        } else {
          // 兜底：唯一活跃页（独立 cockpit 无宿主/未手动选页时，消息结构至少带页面上下文；多页时交给桥侧 boundPageId→活跃页兜底）
          var act = sessions.filter(function (s) { return s.active && s.pageId; });
          if (act.length === 1) srcPage = { pageId: act[0].pageId, url: act[0].url || null, title: act[0].title || null };
        }
      }
      var payload = { source: 'window', sourceLabel: 'AI 窗' };
      if (srcPage) payload = Object.assign(payload, srcPage);
      body.payload = payload;
      http('/bridge/push', body).then(function (b) {
        if (cb) cb(body, b); // 回传实际发送的 body（文本 + 来源 payload）——发送方本地可完整展示
        if (hp && b && b.ok) {
          // 发送即消费：仅错误候选记录 dismissed（防宿主延迟重发"复活"已发送的错误）；
          // 元素/回答不 dismissed——用户后续主动重选同元素不应被拦（removeCandidate 的 dismissed 会阻止再插）
          try { (hp.getPicked() || []).forEach(function (el) { if (el && el.kind === 'error') hp.removeCandidate(el); }); } catch (e) {}
          hp.setPicked([]); // 替换过的候选清除（含 localStorage）
        }
        refreshAgents(); refreshMessages();
      });
    }
    function setTarget(key) {
      targetKey = key || '__all__';
      lastSince = null; // 切换目标 → 重新全量拉取
      if (r.onTarget) r.onTarget(targetKey);
      refreshMessages();
    }
    function getTarget() { return targetKey; }
    function setTargetPage(pid) {
      targetPageId = pid || null;
      if (r.onTargetPage) r.onTargetPage(targetPageId);
    }
    function getTargetPage() { return targetPageId; }

    // ================= pair 设备互连（可选 hook：opts.pair = { enabled, name? }） =================
    // 适配端声明启用 → start() 时自动拉起 headless pair 实例（连同一桥的设备互发消息/互传文件；
    // 协议+widget 全在 pair-client.js 公共库）。消息经 render.onPairMsg(m) 回调透出；
    // 需要 UI 的适配端直接 window.AitiPair.mount(el, { base })，不经此 hook。
    var pairInst = null;
    function getPair() {
      if (!global.AitiPair) return null;
      if (!pairInst) {
        pairInst = global.AitiPair.create({ base: base, name: (opts.pair && opts.pair.name) || null });
        if (r.onPairMsg) pairInst.on('message', function (m) { r.onPairMsg(m); });
        pairInst.start();
      }
      return pairInst;
    }

    // ================= 生命周期 =================
    function start() {
      if (started) return;
      started = true;
      if (opts.pair && opts.pair.enabled) getPair(); // 设备互连启用：自动上线本端为 pair 设备
      if (global.BridgeClient) {
        // instanceId 统一走公共库（hp.getAiInstanceId）——SSE 连接与 ai/page POST 必须同身份，否则桥查不到连接（404）
        if (!aiInstanceId) aiInstanceId = (hp && hp.getAiInstanceId) ? hp.getAiInstanceId() : 'ai-' + Math.random().toString(36).slice(2, 10);
        global.BridgeClient.connect({
          base: base, role: 'ai', instanceId: aiInstanceId,
          // AI 窗负责所有连接：桥 exec（无页面 session 时桥降级推 AI 连接）→ useForward 经 postMessage 转发宿主执行
          // （页面 ↔ AI 窗 postMessage 是唯一通道，页面不连桥）→ 结果由 bridge-client message 监听自动回桥
          useForward: true,
          onStatus: function (text, color) {
            if (r.onStatus) r.onStatus(text, color);
            // 桥连接状态上报宿主（host-protocol 透传）：宿主检测到断开/重连中 → 自动重载 AI 窗 iframe（断线自愈闭环）
            var state = !color ? 'unknown' : (color === '#4ade80' ? 'connected' : (color === '#f59e0b' ? 'reconnecting' : 'disconnected'));
            if (hp) { try { hp.postToHost('dbg_ai_status', { state: state, text: text || '', at: Date.now() }); } catch (e) {} }
          },
          onInteraction: function (m) { if (r.onInteraction) r.onInteraction(m); },
          onResult: function (m) { if (r.onResult) r.onResult(m); }, // 交互/执行结果回传（他端作答、超时等——适配端收尾卡片/日志）
          // 服务端 ready = 本连接已登记（含重连后重新登记）→ 宿主页身份注册此刻才稳（避免 SSE 注册与 POST 竞态 404）
          onReady: function () { if (hp) { hp.resetAiPageReport(); reportAiPage(); hp.resetSelfPageReport(); hp.reportSelfPage(base); } },
          // agent 回答（agent_settled 回桥）→ 实时刷新消息流；消息状态变化（pending→delivered→consumed）→ 本地更新
          onEvent: function (m) {
            if (!m) return;
            if (m.type === 'agent_answer') refreshMessages();
            else if (m.type === 'msg_status' && r.onMsgStatus) r.onMsgStatus(m.msgId, m.status, m.agentKey);
          },
        });
      }
      if (hp) hp.sendReady(); // 握手：宿主 flush boot/候选 + 协议探测
      reportAiPage(); // 宿主页身份（urlIdent/boot）注册到桥
      refreshSessions(); refreshAgents(); refreshMessages();
      timers.push(global.setInterval(refreshSessions, pollMs));
      timers.push(global.setInterval(refreshAgents, pollMs));
      timers.push(global.setInterval(refreshMessages, pollMs));
    }
    function stop() {
      timers.forEach(function (t) { global.clearInterval(t); });
      timers = [];
      started = false;
      if (pairInst) { try { pairInst.stop(); } catch (e) {} pairInst = null; }
      if (global.BridgeClient) { try { global.BridgeClient.disconnect(); } catch (e) {} }
    }

    return {
      start: start, stop: stop,
      setTarget: setTarget, getTarget: getTarget,
      setTargetPage: setTargetPage, getTargetPage: getTargetPage,
      push: push,
      getSessions: function () { return sessions; }, getAgents: function () { return agents; },
      getHostTarget: function () { return (hp && hp.getDebugTarget) ? hp.getDebugTarget() : null; }, // 宿主页身份（无桥 session 时仍可知页面）
      getHost: function () { return hp; }, // host-protocol 实例（候选/占位符等）
      getPair: getPair, // pair 设备互连实例（opts.pair 启用或首调时懒建；headless 协议实例）
    };
  }

  global.AitiAiWin = { create: createAiWindow };
})(window);
