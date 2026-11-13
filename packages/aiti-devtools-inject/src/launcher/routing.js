// routing 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { getPhysViewport, isTouchDevice, placePhysBox } from './viewport.js';
import { dbgMsg } from './protocol.js';
import { el } from './dom.js';

export function initRouting(ctx) {
  ctx.captureSceneSend = function () {
      var tw = (ctx.listFrames()[0] || {}).win;
      var conditions = {
        animSpeed: ctx.optState.animSpeed, netDelay: ctx.optState.netDelay, netOffline: ctx.optState.netOffline,
        darkMode: ctx.optState.darkMode, reducedMotion: ctx.optState.reducedMotion,
        timeOffsetMs: ctx.optState.timeOffsetMs, viewportW: ctx.optState.viewportW,
        blockScroll: ctx.optState.blockScroll, blockWheel: ctx.optState.blockWheel, slowTimers: ctx.optState.slowTimers,
      };
      var scene = {
        kind: 'scene_report',
        at: new Date().toISOString(),
        targetUrl: (tw && tw.location) ? tw.location.href.slice(0, 500) : ctx.url,
        conditions: conditions,
        errors: ctx.errLog.slice(0, 10),
        viewport: tw ? { w: tw.innerWidth, h: tw.innerHeight } : null,
        selection: ctx.lastPayload || null,
      };
      var condCount = Object.keys(conditions).filter(function (k) { return conditions[k] && conditions[k] !== 1; }).length;
      ctx.sendToAi({ kind: 'scene_report', report: scene });
      ctx.addMsg('sys', '📸 现场已发送给 AI：' + ctx.errLog.length + ' 条错误 · ' + condCount + ' 个非默认模拟条件');
      }

  ctx.addMsg = function (role, text) {
      ctx.postToAi({ type: 'dbg_system_log', payload: { role: role, text: text } });
      if (!ctx.aiIframe) console.log('[dbg]', role, text); // ai 未连接时 console 兜底
      }

  // AI 窗复制兑底（dbg_ai_copy_fallback）：iframe 内 clipboard 无权限 → 宿主 top-level 弹手动复制框（宿主 clipboard 可用，再试即成功）
  ctx.showCopyFallback = function (text) {
      if (!ctx.copyFallbackCard) {
        ctx.copyFallbackCard = el('div', { class: 'dbg-dialog' });
        var card = el('div', { class: 'dbg-dialog-card', style: 'width:min(560px, 94%);max-height:90%' });
        var head = el('div', { class: 'dbg-dialog-head' });
        head.appendChild(el('span', {}, ['📋 复制内容']));
        card.appendChild(head);
        var body = el('div', { class: 'dbg-dialog-body' });
        body.appendChild(el('div', {}, ['剪贴板在 AI 窗不可用——已自动全选下方内容，Ctrl/Cmd+C 直接复制：']));
        var ta = el('textarea', { readonly: 'readonly', spellcheck: 'false', style: 'width:100%;height:220px;box-sizing:border-box;white-space:pre-wrap;word-break:break-all;color:#0f172a' });
        body.appendChild(ta);
        card.appendChild(body);
        var foot = el('div', { class: 'dbg-dialog-foot' });
        var retry = el('button', { class: 'dbg-primary' }, ['📋 再试复制']);
        var close = el('button', { class: 'dbg-ghost' }, ['关闭']);
        foot.appendChild(retry);
        foot.appendChild(close);
        card.appendChild(foot);
        ctx.copyFallbackCard.appendChild(card);
        ctx.root.appendChild(ctx.copyFallbackCard);
        close.onclick = function () { ctx.copyFallbackCard.classList.remove('dbg-open'); };
        retry.onclick = function () {
          try {
            navigator.clipboard.writeText(ta.value).then(function () {
              ctx.copyFallbackCard.classList.remove('dbg-open');
              try { if (ctx.addMsg) ctx.addMsg('sys', '📋 已复制到剪贴板'); } catch (e) {}
            }, function () {});
          } catch (e) {}
        };
        ctx.copyFallbackCard.addEventListener('click', function (e) { if (e.target === ctx.copyFallbackCard) ctx.copyFallbackCard.classList.remove('dbg-open'); });
      }
      var ta2 = ctx.copyFallbackCard.querySelector('textarea');
      ta2.value = text;
      // 物理适配（counter-zoom，同 speed 面板机制）：无 viewport meta 页面（布局视口 980 → 全页缩 ~0.4×）下，
      // transform scale(1/scale) 补偿——弹窗字体/尺寸 1:1 显示，小屏不再缩小
      try {
        var _vp = getPhysViewport();
        placePhysBox(ctx.copyFallbackCard, 0, 0, _vp.w, _vp.h, _vp.scale, _vp.scaleY);
      } catch (e) {}
      ctx.copyFallbackCard.classList.add('dbg-open');
      ta2.focus();
      ta2.select();
      }

  ctx.selfAiRequested = false; // 谁触发归谁：本页顶部 InspectButton 发起的点选会话中（dbg_ai_inspect_on source===window 置位；AI 窗发起/FAB/桥 pick 清零）
  ctx.postToAi = function (msg) {
      // ============================================================
      // postToAi 归属路由：决定「launcher 要发的消息投给哪个目标窗口」。
      //
      // 两条正交规则：
      //   · 点击归属看触发方（selfAiRequested：谁触发归谁）
      //   · 宿主归属看注入形态（selfHostPage / host-protocol / aiIframe）
      //
      // 优先级（从上到下第一个命中，①② 先行）：
      //   ① _selfReq（含消息自带 _selfAttrib）    → self（本页输入框，不弹窗）——宿主顶部自点选
      //   ② aiMode==='popup'                      → aiPopup（显式独立 AI 窗）
      //   ③ _inPickSession&&aiIframe               → aiIframe（点选会话进行中：一切消息抓给 AI 窗）
      //   ④ _aiBound&&aiIframe&&!selfHostPage      → aiIframe（归属 AI 的元素/错误/桥结果：有 AI 窗即归 AI）
      //   ⑤ _aiBound&&!selfHostPage&&aiUrl&&!aiFrame→ ensureAi() 补建 → aiIframe（AI 窗未开，用 cfg.aiUrl 补建）
      //   ⑥ window.AitiHostProtocol               → self（页面自身即 AI 宿主：非 AI 指向的 ambient 消息归自己）
      //   ⑦ ctx.aiIframe                           → aiIframe（普通被调试页：消息进 AI 窗）
      //
      // 为什么 ④ 不再要求「在点选会话内」（关键）：
      //   元素/错误候选是【异步】发送的——picksAddElement 先 resolveElLoc（sourcemap 补全真实源码路径），
      //   之后才 postToAi。异步回调时 exitInspector/exitAiInspect 已把 selfAiRequested 复位成 false、
      //   把 inspectorOn/aiInspectActive/pickPanel 全部清 0。若 ④ 仍要求 _inPickSession，则发送时已 false
      //   → 落进 ⑥ self → 候选被插进宿主本页自己的输入框（而该页只是被调试目标，AI 窗才是归属方）。
      //   所以 ④ 以「消息是否 AI 指向（_aiBound）+ 是否有 AI 窗」为准，与会话标志解耦。
      //
      // 发给自己的消息打 __selfLoop（如 dbg_ai_inspect_off → exitAiInspect → 再发 → 无限递归），
      // host-protocol 消费后由 launcher handleClientMessage 入口按标记跳过（不重复处理）。
      // 完整背景 / 三入口归属矩阵 / 与 fd42f62 分歧决定：docs/aiti-devtools-launcher-postToAi-attribution.md
      // ============================================================
      var target = null, toSelf = false;
      var _type = msg && msg.type;
      var _isBridgeProto = _type === 'dbg_mcp_result' || _type === 'dbg_mcp_interaction_control' || _type === 'dbg_bridge_event';
      var _aiBound = _isBridgeProto || _type === 'dbg_ai_element' || _type === 'dbg_ai_error'; // 消息是否 AI 指向
      var _inPickSession = !!(ctx.inspectorOn || ctx.aiInspectActive || ctx.pickPanel);
      // 归属（谁触发归谁）在【生成元素/错误那一刻】就定死（selfAiRequested），随消息携带为 _selfAttrib。
      // 发送是异步的（见上），届时易变标志已被复位——所以优先用生成时刻定死值，勿再读发送时的 selfAiRequested。
      var _selfReq = !!ctx.selfAiRequested;
      if (msg && msg._selfAttrib !== undefined) _selfReq = !!msg._selfAttrib;
      if (_selfReq) {
        target = window; toSelf = true; // ① 归属 self（宿主顶部自点选按钮1）：归本页输入框（不弹窗）
      } else if (ctx.aiMode === 'popup') {
        if (ctx.aiPopup && !ctx.aiPopup.closed) target = ctx.aiPopup; // ② 显式独立 AI 窗
      } else if (_inPickSession && ctx.aiIframe) {
        target = ctx.aiIframe.contentWindow; // ③ 点选/交互会话中：抓给注入的 AI 窗
      } else if (_aiBound && ctx.aiIframe && !ctx.selfHostPage) {
        target = ctx.aiIframe.contentWindow; // ④ 归属 AI 的元素/错误/桥结果：有 AI 窗即归 AI（不依赖会话标志）
      } else if (_aiBound && !ctx.selfHostPage && ctx.cfg.aiUrl && !ctx.aiIframe) {
        // ⑤ 归属 AI、但 AI 窗还没建：补建再路由（跨实例 prod launcher 注入 dev 宿主页，cfg.aiUrl=prod）
        try { ctx.ensureAi(); } catch (e) {}
        if (ctx.aiIframe) target = ctx.aiIframe.contentWindow;
      } else if (window.AitiHostProtocol) {
        target = window; toSelf = true; // ⑥ 页面自身即 AI 宿主：非 AI 指向的 ambient 消息（boot/日志等）一律归自己
      } else if (ctx.aiIframe) {
        target = ctx.aiIframe.contentWindow; // ⑦ 普通被调试页（无 host-protocol）：消息进 AI 窗（原行为）
      }
      if (!target) {
        try { if (window.AitiHostProtocol) { target = window; toSelf = true; } } catch (e) {} // 兜底（④ 已覆盖，防御保留）
      }
      if (!target) return;
      if (toSelf) {
        var out = dbgMsg(msg); out.__selfLoop = true; // 自回发：host-protocol 消费；launcher 侧跳过
        try { target.postMessage(out, '*'); } catch (e) {}
        return;
      }
      if (!ctx.aiReady) { ctx.aiQueue.push(msg); return; }
      try { target.postMessage(dbgMsg(msg), '*'); } catch (e) {}
      }

  // AI 窗 URL 记录（宿主 localStorage——重开保留 session；不记服务端）
  ctx.saveAiUrl = function (url) {
    if (!url) return;
    try { localStorage.setItem('__dbg_ai_url', String(url).slice(0, 500)); } catch (e) {}
  };
  ctx.loadAiUrl = function () {
    try { return localStorage.getItem('__dbg_ai_url') || ''; } catch (e) { return ''; }
  };
  ctx.clearAiUrl = function () {
    try { localStorage.removeItem('__dbg_ai_url'); } catch (e) {}
  };

  // AI 窗自定义地址（用户设置的 aiti-agent / 自定义 AI 服务器地址，最高优先级）：
  // 临时切换 + 10s 协议探测，成功才落盘；失败恢复原状回退（不残留错误地址）
  ctx.saveCustomAiUrl = function (url) {
    if (!url) return;
    try { localStorage.setItem('__dbg_ai_url_custom', String(url).slice(0, 500)); } catch (e) {}
  };
  ctx.loadCustomAiUrl = function () {
    try { return localStorage.getItem('__dbg_ai_url_custom') || ''; } catch (e) { return ''; }
  };
  ctx.clearCustomAiUrl = function () {
    try { localStorage.removeItem('__dbg_ai_url_custom'); } catch (e) {}
  };

  // 用户设置 AI 服务器地址（cockpit ⚙ 推荐 aiti-agent）：临时切换 → 10s 协议探测，成功才持久化 custom；失败恢复原状回退
  ctx.applyCustomAiUrl = function (url) {
    if (!url || !/^https?:\/\//i.test(String(url))) return; // 非法地址忽略（cockpit 侧已校验，双保险）
    var prevCustom = ctx.loadCustomAiUrl() || ''; // 之前验证过的 custom（可为空）；失败时恢复它
    try { ctx.clearAiUrl(); } catch (e) {} // 用户设置新地址 → 清空追踪 URL（换 base；新 AI 窗导航后重新追踪）
    // 临时目标 URL（不落盘；探测成功后才 saveCustomAiUrl）；withAiWinMark：协商标记（见 aiwin.js）
    var sep = String(url).indexOf('?') >= 0 ? '&' : '?';
    var newUrl = ctx.withAiWinMark(String(url) + sep + '_dbg=' + Date.now() + ctx.aiPageParams());
    var popupMode = ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed;
    try {
      if (popupMode) ctx.aiPopup.location.href = newUrl; // 脚本打开的弹窗可跨域导航
      else {
        if (!ctx.aiIframe) { try { ctx.ensureAi(); } catch (e) {} }
        if (ctx.aiIframe) ctx.aiIframe.src = newUrl;
      }
    } catch (e) { try { ctx.openAiPopup(newUrl); } catch (e2) {} }
    ctx.aiReady = false;
    ctx.aiOpen = true;
    try { ctx.showAi(true); } catch (e) {}
    try { if (ctx.addMsg) ctx.addMsg('sys', '⚙ AI 地址已切换：' + String(url).slice(0, 80) + '（10s 协议探测，成功才生效；失败自动回退）'); } catch (e) {}
    // 探测：10s 内收到新 AI 窗 dbg_ai_ready（来源匹配）→ 成功并持久化；超时 → 恢复原状回退
    clearTimeout(ctx._aiSwapT);
    ctx._aiSwapUrl = url;
    ctx._aiSwapPrev = prevCustom;
    ctx._aiSwapSource = popupMode ? ctx.aiPopup : (ctx.aiIframe ? ctx.aiIframe.contentWindow : null);
    // 探测窗口：本机地址 10s；远端地址 20s（Authelia 认证跳转 + SSR 冷启动首载常超 10s——实测「首次无效再设一次才生效」的根因）
    var swapTimeout = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(url)) ? 10000 : 20000;
    ctx._aiSwapT = setTimeout(function () {
      if (!ctx._aiSwapUrl) return; // 已成功，忽略
      // 失败：恢复之前验证过的 custom（无则清除）→ 回退对应地址
      if (ctx._aiSwapPrev) ctx.saveCustomAiUrl(ctx._aiSwapPrev);
      else ctx.clearCustomAiUrl();
      ctx._aiSwapUrl = null; ctx._aiSwapPrev = null; ctx._aiSwapSource = null;
      var backUrl = ctx.aiUrlFor();
      try {
        if (ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed) ctx.aiPopup.location.href = backUrl;
        else if (ctx.aiIframe) ctx.aiIframe.src = backUrl;
      } catch (e) {}
      ctx.aiReady = false;
      try { if (ctx.addMsg) ctx.addMsg('sys', '⚠ AI 地址连接失败（' + Math.round(swapTimeout / 1000) + 's 无响应）——已回退本窗口，请确认地址后重试'); } catch (e) {}
    }, swapTimeout);
  };

  // 真实 URL 探测（前端发回用户地址栏 URL）：顶层时 location.href 即地址栏；iframe 内（如 pi-web 预览壳嵌站点）
  // 用户地址栏是外层——同源可读 window.top/parent；跨域读不到用 document.referrer（外层页 URL）兑底。
  ctx.realUrl = function () {
    var isTop = false;
    try { isTop = (window.self === window.top); } catch (e) {}
    if (isTop) { try { return (window.location && window.location.href) || ''; } catch (e) {} }
    try { if (window.top && window.top !== window && window.top.location && window.top.location.href) return window.top.location.href; } catch (e) {}
    try { if (window.parent && window.parent !== window && window.parent.location && window.parent.location.href) return window.parent.location.href; } catch (e) {}
    try { var r = document.referrer || ''; if (r) return r; } catch (e) {}
    try { return (window.location && window.location.href) || ''; } catch (e) {}
    return '';
  };

  // 方案 D：AI 窗初始化 boot——带 pageId/instanceId/frameId/bridge/targetUrl（AI 只记 pageId，零配置）
  ctx.sendAiBoot = function () {
    try {
      var fr = ctx.listFrames()[0] || null;
      // 目标页 url/title：优先顶层 window（launcher 注入在页面顶层，跨域 AI 窗 iframe 不影响）；fr 兜底
      var targetUrl = '';
      var targetTitle = '';
      try { targetUrl = (ctx.realUrl() || '').slice(0, 500) || ((fr && fr.win && fr.win.location) ? fr.win.location.href.slice(0, 500) : ''); } catch (e) { try { targetUrl = (fr && fr.win && fr.win.location) ? fr.win.location.href.slice(0, 500) : ''; } catch (e2) {} }
      try { targetTitle = (document && document.title) ? document.title.slice(0, 200) : ((fr && fr.win && fr.win.document && fr.win.document.title) ? fr.win.document.title.slice(0, 200) : ''); } catch (e) { try { targetTitle = (fr && fr.win && fr.win.document && fr.win.document.title) ? fr.win.document.title.slice(0, 200) : ''; } catch (e2) {} }
      ctx.postToAi(dbgMsg({
        type: 'dbg_ai_boot',
        payload: {
          pageId: ctx.pageIdentity() + '/' + (ctx.selFrameId() || ctx.T_HOST),
          instanceId: ctx.pageIdentity(),
          frameId: ctx.selFrameId() || ctx.T_HOST,
          bridge: (ctx.cfg && ctx.cfg.bridgeBase) || null,
          targetUrl: targetUrl,
          title: targetTitle,
          frames: ctx.frameTreeInfos(), // 帧树（host+fN+嵌套）：AI 窗展示/选择 iframe
          frameTick: (ctx._frameTick = (ctx._frameTick || 0) + 1), // iframe 变化重发 boot 去重用
        },
      }));
    } catch (e) {}
  }

  // 元素载荷补全（转发 AI 窗累积前）：补 pageId/桥地址/目标页 url/title——
  // AI 快速理解元素 + 经 aiti 工具（page_exec/aiti_page_exec 传 pageId）操作该页面需要
  ctx.enrichElPayload = function (p) {
    if (!p || typeof p !== 'object') return p;
    try {
      var fr = ctx.listFrames()[0] || null;
      var url = (p.frame && p.frame.url) ? p.frame.url : '';
      var title = (p.frame && p.frame.title) ? p.frame.title : '';
      if (!url) { try { url = (ctx.realUrl() || '').slice(0, 500) || (ctx.url || ''); } catch (e) {} }
      if (!title) { try { title = (fr && fr.win && fr.win.document && fr.win.document.title) ? fr.win.document.title.slice(0, 200) : ''; } catch (e) {} }
      var pageId = p.pageId || (ctx.pageIdentity() + '/' + (ctx.selFrameId() || ctx.T_HOST));
      var out = Object.assign({}, p);
      if (pageId) out.pageId = pageId;
      out.frame = { url: url, title: title, pageId: pageId || null };
      out.bridge = (ctx.cfg && ctx.cfg.bridgeBase) || null;
      out.mcp = {
        tool: 'page_exec',
        pageId: pageId || null,
        bridge: out.bridge,
        note: '传 pageId 参数即可操作该页面（MCP: page_exec / 扩展: aiti_page_exec）',
      };
      return out;
    } catch (e) { return p; }
  };

  // ---- 目标路由层（方案 C）：目标 = 宿主(host) + 宿主内真实 iframe（frameId 参照，_f 定向） ----
  // 阶段 3：目标 = 宿主 + 宿主真实 iframe（postToTarget/自建预览已删除）
  ctx.T_HOST = 'host';

  // 枚举宿主所有同源 iframe（AI 窗排除；hub.html 摆的目标 iframe 也在内）——单独命令
  ctx.listFrames = function () {
    var out = [];
    try {
      [].forEach.call(document.querySelectorAll('iframe'), function (f) {
        if (f === ctx.aiIframe) return;
        var src2 = ''; try { src2 = (f.getAttribute('src') || '').slice(0, 80); } catch (e) {}
        out.push({ frameId: 'f' + out.length, idx: out.length, src: src2 || '(srcdoc/inline)', win: f.contentWindow, el: f });
      });
    } catch (e) {}
    return out;
  };

  // 按 frameId 取 frame client；host 返回宿主自身 window.__dbg（注入 client，含完整 CDP 表）
  ctx.frameClient = function (frameId) {
    if (!frameId || frameId === ctx.T_HOST) return window.__dbg || null;
    var fr = ctx.listFrames()[parseInt(String(frameId).slice(1), 10) || 0];
    return (fr && fr.win) ? fr.win.__dbg : null;
  };

  // frameId（桥/方案 D 语义：host/fN）→ 宿主 frameId：同构（host/f0/f1），直接透传
  ctx.frameIdOf = function (frameId) {
    if (!frameId || frameId === ctx.T_HOST) return ctx.T_HOST;
    return String(frameId);
  };

  // 帧树信息（[{id,title,url,name,src,parentId}]）：顶部 iframe id=fN 与桥可寻址一致；嵌套同域递归（id=fN/0/…，跨域仅元素属性）
  // host 条目固定带头（页面自身）；供 boot 帧树（AI 窗下拉展示）共用
  ctx.frameTreeInfos = function () {
    var infos = [];
    try { infos.push({ id: ctx.T_HOST, parentId: null, title: document.title || '', url: (ctx.realUrl ? ctx.realUrl() : location.href).slice(0, 500) || location.href.slice(0, 500) }); } catch (e) { infos.push({ id: ctx.T_HOST, parentId: null }); }
    var frames = ctx.listFrames();
    (function walk(list, parentId) {
      for (var i = 0; i < list.length; i++) {
        var fr = list[i];
        var id = parentId ? parentId + '/' + i : fr.frameId; // 顶层 = fN；嵌套 = 父id/序号
        var info = { id: id, parentId: parentId || null };
        try {
          var w = fr.win, el = fr.el;
          try { info.name = (el && (el.name || '')) || ''; } catch (e) {}
          try { info.src = (el && (el.getAttribute('src') || el.src || '')) || ''; } catch (e) {}
          try { if (w.location) info.url = w.location.href.slice(0, 500); } catch (e) { /* 跨域：仅元素属性 */ }
          try { if (w.document) info.title = w.document.title; } catch (e) {}
          // 嵌套 iframe（同域可读）——排除 AI 窗（launcher 自身控件）
          if (w && w.document) {
            var subs = [];
            [].forEach.call(w.document.querySelectorAll('iframe, frame'), function (sub) {
              if (sub.closest && sub.closest('#__dbg_launcher, .dbg-ai-win, .dbg-dialog')) return;
              subs.push({ frameId: 'x' + subs.length, win: sub.contentWindow, el: sub });
            });
            if (subs.length) walk(subs, id);
          }
        } catch (e) {}
        infos.push(info);
      }
    })(frames, null);
    return infos;
  };

  // 注：launcher 不连桥（宿主与桥零关系）——连桥（role=ai）与宿主 postMessage 交互、页面事件上报
  // （dbg_bridge_event → AI 窗 BridgeClient.postEvent）全部由 AI 窗口负责；帧树同步经 boot → AI 窗 → /bridge/ai/frames

  // 消息定向：host → 宿主 self client（window.postMessage 由其监听处理）；iframe → postMessage 带 _f 参照
  ctx.postToFrame = function (frameId, msg) {
    if (!frameId) frameId = ctx.T_HOST;
    if (!frameId || frameId === ctx.T_HOST) {
      try { window.postMessage(dbgMsg(msg), '*'); } catch (e) {}
      return;
    }
    var fr = ctx.listFrames()[parseInt(String(frameId).slice(1), 10) || 0];
    if (fr && fr.win) fr.win.postMessage({ __dbg: 1, _f: frameId, ...msg }, '*');
  };

  // 模拟 hover（真实事件派发）：hudHoverOn=true → 发 dbg_simulate_hover（mouseover/mouseenter 进入并持久）；
  // false → 广播 dbg_simulate_hover_off（mouseleave 清除）。开启定向选区所在页；关闭广播全部 frame
  // （pin 的 hover 可能落在其它 iframe——每个 client 记忆自己的 _hoverSimEl，广播才保证全部清干净）。
  ctx.applyHoverSim = function () {
    if (ctx.hudHoverOn) {
      ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_simulate_hover' });
    } else {
      ctx.broadcast({ type: 'dbg_simulate_hover_off' });
    }
  };

  // CDP 执行：frameId 缺省=宿主；host 走宿主 self client 本地 CDP，iframe 走 postMessage 带 _f
  // 点击 inspect 识别的源文件 → 经 AI 窗 BridgeClient 转发桥 open_file → server 后台编辑器打开
  ctx.openFileAt = function (file, line) {
    if (!file) return;
    ctx.postBridgeEvent('open_file', { file: file, line: line || null });
    ctx.addMsg('sys', '📂 已请求后台打开：' + file + (line ? ':' + line : ''));
  }

  ctx.execInPage = function (cmd, args, frameId) {
    frameId = frameId || ctx.T_HOST;
    return new Promise(function (resolve) {
      var id = 'req_' + (++ctx.execInPage._n) + '_' + Date.now();
      ctx.pendingCommands[id] = resolve;
      ctx.postToFrame(frameId, { type: 'dbg_exec', payload: { requestId: id, cmd: cmd, args: args } });
    });
  };

  // ---- 选区来源 → frameId（阶段 2）：工具条命令按当前选区所在 document 定向 ----
  ctx.currentFrameId = ctx.T_HOST; // 当前选区来源：'host' | 'fN'（dbg_element_hover 时更新）
  ctx.sourceFrameId = function (source) {
    if (source === 'self') return ctx.T_HOST;
    var frames = ctx.listFrames();
    for (var i = 0; i < frames.length; i++) if (frames[i].win === source) return frames[i].frameId;
    return ctx.T_HOST;
  };
  // 工具条命令定向目标：有选区 → 选区所在 document；无选区 → 第一个宿主 iframe（f0，hub 摆的目标页）；无 iframe → host
  ctx.selFrameId = function () {
    if (ctx.currentFrameId) return ctx.currentFrameId;
    var frames = ctx.listFrames();
    if (frames.length) return frames[0].frameId;
    return ctx.T_HOST;
  };
  // 广播：宿主 self + 全部宿主 iframe（enter/exit inspector、ai_pick 等生命周期消息）
  ctx.broadcast = function (msg) {
    ctx.postToFrame(ctx.T_HOST, msg);
    var frames = ctx.listFrames();
    for (var i = 0; i < frames.length; i++) ctx.postToFrame(frames[i].frameId, msg);
  };
  // iframe 源在宿主页的偏移（工具条/HUD 定位：iframe 内坐标 + 偏移 = 宿主坐标）
  ctx.frameOffset = function (source) {
    if (source === 'self') return { left: 0, top: 0 };
    var frames = ctx.listFrames();
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].win === source) {
        try { var r = frames[i].el.getBoundingClientRect(); return { left: r.left, top: r.top }; } catch (e) {}
        return { left: 0, top: 0 };
      }
    }
    return { left: 0, top: 0 };
  };

  ctx.sendToAi = function (payload) {
      if (ctx.cfg.aiUrl) {
        ctx.ensureAi();
        ctx.showAi(true);
        ctx.postToAi({ type: 'dbg_user_message', payload: payload });
        // 用户消息回显由 ai.html 的 dbg_user_message 显示（不重复 addMsg）
      } else {
        // 后备：endpoint 或 console
        if (ctx.cfg.endpoint && ctx.cfg.sessionId) {
          fetch(ctx.cfg.endpoint + '/' + ctx.cfg.sessionId + '/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ctx.cfg.dbgToken },
            body: JSON.stringify({ type: 'element_inspect', ...payload }),
          }).then(function (r) { return r.json(); }).catch(function (e) { console.error(e); });
        } else {
          console.log('[dbg-launcher] → AI（console 模式）', JSON.stringify(payload, null, 2));
          ctx.addMsg('sys', 'AI 通道未配置（aiUrl/endpoint 为空），已回显到 console。');
        }
      }
      }

  ctx.sendText = function (text) {
      if (!text.trim()) return;
      // 用户消息在 AI 主窗口（ai.html）的对话输入框发送；这里保留函数供 handle/测试调用
      ctx.sendToAi({ kind: 'text', text: text });
      }

  ctx.toggleAi = function () {
      if (ctx.aiMode === 'popup') {
        // 新窗口模式：💬 只负责打开/聚焦新窗口，不 toggle 关闭——关闭走窗口自身 ✕，监测到后自动回内嵌模式；
        // 弹窗已关（监测未及，1.5s 内）时点按手势重新打开。避免“点了没反应”（弹窗被关掉但页面上看不到变化）
        ctx.aiOpen = true;
        ctx.ensureAi();
        ctx.showAi(true);
        ctx.aiBtn.classList.add('dbg-on');
        ctx.saveDbgState();
        if (ctx.inspectorOn) ctx.exitInspector();
        return;
      }
      ctx.aiOpen = !ctx.aiOpen;
      ctx.ensureAi(); // AI 主窗口（对话 + CDP 模拟）
      ctx.showAi(ctx.aiOpen);
      ctx.aiBtn.classList.toggle('dbg-on', ctx.aiOpen);
      ctx.saveDbgState(); // 记录开/关（刷新后恢复）
      if (ctx.inspectorOn) ctx.exitInspector();
      }

  // 事件拦截提示条（页面底部/顶部 toast）：纯信息展示，pointer-events 常关——不吞提示位置下方页面元素的点击。
  // 闪避鼠标：拦截发生在视口下半部 → 提示挪到上半（反之在底部）；无坐标（键盘/scroll/focus）沿用上次侧。
  // 放行走工具条 🔒 放行方案下拉或 空格/Tab 快捷键
  ctx.showBlockedTip = function (category, type, evX, evY) {
      var tip = ctx.root.querySelector('.dbg-block-tip');
      if (!tip) {
        tip = el('div', { class: 'dbg-block-tip' });
        ctx.root.appendChild(tip);
      }
      var labels = { click: '点击', hover: '悬停', key: '键盘', wheel: '滚轮', scroll: '滚动', touch: '触摸', focus: '聚焦' };
      var label = labels[category] || category || '';
      tip.innerHTML = '🛡 已拦截 <b>' + label + '</b> 事件（' + (type || category || '') + '）：页面交互已冻结——放行请用工具条 🔒 放行方案（空格/Tab 一键切换）';
      // 闪避定位：拦截点在下半屏 → 上半展示；在上半屏 → 底部展示。小屏模式底部需抬高避让固定 HUD。
      // clientX/Y 与 innerHeight 同为 CSS px 坐标系，缩放页无需 counter-zoom 补偿
      try {
        var _small = ctx.root.classList.contains('dbg-phys-small');
        var _vh = window.innerHeight || 800;
        var _side = (typeof evY === 'number') ? ((evY >= _vh / 2) ? 'top' : 'bottom') : (tip.__side || 'bottom');
        tip.__side = _side;
        if (_side === 'top') { tip.style.bottom = 'auto'; tip.style.top = '10px'; }
        else { tip.style.top = 'auto'; tip.style.bottom = (_small ? '68px' : '10px'); }
      } catch (e) {}
      tip.style.opacity = '1';
      clearTimeout(tip.__t);
      clearTimeout(tip.__t2);
      tip.__t = setTimeout(function () {
        tip.style.opacity = '0';
        // 淡出（.25s）结束后移除 DOM：不留 opacity:0 残骸（透明但拦截下方元素点击）
        tip.__t2 = setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 260);
      }, 3000);
  };

  ctx.handleClientMessage = function (m, source) {
      if (!m || m.__dbg !== 1) return;
      // self 宿主回发防护：launcher 自己 postToAi 发给自己 window 的消息（__selfLoop，见 postToAi）——
      // host-protocol（aiti-client）已在同页消费（候选进输入框/状态同步），launcher 不回处理，
      // 防 dbg_ai_inspect_off → exitAiInspect → 再发 → 无限递归。
      if (m.__selfLoop) return;
      // 孤儿弹窗清理：宿主已在内嵌模式，但之前打开的 AI 新窗口还活着（每 5s 心跳）——它已无宿主管理（消息不会路由给它），
      // 关闭避免残留窗口占屏（用户在残窗里点不到 fab 以为“点击无效”）。排除：宿主自身/内嵌 AI iframe/目标 iframe。
      if (ctx.aiMode !== 'popup' && m.type === 'dbg_ai_ready' && source && source !== window &&
          typeof source.close === 'function' &&
          !(ctx.aiIframe && source === ctx.aiIframe.contentWindow) &&
          !ctx.listFrames().some(function (f) { return f.win === source; })) {
        try { source.close(); } catch (e) {}
        try { if (ctx.addMsg) ctx.addMsg('sys', '🪟 已关闭残留的 AI 独立窗口（当前为页面内窗口；需要时可点 ⧉ 重新打开独立窗口）'); } catch (e) {}
      }
      // 新窗口模式 + 弹窗句柄丢失（宿主刷新后 ctx.aiPopup 为 null）：从弹窗发来的任意消息 adopt e.source 重建引用。
      // 排除宿主自身（self 走回调不经消息事件）与已知目标 iframe（fN）——弹窗不是宿主 iframe，不会误认领。
      if (ctx.aiMode === 'popup' && !ctx.aiPopup && source && source !== window && typeof source.postMessage === 'function') {
        var _known = ctx.listFrames().some(function (f) { return f.win === source; });
        if (!_known) {
          ctx.aiPopup = source;
          ctx._restoringPopup = false; // 恢复完成（心跳认领）——后续 ensureAi 正常 openAiPopup
          try { ctx._aiOnReady(false); } catch (e) {} // 就绪：补发 boot/队列/缓存候选（幂等）
          try { if (ctx.addMsg) ctx.addMsg('sys', '🪟 已重新连接 AI 独立窗口（窗口未重载，会话保持）'); } catch (e) {}
        }
      }
      switch (m.type) {
        case 'dbg_click_released':
          // 点击已放行给页面（菜单/弹层在点击处弹出）→ HUD 让位隐藏：
          // 可见 HUD 会盖住弹出的菜单且拦截其下方页面交互（无法 hover/点击菜单项）
          if (ctx.hideHud) ctx.hideHud();
          break;
        case 'dbg_event_blocked':
          // 事件拦截提示：被冻结的页面交互 → 底部/顶部提示条（类别与放行方案维度一致）。
          // 拦截点坐标（iframe 来源加宿主页偏移）→ 提示条闪避鼠标：下半屏拦截 → 提示挪上半，反之亦然
          var _bp = m.payload || {};
          var _bx = null, _by = null;
          if (typeof _bp.mouseY === 'number') {
            var _bo = ctx.frameOffset(source);
            _bx = (typeof _bp.mouseX === 'number' ? _bp.mouseX : 0) + _bo.left;
            _by = _bp.mouseY + _bo.top;
          }
          ctx.showBlockedTip(_bp.category || '', _bp.type || '', _bx, _by);
          break;
        case 'dbg_iframe_ready':
          // 阶段 3：宿主内 iframe 就绪提示（launcher 不再自建预览；ready 仅记录）
          if (source === 'self') break;
          ctx.addMsg('sys', 'iframe 就绪：' + (m.payload && m.payload.url) +
            (m.payload && m.payload.frameworks && m.payload.frameworks.length ? '（框架：' + m.payload.frameworks.join('/') + '）' : ''));
          break;
        case 'dbg_ai_confirm': {
          // AI 点选确认：回传当前选区给 AI 窗（累积待发送）+ 恢复 hover（可继续连续选择下一个）
          var aiEl = state.selected || state.hovered;
          if (aiEl) post({ type: 'dbg_ai_picked', payload: aiPickPayload(aiEl) });
          state.engaged = false;
          clearOutline(state.selOutline);
          // 恢复 hover 快选（工具条隐藏 + 宿主 hover 恢复）——先置空避免 setHovered 同元素短路
          state.hovered = null;
          setHovered(aiEl);
          break;
        }
        case 'dbg_mouse_move': {
          if (ctx.hud && ctx.hud.style.opacity === '1' && !ctx.hudUserPos && m.payload) {
            var vp2 = getPhysViewport();
            var mvX = (m.payload.mouseX || 0) + ctx.frameOffset(source).left;
            var hw3 = ctx.hud.offsetWidth || 340;
            var nl = mvX - hw3 / 2;
            if (nl < 4) nl = 4;
            if (nl + hw3 > window.innerWidth - 4) nl = window.innerWidth - hw3 - 4;
            ctx.hud.__vis = { left: nl, top: parseFloat(ctx.hud.style.top) || 0 };
            ctx.hud.style.left = (Math.abs(vp2.scale - 1) < 0.01 ? nl : nl / vp2.scale) + 'px';
          }
          break;
        }
        case 'dbg_current_selector': {
          // # 快速选择：自动填当前选区 selector（可调整重定位）——动态查找（selInputRow 在工具条构建子函数作用域内）
          var selRow = ctx.root.querySelector('.dbg-sel-input-row');
          if (selRow && selRow.style.display === 'flex') {
            var selInput2 = selRow.querySelector('input');
            var sel2 = (m.payload && m.payload.selector) || (m.payload && m.payload.xpath) || '';
            if (selInput2 && sel2) {
              selInput2.value = sel2;
              // 不自动全选（用户要能点击定位改某一段）：光标放末尾
              try { selInput2.setSelectionRange(sel2.length, sel2.length); } catch (e) {}
            }
          }
          break;
        }
        case 'dbg_selection_cancelled':
          ctx.root.querySelector('.dbg-sel-label').textContent = '——';
          ctx.resetToolbar();
          break;
        case 'dbg_hover_skipped':
          // hover 抑制提示（临时诊断已清理，仅保留 break）
          break;
        case 'dbg_element_hover':
          // 交互点选模式（pickPanel）：记录选区（供工具条 ✓ 确认发送用）——
          //   不 break：工具条照常显示（一套 inspect 系统——用户要求，不再有第二套 pick HUD）
          if (ctx.pickPanel && m.payload) ctx.updatePickPanelLabel(m.payload);
          // 守卫：Inspector 未激活时丢弃 hover 消息（防退出后残留消息重建 HUD）
          if (!ctx.inspectorOn && !ctx.aiInspectActive) {
            if (ctx.hud && ctx.hud.parentNode) { ctx.hud.parentNode.removeChild(ctx.hud); ctx.hud = null; }
            break;
          }
          // 阶段 2：选区来源 → currentFrameId（host / fN），后续工具条命令按此定向
          ctx.currentFrameId = ctx.sourceFrameId(source);
          {
            var p = m.payload;
            // 记录选区来源（阶段 3）：只有宿主自身（self）选区记 lastSelfPayload（AI 回传区分）；
            // iframe 选区按 currentFrameId 定向（confirm/导航走 postToFrame(selFrameId)）
            if (source === 'self') {
              ctx.selfEngaged = !!p.engaged;
              ctx.lastSelfPayload = p;
            } else {
              ctx.selfEngaged = false;
            }
            var label = p.tag;
            if (p.rect) label += ' ' + p.rect.w + '×' + p.rect.h;
            if (p.text) label += ' “' + p.text.trim().slice(0, 24) + '”'; // 文本直接显示（太长 CSS ellipsis）
            if (p.component) label += ' · ' + p.component;
            if (p.file) label += ' · ' + p.file.split('/').pop() + (p.line ? ':' + p.line : '');
            var labelEl = ctx.root.querySelector('.dbg-sel-label');
            labelEl.textContent = label;
            // 完整信息进 tooltip（hover 标签查看：文本/颜色/字体/路径）
            var tipParts = ['<' + p.tag + '>' + (p.text ? ' “' + p.text.trim().slice(0, 60) + '”' : '')];
            if (p.usedAt && (p.usedAt.file || p.usedAt.component)) tipParts.push('📍 调用于 ' + (p.usedAt.file ? p.usedAt.file + (p.usedAt.line ? ':' + p.usedAt.line : '') : String(p.usedAt.component)));
            if (p.color) tipParts.push('fg ' + p.color);
            if (p.bg && p.bg !== 'rgba(0, 0, 0, 0)') tipParts.push('bg ' + p.bg);
            if (p.fontSize) tipParts.push('font ' + p.fontSize);
            if (p.xpath) tipParts.push('path ' + p.xpath);
            labelEl.setAttribute('data-tip', tipParts.join(' · '));
            // hover 快选：气泡信息条（选区下方）+ 工具条不跟随
            ctx.updateHud(p, source);
            // 异步补全真实源码路径：hover 载荷的 file 是未解析的 chunk URL——解析（sourcemap/组件函数定位，
            // sourcemap 缓存后亚毫秒）完成后若 HUD 仍显示同一元素 → 重渲染 HUD + 更新工具条标签为真实文件:行。
            if (typeof ctx.resolveElLoc === 'function') {
              ctx.resolveElLoc(p).then(function () {
                try {
                  if (ctx.lastHud && ctx.lastHud.p === p && ctx.hud && ctx.hud.parentNode) {
                    // 锁定（engaged）后工具条已接管、HUD 已 hideHud：这里不重渲染 HUD——
                    //   updateHud 末尾会 opacity=1 让 HUD 复活，与已显示的工具条同屏重叠
                    //   （选区在页面顶部/底部时两者同侧必撞；中间选区上下分开不撞故此前未察觉）。
                    //   只刷新工具条标签为真实文件:行（HUD 信息由工具条接管显示）。
                    var _tbOn2 = ctx.root.querySelector('.dbg-toolbar.dbg-on');
                    if (!_tbOn2) ctx.updateHud(p, source);
                    var _lbl = ctx.root.querySelector('.dbg-sel-label');
                    if (_lbl) {
                      var _l2 = p.tag;
                      if (p.rect) _l2 += ' ' + p.rect.w + '×' + p.rect.h;
                      if (p.text) _l2 += ' “' + String(p.text).trim().slice(0, 24) + '”';
                      if (p.component) _l2 += ' · ' + p.component;
                      if (p.file) _l2 += ' · ' + String(p.file).split('/').pop() + (p.line ? ':' + p.line : '');
                      _lbl.textContent = _l2;
                    }
                  }
                } catch (e) {}
              });
            }
            if (p.engaged) {
              // 点击暂停：工具条显示并跟随选区，HUD 隐藏（工具条接管）
              // 锁定后宿主页 hover 停用：鼠标在工具条上不再弹出下层快选 HUD（只显示按钮 tooltip）
              if (ctx.selfClient && typeof ctx.selfClient.pauseHover === 'function') ctx.selfClient.pauseHover();
              try { ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_pause_hover' }); } catch (e) {} // 选区所在页 hover 同样暂停（自检⑰：临时状态 hover 另一元素选区不变）
              ctx.hideHud();
              ctx.root.querySelector('.dbg-toolbar').classList.add('dbg-on');
              if (p.rect) {
                var offX = 0, offY = 0;
                if (source !== 'self') {
                  var fo = ctx.frameOffset(source);
                  offX = fo.left; offY = fo.top;
                }
                // 工具条水平以鼠标位置居中（非选区左边——鼠标在哪工具条在哪附近）
                var tbX = (typeof p.mouseX === 'number') ? (p.mouseX + offX) : (p.rect.x + offX + p.rect.w / 2);
                ctx.floatToolbar(tbX, p.rect.y + offY, p.rect.w, p.rect.h);
              }
            } else {
              // hover 快选：工具条隐藏；恢复宿主页 hover（未锁定时双区 hover 侦查可用）
              if (ctx.selfClient && typeof ctx.selfClient.resumeHover === 'function') ctx.selfClient.resumeHover();
              try { ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_resume_hover' }); } catch (e) {}
              ctx.root.querySelector('.dbg-toolbar').classList.remove('dbg-on');
              ctx.resetToolbar();
            }
          }
          break;
        case 'dbg_element_selected': {
          var payload = m.payload;
          if (!payload) { ctx.addMsg('sys', '没有可选的元素（页面是空白？）'); break; }
          ctx.lastPayload = payload;
          ctx.dTag.textContent = payload.tag + (payload.rect ? ' ' + payload.rect.w + '×' + payload.rect.h : '') +
            (payload.text ? ' “' + payload.text.trim().slice(0, 30) + '”' : '');
          ctx.dLoc.textContent = ((payload.framework && payload.framework.file) || payload.file)
            ? ((payload.framework && payload.framework.framework) || '') + ' · ' + String((payload.framework && payload.framework.file) || payload.file).split('/').pop() + (((payload.framework && payload.framework.line) || payload.line) ? ':' + ((payload.framework && payload.framework.line) || payload.line) : '')
            : '';
          ctx.renderPreview(payload);
          ctx.showDialog();
          // 确认后：HUD 隐藏 + 工具条隐藏 + 点选退出（进入预览/发送阶段——不调 exitInspector 避免关弹窗）
          if (ctx.hud && ctx.hud.parentNode) { ctx.hud.parentNode.removeChild(ctx.hud); ctx.hud = null; }
          if (ctx.root) { var tbEl = ctx.root.querySelector('.dbg-toolbar'); if (tbEl) tbEl.classList.remove('dbg-on'); }
          ctx.inspectorOn = false;
          ctx.inspBtn.classList.remove('dbg-on');
          try { ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: false } }); } catch (e) {}
          try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {}
          try { if (window.__dbg && typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
          ctx.deactivateNestedIframes();
          break;
        }
        // ---- AI 侧消息 ----
        case 'dbg_ai_message':
          ctx.addMsg('ai', m.payload && m.payload.text || '');
          break;
        case 'dbg_user_text':
          // AI 主窗口对话输入 → 走 sendToAi（真实 AI / 模拟回），回复经 dbg_ai_message 回 AI 窗口
          // 支持关联多选：text + elements[]（AI 窗口 Inspect 累积），打包 element_report 一次发送
          if (m.payload && m.payload.elements && m.payload.elements.length) {
            ctx.sendToAi({ kind: 'element_report', report: { elements: m.payload.elements, instruction: (m.payload.text) || '' } });
          } else {
            ctx.sendToAi({ kind: 'text', text: (m.payload && m.payload.text) || '' });
          }
          break;
        case 'dbg_ai_hide_self':
          // AI 窗点选时隐藏整个弹窗（避免遮挡目标页视线）；aiOpen 置 false（fab 💬 可手动恢复）
          // 新窗口模式：AI 窗是独立窗口不遮挡页面——不隐藏（隐藏=关闭会丢会话）
          // self 触发（本页顶部 InspectButton，数据归自己）：本页即 AI——不动 launcher 自己的 AI 窗
          if (ctx.selfAiRequested) break;
          if (ctx.aiMode === 'popup') break;
          ctx.aiOpen = false;
          ctx.showAi(false);
          ctx.aiBtn.classList.remove('dbg-on');
          break;
        case 'dbg_ai_show_self':
          // self 触发：不弹 launcher 自己的 AI 窗（数据归自己时用户正在本页 AI 输入框，多余浮窗）
          // self 宿主页：页面自身即 AI 窗——预建/弹开都被 ensureAi 总闸拦住，这里直接不动
          if (ctx.selfAiRequested || ctx.selfHostPage) break;
          ctx.aiOpen = true;
          ctx.ensureAi();
          ctx.showAi(true);
          ctx.aiBtn.classList.add('dbg-on');
          break;
        case 'dbg_ai_inspect_on': {
          // 谁触发归谁：本页顶部 InspectButton 发起（source===window，self 宿主）→ 候选归本页输入框；
          // 内部 AI 窗发起（source=aiIframe/aiPopup）→ 归 AI 窗（postToAi 按此归属路由）
          ctx.selfAiRequested = (source === window);
          // AI 窗口请求点选：目标页 + 宿主页双区（与外部 Inspector 一致——hover 高亮 + 点击工具条 + ✓ 回传）
          ctx.aiInspectActive = true;
          ctx.selfEngaged = false;
          ctx.enterSelfClient(isTouchDevice() ? 'touch' : 'mouse'); // 宿主页 selfClient 激活（hub 区域可 hover 选择）
          ctx.activateNestedIframes(isTouchDevice() ? 'touch' : 'mouse'); // 宿主页内同源 iframe 也可选中
          // 阶段 3：宿主 + 全部 iframe 广播进入 Inspector（无自建预览）
          ctx.broadcast({ type: 'dbg_enter_inspector', payload: { mode: 'mouse' } });
          ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: true } });
          ctx.addMsg('sys', '🎯 AI 点选：宿主页与目标页均可 hover 选择（点击 → 工具条 → ✓ 确认回传 AI 窗）。Esc 退出。');
          try { if (ctx.showPickHint) ctx.showPickHint(); } catch (e) {} // 小屏底部 toast：点击元素选择
          break;
        }
        case 'dbg_ai_inspect_off': {
          ctx.exitAiInspect(); // 完全退出点选（target/宿主 client 退出——退出后不再可点选）
          break;
        }
        case 'dbg_ai_url': {
          // AI 窗（pi-web 页面）上报当前 URL——宿主存 localStorage（追踪 URL，重开优先用它保留 session）
          // 来源校验：仅 AI 窗窗口可上报（追踪 URL 决定 AI 窗导航目标，防任意 iframe 塞地址）
          var _aiSrcU = (ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed) ? ctx.aiPopup
            : (ctx.aiIframe ? ctx.aiIframe.contentWindow : null);
          if (!_aiSrcU || source !== _aiSrcU) break;
          // 协议活着（能响应）→ 取消追踪 URL 的 10s 加载探测
          try { if (ctx._aiTrackT) { clearTimeout(ctx._aiTrackT); ctx._aiTrackT = null; } } catch (e) {}
          if (m.payload && m.payload.url) ctx.saveAiUrl(m.payload.url);
          break;
        }
        case 'dbg_ai_set_aiurl': {
          // 用户设置 AI 服务器地址（cockpit ⚙ 推荐 aiti-agent）→ 临时切换 + 10s 探测，成功才落盘
          // 来源校验：仅 AI 窗窗口（aiIframe.contentWindow / aiPopup）可设置——postMessage 目标 '*'，防钓鱼改地址（§4.8）
          var _aiSrc1 = (ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed) ? ctx.aiPopup
            : (ctx.aiIframe ? ctx.aiIframe.contentWindow : null);
          if (!_aiSrc1 || source !== _aiSrc1) break;
          try { if (ctx.applyCustomAiUrl) ctx.applyCustomAiUrl((m.payload && m.payload.url) || ''); } catch (e) {}
          break;
        }
        case 'dbg_ai_setup_aiagent': {
          // cockpit 的「设置 aiti-agent 地址」按钮 → 宿主打开同款模态弹窗（弹窗统一在宿主层，与 copy fallback 同机制）
          // 来源校验：仅 AI 窗窗口（防任意 iframe 弹窗骚扰）
          var _aiSrc2 = (ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed) ? ctx.aiPopup
            : (ctx.aiIframe ? ctx.aiIframe.contentWindow : null);
          if (!_aiSrc2 || source !== _aiSrc2) break;
          try { if (ctx.aiAgentDlg) ctx.aiAgentDlg(); } catch (e) {}
          break;
        }
        case 'dbg_ai_title': {
          // AI 窗上报 document.title + favicon → 标题栏跟随显示（跨域 iframe 读不到 contentDocument，由 AI 窗页面主动上报）
          try { if (ctx.setAiMeta) ctx.setAiMeta(m.payload); else if (m.payload && m.payload.title && ctx.setAiTitle) ctx.setAiTitle(String(m.payload.title).slice(0, 80)); } catch (e) {}
          break;
        }
        case 'dbg_ai_copy_fallback': {
          // AI 窗复制失败（iframe 内 clipboard 无权限）→ 宿主 top-level 弹手动复制框（宿主 clipboard 可用，再试即成功）
          try { if (ctx.showCopyFallback) ctx.showCopyFallback((m.payload && m.payload.text) || ''); } catch (e) {}
          break;
        }
        case 'dbg_copy': {
          // 复制转发协议（core host-protocol 统一语义）：子窗（AI 窗/cockpit iframe）复制失败 → host（launcher）执行。
          // 优先 clipboard（host 页一般有焦点权限），失败弹手动复制框（showCopyFallback，用户 Ctrl+C 无权限要求）——终态不转发（防循环）
          const _ctxt = (m.payload && m.payload.text) || '';
          if (!_ctxt) break;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(_ctxt).then(
                function () { try { ctx.addMsg('sys', '📋 已复制（host）'); } catch (e) {} },
                function () { try { if (ctx.showCopyFallback) ctx.showCopyFallback(_ctxt); } catch (e) {} }
              );
            } else { try { if (ctx.showCopyFallback) ctx.showCopyFallback(_ctxt); } catch (e) {} }
          } catch (e) { try { if (ctx.showCopyFallback) ctx.showCopyFallback(_ctxt); } catch (err) {} }
          break;
        }
        case 'dbg_ai_ready': {
          // AI 窗口就绪握手（新窗口模式：替代 iframe load 事件；内嵌模式同用，幂等——flush 队列 + boot + 缓存候选补发）
          // 追踪 URL 探测：AI 窗协议就绪 → 加载成功（取消 10s 回退）
          try { if (ctx._aiTrackT) { clearTimeout(ctx._aiTrackT); ctx._aiTrackT = null; } } catch (e) {}
          // 自定义地址切换的协议探测：目标 AI 窗就绪 → 成功（来源匹配；探测源丢失时宽松接受）
          if (ctx._aiSwapUrl) {
            var swapOk = false;
            try { if (!ctx._aiSwapSource || (source && ctx._aiSwapSource === source)) swapOk = true; } catch (e) { swapOk = true; }
            if (swapOk) {
              var _okUrl = ctx._aiSwapUrl;
              ctx._aiSwapUrl = null; ctx._aiSwapSource = null; ctx._aiSwapPrev = null;
              clearTimeout(ctx._aiSwapT);
              try { ctx.saveCustomAiUrl(_okUrl); } catch (e) {} // 协商成功才持久化（此后重开 AI 窗用它）
              try { if (ctx.addMsg) ctx.addMsg('sys', '✅ AI 地址连接成功：' + String(_okUrl).slice(0, 80) + '——由 aiti-agent 接管'); } catch (e) {}
            }
          }
          try { if (ctx._aiOnReady) ctx._aiOnReady(false); } catch (e) {}
          if (m.payload && m.payload.title) { try { if (ctx.setAiTitle) ctx.setAiTitle(String(m.payload.title).slice(0, 80)); } catch (e) {} }
          break;
        }
        case 'dbg_ai_status': {
          // AI 窗桥连接状态上报 → 断线自动重载（内嵌模式）；popup 由 bridge-client 主动重连（重载弹窗会丢会话）
          var st = (m.payload && m.payload.state) || '';
          try {
            if (st === 'disconnected' || st === 'reconnecting') {
              // 断线：iframe 模式自动重载 AI 窗（拉新 bridge-client.js + 重新连桥注册宿主页）——自愈闭环，不等用户手动刷新
              if (ctx.aiMode !== 'popup' && ctx.aiIframe && ctx.cfg.aiUrl) {
                if (ctx._aiReloading) { /* 已在重载（防并发/连跳） */ break; }
                ctx._aiReloading = true;
                var _src = ctx.aiUrlFor(); // 追踪 URL（AI 窗上报，保留 session）优先；custom/默认兑底
                var _trk = !!(ctx.trackedAiUrl && ctx.trackedAiUrl());
                try { ctx.aiIframe.src = _src; } catch (e) {}
                try { ctx.aiTrackProbe(_trk); } catch (e) {} // 追踪 URL 重载 → 同样 10s 探测回退
                try { if (ctx.addMsg) ctx.addMsg('sys', '🔁 AI 窗桥连接断开——已自动重载（' + (st === 'reconnecting' ? '重连中' : '待重连') + '）'); } catch (e) {}
                setTimeout(function () { ctx._aiReloading = false; }, 3000); // 重载节流：3s 内不再触发
              }
              // 断开后恢复：AI 窗重连成功会再报 connected（见下），届时补发 boot/候选（_aiOnReady 幂等）
            } else if (st === 'connected') {
              try { if (ctx._aiOnReady) ctx._aiOnReady(false); } catch (e) {} // 重连成功 → 补发 boot/队列/缓存候选
              try { if (ctx.addMsg) ctx.addMsg('sys', '🔗 AI 窗桥连接已恢复'); } catch (e) {}
            }
          } catch (e) {}
          break;
        }
        case 'dbg_ai_picked':
          // 交互点选模式：元素进面板（不转发 AI 窗累积）；否则转发 AI 窗口累积
          if (ctx.pickPanel && m.payload) { ctx.updatePickPanelLabel(m.payload); break; }
          // 目标页选中元素 → 补全上下文（pageId/bridge/url）→ 转发 AI 窗口累积（缓存+重发+ack，扩展未就绪不丢）
          try { ctx.picksAddElement(ctx.enrichElPayload(m.payload)); }
          // 兜底 catch：生成时刻捕获归属（selfAiRequested→_selfAttrib），防异步发送被复位后误路由
          catch (e) { ctx.postToAi({ type: 'dbg_ai_element', _selfAttrib: !!ctx.selfAiRequested, payload: ctx.enrichElPayload(m.payload) }); }
          break;
        case 'dbg_ai_escape':
          // AI 点选时按 Esc → 退出点选模式（回到 AI 输入框）；交互点选中 = 拒绝本次点选
          if (ctx.pickPanel) { ctx.finishPickPanel({ status: 'rejected', reason: '用户按 Esc 取消' }); break; }
          ctx.exitAiInspect();
          break;
        case 'dbg_inspect_escape':
          // 外部 Inspector 内按 Esc（键盘焦点在目标 iframe 时宿主 document 收不到 keydown，由 client 转发）
          // → 退出 Inspector（等效 ✕ 按钮：取消选区并退出）
          try { ctx.exitInspector(); } catch (e) {}
          break;
        case 'dbg_command': {
          // AI 要操作页面：危险命令先弹确认卡（用户允许后才执行），结果原路回给 AI
          ctx.handleAiCommand(m.payload || {});
          break;
        }
        case 'dbg_mcp_interaction': {
          // 桥用户交互（confirm/choose/input/presence/pick_element，AI 窗 bridge-client onInteraction 同窗转发）：
          // 宿主问答面板渲染；作答经 interact.js sendInteractionResult（dbg_mcp_result）→ AI 窗回桥。
          // 历史上此分发来自页面 client 直连桥 SSE，直连形态删除后由 AI 窗转发重建（pi-web 内嵌/cockpit 均走此路）。
          ctx.handleMcpInteraction(m.payload || {});
          break;
        }
        case 'dbg_mcp_result': {
          // 服务端结算（超时/取消/agent 停止——AI 窗 onResult 转发）：关闭宿主侧对应问答/点选面板（幂等：
          // 已作答/已超时的面板本地已关，无匹配即忽略；作答回传方向的 dbg_mcp_result 是 launcher→窗口，不经此分发）
          var p2 = m.payload || {};
          if (ctx.closeHostAskPanel) ctx.closeHostAskPanel(p2.requestId);
          if (ctx.closePickPanel) ctx.closePickPanel(p2.requestId);
          if (ctx.shotCardCleanup) ctx.shotCardCleanup(); // 截屏卡：服务端结算（超时/取消/停止）同步收卡
          break;
        }
        // ---- 目标 UI 执行结果（回给 AI） ----
        case 'dbg_exec_result': {
          var pr = m.payload || {};
          var res = pr.result;
          var resolve = ctx.pendingCommands[pr.requestId];
          if (resolve) { delete ctx.pendingCommands[pr.requestId]; resolve({ ok: pr.ok, result: res }); }
          else console.warn('[dbg-exec] 收到 exec_result 但无 pending 命令：', pr.requestId, '· pending=', Object.keys(ctx.pendingCommands).join(','));
          break;
        }
        // ---- 目标页错误上报（错误 hook 捕获） ----
        case 'dbg_page_error': {
          var pe = m.payload || {};
          ctx.errLog.unshift({ kind: pe.kind, message: pe.message, stack: pe.stack, at: new Date().toISOString() });
          if (ctx.errLog.length > 20) ctx.errLog.pop();
          ctx.addMsg('sys', '⚠ 页面错误 [' + pe.kind + '] ' + pe.message + (pe.stack ? '\n' + pe.stack : ''));
          // AI 候选区：自动采集（去重，最多 3 个）→ 转发 AI 窗（pi-web aiti 扩展 → 输入框 [错误N]；失败不影响错误链路）
          try { if (ctx.picksAddError) ctx.picksAddError(pe.kind, pe.message, pe.stack, ctx.sourceFrameId ? ctx.sourceFrameId(source) : null); } catch (e) {}
          break;
        }
        // ---- eval 审计日志（用户可见，防静默执行） ----
        case 'dbg_eval_log': {
          var elog = m.payload || {};
          ctx.addMsg('sys', '🧪 eval: ' + elog.expression + ' → ' + elog.result);
          break;
        }
        // ---- console 日志 / 网络采集（方案 F：page_log / page_network → 桥环形缓冲 + MCP 工具可查） ----
        case 'dbg_ai_pull_errors': {
          // AI 窗口扩展就绪后主动拉取错过的页面错误（扩展 onMsg 注册前宿主已发——消息丢失兜底；幂等由扩展侧去重）
          if (ctx.picksPendingErrors && ctx.picksPendingErrors.length) {
            ctx.picksPendingErrors.slice().forEach(function (m) { ctx.postToAi(m); });
          }
          break;
        }
        case 'dbg_ai_pull_boot': {
          // 扩展就绪后主动拉取调试目标（boot 在 iframe load/连桥时发，可能早于扩展监听器注册——消息丢失兜底）
          try { ctx.sendAiBoot(); } catch (e) {}
          break;
        }
        case 'dbg_ai_error_ack': {
          // 扩展已处理该错误（候选区 [错误N]）→ 停止定时重发（按 message 前 80 字符匹配）
          var ak = (m.payload || {}).key;
          if (ak && ctx.picksPendingErrors) {
            ctx.picksPendingErrors = ctx.picksPendingErrors.filter(function (e2) {
              return String((e2.payload && e2.payload.message) || '').slice(0, 80) !== ak;
            });
          }
          // FAB 角标不动：留存 3 分钟（用户要求，避免一闪而过）——扩展 ack 消费只停止重发，角标由 3 分钟定时器/打开 AI 窗（showAi fabErrClear）移除
          break;
        }
        case 'dbg_ai_element_ack': {
          // 扩展已把元素放进候选区/输入框 → 停止重发（按指纹）
          try { if (ctx.picksElAck) ctx.picksElAck((m.payload || {}).fp); } catch (e) {}
          break;
        }
        // 方案 F-3：日志/网络不再实时上报——数据留在页面本地缓冲，page_logs/page_network 工具按需拉取
        case 'dbg_console_log':
        case 'dbg_console_replay':
        case 'dbg_network':
        case 'dbg_network_replay': {
          break;
        }
        // ---- MCP 桥连接状态 / 直连交互 / 直连 exec：已随页面直连桥形态删除 ----
        // （dbg_bridge_status/dbg_mcp_interaction/dbg_mcp_exec 均来自页面 client 直连桥的 SSE 转发；
        //   现行路径：桥 exec → AI 窗 bridge-client useForward → dbg_command → handleAiCommand；
        //   交互作答卡由 AI 窗（cockpit / pi-web client）直接渲染，launcher 无参与）
      }
      }

  ctx.destroy = function () {
      window.removeEventListener('message', ctx.onHostMessage);
      try { if (ctx._aiTrackT) { clearTimeout(ctx._aiTrackT); ctx._aiTrackT = null; } } catch (e) {}
      try { if (ctx._aiPopupPoll) { clearInterval(ctx._aiPopupPoll); ctx._aiPopupPoll = null; } } catch (e) {}
      try { if (ctx._aiPopupReadyT) { clearTimeout(ctx._aiPopupReadyT); ctx._aiPopupReadyT = null; } } catch (e) {}
      try { ctx.closeAiPopup(); } catch (e) {} // 新窗口模式：关闭打开的 AI 窗口
      ctx.exitSelfClient(); // 无论 inspectorOn 与否都清理 self client（⑯ 直连 enter 时 inspectorOn=false，残留监听会拦截后续点击）
      if (ctx.inspectorOn) { try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {} }
      // 断开 MutationObserver（防旧 observer 持续观察/干扰新会话）
      try { if (iframeObserver) iframeObserver.disconnect(); } catch (e) {}
      try { if (document.__dbgObserved) { /* observer 存在时 disconnect 由 iframeObserver 处理 */ } } catch (e) {}
      // 彻底移除宿主自身 client（window.__dbg 删除——"结束调试"后页面恢复干净，无注入残留）
      try { if (window.__dbg) { try { if (window.__dbg.exitInspector) window.__dbg.exitInspector(); } catch (e) {} delete window.__dbg; } } catch (e) {}
      // 重置 client hook 标志（__dbgErrHook 等残留 true 会让下次注入的 installErrorHook 直接 return——错误 hook 不重装，页面错误不再上报）
      try { delete window.__dbgErrHook; } catch (e) {}
      try { delete window.__dbgConsoleHook; } catch (e) {}
      try { delete window.__dbgNetObserver; } catch (e) {}
      // 清 FAB 错误提醒定时器（角标 3 分钟/闪烁残留）
      try { if (ctx.fabErrClear) ctx.fabErrClear(); } catch (e) {}
      if (ctx.root && ctx.root.parentNode) ctx.root.parentNode.removeChild(ctx.root);
      }

  ctx.onHostMessage = function (e) { ctx.handleClientMessage(e.data, e.source); }
}
