// aiwin 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el } from './dom.js';
import { getPhysViewport, _fixedVisual, positionPhysical, capVisW, placePhysPanel, detectScreenMode } from './viewport.js';
import { makePointerDrag, makeCardDrag } from './drag.js';
import { AI_WIN_DEFAULTS, AI_WIN_KEY } from './constants.js';
import { lsGetJSON, lsSetJSON } from './storage.js';

export function initAiwin(ctx) {
  ctx.loadAiState = function () { return lsGetJSON(AI_WIN_KEY, {});   }

  ctx.saveAiState = function () { lsSetJSON(AI_WIN_KEY, ctx.aiState);   }

  ctx.applyAiState = function () {
      if (!ctx.aiWin) return;
      ctx.aiWin.style.border = ''; // 重置（小屏全屏贴边改过；大屏回 CSS 默认 1px/12px）
      ctx.aiWin.style.borderRadius = '';
      // 小屏（设备物理 <768）：AI 窗全宽贴边（视觉宽度 = 屏宽-20）——JS 兜底按物理尺寸
      // 关键：走 positionPhysical（counter-zoom transform scale(1/scale) + vv.offset 补偿）——
      // 顶层缩放 0.38 × transform 2.61 抵消 → AI 窗整体视觉 = 布局尺寸，iframe 内部字体视觉 = CSS 值（完全自适应小屏）
      if (detectScreenMode().small) {
        // 小屏：全屏贴边（counter-zoom），默认高度 100% 铺满（最大化态），可用 ⛶ 切到 70%/⚙ 滑杆细调——贴合边不留空隙、方角（不漏页面背景）
        var _vp = getPhysViewport();
        var visW = capVisW(_vp, 0); // 全宽贴边（左右不留空隙）
        // 高度基准用可视视觉高（innerHeight×scale）——屏高（vp.h）含系统 UI/非可视区：
        //   用户记忆高度（smallHeight）可能超可视高，按屏高贴底会把 AI 窗底部推出可视下缘（不可见）
        var visVh = _fixedVisual ? ((window.visualViewport && window.visualViewport.height) || window.innerHeight)
                                 : (window.innerHeight * _vp.scaleY);
        // 旧版 smallHeight（px 值）迁移为 %（一次性；新版本只存 smallHeightPct）
        if (!ctx.aiState.smallHeightPct && ctx.aiState.smallHeight) {
          ctx.aiState.smallHeightPct = Math.round(ctx.aiState.smallHeight / visVh * 100);
          ctx.aiState.smallHeight = 0;
          try { ctx.saveAiState(); } catch (e) {}
        }
        var visH = ctx.aiState.smallHeightPct > 0 ? Math.round(visVh * Math.min(Math.max(ctx.aiState.smallHeightPct, 30), 100) / 100) : visVh; // 默认 100%（占满全屏）；用户设过则按 %
        visH = Math.min(Math.max(visH, Math.round(visVh * 0.3)), Math.round(visVh)); // 30%~可视高
        var _sdock = ctx.aiState.smallDock === 'top' ? 'top' : 'bottom'; // 默认底部
        // 公共浮层定位（与 HUD/预览弹窗/确认窗共用——抽取自 AI 窗算法）：清残留 + 可视视觉高贴边 + placePhysBox
        ctx.aiState.__vis = placePhysPanel(ctx.aiWin, {
          visW: visW, visH: visH, dock: _sdock, gap: 0, visX: 0,
          border: 'none', borderRadius: '0', overflowY: '',
          keyboard: false, // AI 窗自管位置（applyAiState 已在 vv resize 重放），不进键盘 registry
        });
        return;
      }
      var w = ctx.aiState.width, h = ctx.aiState.height;
      // 贴边模式：窗口最大 = 视口（允许完全贴边 0px 边距——用户要求靠到最边上）
      if (ctx.aiState.dock && ctx.aiState.dock !== 'free') {
        if (w > window.innerWidth) w = window.innerWidth;
        if (h > window.innerHeight) h = window.innerHeight;
        ctx.aiState.width = w; ctx.aiState.height = h;
      }
      // 贴边换算：记录 right/bottom 时动态计算 left/top；贴边只改变对应轴（另一轴保留当前实际位置）；完全贴边（0px）
      ctx.aiWin.style.width = w + 'px';
      ctx.aiWin.style.height = h + 'px';
      if (ctx.aiState.dock === 'right') {
        ctx.aiWin.style.left = 'auto'; ctx.aiWin.style.right = '0';
        ctx.aiWin.style.bottom = 'auto'; // 清残留（左右 dock 不固定上下底边）
        ctx.aiWin.style.top = (ctx.aiState.top != null ? ctx.aiState.top : 0) + 'px';
      } else if (ctx.aiState.dock === 'bottom') {
        ctx.aiWin.style.top = 'auto'; ctx.aiWin.style.bottom = '0';
        ctx.aiWin.style.right = 'auto'; // 清残留（上下 dock 不固定左右右边）
        ctx.aiWin.style.left = (ctx.aiState.left != null ? ctx.aiState.left : 0) + 'px';
      } else if (ctx.aiState.dock === 'left') {
        ctx.aiWin.style.right = 'auto'; ctx.aiWin.style.left = '0';
        ctx.aiWin.style.bottom = 'auto'; // 清残留
        ctx.aiWin.style.top = (ctx.aiState.top != null ? ctx.aiState.top : 0) + 'px';
      } else if (ctx.aiState.dock === 'top') {
        ctx.aiWin.style.bottom = 'auto'; ctx.aiWin.style.top = '0';
        ctx.aiWin.style.right = 'auto'; // 清残留
        ctx.aiWin.style.left = (ctx.aiState.left != null ? ctx.aiState.left : 0) + 'px';
      } else { // 自由位置
        ctx.aiWin.style.right = 'auto'; ctx.aiWin.style.bottom = 'auto';
        ctx.aiWin.style.left = (ctx.aiState.left != null ? ctx.aiState.left : 0) + 'px';
        ctx.aiWin.style.top = (ctx.aiState.top != null ? ctx.aiState.top : 0) + 'px';
      }
      }

  ctx.clampAiWindow = function () {
      // 防止拖出屏幕外（允许完全贴边 0px——用户要求能靠到最边上，不做 16px 边距强制）
      if (!ctx.aiState) return;
      if (detectScreenMode().small) return; // 小屏全宽贴边：尺寸由视口决定，不按 layout 980 误夹
      ctx.aiState.width = Math.min(Math.max(ctx.aiState.width, 280), window.innerWidth);
      ctx.aiState.height = Math.min(Math.max(ctx.aiState.height, 200), window.innerHeight);
      if (ctx.aiState.left != null) ctx.aiState.left = Math.min(Math.max(ctx.aiState.left, 0), window.innerWidth - ctx.aiState.width);
      if (ctx.aiState.top != null) ctx.aiState.top = Math.min(Math.max(ctx.aiState.top, 0), window.innerHeight - ctx.aiState.height);
      ctx.applyAiState();
      }

  ctx.aiInScreen = function () {
      try {
        if (!ctx.aiWin || getComputedStyle(ctx.aiWin).display === 'none') return true;
        var vp = getPhysViewport();
        var r = ctx.aiWin.getBoundingClientRect();
        var fx = _fixedVisual ? 1 : vp.scale, fy = _fixedVisual ? 1 : vp.scaleY;
        var vL = r.left * fx, vT = r.top * fy, vR = vL + r.width * fx, vB = vT + r.height * fy;
        var visL = Math.max(vL, 0), visT = Math.max(vT, 0), visR = Math.min(vR, vp.w), visB = Math.min(vB, vp.h);
        var visArea = Math.max(0, visR - visL) * Math.max(0, visB - visT);
        var winArea = Math.max(1, (vR - vL) * (vB - vT));
        return visArea / winArea > 0.4;
      } catch (e) { return true; }
      }

  ctx.resetAiDefault = function () {
      ctx.aiState.left = null; ctx.aiState.top = null; ctx.aiState.dock = undefined;
      ctx.aiState.width = AI_WIN_DEFAULTS.width; ctx.aiState.height = AI_WIN_DEFAULTS.height;
      ctx.aiState.smallDock = undefined; ctx.aiState.smallHeightPct = 0;
      ctx.aiState.__max = null; // 重置退出最大化态（按钮图标同步还原）
      if (ctx.aiSyncMaxBtn) ctx.aiSyncMaxBtn();
      ctx.applyAiState(); ctx.saveAiState();
      }

  // ---- 最大化切换（⛶ 按钮 + 双击标题栏共用一条链路）：记住原状态 ↔ 铺满视口；可随时取消还原 ----
  // 大屏：最大化 = 宽高铺满 innerWidth/innerHeight、左上角贴齐（__max 存原 w/h/left/top/dock）；
  // 小屏：本就默认全屏贴边（高度 100%），最大化切换 = 高度 100% ↔ 70%（⚙ 设置滑杆可再细调）。
  ctx.aiToggleMax = function () {
    if (!ctx.aiWin || !ctx.aiState) return;
    if (detectScreenMode().small) {
      var cur = ctx.aiState.smallHeightPct > 0 ? ctx.aiState.smallHeightPct : 100;
      ctx.aiState.smallHeightPct = cur >= 100 ? 70 : 100; // 已最大化 → 取消（70%）；未满 → 最大化
    } else if (ctx.aiState.__max) {
      var m = ctx.aiState.__max;
      ctx.aiState.width = m.w; ctx.aiState.height = m.h;
      ctx.aiState.left = m.l; ctx.aiState.top = m.t;
      ctx.aiState.dock = m.dock;
      ctx.aiState.__max = null;
    } else {
      ctx.aiState.__max = {
        w: ctx.aiState.width, h: ctx.aiState.height,
        l: ctx.aiState.left != null ? ctx.aiState.left : ctx.aiWin.offsetLeft,
        t: ctx.aiState.top != null ? ctx.aiState.top : ctx.aiWin.offsetTop,
        dock: ctx.aiState.dock,
      };
      ctx.aiState.dock = 'free';
      ctx.aiState.width = window.innerWidth; ctx.aiState.height = window.innerHeight;
      ctx.aiState.left = 0; ctx.aiState.top = 0;
    }
    if (ctx.aiSyncMaxBtn) ctx.aiSyncMaxBtn();
    ctx.applyAiState(); ctx.saveAiState(); ctx.saveDbgState();
  };
  // 最大化按钮图标/提示随状态同步（⛶ 最大化 ↔ ❐ 还原）；小屏按高度 % 判定
  ctx.aiSyncMaxBtn = function () {
    if (!ctx.aiMaxBtn || !ctx.aiState) return;
    var maxed = detectScreenMode().small
      ? (ctx.aiState.smallHeightPct > 0 ? ctx.aiState.smallHeightPct : 100) >= 100
      : !!ctx.aiState.__max;
    ctx.aiMaxBtn.textContent = maxed ? '❐' : '⛶';
    ctx.aiMaxBtn.title = maxed ? '还原窗口（退出最大化）' : '最大化窗口（铺满页面；再点还原）';
  };
  // 拖动/缩放 = 手动调整 → 自动退出最大化态（图标还原；否则松手后点 ❐ 会跳回很久前的旧位置，反直觉）
  ctx.aiDropMax = function () {
    if (ctx.aiState && ctx.aiState.__max) { ctx.aiState.__max = null; if (ctx.aiSyncMaxBtn) ctx.aiSyncMaxBtn(); }
  };

  // ---- AI 窗口方式：内嵌 iframe / 独立新窗口（window.open + postMessage 互通）----
  // 新窗口与 iframe 完全同协议（__dbg:1 + 目标 '*'），仅消息接收方不同：iframe.contentWindow vs 打开的 window；
  // 新窗口内的页面（pi-web 扩展 client / ai.html）用 window.opener.postMessage 回发（与 window.parent 同 API，跨域可读 closed/focus）。
  // 当前页身份 URL 参数（launcher 打开 AI 窗时附带）：独立 AI 窗 URL 兜底 pageId/targetUrl/title
  // （sendAiBoot 走 postMessage 有就绪竞态可能丢；URL 参数零依赖，boot 到达后 host-protocol 覆盖）
  // 页面自身稳定标识（不依赖桥——页面不连桥，身份由 launcher 直接提供；
  // localStorage 持久化：刷新复用同一 pageId（与历史 claim instanceId 语义一致，但无需桥））
  ctx.pageIdentity = function () {
    var id = '';
    try { id = localStorage.getItem('__dbg_page_id') || ''; } catch (e) {}
    if (!id) {
      var letters = 'abcdefghijklmnopqrstuvwxyz';
      id = letters[Math.floor(Math.random() * 26)] + letters[Math.floor(Math.random() * 26)] + String(Math.floor(Math.random() * 900) + 100);
      try { localStorage.setItem('__dbg_page_id', id); } catch (e) {}
    }
    return id;
  };
  ctx.aiPageParams = function () {
    try {
      var pageId = ctx.pageIdentity() + '/' + (ctx.selFrameId() || ctx.T_HOST);
      var fr = ctx.listFrames()[0] || null;
      var targetUrl = '';
      var targetTitle = '';
      try { targetUrl = (fr && fr.win && fr.win.location) ? fr.win.location.href.slice(0, 500) : ''; } catch (e) {}
      try { targetTitle = (fr && fr.win && fr.win.document && fr.win.document.title) ? fr.win.document.title.slice(0, 200) : ''; } catch (e) {}
      return '&pageId=' + encodeURIComponent(pageId) + (targetUrl ? '&targetUrl=' + encodeURIComponent(targetUrl) : '') + (targetTitle ? '&title=' + encodeURIComponent(targetTitle) : '');
    } catch (e) { return ''; }
  };
  // 追踪 URL 校验：AI 窗上报的会话 URL 必须匹配当前 base（custom 或默认推断）——防跨 base 残留/任意 URL
  ctx.trackedAiUrl = function () {
    var t = ctx.loadAiUrl();
    if (!t) return '';
    var bases = [];
    try { var c = ctx.loadCustomAiUrl ? ctx.loadCustomAiUrl() : ''; if (c) bases.push(c); } catch (e) {}
    if (ctx.cfg.aiUrl) bases.push(ctx.cfg.aiUrl);
    for (var i = 0; i < bases.length; i++) if (t.indexOf(bases[i]) === 0) return t;
    return '';
  };
  // AI 弹窗协商标记（2026-09-08）：打开 AI 窗（popup/iframe）时 URL hash 附带 #__dbg_aiwin=1。
  // AI 窗侧 host-protocol aiHost / bridge-client exec 转发 / aiti-client launcherHost 仅在该标记
  // 存在时才认 opener/parent——此前"有 opener 就认"会把任意被 window.open 的普通页面（如
  // aiti-cpu-meter「创建调试会话」跳转的 pi-web 会话页）误判成 AI 弹窗：向宿主报 dbg_ai_ready →
  // 宿主孤儿弹窗清理（routing.js handleClientMessage）把它 source.close() 秒关。约定字符串
  // '__dbg_aiwin=' 三处实现（host-protocol.js / bridge-client.js / aiti-client.mjs）同步；URL 已带
  // 标记（含双 hash 场景）不重复追加。跨版本：旧宿主拼的无标记 URL → 新 AI 窗 JS 不认 opener
  //（降级自管理，宿主刷新拉新产物后恢复）；新宿主 + 旧缓存 AI 窗 JS——旧 JS 无门槛照常工作。
  ctx.withAiWinMark = function (url) {
    url = String(url || '');
    if (url.indexOf('__dbg_aiwin=') >= 0) return url;
    return url + '#__dbg_aiwin=1';
  };
  // 回退地址：用户设置（aiti-agent）或默认推断（带 _dbg/pageId 参数；不含追踪 URL）
  ctx.aiFallbackUrl = function () {
    var custom = ctx.loadCustomAiUrl ? ctx.loadCustomAiUrl() : '';
    var base = custom || ctx.cfg.aiUrl;
    if (!base) return '';
    var sep = base.indexOf('?') >= 0 ? '&' : '?';
    return ctx.withAiWinMark(base + sep + '_dbg=' + Date.now() + ctx.aiPageParams());
  };
  ctx.aiUrlFor = function () {
    // 追踪 URL（AI 窗上报，保留 session）优先；其次用户自定义地址（aiti-agent）；最后默认推断
    var tracked = ctx.trackedAiUrl();
    if (tracked) return ctx.withAiWinMark(tracked);
    return ctx.aiFallbackUrl();
  };
  // 追踪 URL 加载探测：AI 窗以追踪 URL 打开后 10s 内无协议响应（dbg_ai_ready / dbg_ai_url）→
  // 清追踪 URL 并回退 custom/默认（AI 窗此后导航会重新上报，继续追踪）
  ctx.aiTrackProbe = function (usedTracked) {
    try { if (ctx._aiTrackT) { clearTimeout(ctx._aiTrackT); ctx._aiTrackT = null; } } catch (e) {}
    if (!usedTracked) return;
    ctx._aiTrackT = setTimeout(function () {
      ctx._aiTrackT = null;
      try { ctx.clearAiUrl(); } catch (e) {}
      var backUrl = ctx.aiFallbackUrl();
      try {
        if (ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed) ctx.aiPopup.location.href = backUrl;
        else if (ctx.aiIframe) ctx.aiIframe.src = backUrl;
      } catch (e) {}
      ctx.aiReady = false;
      try { if (ctx.addMsg) ctx.addMsg('sys', '⚠ AI 窗会话 URL 加载失败（10s 无响应）——已回退' + ((ctx.loadCustomAiUrl && ctx.loadCustomAiUrl()) ? '用户设置地址' : '默认地址') + '（AI 窗导航后将重新追踪）'); } catch (e) {}
    }, 10000);
  };
  ctx.aiUrlWithBridge = function (base, token) {
    var baseUrl = (ctx.loadCustomAiUrl ? ctx.loadCustomAiUrl() : '') || ctx.cfg.aiUrl;
    var sep = baseUrl.indexOf('?') >= 0 ? '&' : '?';
    return ctx.withAiWinMark(baseUrl + sep + 'bridge=' + encodeURIComponent(base) + '&token=' + encodeURIComponent(token) + '&_dbg=' + Date.now() + ctx.aiPageParams());
  };
  // 打开新窗口（幂等：已开则聚焦；固定窗口名 → 复用同一窗口不重复开）。popup 被浏览器拦截（返回 null）→ 回退内嵌模式
  // 分屏布局（Chrome Inspector 式 dock）：float=独立弹窗（居中自定尺寸）；left/right=贴宿主左/右缘
  // （宽度与独立弹窗默认宽一致，不占半屏）；bottom/top=贴宿主底/顶缘（全宽半高）。
  // 用宿主窗口在屏幕的几何（screenX/screenY/outerWidth/outerHeight）计算 window.open 的 features（屏幕坐标），clamp 屏内。
  ctx.aiPopupFeatures = function () {
    var layout = (ctx.aiState && ctx.aiState.popupLayout) || 'float';
    var availW = screen.availWidth || 1280, availH = screen.availHeight || 800;
    var sx = window.screenX || 0, sy = window.screenY || 0;
    var ow = window.outerWidth || availW, oh = window.outerHeight || availH;
    // 独立弹窗默认宽度（左右 dock 与之保持一致——不要太宽）
    var defW = Math.min(560, Math.max(380, Math.round(availW * 0.42)));
    var w, h, l, t;
    if (layout === 'left') {
      w = defW;
      h = Math.round(oh);
      l = Math.max(0, sx);
      t = Math.max(0, sy);
    } else if (layout === 'right') {
      w = defW;
      h = Math.round(oh);
      l = Math.min(sx + ow - w, Math.max(0, availW - w)); // 贴宿主右缘（超屏则 clamp 屏右）
      t = Math.max(0, sy);
    } else if (layout === 'bottom') {
      w = Math.round(ow);
      h = Math.max(260, Math.round(oh / 2));
      l = Math.max(0, sx);
      t = Math.min(sy + oh - h, Math.max(0, availH - h)); // 贴宿主底缘
    } else if (layout === 'top') {
      w = Math.round(ow);
      h = Math.max(260, Math.round(oh / 2));
      l = Math.max(0, sx);
      t = Math.max(0, sy); // 贴宿主顶缘
    } else { // float：居中自定尺寸
      w = defW;
      h = Math.min(760, Math.max(520, Math.round(availH * 0.82)));
      l = Math.max(0, Math.round((availW - w) / 2));
      t = Math.max(0, Math.round((availH - h) / 3));
    }
    l = Math.min(Math.max(0, l), Math.max(0, availW - w));
    t = Math.min(Math.max(0, t), Math.max(0, availH - h));
    // location=no：Firefox 隐藏 popup 地址栏（Chrome 忽略此特性，地址栏由浏览器 UI 决定，无法脚本移除/锁定）
    return 'popup=yes,width=' + w + ',height=' + h + ',left=' + l + ',top=' + t + ',location=no';
  };
  ctx.openAiPopup = function (url) {
    if (!ctx.cfg.aiUrl) return null;
    try {
      if (ctx.aiPopup && !ctx.aiPopup.closed) { try { ctx.aiPopup.focus(); } catch (e) {} return ctx.aiPopup; }
      var effUrl = url || ctx.aiUrlFor();
      var _tracked = !url && !!(ctx.trackedAiUrl && ctx.trackedAiUrl()); // 本次打开是否用了追踪 URL（10s 探测回退）
      var pop = window.open(effUrl, 'aiti-ai-popup', ctx.aiPopupFeatures());
      if (!pop) {
        ctx.addMsg('sys', '⚠ 浏览器拦截了独立窗口——已退回页面内窗口（点 ⧉ 可再次尝试；直接点击时不会被拦截）');
        ctx.setAiMode('iframe'); // 记录 mode=iframe + 重建内嵌窗口（默认隐藏）
        ctx.aiOpen = true;
        try { ctx.showAi(true); } catch (e) {} // 显示回退的内嵌窗口（避免 fab 亮着但看不到 AI 窗）
        if (ctx.aiBtn) ctx.aiBtn.classList.add('dbg-on');
        ctx.saveDbgState();
        return null;
      }
      ctx.aiPopup = pop;
      ctx.aiReady = false;
      try { ctx.aiTrackProbe(_tracked); } catch (e) {} // 追踪 URL 打开 → 10s 无协议响应回退 custom/默认
      // ready 兜底：扩展 client 的 dbg_ai_ready 可能因监听器未注册而丢——超时后按就绪补发（boot/缓存候选多轮重发幂等）
      clearTimeout(ctx._aiPopupReadyT);
      ctx._aiPopupReadyT = setTimeout(function () { try { ctx._aiOnReady(false); } catch (e) {} }, 2000);
      // 关闭轮询：用户关掉新窗口 → 同步 fab/状态（window.open 的 closed 跨域可读）
      if (!ctx._aiPopupPoll) {
        ctx._aiPopupPoll = setInterval(function () {
          try {
            if (ctx.aiPopup && ctx.aiPopup.closed) {
              ctx.aiPopup = null;
              if (ctx.aiMode === 'popup') {
                // 用户手动关闭新窗口 → 回到内嵌模式（记录 + 重建内嵌窗口；未主动关则显示，经 💬 主动关则保持隐藏）
                var _wasOpen = ctx.aiOpen;
                ctx.setAiMode('iframe'); // 记录 mode=iframe + 重建内嵌窗口（默认隐藏）
                ctx.addMsg('sys', '🪟 AI 独立窗口已关闭——已回到页面内窗口' + (_wasOpen ? '' : '（点 💬 可重新打开）'));
                if (_wasOpen) {
                  ctx.aiOpen = true;
                  try { ctx.showAi(true); } catch (e) {}
                  if (ctx.aiBtn) ctx.aiBtn.classList.add('dbg-on');
                }
                ctx.saveDbgState();
              }
            }
          } catch (e) {}
        }, 1500);
      }
      return pop;
    } catch (e) { return null; }
  };
  ctx.closeAiPopup = function () {
    try { if (ctx.aiPopup && !ctx.aiPopup.closed) ctx.aiPopup.close(); } catch (e) {}
    ctx.aiPopup = null;
    ctx.aiReady = false;
  };
  // ⧉ 下拉：AI 新窗口布局选择（Chrome Inspector 式 dock）——浮动 / 左·右并排 / 底·顶横排。
  // 选中即持久化（aiState.popupLayout）并打开/重排；iframe 模式选中 → 切新窗口模式。
  ctx.aiPopupMenu = function (anchor) {
    try {
      var existing = ctx.root.querySelector('.dbg-ai-pop-menu');
      if (existing) { existing.remove(); return; }
      var menu = el('div', { class: 'dbg-ai-pop-menu' });
      menu.style.zIndex = '2147483647'; // 高于 AI 窗（2147483642）
      var layout = (ctx.aiState && ctx.aiState.popupLayout) || 'float';
      [
        ['float', '⧉ 浮动窗口', '独立小窗，可自由移动、调整大小'],
        ['left', '⇤ 左侧并排', '贴靠浏览器左缘，与页面左右分屏'],
        ['right', '⇥ 右侧并排', '贴靠浏览器右缘，与页面左右分屏'],
        ['bottom', '⇊ 底部横排', '贴靠浏览器底部，上下分屏'],
        ['top', '⇈ 顶部横排', '贴靠浏览器顶部，上下分屏'],
      ].forEach(function (d) {
        var item = el('div', { class: 'dbg-ai-pop-menu-item' + (layout === d[0] ? ' dbg-on' : '') }, []);
        item.appendChild(el('span', {}, [d[1]]));
        item.appendChild(el('span', { class: 'dbg-ai-pop-menu-desc' }, [d[2]]));
        item.addEventListener('click', function (ev) {
          ev.stopPropagation();
          ctx.aiState.popupLayout = d[0];
          try { ctx.saveAiState(); } catch (e) {} // 布局持久化（下次打开照着来）
          try { if (menu.parentNode) menu.parentNode.removeChild(menu); } catch (e) {}
          // 打开/重排：popup 已开且布局不同 → 关掉按新布局重开（popup URL 会话经 dbg_ai_url 记录保留）
          if (ctx.aiMode === 'popup' && ctx.aiPopup && !ctx.aiPopup.closed) {
            try { ctx.closeAiPopup(); } catch (e) {}
          }
          ctx.aiOpen = true;
          if (ctx.aiMode !== 'popup') {
            ctx.setAiMode('popup'); // iframe → 切新窗口模式（内部 ensureAi 按新布局打开弹窗）
          } else {
            try { ctx.ensureAi(); } catch (e) {}
          }
          try { ctx.showAi(true); } catch (e) {}
          if (ctx.aiBtn) ctx.aiBtn.classList.add('dbg-on');
          ctx.saveDbgState();
          ctx.addMsg('sys', '🪟 AI 已在独立窗口打开（' + d[1] + '）——关闭该窗口即回到页面内');
        });
        menu.appendChild(item);
      });
      ctx.root.appendChild(menu);
      // 定位到 ⧉ 下方（counter-zoom 跟随缩放；下方放不下翻上方）
      try {
        var _vp = getPhysViewport(), _r = anchor.getBoundingClientRect();
        var _fx = _fixedVisual ? 1 : _vp.scale, _fy = _fixedVisual ? 1 : _vp.scaleY;
        var _vL = Math.max(4, _r.right * _fx - 170), _vT = _r.bottom * _fy + 4;
        positionPhysical(menu, _vL, _vT, _vp.scale, _vp.scaleY);
        requestAnimationFrame(function () {
          try {
            var _r2 = menu.getBoundingClientRect();
            var _w2 = _r2.width * _fx, _h2 = _r2.height * _fy;
            // 只 clamp 屏内（防超屏），不强制贴屏右——下拉菜单保持 ⧉ 下方（抄 aiWinSettings 的"贴右"会把菜单弹到最右侧）
            var cL = Math.min(Math.max(4, _vL), Math.max(4, _vp.w - _w2 - 4));
            var cT = (_vT + _h2 > _vp.h - 4) ? Math.max(4, _r.top * _fy - _h2 - 4) : _vT; // 下方放不下翻上方
            if (cL !== _vL || cT !== _vT) positionPhysical(menu, cL, cT, _vp.scale, _vp.scaleY);
          } catch (e) {}
        });
      } catch (e) {}
      setTimeout(function () {
        var close = function (ev) {
          if (!menu.parentNode) { document.removeEventListener('mousedown', close); return; }
          if (!menu.contains(ev.target) && !anchor.contains(ev.target)) { try { menu.remove(); } catch (e) {} document.removeEventListener('mousedown', close); }
        };
        document.addEventListener('mousedown', close);
      }, 0);
    } catch (e) {}
  };
  // 切换窗口方式（内嵌 ⇄ 新窗口）：销毁重建（新窗口模式无内嵌窗口；回内嵌时重建 iframe 窗口）
  ctx.setAiMode = function (mode) {
    mode = mode === 'popup' ? 'popup' : 'iframe';
    if (ctx.aiState) ctx.aiState.mode = mode;
    try { ctx.saveAiState(); } catch (e) {}
    ctx.aiMode = mode;
    try { var _sp = ctx.root && ctx.root.querySelector('.dbg-ai-settings-pop'); if (_sp) _sp.remove(); } catch (e) {}
    if (ctx.aiWin) {
      try { ctx.closeAiPopup(); } catch (e) {}
      try { if (ctx.aiIframe) ctx.aiIframe.onload = null; } catch (e) {}
      ctx.aiIframe = null;
      try { if (ctx.aiWin.parentNode) ctx.aiWin.parentNode.removeChild(ctx.aiWin); } catch (e) {}
      ctx.aiWin = null;
      ctx.aiReady = false;
    }
    ctx.ensureAi();
  };
  // 就绪处理（iframe load / 新窗口 dbg_ai_ready 握手 / 兜底定时器共用）：flush 队列 + boot + 缓存候选补发
  ctx._aiOnReady = function (reqUrl) {
    try {
      ctx.aiReady = true;
      if (reqUrl) { try { if (ctx.aiIframe && ctx.aiIframe.contentWindow) ctx.aiIframe.contentWindow.postMessage({ __dbg: 1, type: 'dbg_ai_get_url', payload: {} }, '*'); } catch (e) {} }
      ctx.sendAiBoot(); // 方案 D：boot 消息带 pageId/bridge/targetUrl（AI 零配置）
      var pending = ctx.aiQueue.splice(0);
      pending.forEach(function (msg) { ctx.postToAi(msg); });
      // boot 兜底：扩展监听器就绪前 boot 会丢（与错误同竞态）——多轮补发，扩展侧幂等（setDebugTarget）
      [500, 2000, 4500].forEach(function (d) {
        setTimeout(function () { try { ctx.sendAiBoot(); } catch (e) {} }, d);
      });
      // 补发缓存页面错误（AI 窗口打开前页面已崩溃——错误不丢，候选区 [错误N] 照常出现）
      if (ctx.picksPendingErrors && ctx.picksPendingErrors.length) {
        var perr = ctx.picksPendingErrors.slice();
        [400, 1500, 3500].forEach(function (d) {
          setTimeout(function () { perr.forEach(function (m) { if (ctx.picksPendingErrors.indexOf(m) >= 0) ctx.postToAi(m); }); }, d);
        });
      }
      // 补发缓存的元素候选（AI 窗重开/重载前确认选中的元素——不丢，输入框 [元素N] 照常出现）
      if (ctx.picksPendingElements && ctx.picksPendingElements.length) {
        var pel = ctx.picksPendingElements.slice();
        [400, 1500, 3500].forEach(function (d) {
          setTimeout(function () { pel.forEach(function (m) { if (ctx.picksPendingElements.indexOf(m) >= 0) ctx.postToAi(m); }); }, d);
        });
      }
    } catch (e) {}
  };

  // AI 窗标题栏跟随 iframe 内部 document.title + favicon（跨域读不到 contentDocument——由 AI 窗页面经 dbg_ai_title 上报 {title, icon}）
  ctx.setAiTitle = function (t) { ctx.setAiMeta({ title: t }); };
  ctx.setAiMeta = function (payload) {
    var t = (payload && payload.title) || '';
    var icon = payload && payload.icon;
    ctx._aiTitle = t || '';
    var el2 = ctx.aiTitleEl || (ctx.root && ctx.root.querySelector('.dbg-ai-title'));
    if (!el2) return;
    el2.textContent = ''; // 重建（幂等：清掉旧文本/图标残留）
    if (icon) {
      var img = el('img', { class: 'dbg-ai-favicon', alt: '' });
      img.src = icon;
      el2.appendChild(img);
    }
    var txt = el('span', { class: 'dbg-ai-txt' });
    txt.textContent = t || 'AI';
    el2.appendChild(txt);
  };

  ctx.ensureAi = function () {
      if (ctx.selfHostPage) return; // self 宿主页：页面自身即 AI 窗——绝不创建第二个（总闸，覆盖全部调用点）
      if (ctx.aiWin || !ctx.cfg.aiUrl) return;
      ctx.aiState = Object.assign({}, AI_WIN_DEFAULTS, ctx.loadAiState());
      ctx.aiMode = ctx.aiState.mode === 'popup' ? 'popup' : 'iframe';
      if (ctx.aiMode === 'popup') {
        if (ctx._restoringPopup) {
          // 恢复模式：不立即 window.open（同名窗口会被复用并导航，弹窗会话丢失）——等弹窗心跳 adopt（10s 定时器兜底打开）
          ctx._restoringPopup = false;
          return;
        }
        // 新窗口模式：不建内嵌窗口——只确保新窗口打开（已开聚焦；被浏览器拦截 → openAiPopup 内部 setAiMode 回退内嵌重建）
        ctx.openAiPopup();
        return;
      }
      var aiSrc = ctx.aiUrlFor();
      var _trackedUsed = !!(ctx.trackedAiUrl && ctx.trackedAiUrl()); // 是否用追踪 URL（10s 探测回退）

      ctx.aiWin = el('div', { class: 'dbg-ai-win' });
      var bar = el('div', { class: 'dbg-ai-bar' });
      ctx.aiTitleEl = el('span', { class: 'dbg-ai-title' }, ['🤖 AI']);
      bar.appendChild(ctx.aiTitleEl);
      // 最大化按钮 ⛶：铺满视口 ↔ 还原（大屏存/回 __max 原状态；小屏 = 高度 100% ↔ 70%）。
      // 与双击标题栏同链路 aiToggleMax；拖动/缩放自动退出最大化态（aiDropMax）
      var maxBtn = el('button', { class: 'dbg-ai-max' }, ['⛶']);
      ctx.aiMaxBtn = maxBtn;
      maxBtn.addEventListener('click', function (e) { e.stopPropagation(); ctx.aiToggleMax(); });
      bar.appendChild(maxBtn);
      ctx.aiSyncMaxBtn();
      // 新窗口按钮 ⧉：大屏下拉选择布局（Chrome Inspector 式：独立弹窗 / 左/右/底/顶 dock）；小屏无分屏意义，直接打开新窗口
      var popBtn = el('button', { class: 'dbg-ai-pop', title: 'AI 新窗口布局：浮动 / 左·右并排 / 底·顶横排（关闭新窗口即回到内嵌模式）' }, ['⧉']);
      popBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (detectScreenMode().small) {
          // 小屏：移动端 window.open 忽略分屏 features（直接新标签页全屏）——不弹下拉，直接打开
          ctx.aiOpen = true;
          ctx.setAiMode('popup'); // 销毁内嵌窗口 + 打开新窗口（会话经记录 URL 延续）
          ctx.aiBtn.classList.add('dbg-on');
          ctx.saveDbgState();
          ctx.addMsg('sys', '🪟 AI 已在独立窗口打开——关闭该窗口即回到页面内窗口');
          return;
        }
        ctx.aiPopupMenu(popBtn);
      });
      bar.appendChild(popBtn);
      var setBtn = el('button', { class: 'dbg-ai-settings', title: '设置' }, ['⚙']);
      setBtn.addEventListener('click', function (e) { e.stopPropagation(); ctx.aiWinSettings(setBtn); });
      bar.appendChild(setBtn);
      var closeBtn = el('button', { class: 'dbg-ai-close', title: '关闭' }, ['✕']);
      closeBtn.addEventListener('click', function () {
        ctx.showAi(false);
        ctx.aiOpen = false;
        ctx.aiBtn.classList.remove('dbg-on');
        ctx.saveDbgState(); // 关闭状态持久化（刷新后不恢复）
      });
      bar.appendChild(closeBtn);
      ctx.aiWin.appendChild(bar);

      ctx.aiIframe = el('iframe', { src: aiSrc, style: 'border:0;width:100%;height:calc(100% - 30px);display:block;background:#fff;' });
      ctx.aiIframe.addEventListener('load', function () { ctx._aiOnReady(true); });
      try { ctx.aiTrackProbe(_trackedUsed); } catch (e) {} // 追踪 URL 打开 → 10s 无协议响应回退 custom/默认
      ctx.aiWin.appendChild(ctx.aiIframe);

      // 右下角拖拽手柄：自由调宽高；边缘拖条（右=调宽 / 下=调高）：单轴——触屏只有右下角手柄
      // 必须斜拖，且窗口贴屏底时手柄落在系统手势区难命中；边缘条长好点。
      // 插入顺序：边缘条先、角柄后（同 z-index 下后者在上）——右下角重叠区角柄（双轴）优先命中
      var resizeR = el('div', { class: 'dbg-ai-resize-r' });
      var resizeB = el('div', { class: 'dbg-ai-resize-b' });
      ctx.aiWin.appendChild(resizeR);
      ctx.aiWin.appendChild(resizeB);
      var resizeHandle = el('div', { class: 'dbg-ai-resize' });
      ctx.aiWin.appendChild(resizeHandle);
      var resizeL = el('div', { class: 'dbg-ai-resize-l' }); // 左缘拖条（镜像右缘：单轴调宽，左缘跟手）——小屏也保留，用户平板实测左下角拖不了
      ctx.aiWin.appendChild(resizeL);
      ctx.root.appendChild(ctx.aiWin);
      ctx.root.classList.toggle('dbg-phys-small', detectScreenMode().small); // 小屏放大头部（dock/size 隐藏，bar 34px）
      ctx.applyAiState();
      // 模式自愈：小屏/大屏判定翻转时（旋转/键盘/系统栏变化后 vv resize → clamp → 此处），
      // 重置对方模式的残留状态（小屏全宽时会存 width=innerWidth/smallHeightPct；回大屏后这些值会让
      // 自由窗口行为异常，如“width 777 全宽但自由模式”。真实发生：pad 弹键盘误判小屏 → 关键盘后
      // dbg-phys-small 挂着不摘 → 角柄/拖动全隐藏“缩放功能没了”）。
      var _wasSmall = !!ctx.__aiWasSmall; ctx.__aiWasSmall = detectScreenMode().small;
      if (_wasSmall && !ctx.__aiWasSmall) {
        // 小屏 → 大屏：清小屏残留（全宽尺寸/高度%/贴边/最大化态），回默认自由窗
        try {
          delete ctx.aiState.smallDock; delete ctx.aiState.__max;
          if (ctx.aiState.width >= window.innerWidth - 4) { ctx.aiState.width = Math.min(AI_WIN_DEFAULTS.width, window.innerWidth - 16); }
          ctx.aiState.dock = 'free';
          if (ctx.aiState.left == null) ctx.aiState.left = 16;
          if (ctx.aiSyncMaxBtn) ctx.aiSyncMaxBtn();
          ctx.saveAiState(); ctx.applyAiState();
        } catch (e) {}
      } else if (!_wasSmall && ctx.__aiWasSmall) {
        // 大屏 → 小屏：无需迁移（applyAiState 小屏分支全接管尺寸/位置）
      }

      // 拖拽移动（按住标题栏）/ resize 手柄：公共手势工具 makePointerDrag（drag.js）
      // 生命周期/触屏修复（pointercancel 兜底/touch-action 说明）/rAF 合并都在公共层单点维护（fab/工具条/HUD 同款）；
      // rAF 合并：pointermove 频率远高于渲染帧率，每帧最多应用一次末值——否则一帧内多次 layout +
      // iframe（pi-web）全量重排，大屏缩放明显掉帧。
      var dragCtl = makePointerDrag({
        handle: bar, capture: 'now', raf: true, preventStart: true,
        filter: function (e) {
          if (detectScreenMode().small) return false; // 小屏全宽贴边：不拖拽
          if (e.target && e.target.tagName === 'BUTTON') return false; // 按钮不触发拖拽
          return true;
        },
        onStart: function (e) {
          ctx.aiDropMax(); // 手动拖动 = 退出最大化态
          ctx.aiWin.classList.add('dbg-dragging');
          ctx.aiWin.style.willChange = 'left, top'; // 提示合成层，避免拖拽中反复重排
          if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = 'none'; // 拖拽时 iframe 内 hover/滚动不再抢占/触发重排
          return { left: ctx.aiWin.offsetLeft, top: ctx.aiWin.offsetTop };
        },
        onMove: function (ev, st, dx, dy) {
          st.pl = st.left + dx; st.pt = st.top + dy;
          ctx.aiState.left = st.pl; ctx.aiState.top = st.pt; ctx.aiState.dock = 'free';
          ctx.aiWin.style.left = ctx.aiState.left + 'px';
          ctx.aiWin.style.right = 'auto';
          ctx.aiWin.style.top = ctx.aiState.top + 'px';
          ctx.aiWin.style.bottom = 'auto';
        },
        onEnd: function () {
          ctx.aiWin.classList.remove('dbg-dragging');
          ctx.aiWin.style.willChange = '';
          if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = '';
          ctx.clampAiWindow();
          ctx.saveAiState();
          ctx.saveDbgState(); // 位置持久化（刷新后恢复）
        },
      });
      // resize 手柄拖拽：同拖动条；缩放时只写 width/height（不动位置），
      // 避免 applyAiState 重写 left/top/right/bottom + detectScreenMode 读屏的重复开销。
      var rsCtl = makePointerDrag({
        handle: resizeHandle, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !detectScreenMode().small; }, // 小屏不 resize（全宽贴边尺寸自适应）
        onStart: function (e) {
          e.stopPropagation(); // 手柄 pointerdown 不冒泡
          ctx.aiDropMax(); // 手动缩放 = 退出最大化态
          ctx.aiWin.classList.add('dbg-resizing'); // 拖动中亮指示条
          ctx.aiWin.style.willChange = 'width, height';
          if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = 'none';
          return { w: ctx.aiState.width, h: ctx.aiState.height };
        },
        onMove: function (ev, st, dx, dy) {
          st.pw = st.w + dx; st.ph = st.h + dy;
          ctx.aiState.width = Math.min(Math.max(st.pw, 280), window.innerWidth);
          ctx.aiState.height = Math.min(Math.max(st.ph, 200), window.innerHeight);
          ctx.aiWin.style.width = ctx.aiState.width + 'px';
          ctx.aiWin.style.height = ctx.aiState.height + 'px';
        },
        onEnd: function () {
          ctx.aiWin.classList.remove('dbg-resizing');
          ctx.aiWin.style.willChange = '';
          if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = '';
          ctx.clampAiWindow(); // 完整收敛（含位置 clamp）
          ctx.saveAiState();
          ctx.saveDbgState(); // 尺寸持久化（刷新后恢复）
        },
      });
      // 边缘拖条（单轴）：只改宽 / 只改高。小屏隐藏（全宽贴边尺寸自适应）；
      // 持久化/收敛与角柄同链路（onEnd 共用 clamp+save）。
      var edgeEnd = function () {
        ctx.aiWin.classList.remove('dbg-resizing');
        ctx.aiWin.style.willChange = '';
        if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = '';
        ctx.clampAiWindow();
        ctx.saveAiState();
        ctx.saveDbgState();
      };
      var edgeStart = function (e) {
        e.stopPropagation();
        ctx.aiDropMax(); // 手动缩放 = 退出最大化态
        ctx.aiWin.classList.add('dbg-resizing'); // 拖动中亮指示条（触屏无 hover：用时才给反馈，不常显）
        ctx.aiWin.style.willChange = 'width, height';
        if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = 'none';
        return { w: ctx.aiState.width, h: ctx.aiState.height };
      };
      var rsRCtl = makePointerDrag({
        handle: resizeR, capture: 'now', raf: true, preventStart: true,
        // 无 small 过滤：小屏（平板）也允许边缘条拖拽（角柄小屏隐藏但边缘条保留——用户平板实测）
        onStart: edgeStart,
        onMove: function (ev, st, dx) {
          ctx.aiState.width = Math.min(Math.max(st.w + dx, 280), window.innerWidth);
          ctx.aiWin.style.width = ctx.aiState.width + 'px';
        },
        onEnd: edgeEnd,
      });
      var rsBCtl = makePointerDrag({
        handle: resizeB, capture: 'now', raf: true, preventStart: true,
        // 无 small 过滤：同上（小屏允许边缘条拖拽）
        onStart: edgeStart,
        onMove: function (ev, st, dx, dy) {
          ctx.aiState.height = Math.min(Math.max(st.h + dy, 200), window.innerHeight);
          ctx.aiWin.style.height = ctx.aiState.height + 'px';
        },
        onEnd: edgeEnd,
      });
      // 左缘拖条（镜像右缘）：单轴调宽——左缘跟手、右缘锚定
      // 无 small 过滤：小屏（平板）也允许边缘条拖拽（用户实测左下角拖不了；角柄小屏隐藏但边缘条保留）
      var rsLCtl = makePointerDrag({
        handle: resizeL, capture: 'now', raf: true, preventStart: true,
        onStart: function (e) {
          e.stopPropagation();
          ctx.aiDropMax(); // 手动缩放 = 退出最大化态
          ctx.aiWin.classList.add('dbg-resizing');
          ctx.aiWin.style.willChange = 'width, left';
          if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = 'none';
          return { w: ctx.aiState.width, left: (ctx.aiState.left != null ? ctx.aiState.left : ctx.aiWin.offsetLeft) };
        },
        onMove: function (ev, st, dx) {
          var right = st.left + st.w;
          var nw = Math.min(Math.max(st.w - dx, 280), window.innerWidth);
          ctx.aiState.width = nw;
          ctx.aiState.left = right - nw; // 左缘跟手：右缘锚定
          ctx.aiWin.style.width = ctx.aiState.width + 'px';
          ctx.aiWin.style.left = ctx.aiState.left + 'px';
        },
        onEnd: function () {
          ctx.aiWin.classList.remove('dbg-resizing');
          ctx.aiWin.style.willChange = '';
          if (ctx.aiIframe) ctx.aiIframe.style.pointerEvents = '';
          ctx.clampAiWindow();
          ctx.saveAiState();
          ctx.saveDbgState();
        },
      });
      // 双击标题栏 = 最大化切换（触屏友好：标题栏空白一键铺满；再双击回原尺寸/位置）。
      // 与 ⛶ 按钮同链路 aiToggleMax（一套 __max 状态，按钮图标同步）。
      // 自实现双击检测：bar pointerdown 有 preventDefault（防焦点夺取）会抑制浏览器合成 click/dblclick——
      // 依赖 dblclick 事件在触屏上不可靠；用两次 pointerup 间隔（<350ms）+ 位移小（<30px）判定。
      var barLastTap = { t: 0, x: 0, y: 0 };
      bar.addEventListener('pointerup', function (e) {
        if (detectScreenMode().small) return;
        if (e.target && e.target.closest && e.target.closest('button')) return; // 按钮不触发
        var now = Date.now();
        if (now - barLastTap.t < 350 && Math.abs(e.clientX - barLastTap.x) < 30 && Math.abs(e.clientY - barLastTap.y) < 30) {
          barLastTap.t = 0; // 双击已消费（防三连击连续切换）
          try { ctx.aiToggleMax(); } catch (err) {}
          return;
        }
        barLastTap = { t: now, x: e.clientX, y: e.clientY };
      });

      // ESC 取消进行中的拖拽/缩放（capture 先于页面/launcher 处理；无拖拽时放行给页面）
      window.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!dragCtl.active() && !rsCtl.active() && !rsRCtl.active() && !rsBCtl.active() && !rsLCtl.active()) return;
        e.preventDefault();
        e.stopPropagation();
        dragCtl.cancel();
        rsCtl.cancel();
        rsRCtl.cancel();
        rsBCtl.cancel();
        rsLCtl.cancel();
      }, true);

      // 窗口尺寸变化时夹紧（rAF 节流——拖动浏览器边缘时 resize 事件频率也很高）；
      // 最大化态跟随浏览器窗口重新铺满（否则拉大窗口后 AI 窗留黑边/被夹小）
      var winResizeFrame = null;
      window.addEventListener('resize', function () {
        if (!ctx.aiWin) return;
        if (winResizeFrame) return;
        winResizeFrame = requestAnimationFrame(function () {
          winResizeFrame = null;
          if (ctx.aiState && ctx.aiState.__max && !detectScreenMode().small) {
            ctx.aiState.width = window.innerWidth; ctx.aiState.height = window.innerHeight;
            ctx.aiState.left = 0; ctx.aiState.top = 0;
          }
          ctx.clampAiWindow();
        });
      });
      }

  ctx.showAi = function (v) {
      if (ctx.selfHostPage) return; // self 宿主页：无 AI 窗可显隐（同 ensureAi 总闸）
      if (ctx.aiMode === 'popup') {
        // 新窗口模式：无内嵌窗口——v=true 确保新窗口打开（已开聚焦），v=false 关闭新窗口（监测切回内嵌）
        if (v) { try { ctx.openAiPopup(); } catch (e) {} }
        else { try { ctx.closeAiPopup(); } catch (e) {} }
      } else {
        if (!ctx.aiWin) return;
        ctx.aiWin.style.display = v ? 'block' : 'none';
      }
      // FAB 错误角标：打开 AI 窗（用户已看到错误详情）→ 清除角标状态；关窗不恢复（角标只由新错误 + 3 分钟定时器驱动）
      try { if (v && ctx.fabErrClear) ctx.fabErrClear(); } catch (e) {}
      // 打开 = 清理动作：仅重置错误去重（client seen + launcher picksErrSeen/pendingErrors）→
      // 同消息“未清理去除、清理后再次触发重新上报”。不动扩展候选与输入框占位符——占位符是用户正在编辑的内容，
      // 打开窗即摘除会破坏发送（用户实测：清理后 [错误1] 发不出去）
      if (v) { try { if (ctx.resetErrDedup) ctx.resetErrDedup(); } catch (e) {} }
      // AI 窗口显示时补发缓存错误（隐藏 iframe 时扩展未运行，消息丢失——显示后多轮补发，扩展侧去重幂等）
      // boot 兜底：显示时也补发（隐藏期间扩展可能已卸载/重载）
      if (v) {
        [700, 2200].forEach(function (d) {
          setTimeout(function () { try { ctx.sendAiBoot(); } catch (e) {} }, d);
        });
      }
      if (v && ctx.picksPendingErrors && ctx.picksPendingErrors.length) {
        var perr2 = ctx.picksPendingErrors.slice();
        [600, 2000, 4000].forEach(function (d) {
          setTimeout(function () { perr2.forEach(function (m) { if (ctx.picksPendingErrors.indexOf(m) >= 0) ctx.postToAi(m); }); }, d);
        });
      }
      // 同样补发缓存的元素候选（AI 窗隐藏期间确认的元素）
      if (v && ctx.picksPendingElements && ctx.picksPendingElements.length) {
        var pel2 = ctx.picksPendingElements.slice();
        [600, 2000, 4000].forEach(function (d) {
          setTimeout(function () { pel2.forEach(function (m) { if (ctx.picksPendingElements.indexOf(m) >= 0) ctx.postToAi(m); }); }, d);
        });
      }
      if (v) requestAnimationFrame(function () { try { if (!ctx.aiInScreen()) ctx.resetAiDefault(); } catch (e) {} }); // 超屏/不可见→回默认
      }

  // ---- AI 窗设置弹窗（⚙）：小屏=高度 % + 贴底/贴顶；大屏=宽高 px + 左右/自由。状态分 key 存（旋转切换大小屏互不干扰） ----
  ctx.aiWinSettings = function (anchorBtn) {
    try {
      var existing = ctx.root.querySelector('.dbg-ai-settings-pop');
      if (existing) { existing.remove(); return; }
      var pop = el('div', { class: 'dbg-ai-settings-pop' });
      pop.style.zIndex = '2147483647'; // 高于 AI 窗（2147483642）——设置弹窗不被自身遮挡（用户实测）
      var small = detectScreenMode().small;
      var sec = el('div', { style: 'font-size:11px;font-weight:600;color:#4f46e5;margin-bottom:6px' }, [small ? '📱 小屏（按 % 高度）' : '🖥 大屏（具体尺寸/位置）']);
      pop.appendChild(sec);
      if (small) {
        // 高度 %：slider + 数值
        var hRow = el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12px' });
        var pct = (ctx.aiState.smallHeightPct > 0 ? ctx.aiState.smallHeightPct : 100);
        var slider = el('input', { type: 'range', min: '30', max: '100', step: '5', value: String(pct), style: 'flex:1' });
        var pctLabel = el('span', { style: 'min-width:34px;text-align:right;font-weight:600' }, [pct + '%']);
        slider.addEventListener('input', function () {
          ctx.aiState.smallHeightPct = parseInt(slider.value, 10);
          pctLabel.textContent = ctx.aiState.smallHeightPct + '%';
          ctx.saveAiState(); ctx.applyAiState();
        });
        hRow.appendChild(el('span', {}, ['高度'])); hRow.appendChild(slider); hRow.appendChild(pctLabel);
        pop.appendChild(hRow);
        // 贴底/贴顶
        var dRow = el('div', { style: 'display:flex;gap:8px;margin-top:8px' });
        [['bottom', '⬇ 贴底'], ['top', '⬆ 贴顶']].forEach(function (d) {
          var b = el('button', { style: 'flex:1;border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;font-size:12px;color:#374151;background:' + (ctx.aiState.smallDock === d[0] ? '#4f46e5;color:#fff' : '#fff') }, [d[1]]);
          b.addEventListener('click', function () {
            ctx.aiState.smallDock = d[0];
            ctx.saveAiState(); ctx.applyAiState();
            ctx.aiWinSettings(anchorBtn);
          });
          dRow.appendChild(b);
        });
        pop.appendChild(dRow);
      } else {
        // 大屏：宽/高 px
        var whRow = el('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px' });
        var wInp = el('input', { type: 'number', value: String(ctx.aiState.width || 400), min: '280', step: '20', style: 'width:64px;border:1px solid #d1d5db;border-radius:5px;padding:2px 5px;font:inherit;color:#111827' });
        var hInp = el('input', { type: 'number', value: String(ctx.aiState.height || 560), min: '200', step: '20', style: 'width:64px;border:1px solid #d1d5db;border-radius:5px;padding:2px 5px;font:inherit;color:#111827' });
        wInp.addEventListener('change', function () { ctx.aiState.width = Math.max(280, parseInt(wInp.value, 10) || 400); ctx.clampAiWindow(); ctx.saveAiState(); ctx.applyAiState(); });
        hInp.addEventListener('change', function () { ctx.aiState.height = Math.max(200, parseInt(hInp.value, 10) || 560); ctx.clampAiWindow(); ctx.saveAiState(); ctx.applyAiState(); });
        whRow.appendChild(el('span', {}, ['宽'])); whRow.appendChild(wInp); whRow.appendChild(el('span', {}, ['高'])); whRow.appendChild(hInp);
        pop.appendChild(whRow);
        // 位置：左/右/自由
        var posRow = el('div', { style: 'display:flex;gap:8px;margin-top:8px' });
        [['left', '⬅ 贴左'], ['right', '➡ 贴右'], ['free', '✥ 自由']].forEach(function (d) {
          var cur = ctx.aiState.dock || (d[0] === 'right' ? 'right' : '');
          var b = el('button', { style: 'flex:1;border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;font-size:12px;color:#374151;background:' + (cur === d[0] ? '#4f46e5;color:#fff' : '#fff') }, [d[1]]);
          b.addEventListener('click', function () {
            ctx.aiState.dock = d[0];
            if (d[0] === 'free') { ctx.aiState.left = 16; ctx.aiState.top = 16; }
            ctx.clampAiWindow(); ctx.saveAiState(); ctx.applyAiState();
            ctx.aiWinSettings(anchorBtn);
          });
          posRow.appendChild(b);
        });
        pop.appendChild(posRow);
      }
      // AI 地址显示：当前生效地址 + 来源（⭐ 用户设置 aiti-agent > 会话记忆（AI 窗上报）> 默认推断）
      // AI 地址（两行独立管理）：🔁 当前会话追踪（AI 窗上报，优先）/ ⭐ 用户设置或默认推断——各自可复制/单独清除
      var urlSec = el('div', { style: 'margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px' });
      urlSec.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:#4f46e5;margin-bottom:4px' }, ['🔗 AI 地址']));
      var urlMono = 'font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.5;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;color:#334155;user-select:all';
      var _reopenSettings = function () { try { pop.remove(); ctx.aiWinSettings(anchorBtn); } catch (e) {} }; // 清除后重建面板（显示最新值）
      var _navAi = function (u) { // AI 窗导航到回退地址
        try {
          if (ctx.aiMode === 'popup') { if (ctx.aiPopup && !ctx.aiPopup.closed) ctx.aiPopup.location.href = u; else ctx.openAiPopup(u); }
          else if (ctx.aiIframe) { ctx.aiReady = false; ctx.aiIframe.src = u; }
        } catch (e) {}
      };
      // 行1：🔁 当前会话（AI 窗导航上报，优先使用）——可单独清除 → AI 窗回退用户设置/默认地址，此后继续重新追踪
      var tracked2 = (ctx.trackedAiUrl ? ctx.trackedAiUrl() : '') || '';
      var trkRow = el('div', { style: 'margin-bottom:8px' });
      var trkHead = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px;color:#6b7280' });
      trkHead.appendChild(el('span', {}, ['🔁 当前会话（AI 窗上报，优先）']));
      var trkClear = el('button', { style: 'margin-left:auto;border:1px solid #d1d5db;border-radius:5px;padding:1px 8px;cursor:pointer;font:inherit;font-size:11px;background:#fff;color:#374151' }, ['✕ 清除']);
      trkClear.addEventListener('click', function () {
        try { ctx.clearAiUrl(); } catch (e) {}
        _navAi(ctx.aiFallbackUrl());
        try { ctx.addMsg('sys', '✕ 已清除会话追踪 URL——AI 窗已回退' + ((ctx.loadCustomAiUrl && ctx.loadCustomAiUrl()) ? '用户设置地址（导航后重新追踪）' : '默认地址（导航后重新追踪）')); } catch (e) {}
        _reopenSettings();
      });
      trkHead.appendChild(trkClear);
      trkRow.appendChild(trkHead);
      trkRow.appendChild(el('div', { style: urlMono, title: tracked2 || '（无——AI 窗加载/导航后自动记录）' }, [tracked2 || '（无——AI 窗加载/导航后自动记录）']));
      urlSec.appendChild(trkRow);
      // 行2：⭐ 用户设置（aiti-agent）或默认推断——显示当前 base；可复制；用户设置可清除回默认
      var customUrl = (ctx.loadCustomAiUrl ? ctx.loadCustomAiUrl() : '') || '';
      var setRow = el('div', {});
      var setHead = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px;color:#6b7280' });
      setHead.appendChild(el('span', {}, [customUrl ? '⭐ 用户设置（aiti-agent）' : '默认推断']));
      var cpBtn = el('button', { style: 'border:1px solid #d1d5db;border-radius:5px;padding:1px 8px;cursor:pointer;font:inherit;font-size:11px;background:#fff;color:#374151' }, ['📋 复制']);
      cpBtn.addEventListener('click', function () {
        try {
          navigator.clipboard.writeText(customUrl || ctx.cfg.aiUrl || '').then(function () { cpBtn.textContent = '✓ 已复制'; setTimeout(function () { cpBtn.textContent = '📋 复制'; }, 1200); }, function () { cpBtn.textContent = '复制失败'; });
        } catch (e) {}
      });
      setHead.appendChild(cpBtn);
      if (customUrl) {
        var cstClear = el('button', { style: 'border:1px solid #d1d5db;border-radius:5px;padding:1px 8px;cursor:pointer;font:inherit;font-size:11px;background:#fff;color:#374151' }, ['✕ 清除']);
        cstClear.addEventListener('click', function () {
          try { ctx.clearCustomAiUrl(); } catch (e) {}
          // 追踪 URL 若属于 custom base → 同步失效（清掉）；属于默认 base 则保留会话
          var trkLeft = (ctx.trackedAiUrl ? ctx.trackedAiUrl() : '');
          if (!trkLeft) { try { ctx.clearAiUrl(); } catch (e) {} }
          var backUrl = ctx.aiUrlFor();
          _navAi(backUrl);
          try { ctx.addMsg('sys', '✕ 已清除用户设置地址——AI 窗回退默认地址' + (trkLeft ? '（当前会话仍保留）' : '（导航后重新追踪）')); } catch (e) {}
          _reopenSettings();
        });
        setHead.appendChild(cstClear);
      }
      setRow.appendChild(setHead);
      setRow.appendChild(el('div', { style: urlMono, title: customUrl || ctx.cfg.aiUrl || '（未配置）' }, [customUrl || ctx.cfg.aiUrl || '（未配置）']));
      urlSec.appendChild(setRow);
      pop.appendChild(urlSec);
      // ⭐ 设置 aiti-agent 地址（第一推荐）——默认只显示按钮，点开才出输入框；与 cockpit 同链路（临时切换 + 10s 探测，成功才生效）
      var setSec = el('div', { style: 'margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px' });
      var setLbl = el('div', { style: 'font-size:11px;font-weight:600;color:#4f46e5;margin-bottom:4px' }, ['⭐ 设置 aiti-agent（第一推荐）']);
      setSec.appendChild(setLbl);
      var aitiLink = el('a', { href: 'https://aiti.pw', target: '_blank', rel: 'noopener', style: 'color:#4f46e5;text-decoration:underline' }, ['aiti.pw ↗']);
      setSec.appendChild(el('div', { style: 'font-size:11px;color:#6b7280;line-height:1.5;margin-bottom:6px' }, ['带 Web 界面的 AI 助手（', aitiLink, '）——装好后设地址，AI 窗直接由它接管；应用后 10s 协议探测，成功才生效，失败自动回退。']));
      var setBtn = el('button', { style: 'width:100%;border:1px solid #4f46e5;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;font-size:12px;background:#eef2ff;color:#4338ca' }, ['⚙ 设置地址']);
      setBtn.addEventListener('click', function () {
        try { pop.remove(); } catch (e) {} // 关设置弹窗，打开同款模态弹窗（与 cockpit 一致）
        if (ctx.aiAgentDlg) ctx.aiAgentDlg();
      });
      setSec.appendChild(setBtn);
      pop.appendChild(setSec);
      // 重置：位置/尺寸 + URL（新会话）——原工具条 ⟲ 移入设置
      var resetSec = el('div', { style: 'margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px' });
      var resetLbl = el('div', { style: 'font-size:11px;font-weight:600;color:#4f46e5;margin-bottom:4px' }, ['⟲ 重置']);
      resetSec.appendChild(resetLbl);
      var resetBtn = el('button', { style: 'width:100%;border:1px solid #fca5a5;border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit;font-size:12px;background:#fef2f2;color:#b91c1c' }, ['重置位置/尺寸 + URL（新会话）']);
      resetBtn.addEventListener('click', function () {
        ctx.resetAiDefault(); // 位置/尺寸回默认（含保存）
        ctx.clearAiUrl();     // 清 URL 记录（会话回初始）
        try { ctx.clearCustomAiUrl(); } catch (e) {} // 清用户设置的 aiti-agent 地址（回默认推断）
        if (ctx.aiMode === 'popup') { ctx.openAiPopup(); }
        else if (ctx.aiIframe && ctx.cfg.aiUrl) {
          var sep = ctx.cfg.aiUrl.indexOf('?') >= 0 ? '&' : '?';
          ctx.aiIframe.src = ctx.withAiWinMark(ctx.cfg.aiUrl + sep + '_dbg=' + Date.now() + ctx.aiPageParams());
        }
        ctx.addMsg('sys', '⟲ 已重置：AI 窗位置/尺寸回默认，URL 回初始（新会话）');
        try { pop.remove(); } catch (e) {} // 重置后窗口移动，设置弹窗一并关闭
      });
      resetSec.appendChild(resetBtn);
      pop.appendChild(resetSec);
      // 调试设置（原 ⚙ 内容——保留：刷新时自动显示调试信息 + 查看调试信息）
      var dbgSec = el('div', { style: 'margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px' });
      var dbgLbl = el('div', { style: 'font-size:11px;font-weight:600;color:#4f46e5;margin-bottom:4px' }, ['🔧 调试']);
      dbgSec.appendChild(dbgLbl);
      var lbl = el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, []);
      var cb = el('input', { type: 'checkbox' });
      try { cb.checked = ctx.loadShowDebug(); } catch (e) {}
      cb.addEventListener('change', function () { try { ctx.saveShowDebug(cb.checked); } catch (e) {} });
      lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' 刷新时自动显示调试信息'));
      dbgSec.appendChild(lbl);
      var viewBtn = el('button', { style: 'margin-top:6px;border:1px solid #94a3b8;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:12px;background:#fff;color:#374151' }, ['📋 查看调试信息']);
      viewBtn.addEventListener('click', function () { pop.remove(); try { ctx.showDebugPanel(); } catch (e) {} });
      dbgSec.appendChild(viewBtn);
      pop.appendChild(dbgSec);
      // Inspector 设置（原工具条 ⏱：调速/网络/错误/场景/放行/视口等）——点击弹出独立面板
      var inspSec = el('div', { style: 'margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px' });
      var inspLbl = el('div', { style: 'font-size:11px;font-weight:600;color:#4f46e5;margin-bottom:6px' }, ['🛠 Inspector 设置']);
      inspSec.appendChild(inspLbl);
      var inspBtn = el('button', { style: 'width:100%;border:1px solid #a5b4fc;border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit;font-size:12px;background:#eef2ff;color:#4338ca' }, ['⏱ 调速 / 🌐 网络 / ⚠ 错误（弹出面板）']);
      inspBtn.addEventListener('click', function () {
        try { pop.remove(); } catch (e) {} // 关设置弹窗（面板 z-index 低于设置弹窗，不关会被盖住）
        try { ctx.toggleSpeedPanel(); } catch (e) {}
      });
      inspSec.appendChild(inspBtn);
      pop.appendChild(inspSec);
      ctx.root.appendChild(pop);
      // 定位到 ⚙ 下方（counter-zoom 跟随缩放；下方放不下翻上方）
      try {
        var _vp = getPhysViewport(), _r = anchorBtn.getBoundingClientRect();
        var _fx = _fixedVisual ? 1 : _vp.scale, _fy = _fixedVisual ? 1 : _vp.scaleY;
        var _vL = Math.max(4, _r.right * _fx - 200), _vT = _r.bottom * _fy + 4;
        // 限宽防超屏：transform scale(1/scale) 已放大宽度，页面缩放再补偿——布局宽直接 = 视觉目标宽即可（参照 placePhysBox：width=visW）
        //   小屏无 meta：视觉宽 = 屏宽 92% 封顶 340；桌面 scale=1：320 视觉即 320 布局
        var _visW = Math.min(340, Math.round(_vp.w * 0.92));
        pop.style.width = _visW + 'px';
        pop.style.maxWidth = 'none';
        pop.style.minWidth = ''; // 恢复 CSS min-width:210（transform 补偿后视觉 = 210，不超屏）
        positionPhysical(pop, _vL, _vT, _vp.scale, _vp.scaleY);
        requestAnimationFrame(function () {
          try {
            // 视觉宽高：getBoundingClientRect（含 counter-zoom transform）→ 布局 px × scale/scaleY = 视觉 px
            var _r2 = pop.getBoundingClientRect();
            var _w2 = _r2.width * _fx, _h2 = _r2.height * _fy;
            // 优先 ⚙ 下方弹出，只 clamp 屏内（超屏才贴边，不强制贴屏右——大屏不再弹到最右侧）；下方放不下翻上方
            var cL = Math.min(Math.max(4, _vL), Math.max(4, _vp.w - _w2 - 4));
            var cT = (_vT + _h2 > _vp.h - 4) ? Math.max(4, _r.top * _fy - _h2 - 4) : _vT;
            if (cL !== _vL || cT !== _vT) positionPhysical(pop, cL, cT, _vp.scale, _vp.scaleY);
          } catch (e) {}
        });
      } catch (e) {}
      setTimeout(function () {
        var close = function (ev) {
          if (!pop.parentNode) { document.removeEventListener('mousedown', close); return; }
          if (!pop.contains(ev.target) && !anchorBtn.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', close); }
        };
        document.addEventListener('mousedown', close);
      }, 0);
    } catch (e) {}
  };

  // ⭐ 设置 aiti-agent 地址模态弹窗（宿主层统一打开——cockpit 与 Host ⚙ 都走这里；应用后临时切换 + 10s 协议探测，成功才生效，失败自动回退）
  ctx.aiAgentDlg = function () {
    try {
      // 防重复叠加：已有同款设置弹窗则忽略（宿主层非单例，快速连点会开多个遮罩）
      if (ctx.root) {
        var _dup = ctx.root.querySelector('.dbg-dialog-card');
        if (_dup && _dup.innerText.indexOf('设置 aiti-agent') >= 0) return;
      }
      var dlg = el('div', { class: 'dbg-dialog' });
      var card = el('div', { class: 'dbg-dialog-card', style: 'width:min(520px, 90vw)' });
      var head = el('div', { class: 'dbg-dialog-head' });
      head.appendChild(el('span', {}, ['⭐ 设置 aiti-agent 地址']));
      var close = el('button', { style: 'border:0;background:none;cursor:pointer;font-size:14px;color:#6b7280' }, ['✕']);
      head.appendChild(close);
      var body = el('div', { class: 'dbg-dialog-body' });
      var aitiLink = el('a', { href: 'https://aiti.pw', target: '_blank', rel: 'noopener', style: 'color:#4f46e5;text-decoration:underline' }, ['aiti.pw ↗']);
      body.appendChild(el('div', { style: 'font-size:12.5px;color:#374151;line-height:1.6' }, ['带 Web 界面的 AI 助手（', aitiLink, '）——下载安装后，把它的访问地址填到下面，AI 窗将直接由它接管（本窗口不再使用）。']));
      body.appendChild(el('div', { style: 'font-size:11.5px;color:#6b7280;line-height:1.6' }, ['应用后自动与宿主协商重开 AI 窗，10 秒内协议探测；连接成功才生效（此后重开自动使用），失败自动回退本窗口（可修改重试）。']));
      var inp = el('input', { type: 'url', spellcheck: 'false', placeholder: 'https://你的-aiti-agent-地址', value: (ctx.loadCustomAiUrl ? ctx.loadCustomAiUrl() : '') || '', style: 'width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;outline:none' });
      body.appendChild(inp);
      // 当前导航 URL：可直接填入输入框修改（如微调地址/路径）或仅复制
      var _cur = (ctx.trackedAiUrl ? ctx.trackedAiUrl() : '') || '';
      if (_cur) {
        var curRow = el('div', { style: 'margin-top:6px;font-size:11px;color:#6b7280;line-height:1.5' });
        curRow.appendChild(el('span', {}, ['🔁 当前 AI 窗导航：']));
        var curBtn = el('button', { style: 'margin-left:4px;border:1px solid #d1d5db;border-radius:5px;padding:1px 8px;cursor:pointer;font:inherit;font-size:11px;background:#fff;color:#374151' }, ['✍ 填入修改']);
        curBtn.addEventListener('click', function () {
          try {
            inp.value = String(_cur); // 原样填入（完整路径与参数，一字不改）
            inp.focus();
            try { var u0 = String(_cur); inp.setSelectionRange(u0.length, u0.length); } catch (e) {}
            curBtn.textContent = '✓ 已填入';
            setTimeout(function () { curBtn.textContent = '✍ 填入修改'; }, 1200);
          } catch (e) {}
        });
        curRow.appendChild(curBtn);
        var curUrl2 = el('span', { style: 'font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all;user-select:all' }, [_cur.slice(0, 120) + (_cur.length > 120 ? '…' : '')]);
        curRow.appendChild(curUrl2);
        body.appendChild(curRow);
      }
      var foot = el('div', { class: 'dbg-dialog-foot' });
      var openAiti = el('button', { class: 'dbg-ghost' }, ['🔗 打开 aiti.pw']);
      var cancelBtn = el('button', { class: 'dbg-ghost' }, ['取消']);
      var applyBtn = el('button', { class: 'dbg-primary' }, ['应用并切换']);
      var closeDlg = function () { try { dlg.remove(); } catch (e) {} };
      close.addEventListener('click', closeDlg);
      dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDlg(); });
      cancelBtn.addEventListener('click', closeDlg);
      openAiti.addEventListener('click', function () { try { window.open('https://aiti.pw', '_blank'); } catch (e) {} });
      applyBtn.addEventListener('click', function () {
        var u = (inp.value || '').trim();
        if (!u) { applyBtn.textContent = '请输入地址'; setTimeout(function () { applyBtn.textContent = '应用并切换'; }, 1500); return; }
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        try {
          var p = new URL(u);
          if (!p.hostname) throw 0;
          if (/\s/.test(p.hostname) || p.hostname.indexOf('%') >= 0) throw 1; // 空格会被编码成 %20 的假 host（'not a url' 不 throw）——判非法
          u = p.href.replace(/\/+$/, '');
        } catch (e) { applyBtn.textContent = '地址格式不对'; setTimeout(function () { applyBtn.textContent = '应用并切换'; }, 1500); return; }
        ctx.applyCustomAiUrl(u); // 临时切换 + 10s 探测，成功才落盘（与 cockpit 同链路）
        try { ctx.addMsg('sys', '⚙ 已应用 aiti-agent 地址：' + String(u).slice(0, 60) + '（10s 协议探测，成功才生效）'); } catch (e) {}
        closeDlg(); // AI 窗即将切换
      });
      foot.appendChild(openAiti); foot.appendChild(cancelBtn); foot.appendChild(applyBtn);
      card.appendChild(head); card.appendChild(body); card.appendChild(foot);
      try { makeCardDrag(head, card); } catch (e) {} // 拖拽（按住头部非按钮）
      dlg.appendChild(card);
      if (ctx.root) ctx.root.appendChild(dlg);
      dlg.classList.add('dbg-open');
      // 物理适配（小屏：counter-zoom 贴底全宽，参照预览弹窗 showDialog）；输入法弹出（visualViewport 收缩）→ 重定位贴键盘顶，防遮挡
      try {
        if (detectScreenMode().small) {
          dlg.style.zIndex = '2147483648'; // 盖住工具条（2147483647）
          card.style.position = 'fixed'; // 脱离 flex（placePhysPanel 依赖 fixed）
          var _placeVv = function () {
            try {
              var _vp2 = getPhysViewport();
              var _vvh = (window.visualViewport && window.visualViewport.height) || window.innerHeight; // 键盘弹出时收缩
              var _visVh = _fixedVisual ? _vvh : (_vvh * _vp2.scaleY); // 可视视觉高（贴底基准——键盘顶）
              placePhysPanel(card, { visW: capVisW(_vp2, 0), dock: 'bottom', gap: 0, visX: 0, borderRadius: '14px 14px 0 0', minH: 0, maxH: Math.round(_visVh * 0.92) });
            } catch (e) {}
          };
          _placeVv();
          if (window.visualViewport) window.visualViewport.addEventListener('resize', _placeVv); // 键盘弹/收跟随
          var _origClose = closeDlg;
          closeDlg = function () { _origClose(); try { if (window.visualViewport) window.visualViewport.removeEventListener('resize', _placeVv); } catch (e) {} }; // 关闭移除监听（防残留/重复绑定）
        }
      } catch (e) {}
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
    } catch (e) {}
  };

  ctx.bindAiUrlToBridge = function (base, token) {
      if (!ctx.cfg.aiUrl) return;
      var savedUrl = ctx.trackedAiUrl ? ctx.trackedAiUrl() : ''; // 追踪 URL（已过 base 校验）
      if (savedUrl) {
        // 有记录 URL（含 session）→ 保留（不重设 src，避免丢 session/当前页）
        return;
      }
      if (ctx.aiMode === 'popup') {
        // 新窗口模式：清 URL 记录后用带 bridge/token 的新 URL 重开窗口
        ctx.clearAiUrl();
        ctx.openAiPopup(ctx.aiUrlWithBridge(base, token));
        ctx.addMsg('sys', '🔗 AI 窗已绑定桥：' + base + ' token=' + token);
        return;
      }
      if (!ctx.aiIframe) return;
      var sep = ctx.cfg.aiUrl.indexOf('?') >= 0 ? '&' : '?';
      ctx.aiIframe.src = ctx.withAiWinMark(ctx.cfg.aiUrl + sep + 'bridge=' + encodeURIComponent(base) + '&token=' + encodeURIComponent(token) + '&_dbg=' + Date.now() + ctx.aiPageParams());
      ctx.addMsg('sys', '🔗 AI 窗已绑定桥：' + base + ' token=' + token);
      }
}
