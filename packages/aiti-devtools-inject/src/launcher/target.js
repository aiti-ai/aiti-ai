// target 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { VERSION } from './config.js';
import { MINI_DBG_CLIENT } from 'virtual:dbg-client';
import { el } from './dom.js';
import { getPhysViewport, _fixedVisual, positionPhysical, isTouchDevice } from './viewport.js';

export function initTarget(ctx) {

  ctx.ensureClientFresh = function (win, doc) {
      try {
        if (win && doc && doc.body && win.__dbg && typeof win.__dbg.getSelectionPayload !== 'function') {
          try { if (typeof win.__dbg.exitInspector === 'function') win.__dbg.exitInspector(); } catch (e) {}
          try { delete win.__dbg; } catch (e) {}
          var s2 = doc.createElement('script');
          s2.textContent = MINI_DBG_CLIENT.replace('__DBG_VERSION__', VERSION);
          doc.body.appendChild(s2);
        }
      } catch (e) {}
      }

  // 工具条（原在 ensureTarget 内；阶段 3 独立构建，launcher 初始化时调用一次）
  ctx.buildToolbar = function () {
      var toolbar = el('div', { class: 'dbg-toolbar dbg-float-toolbar' });
      var toolbarRow1 = el('div', { class: 'dbg-toolbar-row' });
      var selLabel = el('span', { class: 'dbg-sel-label' }, ['——']);
      // 工具条标题文字点击 → 打开预览弹窗（查看详情/指示/发送）——预览为可选：默认工具条 ✓ 直接发送，少点一次
      selLabel.title = '🔍 点击查看详情/预览（发送直接点 ✓）';
      selLabel.style.cursor = 'pointer';
      selLabel.style.textDecoration = 'underline dotted';
      selLabel.style.textUnderlineOffset = '3px';
      selLabel.addEventListener('click', function (e) {
        e.stopPropagation();
        // 预览当前选区：lastSelfPayload（最近 hover/点选，含触屏）优先——lastPayload 是上次确认✓的载荷，
        // 换了新元素没确认时它仍指向旧元素 → 弹窗永远显示第一次的结果（用户实测）。ifreme 选区无 lastSelfPayload → 回退 lastPayload。
        var _pp = ctx.lastSelfPayload || ctx.lastPayload;
        if (!_pp) return;
        ctx.lastPayload = _pp;
        // 预览弹窗也要真实源码路径：hover 载荷的 file 是未解析的 chunk URL——先 resolveElLoc（sourcemap + 组件函数定位）
        // 补全成真实文件+行再渲染，与候选/发送链路一致。
        var _render = function () {
          ctx.dTag.textContent = (_pp.tag || '?') + (_pp.rect ? ' ' + _pp.rect.w + '×' + _pp.rect.h : '') +
            (_pp.text ? ' “' + String(_pp.text).trim().slice(0, 30) + '”' : '');
          // 兼容两种形态：富载荷 framework.file 嵌套 / hover 轻载荷顶层 file
          var _fwf = (_pp.framework && _pp.framework.file) || _pp.file || null;
          var _fwn = (_pp.framework && _pp.framework.framework) || null;
          var _fwl = (_pp.framework && _pp.framework.line) || _pp.line || null;
          ctx.dLoc.textContent = _fwf
            ? ((_fwn || '') + ' · ' + String(_fwf).split('/').pop() + (_fwl ? ':' + _fwl : ''))
            : '';
          ctx.renderPreview(_pp);
          ctx.showDialog();
          // 打开预览时关掉工具条（避免两者同时显示互相干扰；关闭/取消预览时恢复）
          if (ctx.root) { var _tbEl = ctx.root.querySelector('.dbg-toolbar'); if (_tbEl) _tbEl.classList.remove('dbg-on'); }
        };
        if (typeof ctx.resolveElLoc === 'function') ctx.resolveElLoc(_pp).then(_render);
        else _render();
      });
      toolbarRow1.appendChild(selLabel);
      toolbar.appendChild(toolbarRow1);
      var toolbarRow2 = el('div', { class: 'dbg-toolbar-row dbg-toolbar-btns' });
      toolbar.appendChild(toolbarRow2);
      // 导航 6 按钮：↖父级 ↘子级（斜向=走 DOM 树；原 ↑↓ 图标让位给几何方向键防混淆）
      //   + ←↑↓→ 四个几何方向键正面化（原 ▾ 菜单掏空取消）；◀前一个/▶后一个/⏮最前/⏭最后 撤下——
      //   仅快捷键 PageUp/PageDown/Home/End（触屏在帮助窗 ④ 有可点入口），HOST_NAV_KEYS/doNav 不动
      var NAV_DEFS = [
        ['up', '↖', '父级（DOM 树上一层，↖=向父层）· 快捷键 Backspace / Delete'],
        ['downOrNext', '↘', '子级/深度遍历（↘=展开树；有子级→进入首子级；无子级→同级 next，一路点遍历整棵 DOM 树）· 快捷键 Enter'],
        ['leftN', '←', '页面左边相邻元素 · 快捷键 ←'], ['topN', '↑', '页面上边相邻元素 · 快捷键 ↑'],
        ['bottomN', '↓', '页面下边相邻元素 · 快捷键 ↓'], ['rightN', '→', '页面右边相邻元素 · 快捷键 →'],
      ];
      // ---- 通用弹出定位：锚点 rect（布局）→ 视觉（跟随缩放 scale/scaleY + counter-zoom）；
      //      默认朝下放行（anchor 下方），下方放不下翻上方；屏内 clamp；rAF 后按实际视觉尺寸校正 ----
      function anchorPopup(popupEl, anchorEl, opts) {
        opts = opts || {};
        var vp = getPhysViewport();
        var r = anchorEl.getBoundingClientRect();
        var tbEl = ctx.root.querySelector('.dbg-toolbar');
        var tbRect = tbEl ? tbEl.getBoundingClientRect() : null;
        var xMul = _fixedVisual ? 1 : vp.scale;   // rect 布局→视觉（iOS visual rect 已视觉）
        var yMul = _fixedVisual ? 1 : vp.scaleY;
        var anchorBottom = tbRect ? Math.max(r.bottom, tbRect.bottom) : r.bottom;
        var anchorTop = tbRect ? Math.min(r.top, tbRect.top) : r.top;
        var vBottom = anchorBottom * yMul, vTop = anchorTop * yMul;
        var vLeft = Math.max(4, r.left * xMul - (opts.offsetLeft || 0));
        var estH = opts.estH || 120, estW = opts.estW || 160;
        var vTop2 = vBottom + (opts.gap != null ? opts.gap : 4);
        if (vTop2 + estH > vp.h - 8) vTop2 = Math.max(4, vTop - estH - (opts.gap != null ? opts.gap : 4)); // 下方放不下翻上方
        vLeft = Math.min(vLeft, Math.max(4, vp.w - estW - 4));
        positionPhysical(popupEl, vLeft, vTop2, vp.scale, vp.scaleY);
        ctx.root.appendChild(popupEl);
        requestAnimationFrame(function () {
          try {
            if (!popupEl.parentNode) return;
            var w2 = popupEl.offsetWidth, h2 = popupEl.offsetHeight;
            var cLeft = Math.min(Math.max(4, vLeft), Math.max(4, vp.w - w2 - 4));
            var cTop = vTop2;
            if (cTop + h2 > vp.h - 4) cTop = Math.max(4, vTop - h2 - 4);
            if (cLeft !== vLeft || cTop !== vTop2) positionPhysical(popupEl, cLeft, cTop, vp.scale, vp.scaleY);
          } catch (e) {}
        });
      }
      NAV_DEFS.forEach(function (d) {
        var b = el('button', { 'data-tip': d[2], 'data-dir': d[0] }, [d[1]]);
        b.addEventListener('click', function () { ctx.doNav(d[0]); });
        toolbarRow2.appendChild(b);
      });
      // # 快速选择：CSS selector 或 xpath path
      var selBtn = el('button', { 'data-tip': '快速选择：输入 CSS selector（.card）或 xpath（//div[@class=card]）定位元素' }, ['#']);
      selBtn.addEventListener('click', function () {
        if (selInputRow.style.display === 'flex') { selInputRow.style.display = 'none'; ctx.floatToolbarReAnchor(); return; }
        selInputRow.style.display = 'flex';
        selInput.value = ''; // 先清空，自动识别当前选区 selector 填入（异步回传，可基于此调整）
        selInput.focus();
        ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_current_selector' }); // 选区所在页生成当前选区的 CSS selector / xpath 回传
        ctx.floatToolbarReAnchor(); // 弹窗两行使工具条变高 → 重新避让（下半部分不遮挡选区/弹窗）
      });
      toolbarRow2.appendChild(selBtn);
      var selInputRow = el('div', { class: 'dbg-toolbar-row dbg-sel-input-row' });
      var selInput = el('input', { placeholder: 'CSS selector 或 XPath，Enter 定位', 'aria-label': 'selector' });
      var selHint = el('div', { class: 'dbg-sel-hint' }, ['CSS：.card / .card button / #main > li:nth-child(2)　XPath：//div[@class="card"]']);
      selInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var v = selInput.value.trim();
          if (v) { ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_select', payload: { selector: v } }); }
          selInputRow.style.display = 'none';
          ctx.floatToolbarReAnchor();
        } else if (e.key === 'Escape') { selInputRow.style.display = 'none'; ctx.floatToolbarReAnchor(); }
      });
      selInputRow.appendChild(selInput);
      selInputRow.appendChild(selHint);
      toolbar.appendChild(selInputRow);
      var confirmBtn = el('button', { 'data-tip': '确认选中并弹出预览', class: 'dbg-nav-ok' }, ['✓']);
      confirmBtn.addEventListener('click', function () {
        // user_pick_element 交互（pickPanel 存在）：工具条 ✓ 确认 → 候选 + 发送（同步 MCP / 异步 AI 窗）+ 结束交互
        if (ctx.pickPanel) {
          var _pp = ctx.pickPanel;
          var _pl = _pp.el || (ctx.getPickPayload ? ctx.getPickPayload() : null);
          if (_pl) {
            _pp.el = _pl;
            var _desc = '<' + (_pl.tag || '?') + '>'
              + (_pl.text ? ' ' + String(_pl.text).trim().slice(0, 50) : '')
              + (_pl.xpath ? ' · ' + String(_pl.xpath).slice(0, 60) : '');
            _pp.resultDesc = _desc;
            if (_pp.asyncMode) {
              // 异步：只发 AI 窗口输入框（元素候选 [元素N] 进 pi-web）——不走 MCP、不重复：
              //   不再 postBridgeEvent user_answer（那会让扩展把回答文本也当候选再插一个——用户实测重复）
              try { ctx.picksAddElement(ctx.enrichElPayload ? ctx.enrichElPayload(_pl) : _pl); } catch (e) {}
              ctx.finishPickPanel({ status: 'async', payload: _pl, note: '候选已放入 AI 待选' });
            } else {
              // 同步：只回 MCP（sendInteractionResult）——不再往输入框放候选（用户实测：同步回传的同时又放了一个，重复）。
              // 先 sourcemap 补全真实源码路径再回传（user_pick_element 响应带真实文件而非 chunk URL）
              var _fin = function (p2) {
                _pp.el = p2;
                ctx.finishPickPanel({ status: 'answered', payload: p2, selector: p2.xpath || null });
              };
              if (typeof ctx.resolveElLoc === 'function') ctx.resolveElLoc(_pl).then(function (pl2) { _fin(pl2 || _pl); });
              else _fin(_pl);
            }
          }
          return;
        }
        if (ctx.aiInspectActive) {
          // 选区在宿主页（self）→ 回传宿主选区（优先 getSelectionPayload 富载荷：computed/selector/url/pageId；
          // hover 轻载荷兜底）→ 补全 pageId/桥/url 后发 AI 窗；否则 target
          if (ctx.lastSelfPayload) {
            var _sp = null;
            try {
              if (ctx.selfClient && typeof ctx.selfClient.getSelectionPayload === 'function') _sp = ctx.selfClient.getSelectionPayload();
            } catch (e) {}
            try { ctx.picksAddElement(ctx.enrichElPayload(_sp || ctx.lastSelfPayload)); }
            // 兜底 catch：紧跟着 picksAddElement 生成时也捕获 selfAiRequested→_selfAttrib，保证归属在生成那一刻定死
            catch (e) { ctx.postToAi({ type: 'dbg_ai_element', _selfAttrib: !!ctx.selfAiRequested, payload: ctx.enrichElPayload(_sp || ctx.lastSelfPayload) }); }
            if (ctx.selfClient && typeof ctx.selfClient.resumeHover === 'function') ctx.selfClient.resumeHover();
            ctx.selfEngaged = false; ctx.lastSelfPayload = null;
            try { ctx.exitAiInspect(); } catch (e) {}
            return;
          }
          ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_ai_confirm' });
          setTimeout(function () { try { ctx.exitAiInspect(); } catch (e) {} }, 600);
        } else {
          // 外部 Inspector：✓ 确认 → 直接发送给 AI（候选 [元素N] 进输入框）——不再弹预览（用户要求：预览改为点工具条标题文字才看）
          var _ep = null;
          if (ctx.lastSelfPayload) _ep = ctx.lastSelfPayload;
          if (!_ep) {
            try { if (ctx.selfClient && typeof ctx.selfClient.getSelectionPayload === 'function') _ep = ctx.selfClient.getSelectionPayload(); } catch (e) {}
          }
          if (_ep) {
            ctx.lastPayload = _ep;
            try { ctx.picksAddElement(ctx.enrichElPayload ? ctx.enrichElPayload(_ep) : _ep); }
            // 兜底 catch：同上一处，生成时刻捕获归属，避免发送时（异步）被复位误路由
            catch (e) { ctx.postToAi({ type: 'dbg_ai_element', _selfAttrib: !!ctx.selfAiRequested, payload: ctx.enrichElPayload ? ctx.enrichElPayload(_ep) : _ep }); }
          } else {
            ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_confirm' }); // 无宿主选区（iframe 内）——target 文档弹预览（次要场景）
          }
          ctx.selfEngaged = false; ctx.lastSelfPayload = null;
          try { ctx.exitInspector(); } catch (e) {}
          return;
        }
      });
      // 退出 AI 点选模式：关 aiPick + 通知 AI 窗（按钮恢复 + 输入框恢复显示）——挂 ctx（routing.js 等跨模块调用）
      ctx.exitAiInspect = function () {
        ctx.aiInspectActive = false;
        try { ctx.postToAi({ type: 'dbg_ai_inspect_off', payload: {} }); } catch (e) {} // AI 窗按钮恢复（🎯）
        // 完全退出点选（退出后不再可点选——即使外部 Inspector 之前开着）：target + 宿主 client 退出
        try { ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: false } }); } catch (e) {}
        try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {}
        try { if (window.__dbg && typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
        try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {}
        ctx.inspectorOn = false;
        ctx.inspBtn.classList.remove('dbg-on');
        ctx.deactivateNestedIframes(); // 退出嵌套 iframe
        // 不隐藏目标 iframe（退出 Inspector 只退出点选，不关 iframe）
        // 隐藏选区工具条（退出点选不残留"还在选择"观感）
        if (ctx.root) { var tbEl = ctx.root.querySelector('.dbg-toolbar'); if (tbEl) tbEl.classList.remove('dbg-on'); }
        // 退出清理：HUD/拦截提示条/按钮 tooltip 彻底移除（不留 opacity:0 残骸——透明但拦截下方元素点击）
        try { if (ctx.cleanupInspectResidue) ctx.cleanupInspectResidue(); } catch (e) {}
        // 选择完成/退出 → 恢复显示 AI 窗（点选时隐藏了整个弹窗）
        // self 触发（本页顶部 InspectButton，数据归自己）：本页即 AI——不弹 launcher 自己的 AI 窗（避免多余浮窗）
        if (!ctx.selfAiRequested && !ctx.selfHostPage) {
          ctx.aiOpen = true;
          ctx.ensureAi();
          ctx.showAi(true);
          ctx.aiBtn.classList.add('dbg-on');
        }
        // 会话结束即复位归属：selfAiRequested 只在点选会话期间生效——残留会让后续错误/日志候选
        // 全部劫持发给自己，AI 窗收不到（用户实测：错误消息没进 AI 窗）。复位后回归 AI 窗优先。
        ctx.selfAiRequested = false;
      }
      var resumeBtn = el('button', { 'data-tip': '恢复快选：退出临时状态，hover 高亮重新生效（鼠标划过快速预览/切换选区）', class: 'dbg-nav-resume' }, ['🖱']);
      resumeBtn.addEventListener('click', function () {
        if (ctx.selfClient && typeof ctx.selfClient.resumeHover === 'function') ctx.selfClient.resumeHover();
        ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_resume_hover' });
        ctx.addMsg('sys', '🖱 已恢复快选：hover 高亮重新生效（划过快速预览，点击即选新位置）。');
      });
      toolbarRow2.appendChild(resumeBtn);
      // 模拟 hover（真实事件派发）：pin 在当前选中元素，页面 JS hover 逻辑（mouseenter 展开/动画）生效并持久保持；
      //   再点/退出清除（mouseleave 仍被冻结拦截 → 持久）。只影响 JS 逻辑，CSS :hover 需真实指针。
      var hoverSimBtn = el('button', { 'data-tip': '模拟 hover（真实派发 mouseover/mouseenter，页面 JS hover 逻辑生效并持久保持；再点或退出清除）', class: 'dbg-nav-hover' }, ['👆']);
      hoverSimBtn.addEventListener('click', function () {
        ctx.hudHoverOn = !ctx.hudHoverOn;
        try { ctx.applyHoverSim(); } catch (e) {}
        hoverSimBtn.classList.toggle('dbg-on', !!ctx.hudHoverOn); // 立即更新外观
        ctx.addMsg('sys', '👆 模拟 hover：' + (ctx.hudHoverOn ? '已 pin（mouseover/mouseenter 已派发，持久保持；再点或退出清除）' : '已清除（mouseleave 已派发）') + '。');
      });
      toolbarRow2.appendChild(hoverSimBtn);
      var profileBtn = el('button', { 'data-tip': '放行方案（下拉选择）：🔒默认放行 / 🔓全部放行 / ⛔全部冻结 / 自定义方案；下拉末尾「⚙️ 自定义…」打开设置面板管理多个方案。快捷键：空格/Tab=默认放行⇄全部放行一键切换（锁定态生效，页面弹出菜单不收起）', class: 'dbg-nav-profile' }, [ctx.RELEASE_PROFILES.default.label]);
      var profileMenu = null;
      function closeProfileMenu() {
        if (profileMenu && profileMenu.parentNode) profileMenu.parentNode.removeChild(profileMenu);
        profileMenu = null;
      }
      profileBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        showTooltip(profileBtn.getAttribute('data-tip'), profileBtn, 'click'); // 手动显示 tooltip（stopPropagation 挡了工具栏委托）
        if (profileMenu) { closeProfileMenu(); return; }
        profileMenu = el('div', { class: 'dbg-profile-menu' });
        ctx.getProfileOrder().forEach(function (name) {
          var pf = ctx.getProfiles()[name];
          var item = el('div', { class: 'dbg-profile-item' + (name === ctx.currentProfile ? ' dbg-on' : '') }, []);
          item.appendChild(el('span', { class: 'dbg-profile-label' }, [pf.label + ((name === 'default' || name === 'all') ? ' · 空格/Tab' : '')]));
          item.appendChild(el('span', { class: 'dbg-profile-desc' }, [pf.release.length ? '放行 ' + pf.release.join('/') : '全部冻结']));
          item.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var applied = ctx.applyProfile(name);
            profileBtn.textContent = applied.label;
            closeProfileMenu();
            ctx.addMsg('sys', '已应用放行方案：' + applied.label + '（' + (applied.release.length ? '放行 ' + applied.release.join('/') : '全部冻结') + '）');
          });
          profileMenu.appendChild(item);
        });
        // 常驻动作项：「⚙️ 自定义…」打开 ⏱ 设置面板管理多个自定义方案（增删改+localStorage 持久化已在）
        profileMenu.appendChild(el('div', { class: 'dbg-profile-divider' }));
        var pfCustom = el('div', { class: 'dbg-profile-item dbg-profile-action' }, []);
        pfCustom.appendChild(el('span', { class: 'dbg-profile-label' }, ['⚙️ 自定义…']));
        pfCustom.appendChild(el('span', { class: 'dbg-profile-desc' }, ['添加/编辑/删除自定义方案']));
        pfCustom.addEventListener('click', function (ev) {
          ev.stopPropagation();
          closeProfileMenu();
          ctx.toggleSpeedPanel(); // 直接打开设置面板（用户定稿：不做滚动定位，方案管理区在其中）
        });
        profileMenu.appendChild(pfCustom);
        anchorPopup(profileMenu, profileBtn, { // 通用弹出定位（跟随缩放/字体 + 屏内 clamp + 溢出翻面）
          estH: ctx.getProfileOrder().length * 32 + 51, // +51：divider + ⚙️ 动作项两行（翻面判断不错位）
          estW: 250 + 40, // min-width 250 + 左移 40（原 left=br.left-40）
          offsetLeft: 40
        });
      });
      toolbarRow2.appendChild(profileBtn);
      // 帮助按钮：使用帮助小窗（help 子系统构建/开关；打开时工具条保持显示，对照选区读帮助）
      var helpBtn = el('button', { 'data-tip': '使用帮助：按钮说明 / 快捷键总表 / 进阶技巧（含放行工作流、触屏导航入口）', class: 'dbg-nav-help' }, ['❓']);
      helpBtn.addEventListener('click', function () { ctx.toggleHelpDialog(); });
      toolbarRow2.appendChild(helpBtn);
      var exitInspBtn = el('button', { 'data-tip': '取消选区并退出 Inspector', class: 'dbg-nav-close' }, ['✕']);
      exitInspBtn.addEventListener('click', function () {
        if (ctx.selfClientActive) { try { ctx.exitSelfClient(); } catch (e) {} ctx.selfClientActive = false; }
        try { ctx.exitInspector(); } catch (e) {} // 真正退出（异常不阻断后续清理）
        // 直接调 client exitInspector（监听移除在函数开头——即使后续 RangeError 也完成退出，hover/点击不再被拦截）
        try { if (window.__dbg && typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
        try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {}
        if (ctx.hud && ctx.hud.parentNode) { ctx.hud.parentNode.removeChild(ctx.hud); ctx.hud = null; } // 兜底移除 HUD
        ctx.sweepTargetOutlinesGlobal(); // 独立兜底（不依赖 exitInspector 完整执行）
        setTimeout(ctx.sweepTargetOutlinesGlobal, 500);
        setTimeout(ctx.sweepTargetOutlinesGlobal, 1500);
        ctx.addMsg('sys', '✕ 已退出 Inspector（宿主与全部 iframe 点选已关闭）。');
      });
      // 分隔线：确认按钮（✓）特殊——与左边功能按钮隔开，放在最右边
      toolbarRow2.appendChild(el('span', { class: 'dbg-toolbar-sep' }));
      toolbarRow2.appendChild(exitInspBtn);
      toolbarRow2.appendChild(confirmBtn); // ✓ 确定按钮（最右）
      // 鼠标在工具条上：冻结跟随位置（允许点击按钮，避免"追上又跑"）
      window.addEventListener('click', function (e) {
        if (e.target && e.target.closest && (e.target.closest('.dbg-nav-profile') || e.target.closest('.dbg-profile-item'))) return; // 按钮/菜单项不先关：各自 handler 处理（applyProfile + 关闭）
        closeProfileMenu();
      }, true); // window capture（工具条构建时注册，先于 onClick/freezeEvent）：点任何地方自动收起
      // 按钮 tooltip：大屏 hover 显示（移出隐藏）+ 小屏/点击显示（2.2s 自动消失）
      var tooltipEl = null, tooltipTimer = null, tooltipMode = null;
      var tooltipShownOnce = {}; // key=tip 内容：整个页面生命周期每个 tooltip 只弹一次（含 hover；刷新页面重置）
      function showTooltip(text, anchorEl, mode) {
        if (tooltipShownOnce[text]) return; // 该按钮 tooltip 已弹过一次（点击或 hover），整个页面生命周期不再弹
        tooltipShownOnce[text] = true;
        if (!tooltipEl) {
          tooltipEl = el('div', { class: 'dbg-tooltip' });
          ctx.root.appendChild(tooltipEl);
        }
        tooltipEl.textContent = text;
        // 跟随缩放/字体：rect=布局 → 视觉（横向×scale、纵向×scaleY）；positionPhysical（counter-zoom + 布局换算）——
        //   缩放页面（无 meta scale 0.396/华为非等比）布局 px 直接 fixed → tooltip 视觉错位/弹到不可见位置（用户"第二次再点就不显示"）
        var vp = getPhysViewport();
        var r = anchorEl.getBoundingClientRect();
        var xMul = _fixedVisual ? 1 : vp.scale;
        var yMul = _fixedVisual ? 1 : vp.scaleY;
        // 按 tooltip 实际高度往上几个身位（8px 间距）——多行提示不被工具条覆盖；顶部放不下转按钮下方
        var th = tooltipEl.offsetHeight || 28;
        var vTop = r.top * yMul - th - 8;
        // 若有打开的下拉（🔒 放行方案，向上弹在按钮上方）→ tooltip 放到下拉上方（避免两者覆盖）
        var openMenu = null;
        if (profileMenu && profileMenu.parentNode) openMenu = profileMenu;
        if (openMenu) {
          var mr = openMenu.getBoundingClientRect();
          if (mr.top * yMul < r.top * yMul) { // 下拉在按钮上方（向上弹）→ tooltip 放到下拉上方（更高，距离重算）
            vTop = mr.top * yMul - th - 8;
          }
        }
        if (vTop < 2) vTop = r.bottom * yMul + 8;
        var vLeft = Math.max(4, Math.min(r.left * xMul, vp.w - 180));
        positionPhysical(tooltipEl, vLeft, vTop, vp.scale, vp.scaleY);
        tooltipEl.style.opacity = '1';
        tooltipMode = mode || 'hover';
        clearTimeout(tooltipTimer);
        if (tooltipMode === 'click') {
          tooltipTimer = setTimeout(function () { hideTooltip(); }, 2200);
        }
      }
      function hideTooltip() {
        // 无条件隐藏（timer 回调 / hover 移出都用它）；mouseout 处单独判断是否跳过 click 模式。
        // 淡出过渡（.3s）结束后移除 DOM：不留 opacity:0 残骸（透明但拦截下方元素点击）
        if (tooltipEl) {
          tooltipEl.style.opacity = '0';
          clearTimeout(tooltipTimer);
          tooltipTimer = setTimeout(function () {
            if (tooltipEl && tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
            tooltipEl = null;
          }, 320);
        }
        tooltipMode = null;
      }
      // 退出 Inspector 时彻底移除按钮 tooltip（供 ctx.cleanupInspectResidue 调用；淡出中的 timer 一并取消）
      ctx.removeTooltip = function () {
        clearTimeout(tooltipTimer);
        if (tooltipEl && tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
        tooltipEl = null;
        tooltipMode = null;
      };
      // 大屏：hover 显示（跟随按钮，移出隐藏）；触屏无 hover
      toolbar.addEventListener('mouseover', function (e) {
        if (isTouchDevice()) return;
        var btn = e.target && e.target.closest ? e.target.closest('button, .dbg-sel-label') : null; // 按钮 + 选区标签（标签 tooltip 含完整信息）
        var tip = btn && btn.getAttribute('data-tip');
        if (btn && tip) showTooltip(tip, btn, 'hover');
      });
      toolbar.addEventListener('mouseout', function () {
        if (!isTouchDevice() && tooltipMode !== 'click') hideTooltip(); // 点击模式由 2.2s timer 消失
      });
      // 点击显示（小屏主用；大屏点击也提示）：2.2s 自动消失
      toolbar.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('button') : null;
        var tip = btn && btn.getAttribute('data-tip');
        if (btn && tip) showTooltip(tip, btn, 'click');
      });
      // 鼠标进入工具条 = 暂停选取（视同点击：hover 停用、选区保留、工具条位置冻结），移出恢复
      toolbar.addEventListener('mouseenter', function () {
        ctx.toolbarHovering = true;
        if (ctx.selfClient && typeof ctx.selfClient.pauseHover === 'function') ctx.selfClient.pauseHover();
        ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_pause_hover' });
      });
      toolbar.addEventListener('mouseleave', function () {
        // 只解除工具条位置冻结（可跟随新选区）；不自动恢复 hover 快选——用户需手动 🖱 恢复快选 或 ✕ 取消
        ctx.toolbarHovering = false;
      });
      ctx.root.appendChild(toolbar); // 工具条放 root（launcher 直接子级）：z-index 2147483647 全局生效
      }
}
