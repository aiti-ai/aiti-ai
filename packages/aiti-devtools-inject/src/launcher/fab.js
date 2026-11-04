// fab 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { getPhysViewport, _fixedVisual, positionPhysical, detectScreenMode } from './viewport.js';

export function initFab(ctx) {
  ctx.persistFabPos = function () {
      // 存 edge + 视觉位置（px）——7455fd3 起验证正确的方案：同视口 reload 位置精确保持；
      //   兼容旧 ratio 格式（restoreFabPos 转 x/y）——拖动后即以 x/y 覆盖
      try { if (ctx.fabPhys) localStorage.setItem('__dbg_fab__', JSON.stringify({ edge: ctx.fabEdge, x: Math.round(ctx.fabPhys.x), y: Math.round(ctx.fabPhys.y) })); } catch (e) {}
      }

  ctx.applyFabOrient = function () {
      ctx.fab.classList.toggle('dbg-horz', ctx.fabEdge === 'top' || ctx.fabEdge === 'bottom');
      }

  ctx.applyFabResponsive = function () {
      // 按设备物理尺寸判断小屏（detectScreenMode：screen.width + mobile UA 视觉视口兜底，见上）
      var m = detectScreenMode();
      ctx.fab.classList.toggle('dbg-smal', m.small);
      ctx.fab.classList.toggle('dbg-tiny', m.tiny);
      }

  ctx.applyFabTipDir = function () {
      // 按钮级展开方向（样式统一，方向独立）：
      // - 竖排（贴左/右）：贴右两个都向左（不推出屏幕）、贴左都向右——同方向不互相覆盖（上下排）
      // - 横排（贴顶/底）：AI 向左、Inspect 向右（各自向外展开，避免覆盖相邻按钮）
      var btns = ctx.fab.querySelectorAll('button');
      var dir;
      if (ctx.fabEdge === 'top' || ctx.fabEdge === 'bottom') {
        btns.forEach(function (b, i) { b.setAttribute('data-tip', i === 0 ? 'left' : 'right'); });
        return;
      }
      dir = (ctx.fabEdge === 'right') ? 'left' : 'right';
      btns.forEach(function (b) { b.setAttribute('data-tip', dir); });
      }

  ctx.applyFabView = function () {
      var vp = getPhysViewport();
      if (!ctx.fabPhys) return;
      ctx.applyFabResponsive();
      ctx.applyFabTipDir();
      ctx.fab.style.right = 'auto';
      ctx.fab.style.bottom = 'auto';
      // 统一物理固定（counter-zoom + vv.offset 补偿）：任意缩放/滚动/pan 视觉位置不变
      positionPhysical(ctx.fab, ctx.fabPhys.x, ctx.fabPhys.y, vp.scale, vp.scaleY);
      }

  ctx.fabInScreen = function () {
      try {
        var r = ctx.fab.getBoundingClientRect();
        var vp = getPhysViewport();
        // iOS visual 语义 rect 已是视觉坐标；layout 语义 rect 布局坐标 ×scale
        var vL = _fixedVisual ? r.left : r.left * vp.scale;
        var vT = _fixedVisual ? r.top : r.top * vp.scaleY;
        var vW = _fixedVisual ? r.width : r.width * vp.scale;
        var vH = _fixedVisual ? r.height : r.height * vp.scaleY;
        return !(vL < -2 || vT < -2 || vL + vW > vp.w + 2 || vT + vH > vp.h + 2);
      } catch (e) { return true; }
      }

  ctx.resetFabDefault = function () {
      var vp = getPhysViewport();
      ctx.fabEdge = 'right';
      ctx.fabPhys = { x: 0, y: 0.12 * vp.h }; // 贴右 + 距顶 12%（≈1/8）——缩放 counter-zoom 始终可用
      ctx.refreshFabAnchor();
      }

  ctx.restoreFabPos = function () {
      var s = null;
      try { s = localStorage.getItem('__dbg_fab__'); } catch (e) {}
      if (s) {
        try {
          var d = JSON.parse(s);
          if (d && d.edge) {
        ctx.fabEdge = d.edge;
        var vp = getPhysViewport();
        // 比例恢复（新格式 {edge, ratio}）：沿边位置 = 比例 × 当前视口——视口变化后按当前重算
        // 旧格式 {edge, x, y}（具体像素）：直接恢复，refreshFabAnchor 的 clamp 兜底防超屏
        var ratio = (typeof d.ratio === 'number') ? Math.min(1, Math.max(0, d.ratio)) : null;
        if (ratio !== null) {
          if (ctx.fabEdge === 'top' || ctx.fabEdge === 'bottom') ctx.fabPhys = { x: ratio * vp.w, y: 0 };
          else ctx.fabPhys = { x: 0, y: ratio * vp.h };
        } else {
          ctx.fabPhys = { x: d.x || 0, y: d.y || 0 };
        }
        ctx.refreshFabAnchor(); // 按当前视口贴边 + 沿边 clamp
        // 恢复后 rAF 验证：旧数据/视口计算错误导致超屏 → 回默认位置（避免算没/算错不可见）
        requestAnimationFrame(function () {
          var ok = ctx.fabInScreen();
          if (!ok) ctx.resetFabDefault();
          try {
            var vp2 = getPhysViewport();
            var rr = ctx.fab.getBoundingClientRect();
            console.log('[dbg-fab]', JSON.stringify({
              scale: +vp2.scale.toFixed(3),
              vp: { w: Math.round(vp2.w), h: Math.round(vp2.h) },
              screen: { w: screen.width, h: screen.height }, dpr: devicePixelRatio,
              inner: { w: innerWidth, h: innerHeight },
              stored: JSON.parse(localStorage.getItem('__dbg_fab__') || 'null'),
              rect: { l: Math.round(rr.left), t: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
              inScreen: ok
            }));
          } catch (e) {}
        });
        return;
      }
        } catch (e) {}
      }
      // 无持久化/无效：默认贴右侧（比例 0.12 ≈ 距顶 1/8）——保证缩放 counter-zoom 始终可用
      ctx.resetFabDefault();
      }

  ctx.refreshFabAnchor = function () {
      // 窗口物理变化（缩放不变）：贴边锚点重算（保持贴边）；拖放自定义位置 clamp 视口内
      var vp = getPhysViewport();
      ctx.applyFabOrient(); // 贴顶/贴底 → 横排（尺寸变化，先切换再量 offsetWidth）
      ctx.applyFabResponsive(); // 小屏放大后的按钮尺寸
      // counter-zoom：transform scale(1/scale) 抵消页面缩放 → 视觉尺寸 = offsetWidth（基础 CSS 尺寸）
      var w = ctx.fab.offsetWidth, h = ctx.fab.offsetHeight;
      var x = ctx.fabPhys ? ctx.fabPhys.x : 0, y = ctx.fabPhys ? ctx.fabPhys.y : 0;
      // 边距恒为视觉 px（fabPhys 是视觉目标，positionPhysical 内部再 /scale 转布局）——不能用 8*scale（缩放时贴边只剩 2px）
      if (ctx.fabEdge === 'left') x = 8;
      else if (ctx.fabEdge === 'right') x = vp.w - w - 8;
      else if (ctx.fabEdge === 'top') y = 8;
      else if (ctx.fabEdge === 'bottom') y = vp.h - h - 16; // 贴底往上提（边距 16 视觉 px——避免贴太靠底被手势条/安全区遮挡或误判屏外）
      x = Math.min(Math.max(8, x), Math.max(8, vp.w - w - 8));
      y = Math.min(Math.max(8, y), Math.max(8, vp.h - h - 16));
      ctx.fabPhys = { x: x, y: y };
      ctx.applyFabView();
      }

  ctx.safeFabRefresh = function () { try { if (ctx.fabEdge && ctx.fabPhys) ctx.refreshFabAnchor(); } catch (e) {} }

  // ---- 页面错误提醒（picks.js picksAddError 调用）：AI 按钮红描边 + 角标 + 脉冲闪烁 ----
  // 行为：新错误 → 按钮红描边 + 角标（数字=待处理错误数，1 个仅红点）+ 动画闪 6s；
  //   角标留存 3 分钟（用户要求，避免一闪而过）——每次新错误重置计时；打开 AI 窗（showAi fabErrClear）提前移除。
  ctx.fabErrNotify = function (n) {
    try {
      if (!ctx.aiBtn) return;
      var badge = ctx.aiBtn.querySelector('.dbg-fab-err-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'dbg-fab-err-badge';
        ctx.aiBtn.appendChild(badge);
      }
      badge.style.display = 'flex';
      badge.textContent = n > 1 ? String(n) : ''; // 1 个错误只显示红点，多个显示数字
      ctx.aiBtn.classList.add('dbg-err');
      // 重新触发脉冲动画（移除类 + 强制 reflow 再添加，保证连续错误每次都闪）
      ctx.aiBtn.classList.remove('dbg-err-pulse');
      void ctx.aiBtn.offsetWidth;
      ctx.aiBtn.classList.add('dbg-err-pulse');
      if (ctx.fabErrPulseT) clearTimeout(ctx.fabErrPulseT);
      ctx.fabErrPulseT = setTimeout(function () { try { ctx.aiBtn.classList.remove('dbg-err-pulse'); } catch (e) {} }, 7000); // 动画 4×1.5s≈6s + 余量
      // 角标留存 3 分钟（180s）后自动移除；每次新错误重置计时
      if (ctx.fabErrAutoT) clearTimeout(ctx.fabErrAutoT);
      ctx.fabErrAutoT = setTimeout(function () { try { ctx.fabErrClear(); } catch (e) {} }, 3 * 60 * 1000);
    } catch (e) {}
  };
  ctx.fabErrClear = function () {
    try {
      if (ctx.fabErrAutoT) { clearTimeout(ctx.fabErrAutoT); ctx.fabErrAutoT = null; }
      if (ctx.fabErrPulseT) { clearTimeout(ctx.fabErrPulseT); ctx.fabErrPulseT = null; }
      if (ctx.aiBtn) {
        ctx.aiBtn.classList.remove('dbg-err', 'dbg-err-pulse');
        var b = ctx.aiBtn.querySelector('.dbg-fab-err-badge');
        if (b) b.remove();
      }
    } catch (e) {}
  };
}
