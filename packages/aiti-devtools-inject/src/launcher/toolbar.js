// toolbar 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { getPhysViewport, detectCoordSemantics, positionPhysical } from './viewport.js';
import { makePointerDrag } from './drag.js';
import { HOST_NAV_KEYS } from './constants.js';

export function initToolbar(ctx) {
  ctx.floatToolbar = function (x, y, w, h) {
      var tb = ctx.root.querySelector('.dbg-toolbar');
      if (!tb) return;
      if (Date.now() < ctx.navHoldT) return; // 导航切换选区中：工具条保持当前位置（连续点击导航不跳、可连续点）
      ctx.attachToolbarDrag(); // 确保拖动绑定（工具条可能延迟创建；幂等 __dragBound）
      // 拖动后：选区 rect 未变 → 保持拖动位置（不干扰用户摆放）；选区变化（导航/点选新元素）→ 智能贴合
      if (ctx.toolbarDragged && ctx.lastSelRect &&
          Math.abs(ctx.lastSelRect.x - x) < 4 && Math.abs(ctx.lastSelRect.y - y) < 4) return;
      ctx.toolbarDragged = false;
      ctx.lastSelRect = { x: x, y: y, w: w, h: h || 24 };
      tb.classList.add('dbg-floating');
      var vp = getPhysViewport();
      // 布局坐标（选区宿主坐标）→ 视觉 px——与 __vis/applyToolbarZoom 同一基准（页面缩放/移动端 layout 缩放统一）
      var xv = x * vp.scale, yv = y * vp.scale;
      var wv = (w || 24) * vp.scale, hv = (h || 24) * vp.scale;
      var th = tb.offsetHeight || 30, tbw = tb.offsetWidth || 200; // 视觉尺寸（counter-zoom 抵消后 offset=视觉）
      var vw = vp.w, vh = vp.h; // 物理视口（视觉 px）——移动端 layout=980 会允许超屏位置
      // 完全避让选区（不遮挡选中可见性）：上方空间足 → 选区上方；否则下方（都确保不出视口）；再否则重叠但强制视口内
      var top;
      var upOk = (yv - th - 8 >= 4);
      var downOk = (yv + hv + 8 + th <= vh - 4);
      if (upOk) top = yv - th - 8;
      else if (downOk) top = yv + hv + 8;
      else top = Math.max(4, Math.min(yv - th - 8, vh - th - 4)); // 上下都不够：重叠兜底（顶部优先，不出视口）
      // 绝对保险：clamp 视口内（工具条永远可见，不被底部/顶部截断隐藏）
      top = Math.min(Math.max(4, top), Math.max(4, vh - th - 4));
      // HUD 提示显示中（hover 快选）→ 工具条避让 HUD 区域（不盖住多行提示）
      var hudEl2 = ctx.root.querySelector('.dbg-hud');
      var hudShown = hudEl2 && hudEl2.style.opacity !== '0' && hudEl2.style.opacity !== '';
      if (hudShown) {
        var hr = hudEl2.getBoundingClientRect();
        var hrTop = hr.top * vp.scale, hrBot = hr.bottom * vp.scale; // 布局 → 视觉（同基准比较）
        if (hrTop >= yv - 2 && top <= hrBot + 4 && hrTop <= yv + hv + 4) {
          // 工具条想放在 HUD 位置 → 挪到 HUD 上方（选区上方空间优先，否则选区下方 HUD 之上）
          if (yv - th - 8 >= 4) top = yv - th - 8;
          else top = Math.max(4, hrTop - th - 8);
        }
      }
      // 水平：不强行左对齐选区（左对齐会把工具条宽度压向视口边缘导致折行）——选区上方水平居中，clamp 视口内保持完整宽度
      var left = Math.min(Math.max(4, xv - tbw / 2), Math.max(4, vw - tbw - 8));
      // 点选/问答浮窗显示中 → 工具条避让：.dbg-pick-dialog（AI 请你选择元素确认窗 / 兜底问答面板）
      //   z-index 比工具条高一档（2147483648 > 2147483647），重叠时盖住工具条——底部贴合的选区最易撞上；
      //   问答面板可多个并存（不同 requestId）→ 遍历全部，逐个避让
      var _pds = ctx.root.querySelectorAll('.dbg-pick-dialog');
      for (var _pi = 0; _pi < _pds.length; _pi++) {
        var _pr = _pds[_pi].getBoundingClientRect();
        if (!(_pr.width > 2 && _pr.height > 2)) continue; // display:none 时 rect 全 0 → 跳过
        var _pdL = _pr.left * vp.scale, _pdR = _pr.right * vp.scale; // rect=布局 px → ×scale 转视觉（同上方 HUD 避让基准）
        var _pdT = _pr.top * vp.scale, _pdB = _pr.bottom * vp.scale;
        if (left < _pdR + 4 && left + tbw > _pdL - 4 && top < _pdB - 4 && top + th > _pdT + 4) {
          // 矩形相交：面板上方空间足 → 挪到面板上方；否则面板下方；都放不下保持原 clamp 结果（重叠兜底）
          if (_pdT - th - 8 >= 4) top = Math.max(4, _pdT - th - 8);
          else if (_pdB + 8 + th <= vh - 4) top = _pdB + 8;
        }
      }
      tb.__vis = { left: left, top: top }; // 视觉目标（applyToolbarZoom 按此换算布局 + counter-zoom）
      ctx.applyToolbarZoom(); // 页面缩放时 counter-zoom（工具条不跟着页面放大）
      }

  ctx.floatToolbarReAnchor = function () {
      if (!ctx.lastSelRect) return;
      var wasDragged = ctx.toolbarDragged;
      ctx.toolbarDragged = false; // 强制重算（弹窗开/关是临时高度变化，应重新避让）
      ctx.floatToolbar(ctx.lastSelRect.x, ctx.lastSelRect.y, ctx.lastSelRect.w, ctx.lastSelRect.h);
      ctx.toolbarDragged = wasDragged;
      }

  // 浮窗弹出时工具条避让（interact.js 开窗时调用）：有选区 → 走完整重锚（含 HUD/浮窗避让）；
  //   无选区（用户拖过工具条，lastSelRect 已清）→ 按当前浮窗位置直接上移工具条（否则重锚 no-op，工具条被浮窗盖住）
  ctx.dodgeToolbarAboveDialog = function (dialog) {
      var tb = ctx.root.querySelector('.dbg-toolbar');
      if (!tb || !tb.classList.contains('dbg-on') || !tb.classList.contains('dbg-floating')) return;
      if (ctx.lastSelRect) { ctx.floatToolbarReAnchor(); return; }
      try {
        var vp = getPhysViewport();
        var tr = tb.getBoundingClientRect(), dr = dialog.getBoundingClientRect();
        if (!(dr.width > 2 && dr.height > 2)) return;
        var th = tb.offsetHeight || 30;
        var tL = tr.left * vp.scale, tR = tr.right * vp.scale;
        var tT = tb.__vis ? tb.__vis.top : tr.top * vp.scale, tB = tT + th;
        var dL = dr.left * vp.scale, dR = dr.right * vp.scale;
        var dT = dr.top * vp.scale, dB = dr.bottom * vp.scale;
        if (tL < dR + 4 && tR > dL - 4 && tT < dB - 4 && tB > dT + 4) {
          tb.__vis = { left: tb.__vis ? tb.__vis.left : tL, top: Math.max(4, dT - th - 8) }; // 挪到浮窗上方
          ctx.applyToolbarZoom();
        }
      } catch (e) {}
      }

  ctx.applyToolbarZoom = function () {
      var vp = getPhysViewport();
      var tb = ctx.root.querySelector('.dbg-toolbar');
      if (!tb || !tb.__vis) return;
      positionPhysical(tb, tb.__vis.left, tb.__vis.top, vp.scale, vp.scaleY);
      }

  ctx.attachToolbarDrag = function () {
      var tb2 = ctx.root.querySelector('.dbg-toolbar');
      if (!tb2 || tb2.__dragBound) return;
      tb2.__dragBound = true;
      // 拖动（公共手势工具 makePointerDrag）：超阈值（4px）才判定拖动/捕获——纯点击不捕获，按钮 click 正常
      makePointerDrag({
        handle: tb2, threshold: 4, capture: 'late',
        filter: function (e) { return !(e.target && e.target.closest && e.target.closest('button')); }, // 按钮交互不拖
        onStart: function (e) {
          var tv = tb2.__vis || { left: 0, top: 0 };
          var cl = detectCoordSemantics(tb2, e.clientX);
          var s = cl ? (getPhysViewport().scale) : 1;
          return { ox: e.clientX * s - tv.left, oy: e.clientY * s - tv.top, coordLayout: cl };
        },
        onMove: function (ev, st) {
          tb2.classList.add('dbg-floating');
          // 拖动位置：clientX/Y = 视觉屏坐标（触摸相对视觉视口）——直接 clamp 物理视口内，不乘 scale
          var vpp = getPhysViewport();
          var tbw2 = tb2.offsetWidth || 200, tbh2 = tb2.offsetHeight || 40;
          var sx2 = st.coordLayout ? vpp.scale : 1;
          var sy2 = st.coordLayout ? vpp.scaleY : 1;
          var nlv = Math.min(Math.max(4, ev.clientX * sx2 - st.ox), Math.max(4, vpp.w - tbw2 - 4));
          var ntv = Math.min(Math.max(4, ev.clientY * sy2 - st.oy), Math.max(4, vpp.h - tbh2 - 4));
          tb2.__vis = { left: nlv, top: ntv }; // 视觉目标（applyToolbarZoom 换算布局 + counter-zoom + offset 补偿）
          ctx.applyToolbarZoom();
        },
        onEnd: function (ev, st, moved) {
          if (moved) { ctx.toolbarDragged = true; ctx.lastSelRect = null; } // 用户拖动：本次选区保持位置，下个选区贴合
        },
      });
      }

  ctx.resetToolbar = function () {
      var tb = ctx.root.querySelector('.dbg-toolbar');
      if (!tb) return;
      tb.classList.remove('dbg-floating');
      tb.style.top = '';
      tb.style.left = '';
      }

  ctx.hostKey = function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      var k = e.key;
      // 帮助窗最前一档：open 时 Esc 先关帮助窗；其余按键一律不劫持（窗内 Tab 移焦点/方向键滚动原生行为）
      if (ctx.helpDialogOpen && ctx.helpDialogOpen()) {
        if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); ctx.closeHelpDialog(); }
        return;
      }
      if (k === 'Escape') {
        if (ctx.pickPanel) { ctx.finishPickPanel({ status: 'rejected', reason: '用户按 Esc 取消' }); return; }
        if (ctx.dialog.classList.contains('dbg-open')) ctx.closeDialog();
        // inspect / AI 点选（🎯 或 aiti_user_pick_element 进入时只设 aiInspectActive 不设 inspectorOn）——Esc 一律退出
        else if (ctx.inspectorOn || ctx.aiInspectActive) ctx.exitInspector();
        else if (ctx.selfClientActive) { ctx.exitSelfClient(); ctx.selfClientActive = false; }
        return;
      }
      // 只要工具条显示（锁定态）就生效——不检查 inspectorOn（兼容 AI 点选/各种进入路径）
      var tb2 = ctx.root.querySelector('.dbg-toolbar');
      if (!tb2 || !tb2.classList.contains('dbg-on')) return;
      // 空格 / Tab = 默认放行 ⇄ 全部放行 一键切换（不用开 🔒 下拉；全键盘通用，仅锁定态拦截——非锁定态两键照常滚页面/移焦点）。
      // Tab 兑底：有些系统监控占据空格。工作流：空格→全部放行→点页面元素弹菜单→空格→默认放行→点菜单项选中，全程免鼠标，弹出菜单不收起
      if (k === ' ' || k === 'Tab') {
        e.preventDefault(); e.stopPropagation(); // 防止页面滚动 / 焦点按钮被空格激活 / Tab 移走焦点
        if (!e.repeat) {
          var _pBtn = ctx.root.querySelector('.dbg-nav-profile');
          var _next = ctx.currentProfile === 'default' ? 'all' : 'default';
          var _pfv = ctx.applyProfile(_next);
          if (_pBtn) _pBtn.textContent = _pfv.label;
          ctx.addMsg('sys', '⚡ 已切换：' + _pfv.label + '（' + (_pfv.release.length ? '放行 ' + _pfv.release.join('/') : '全部冻结') + '）——空格/Tab 可切回' + (_next === 'default' ? '全部放行' : '默认放行') + '，页面弹出菜单保持打开');
        }
        return;
      }
      var dir = HOST_NAV_KEYS[k];
      if (!dir) return;
      e.preventDefault(); e.stopPropagation();
      ctx.doNav(dir);
    }
}
