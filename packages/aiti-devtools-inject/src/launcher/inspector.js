// inspector 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el } from './dom.js';
import { getPhysViewport, detectScreenMode, isTouchCompact, isTouchDevice, isSmallScreen } from './viewport.js';

export function initInspector(ctx) {
  ctx.applyToolbarCompact = function () {
      var tb = ctx.root.querySelector('.dbg-toolbar');
      if (!tb) return;
      tb.classList.toggle('dbg-compact', isSmallScreen());
      tb.classList.toggle('dbg-touch', isTouchCompact());
      // 物理视口限宽（视觉 px=基础宽，counter-zoom 后）：移动端 layout=980 时 CSS 100vw 限宽失效
      var vp = getPhysViewport();
      tb.style.maxWidth = (vp.w - 12) + 'px'; // 视觉视口限宽（当前可见区域，缩放跟随避免折行）
      // dbg-phys-small 改用纯设备小屏（detectScreenMode().small，与 aiwin 一致）：
      // isSmallScreen()=small||触屏——pad（777px 触屏）被误挂小屏 class → AI 窗角柄/边缘条被
      // #...dbg-phys-small .dbg-ai-resize{display:none} 干掉（“缩放功能没了”反复出现的真凶）。
      // HUD/dialog 小屏放大对 pad 本也无益（非小屏），纯 small 判定语义正确。
      ctx.root.classList.toggle('dbg-phys-small', detectScreenMode().small);
      }

  ctx.enterInspector = function () {
      try { if (ctx.debugPanel) ctx.debugPanel.classList.remove('dbg-open'); } catch (e) {} // 收起 debug 信息面板（on-load 自动开的白卡片盖住点选）
      ctx.selfAiRequested = false; // FAB 外部 Inspector：候选归 AI 窗（原逻辑；无 AI 窗时 postToAi 兑底归自己）
      ctx.inspectorOn = true;
      ctx.aiInspectActive = false; // 外部 Inspector 与 AI 点选互斥：关闭 AI 点选模式
      ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: false } });
      // 阶段 3：无自建预览——目标 = 宿主自身 + 宿主真实 iframe（hub 摆的目标页）
      // 新窗口模式：AI 窗是独立窗口不遮挡页面——不隐藏/关闭（隐藏=关闭会丢会话，且用户以为点没反应）
      if (ctx.aiMode !== 'popup') {
        ctx.showAi(false);
        ctx.aiOpen = false;
        ctx.aiBtn.classList.remove('dbg-on');
      }
      ctx.inspBtn.classList.add('dbg-on');
      ctx.hudHoverOn = false; // 每次进入重置模拟 hover（防残留）
      try { var _hb = ctx.root.querySelector('.dbg-nav-hover'); if (_hb) _hb.classList.remove('dbg-on'); } catch (e) {}
      ctx.applyToolbarCompact(); // 小屏放大工具条
      ctx.root.querySelector('.dbg-toolbar').classList.remove('dbg-on'); // hover 快选不显示，点击暂停后显示
      // 双区同时生效：宿主页自身（self client）+ 目标 iframe（同一份 client，事件不跨 document 天然不冲突）
      var mode = isTouchDevice() ? 'touch' : 'mouse';
      ctx.ensureClientFresh(window, document); // 宿主 client 强制最新（防旧版残留）
      ctx.listFrames().forEach(function (fr) { ctx.ensureClientFresh(fr.win, fr.win.document); }); // 全部宿主 iframe 强制最新
      ctx.enterSelfClient(mode);
      ctx.activateNestedIframes(mode); // 宿主页内同源 iframe 也可选中
      ctx.broadcast({ type: 'dbg_enter_inspector', payload: { mode: mode } });
      ctx.addMsg('sys', '🎯 Inspector（' + (mode === 'touch' ? '触屏' : '桌面') + '）：宿主页与目标页均可点选——' +
        (mode === 'touch'
          ? '点击=移动选区，✓确认。'
          : '划过高亮，点击选中，Esc 退出。'));
      try { if (ctx.showPickHint) ctx.showPickHint(); } catch (e) {} // 小屏底部 toast：点击元素选择
      }

  ctx.sweepTargetOutlinesGlobal = function () {
      // 清除宿主 + 全部宿主 iframe 的残留选区框 div（独立兜底，不依赖 exitInspector 完整执行）
      function sweep(doc) {
        try {
          doc.querySelectorAll('body > div').forEach(function (n) {
            if (n.style && n.style.position === 'fixed' && n.style.outline && String(n.style.zIndex) === '2147483646') {
              if (n.parentNode) n.parentNode.removeChild(n);
            }
          });
        } catch (e) {}
      }
      sweep(document);
      ctx.listFrames().forEach(function (fr) { sweep(fr.win.document); });
      }

  // 清理点选残留覆盖层（HUD/拦截提示条/按钮 tooltip）：退出后彻底移除，不留 opacity:0 残骸
  // （透明但拦截下方元素点击——block-tip/tooltip 曾实测挡点击）。两条退出路径（外部 Inspector / AI 点选）共用。
  ctx.cleanupInspectResidue = function () {
    try { if (ctx.hideHud) ctx.hideHud(); } catch (e) {} // 隐藏兜底（淡出中不留 opacity:1）
    try { if (ctx.hud && ctx.hud.parentNode) { ctx.hud.parentNode.removeChild(ctx.hud); ctx.hud = null; } } catch (e) {} // 彻底移除 HUD 元素（点击提示不残留）
    try { if (ctx.resetHudPos) ctx.resetHudPos(); } catch (e) {} // 重置 HUD 拖动位置（下次恢复跟随选区）
    try {
      var _tip = ctx.root.querySelector('.dbg-block-tip');
      if (_tip) { clearTimeout(_tip.__t); clearTimeout(_tip.__t2); if (_tip.parentNode) _tip.parentNode.removeChild(_tip); } // 拦截提示条：取消定时器并移除
    } catch (e) {}
    try { if (ctx.removeTooltip) ctx.removeTooltip(); } catch (e) {} // 按钮 tooltip 一并移除
  };

  ctx.exitInspector = function () {
      ctx.inspectorOn = false;
      ctx.inspBtn.classList.remove('dbg-on');
      if (ctx.hudHoverOn) {
        ctx.hudHoverOn = false;
        try { ctx.applyHoverSim(); } catch (e) {} // 退出：清除模拟 hover 持久态（client 侧 exitInspector 也自清）
      }
      if (ctx.aiInspectActive) {
        ctx.aiInspectActive = false;
        try { ctx.postToAi({ type: 'dbg_ai_inspect_off', payload: {} }); } catch (e) {} // AI 点选结束：同步 AI 窗按钮
        // self 触发（数据归自己）：本页即 AI——不弹 launcher 自己的 AI 窗
        if (!ctx.selfAiRequested && !ctx.selfHostPage) { ctx.aiOpen = true; ctx.ensureAi(); ctx.showAi(true); ctx.aiBtn.classList.add('dbg-on'); } // 恢复显示 AI 窗（点选时隐藏了整个弹窗；self 宿主页无 AI 窗不弹）
      } else if (ctx.aiMode !== 'popup') {
        // 外部 Inspector（点 FAB 🎯 进入）：进入时隐藏了 AI 窗（showAi(false)），确认/退出后恢复显示——
        // 候选 [元素N] 要弹出给用户看（否则确认后没反应，用户以为失败）
        if (!ctx.selfAiRequested && !ctx.selfHostPage) {
          ctx.aiOpen = true;
          try { ctx.ensureAi(); } catch (e) {}
          try { ctx.showAi(true); } catch (e) {}
          try { ctx.aiBtn.classList.add('dbg-on'); } catch (e) {}
        }
      }
      ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: false } });
      ctx.root.querySelector('.dbg-toolbar').classList.remove('dbg-on');
      ctx.cleanupInspectResidue(); // 彻底移除 HUD/拦截提示条/按钮 tooltip（不留 opacity:0 残骸挡点击）
      if (ctx.dialog) ctx.dialog.classList.remove('dbg-open'); // 退出时直接关预览弹窗（不调 closeDialog——closeDialog 会调 exitInspector，避免无限递归）
      ctx.exitSelfClient();
      ctx.broadcast({ type: 'dbg_exit_inspector' });
      ctx.deactivateNestedIframes(); // 退出嵌套 iframe
      if (document.body.style.paddingBottom) document.body.style.paddingBottom = ''; // 清小屏 HUD 撑开的空间
      ctx.sweepTargetOutlinesGlobal();
      // 会话结束即复位归属（同 exitAiInspect）：残留会让后续错误/日志候选全部劫持发给自己，AI 窗收不到
      ctx.selfAiRequested = false;
      // 异步重画兜底：退出后 2s 内持续清除（某些路径退出后短暂重画选区框）
      var _sweepN = 0;
      var _sweepT = setInterval(function () {
        ctx.sweepTargetOutlinesGlobal();
        if (++_sweepN >= 4) clearInterval(_sweepT);
      }, 500);
      }

  ctx.activateNestedIframes = function (mode) {
      try {
        document.querySelectorAll('iframe').forEach(function (f) {
          if (f.closest && f.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return; // target/AI 窗单独处理
          try {
            var w = f.contentWindow;
            if (w && w.__dbg && typeof w.__dbg.enterInspector === 'function') w.__dbg.enterInspector(mode || 'mouse');
          } catch (e) {} // 跨源 iframe 无法访问——跳过
        });
      } catch (e) {}
      }

  ctx.deactivateNestedIframes = function () {
      try {
        document.querySelectorAll('iframe').forEach(function (f) {
          if (f.closest && f.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
          try {
            var w = f.contentWindow;
            if (w && w.__dbg && typeof w.__dbg.exitInspector === 'function') w.__dbg.exitInspector();
          } catch (e) {}
        });
      } catch (e) {}
      }
}
